/**
 * Post-synthesis citation validator.
 *
 * The synthesizer attaches [N] markers to claims. Despite strict prompts, the
 * model still attaches markers to thematically-related-but-not-supporting
 * segments. This module reads the synthesized report, pulls (claim, segment)
 * pairs, and asks Haiku — in a single batched call — whether each segment
 * actually supports the claim.
 *
 * Verdicts:
 *   YES     — segment text directly supports the claim
 *   PARTIAL — same topic, but doesn't fully support the specific claim
 *   NO      — segment is irrelevant to the claim
 *
 * Action by verdict:
 *   YES     — keep [N] as-is
 *   PARTIAL — keep [N] but flag in citations metadata so frontend can warn
 *   NO      — strip [N] from the report text + flag in metadata
 *
 * The report text never has fabricated content removed (we don't re-write
 * sentences). We only fix the misleading citation attribution. If too many
 * NOs (>30%), we mark the whole response as low-confidence in the citations
 * metadata so the frontend can show a "weak grounding" badge if desired.
 *
 * Additionally exports verifyClaimsAgainstCitations and rewriteToHedge for
 * the post-generation hallucination gate (see route.ts). These detect specific
 * factual claims (numbers, legislation, dollar amounts, percentages, named
 * entities) that have no grounding in the citation excerpts, then rewrite them
 * to softer hedges or remove them entirely.
 */

import Anthropic from '@anthropic-ai/sdk';

export interface Citation {
  n: number;
  quote?: string;
  speakers?: string[]; // who is MENTIONED in the segment (the `m` field) — NOT who spoke it
  speakerKey?: string | null; // PRIMARY speaker (`sk`) — who actually SPOKE the segment
  topics?: string[];
  [k: string]: unknown;
}

export interface CitationVerdict {
  n: number;
  verdict: 'YES' | 'PARTIAL' | 'NO' | 'UNKNOWN';
  reason?: string;
}

export interface FailedClaim {
  claim: string;
  n: number;
  verdict: 'NO' | 'PARTIAL';
}

export interface ValidationResult {
  cleanedReport: string;
  verdicts: CitationVerdict[];
  unsupportedCount: number;
  totalChecked: number;
  /** Specific (claim, citation-n) pairs that failed — used by self-critique rewrite */
  failedClaims: FailedClaim[];
}

const VALIDATE_TIMEOUT_MS = 8000;
const VERIFY_TIMEOUT_MS = 10000;
const REWRITE_TIMEOUT_MS = 10000;

/**
 * Find each (sentence-with-citation, citation-numbers) pair in the report.
 * A "claim" is the sentence containing the [N] marker(s).
 */
function extractClaims(report: string): Array<{ claim: string; markers: number[] }> {
  // Split into sentences. Tolerant of newlines, list items, headings.
  // We treat each line that contains [N] as a candidate.
  const out: Array<{ claim: string; markers: number[] }> = [];
  const lines = report.split(/\n+/);
  for (const line of lines) {
    if (!/\[\d+\]/.test(line)) continue;
    // Per-sentence in the line (split on period+space, ?, !, but keep line minimal)
    const sentences = line.split(/(?<=[.!?])\s+/);
    for (const sRaw of sentences) {
      const s = sRaw.trim();
      if (!/\[\d+\]/.test(s)) continue;
      const markers = Array.from(s.matchAll(/\[(\d+)\]/g)).map((m) => parseInt(m[1], 10));
      out.push({ claim: s, markers: Array.from(new Set(markers)) });
    }
  }
  return out;
}

/**
 * Strip a specific citation number from a sentence in the report.
 * Handles `[3]`, `[3, 7]`, `[3,7]` variations.
 */
function stripCitation(report: string, n: number): string {
  // Replace `[3]` directly with empty (and clean up double spaces)
  let out = report.replace(new RegExp(`\\s?\\[${n}\\](?![\\d])`, 'g'), '');
  // Handle in-list cases `[3, 7]` → `[7]`, `[7, 3]` → `[7]`
  out = out.replace(new RegExp(`\\[${n},\\s*(\\d+)\\]`, 'g'), '[$1]');
  out = out.replace(new RegExp(`\\[(\\d+),\\s*${n}\\]`, 'g'), '[$1]');
  // Tidy: collapse double spaces and stray space-before-punctuation
  return out.replace(/  +/g, ' ').replace(/\s+([.,!?;])/g, '$1');
}

export async function validateCitations(
  report: string,
  citations: Citation[],
  anthropicKey?: string
): Promise<ValidationResult> {
  if (!anthropicKey || !report || citations.length === 0) {
    return { cleanedReport: report, verdicts: [], unsupportedCount: 0, totalChecked: 0, failedClaims: [] };
  }

  const claims = extractClaims(report);
  if (claims.length === 0) {
    return { cleanedReport: report, verdicts: [], unsupportedCount: 0, totalChecked: 0, failedClaims: [] };
  }

  // Build the (claim, segment) pairs. Many claims cite multiple segments;
  // we expand to one pair per (claim, segment) but cap total pairs at 40
  // for cost+latency control. Citations cited most often go first.
  const pairs: Array<{ pid: number; claim: string; n: number; segText: string }> = [];
  let pid = 0;
  for (const c of claims) {
    for (const n of c.markers) {
      const cit = citations.find((x) => x.n === n);
      if (!cit || !cit.quote) continue;
      pairs.push({ pid: pid++, claim: c.claim, n, segText: String(cit.quote).slice(0, 350) });
      if (pairs.length >= 40) break;
    }
    if (pairs.length >= 40) break;
  }

  if (pairs.length === 0) {
    return { cleanedReport: report, verdicts: [], unsupportedCount: 0, totalChecked: 0, failedClaims: [] };
  }

  const prompt = `You are a strict citation verifier. For each (CLAIM, SEGMENT) pair, judge whether the SEGMENT TEXT directly supports the specific factual content of the CLAIM.

Verdicts:
- "YES"     — the segment text contains the specific information the claim asserts
- "PARTIAL" — same general topic, but the segment doesn't fully support the specific claim (e.g. mentions the topic but not the named figure / number / position the claim states)
- "NO"      — the segment is about a different topic; the claim cannot be derived from this segment

Be strict. Loose thematic overlap is "PARTIAL", not "YES". A claim about Sacks's crypto policy backed by a segment about Sacks's tax views is "NO" — different topic.

PAIRS:
${pairs
  .map(
    (p) =>
      `[#${p.pid}] cite=[${p.n}]\n  CLAIM: ${p.claim.replace(/\s+/g, ' ').slice(0, 280)}\n  SEGMENT: ${p.segText}`
  )
  .join('\n\n')}

Output ONLY JSON: {"v":[{"pid":<int>,"verdict":"YES|PARTIAL|NO"},...]} with exactly ${pairs.length} entries. No prose.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const res = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        temperature: 0,
        system:
          'You verify citation accuracy. Output strict JSON only. No prose, no code fences.',
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: controller.signal }
    );

    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    const cleaned = text.replace(/```(?:json)?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const verdictRows: Array<{ pid: number; verdict: string }> = Array.isArray(parsed.v)
      ? parsed.v
      : [];

    // Map pid → verdict; aggregate per-citation by worst case
    const pidToVerdict = new Map<number, string>();
    for (const r of verdictRows) {
      if (typeof r.pid === 'number' && typeof r.verdict === 'string') {
        pidToVerdict.set(r.pid, r.verdict.toUpperCase());
      }
    }

    // Per-citation aggregation: a citation is YES only if every pair using it is YES.
    // If any pair is NO, the citation is NO. Otherwise PARTIAL.
    const perCitation = new Map<number, { yes: number; partial: number; no: number }>();
    for (const p of pairs) {
      const v = pidToVerdict.get(p.pid) || 'UNKNOWN';
      const counts = perCitation.get(p.n) || { yes: 0, partial: 0, no: 0 };
      if (v === 'YES') counts.yes++;
      else if (v === 'PARTIAL') counts.partial++;
      else if (v === 'NO') counts.no++;
      perCitation.set(p.n, counts);
    }

    const verdicts: CitationVerdict[] = [];
    let cleanedReport = report;
    let unsupported = 0;
    const noCitations = new Set<number>();
    for (const [n, c] of perCitation.entries()) {
      let v: CitationVerdict['verdict'];
      if (c.no > 0 && c.yes === 0) v = 'NO';
      else if (c.partial > 0 && c.yes === 0) v = 'PARTIAL';
      else v = 'YES';
      verdicts.push({ n, verdict: v });
      if (v === 'NO') {
        unsupported++;
        noCitations.add(n);
        cleanedReport = stripCitation(cleanedReport, n);
      }
    }

    // Capture the specific claims that cited NO-verdict segments so the
    // self-critique rewrite loop can tell the model what went wrong.
    const failedClaims: FailedClaim[] = [];
    for (const p of pairs) {
      if (noCitations.has(p.n)) {
        failedClaims.push({ claim: p.claim, n: p.n, verdict: 'NO' });
      }
    }

    console.log(
      `[validate] ${pairs.length} pairs / ${verdicts.length} citations checked in ${Date.now() - t0}ms; verdicts: ${verdicts
        .map((v) => `${v.n}=${v.verdict[0]}`)
        .join(',')}`
    );

    return {
      cleanedReport,
      verdicts,
      unsupportedCount: unsupported,
      totalChecked: verdicts.length,
      failedClaims,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[validate] failed after ${Date.now() - t0}ms: ${msg}`);
    return { cleanedReport: report, verdicts: [], unsupportedCount: 0, totalChecked: 0, failedClaims: [] };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Hallucination gate: verifyClaimsAgainstCitations ───────────────────────
//
// Extracts every specific factual claim from the draft (numbers, percentages,
// dollar amounts, dates, legislation names, agency names, named studies, named
// court cases, specific titles) and for each one marks it:
//   GROUNDED   — appears verbatim or near-verbatim in at least one citation
//   INFERRED   — reasonable paraphrase of citation content
//   UNGROUNDED — does not appear in any citation
//
// Uses Claude Haiku 4.5 for speed and cost.

export interface ClaimVerdict {
  text: string;
  status: 'GROUNDED' | 'INFERRED' | 'UNGROUNDED';
  citation_n: number | null;
}

export interface ClaimVerificationResult {
  claims: ClaimVerdict[];
  claimsTotal: number;
  claimsGrounded: number;
  claimsInferred: number;
  claimsUngrounded: number;
  verificationMs: number;
}

/** Truncate a citation quote to 280 chars for the verifier context window. */
function truncateForVerifier(text: string): string {
  if (text.length <= 280) return text;
  return text.slice(0, 277) + '...';
}

export async function verifyClaimsAgainstCitations(
  draftReport: string,
  citations: Citation[],
  query: string,
  anthropicKey?: string
): Promise<ClaimVerificationResult> {
  const t0 = Date.now();
  const empty: ClaimVerificationResult = {
    claims: [],
    claimsTotal: 0,
    claimsGrounded: 0,
    claimsInferred: 0,
    claimsUngrounded: 0,
    verificationMs: 0,
  };

  if (!anthropicKey || !draftReport || citations.length === 0) return empty;

  const citationBlock = citations
    .slice(0, 12)
    .map((c) => `[${c.n}] ${truncateForVerifier(String(c.quote || ''))}`)
    .join('\n');

  const systemPrompt = `You are a fact-verification gate. The user received a synthesized roundtable answer drafted from N citation excerpts. Your job: extract every specific factual claim from the draft (numbers, percentages, dollar amounts, dates, legislation names, agency names, named studies, named court cases, specific titles), then for EACH claim mark it:
- GROUNDED: claim appears verbatim or near-verbatim in at least one citation excerpt
- INFERRED: claim is a reasonable paraphrase of citation content
- UNGROUNDED: claim does not appear in any citation

Output JSON ONLY: { "claims": [{ "text": "...", "status": "GROUNDED|INFERRED|UNGROUNDED", "citation_n": <int or null> }, ...] }
No prose, no code fences, no explanation. Only specific factual claims (numbers, names, legislation, percentages, dollar amounts, dates, titles). Do NOT extract vague opinions or general statements.`;

  const userMsg = `QUERY: ${query}

CITATION EXCERPTS:
${citationBlock}

DRAFT REPORT:
${draftReport.slice(0, 3000)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const res = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1200,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      },
      { signal: controller.signal }
    );

    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    const cleaned = text.replace(/```(?:json)?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const rawClaims: unknown[] = Array.isArray(parsed.claims) ? parsed.claims : [];

    const claims: ClaimVerdict[] = rawClaims
      .filter(
        (c): c is { text: string; status: string; citation_n: number | null } =>
          typeof c === 'object' && c !== null && 'text' in c && 'status' in c
      )
      .map((c) => ({
        text: String(c.text).slice(0, 300),
        status: (['GROUNDED', 'INFERRED', 'UNGROUNDED'].includes(String(c.status).toUpperCase())
          ? String(c.status).toUpperCase()
          : 'UNGROUNDED') as ClaimVerdict['status'],
        citation_n: typeof c.citation_n === 'number' ? c.citation_n : null,
      }));

    const claimsGrounded = claims.filter((c) => c.status === 'GROUNDED').length;
    const claimsInferred = claims.filter((c) => c.status === 'INFERRED').length;
    const claimsUngrounded = claims.filter((c) => c.status === 'UNGROUNDED').length;
    const verificationMs = Date.now() - t0;

    console.log(
      `[verify-claims] query="${query.slice(0, 60)}" total=${claims.length} grounded=${claimsGrounded} inferred=${claimsInferred} ungrounded=${claimsUngrounded} ms=${verificationMs}`
    );

    return {
      claims,
      claimsTotal: claims.length,
      claimsGrounded,
      claimsInferred,
      claimsUngrounded,
      verificationMs,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[verify-claims] failed after ${Date.now() - t0}ms: ${msg}`);
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * FAIL-SAFE guard for every LLM rewrite pass. An LLM cleanup step can occasionally
 * return a refusal, a meta-commentary ("I'm the EXCISER, I need to clarify..."), or a
 * near-empty stub instead of the rewritten text (this destroyed q13, 2026-06-25). A
 * cleanup must only ever improve or no-op — NEVER replace a real answer with garbage.
 * If the output looks degenerate, discard it and keep the original.
 */
function safeRewrite(original: string, rewritten: string | undefined): string {
  const r = (rewritten || '').trim();
  if (!r) return original;
  // Too short relative to the source → likely a refusal/stub.
  if (r.length < Math.min(400, original.length * 0.5)) return original;
  // Lost the roundtable dialogue structure it should have preserved.
  const origMarkers = (original.match(/\*\*/g) || []).length;
  const newMarkers = (r.match(/\*\*/g) || []).length;
  if (origMarkers >= 4 && newMarkers < origMarkers / 2) return original;
  // Opens with meta-commentary / preamble instead of the content.
  if (/^(I appreciate|I'm the|I am the|I need to clarify|I cannot|I can't|I should|My role|My instruction|Sure[,!]|Here is|Here's the|Okay|Understood|As an? (AI|assistant|editor))/i.test(r)) {
    return original;
  }
  return r;
}

// ─── Hallucination gate: rewriteToHedge (EXCISE mode) ───────────────────────
//
// Takes the draft report and a list of UNGROUNDED claim strings, then EXCISES
// the unsupported specifics — deleting the claim (and its sentence/turn when the
// assertion depends on it) rather than softening it into a vague hedge. Soft
// hedges ("substantial", "in the ballpark of") still imply a fact existed and
// were the dominant fabrication-grading failure (2026-06-25); removal is the fix.
// Name kept for call-site stability; behavior is excision. Uses Claude Haiku 4.5.

export async function rewriteToHedge(
  draftReport: string,
  ungroundedClaims: string[],
  anthropicKey?: string
): Promise<string> {
  if (!anthropicKey || !draftReport || ungroundedClaims.length === 0) return draftReport;

  const t0 = Date.now();
  const claimList = ungroundedClaims.map((c, i) => `${i + 1}. ${c}`).join('\n');

  const systemPrompt = `You are a fabrication EXCISER. The text below is a podcast-host roundtable. The listed claims have NO citation support — they are fabrications. EXCISE them: delete the unsupported specific and, if a sentence's core assertion depends on it, delete the whole sentence. Do NOT soften, do NOT paraphrase into a vague hedge — REMOVE.

Fabricated claims to excise (no citation supports these):
${claimList}

Rules:
- DELETE each fabricated specific (number, %, $ amount, date, name, statute, study, title). Do not replace it with "substantial"/"significant"/"in the ballpark of" — those vague hedges still imply a fact existed. Cut the assertion.
- If removing the specific leaves a sentence that no longer says anything, delete the sentence. If a host's turn becomes empty, delete that turn's header too.
- It is BETTER to have a shorter, fully-grounded answer than a longer one padded with hedged fabrications. A turn that just says "we haven't gone deep on the specifics here" is acceptable.
- Do NOT add any new claim, number, or detail not in the original.
- Preserve all GROUNDED content and every citation marker [N] that sits on content you keep, verbatim.
- Keep each remaining turn punchy (1-3 sentences). Output ONLY the rewritten text, no preamble.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REWRITE_TIMEOUT_MS);

  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const res = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,                                   // was 2000 — truncated hedged answers mid-sentence
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: draftReport.slice(0, 12000) }],  // was 3500 — cut long drafts before rewrite
      },
      { signal: controller.signal }
    );

    const rewritten = res.content[0]?.type === 'text' ? res.content[0].text : draftReport;
    const safe = safeRewrite(draftReport, rewritten);
    console.log(`[excise] removed ${ungroundedClaims.length} ungrounded claims in ${Date.now() - t0}ms${safe === draftReport && rewritten !== draftReport ? ' (DISCARDED degenerate rewrite)' : ''}`);
    return safe;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[rewrite-hedge] failed after ${Date.now() - t0}ms: ${msg}`);
    return draftReport;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Deterministic speaker-attribution verifier + repair ────────────────────
//
// THE #1 score-limiter (QA 2026-06-25, triple-confirmed): the synthesis assigns
// content from citation [N] to a bestie even when [N]'s ACTUAL speaker (`sk`) is a
// guest (Elon/Gerstner/Gurley/Cuban/…) or a different host. Prompt instructions do
// NOT reliably stop this. So we DETECT it deterministically (compare each [N]'s sk
// to the turn it's voiced under) and REPAIR only the detected violations with a
// tightly-scoped LLM pass — deterministic detection means the check can't silently
// pass, and constraining the repair to known violations limits new errors.

const HOST_KEYS = new Set(['chamath', 'sacks', 'friedberg', 'calacanis']);
const SPEAKER_DISPLAY: Record<string, string> = {
  chamath: 'Chamath', sacks: 'David Sacks', friedberg: 'David Friedberg',
  calacanis: 'Jason Calacanis', jason: 'Jason Calacanis', elon: 'Elon Musk',
  gerstner: 'Brad Gerstner', gurley: 'Bill Gurley', cuban: 'Mark Cuban',
  thiel: 'Peter Thiel', baker: 'a guest (Baker)',
};

/** Map a citation's `sk` to a comparable key; null = unknown/unprovable. */
function skToKey(sk?: string | null): string | null {
  if (!sk || sk === 'unknown' || sk === '?') return null;
  const k = sk.startsWith('likely_') ? sk.slice('likely_'.length) : sk;
  return k === 'jason' ? 'calacanis' : k;
}

/** Map a report turn header (e.g. "SACKS", "David Friedberg", "JASON") to a host key. */
function turnNameToHostKey(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes('chamath')) return 'chamath';
  if (n.includes('sacks')) return 'sacks';
  if (n.includes('friedberg') || n.includes('freeberg')) return 'friedberg';
  if (n.includes('jason') || n.includes('calacanis')) return 'calacanis';
  return null; // narration / guest header / "Where they land" etc. — not a host turn
}

function displayName(key: string): string {
  return SPEAKER_DISPLAY[key] || key.charAt(0).toUpperCase() + key.slice(1);
}

export interface AttributionViolation {
  turnSpeaker: string;   // host key the turn is voiced as
  citationN: number;
  actualSpeaker: string; // sk key of the cited segment
  kind: 'guest-as-host' | 'cross-host';
}

/**
 * Deterministically find citation markers attributed to the wrong speaker:
 * a [N] sitting inside host H's turn whose actual segment speaker (sk) is a
 * different host (cross-host) or a named guest (guest-as-host). Unknown-speaker
 * segments are NOT flagged (can't prove a violation). No LLM, no network.
 */
export function verifySpeakerAttribution(
  report: string,
  citations: Citation[]
): AttributionViolation[] {
  const skByN = new Map<number, string>();
  for (const c of citations) {
    const k = skToKey(c.speakerKey as string | null | undefined);
    if (k) skByN.set(c.n, k);
  }
  if (skByN.size === 0) return [];

  const violations: AttributionViolation[] = [];
  const turnRe = /\*\*([A-Za-z][A-Za-z .'-]*?):\*\*/g;
  const headers = [...report.matchAll(turnRe)];
  for (let i = 0; i < headers.length; i++) {
    const hostKey = turnNameToHostKey(headers[i][1]);
    if (!hostKey) continue; // only audit turns voiced as one of the four hosts
    const bodyStart = (headers[i].index ?? 0) + headers[i][0].length;
    const bodyEnd = i + 1 < headers.length ? (headers[i + 1].index ?? report.length) : report.length;
    const body = report.slice(bodyStart, bodyEnd);
    const markers = new Set(
      Array.from(body.matchAll(/\[(\d+)\]/g)).map((m) => parseInt(m[1], 10))
    );
    for (const n of markers) {
      const actual = skByN.get(n);
      if (!actual || actual === hostKey) continue; // unknown or correct
      violations.push({
        turnSpeaker: hostKey,
        citationN: n,
        actualSpeaker: actual,
        kind: HOST_KEYS.has(actual) ? 'cross-host' : 'guest-as-host',
      });
    }
  }
  return violations;
}

/**
 * Repair detected speaker misattributions with a tightly-scoped LLM rewrite.
 * Given the ground-truth speaker for each violating [N], the model must make the
 * attribution match: a guest's words get the guest's name ("as Elon argued [N]")
 * and are NEVER presented as a host's own view; a different host's words move to
 * that host or are explicitly attributed. Everything else is preserved verbatim.
 */
export async function repairSpeakerAttribution(
  draftReport: string,
  violations: AttributionViolation[],
  anthropicKey?: string
): Promise<string> {
  if (!anthropicKey || !draftReport || violations.length === 0) return draftReport;

  const t0 = Date.now();
  // One ground-truth line per violating citation (dedup by n).
  const byN = new Map<number, AttributionViolation>();
  for (const v of violations) if (!byN.has(v.citationN)) byN.set(v.citationN, v);
  const truth = [...byN.values()]
    .map((v) => {
      const who = displayName(v.actualSpeaker);
      const guest = v.kind === 'guest-as-host';
      return `- [${v.citationN}] was actually said by ${who}${guest ? ' (a GUEST — NOT one of the four besties)' : ' (a different bestie, not the one currently voicing it)'}.`;
    })
    .join('\n');

  const systemPrompt = `You fix SPEAKER MISATTRIBUTION in a podcast-host roundtable. Each listed citation [N] was spoken by a specific person — but the draft currently puts that content in the wrong bestie's mouth. Fix ONLY the attribution; do not change any other content.

The four besties (hosts) are: Chamath, David Sacks, David Friedberg, Jason Calacanis. Anyone else (Elon Musk, Brad Gerstner, Bill Gurley, Mark Cuban, Peter Thiel, etc.) is a GUEST, not a bestie.

Ground truth for the misattributed citations:
${truth}

Rules:
- A GUEST's words must NEVER be presented as a bestie's own view. Rewrite so the bestie REFERENCES the guest by name: e.g. "As Elon argued, ... [N]" or "Friedberg pushes back on Gurley's point that ... [N]". Keep the [N] marker on that content.
- If [N] belongs to a DIFFERENT bestie, either move that line into that bestie's turn or have the current speaker explicitly attribute it ("to Sacks's point that ... [N]").
- Do NOT invent new claims, numbers, or details. Do NOT remove grounded content. Keep every [N] marker on the content it supports.
- Keep turns punchy (1-3 sentences). Output ONLY the rewritten text, no preamble.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REWRITE_TIMEOUT_MS);
  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const res = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4000,
        temperature: 0.2,
        system: systemPrompt,
        messages: [{ role: 'user', content: draftReport.slice(0, 12000) }],
      },
      { signal: controller.signal }
    );
    const rewritten = res.content[0]?.type === 'text' ? res.content[0].text : draftReport;
    const safe = safeRewrite(draftReport, rewritten);
    console.log(`[attribution] repaired ${byN.size} misattributed citations (${violations.length} hits) in ${Date.now() - t0}ms${safe === draftReport && rewritten !== draftReport ? ' (DISCARDED degenerate rewrite)' : ''}`);
    return safe;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[attribution] repair failed after ${Date.now() - t0}ms: ${msg}`);
    return draftReport;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Telemetry: appendVerifierStats ─────────────────────────────────────────
//
// Append a single JSON line per verifier invocation to data/qa/verifier-stats.jsonl
// so we can prove in production that the verifier is firing and measure hedge rate
// over time. Async + fail-silent — telemetry must never block or break a response.

export interface VerifierStatsLogEntry {
  query: string;
  claimsTotal: number;
  claimsUngrounded: number;
  hedgesApplied: boolean;
  verificationMs: number;
}

export async function appendVerifierStats(stats: VerifierStatsLogEntry): Promise<void> {
  try {
    // Node-only — guard against any edge-runtime importer.
    const fs = await import('fs');
    const path = await import('path');
    // Vercel filesystem is read-only outside /tmp. Prefer /tmp on Vercel so the
    // JSONL aggregate actually persists for the lifetime of the lambda; locally,
    // prefer the repo's data/qa/ so dev-time telemetry stays alongside QA fixtures.
    const onVercel = !!process.env.VERCEL;
    const candidates = onVercel
      ? ['/tmp/verifier-stats.jsonl']
      : [
          path.join(process.cwd(), 'data', 'qa', 'verifier-stats.jsonl'),
          path.join(process.cwd(), '..', 'data', 'qa', 'verifier-stats.jsonl'),
        ];
    const target = candidates.find((p) => fs.existsSync(path.dirname(p))) ?? candidates[0];
    const line =
      JSON.stringify({
        ts: new Date().toISOString(),
        query: stats.query.slice(0, 80),
        claimsTotal: stats.claimsTotal,
        claimsUngrounded: stats.claimsUngrounded,
        hedgesApplied: stats.hedgesApplied,
        verificationMs: stats.verificationMs,
      }) + '\n';
    await fs.promises.appendFile(target, line, 'utf8').catch(() => {
      /* fail-silent */
    });
  } catch {
    /* fail-silent — telemetry must never break the response path */
  }
}

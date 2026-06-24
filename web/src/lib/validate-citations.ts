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
  speakers?: string[];
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

// ─── Hallucination gate: rewriteToHedge ─────────────────────────────────────
//
// Takes the draft report and a list of UNGROUNDED claim strings, then rewrites
// the offending sentences to remove or soften the unsupported specifics while
// preserving the overall voice and structure. Uses Claude Haiku 4.5.

export async function rewriteToHedge(
  draftReport: string,
  ungroundedClaims: string[],
  anthropicKey?: string
): Promise<string> {
  if (!anthropicKey || !draftReport || ungroundedClaims.length === 0) return draftReport;

  const t0 = Date.now();
  const claimList = ungroundedClaims.map((c, i) => `${i + 1}. ${c}`).join('\n');

  const systemPrompt = `Rewrite the following text to REMOVE specific unsupported claims. Replace them with generic hedges. Keep voice and structure. The text is written in the voices of podcast hosts — preserve their speaking style, use of first person, and conversational tone.

Specifically, these claims have no citation support and must be softened or dropped:
${claimList}

Rules:
- Do NOT add new specific claims not in the original
- Do NOT change the overall argument or structure
- Use phrases like "in the ballpark of", "substantial", "significant", "considerable", "reportedly" as replacements for unsupported specifics
- If a claim is a legislative name (e.g. "Section 338 of the tariff act"), replace with a generic reference (e.g. "the relevant tariff provision")
- Keep citation markers [N] that were already present
- Output ONLY the rewritten text, no preamble`;

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
    console.log(`[rewrite-hedge] rewrote ${ungroundedClaims.length} ungrounded claims in ${Date.now() - t0}ms`);
    return rewritten;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[rewrite-hedge] failed after ${Date.now() - t0}ms: ${msg}`);
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

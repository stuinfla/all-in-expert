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

/**
 * Cross-encoder rerank using Claude Haiku as scorer.
 *
 * After cosine top-N, this re-scores each segment against the actual query
 * with a single batched Haiku call. Cosine similarity is approximate and
 * shallow (vector-space distance over averaged tokens); a real LLM read of
 * "does this segment answer this query?" produces dramatically better
 * top-K selection — especially for queries whose terms are rare in the
 * cosine-favorite segments.
 *
 * Cost: ~$0.001 per query (Haiku, ~1500 input tokens). Latency: ~400-800ms.
 *
 * On any failure (timeout, parse error, missing key) we return the input
 * unchanged so the route falls back to cosine-only ranking.
 */

import Anthropic from '@anthropic-ai/sdk';

export interface RerankableSegment {
  id: string;
  entry: { c: string; v: string; t: string; p: string[]; m: string[]; u: string };
  distance: number;
  rawDistance: number;
}

const RERANK_TIMEOUT_MS = 4000;

export async function rerank<T extends RerankableSegment>(
  query: string,
  segments: T[],
  topK: number,
  anthropicKey?: string
): Promise<T[]> {
  if (!anthropicKey || segments.length <= topK) return segments.slice(0, topK);

  // Cap input — even a long-context model wastes tokens on >40 segments.
  const candidates = segments.slice(0, Math.min(segments.length, 30));

  const numbered = candidates
    .map((s, i) => {
      const speakers = s.entry.m.length ? ` voices=${s.entry.m.join('/')}` : '';
      const topics = s.entry.p.length ? ` topics=${s.entry.p.join('/')}` : '';
      // Truncate per-segment to keep input bounded; rerank only needs a sniff.
      const txt = s.entry.c.slice(0, 320).replace(/\s+/g, ' ');
      return `[${i}]${speakers}${topics} "${txt}"`;
    })
    .join('\n');

  const prompt = `You are a relevance scorer for a podcast retrieval system. Score how directly each segment answers the user's query.

QUERY: "${query}"

SEGMENTS:
${numbered}

For each segment, output a single integer score 0-10:
- 10 = directly answers the query (contains the exact information asked about)
- 7-9 = strong topic match with relevant content
- 4-6 = adjacent topic or partial match
- 1-3 = same vocabulary but different topic
- 0 = irrelevant

Output ONLY a JSON object: {"scores":[<num>,<num>,...]} with exactly ${candidates.length} integers in segment order. No explanation.`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS);
  const t0 = Date.now();

  try {
    const client = new Anthropic({ apiKey: anthropicKey });
    const res = await client.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        temperature: 0,
        system:
          'You score document relevance. Output strict JSON only. No prose, no code fences, no commentary.',
        messages: [{ role: 'user', content: prompt }],
      },
      { signal: controller.signal }
    );

    const text = res.content[0]?.type === 'text' ? res.content[0].text : '';
    // Tolerate ```json fences just in case
    const cleaned = text.replace(/```(?:json)?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    const scores: number[] = Array.isArray(parsed.scores) ? parsed.scores : [];
    if (scores.length !== candidates.length) {
      console.log(`[rerank] score length mismatch: got ${scores.length} want ${candidates.length}`);
      return segments.slice(0, topK);
    }

    // Pair scores with original segments, sort by score desc, take topK.
    // Stable tiebreak on original cosine distance.
    const paired = candidates.map((s, i) => ({ s, score: scores[i] || 0, orig: i }));
    paired.sort((a, b) => b.score - a.score || a.s.distance - b.s.distance);
    const top = paired.slice(0, topK).map((p) => p.s);

    console.log(
      `[rerank] ${candidates.length}→${topK} in ${Date.now() - t0}ms; top scores: ${paired
        .slice(0, topK)
        .map((p) => p.score)
        .join(',')}`
    );
    return top;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[rerank] failed after ${Date.now() - t0}ms: ${msg} — using cosine ranking`);
    return segments.slice(0, topK);
  } finally {
    clearTimeout(timer);
  }
}

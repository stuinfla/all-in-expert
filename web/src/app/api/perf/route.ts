import { NextResponse } from 'next/server';
import { readRecentPerfStats, summarize, type PerfStatsEntry } from '@/lib/perf-stats';

export const dynamic = 'force-dynamic';

/**
 * GET /api/perf — aggregate per-stage timing observability.
 *
 * Reads the last N entries of data/qa/perf-stats.jsonl (written by route.ts
 * after every synthesis via after(appendPerfStats)) and returns p50/p99/avg
 * per stage. This is the read-side counterpart to the perf telemetry
 * already happening inside /api/ask — no metrics pipeline required.
 *
 * Returns empty/zeroed stats when no entries exist yet (e.g. fresh deploy
 * before the cache-warm script has run). Operators should treat zero counts
 * as "no traffic", not "endpoint broken".
 *
 * Query params:
 *   ?limit=N  cap how many recent entries to aggregate (default 100, max 1000)
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get('limit') ?? 100);
  const limit = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(1000, Math.floor(limitParam))
    : 100;

  const entries = await readRecentPerfStats(limit);

  // Split by stream vs non-stream — they have meaningfully different
  // synthesis profiles (SSE is end-to-end vs JSON is single shot) so an
  // operator comparing p99 wants them broken out.
  const stream = entries.filter((e) => e.stream === true);
  const nonStream = entries.filter((e) => e.stream === false);

  // Bucket cache hits separately too — a flood of cache hits would otherwise
  // hide synthesis-side p99 regressions in the aggregate.
  const cacheMisses = entries.filter((e) => !e.cacheHit);

  function buildSummary(rows: PerfStatsEntry[]) {
    return {
      count: rows.length,
      retrieveMs: summarize(rows.map((e) => e.retrieveMs)),
      rerankMs: summarize(rows.map((e) => e.rerankMs)),
      synthesisMs: summarize(rows.map((e) => e.synthesisMs)),
      verificationMs: summarize(rows.map((e) => e.verificationMs)),
      totalMs: summarize(rows.map((e) => e.totalMs)),
    };
  }

  const firstTs = entries.length ? entries[entries.length - 1]?.ts ?? null : null;
  const lastTs = entries.length ? entries[0]?.ts ?? null : null;

  return NextResponse.json(
    {
      windowSize: limit,
      sampleSize: entries.length,
      firstTs,
      lastTs,
      overall: buildSummary(entries),
      cacheMissOnly: buildSummary(cacheMisses),
      stream: buildSummary(stream),
      nonStream: buildSummary(nonStream),
      now: new Date().toISOString(),
      note:
        'Per-stage p50/p99/avg in ms over the last N synthesis events. ' +
        'Empty sampleSize means no synthesis has been logged on this serverless ' +
        'instance yet (cold start, or perf-stats.jsonl lives only in /tmp on Vercel).',
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'Content-Type': 'application/json; charset=utf-8',
      },
    }
  );
}

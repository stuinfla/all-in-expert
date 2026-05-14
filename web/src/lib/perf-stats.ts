// ─── Perf stats telemetry ───────────────────────────────────────────────────
//
// Append a single JSON line per synthesis to data/qa/perf-stats.jsonl with
// the per-stage timing breakdown already captured by route.ts. The /api/perf
// endpoint reads the last N entries and reports aggregate p50/p99 per stage.
//
// Vercel serverless filesystems are read-only except `/tmp`, so we try a
// stable on-disk path first (works in `npm run dev` and in self-hosted
// Node deploys) and fall back to `/tmp/perf-stats.jsonl` so production stays
// observable without a metrics pipeline. Fail-silent — telemetry must never
// break a user-facing response.

import { existsSync, mkdirSync, promises as fsp } from 'fs';
import { dirname, join } from 'path';

export interface PerfStatsEntry {
  ts?: string;
  retrieveMs: number;
  rerankMs: number;
  synthesisMs: number;
  verificationMs: number;
  totalMs: number;
  mode: string;            // hybrid / tfidf / etc.
  stream: boolean;
  cacheHit?: boolean;
  speaker?: string | null;
  strict?: boolean;
}

// Resolve the writable target once per cold-start. Tries (in order):
//   1. <cwd>/data/qa/perf-stats.jsonl       (web/ co-located build)
//   2. <cwd>/../data/qa/perf-stats.jsonl    (monorepo: cwd=web/, data lives one up)
//   3. /tmp/perf-stats.jsonl                (Vercel/Lambda read-only FS)
function resolveTarget(): string {
  const candidates = [
    join(process.cwd(), 'data', 'qa', 'perf-stats.jsonl'),
    join(process.cwd(), '..', 'data', 'qa', 'perf-stats.jsonl'),
  ];
  for (const p of candidates) {
    try {
      const dir = dirname(p);
      if (existsSync(dir)) return p;
    } catch {
      /* ignore — try next */
    }
  }
  // Last resort: /tmp (writable on Vercel/Lambda)
  return '/tmp/perf-stats.jsonl';
}

let cachedTarget: string | null = null;
function getTarget(): string {
  if (cachedTarget) return cachedTarget;
  cachedTarget = resolveTarget();
  return cachedTarget;
}

/**
 * Append one perf-stats line. Fail-silent.
 */
export async function appendPerfStats(entry: PerfStatsEntry): Promise<void> {
  try {
    const target = getTarget();
    // Ensure parent dir exists (for /tmp this is a no-op; for repo paths
    // mkdir -p covers a fresh clone where data/qa/ may not yet exist).
    try {
      const dir = dirname(target);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    const line =
      JSON.stringify({
        ts: entry.ts ?? new Date().toISOString(),
        retrieveMs: entry.retrieveMs,
        rerankMs: entry.rerankMs,
        synthesisMs: entry.synthesisMs,
        verificationMs: entry.verificationMs,
        totalMs: entry.totalMs,
        mode: entry.mode,
        stream: entry.stream,
        cacheHit: entry.cacheHit ?? false,
        speaker: entry.speaker ?? null,
        strict: entry.strict ?? false,
      }) + '\n';
    await fsp.appendFile(target, line, 'utf8').catch(() => {
      /* fail-silent */
    });
  } catch {
    /* fail-silent — telemetry must never break the response path */
  }
}

/**
 * Read the last `limit` perf-stats entries (default 100). Returns newest-first.
 * Used by /api/perf to compute aggregate p50/p99 per stage.
 *
 * Reads the whole file then slices — fine for jsonl files in the < few-MB
 * range. If perf-stats.jsonl ever grows beyond that, swap in a streaming
 * tail or rotate the file.
 */
export async function readRecentPerfStats(limit = 100): Promise<PerfStatsEntry[]> {
  try {
    const target = getTarget();
    if (!existsSync(target)) return [];
    const raw = await fsp.readFile(target, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const tail = lines.slice(-limit).reverse();
    const out: PerfStatsEntry[] = [];
    for (const line of tail) {
      try {
        out.push(JSON.parse(line) as PerfStatsEntry);
      } catch {
        /* skip malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Compute p50/p99 (and count/avg/max) over an array of numbers.
 * Returns zeros when input is empty.
 */
export interface PercentileSummary {
  count: number;
  p50: number;
  p99: number;
  avg: number;
  max: number;
}

export function summarize(values: number[]): PercentileSummary {
  if (!values.length) return { count: 0, p50: 0, p99: 0, avg: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
    return sorted[idx];
  };
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    count: sorted.length,
    p50: pick(0.5),
    p99: pick(0.99),
    avg: Math.round(sum / sorted.length),
    max: sorted[sorted.length - 1],
  };
}

import { NextResponse } from 'next/server';
import { existsSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-dynamic';

// Process-start timestamp for uptime computation. Captured at module load,
// which on serverless platforms (Vercel) is per-cold-start instance.
const PROCESS_START_MS = Date.now();

// Build-time stamp: read from BUILD_TIME env if set at deploy, else fall
// back to BUILT_AT (Vercel-injected) or module-load time.
const BUILD_TIME =
  process.env.BUILD_TIME ||
  process.env.NEXT_PUBLIC_BUILD_TIME ||
  process.env.VERCEL_GIT_COMMIT_SHA
    ? `${process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? ''} @ ${new Date(PROCESS_START_MS).toISOString()}`
    : new Date(PROCESS_START_MS).toISOString();

/**
 * GET /api/health — observability endpoint.
 *
 * Returns a structured snapshot of corpus + asset state so operators can
 * verify (a) the deployed bundle has its data files, (b) the QA score
 * matches the last reviewed baseline, and (c) the instance is up. Designed
 * to be cheap (no LLM call, no heavy reads) and safe (no secrets, no PII).
 *
 * Reads on every request — Vercel may serve from different cold instances,
 * so this also doubles as a "did the data ship with this deploy?" probe.
 */
export async function GET() {
  const publicData = join(process.cwd(), 'public', 'data');
  const contentIndexPath = join(publicData, 'content-index.json');
  const embeddingsBinPath = join(publicData, 'embeddings.bin');
  const rvfPath = join(publicData, 'all-in-expert.rvf');

  // Walk up from cwd to locate data/qa/{latest,baseline}.json. In `web/`
  // runtime these live one level up at ../data/qa/ (repo root). We surface
  // BOTH: `lastQaScore` returns latest if available, else baseline (so the
  // health endpoint reflects fresh QA runs); `qaLatest` and `qaBaseline`
  // expose the raw snapshots so operators can spot a divergence.
  const qaLatestCandidates = [
    join(process.cwd(), 'data', 'qa', 'latest.json'),
    join(process.cwd(), '..', 'data', 'qa', 'latest.json'),
    join(publicData, 'qa-latest.json'),
  ];
  const qaBaselineCandidates = [
    join(process.cwd(), 'data', 'qa', 'baseline.json'),
    join(process.cwd(), '..', 'data', 'qa', 'baseline.json'),
    join(publicData, 'qa-baseline.json'),
  ];

  let chunkCount = 0;
  let chunkCountSource: 'content-index' | 'unavailable' = 'unavailable';
  if (existsSync(contentIndexPath)) {
    try {
      // content-index.json is a flat { id: {...} } dict. Counting keys is
      // O(n) but fine here — the file is ~10MB and read fully on every
      // ask anyway, so this isn't an incremental cost.
      const idx = JSON.parse(readFileSync(contentIndexPath, 'utf8'));
      chunkCount = Object.keys(idx).length;
      chunkCountSource = 'content-index';
    } catch {
      /* malformed → leave at 0, surface via source field */
    }
  }

  interface QaSnapshot {
    overall: number;
    createdAt: string | null;
    source: 'latest' | 'baseline';
    path: string;
  }
  function readQaSnapshot(
    candidates: string[],
    source: 'latest' | 'baseline'
  ): QaSnapshot | null {
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        if (typeof parsed.overall === 'number') {
          return {
            overall: parsed.overall,
            createdAt: parsed.createdAt ?? null,
            source,
            path: p,
          };
        }
      } catch {
        /* try next candidate */
      }
    }
    return null;
  }
  const qaLatest = readQaSnapshot(qaLatestCandidates, 'latest');
  const qaBaseline = readQaSnapshot(qaBaselineCandidates, 'baseline');
  // Prefer latest, fall back to baseline. `lastQaScore` keeps the same
  // field name for backward compat; `qaScoreSource` tells you which it is.
  const preferred = qaLatest ?? qaBaseline;
  const lastQaScore: number | null = preferred?.overall ?? null;
  const qaBaselineDate: string | null = preferred?.createdAt ?? null;
  const qaScoreSource: 'latest' | 'baseline' | null = preferred?.source ?? null;

  const embeddingsBinExists = existsSync(embeddingsBinPath);
  const rvfExists = existsSync(rvfPath);

  // Asset sizes are useful for verifying the right bundle shipped.
  const embeddingsBinBytes = embeddingsBinExists ? statSync(embeddingsBinPath).size : 0;
  const rvfBytes = rvfExists ? statSync(rvfPath).size : 0;

  // Aggregate verifier telemetry from data/qa/verifier-stats.jsonl. Tail-read
  // the last 100 lines so we don't load an arbitrarily large log into memory.
  // Surfacing this proves the post-generation verifier (ADR-027) is firing
  // and gives us a live hedge-rate measurement.
  const verifierStatsCandidates = [
    join(process.cwd(), 'data', 'qa', 'verifier-stats.jsonl'),
    join(process.cwd(), '..', 'data', 'qa', 'verifier-stats.jsonl'),
  ];
  let verifierStats: {
    last100: { total: number; hedgeRate: number; avgVerificationMs: number; avgUngrounded: number };
  } = {
    last100: { total: 0, hedgeRate: 0, avgVerificationMs: 0, avgUngrounded: 0 },
  };
  for (const p of verifierStatsCandidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      const tail = lines.slice(-100);
      const parsed = tail
        .map((l) => {
          try {
            return JSON.parse(l) as {
              claimsUngrounded?: number;
              hedgesApplied?: boolean;
              verificationMs?: number;
            };
          } catch {
            return null;
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);
      const total = parsed.length;
      if (total > 0) {
        const hedged = parsed.filter((r) => r.hedgesApplied === true).length;
        const sumMs = parsed.reduce((s, r) => s + (typeof r.verificationMs === 'number' ? r.verificationMs : 0), 0);
        const sumUng = parsed.reduce((s, r) => s + (typeof r.claimsUngrounded === 'number' ? r.claimsUngrounded : 0), 0);
        verifierStats = {
          last100: {
            total,
            hedgeRate: Math.round((hedged / total) * 1000) / 1000,
            avgVerificationMs: Math.round(sumMs / total),
            avgUngrounded: Math.round((sumUng / total) * 100) / 100,
          },
        };
      }
      break;
    } catch {
      /* try next candidate */
    }
  }

  const uptimeSec = Math.floor((Date.now() - PROCESS_START_MS) / 1000);

  const status: 'ok' | 'degraded' =
    chunkCount > 0 && embeddingsBinExists ? 'ok' : 'degraded';

  return NextResponse.json(
    {
      status,
      version: 'iter-4',
      buildTime: BUILD_TIME,
      chunkCount,
      chunkCountSource,
      embeddingsBinExists,
      embeddingsBinBytes,
      rvfExists,
      rvfBytes,
      lastQaScore,
      qaBaselineDate,
      qaScoreSource,
      qaLatest,
      qaBaseline,
      verifierStats,
      uptime: `${uptimeSec}`,
      now: new Date().toISOString(),
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'Content-Type': 'application/json; charset=utf-8',
      },
    }
  );
}

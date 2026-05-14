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

  // Walk up from cwd to locate data/qa/baseline.json. In `web/` runtime the
  // QA baseline lives one level up at ../data/qa/baseline.json (repo root).
  // We try both the bundled copy (if present) and the repo-root copy.
  const qaCandidates = [
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

  let lastQaScore: number | null = null;
  let qaBaselineDate: string | null = null;
  for (const p of qaCandidates) {
    if (existsSync(p)) {
      try {
        const baseline = JSON.parse(readFileSync(p, 'utf8'));
        if (typeof baseline.overall === 'number') {
          lastQaScore = baseline.overall;
          qaBaselineDate = baseline.createdAt ?? null;
          break;
        }
      } catch {
        /* try next candidate */
      }
    }
  }

  const embeddingsBinExists = existsSync(embeddingsBinPath);
  const rvfExists = existsSync(rvfPath);

  // Asset sizes are useful for verifying the right bundle shipped.
  const embeddingsBinBytes = embeddingsBinExists ? statSync(embeddingsBinPath).size : 0;
  const rvfBytes = rvfExists ? statSync(rvfPath).size : 0;

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

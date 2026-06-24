#!/usr/bin/env node
/**
 * Cache-warm script for All-In Expert
 *
 * POSTs a known set of common queries against production /api/ask using the
 * QA_BYPASS_TOKEN header so the warming pass does NOT consume the daily 25-
 * call rate-limit budget. Goal: the first real user after a deploy hits a
 * warm cache (in-memory + pi-brain) instead of paying full cold-start
 * synthesis latency (~6-10s).
 *
 * Best-effort: individual request failures are logged but do NOT fail the
 * script — exit code is always 0 (otherwise a flaky deploy could block the
 * weekly pipeline on a transient API timeout).
 *
 * Usage:
 *   QA_BYPASS_TOKEN=xxx node scripts/cache-warm.mjs
 *
 * Wired into scripts/weekly-update.sh right after the Vercel alias step.
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERIES_PATH = join(__dirname, 'cache-warm-queries.json');
const API_URL =
  process.env.CACHE_WARM_URL || 'https://asktheallinexperts.vercel.app/api/ask';
const BYPASS_TOKEN = process.env.QA_BYPASS_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.CACHE_WARM_TIMEOUT_MS || 60_000);

function log(msg) {
  console.log(`[cache-warm] ${msg}`);
}

async function warmOne(entry, idx, total) {
  const body = { query: entry.query };
  if (entry.speaker) body.speaker = entry.speaker;
  if (entry.mode) body.mode = entry.mode;
  if (typeof entry.strict === 'boolean') body.strict = entry.strict;

  const headers = { 'Content-Type': 'application/json' };
  if (BYPASS_TOKEN) headers['x-qa-token'] = BYPASS_TOKEN;  // route.ts validates x-qa-token, NOT x-qa-bypass

  const label =
    `${idx + 1}/${total} ${entry.speaker ? `[${entry.speaker}${entry.strict ? '/strict' : ''}] ` : ''}"${entry.query.slice(0, 60)}"`;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;
    // Drain body so the server can release the connection — but cap parse
    // work; we don't care about content, just status + timing.
    let cacheHit = null;
    try {
      const j = await res.json();
      cacheHit = j?.cacheHit ?? null;
    } catch {
      /* non-JSON or empty — ignore */
    }
    const cacheTag = cacheHit === true ? ' (cache HIT)' : cacheHit === false ? ' (cache MISS)' : '';
    log(`${label} → ${res.status} ${elapsed}ms${cacheTag}`);
    return { ok: res.ok, status: res.status, elapsed };
  } catch (err) {
    const elapsed = Date.now() - start;
    const msg = err?.name === 'AbortError' ? `timeout>${REQUEST_TIMEOUT_MS}ms` : (err?.message || String(err));
    log(`${label} → ERROR ${elapsed}ms (${msg})`);
    return { ok: false, status: 0, elapsed, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  let queries;
  try {
    queries = JSON.parse(readFileSync(QUERIES_PATH, 'utf8'));
  } catch (err) {
    log(`FATAL: cannot read ${QUERIES_PATH}: ${err.message}`);
    process.exit(0); // best-effort — never block deploy
  }
  if (!Array.isArray(queries) || queries.length === 0) {
    log('No queries to warm — exiting.');
    process.exit(0);
  }

  log(`Target: ${API_URL}`);
  log(`Queries: ${queries.length}`);
  log(`Bypass token: ${BYPASS_TOKEN ? 'present' : 'MISSING (warming will count against daily limit!)'}`);

  const wallStart = Date.now();
  const results = [];
  // Serial, not parallel: parallel hammers the Anthropic rate limit on a
  // single deploy and partially defeats the warming goal (each query needs
  // its own synthesis path to populate the in-memory + pi-brain caches).
  for (let i = 0; i < queries.length; i++) {
    // eslint-disable-next-line no-await-in-loop
    const r = await warmOne(queries[i], i, queries.length);
    results.push(r);
  }
  const wallElapsed = Date.now() - wallStart;
  const okCount = results.filter((r) => r.ok).length;
  const avg = Math.round(results.reduce((s, r) => s + r.elapsed, 0) / results.length);
  log(`─── Summary ───`);
  log(`OK: ${okCount}/${results.length}  avg: ${avg}ms  total wall: ${wallElapsed}ms`);
  // Always exit 0 — warming is best-effort.
  process.exit(0);
}

main().catch((err) => {
  log(`Unexpected error: ${err?.stack || err}`);
  process.exit(0);
});

/**
 * Pi-Brain integration — query cache via pi.ruv.io collective intelligence.
 *
 * Two-tier caching:
 *   1. In-memory LRU (per-instance, warm-cache only) — ~1ms lookups
 *   2. Pi-Brain REST (/v1/memories) — cross-instance, persistent — ~300-800ms
 *
 * Cache matching is EXACT on normalized query. Semantic fuzzy-matching is
 * deferred until we've profiled pi.ruv's score distribution on real traffic.
 *
 * Safety: all network failures degrade silently to "cache miss" so the API
 * route can fall through to normal retrieval + synthesis.
 */

import crypto from 'crypto';

const PI_BRAIN_BASE = 'https://pi.ruv.io/v1';
const PI_BRAIN_KEY = process.env.PI_BRAIN_API_KEY || 'brain-ui';
const CACHE_TAG = 'all-in-expert';
const CACHE_VERSION = 'aie-v1';
const CACHE_TTL_MS = 72 * 60 * 60 * 1000; // 72h
const LOOKUP_TIMEOUT_MS = 1200;
const STORE_TIMEOUT_MS = 2500;

export interface CachedResponse {
  report: string;
  citations: unknown[];
  segmentsFound: number;
  totalEntries: number;
  searchMode: string;
}

interface CacheKey {
  query: string;
  speaker: string | null;
  mode: string | null;
}

function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function cacheTitle({ query, speaker, mode }: CacheKey): string {
  const norm = normalizeQuery(query);
  const hash = crypto
    .createHash('sha256')
    .update(`${CACHE_VERSION}|${speaker || ''}|${mode || ''}|${norm}`)
    .digest('hex')
    .slice(0, 16);
  // Keep the human-readable prefix so the pi-brain UI is browsable
  return `AIE-CACHE [${hash}] ${norm.slice(0, 80)}`;
}

// ─── Tier 1: in-memory LRU (survives across warm requests) ─────────
const memCache = new Map<string, { value: CachedResponse; expires: number }>();
const MEM_CACHE_MAX = 200;

function memGet(titleHash: string): CachedResponse | null {
  const hit = memCache.get(titleHash);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    memCache.delete(titleHash);
    return null;
  }
  // Touch LRU
  memCache.delete(titleHash);
  memCache.set(titleHash, hit);
  return hit.value;
}

function memSet(titleHash: string, value: CachedResponse) {
  if (memCache.size >= MEM_CACHE_MAX) {
    const oldestKey = memCache.keys().next().value;
    if (oldestKey) memCache.delete(oldestKey);
  }
  memCache.set(titleHash, { value, expires: Date.now() + CACHE_TTL_MS });
}

// ─── Tier 2: Pi-Brain REST ─────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look up a cached answer.
 *
 * Pi-Brain's /v1/memories/search is semantic; we filter results to EXACT title
 * matches against our deterministic title hash. That prevents false-positive
 * cache hits on genuinely different questions that happen to share vocabulary.
 */
export async function cacheLookup(
  key: CacheKey
): Promise<{ value: CachedResponse; source: 'mem' | 'pi-brain' } | null> {
  const title = cacheTitle(key);
  const titleHash = title.slice(0, 26); // "AIE-CACHE [<16hex>]"

  // Tier 1: in-memory
  const memHit = memGet(titleHash);
  if (memHit) return { value: memHit, source: 'mem' };

  // Tier 2: pi-brain
  const q = encodeURIComponent(titleHash);
  const res = await fetchWithTimeout(
    `${PI_BRAIN_BASE}/memories/search?q=${q}&limit=5`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PI_BRAIN_KEY}`,
        Accept: 'application/json',
      },
    },
    LOOKUP_TIMEOUT_MS
  );
  if (!res || !res.ok) return null;

  let hits: Array<{
    title?: string;
    content?: string;
    tags?: string[];
    created_at?: string;
  }>;
  try {
    hits = await res.json();
  } catch {
    return null;
  }
  if (!Array.isArray(hits)) return null;

  for (const h of hits) {
    if (!h.title || !h.title.startsWith(titleHash)) continue;
    if (!h.tags || !h.tags.includes(CACHE_TAG)) continue;
    if (h.created_at) {
      const age = Date.now() - new Date(h.created_at).getTime();
      if (age > CACHE_TTL_MS) continue;
    }
    if (!h.content) continue;
    try {
      const parsed = JSON.parse(h.content) as CachedResponse;
      if (parsed && typeof parsed.report === 'string') {
        memSet(titleHash, parsed);
        return { value: parsed, source: 'pi-brain' };
      }
    } catch {
      // malformed cache entry → skip
    }
  }
  return null;
}

/**
 * Store a response to both tiers. Failures are silent.
 */
export async function cacheStore(
  key: CacheKey,
  value: CachedResponse
): Promise<void> {
  const title = cacheTitle(key);
  const titleHash = title.slice(0, 26);
  memSet(titleHash, value);

  // Fire-and-forget to pi-brain. We don't await downstream — but we DO await
  // in the API route via Promise.allSettled so Vercel doesn't kill the fn early.
  const body = JSON.stringify({
    category: 'custom',
    title,
    content: JSON.stringify(value),
    tags: [CACHE_TAG, 'cache', CACHE_VERSION, key.speaker || 'all-speakers'],
  });
  await fetchWithTimeout(
    `${PI_BRAIN_BASE}/memories`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PI_BRAIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body,
    },
    STORE_TIMEOUT_MS
  );
}

// ─── Health probe (used by /api/health if we add one) ──────────────
export async function piBrainHealth(): Promise<{ ok: boolean; latencyMs: number }> {
  const t0 = Date.now();
  const res = await fetchWithTimeout(
    `${PI_BRAIN_BASE}/challenge`,
    { method: 'GET' },
    1000
  );
  return { ok: !!res && res.ok, latencyMs: Date.now() - t0 };
}

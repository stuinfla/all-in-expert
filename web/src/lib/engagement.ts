/**
 * Engagement tracking — visitor count + 1-5 star ratings.
 *
 * Visitor count: abacus.jasoncameron.dev — free atomic INCR counter,
 * no auth, no env vars, persistent across deploys + cold starts.
 *
 * Ratings: pi.ruv.io (kept) — needs sum aggregation, which abacus can't do.
 */

// Visitor counter — abacus public atomic counter
const ABACUS_BASE = 'https://abacus.jasoncameron.dev';
const ABACUS_NS = 'asktheallinexperts';
const ABACUS_KEY = 'visitors';
const ABACUS_TIMEOUT_MS = 4000;

// Read-cache: don't hammer abacus on every /api/stats GET
let cachedVisitorCount = 0;
let cachedAt = 0;
const VISITOR_CACHE_TTL_MS = 5_000;

// Ratings — still on pi-brain (needs sum, abacus is counter-only)
const PI_BRAIN_BASE = 'https://pi.ruv.io/v1';
const PI_BRAIN_KEY = process.env.PI_BRAIN_API_KEY || 'brain-ui';
const PI_BRAIN_TIMEOUT_MS = 2500;
const RATINGS_TITLE = 'AIE-ENGAGEMENT ratings total';

interface RatingsState {
  count: number;
  sum: number;
  synced: boolean;
}

const ratings: RatingsState = { count: 0, sum: 0, synced: false };

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: c.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function readLatest(
  titlePrefix: string
): Promise<{ title: string; content: string } | null> {
  const res = await fetchWithTimeout(
    `${PI_BRAIN_BASE}/memories/search?q=${encodeURIComponent(titlePrefix)}&limit=20`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${PI_BRAIN_KEY}`, Accept: 'application/json' },
    },
    PI_BRAIN_TIMEOUT_MS
  );
  if (!res || !res.ok) return null;
  try {
    const hits = (await res.json()) as Array<{
      title?: string;
      content?: string;
      created_at?: string;
    }>;
    if (!Array.isArray(hits)) return null;
    // Find the newest entry whose title matches our prefix
    let best: { title: string; content: string; ts: number } | null = null;
    for (const h of hits) {
      if (!h.title || !h.title.startsWith(titlePrefix)) continue;
      const ts = h.created_at ? new Date(h.created_at).getTime() : 0;
      if (!best || ts > best.ts) best = { title: h.title, content: h.content || '', ts };
    }
    return best ? { title: best.title, content: best.content } : null;
  } catch {
    return null;
  }
}

async function writeLatest(title: string, payload: object): Promise<void> {
  await fetchWithTimeout(
    `${PI_BRAIN_BASE}/memories`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${PI_BRAIN_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        category: 'solution',
        title,
        content: JSON.stringify(payload),
        tags: ['all-in-expert', 'engagement'],
      }),
    },
    PI_BRAIN_TIMEOUT_MS
  );
}

async function abacusFetch(path: string): Promise<number | null> {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ABACUS_TIMEOUT_MS);
  try {
    const res = await fetch(`${ABACUS_BASE}${path}`, {
      signal: c.signal,
      cache: 'no-store',
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { value?: number };
    return typeof j.value === 'number' ? j.value : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function readVisitorCount(): Promise<number> {
  const now = Date.now();
  if (cachedVisitorCount > 0 && now - cachedAt < VISITOR_CACHE_TTL_MS) {
    return cachedVisitorCount;
  }
  const v = await abacusFetch(`/get/${ABACUS_NS}/${ABACUS_KEY}`);
  if (v !== null) {
    cachedVisitorCount = v;
    cachedAt = now;
    return v;
  }
  // abacus unreachable — return last known
  return cachedVisitorCount;
}

async function syncRatings(): Promise<void> {
  if (ratings.synced) return;
  const hit = await readLatest(RATINGS_TITLE);
  if (!hit) return;
  try {
    const parsed = JSON.parse(hit.content) as { count?: number; sum?: number };
    if (typeof parsed.count === 'number' && parsed.count > ratings.count) {
      ratings.count = parsed.count;
      ratings.sum = typeof parsed.sum === 'number' ? parsed.sum : 0;
    }
    ratings.synced = true;
  } catch {
    // skip
  }
}

export async function recordVisit(): Promise<number> {
  const v = await abacusFetch(`/hit/${ABACUS_NS}/${ABACUS_KEY}`);
  if (v !== null) {
    cachedVisitorCount = v;
    cachedAt = Date.now();
    return v;
  }
  // abacus unreachable — return last known so the UI doesn't regress
  return cachedVisitorCount;
}

export async function recordRating(stars: number): Promise<{ count: number; avg: number }> {
  if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
    throw new Error('stars must be 1..5');
  }
  const normalized = Math.round(stars);
  await syncRatings();
  ratings.count += 1;
  ratings.sum += normalized;
  writeLatest(RATINGS_TITLE, {
    count: ratings.count,
    sum: ratings.sum,
    ts: Date.now(),
  }).catch(() => {});
  return { count: ratings.count, avg: ratings.count > 0 ? ratings.sum / ratings.count : 0 };
}

export async function getEngagement(): Promise<{
  visitors: number;
  ratings: { count: number; avg: number };
}> {
  const [v] = await Promise.all([readVisitorCount(), syncRatings()]);
  return {
    visitors: v,
    ratings: {
      count: ratings.count,
      avg: ratings.count > 0 ? ratings.sum / ratings.count : 0,
    },
  };
}

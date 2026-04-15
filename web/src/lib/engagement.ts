/**
 * Engagement tracking — visitor count and 1-5 star ratings.
 *
 * Same tier pattern as rate-limit: in-memory authoritative per-instance,
 * pi-brain for approximate cross-instance sync and persistence. Not exact
 * under heavy concurrent load, but fine for hobby-traffic social-proof
 * signals ("1,234 visitors · 4.2/5 from 27 ratings").
 */

const PI_BRAIN_BASE = 'https://pi.ruv.io/v1';
const PI_BRAIN_KEY = process.env.PI_BRAIN_API_KEY || 'brain-ui';
const PI_BRAIN_TIMEOUT_MS = 2500;

// Deterministic titles so lookups always hit the latest aggregate
const VISITS_TITLE = 'AIE-ENGAGEMENT visitors total';
const RATINGS_TITLE = 'AIE-ENGAGEMENT ratings total';

interface VisitorState {
  total: number;
  synced: boolean;
}
interface RatingsState {
  count: number;
  sum: number;
  synced: boolean;
}

const visitors: VisitorState = { total: 0, synced: false };
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

async function syncVisitors(): Promise<void> {
  if (visitors.synced) return;
  visitors.synced = true;
  const hit = await readLatest(VISITS_TITLE);
  if (!hit) return;
  try {
    const parsed = JSON.parse(hit.content) as { total?: number };
    if (typeof parsed.total === 'number' && parsed.total > visitors.total) {
      visitors.total = parsed.total;
    }
  } catch {
    // skip
  }
}

async function syncRatings(): Promise<void> {
  if (ratings.synced) return;
  ratings.synced = true;
  const hit = await readLatest(RATINGS_TITLE);
  if (!hit) return;
  try {
    const parsed = JSON.parse(hit.content) as { count?: number; sum?: number };
    if (typeof parsed.count === 'number' && parsed.count > ratings.count) {
      ratings.count = parsed.count;
      ratings.sum = typeof parsed.sum === 'number' ? parsed.sum : 0;
    }
  } catch {
    // skip
  }
}

export async function recordVisit(): Promise<number> {
  await syncVisitors();
  visitors.total += 1;
  writeLatest(VISITS_TITLE, { total: visitors.total, ts: Date.now() }).catch(() => {});
  return visitors.total;
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
  await Promise.all([syncVisitors(), syncRatings()]);
  return {
    visitors: visitors.total,
    ratings: {
      count: ratings.count,
      avg: ratings.count > 0 ? ratings.sum / ratings.count : 0,
    },
  };
}

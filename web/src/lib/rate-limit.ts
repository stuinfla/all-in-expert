/**
 * Daily rate limiter for /api/ask — soft global cap of 25 synthesis calls
 * per UTC day. Resets at 00:00 UTC.
 *
 * Storage tiers:
 *   1. In-memory counter per function instance (authoritative within that
 *      instance; fast, atomic)
 *   2. Pi-Brain persisted counter (approximate cross-instance sync; slow,
 *      eventually consistent)
 *
 * Caveat: Vercel may scale to multiple concurrent function instances. Each
 * instance has its own in-memory counter; pi-brain persistence catches most
 * cross-instance drift but isn't atomic. In practice for a hobby-traffic
 * site this means the TRUE daily cap sits between 25 (single instance)
 * and 25×instance-count (peak burst). Upgrading to Upstash Redis with
 * atomic INCR would make it exact.
 *
 * Cached responses (mem or pi-brain hit) do NOT count against the limit —
 * only fresh syntheses that actually invoke Claude.
 */

const DAILY_LIMIT = 25;
const PI_BRAIN_BASE = 'https://pi.ruv.io/v1';
const PI_BRAIN_KEY = process.env.PI_BRAIN_API_KEY || 'brain-ui';
const PI_BRAIN_TIMEOUT_MS = 2500;
const COUNTER_TITLE_PREFIX = 'AIE-RATELIMIT';

interface DayState {
  dayKey: string;
  count: number;
}

// Module-level state survives across warm requests in a single fn instance.
let state: DayState | null = null;
let piBrainSynced = false;

function currentDayKey(): string {
  // UTC yyyy-mm-dd
  return new Date().toISOString().slice(0, 10);
}

function getOrInitState(): DayState {
  const today = currentDayKey();
  if (!state || state.dayKey !== today) {
    state = { dayKey: today, count: 0 };
    piBrainSynced = false;
  }
  return state;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response | null> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * One-time per-instance: on first call of the day, try to read the
 * current day's counter from pi-brain so a cold-started instance doesn't
 * reset the whole cap to zero.
 */
async function syncFromPiBrain(s: DayState): Promise<void> {
  if (piBrainSynced) return;
  piBrainSynced = true; // attempt once; if it fails we just proceed
  const title = `${COUNTER_TITLE_PREFIX} ${s.dayKey}`;
  const res = await fetchWithTimeout(
    `${PI_BRAIN_BASE}/memories/search?q=${encodeURIComponent(title)}&limit=10`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${PI_BRAIN_KEY}`, Accept: 'application/json' },
    },
    PI_BRAIN_TIMEOUT_MS
  );
  if (!res || !res.ok) return;
  try {
    const hits = (await res.json()) as Array<{ title?: string; content?: string }>;
    if (!Array.isArray(hits)) return;
    // Find the highest count observed for today
    let max = 0;
    for (const h of hits) {
      if (!h.title || !h.title.startsWith(title)) continue;
      try {
        const parsed = JSON.parse(h.content || '{}') as { count?: number };
        if (typeof parsed.count === 'number' && parsed.count > max) max = parsed.count;
      } catch {
        // skip
      }
    }
    if (max > s.count) {
      console.log(`[ratelimit] synced from pi-brain: ${s.count} → ${max} for ${s.dayKey}`);
      s.count = max;
    }
  } catch {
    // swallow
  }
}

/**
 * Push the current counter to pi-brain so other instances can see it.
 * Fire-and-forget: safe to call without await.
 */
async function pushToPiBrain(s: DayState): Promise<void> {
  const title = `${COUNTER_TITLE_PREFIX} ${s.dayKey}`;
  const body = JSON.stringify({
    category: 'solution',
    title,
    content: JSON.stringify({ dayKey: s.dayKey, count: s.count, ts: Date.now() }),
    tags: ['all-in-expert', 'ratelimit', s.dayKey],
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
    PI_BRAIN_TIMEOUT_MS
  );
}

export interface RateLimitCheckResult {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  dayKey: string;
  resetsAt: string; // ISO of next UTC midnight
}

function nextUtcMidnightISO(): string {
  const d = new Date();
  const next = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0)
  );
  return next.toISOString();
}

/**
 * Check whether a new paid synthesis call is allowed. Does NOT increment —
 * call `recordCall()` after the synthesis completes (or on a confirmed
 * non-cached path) to consume the budget.
 */
export async function checkRateLimit(): Promise<RateLimitCheckResult> {
  const s = getOrInitState();
  await syncFromPiBrain(s);
  return {
    allowed: s.count < DAILY_LIMIT,
    count: s.count,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - s.count),
    dayKey: s.dayKey,
    resetsAt: nextUtcMidnightISO(),
  };
}

/**
 * Record a consumed call (after synthesis actually ran). Updates local
 * counter synchronously; pi-brain persistence is fire-and-forget.
 */
export function recordCall(): RateLimitCheckResult {
  const s = getOrInitState();
  s.count += 1;
  // Fire-and-forget pi-brain write — don't block the response
  pushToPiBrain(s).catch(() => {});
  return {
    allowed: s.count < DAILY_LIMIT,
    count: s.count,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - s.count),
    dayKey: s.dayKey,
    resetsAt: nextUtcMidnightISO(),
  };
}

/**
 * Read-only snapshot for /api/stats. Also syncs from pi-brain so stats
 * reflect the latest known cross-instance count.
 */
export async function getStats(): Promise<RateLimitCheckResult> {
  const s = getOrInitState();
  await syncFromPiBrain(s);
  return {
    allowed: s.count < DAILY_LIMIT,
    count: s.count,
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - s.count),
    dayKey: s.dayKey,
    resetsAt: nextUtcMidnightISO(),
  };
}

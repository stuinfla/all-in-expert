import { after } from 'next/server';

/**
 * Semantic-retrieval health tracking.
 *
 * Why this exists: on 2026-07-09 the OpenAI account went to a negative credit
 * balance. Every embedding call returned HTTP 429 `insufficient_quota`, so
 * `embedQuery()` threw, `semanticSearchBin()` caught it and returned null, and
 * `hybridSearch()` happily fused zero dense hits with the TF-IDF list — while
 * still reporting the hardcoded label `mode: 'hybrid'`. The API returned 200,
 * answer quality silently collapsed to keyword search, and nothing alerted.
 *
 * The rule this enforces: a degraded dense path must be VISIBLE — in the
 * response body (honest `searchMode`), in the logs, on /api/health, and on
 * Stuart's phone. Answers keep flowing (the site stays up), but nobody has to
 * discover the degradation by noticing the answers got worse.
 */

// Must match the vector space of the precomputed doc vectors in embeddings.bin.
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 384;

export interface SemanticStatus {
  ok: boolean;
  /** Machine-readable cause, e.g. 'insufficient_quota', 'api_key_missing'. Never contains the key. */
  reason: string | null;
  at: string;
}

// Per-instance state. Serverless gives each cold instance its own module scope,
// so this reflects what THIS instance last observed — good enough to drive the
// response label and the alert. /api/health does a live probe instead, because
// it may well be answered by a different instance than the one that failed.
let current: SemanticStatus = { ok: true, reason: null, at: new Date(0).toISOString() };

// Rate-limit the phone push. Without this, a 429 storm sends one notification
// per request. 15 min is short enough to be timely, long enough not to spam.
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
let lastAlertMs = 0;

export function getSemanticStatus(): SemanticStatus {
  return current;
}

export function recordSemanticSuccess(): void {
  current = { ok: true, reason: null, at: new Date().toISOString() };
}

/**
 * Reduce an upstream error to a coarse, non-secret code.
 *
 * MUST NOT pass raw provider bodies through. OpenAI's 401 body echoes back the
 * offending key as `sk-proj-****************3456` — prefix plus the LAST FOUR
 * characters. That verbatim body was previously forwarded to console.error and
 * to an ntfy topic (ntfy.sh topics are readable by anyone who knows the name),
 * publishing key material. Verified 2026-07-09 with a sentinel key.
 *
 * So: extract the HTTP status and OpenAI's own error `code`/`type`, and drop
 * everything else. The final redaction pass is belt-and-braces for any path
 * that doesn't match the expected shape.
 */
function sanitizeReason(raw: string): string {
  // embedQuery() already throws `OpenAI embeddings <status>[: <code>]`. The JSON
  // fallbacks cover any caller that still hands us a raw provider body.
  const http = /OpenAI embeddings (\d{3})(?::\s*([a-z_]+))?/.exec(raw);
  const jsonCode = /"code"\s*:\s*"([a-z_]+)"/.exec(raw) ?? /"type"\s*:\s*"([a-z_]+)"/.exec(raw);
  const code = http?.[2] ?? jsonCode?.[1] ?? null;

  let out: string;
  if (http || code) {
    out = [http ? `openai_http_${http[1]}` : null, code].filter(Boolean).join(':');
  } else {
    out = raw;
  }

  return out
    .replace(/sk-[A-Za-z0-9_*-]+/g, '[redacted]') // never emit key-shaped tokens
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export function recordSemanticFailure(reason: string): void {
  const safe = sanitizeReason(reason);
  current = { ok: false, reason: safe, at: new Date().toISOString() };
  console.error(`[semantic-health] DEGRADED — dense retrieval unavailable: ${safe}`);
  notifyDegraded(safe);
}

/**
 * Fire-and-forget phone push on the same ntfy topic the pipeline scripts use.
 * Scheduled with `after()` so it runs once the response has been flushed —
 * a plain un-awaited fetch can be killed when the serverless instance freezes.
 *
 * The topic is read from AIE_NTFY_TOPIC and NOT hardcoded: the ntfy topic name
 * is itself the subscribe/publish credential, and this repo is on GitHub.
 */
function notifyDegraded(reason: string): void {
  const now = Date.now();
  if (now - lastAlertMs < ALERT_COOLDOWN_MS) return;
  lastAlertMs = now;

  const topic = process.env.AIE_NTFY_TOPIC;
  if (!topic) return; // no topic configured → console.error above is the only signal

  try {
    after(async () => {
      try {
        await fetch(`https://ntfy.sh/${topic}`, {
          method: 'POST',
          headers: {
            Title: 'All-In Expert: semantic search DOWN',
            Priority: 'high',
            Tags: 'warning',
          },
          body: `Dense retrieval is failing (${reason}). /api/ask is serving TF-IDF-only answers. Check the OpenAI key and credit balance.`,
        });
      } catch {
        /* best-effort: never let an alert failure break a user request */
      }
    });
  } catch {
    // `after()` throws outside a request scope (e.g. if called from a script).
    // The console.error above already recorded the degradation.
  }
}

interface LiveProbe {
  ok: boolean;
  reason: string | null;
  at: number;
}
let probeCache: LiveProbe | null = null;
// One live probe per minute per instance. A 1-token embedding costs ~$0.00000002,
// so the cache exists to bound abuse of an unauthenticated endpoint, not cost.
const PROBE_TTL_MS = 60_000;

/**
 * Live check of the dense path: does the OpenAI key resolve AND can it spend?
 *
 * A `GET /v1/models` would only prove the key authenticates — the 2026-07-09
 * outage returned 200 there while every billable call returned 429. So this
 * deliberately issues a real (tiny) embedding request. Distinguishing those two
 * is the whole point: 401 = bad key, 429 insufficient_quota = empty wallet.
 */
export async function probeSemanticLive(): Promise<{ ok: boolean; reason: string | null; checkedAt: string; cached: boolean }> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) {
    return { ok: probeCache.ok, reason: probeCache.reason, checkedAt: new Date(probeCache.at).toISOString(), cached: true };
  }

  const apiKey = process.env.OPEN_AI_KEY || process.env.OPENAI_API_KEY;
  let ok = false;
  let reason: string | null = null;

  if (!apiKey) {
    reason = 'api_key_missing';
  } else {
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: 'health', dimensions: EMBEDDING_DIMS }),
      });
      if (res.ok) {
        ok = true;
      } else {
        // Prefer OpenAI's `code` — it names the actionable cause
        // (`insufficient_quota` = empty wallet, `invalid_api_key` = bad key)
        // where `type` only says `invalid_request_error` for both.
        const body = (await res.json().catch(() => null)) as { error?: { type?: string; code?: string } } | null;
        reason = sanitizeReason(body?.error?.code ?? body?.error?.type ?? `http_${res.status}`);
      }
    } catch {
      reason = 'network_error';
    }
  }

  probeCache = { ok, reason, at: Date.now() };
  return { ok, reason, checkedAt: new Date(probeCache.at).toISOString(), cached: false };
}

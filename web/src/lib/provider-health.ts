import { after } from 'next/server';

/**
 * Health tracking for the external providers on the critical path.
 *
 * Two independent legs, and BOTH must work for the site to answer:
 *   • retrieval  — OpenAI `text-embedding-3-small` embeds the query
 *   • synthesis  — Anthropic (Opus by default) writes the answer
 *
 * Why this exists, twice over:
 *
 * 2026-07-09 (morning): the OpenAI account went to a negative credit balance.
 * `embedQuery()` threw, `semanticSearchBin()` swallowed it, and `hybridSearch()`
 * fused zero dense hits with TF-IDF while still reporting its hardcoded label
 * `mode: 'hybrid'`. HTTP 200, quality quietly halved, no alert.
 *
 * 2026-07-09 (evening): the ANTHROPIC account ran out of credit. `/api/ask`
 * returned HTTP 500 to every visitor — and `/api/health` reported `status: ok`,
 * because it only probed the embedding provider. Retrieval health is not site
 * health. A health endpoint that green-lights a dead site is worse than none.
 *
 * The rule: every provider on the critical path is probed, reported, and alerted.
 */

const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 384;
/** Cheapest model that still proves the account can spend. */
const SYNTH_PROBE_MODEL = 'claude-haiku-4-5-20251001';

export type Leg = 'semantic' | 'synthesis';

export interface ProviderStatus {
  ok: boolean;
  /** Machine-readable cause, e.g. 'insufficient_quota', 'credit_balance_too_low'. Never a secret. */
  reason: string | null;
  at: string;
}

/**
 * Reduce an upstream error to a coarse, non-secret code.
 *
 * MUST NOT pass raw provider bodies through. OpenAI's 401 body echoes the
 * offending key as `sk-proj-****************3456` — prefix plus the LAST FOUR
 * characters. That verbatim body was previously forwarded to console.error, to
 * an ntfy topic, AND (via route.ts's catch-all) to unauthenticated HTTP clients.
 * Verified 2026-07-09 with a sentinel key.
 */
/**
 * Anthropic states several distinct billing conditions in PROSE rather than a
 * machine code, and the prose carries operational detail (balances, reset dates)
 * that must never reach a public endpoint. Map each to a stable code.
 */
const PROSE_CODES: Array<[RegExp, string]> = [
  [/credit balance is too low/i, 'credit_balance_too_low'],
  [/reached your specified API usage limits?/i, 'usage_limit_reached'],
  [/rate.?limit/i, 'rate_limited'],
  [/overloaded/i, 'overloaded'],
  // "Incorrect API key provided: sk-proj-****3456" — OpenAI's 401 prose, which
  // echoes the key's last four characters. Match it before the fallback so it is
  // named rather than merely redacted.
  [/invalid x-api-key|authentication_error|invalid_api_key|incorrect api key provided/i, 'invalid_api_key'],
];

export function sanitizeReason(raw: string): string {
  for (const [re, code] of PROSE_CODES) if (re.test(raw)) return code;

  const http = /(?:OpenAI|Anthropic|Gemini)[^\d]{0,20}(\d{3})(?::\s*([a-z_]+))?/i.exec(raw);
  const jsonCode = /"code"\s*:\s*"([a-z_]+)"/.exec(raw) ?? /"type"\s*:\s*"([a-z_]+)"/.exec(raw);
  if (http || jsonCode) {
    const code = http?.[2] ?? jsonCode?.[1] ?? null;
    return [http ? `http_${http[1]}` : null, code].filter(Boolean).join(':').slice(0, 120);
  }

  // Already a bare code (no whitespace)? Pass it through, redacted. Otherwise it
  // is unrecognised provider prose — /api/health is PUBLIC, so never echo it.
  // On 2026-07-09 this endpoint briefly published Anthropic's spend-limit notice,
  // reset date and all, to anonymous callers.
  const bare = raw.trim();
  if (/^[A-Za-z0-9_:.-]{1,60}$/.test(bare)) return bare.replace(/sk-[A-Za-z0-9_*-]+/g, '[redacted]');
  return 'provider_error';
}

// Per-instance state. Serverless gives each cold instance its own module scope,
// so this reflects what THIS instance last observed — enough to drive the
// response label and the alert. /api/health probes live instead, because it may
// be answered by a different instance than the one that failed.
const state: Record<Leg, ProviderStatus> = {
  semantic: { ok: true, reason: null, at: new Date(0).toISOString() },
  synthesis: { ok: true, reason: null, at: new Date(0).toISOString() },
};

// Rate-limit the phone push per leg. Without this, an outage sends one
// notification per request. 15 min is timely without being a firehose.
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;
const lastAlertMs: Record<Leg, number> = { semantic: 0, synthesis: 0 };

const ALERT_COPY: Record<Leg, { title: string; body: (r: string) => string }> = {
  semantic: {
    title: 'All-In Expert: semantic search DOWN',
    body: (r) =>
      `Dense retrieval is failing (${r}). /api/ask is serving TF-IDF-only answers. Check the OpenAI key and credit balance.`,
  },
  synthesis: {
    title: 'All-In Expert: SITE DOWN (synthesis)',
    body: (r) =>
      `Answer synthesis is failing (${r}). /api/ask cannot answer at all. Check the Anthropic key and credit balance.`,
  },
};

export function getStatus(leg: Leg): ProviderStatus {
  return state[leg];
}

export function recordSuccess(leg: Leg): void {
  state[leg] = { ok: true, reason: null, at: new Date().toISOString() };
}

export function recordFailure(leg: Leg, reason: string): void {
  const safe = sanitizeReason(reason);
  state[leg] = { ok: false, reason: safe, at: new Date().toISOString() };
  console.error(`[provider-health] ${leg.toUpperCase()} DEGRADED: ${safe}`);
  notifyDegraded(leg, safe);
}

// Named helpers so call sites read naturally.
export const recordSemanticSuccess = (): void => recordSuccess('semantic');
export const recordSemanticFailure = (r: string): void => recordFailure('semantic', r);
export const recordSynthesisSuccess = (): void => recordSuccess('synthesis');
export const recordSynthesisFailure = (r: string): void => recordFailure('synthesis', r);

/**
 * Fire-and-forget phone push on the same ntfy topic the pipeline scripts use.
 * Scheduled with `after()` so it runs once the response has been flushed — a
 * plain un-awaited fetch can be killed when the serverless instance freezes.
 *
 * The topic is read from AIE_NTFY_TOPIC and NOT hardcoded: on ntfy.sh the topic
 * name IS the credential, and this repo is public.
 */
function notifyDegraded(leg: Leg, reason: string): void {
  const now = Date.now();
  if (now - lastAlertMs[leg] < ALERT_COOLDOWN_MS) return;
  lastAlertMs[leg] = now;

  const topic = process.env.AIE_NTFY_TOPIC;
  if (!topic) return; // no topic configured → console.error above is the only signal

  const copy = ALERT_COPY[leg];
  try {
    after(async () => {
      try {
        await fetch(`https://ntfy.sh/${topic}`, {
          method: 'POST',
          headers: {
            Title: copy.title,
            Priority: leg === 'synthesis' ? 'urgent' : 'high',
            Tags: leg === 'synthesis' ? 'rotating_light' : 'warning',
          },
          body: copy.body(reason),
        });
      } catch {
        /* best-effort: never let an alert failure break a user request */
      }
    });
  } catch {
    // `after()` throws outside a request scope. console.error already recorded it.
  }
}

interface LiveProbe {
  ok: boolean;
  reason: string | null;
  at: number;
}
const probeCache: Partial<Record<Leg, LiveProbe>> = {};
// One live probe per minute per leg per instance. Both probes cost a fraction of
// a cent; the cache bounds abuse of an unauthenticated endpoint, not spend.
const PROBE_TTL_MS = 60_000;

export type ProbeResult = { ok: boolean; reason: string | null; checkedAt: string; cached: boolean };

function cached(leg: Leg): ProbeResult | null {
  const c = probeCache[leg];
  if (c && Date.now() - c.at < PROBE_TTL_MS) {
    return { ok: c.ok, reason: c.reason, checkedAt: new Date(c.at).toISOString(), cached: true };
  }
  return null;
}

function store(leg: Leg, ok: boolean, reason: string | null): ProbeResult {
  const at = Date.now();
  probeCache[leg] = { ok, reason, at };
  return { ok, reason, checkedAt: new Date(at).toISOString(), cached: false };
}

/**
 * Live check of the dense-retrieval leg: does the OpenAI key resolve AND spend?
 *
 * A `GET /v1/models` would only prove the key authenticates — during the
 * 2026-07-09 outage that returned 200 while every billable call returned 429.
 * So this issues a real (tiny) embedding request. 401 = bad key,
 * 429 insufficient_quota = empty wallet. The distinction is the whole point.
 */
export async function probeSemanticLive(): Promise<ProbeResult> {
  const hit = cached('semantic');
  if (hit) return hit;

  const apiKey = process.env.OPEN_AI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) return store('semantic', false, 'api_key_missing');

  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: 'health', dimensions: EMBEDDING_DIMS }),
    });
    if (res.ok) return store('semantic', true, null);
    const body = (await res.json().catch(() => null)) as { error?: { type?: string; code?: string } } | null;
    return store('semantic', false, sanitizeReason(body?.error?.code ?? body?.error?.type ?? `OpenAI ${res.status}`));
  } catch {
    return store('semantic', false, 'network_error');
  }
}

/**
 * Live check of the synthesis leg: can Anthropic actually be billed?
 *
 * Anthropic answers a dead balance with HTTP 400 `invalid_request_error` and the
 * prose "Your credit balance is too low…" — NOT a 402, and not a machine code —
 * so a naive status check misreads it as a malformed request. sanitizeReason()
 * maps it to `credit_balance_too_low`.
 */
export async function probeSynthesisLive(): Promise<ProbeResult> {
  const hit = cached('synthesis');
  if (hit) return hit;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return store('synthesis', false, 'api_key_missing');

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: SYNTH_PROBE_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (res.ok) return store('synthesis', true, null);
    const body = (await res.json().catch(() => null)) as { error?: { type?: string; message?: string } } | null;
    const raw = body?.error?.message ?? body?.error?.type ?? `Anthropic ${res.status}`;
    return store('synthesis', false, sanitizeReason(raw));
  } catch {
    return store('synthesis', false, 'network_error');
  }
}

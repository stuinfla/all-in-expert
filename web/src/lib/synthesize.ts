/**
 * Multi-provider synthesis router for the model bake-off.
 *
 * Routes a single (system, user) prompt to Anthropic / OpenAI / Google by model-id
 * prefix and returns the plain text. Anthropic uses the installed SDK; OpenAI and
 * Google use REST (no SDK install). This lets the QA harness sweep the SAME pipeline
 * (retrieval + prompt + verifiers + grader) across providers via the SYNTH_MODEL env.
 *
 * Provider conventions handled here:
 *  - OpenAI gpt-5* / o* (reasoning): use `max_completion_tokens`, omit `temperature`
 *    (reasoning models reject non-default temp), and give token headroom so reasoning
 *    tokens don't starve the visible answer.
 *  - OpenAI gpt-4*: classic `max_tokens` + temperature.
 *  - Gemini: systemInstruction + contents, `maxOutputTokens` with headroom for thinking.
 */
import Anthropic from '@anthropic-ai/sdk';

export interface SynthArgs {
  model: string;
  system: string;
  userPrompt: string;
  maxTokens: number;
  anthropicKey?: string;
}

const SYNTH_TIMEOUT_MS = 90_000; // reasoning/pro models can be slow

function isOpenAIReasoning(model: string): boolean {
  return /^(o[0-9]|gpt-5)/.test(model);
}

export async function synthesizeText(args: SynthArgs): Promise<string> {
  const { model, system, userPrompt, maxTokens } = args;

  // ── Anthropic ──────────────────────────────────────────────────────────
  if (model.startsWith('claude')) {
    const key = args.anthropicKey || process.env.ANTHROPIC_API_KEY;
    const client = new Anthropic({ apiKey: key });
    const res = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // Opus 4.8 deprecates temperature; the SDK drops undefined keys.
      temperature: model.includes('opus') ? undefined : 0.3,
      system,
      messages: [{ role: 'user', content: userPrompt }],
    });
    return res.content[0]?.type === 'text' ? res.content[0].text : '';
  }

  // ── OpenAI (gpt-* / o*) via REST ─────────────────────────────────────────
  if (/^(gpt-|o[0-9]|chatgpt)/.test(model)) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY missing');
    const reasoning = isOpenAIReasoning(model);
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userPrompt },
      ],
    };
    if (reasoning) {
      // Headroom so reasoning tokens don't consume the whole budget.
      body.max_completion_tokens = Math.max(maxTokens * 3, 8000);
    } else {
      body.max_tokens = maxTokens;
      body.temperature = 0.3;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      // Never embed the raw body: OpenAI's 401 echoes the key as
      // `sk-proj-****…3456`, and this message reaches logs and (formerly) HTTP
      // clients. Keep the status and OpenAI's own error code — the actionable part.
      if (!r.ok) {
        const body = await r.text();
        const code = /"code"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] ?? /"type"\s*:\s*"([a-z_]+)"/.exec(body)?.[1] ?? '';
        throw new Error(`OpenAI ${r.status}${code ? `: ${code}` : ''}`);
      }
      const d = await r.json();
      return d.choices?.[0]?.message?.content || '';
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Google Gemini via REST ───────────────────────────────────────────────
  if (model.startsWith('gemini')) {
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!key) throw new Error('GEMINI/GOOGLE_API_KEY missing');
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: Math.max(maxTokens * 2, 8000), temperature: 0.3 },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SYNTH_TIMEOUT_MS);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!r.ok) {
        const body = await r.text();
        const status = /"status"\s*:\s*"([A-Z_]+)"/.exec(body)?.[1]?.toLowerCase() ?? '';
        throw new Error(`Gemini ${r.status}${status ? `: ${status}` : ''}`);
      }
      const d = await r.json();
      const parts = d.candidates?.[0]?.content?.parts || [];
      return parts.map((p: { text?: string }) => p.text || '').join('');
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(`Unknown model provider for "${model}"`);
}

#!/usr/bin/env node
/**
 * 20-question QA harness for All-In Expert
 *
 * Runs 20 diverse queries through the production API, collects the responses,
 * and uses Claude to grade each response 1-100 on:
 *   - Voice accuracy (does it sound like the besties?)
 *   - Content grounding (does it use real retrieved segments?)
 *   - Citation quality (are the [N] refs accurate and useful?)
 *   - Recency respect (does it prefer recent segments when they exist?)
 *   - Overall usefulness
 *
 * Prints a scorecard. Flags anything <85 for iteration.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
config({ path: join(ROOT, '.env') });

const API_URL = process.env.ALL_IN_API_URL || 'https://asktheallinexperts.vercel.app/api/ask';
const OUT_DIR = join(ROOT, 'data', 'qa');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── 20 diverse test questions ────────────────────────────────
const TEST_QUESTIONS = [
  { id: 'q01', category: 'Markets', query: 'Whether Anthropic is doing a good job these days' },
  { id: 'q02', category: 'Macro', query: 'What do the besties think about the US national debt crisis?' },
  { id: 'q03', category: 'Politics', query: 'Should the US regulate AI companies?', mode: 'analysis' },
  { id: 'q04', category: 'Crypto', query: 'What does Sacks think about crypto regulation right now?', speaker: 'sacks' },
  { id: 'q05', category: 'Forecast', query: 'Will Bitcoin hit 200k by end of 2026?', mode: 'forecast' },
  { id: 'q06', category: 'Science', query: 'What does Friedberg think about nuclear energy?', speaker: 'friedberg' },
  { id: 'q07', category: 'Tariffs', query: 'Are tariffs good or bad for the US economy?' },
  { id: 'q08', category: 'Tech', query: 'Is OpenAI overvalued at current levels?' },
  { id: 'q09', category: 'Chamath', query: "What is Chamath's current macro view?", speaker: 'chamath' },
  { id: 'q10', category: 'AI', query: 'Will AI replace software engineers in five years?', mode: 'forecast' },
  { id: 'q11', category: 'Politics', query: 'What do the besties think about DOGE and government efficiency?' },
  { id: 'q12', category: 'Markets', query: 'Is there an AI bubble forming?' },
  { id: 'q13', category: 'Guest', query: 'What does Brad Gerstner think about AI infrastructure spending?', speaker: 'gerstner' },
  { id: 'q14', category: 'Geopolitics', query: 'How should the US handle China on trade and tech?' },
  { id: 'q15', category: 'Startups', query: "What is Jason's advice to early-stage founders right now?", speaker: 'calacanis' },
  { id: 'q16', category: 'Energy', query: 'What is the future of nuclear power in America?' },
  { id: 'q17', category: 'Forecast', query: 'Will there be a recession in 2026?', mode: 'forecast' },
  { id: 'q18', category: 'Immigration', query: 'What do the besties think about H-1B visas?' },
  { id: 'q19', category: 'Health', query: 'What does Friedberg think about GLP-1 drugs and longevity?', speaker: 'friedberg' },
  { id: 'q20', category: 'Media', query: "What is Sacks's view on media bias and censorship?", speaker: 'sacks' },
];

async function runQuery(q) {
  const body = { query: q.query };
  if (q.speaker) body.speaker = q.speaker;
  if (q.mode) body.mode = q.mode;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    return { ok: false, error: `HTTP ${res.status}` };
  }

  const data = await res.json();
  return { ok: true, data };
}

async function gradeResponse(q, response) {
  // Show the grader ALL retrieved citations (up to 15), not just top 5
  const allCitations = response.citations || [];
  const citationBlock = allCitations
    .slice(0, 15)
    .map((c, i) => `[${i + 1}] speakers=${(c.speakers || []).join('/') || '?'} topics=${(c.topics || []).join('/') || '?'}\n    "${c.quote?.slice(0, 300) || ''}"`)
    .join('\n');

  const prompt = `You are grading an AI that synthesizes All-In Podcast hosts' views using retrieved transcript segments. Be rigorous but FAIR — you must verify claims against the actual citations before calling something fabricated.

═══ REAL-WORLD CONTEXT YOU MUST KNOW ═══
(These are REAL facts, not hallucinations if the system mentions them)

• David Sacks became the White House AI & Crypto Czar in January 2025 under Trump. He divested from crypto funds when taking the role. He is genuinely part of the administration now.
• Chamath Palihapitiya runs Social Capital, has been bullish on Anthropic at "trillion-five market cap" valuations in past discussions.
• David Friedberg runs The Production Board, does "Science Corner" segments, known as "Sultan of Science" or "Freeberg".
• Jason Calacanis hosts the show, runs LAUNCH, is an angel investor.
• Brad Gerstner (Altimeter) is a frequent guest bestie and has appeared multiple times recently.
• The podcast has discussed: Anthropic's DOD contract cancellation, Anthropic's $570k engineer hiring, OpenAI's $20B run rate, Bitcoin crossing $100k, Gary Gensler's crypto enforcement approach, DOGE efficiency initiatives, Iran war, Jensen Huang on trillion-dollar capex, and many similar recent topics.
• Sacks genuinely has said he "admires Anthropic's products" and "gave them credit for MCP last year".

If the system references ANY of the above, it is NOT fabricating — it's grounded in real recent podcast content.

═══ THE USER'S QUESTION ═══
"${q.query}"
${q.speaker ? `(Focused on: ${q.speaker})` : '(All besties)'}
${q.mode ? `(Mode: ${q.mode})` : ''}

═══ THE SYSTEM'S RESPONSE ═══
${response.report || 'NO REPORT RETURNED'}

═══ ALL RETRIEVED CITATIONS (${allCitations.length} total) ═══
${citationBlock || '(no citations)'}

═══ METADATA ═══
Search mode: ${response.searchMode || '?'}
Segments retrieved: ${response.segmentsFound || 0}

═══ YOUR GRADING TASK ═══

Step 1: CLAIM VERIFICATION. For each substantive claim in the response that has a [N] marker, check whether citation [N] supports it (even loosely — paraphrase in voice counts as valid grounding). Host-style setup sentences from Jason that introduce the topic don't need citations — they're framing, not factual claims.

Step 2: GRADE on five dimensions (1-100 each):

1. **Voice Accuracy** — Does it sound like the actual besties in dialogue format (not analysis)? Chamath: blunt + numbers + "Look, the reality is". Sacks: measured + systems + framework-first. Friedberg: "let me step back" + first principles. Jason: host energy + questions. Short conversational turns, not essay paragraphs.

2. **Content Grounding** — Do substantive claims have matching citations in the 15 above? Paraphrase in voice is fine; only mark down if specific numbers/quotes appear that CANNOT be traced to ANY of the 15 citations or to the real-world context above.

3. **Citation Accuracy** — Are [N] markers matched to claims that the actual cited segment supports?

4. **Recency & Authority** — Does the response feel "current" (e.g. Sacks speaks as Czar, not as outsider)? Uses present tense?

5. **Usefulness** — Would a real reader walk away feeling informed about what the besties actually think?

Be strict but FAIR. 98+ means "publishable as a real All-In roundup with proper voice and grounded claims". 85-97 means "solid but has small issues". <85 means "broken — either bad voice OR real fabrication (not just style drift)".

Respond in EXACT JSON format:
{
  "voice": <1-100>,
  "grounding": <1-100>,
  "citations": <1-100>,
  "recency": <1-100>,
  "usefulness": <1-100>,
  "overall": <weighted average — voice and grounding weighted 2x>,
  "verified_claims": <count of claims you verified against citations>,
  "unverified_claims": <count of specific numeric/factual claims you couldn't trace to citations or context>,
  "strengths": ["..."],
  "weaknesses": ["..."],
  "key_issue": "<most important thing to fix, or 'none' if great>"
}`;

  const r = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1536,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = r.content[0].type === 'text' ? r.content[0].text : '';
  // Extract JSON from response
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return { overall: 0, error: 'no json', raw: text };
  }

  try {
    return JSON.parse(match[0]);
  } catch {
    return { overall: 0, error: 'parse failed', raw: text };
  }
}

async function main() {
  const pilot = process.argv.includes('--pilot');
  const questions = pilot ? TEST_QUESTIONS.slice(0, 5) : TEST_QUESTIONS;

  const startTime = Date.now();
  console.log(`\n═══ All-In Expert QA Run (${questions.length} questions${pilot ? ', PILOT' : ''}) ═══`);
  console.log(`API: ${API_URL}\n`);

  const results = [];

  for (const q of questions) {
    process.stdout.write(`[${q.id}] ${q.category.padEnd(12)} ${q.query.slice(0, 60).padEnd(62)}`);

    const resp = await runQuery(q);
    if (!resp.ok) {
      console.log(`  ✗ ${resp.error}`);
      results.push({ ...q, error: resp.error, overall: 0 });
      continue;
    }

    const grade = await gradeResponse(q, resp.data);
    results.push({ ...q, grade, response: resp.data });
    const mark = grade.overall >= 98 ? '★' : grade.overall >= 85 ? '✓' : '✗';
    console.log(`  ${mark} ${grade.overall || '?'}/100`);
    if (grade.key_issue && grade.key_issue !== 'none') {
      console.log(`     issue: ${grade.key_issue.slice(0, 100)}`);
    }
  }

  // Scorecard
  const validScores = results.filter(r => r.grade?.overall).map(r => r.grade.overall);
  const avg = validScores.reduce((a, b) => a + b, 0) / (validScores.length || 1);
  const min = Math.min(...validScores);
  const max = Math.max(...validScores);
  const below85 = results.filter(r => (r.grade?.overall || 0) < 85);
  const at98plus = results.filter(r => (r.grade?.overall || 0) >= 98);

  console.log('\n═══ Scorecard ═══');
  console.log(`Average:    ${avg.toFixed(1)}/100`);
  console.log(`Min/Max:    ${min} / ${max}`);
  console.log(`At ≥98:     ${at98plus.length}/${results.length}`);
  console.log(`Below 85:   ${below85.length}/${results.length}`);
  console.log(`Duration:   ${((Date.now() - startTime) / 1000).toFixed(0)}s`);

  if (below85.length > 0) {
    console.log('\n═══ Weak Responses (< 85) ═══');
    for (const r of below85) {
      console.log(`\n[${r.id}] ${r.query}`);
      console.log(`  Score: ${r.grade.overall}`);
      console.log(`  Issue: ${r.grade.key_issue}`);
      if (r.grade.weaknesses) {
        console.log(`  Weaknesses: ${r.grade.weaknesses.slice(0, 3).join('; ')}`);
      }
    }
  }

  // Save full results
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
  const outPath = join(OUT_DIR, `qa-run-${timestamp}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\nFull results: ${outPath}`);
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

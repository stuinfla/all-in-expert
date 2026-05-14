#!/usr/bin/env node
// 12-question subset run for post-implementation QA gate
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
config({ path: join(ROOT, '.env') });

const API_URL = 'https://asktheallinexperts.vercel.app/api/ask';
const OUT_DIR = join(ROOT, 'data', 'qa');
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Sampled 12 of 20 for breadth/coverage
const TEST_QUESTIONS = [
  { id: 'q01', category: 'Markets', query: 'Whether Anthropic is doing a good job these days' },
  { id: 'q02', category: 'Macro', query: 'What do the besties think about the US national debt crisis?' },
  { id: 'q04', category: 'Crypto', query: 'What does Sacks think about crypto regulation right now?', speaker: 'sacks' },
  { id: 'q05', category: 'Forecast', query: 'Will Bitcoin hit 200k by end of 2026?', mode: 'forecast' },
  { id: 'q06', category: 'Science', query: 'What does Friedberg think about nuclear energy?', speaker: 'friedberg' },
  { id: 'q08', category: 'Tech', query: 'Is OpenAI overvalued at current levels?' },
  { id: 'q09', category: 'Chamath', query: "What is Chamath's current macro view?", speaker: 'chamath' },
  { id: 'q11', category: 'Politics', query: 'What do the besties think about DOGE and government efficiency?' },
  { id: 'q12', category: 'Markets', query: 'Is there an AI bubble forming?' },
  { id: 'q15', category: 'Startups', query: "What is Jason's advice to early-stage founders right now?", speaker: 'calacanis' },
  { id: 'q18', category: 'Immigration', query: 'What do the besties think about H-1B visas?' },
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
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const data = await res.json();
  return { ok: true, data };
}

async function gradeResponse(q, response) {
  const allCitations = response.citations || [];
  const citationBlock = allCitations.slice(0, 12)
    .map((c, i) => `[${i + 1}] sp=${(c.speakers||[]).join('/')||'?'} "${(c.quote||'').slice(0,220)}"`)
    .join('\n');
  const prompt = `Grade an All-In Podcast synthesis AI on 5 dims (1-100): voice, grounding, citations, recency, usefulness.

Q: "${q.query}" ${q.speaker?`[focus:${q.speaker}]`:''} ${q.mode?`[mode:${q.mode}]`:''}

RESPONSE:
${(response.report||'NONE').slice(0,3500)}

CITATIONS (${allCitations.length}, showing 12):
${citationBlock||'NONE'}

META: searchMode=${response.searchMode} segs=${response.segmentsFound}

CONTEXT: Sacks=WH AI/Crypto Czar (Jan2025+). Chamath=Social Capital. Friedberg=Production Board. Jason=host. Brad Gerstner=Altimeter guest.

Respond JSON only:
{"voice":N,"grounding":N,"citations":N,"recency":N,"usefulness":N,"overall":N,"searchMode":"${response.searchMode}","citation_count":${allCitations.length},"key_issue":"...","strengths":["..."],"weaknesses":["..."]}`;

  const r = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = r.content[0].type === 'text' ? r.content[0].text : '';
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return { overall: 0, error: 'no json', raw: text.slice(0,200) };
  try { return JSON.parse(match[0]); } catch { return { overall: 0, error: 'parse failed' }; }
}

async function main() {
  const t0 = Date.now();
  console.log(`Running ${TEST_QUESTIONS.length} questions vs ${API_URL}\n`);
  const results = [];
  for (const q of TEST_QUESTIONS) {
    process.stdout.write(`[${q.id}] ${q.category.padEnd(11)} ${q.query.slice(0,55).padEnd(57)}`);
    try {
      const resp = await runQuery(q);
      if (!resp.ok) {
        console.log(` X ${resp.error}`);
        results.push({ ...q, error: resp.error, overall: 0 });
        continue;
      }
      const grade = await gradeResponse(q, resp.data);
      results.push({ ...q, grade, searchMode: resp.data.searchMode, segmentsFound: resp.data.segmentsFound, citationCount: (resp.data.citations||[]).length, reportLen: (resp.data.report||'').length });
      const m = grade.overall >= 90 ? '*' : grade.overall >= 75 ? 'o' : 'x';
      console.log(` ${m} ${grade.overall||'?'}/100 sm=${resp.data.searchMode} cites=${(resp.data.citations||[]).length}`);
      if (grade.key_issue && grade.key_issue !== 'none') console.log(`     issue: ${grade.key_issue.slice(0,90)}`);
    } catch (e) {
      console.log(` X ${e.message}`);
      results.push({ ...q, error: e.message, overall: 0 });
    }
  }
  const valid = results.filter(r => r.grade?.overall).map(r => r.grade);
  const avgOverall = valid.reduce((a,b)=>a+b.overall,0)/valid.length;
  const avgVoice = valid.reduce((a,b)=>a+b.voice,0)/valid.length;
  const avgGround = valid.reduce((a,b)=>a+b.grounding,0)/valid.length;
  const avgCite = valid.reduce((a,b)=>a+b.citations,0)/valid.length;
  const avgRec = valid.reduce((a,b)=>a+b.recency,0)/valid.length;
  const avgUse = valid.reduce((a,b)=>a+b.usefulness,0)/valid.length;
  console.log(`\n=== Aggregate ===`);
  console.log(`Overall: ${avgOverall.toFixed(1)}`);
  console.log(`Voice:   ${avgVoice.toFixed(1)}`);
  console.log(`Ground:  ${avgGround.toFixed(1)}`);
  console.log(`Cite:    ${avgCite.toFixed(1)}`);
  console.log(`Recency: ${avgRec.toFixed(1)}`);
  console.log(`Useful:  ${avgUse.toFixed(1)}`);
  const searchModes = {};
  for (const r of results) if (r.searchMode) searchModes[r.searchMode]=(searchModes[r.searchMode]||0)+1;
  console.log(`searchModes:`, searchModes);
  console.log(`Duration: ${((Date.now()-t0)/1000).toFixed(0)}s`);
  const outPath = join(OUT_DIR, `qa-subset-${new Date().toISOString().split('T')[0]}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Saved: ${outPath}`);
}
main().catch(e=>{console.error('Fatal:',e.message);process.exit(1)});

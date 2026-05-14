import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import { readFileSync } from 'fs';
config({ path: '/Users/stuartkerr/Code/All In Expert/.env' });
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const API = 'https://asktheallinexperts.vercel.app/api/ask';

const QS = [
  { id: 'q15', category: 'Startups', query: "What is Jason's advice to early-stage founders right now?", speaker: 'calacanis' },
  { id: 'q16', category: 'Energy', query: 'What is the future of nuclear power in America?' },
  { id: 'q17', category: 'Forecast', query: 'Will there be a recession in 2026?', mode: 'forecast' },
  { id: 'q18', category: 'Immigration', query: 'What do the besties think about H-1B visas?' },
  { id: 'q19', category: 'Health', query: 'What does Friedberg think about GLP-1 drugs and longevity?', speaker: 'friedberg' },
  { id: 'q20', category: 'Media', query: "What is Sacks's view on media bias and censorship?", speaker: 'sacks' },
];

async function run(q) {
  const body = { query: q.query };
  if (q.speaker) body.speaker = q.speaker;
  if (q.mode) body.mode = q.mode;
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

async function grade(q, response) {
  const allCitations = response.citations || [];
  const citationBlock = allCitations.slice(0, 15).map((c, i) =>
    `[${i+1}] speakers=${(c.speakers||[]).join('/')||'?'} key=${c.speakerKey||'?'} topics=${(c.topics||[]).join('/')||'?'}\n    "${(c.quote||'').slice(0,300)}"`).join('\n');
  const prompt = `Grade an All-In Podcast bestie-synth on:
1 voice 2 grounding 3 citations 4 recency 5 usefulness (1-100 each).

QUESTION: "${q.query}" ${q.speaker?`(focus:${q.speaker})`:''} ${q.mode?`(mode:${q.mode})`:''}

RESPONSE:
${response.report || 'NONE'}

CITATIONS (${allCitations.length}):
${citationBlock}

Real context: Sacks=AI/Crypto Czar (Jan2025), Chamath=Anthropic bull, Friedberg=Science Corner, Gerstner=Altimeter, Anthropic-DOD-cancel/OpenAI-$20B/BTC-$100k all real.

JSON only:
{"voice":N,"grounding":N,"citations":N,"recency":N,"usefulness":N,"overall":N,"verified_claims":N,"unverified_claims":N,"key_issue":"..."}`;
  const r = await client.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 600, messages: [{ role: 'user', content: prompt }] });
  const text = r.content[0].text;
  const m = text.match(/\{[\s\S]*\}/);
  try { return JSON.parse(m[0]); } catch { return { overall: 0, error: 'parse' }; }
}

for (const q of QS) {
  process.stdout.write(`[${q.id}] ${q.category.padEnd(12)} ${q.query.slice(0,55).padEnd(57)}`);
  try {
    const resp = await run(q);
    const g = await grade(q, resp);
    console.log(`  ${g.overall||'?'}/100  v=${g.voice} g=${g.grounding} c=${g.citations} r=${g.recency} u=${g.usefulness}`);
    if (g.key_issue && g.key_issue !== 'none') console.log(`     issue: ${g.key_issue.slice(0,110)}`);
  } catch (e) {
    console.log(`  ERR ${e.message}`);
  }
}

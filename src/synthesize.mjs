#!/usr/bin/env node
/**
 * All-In Expert LLM Synthesizer
 *
 * Uses Claude to analyze raw transcript segments and generate
 * intelligent "what would each bestie think" reports with:
 * - Speaker identification from context
 * - Perspective synthesis per bestie
 * - Collective consensus with confidence levels
 * - Market/AI/politics forecasting based on historical positions
 *
 * Usage:
 *   node src/synthesize.mjs "Should the US regulate AI?"
 *   node src/synthesize.mjs --speaker sacks "What about tariffs?"
 *   node src/synthesize.mjs --forecast "Will there be a recession in 2026?"
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
config({ path: join(ROOT, '.env') });

const KB_DIR = join(ROOT, 'data', 'kb');
const PROFILES_DIR = join(ROOT, 'data', 'profiles');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SPEAKER_CONTEXT = {
  chamath: {
    name: 'Chamath Palihapitiya',
    short: 'Chamath',
    lens: 'Venture capitalist (Social Capital). Analyzes via capital allocation, market efficiency, systemic risk. Contrarian macro views. Data-driven.',
    style: 'Bold, contrarian, numbers-heavy. Will take unpopular positions backed by data.'
  },
  sacks: {
    name: 'David Sacks',
    short: 'Sacks',
    lens: 'Enterprise SaaS investor (Craft Ventures), former PayPal COO. From Jan 2025: White House AI & Crypto Czar. Foreign policy hawk, pro-business, skeptical of media narratives.',
    style: 'Analytical, measured, builds logical arguments. Frames issues as systems problems.'
  },
  friedberg: {
    name: 'David Friedberg',
    short: 'Friedberg',
    lens: 'CEO of The Production Board. Deep science background (former Google). "Sultan of Science." First-principles thinker on climate, biotech, food, energy.',
    style: 'Methodical, science-first. Reframes political debates as scientific/economic questions.'
  },
  calacanis: {
    name: 'Jason Calacanis',
    short: 'Jason',
    lens: 'Angel investor, LAUNCH CEO, podcast host/moderator. Startup ecosystem insider and media operator.',
    style: 'Provocative, asks uncomfortable questions, plays devil\'s advocate. Steers toward actionable takeaways.'
  }
};

function loadEntries() {
  const files = readdirSync(KB_DIR)
    .filter(f => f.startsWith('entries_') && f.endsWith('.json'))
    .sort();
  let entries = [];
  for (const file of files) {
    entries = entries.concat(JSON.parse(readFileSync(join(KB_DIR, file), 'utf8')));
  }
  return entries;
}

function loadProfiles() {
  const profiles = {};
  for (const key of Object.keys(SPEAKER_CONTEXT)) {
    const file = join(PROFILES_DIR, `${key}.json`);
    if (existsSync(file)) profiles[key] = JSON.parse(readFileSync(file, 'utf8'));
  }
  return profiles;
}

function hashProject(word, dimensions = 512) {
  let hash = 0;
  for (let i = 0; i < word.length; i++) {
    hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % dimensions;
}

function textToVector(text, dimensions = 512) {
  const vec = new Float32Array(dimensions);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const wordCounts = {};
  for (const word of words) wordCounts[word] = (wordCounts[word] || 0) + 1;
  for (const [word, count] of Object.entries(wordCounts)) {
    vec[hashProject(word, dimensions)] += count / words.length;
  }
  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < dimensions; i++) vec[i] /= norm;
  return vec;
}

async function searchRvf(entries, query, limit = 30) {
  try {
    const { RvfDatabase } = await import('@ruvector/rvf');
    const dbPath = join(KB_DIR, 'all-in-expert.rvf');
    if (existsSync(dbPath)) {
      const db = await RvfDatabase.openReadonly(dbPath);
      const queryVec = textToVector(query);
      const rvfResults = await db.query(queryVec, limit, { efSearch: 200 });
      const entryMap = new Map(entries.map(e => [e.id, e]));
      return rvfResults
        .map(r => entryMap.get(r.id))
        .filter(Boolean);
    }
  } catch { /* fall through */ }

  // Keyword fallback
  const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);
  return entries
    .map(e => {
      const content = e.content.toLowerCase();
      const score = queryWords.filter(w => content.includes(w)).length;
      return { ...e, score };
    })
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function synthesize(query, segments, options = {}) {
  const segmentText = segments
    .slice(0, 15) // Top 15 most relevant segments
    .map((s, i) => {
      const url = s.metadata?.youtubeUrl || '';
      const topics = (s.metadata?.topics || []).join(', ');
      return `--- Segment ${i + 1} [${s.metadata?.startTime || '??'}] (Topics: ${topics}) ---\n${s.content.slice(0, 600)}\n${url}`;
    })
    .join('\n\n');

  const speakerProfiles = Object.entries(SPEAKER_CONTEXT)
    .map(([key, s]) => `**${s.name} (${s.short})**: ${s.lens}\nStyle: ${s.style}`)
    .join('\n\n');

  const focusSpeaker = options.speaker
    ? SPEAKER_CONTEXT[options.speaker]
    : null;

  const isForecast = options.forecast;

  const systemPrompt = `You are the All-In Expert — an intelligence system trained on 300+ episodes of the All-In Podcast (Chamath Palihapitiya, David Sacks, David Friedberg, Jason Calacanis).

Your job is to analyze transcript segments and synthesize what each "bestie" would think about a given question, based on their established positions, expertise areas, and debate patterns.

THE FOUR BESTIES:
${speakerProfiles}

RULES:
1. Base your analysis on the ACTUAL transcript segments provided — cite specific moments when possible
2. When you can identify who is speaking in a segment (from context clues, names, topic expertise), attribute it
3. Distinguish between what they HAVE said (evidence-based) and what they WOULD LIKELY say (inference)
4. Be specific about their reasoning style, not generic
5. Include YouTube links to the most relevant segments
6. Rate confidence: HIGH (direct quotes exist), MEDIUM (strong inference from patterns), LOW (extrapolation)`;

  let userPrompt;

  if (focusSpeaker) {
    userPrompt = `QUESTION: "${query}"

FOCUS: Analyze specifically what ${focusSpeaker.name} would think about this.

Here are the most relevant transcript segments from the All-In Podcast:

${segmentText}

Provide:
1. **${focusSpeaker.short}'s Position**: What they would say, based on their established views
2. **Key Evidence**: Specific transcript segments that support this
3. **Their Reasoning**: How they would frame the argument (using their known analytical lens)
4. **Confidence Level**: How certain are we about this position
5. **Relevant Episodes**: YouTube links to the most relevant discussions`;
  } else if (isForecast) {
    userPrompt = `FORECASTING QUESTION: "${query}"

Analyze what each bestie would predict, based on their track record and analytical frameworks.

Here are the most relevant transcript segments from the All-In Podcast:

${segmentText}

Provide a FORECAST REPORT:
1. **Chamath's Forecast**: His prediction and reasoning (macro/capital allocation lens)
2. **Sacks' Forecast**: His prediction and reasoning (enterprise/political lens)
3. **Friedberg's Forecast**: His prediction and reasoning (science/first-principles lens)
4. **Jason's Forecast**: His prediction and reasoning (startup/media lens)
5. **Consensus Forecast**: Where they agree and disagree
6. **Confidence Assessment**: How reliable is this forecast based on their track record
7. **Key Evidence**: Most relevant transcript segments with YouTube links`;
  } else {
    userPrompt = `QUESTION: "${query}"

Here are the most relevant transcript segments from the All-In Podcast:

${segmentText}

Provide a BESTIE INTELLIGENCE REPORT:
1. **Chamath's Take**: What he would say and why (with evidence from segments)
2. **Sacks' Take**: What he would say and why (with evidence from segments)
3. **Friedberg's Take**: What he would say and why (with evidence from segments)
4. **Jason's Take**: What he would say and why (with evidence from segments)
5. **Consensus View**: Where they align and where they diverge
6. **Confidence Level**: HIGH/MEDIUM/LOW for each bestie's position
7. **Key Sources**: Most relevant YouTube links`;
  }

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  return response.content[0].text;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
All-In Expert — LLM-Powered Intelligence Synthesizer

Usage:
  node src/synthesize.mjs "Your question"                     Full bestie report
  node src/synthesize.mjs --speaker chamath "Your question"   Focus on one bestie
  node src/synthesize.mjs --forecast "Your prediction query"  Forecasting mode

Examples:
  node src/synthesize.mjs "Should the US regulate AI companies?"
  node src/synthesize.mjs --forecast "Will Bitcoin hit 200K in 2026?"
  node src/synthesize.mjs --speaker sacks "What about tariffs on China?"
  node src/synthesize.mjs --speaker friedberg "What's the future of nuclear energy?"

Speakers: chamath, sacks, friedberg, calacanis
`);
    return;
  }

  // Parse flags
  let speaker = null;
  let forecast = false;
  let query = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--speaker' && args[i + 1]) { speaker = args[++i]; }
    else if (args[i] === '--forecast') { forecast = true; }
    else { query += (query ? ' ' : '') + args[i]; }
  }

  if (!query) {
    console.error('Please provide a query.');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set in .env');
    process.exit(1);
  }

  console.log(`\nSearching knowledge base for: "${query}"\n`);

  const entries = loadEntries();
  if (entries.length === 0) {
    console.error('Knowledge base is empty. Run: bash scripts/refresh-kb.sh');
    process.exit(1);
  }

  const segments = await searchRvf(entries, query, 30);
  console.log(`Found ${segments.length} relevant segments across the All-In Podcast\n`);

  if (segments.length === 0) {
    console.log('No relevant segments found. Try a different query.');
    return;
  }

  console.log('Synthesizing bestie intelligence report...\n');
  console.log('━'.repeat(60));

  const report = await synthesize(query, segments, { speaker, forecast });
  console.log(report);

  console.log('\n' + '━'.repeat(60));
  console.log(`\nPowered by ${entries.length} knowledge entries from 300+ All-In episodes`);
}

main().catch(err => {
  if (err.message?.includes('api_key')) {
    console.error('API key error. Check ANTHROPIC_API_KEY in .env');
  } else {
    console.error('Error:', err.message);
  }
});

#!/usr/bin/env node
/**
 * All-In Expert Query Interface
 *
 * Ask questions like:
 *   node src/query.mjs "What would the besties think about tariffs on China?"
 *   node src/query.mjs --speaker chamath "How should I invest in AI?"
 *   node src/query.mjs --topic markets "Is a recession coming?"
 *   node src/query.mjs --consensus "Should the US regulate AI?"
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const KB_DIR = join(ROOT, 'data', 'kb');
const PROFILES_DIR = join(ROOT, 'data', 'profiles');
const TRANSCRIPTS_DIR = join(ROOT, 'data', 'transcripts');

/**
 * Load all knowledge entries from JSON batches.
 */
function loadEntries() {
  const files = readdirSync(KB_DIR)
    .filter(f => f.startsWith('entries_') && f.endsWith('.json'))
    .sort();

  let entries = [];
  for (const file of files) {
    const batch = JSON.parse(readFileSync(join(KB_DIR, file), 'utf8'));
    entries = entries.concat(batch);
  }
  return entries;
}

/**
 * Load speaker profiles.
 */
function loadProfiles() {
  const profiles = {};
  const speakerKeys = ['chamath', 'sacks', 'friedberg', 'calacanis'];
  for (const key of speakerKeys) {
    const file = join(PROFILES_DIR, `${key}.json`);
    if (existsSync(file)) {
      profiles[key] = JSON.parse(readFileSync(file, 'utf8'));
    }
  }
  return profiles;
}

/**
 * Simple keyword-based search (used as fallback when RVF is not available).
 * Scores entries by keyword overlap with the query.
 */
function keywordSearch(entries, query, options = {}) {
  const queryWords = query.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2);

  // Remove stop words
  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all',
    'can', 'has', 'her', 'was', 'one', 'our', 'out', 'day', 'had', 'has', 'his',
    'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who', 'boy', 'did',
    'get', 'let', 'say', 'she', 'too', 'use', 'what', 'when', 'where', 'which',
    'will', 'with', 'would', 'could', 'should', 'about', 'think', 'they', 'this',
    'that', 'from', 'have', 'been', 'were', 'some', 'them', 'than', 'each', 'make',
    'like', 'just', 'over', 'such', 'take', 'into', 'very', 'much', 'does', 'going']);

  const searchTerms = queryWords.filter(w => !stopWords.has(w));

  const scored = entries.map(entry => {
    const content = entry.content.toLowerCase();
    let score = 0;

    // Keyword match scoring
    for (const term of searchTerms) {
      const regex = new RegExp(`\\b${term}`, 'gi');
      const matches = content.match(regex);
      if (matches) score += matches.length;
    }

    // Boost for topic match
    if (options.topic) {
      if (entry.metadata.topics.includes(options.topic)) score *= 1.5;
    }

    // Boost for speaker mention
    if (options.speaker) {
      if (entry.metadata.speakersMentioned.includes(options.speaker)) score *= 2;
    }

    return { ...entry, score };
  });

  return scored
    .filter(e => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit || 20);
}

/**
 * Hash-project text into a vector (must match build-knowledge-base.mjs).
 */
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

/**
 * Try to use RVF for semantic search, fall back to keywords.
 */
async function search(entries, query, options = {}) {
  try {
    const { RvfDatabase } = await import('@ruvector/rvf');
    const dbPath = join(KB_DIR, 'all-in-expert.rvf');

    if (existsSync(dbPath)) {
      const db = await RvfDatabase.openReadonly(dbPath);
      const queryVec = textToVector(query);
      const rvfResults = await db.query(queryVec, options.limit || 20, {
        efSearch: 200
      });

      // Enrich RVF results with full text from JSON entries
      const entryMap = new Map(entries.map(e => [e.id, e]));
      const enriched = rvfResults
        .map(r => {
          const entry = entryMap.get(r.id);
          if (!entry) return null;
          return { ...entry, score: 1 / (1 + r.distance) }; // Convert distance to similarity
        })
        .filter(Boolean);

      // Apply speaker/topic filters on enriched results
      let filtered = enriched;
      if (options.speaker) {
        filtered = filtered.filter(e => e.metadata.speakersMentioned.includes(options.speaker));
      }
      if (options.topic) {
        filtered = filtered.filter(e => e.metadata.topics.includes(options.topic));
      }

      if (filtered.length > 0) return filtered;
      // Fall through to keyword if RVF returned nothing useful after filtering
    }
  } catch {
    // Fall back to keyword search
  }

  return keywordSearch(entries, query, options);
}

/**
 * Format a bestie's perspective based on relevant quotes and their profile.
 */
function formatBestiePerspective(speaker, profile, relevantChunks) {
  const chunks = relevantChunks.filter(c =>
    c.metadata.speakersMentioned.includes(speaker) || c.score > 3
  ).slice(0, 5);

  if (chunks.length === 0) {
    return {
      speaker: profile.name,
      role: profile.role,
      perspective: `No direct mentions found in knowledge base for this query.`,
      confidence: 'low',
      lens: profile.lensDescription,
      relevantQuotes: []
    };
  }

  return {
    speaker: profile.name,
    role: profile.role,
    lens: profile.lensDescription,
    debateStyle: profile.debateStyle,
    confidence: chunks.length >= 3 ? 'high' : chunks.length >= 1 ? 'medium' : 'low',
    topTopics: profile.topTopics?.slice(0, 5),
    relevantSegments: chunks.map(c => ({
      text: c.content.slice(0, 500),
      time: c.metadata.startTime,
      videoId: c.metadata.videoId,
      url: c.metadata.youtubeUrl,
      topics: c.metadata.topics
    }))
  };
}

/**
 * Build a collective consensus from all besties' perspectives.
 */
function buildConsensus(perspectives) {
  const allTopics = new Set();
  let totalConfidence = 0;
  const confidenceMap = { high: 3, medium: 2, low: 1 };

  for (const p of perspectives) {
    totalConfidence += confidenceMap[p.confidence] || 0;
    if (p.relevantSegments) {
      for (const seg of p.relevantSegments) {
        seg.topics.forEach(t => allTopics.add(t));
      }
    }
  }

  return {
    averageConfidence: totalConfidence / perspectives.length > 2 ? 'high' : totalConfidence / perspectives.length > 1 ? 'medium' : 'low',
    commonTopics: [...allTopics],
    bestiePerspectives: perspectives,
    note: 'This analysis is based on keyword matching and topic detection from YouTube auto-captions. For higher accuracy, run the speaker diarization pipeline (AssemblyAI or WhisperX) to get direct speaker attribution.'
  };
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help')) {
    console.log(`
All-In Expert Query Interface

Usage:
  node src/query.mjs "Your question"                    Search all episodes
  node src/query.mjs --speaker chamath "Your question"  Focus on one bestie
  node src/query.mjs --topic AI "Your question"         Filter by topic
  node src/query.mjs --consensus "Your question"        Get collective view
  node src/query.mjs --profile chamath                  Show bestie profile

Speakers: chamath, sacks, friedberg, calacanis
Topics: AI, markets, crypto, politics, foreign_policy, startups, enterprise, science, energy, media
`);
    return;
  }

  // Parse flags
  let speaker = null;
  let topic = null;
  let consensus = false;
  let profileOnly = false;
  let query = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--speaker' && args[i + 1]) { speaker = args[++i]; }
    else if (args[i] === '--topic' && args[i + 1]) { topic = args[++i]; }
    else if (args[i] === '--consensus') { consensus = true; }
    else if (args[i] === '--profile' && args[i + 1]) { profileOnly = true; speaker = args[++i]; }
    else { query += (query ? ' ' : '') + args[i]; }
  }

  const profiles = loadProfiles();

  // Profile view
  if (profileOnly && speaker && profiles[speaker]) {
    const p = profiles[speaker];
    console.log(`\n=== ${p.name} ===`);
    console.log(`Role: ${p.role}`);
    console.log(`Lens: ${p.lensDescription}`);
    console.log(`Debate Style: ${p.debateStyle}`);
    console.log(`\nExpertise: ${p.expertise.join(', ')}`);
    console.log(`Biases: ${p.biases.join(', ')}`);
    console.log(`\nMentions: ${p.totalMentions} across ${p.episodeAppearances} episodes`);
    if (p.topTopics) {
      console.log(`\nTop Topics:`);
      for (const t of p.topTopics) {
        console.log(`  ${t.topic}: ${t.count} mentions`);
      }
    }
    return;
  }

  if (!query) {
    console.error('Please provide a query.');
    process.exit(1);
  }

  console.log(`\nSearching for: "${query}"\n`);

  // Load data
  const entries = loadEntries();
  if (entries.length === 0) {
    console.error('Knowledge base is empty. Run the build pipeline first:');
    console.error('  npm run download:captions && npm run process:captions && npm run build:kb');
    process.exit(1);
  }

  // Search
  const results = await search(entries, query, { speaker, topic, limit: 20 });

  if (consensus || (!speaker && !topic)) {
    // Show all besties' perspectives
    console.log('=== BESTIE INTELLIGENCE REPORT ===\n');

    const perspectives = [];
    for (const [key, profile] of Object.entries(profiles)) {
      const speakerResults = await search(entries, query, { speaker: key, limit: 10 });
      perspectives.push(formatBestiePerspective(key, profile, speakerResults));
    }

    const report = buildConsensus(perspectives);

    for (const p of report.bestiePerspectives) {
      console.log(`--- ${p.speaker} (${p.role}) ---`);
      console.log(`Confidence: ${p.confidence}`);
      console.log(`Lens: ${p.lens}`);
      if (p.relevantSegments && p.relevantSegments.length > 0) {
        console.log(`\nRelevant segments:`);
        for (const seg of p.relevantSegments.slice(0, 3)) {
          console.log(`  [${seg.time}] ${seg.text.slice(0, 200)}...`);
          console.log(`  ${seg.url}`);
          console.log();
        }
      }
      console.log();
    }

    console.log(`=== CONSENSUS ===`);
    console.log(`Overall confidence: ${report.averageConfidence}`);
    console.log(`Topics covered: ${report.commonTopics.join(', ')}`);
    console.log(`\nNote: ${report.note}`);
  } else {
    // Show filtered results
    console.log(`Results (${results.length} found):\n`);
    for (const result of results.slice(0, 10)) {
      console.log(`[Score: ${result.score?.toFixed(1) || 'N/A'}] [${result.metadata.startTime}]`);
      console.log(`Topics: ${result.metadata.topics.join(', ')}`);
      console.log(`Speakers: ${result.metadata.speakersMentioned.join(', ') || 'unknown'}`);
      console.log(`${result.content.slice(0, 200)}...`);
      console.log(`${result.metadata.youtubeUrl}`);
      console.log();
    }
  }
}

main().catch(console.error);

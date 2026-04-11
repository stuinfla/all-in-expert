#!/usr/bin/env node
/**
 * Process raw YouTube JSON3 captions into structured transcripts.
 *
 * Input: data/captions/*.en.json3
 * Output: data/transcripts/*.json
 *
 * Each transcript is segmented into chunks with:
 * - Text content
 * - Start/end timestamps
 * - Speaker attribution (when determinable from context)
 * - Topic indicators
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CAPTIONS_DIR = join(ROOT, 'data', 'captions');
const TRANSCRIPTS_DIR = join(ROOT, 'data', 'transcripts');
const EPISODES_FILE = join(ROOT, 'data', 'episodes', 'episodes_metadata.json');

if (!existsSync(TRANSCRIPTS_DIR)) mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

// Known speakers and their name variants in transcripts
const SPEAKERS = {
  chamath: {
    name: 'Chamath Palihapitiya',
    short: 'Chamath',
    aliases: ['chamath', 'palihapitiya', 'chamath palihapitiya'],
    expertise: ['venture capital', 'public markets', 'macro economics', 'politics', 'social capital', 'SPACs']
  },
  sacks: {
    name: 'David Sacks',
    short: 'Sacks',
    aliases: ['sacks', 'david sacks', 'the rain man'],
    expertise: ['enterprise SaaS', 'politics', 'foreign policy', 'AI', 'crypto', 'government efficiency']
  },
  friedberg: {
    name: 'David Friedberg',
    short: 'Friedberg',
    aliases: ['friedberg', 'david friedberg', 'the sultan of science', 'science corner'],
    expertise: ['science', 'agriculture', 'climate', 'biotech', 'macro economics', 'food technology']
  },
  calacanis: {
    name: 'Jason Calacanis',
    short: 'Jason',
    aliases: ['jason', 'calacanis', 'jason calacanis', 'j-cal', 'jcal'],
    expertise: ['startups', 'media', 'angel investing', 'tech industry', 'podcasting']
  }
};

/**
 * Extract plain text from JSON3 caption events.
 * Returns an array of { text, startMs, endMs } segments.
 */
function extractSegments(json3Data) {
  const events = json3Data.events || [];
  const segments = [];

  for (const event of events) {
    if (!event.segs) continue;

    const text = event.segs
      .map(s => s.utf8 || '')
      .join('')
      .trim();

    if (!text || text === '\n') continue;

    segments.push({
      text,
      startMs: event.tStartMs || 0,
      endMs: (event.tStartMs || 0) + (event.dDurationMs || 0)
    });
  }

  return segments;
}

/**
 * Merge small segments into larger chunks (~30 second windows).
 * This creates more meaningful units for vector search.
 */
function mergeIntoChunks(segments, chunkDurationMs = 30000) {
  const chunks = [];
  let currentChunk = { text: '', startMs: 0, endMs: 0 };

  for (const seg of segments) {
    if (currentChunk.text === '') {
      currentChunk.startMs = seg.startMs;
    }

    currentChunk.text += (currentChunk.text ? ' ' : '') + seg.text;
    currentChunk.endMs = seg.endMs;

    if (seg.endMs - currentChunk.startMs >= chunkDurationMs) {
      chunks.push({ ...currentChunk });
      currentChunk = { text: '', startMs: 0, endMs: 0 };
    }
  }

  // Don't forget the last chunk
  if (currentChunk.text) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Detect speaker mentions in text.
 * Returns array of speaker keys mentioned.
 */
function detectSpeakerMentions(text) {
  const lower = text.toLowerCase();
  const mentioned = [];

  for (const [key, speaker] of Object.entries(SPEAKERS)) {
    for (const alias of speaker.aliases) {
      if (lower.includes(alias)) {
        mentioned.push(key);
        break;
      }
    }
  }

  return [...new Set(mentioned)];
}

/**
 * Detect topics in text using keyword matching.
 */
function detectTopics(text) {
  const lower = text.toLowerCase();
  const topics = [];

  const topicKeywords = {
    'AI': ['artificial intelligence', 'machine learning', 'deep learning', 'neural network', 'gpt', 'openai', 'anthropic', 'claude', 'llm', 'chatgpt', 'ai model', 'ai agent'],
    'markets': ['stock market', 'nasdaq', 's&p', 'dow jones', 'bull market', 'bear market', 'recession', 'inflation', 'interest rate', 'fed rate', 'earnings', 'ipo', 'spac', 'valuation'],
    'crypto': ['bitcoin', 'ethereum', 'crypto', 'blockchain', 'defi', 'stablecoin', 'web3', 'nft', 'token'],
    'politics': ['election', 'president', 'congress', 'senate', 'democrat', 'republican', 'trump', 'biden', 'kamala', 'policy', 'regulation', 'legislation', 'doge'],
    'foreign_policy': ['china', 'russia', 'ukraine', 'iran', 'nato', 'tariff', 'trade war', 'sanctions', 'geopolitics', 'middle east', 'israel', 'gaza'],
    'startups': ['startup', 'venture capital', 'series a', 'fundrais', 'founder', 'unicorn', 'seed round', 'angel invest'],
    'enterprise': ['saas', 'enterprise', 'b2b', 'cloud', 'platform', 'microsoft', 'google', 'salesforce', 'oracle'],
    'science': ['science corner', 'research', 'clinical trial', 'biology', 'physics', 'chemistry', 'genome', 'crispr', 'breakthrough'],
    'energy': ['energy', 'nuclear', 'solar', 'oil', 'natural gas', 'renewable', 'climate', 'carbon'],
    'media': ['media', 'journalism', 'podcast', 'content', 'creator', 'streaming', 'netflix', 'youtube', 'twitter', 'social media']
  };

  for (const [topic, keywords] of Object.entries(topicKeywords)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        topics.push(topic);
        break;
      }
    }
  }

  return [...new Set(topics)];
}

/**
 * Format milliseconds as HH:MM:SS
 */
function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Try to match a YouTube video ID to RSS episode metadata.
 */
function matchToEpisode(videoId, title, episodesMetadata) {
  // Try direct match on any field
  for (const ep of episodesMetadata) {
    // Check if YouTube title contains key phrases from RSS title
    const rssWords = ep.title.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    const ytTitle = (title || '').toLowerCase();
    const matchCount = rssWords.filter(w => ytTitle.includes(w)).length;
    if (matchCount >= 3 && matchCount / rssWords.length > 0.4) {
      return ep;
    }
  }
  return null;
}

function processFile(captionFile) {
  const videoId = basename(captionFile).replace('.en.json3', '');

  const raw = JSON.parse(readFileSync(join(CAPTIONS_DIR, captionFile), 'utf8'));
  const segments = extractSegments(raw);

  if (segments.length === 0) {
    return null;
  }

  // Merge into ~30 second chunks for vector search
  const chunks = mergeIntoChunks(segments, 30000);

  // Also create ~2 minute chunks for longer context
  const longChunks = mergeIntoChunks(segments, 120000);

  // Full text for analysis
  const fullText = segments.map(s => s.text).join(' ');

  // Detect overall topics and speaker mentions
  const topics = detectTopics(fullText);
  const speakersMentioned = detectSpeakerMentions(fullText);

  // Process each chunk
  const processedChunks = chunks.map((chunk, i) => ({
    id: `${videoId}_chunk_${i}`,
    videoId,
    chunkIndex: i,
    text: chunk.text,
    startTime: formatTime(chunk.startMs),
    endTime: formatTime(chunk.endMs),
    startMs: chunk.startMs,
    endMs: chunk.endMs,
    topics: detectTopics(chunk.text),
    speakersMentioned: detectSpeakerMentions(chunk.text),
    wordCount: chunk.text.split(/\s+/).length
  }));

  const processedLongChunks = longChunks.map((chunk, i) => ({
    id: `${videoId}_long_${i}`,
    videoId,
    chunkIndex: i,
    text: chunk.text,
    startTime: formatTime(chunk.startMs),
    endTime: formatTime(chunk.endMs),
    startMs: chunk.startMs,
    endMs: chunk.endMs,
    topics: detectTopics(chunk.text),
    speakersMentioned: detectSpeakerMentions(chunk.text),
    wordCount: chunk.text.split(/\s+/).length
  }));

  const durationMs = segments[segments.length - 1].endMs;

  return {
    videoId,
    durationMs,
    duration: formatTime(durationMs),
    totalWords: fullText.split(/\s+/).length,
    topics,
    speakersMentioned,
    chunks: processedChunks,
    longChunks: processedLongChunks,
    chunkCount: processedChunks.length,
    longChunkCount: processedLongChunks.length
  };
}

function main() {
  const captionFiles = readdirSync(CAPTIONS_DIR)
    .filter(f => f.endsWith('.en.json3'));

  console.log(`Processing ${captionFiles.length} caption files...`);

  // Load episode metadata for enrichment
  let episodesMetadata = [];
  if (existsSync(EPISODES_FILE)) {
    episodesMetadata = JSON.parse(readFileSync(EPISODES_FILE, 'utf8'));
  }

  let processed = 0;
  let totalChunks = 0;
  let totalWords = 0;

  const manifest = [];

  for (const file of captionFiles) {
    try {
      const result = processFile(file);
      if (!result) continue;

      // Save individual transcript
      writeFileSync(
        join(TRANSCRIPTS_DIR, `${result.videoId}.json`),
        JSON.stringify(result, null, 2)
      );

      manifest.push({
        videoId: result.videoId,
        duration: result.duration,
        totalWords: result.totalWords,
        chunkCount: result.chunkCount,
        topics: result.topics
      });

      processed++;
      totalChunks += result.chunkCount;
      totalWords += result.totalWords;

      if (processed % 10 === 0) {
        console.log(`Processed ${processed}/${captionFiles.length} (${totalChunks} chunks, ${totalWords} words)`);
      }
    } catch (err) {
      console.error(`Error processing ${file}: ${err.message}`);
    }
  }

  // Save manifest
  writeFileSync(
    join(TRANSCRIPTS_DIR, '_manifest.json'),
    JSON.stringify({
      processedAt: new Date().toISOString(),
      episodeCount: processed,
      totalChunks,
      totalWords,
      episodes: manifest
    }, null, 2)
  );

  console.log(`\nDone:`);
  console.log(`  Episodes processed: ${processed}`);
  console.log(`  Total chunks: ${totalChunks}`);
  console.log(`  Total words: ${totalWords.toLocaleString()}`);
  console.log(`  Manifest: data/transcripts/_manifest.json`);
}

main();

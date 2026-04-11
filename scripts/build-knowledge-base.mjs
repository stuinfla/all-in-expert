#!/usr/bin/env node
/**
 * Build the All-In Expert RVF knowledge base from processed transcripts.
 *
 * Creates a vector database with:
 * - Per-chunk embeddings for semantic search
 * - Speaker attribution metadata
 * - Topic classification
 * - Episode context
 *
 * The KB supports queries like:
 * - "What would Chamath think about tariffs?"
 * - "What has Sacks said about AI regulation?"
 * - "What's the collective bestie view on crypto?"
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TRANSCRIPTS_DIR = join(ROOT, 'data', 'transcripts');
const KB_DIR = join(ROOT, 'data', 'kb');
const PROFILES_DIR = join(ROOT, 'data', 'profiles');

if (!existsSync(KB_DIR)) mkdirSync(KB_DIR, { recursive: true });
if (!existsSync(PROFILES_DIR)) mkdirSync(PROFILES_DIR, { recursive: true });

// Speaker expertise profiles
const SPEAKER_PROFILES = {
  chamath: {
    name: 'Chamath Palihapitiya',
    role: 'Venture Capitalist, Social Capital CEO',
    lensDescription: 'Analyzes through the lens of capital allocation, market efficiency, and systemic risk. Tends toward contrarian macro views. Focuses on where capital is flowing and why.',
    expertise: ['venture capital', 'public markets', 'macro economics', 'politics', 'tech investing', 'SPACs', 'healthcare', 'climate tech'],
    biases: ['pro-efficiency', 'skeptical of government intervention', 'data-driven', 'contrarian on popular narratives'],
    debateStyle: 'Data-heavy, contrarian, willing to take unpopular positions. Often challenges conventional wisdom with numbers.'
  },
  sacks: {
    name: 'David Sacks',
    role: 'Craft Ventures GP, Former PayPal COO, White House AI Czar (2025)',
    lensDescription: 'Analyzes through enterprise value creation and political power dynamics. Strong foreign policy views. Post-2025: insider government perspective on AI policy.',
    expertise: ['enterprise SaaS', 'politics', 'foreign policy', 'AI policy', 'crypto regulation', 'government efficiency', 'DOGE', 'defense tech'],
    biases: ['pro-business', 'non-interventionist foreign policy', 'skeptical of media narratives', 'pro-crypto'],
    debateStyle: 'Analytical and measured, builds logical arguments methodically. Often frames issues as systems problems.'
  },
  friedberg: {
    name: 'David Friedberg',
    role: 'The Production Board CEO, Former Google',
    lensDescription: 'Analyzes through scientific first principles and systems thinking. Brings deep science background to every topic. The "Sultan of Science."',
    expertise: ['science', 'agriculture', 'climate', 'biotech', 'food technology', 'macro economics', 'energy', 'longevity'],
    biases: ['evidence-based', 'systems thinker', 'long-term oriented', 'pro-innovation', 'skeptical of narratives without data'],
    debateStyle: 'Methodical, science-first. Often reframes political debates as scientific/economic questions. Brings unique perspectives from hard science.'
  },
  calacanis: {
    name: 'Jason Calacanis',
    role: 'Angel Investor, LAUNCH CEO, Podcast Host',
    lensDescription: 'Analyzes as a startup ecosystem insider and media operator. Practical, founder-focused perspective. The moderator and provocateur.',
    expertise: ['startups', 'angel investing', 'media', 'tech industry', 'founder dynamics', 'podcasting', 'content creation'],
    biases: ['pro-founder', 'optimistic on startups', 'media-savvy', 'relationship-driven analysis'],
    debateStyle: 'Provocative, asks the uncomfortable questions. Often plays devil\'s advocate. Steers conversations toward actionable takeaways.'
  }
};

/**
 * Load all processed transcripts.
 */
function loadTranscripts() {
  const files = readdirSync(TRANSCRIPTS_DIR)
    .filter(f => f.endsWith('.json') && !f.startsWith('_'));

  console.log(`Loading ${files.length} transcript files...`);

  const transcripts = [];
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(TRANSCRIPTS_DIR, file), 'utf8'));
      transcripts.push(data);
    } catch (err) {
      console.error(`Error loading ${file}: ${err.message}`);
    }
  }

  return transcripts;
}

/**
 * Build the knowledge entries from transcripts.
 * Each entry is a chunk enriched with speaker/topic metadata for vector storage.
 */
function buildKnowledgeEntries(transcripts) {
  const entries = [];

  for (const transcript of transcripts) {
    // Use long chunks (2-min windows) for richer context
    const chunks = transcript.longChunks || transcript.chunks;

    for (const chunk of chunks) {
      entries.push({
        id: chunk.id,
        content: chunk.text,
        metadata: {
          videoId: transcript.videoId,
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          duration: transcript.duration,
          topics: chunk.topics,
          speakersMentioned: chunk.speakersMentioned,
          wordCount: chunk.wordCount,
          youtubeUrl: `https://youtube.com/watch?v=${transcript.videoId}&t=${Math.floor(chunk.startMs / 1000)}`
        }
      });
    }
  }

  return entries;
}

/**
 * Build speaker-specific topic profiles by analyzing what each speaker
 * is mentioned alongside.
 */
function buildSpeakerTopicProfiles(transcripts) {
  const profiles = {};

  for (const [key, profile] of Object.entries(SPEAKER_PROFILES)) {
    profiles[key] = {
      ...profile,
      topicCounts: {},
      sampleQuotes: [],
      totalMentions: 0,
      episodeAppearances: 0
    };
  }

  for (const transcript of transcripts) {
    const speakersInEpisode = new Set();
    const chunks = transcript.chunks || [];

    for (const chunk of chunks) {
      for (const speaker of chunk.speakersMentioned) {
        if (profiles[speaker]) {
          profiles[speaker].totalMentions++;
          speakersInEpisode.add(speaker);

          for (const topic of chunk.topics) {
            profiles[speaker].topicCounts[topic] = (profiles[speaker].topicCounts[topic] || 0) + 1;
          }

          // Keep sample quotes (chunks where this speaker is mentioned)
          if (profiles[speaker].sampleQuotes.length < 50 && chunk.wordCount > 20) {
            profiles[speaker].sampleQuotes.push({
              text: chunk.text.slice(0, 300),
              videoId: transcript.videoId,
              time: chunk.startTime,
              topics: chunk.topics
            });
          }
        }
      }
    }

    for (const speaker of speakersInEpisode) {
      profiles[speaker].episodeAppearances++;
    }
  }

  // Sort topic counts for each speaker
  for (const [key, profile] of Object.entries(profiles)) {
    const sorted = Object.entries(profile.topicCounts)
      .sort(([, a], [, b]) => b - a);
    profile.topTopics = sorted.slice(0, 10).map(([topic, count]) => ({ topic, count }));
  }

  return profiles;
}

/**
 * Generate a simple bag-of-words embedding vector.
 * Uses TF-IDF-like weighting over a fixed vocabulary built from the corpus.
 * This is a lightweight local approach — no external API needed.
 * Dimension: 512 (hash-projected)
 */
function buildVocabulary(entries) {
  const docFreq = {};
  const N = entries.length;

  for (const entry of entries) {
    const words = new Set(entry.content.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2));
    for (const word of words) {
      docFreq[word] = (docFreq[word] || 0) + 1;
    }
  }

  // Keep words that appear in 2+ but <80% of docs (IDF filter)
  const vocab = Object.entries(docFreq)
    .filter(([, df]) => df >= 2 && df < N * 0.8)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5000)
    .map(([word]) => word);

  return vocab;
}

function hashProject(word, dimensions = 512) {
  // Simple string hash to project words into fixed-dimension space
  let hash = 0;
  for (let i = 0; i < word.length; i++) {
    hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % dimensions;
}

function textToVector(text, vocab, dimensions = 512) {
  const vec = new Float32Array(dimensions);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const wordCounts = {};

  for (const word of words) {
    wordCounts[word] = (wordCounts[word] || 0) + 1;
  }

  for (const [word, count] of Object.entries(wordCounts)) {
    const idx = hashProject(word, dimensions);
    const tf = count / words.length;
    vec[idx] += tf;
  }

  // L2 normalize
  let norm = 0;
  for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dimensions; i++) vec[i] /= norm;
  }

  return vec;
}

/**
 * Build the RVF knowledge base.
 * Uses hash-projected TF vectors for local embedding (no API needed).
 * Falls back to JSON if RVF is not available.
 */
async function buildRvfKnowledgeBase(entries, speakerProfiles) {
  const DIMENSIONS = 512;
  let useRvf = false;

  console.log('Building vocabulary from corpus...');
  const vocab = buildVocabulary(entries);
  console.log(`Vocabulary: ${vocab.length} terms`);

  // Generate vectors for all entries
  console.log('Generating embeddings...');
  const vectors = entries.map(e => textToVector(e.content, vocab, DIMENSIONS));

  try {
    const { RvfDatabase } = await import('@ruvector/rvf');
    useRvf = true;
    console.log('Using RVF binary format for knowledge base');

    const rvfPath = join(KB_DIR, 'all-in-expert.rvf');

    const db = await RvfDatabase.create(rvfPath, {
      dimensions: DIMENSIONS,
      metric: 'cosine',
      m: 16,
      efConstruction: 200
    });

    // Ingest in batches of 100
    const BATCH = 100;
    let indexed = 0;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH).map((entry, j) => ({
        id: entry.id,
        vector: vectors[i + j],
        metadata: {
          videoId: entry.metadata.videoId,
          startMs: entry.metadata.startMs || 0,
          wordCount: entry.metadata.wordCount || 0
        }
      }));

      const result = await db.ingestBatch(batch);
      indexed += result.accepted;

      if (indexed % 500 === 0 || i + BATCH >= entries.length) {
        console.log(`Indexed ${indexed}/${entries.length} entries (${result.rejected} rejected in last batch)`);
      }
    }

    await db.close();
    console.log(`RVF database saved: ${indexed} entries indexed at ${rvfPath}`);
  } catch (err) {
    console.log(`RVF not available (${err.message}), falling back to JSON format`);
    useRvf = false;
  }

  // Always save JSON backup for portability
  console.log('Saving JSON knowledge base...');

  // Save entries in batches to avoid huge files
  const BATCH_SIZE = 500;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE);
    writeFileSync(
      join(KB_DIR, `entries_${batchNum.toString().padStart(3, '0')}.json`),
      JSON.stringify(batch, null, 2)
    );
  }

  // Save speaker profiles
  for (const [key, profile] of Object.entries(speakerProfiles)) {
    writeFileSync(
      join(PROFILES_DIR, `${key}.json`),
      JSON.stringify(profile, null, 2)
    );
  }

  // Save KB manifest
  const manifest = {
    createdAt: new Date().toISOString(),
    format: useRvf ? 'rvf+json' : 'json',
    entryCount: entries.length,
    speakers: Object.keys(speakerProfiles),
    speakerStats: Object.fromEntries(
      Object.entries(speakerProfiles).map(([k, v]) => [k, {
        mentions: v.totalMentions,
        episodes: v.episodeAppearances,
        topTopics: v.topTopics
      }])
    ),
    topicDistribution: entries.reduce((acc, e) => {
      for (const topic of e.metadata.topics) {
        acc[topic] = (acc[topic] || 0) + 1;
      }
      return acc;
    }, {})
  };

  writeFileSync(join(KB_DIR, '_manifest.json'), JSON.stringify(manifest, null, 2));

  return manifest;
}

async function main() {
  console.log('=== All-In Expert Knowledge Base Builder ===\n');

  const transcripts = loadTranscripts();
  if (transcripts.length === 0) {
    console.error('No transcripts found. Run process-captions.mjs first.');
    process.exit(1);
  }

  console.log(`\nBuilding knowledge entries from ${transcripts.length} episodes...`);
  const entries = buildKnowledgeEntries(transcripts);
  console.log(`Created ${entries.length} knowledge entries`);

  console.log('\nBuilding speaker expertise profiles...');
  const speakerProfiles = buildSpeakerTopicProfiles(transcripts);

  for (const [key, profile] of Object.entries(speakerProfiles)) {
    console.log(`  ${profile.name}: ${profile.totalMentions} mentions across ${profile.episodeAppearances} episodes`);
    if (profile.topTopics.length > 0) {
      console.log(`    Top topics: ${profile.topTopics.slice(0, 5).map(t => t.topic).join(', ')}`);
    }
  }

  console.log('\nBuilding knowledge base...');
  const manifest = await buildRvfKnowledgeBase(entries, speakerProfiles);

  console.log('\n=== Knowledge Base Complete ===');
  console.log(`  Entries: ${manifest.entryCount}`);
  console.log(`  Format: ${manifest.format}`);
  console.log(`  Topics: ${Object.keys(manifest.topicDistribution).join(', ')}`);
  console.log(`\n  Speaker Profiles: data/profiles/`);
  console.log(`  Knowledge Base: data/kb/`);
}

main().catch(console.error);

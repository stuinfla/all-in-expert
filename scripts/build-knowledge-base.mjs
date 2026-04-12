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

// Speaker expertise profiles — core besties + frequent guests
const SPEAKER_PROFILES = {
  chamath: {
    name: 'Chamath Palihapitiya', tier: 'core',
    role: 'Venture Capitalist, Social Capital CEO',
    lensDescription: 'Analyzes through the lens of capital allocation, market efficiency, and systemic risk. Tends toward contrarian macro views. Focuses on where capital is flowing and why.',
    expertise: ['venture capital', 'public markets', 'macro economics', 'politics', 'tech investing', 'SPACs', 'healthcare', 'climate tech'],
    biases: ['pro-efficiency', 'skeptical of government intervention', 'data-driven', 'contrarian on popular narratives'],
    debateStyle: 'Data-heavy, contrarian, willing to take unpopular positions. Often challenges conventional wisdom with numbers.'
  },
  sacks: {
    name: 'David Sacks', tier: 'core',
    role: 'Craft Ventures GP, Former PayPal COO, White House AI & Crypto Czar (2025)',
    lensDescription: 'Analyzes through enterprise value creation and political power dynamics. Strong foreign policy views. Post-2025: insider government perspective on AI policy.',
    expertise: ['enterprise SaaS', 'politics', 'foreign policy', 'AI policy', 'crypto regulation', 'government efficiency', 'DOGE', 'defense tech'],
    biases: ['pro-business', 'non-interventionist foreign policy', 'skeptical of media narratives', 'pro-crypto'],
    debateStyle: 'Analytical and measured, builds logical arguments methodically. Often frames issues as systems problems.'
  },
  friedberg: {
    name: 'David Friedberg', tier: 'core',
    role: 'The Production Board CEO, Former Google',
    lensDescription: 'Analyzes through scientific first principles and systems thinking. Brings deep science background to every topic. The "Sultan of Science."',
    expertise: ['science', 'agriculture', 'climate', 'biotech', 'food technology', 'macro economics', 'energy', 'longevity'],
    biases: ['evidence-based', 'systems thinker', 'long-term oriented', 'pro-innovation', 'skeptical of narratives without data'],
    debateStyle: 'Methodical, science-first. Often reframes political debates as scientific/economic questions. Brings unique perspectives from hard science.'
  },
  calacanis: {
    name: 'Jason Calacanis', tier: 'core',
    role: 'Angel Investor, LAUNCH CEO, Podcast Host',
    lensDescription: 'Analyzes as a startup ecosystem insider and media operator. Practical, founder-focused perspective. The moderator and provocateur.',
    expertise: ['startups', 'angel investing', 'media', 'tech industry', 'founder dynamics', 'podcasting', 'content creation'],
    biases: ['pro-founder', 'optimistic on startups', 'media-savvy', 'relationship-driven analysis'],
    debateStyle: 'Provocative, asks the uncomfortable questions. Often plays devil\'s advocate. Steers conversations toward actionable takeaways.'
  },
  gerstner: {
    name: 'Brad Gerstner', tier: 'guest',
    role: 'Founder/CEO, Altimeter Capital',
    lensDescription: 'Long-term tech growth investor. Focuses on category-defining tech franchises and durable competitive advantages.',
    expertise: ['growth investing', 'public markets', 'tech platforms', 'AI infrastructure', 'long-term compounding'],
    biases: ['bullish on US tech', 'platform-oriented', 'long duration'],
    debateStyle: 'Measured, analytical, references specific companies and metrics. Focuses on what endures.'
  },
  gurley: {
    name: 'Bill Gurley', tier: 'guest',
    role: 'General Partner, Benchmark',
    lensDescription: 'Late-stage VC and market structure expert. Skeptical of rent-seeking regulation and market distortions.',
    expertise: ['late-stage VC', 'market structure', 'IPO markets', 'marketplaces', 'regulation critique'],
    biases: ['anti-regulatory-capture', 'pro-free-markets', 'skeptical of central planning'],
    debateStyle: 'Pointed, historical, often references specific market failures and regulatory missteps.'
  },
  baker: {
    name: 'Gavin Baker', tier: 'guest',
    role: 'CIO, Atreides Management',
    lensDescription: 'Tech growth investor with deep focus on AI compute economics and semiconductor cycles.',
    expertise: ['public tech markets', 'AI compute', 'semiconductors', 'growth investing'],
    biases: ['deeply informed on hardware/software stack', 'long tech'],
    debateStyle: 'Highly technical, brings granular data on compute, model economics, and capex cycles.'
  },
  thiel: {
    name: 'Peter Thiel', tier: 'guest',
    role: 'Co-founder PayPal/Palantir, Founders Fund',
    lensDescription: 'Contrarian philosopher-investor. Believes in monopolies as engines of progress and is skeptical of consensus.',
    expertise: ['contrarian VC', 'monopoly theory', 'political philosophy', 'defense tech', 'zero-to-one thinking'],
    biases: ['anti-consensus', 'pro-monopoly', 'skeptical of globalization'],
    debateStyle: 'Philosophical, historical, challenges frames rather than facts.'
  },
  ackman: {
    name: 'Bill Ackman', tier: 'guest',
    role: 'Founder/CEO, Pershing Square Capital',
    lensDescription: 'Activist public-markets investor. Sharp macro views, outspoken on policy and DEI/university issues.',
    expertise: ['activist investing', 'public markets', 'macro', 'university governance'],
    biases: ['outspoken', 'anti-woke', 'long duration concentrated bets'],
    debateStyle: 'Direct, combative, willing to call out individuals and institutions by name.'
  },
  gracias: {
    name: 'Antonio Gracias', tier: 'guest',
    role: 'Founder/CEO, Valor Equity Partners',
    lensDescription: 'Operational VC with deep Elon/Tesla network ties. Led DOGE investigation efforts.',
    expertise: ['operational VC', 'manufacturing', 'DOGE', 'voter fraud investigation', 'SpaceX/Tesla network'],
    biases: ['operational rigor', 'pro-DOGE', 'Musk-aligned'],
    debateStyle: 'Quietly confident, brings operational receipts and specific findings from investigations.'
  },
  rabois: {
    name: 'Keith Rabois', tier: 'guest',
    role: 'Partner, Khosla Ventures',
    lensDescription: 'Contrarian startup investor known for polarizing takes on hiring, cities, and founders.',
    expertise: ['payments', 'real estate tech', 'founder selection', 'contrarian startup theses'],
    biases: ['anti-consensus hiring', 'pro-Miami', 'skeptical of remote work'],
    debateStyle: 'Provocative, takes extreme positions, often against conventional startup wisdom.'
  },
  lonsdale: {
    name: 'Joe Lonsdale', tier: 'guest',
    role: 'Co-founder Palantir, 8VC',
    lensDescription: 'Defense tech and policy reform advocate. Focuses on government modernization and infrastructure.',
    expertise: ['defense tech', 'government efficiency', 'infrastructure', 'policy reform', 'palantir'],
    biases: ['pro-reform', 'pro-defense-tech', 'anti-bureaucracy'],
    debateStyle: 'Action-oriented, focused on concrete solutions to systemic government problems.'
  },
  naval: {
    name: 'Naval Ravikant', tier: 'guest',
    role: 'Co-founder AngelList',
    lensDescription: 'Philosopher-investor. Focuses on first principles of wealth, leverage, and specific knowledge.',
    expertise: ['philosophy of wealth', 'angel investing', 'startups', 'specific knowledge', 'leverage'],
    biases: ['first-principles', 'long-term', 'anti-credentialism'],
    debateStyle: 'Concise aphorisms, deep frameworks, rarely engages in tactical debates.'
  },
  elon: {
    name: 'Elon Musk', tier: 'guest',
    role: 'CEO Tesla/SpaceX/xAI, X owner',
    lensDescription: 'First-principles engineer-entrepreneur. Focuses on accelerating technology to save civilization.',
    expertise: ['Tesla', 'SpaceX', 'xAI', 'DOGE', 'free speech', 'AI safety', 'first principles engineering'],
    biases: ['techno-optimist', 'anti-woke', 'pro-efficiency'],
    debateStyle: 'Direct, engineering-focused, brings concrete physics and economics to abstract debates.'
  },
  tucker: {
    name: 'Tucker Carlson', tier: 'guest',
    role: 'Conservative media host',
    lensDescription: 'Populist conservative commentator. Skeptical of institutions and foreign interventionism.',
    expertise: ['conservative media', 'populism', 'foreign policy critique', 'media criticism'],
    biases: ['populist', 'anti-interventionist', 'institutionally skeptical'],
    debateStyle: 'Rhetorical, uses interview format to draw out unusual positions.'
  },
  kalanick: {
    name: 'Travis Kalanick', tier: 'guest',
    role: 'Founder Uber, CEO CloudKitchens',
    lensDescription: 'Founder-operator focused on disrupting physical-world industries via software and logistics.',
    expertise: ['founder/operator mindset', 'disruption', 'real estate tech', 'logistics', 'marketplaces'],
    biases: ['operator-first', 'aggressive growth', 'pro-disruption'],
    debateStyle: 'Aggressive, operator-focused, talks about systems and marketplace dynamics.'
  },
  cuban: {
    name: 'Mark Cuban', tier: 'guest',
    role: 'Owner Dallas Mavericks, serial entrepreneur',
    lensDescription: 'Pragmatic entrepreneur focused on direct-to-consumer strategies and healthcare cost reform.',
    expertise: ['entrepreneurship', 'sports business', 'healthcare costs', 'consumer tech'],
    biases: ['pragmatic', 'consumer advocate', 'willing to take political positions'],
    debateStyle: 'Direct, data-driven on specific industries, pushes back on ideology.'
  },
  shapiro: {
    name: 'Ben Shapiro', tier: 'guest',
    role: 'Daily Wire co-founder',
    lensDescription: 'Conservative commentator focused on politics, media, and cultural issues.',
    expertise: ['politics', 'media', 'culture wars', 'legal analysis'],
    biases: ['conservative', 'anti-woke', 'pro-Israel'],
    debateStyle: 'Rapid, fact-heavy, confrontational. Builds arguments through stacked facts.'
  },
  saagar: {
    name: 'Saagar Enjeti', tier: 'guest',
    role: 'Breaking Points host',
    lensDescription: 'Populist political journalist focused on working-class issues and foreign policy critique.',
    expertise: ['political journalism', 'populism', 'foreign policy', 'trade policy'],
    biases: ['populist', 'anti-establishment', 'pro-worker'],
    debateStyle: 'Journalistic, brings historical context and policy detail.'
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
/**
 * Build the RVF knowledge base.
 * Uses @xenova/transformers (all-MiniLM-L6-v2, 384 dims) for REAL semantic embeddings.
 * Model runs locally via ONNX — no API needed.
 */
async function buildRvfKnowledgeBase(entries, speakerProfiles) {
  const DIMENSIONS = 384;
  let useRvf = false;

  console.log('Loading MiniLM-L6-v2 embedding model...');
  const { pipeline } = await import('@xenova/transformers');
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });

  console.log(`Generating real semantic embeddings for ${entries.length} entries...`);
  const vectors = [];
  const BATCH = 32;
  const start = Date.now();

  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = entries.slice(i, i + BATCH).map(e => e.content.slice(0, 512));
    const result = await extractor(batch, { pooling: 'mean', normalize: true });

    // Extract per-document vectors from tensor
    const flatData = result.data;
    for (let j = 0; j < batch.length; j++) {
      const vec = new Float32Array(DIMENSIONS);
      for (let k = 0; k < DIMENSIONS; k++) {
        vec[k] = flatData[j * DIMENSIONS + k];
      }
      vectors.push(vec);
    }

    if ((i + BATCH) % 320 === 0 || i + BATCH >= entries.length) {
      const pct = Math.min(100, ((i + BATCH) / entries.length * 100)).toFixed(1);
      const rate = ((i + BATCH) / ((Date.now() - start) / 1000)).toFixed(0);
      console.log(`  Embedded ${Math.min(i + BATCH, entries.length)}/${entries.length} (${pct}%, ${rate} entries/sec)`);
    }
  }

  console.log(`All ${vectors.length} embeddings generated in ${((Date.now() - start) / 1000).toFixed(1)}s`);

  // Write precomputed embeddings as a flat Float32 binary file for
  // serverless-friendly cosine similarity (bypasses @ruvector/rvf native module)
  const WEB_DATA_EARLY = join(ROOT, 'web', 'public', 'data');
  mkdirSync(WEB_DATA_EARLY, { recursive: true });
  const embeddingsBin = new Float32Array(entries.length * DIMENSIONS);
  const idOrder = [];
  for (let i = 0; i < entries.length; i++) {
    embeddingsBin.set(vectors[i], i * DIMENSIONS);
    idOrder.push(entries[i].id);
  }
  writeFileSync(join(KB_DIR, 'embeddings.bin'), Buffer.from(embeddingsBin.buffer));
  writeFileSync(join(WEB_DATA_EARLY, 'embeddings.bin'), Buffer.from(embeddingsBin.buffer));
  writeFileSync(join(KB_DIR, 'embeddings-order.json'), JSON.stringify(idOrder));
  writeFileSync(join(WEB_DATA_EARLY, 'embeddings-order.json'), JSON.stringify(idOrder));
  console.log(`Embeddings binary: ${entries.length} × ${DIMENSIONS} Float32 = ${(embeddingsBin.byteLength / 1024 / 1024).toFixed(1)}MB`);

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

  // Build content index: compact JSON mapping entry IDs to content + metadata
  // This ships alongside the RVF file for Vercel deployment
  console.log('Building content index...');

  const contentIndex = {};
  for (const entry of entries) {
    contentIndex[entry.id] = {
      c: entry.content,                          // text content
      v: entry.metadata.videoId,                  // video ID
      t: entry.metadata.startTime || '00:00:00',  // timestamp
      s: entry.metadata.startMs || 0,             // start ms
      p: entry.metadata.topics || [],             // topics
      m: entry.metadata.speakersMentioned || [],   // speakers mentioned
      u: entry.metadata.youtubeUrl || ''           // youtube URL
    };
  }

  // Save content index to both KB dir and web/public/data for deployment
  const WEB_DATA_DIR = join(ROOT, 'web', 'public', 'data');
  mkdirSync(WEB_DATA_DIR, { recursive: true });

  writeFileSync(join(KB_DIR, 'content-index.json'), JSON.stringify(contentIndex));
  writeFileSync(join(WEB_DATA_DIR, 'content-index.json'), JSON.stringify(contentIndex));
  console.log(`Content index: ${Object.keys(contentIndex).length} entries (${(JSON.stringify(contentIndex).length / 1024 / 1024).toFixed(1)}MB)`);

  // Copy RVF to web/public/data if it was built
  if (useRvf) {
    const rvfSrc = join(KB_DIR, 'all-in-expert.rvf');
    const rvfDst = join(WEB_DATA_DIR, 'all-in-expert.rvf');
    const { copyFileSync } = await import('fs');
    copyFileSync(rvfSrc, rvfDst);
    console.log(`RVF copied to ${rvfDst}`);
  }

  // Also save legacy batch entries for CLI compatibility
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

  // Copy speaker profiles to web/public/data
  writeFileSync(join(WEB_DATA_DIR, 'speaker-profiles.json'), JSON.stringify(speakerProfiles));

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

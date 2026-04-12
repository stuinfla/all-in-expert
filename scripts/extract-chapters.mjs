#!/usr/bin/env node
/**
 * Extract timestamped topic chapters from the RSS feed and build a separate
 * RVF index for topic-based search.
 *
 * Each episode's description contains entries like "(0:00) Topic title".
 * We parse these into structured chapters and index them.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';
import { pipeline } from '@xenova/transformers';
import { RvfDatabase } from '@ruvector/rvf';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const RSS_FILE = join(ROOT, 'data', 'episodes', 'rss_feed.xml');
const CHAPTERS_DIR = join(ROOT, 'data', 'chapters');
const WEB_DATA_DIR = join(ROOT, 'web', 'public', 'data');

if (!existsSync(CHAPTERS_DIR)) mkdirSync(CHAPTERS_DIR, { recursive: true });
if (!existsSync(WEB_DATA_DIR)) mkdirSync(WEB_DATA_DIR, { recursive: true });

// Regex: matches "(H:MM:SS) Topic" or "(MM:SS) Topic"
const CHAPTER_REGEX = /\((\d{1,2}):(\d{2})(?::(\d{2}))?\)\s*([^<]+?)(?=<\/p>|<p>|\s*\(\d)/gi;

function parseTimestamp(h, m, s) {
  const hours = s ? parseInt(h) : 0;
  const mins = s ? parseInt(m) : parseInt(h);
  const secs = s ? parseInt(s) : parseInt(m);
  return hours * 3600 + mins * 60 + secs;
}

function formatTime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function cleanTopicText(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractChapters(description) {
  const chapters = [];
  CHAPTER_REGEX.lastIndex = 0;

  let match;
  while ((match = CHAPTER_REGEX.exec(description)) !== null) {
    const [, h, m, s, topicText] = match;
    const startSec = parseTimestamp(h, m, s);
    const topic = cleanTopicText(topicText);
    if (!topic || topic.length < 3 || topic.length > 300) continue;
    chapters.push({ startSec, startTime: formatTime(startSec), topic });
  }

  return chapters;
}

function parseDate(dateStr) {
  try {
    return new Date(dateStr).toISOString().split('T')[0];
  } catch {
    return '';
  }
}

async function main() {
  console.log('Parsing RSS feed...');
  const xml = readFileSync(RSS_FILE, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  const items = parsed.rss?.channel?.item || [];

  console.log(`Found ${items.length} RSS items`);

  const episodes = [];
  let totalChapters = 0;

  for (const item of items) {
    const title = item.title || '';
    const description = typeof item.description === 'string'
      ? item.description
      : (item.description?.['#text'] || '');
    const pubDate = item.pubDate || '';
    const date = parseDate(pubDate);
    const audioUrl = item.enclosure?.['@_url'] || '';

    if (!date || new Date(date) < new Date('2024-04-01')) continue;

    const chapters = extractChapters(description);
    if (chapters.length === 0) continue;

    episodes.push({ title, date, audioUrl, chapters });
    totalChapters += chapters.length;
  }

  episodes.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  console.log(`Extracted ${totalChapters} chapters from ${episodes.length} episodes`);
  console.log(`Date range: ${episodes[episodes.length - 1]?.date} through ${episodes[0]?.date}`);
  console.log(`Avg chapters/episode: ${(totalChapters / episodes.length).toFixed(1)}`);

  console.log('\nMost recent episode sample:');
  const recent = episodes[0];
  if (recent) {
    console.log(`  ${recent.date}: ${recent.title.slice(0, 70)}`);
    for (const ch of recent.chapters.slice(0, 5)) {
      console.log(`    ${ch.startTime}  ${ch.topic.slice(0, 70)}`);
    }
  }

  // Build structured index
  const episodeIndex = episodes.map((ep, i) => ({
    id: `ep_${i.toString().padStart(4, '0')}`,
    title: ep.title,
    date: ep.date,
    audioUrl: ep.audioUrl,
    chapterCount: ep.chapters.length,
    chapters: ep.chapters.map((ch, j) => ({
      id: `ep_${i.toString().padStart(4, '0')}_ch_${j.toString().padStart(2, '0')}`,
      startSec: ch.startSec,
      startTime: ch.startTime,
      topic: ch.topic,
    })),
  }));

  writeFileSync(join(CHAPTERS_DIR, 'chapters.json'), JSON.stringify(episodeIndex, null, 2));
  writeFileSync(join(WEB_DATA_DIR, 'chapters.json'), JSON.stringify(episodeIndex));

  const sizeMB = (JSON.stringify(episodeIndex).length / 1024 / 1024).toFixed(2);
  console.log(`\nSaved chapters.json (${sizeMB}MB)`);

  // ─── Build RVF topic index ─────────────────────────────────
  console.log('\nLoading embedding model...');
  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { quantized: true });

  const allChapters = [];
  for (const ep of episodeIndex) {
    for (const ch of ep.chapters) {
      allChapters.push({
        id: ch.id,
        text: ch.topic,
        episodeTitle: ep.title,
        episodeDate: ep.date,
        audioUrl: ep.audioUrl,
        startTime: ch.startTime,
        startSec: ch.startSec,
      });
    }
  }

  console.log(`Embedding ${allChapters.length} chapter topics...`);

  const rvfPath = join(CHAPTERS_DIR, 'chapters.rvf');
  try { unlinkSync(rvfPath); } catch {}

  const db = await RvfDatabase.create(rvfPath, {
    dimensions: 384,
    metric: 'cosine',
    m: 16,
    efConstruction: 200,
  });

  const BATCH = 64;
  const start = Date.now();
  const chapterLookup = {};

  for (let i = 0; i < allChapters.length; i += BATCH) {
    const batch = allChapters.slice(i, i + BATCH);
    const texts = batch.map(c => c.text);
    const result = await extractor(texts, { pooling: 'mean', normalize: true });

    const entries = [];
    for (let j = 0; j < batch.length; j++) {
      const vec = new Float32Array(384);
      for (let k = 0; k < 384; k++) {
        vec[k] = result.data[j * 384 + k];
      }
      entries.push({
        id: batch[j].id,
        vector: vec,
        metadata: { startSec: batch[j].startSec },
      });
      chapterLookup[batch[j].id] = {
        topic: batch[j].text,
        episodeTitle: batch[j].episodeTitle,
        episodeDate: batch[j].episodeDate,
        audioUrl: batch[j].audioUrl,
        startTime: batch[j].startTime,
        startSec: batch[j].startSec,
      };
    }

    await db.ingestBatch(entries);

    if ((i + BATCH) % 640 === 0 || i + BATCH >= allChapters.length) {
      const done = Math.min(i + BATCH, allChapters.length);
      const rate = (done / ((Date.now() - start) / 1000)).toFixed(0);
      console.log(`  Embedded ${done}/${allChapters.length} (${rate}/sec)`);
    }
  }

  await db.close();

  writeFileSync(join(CHAPTERS_DIR, 'chapter-lookup.json'), JSON.stringify(chapterLookup));
  writeFileSync(join(WEB_DATA_DIR, 'chapter-lookup.json'), JSON.stringify(chapterLookup));
  copyFileSync(rvfPath, join(WEB_DATA_DIR, 'chapters.rvf'));

  // Build freshness manifest
  const manifest = {
    updatedAt: new Date().toISOString(),
    episodeCount: episodeIndex.length,
    chapterCount: allChapters.length,
    dateRange: {
      oldest: episodes[episodes.length - 1]?.date,
      newest: episodes[0]?.date,
    },
    latestEpisode: {
      title: episodes[0]?.title,
      date: episodes[0]?.date,
    },
  };
  writeFileSync(join(CHAPTERS_DIR, 'freshness.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(WEB_DATA_DIR, 'freshness.json'), JSON.stringify(manifest));

  console.log(`\nDone in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  console.log(`Latest episode: ${manifest.latestEpisode.date}`);
}

main().catch(e => {
  console.error('ERROR:', e.message);
  console.error(e.stack);
  process.exit(1);
});

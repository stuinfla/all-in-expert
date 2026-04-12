#!/usr/bin/env node
/**
 * Build a videoId → episode date map by fuzzy-matching YouTube titles
 * to RSS episode titles. Used for recency-weighted search ranking.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const TSV = join(ROOT, 'data', 'episodes', 'all_video_ids.tsv');
const RSS_FILE = join(ROOT, 'data', 'episodes', 'rss_feed.xml');
const OUT_LOCAL = join(ROOT, 'data', 'kb', 'episode-dates.json');
const OUT_WEB = join(ROOT, 'web', 'public', 'data', 'episode-dates.json');

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenOverlap(a, b) {
  const tokensA = new Set(normalize(a).split(' ').filter((w) => w.length > 3));
  const tokensB = new Set(normalize(b).split(' ').filter((w) => w.length > 3));
  let overlap = 0;
  for (const t of tokensA) if (tokensB.has(t)) overlap++;
  const union = tokensA.size + tokensB.size - overlap;
  return union > 0 ? overlap / union : 0;
}

function parseRssDate(dateStr) {
  try {
    return new Date(dateStr).toISOString().split('T')[0];
  } catch {
    return null;
  }
}

function loadFullRss() {
  const xml = readFileSync(RSS_FILE, 'utf8');
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  const items = parsed.rss?.channel?.item || [];
  return items
    .map((item) => {
      const title = item.title || '';
      const pubDate = item.pubDate || '';
      const date = parseRssDate(pubDate);
      return { title, date };
    })
    .filter((e) => e.date && e.title);
}

function main() {
  // Load FULL RSS feed (all episodes, not just April 2024+)
  const rssEpisodes = loadFullRss();
  console.log(`Loaded ${rssEpisodes.length} RSS episodes (full feed)`);

  // Load YouTube video IDs (has videoId + youtube_title)
  const tsv = readFileSync(TSV, 'utf8');
  const ytVideos = tsv
    .trim()
    .split('\n')
    .map((line) => {
      const parts = line.split('\t');
      return { id: parts[0], title: parts.slice(1).join('\t') };
    })
    .filter((v) => v.id);
  console.log(`Loaded ${ytVideos.length} YouTube videos`);

  // For each YT video, find the best RSS match
  const videoDates = {};
  let matched = 0;
  let unmatched = 0;

  for (const yt of ytVideos) {
    let bestScore = 0;
    let bestEpisode = null;
    for (const rss of rssEpisodes) {
      const score = tokenOverlap(yt.title, rss.title);
      if (score > bestScore) {
        bestScore = score;
        bestEpisode = rss;
      }
    }
    if (bestScore >= 0.2 && bestEpisode) {
      videoDates[yt.id] = bestEpisode.date;
      matched++;
    } else {
      unmatched++;
    }
  }

  console.log(`Matched ${matched}/${ytVideos.length} videos to dates (${unmatched} unmatched)`);

  // Compute stats
  const dates = Object.values(videoDates).sort();
  console.log(`Date range: ${dates[0]} → ${dates[dates.length - 1]}`);

  // Save
  mkdirSync(dirname(OUT_LOCAL), { recursive: true });
  mkdirSync(dirname(OUT_WEB), { recursive: true });
  writeFileSync(OUT_LOCAL, JSON.stringify(videoDates));
  writeFileSync(OUT_WEB, JSON.stringify(videoDates));

  const sizeKB = (JSON.stringify(videoDates).length / 1024).toFixed(1);
  console.log(`Saved episode-dates.json (${sizeKB}KB)`);
}

main();

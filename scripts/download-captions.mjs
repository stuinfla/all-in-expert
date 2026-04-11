#!/usr/bin/env node
/**
 * Download YouTube auto-captions for All-In Podcast episodes.
 * Uses yt-dlp with rate-limiting delays to avoid YouTube throttling.
 *
 * Usage:
 *   node scripts/download-captions.mjs              # Download all
 *   node scripts/download-captions.mjs --batch 50   # Download 50 at a time
 *   node scripts/download-captions.mjs --resume     # Skip already downloaded
 */

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CAPTIONS_DIR = join(ROOT, 'data', 'captions');
const EPISODES_FILE = join(ROOT, 'data', 'episodes', 'all_video_ids.tsv');
const PROGRESS_FILE = join(ROOT, 'data', 'episodes', 'download_progress.json');

const DELAY_MS = 3000; // 3 seconds between downloads to avoid rate limiting
const BATCH_SIZE = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--batch') || '999');
const RESUME = process.argv.includes('--resume');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function loadProgress() {
  if (existsSync(PROGRESS_FILE)) {
    return JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'));
  }
  return { downloaded: [], failed: [], skipped: [] };
}

function saveProgress(progress) {
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function getAlreadyDownloaded() {
  if (!existsSync(CAPTIONS_DIR)) return new Set();
  return new Set(
    readdirSync(CAPTIONS_DIR)
      .filter(f => f.endsWith('.en.json3'))
      .map(f => f.replace('.en.json3', ''))
  );
}

async function downloadCaption(videoId) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--write-auto-subs',
      '--sub-lang', 'en',
      '--sub-format', 'json3',
      '--skip-download',
      '--extractor-args', 'youtube:player_client=default',
      '--no-warnings',
      '-o', join(CAPTIONS_DIR, '%(id)s'),
      `https://www.youtube.com/watch?v=${videoId}`
    ]);

    let stderr = '';
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('close', code => {
      if (code === 0) resolve(true);
      else reject(new Error(stderr.trim().split('\n').pop()));
    });

    // Timeout after 60 seconds
    setTimeout(() => { proc.kill(); reject(new Error('Timeout')); }, 60000);
  });
}

async function main() {
  // Load video IDs
  const lines = readFileSync(EPISODES_FILE, 'utf8').trim().split('\n');
  const videos = lines.map(line => {
    const [id, ...titleParts] = line.split('\t');
    return { id, title: titleParts.join('\t') };
  }).filter(v => v.id);

  console.log(`Found ${videos.length} videos in catalog`);

  const alreadyDownloaded = getAlreadyDownloaded();
  const progress = loadProgress();

  let toDownload = videos;
  if (RESUME || alreadyDownloaded.size > 0) {
    toDownload = videos.filter(v => !alreadyDownloaded.has(v.id));
    console.log(`Skipping ${alreadyDownloaded.size} already downloaded, ${toDownload.length} remaining`);
  }

  toDownload = toDownload.slice(0, BATCH_SIZE);
  console.log(`Downloading ${toDownload.length} captions (batch size: ${BATCH_SIZE})`);

  let success = 0;
  let failed = 0;

  for (let i = 0; i < toDownload.length; i++) {
    const video = toDownload[i];
    const pct = ((i + 1) / toDownload.length * 100).toFixed(1);
    process.stdout.write(`[${pct}%] ${video.id} - ${video.title.slice(0, 60)}... `);

    try {
      await downloadCaption(video.id);
      progress.downloaded.push(video.id);
      success++;
      console.log('OK');
    } catch (err) {
      progress.failed.push({ id: video.id, error: err.message });
      failed++;
      console.log(`FAIL: ${err.message.slice(0, 80)}`);

      // If rate limited, back off significantly
      if (err.message.includes('rate-limit')) {
        console.log('Rate limited — waiting 60 seconds...');
        await sleep(60000);
      }
    }

    saveProgress(progress);

    // Delay between downloads
    if (i < toDownload.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nDone: ${success} downloaded, ${failed} failed, ${alreadyDownloaded.size} previously cached`);
  console.log(`Total captions available: ${getAlreadyDownloaded().size}`);
}

main().catch(console.error);

#!/usr/bin/env node
/**
 * Demote provably-unreliable speaker labels to `unknown`.
 *
 * WHY: `sk` is not a speaker label. detectPrimarySpeaker() assigns whoever is
 * NAMED first in a caption segment and lets following segments inherit it, then
 * stamps `skc:"high"`. See scripts/audit-speaker-labels.mjs (commit 3b12072):
 * at least 31.9% of chunks are provably or near-certainly wrong.
 *
 * A confidently WRONG name is worse than no name. route.ts already handles the
 * honest case — "If a segment is SPOKEN BY: uncertain, do NOT assign it to a
 * named person — paraphrase neutrally" — but that branch almost never fires,
 * because 91% of chunks carry a confident name. This makes it fire.
 *
 * We demote only what we can DISPROVE from text. We do not touch host-vs-host
 * confusion (62% of chunks), which needs audio. This is a floor, not a fix.
 *
 *   R1 spans_speaker_change  chunk contains YouTube's ">>" marker → ≥2 speakers
 *   R2 guest_absent          guest tagged on an episode whose title omits them
 *   R3 alias_disproved       the alias matched an ordinary word, not the person
 *                            ('naval blockade', 'Cuban missile crisis', 'gavin'
 *                             → Gavin NEWSOM, 'muchas gracias', …)
 *
 * Idempotent. Run after build-knowledge-base.mjs, before deploy.
 * Usage: node scripts/demote-unreliable-speakers.mjs [--dry-run]
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(ROOT, 'web', 'public', 'data', 'content-index.json');
const TITLES_PATH = join(ROOT, 'data', 'episodes', 'video_titles.json');

const DRY = process.argv.includes('--dry-run');

/** Anyone who is not one of the four hosts is a guest. */
const GUEST_RE = {
  elon: /elon|musk/i,
  thiel: /thiel/i,
  cuban: /cuban/i,
  tucker: /tucker/i,
  kalanick: /kalanick|travis/i,
  gurley: /gurley/i,
  naval: /naval|ravikant/i,
  ackman: /ackman/i,
  gerstner: /gerstner/i,
  gracias: /gracias/i,
  lonsdale: /lonsdale/i,
  doerr: /doerr/i,
  shapiro: /shapiro/i,
  baker: /gavin baker/i,
  rabois: /rabois/i,
  saagar: /saagar|enjeti/i,
  howery: /howery/i,
};

/** Phrases that prove the alias matched something other than the person. */
const DISPROVED = {
  naval: /\bnaval\s+(blockade|base|bases|power|forces|force|fleet|ship|ships|vessel|vessels|warfare|academy|yard|superiority|presence|assets|buildup|build-up|exercise|exercises|war)\b/i,
  cuban: /\bcuban\s+(missile|missiles|government|people|revolution|cigar|cigars|crisis|regime|americans)\b|\bcuba\b/i,
  gracias: /\b(muchas\s+gracias|gracias\s+(a|por|amigo|señor))\b|\bgracias\s*[.!]?\s*$/i,
  baker: /\bgavin\s+newsom\b|\bnewsom\b/i,
  kalanick: /\btravis\s+(scott|kelce|county|barker)\b/i,
  sacks: /\bsacks\s+of\b|\bburlap\b/i,
};

async function loadTitles(videoIds) {
  const cache = existsSync(TITLES_PATH) ? JSON.parse(readFileSync(TITLES_PATH, 'utf8')) : {};
  const missing = videoIds.filter((v) => !(v in cache));
  if (missing.length) {
    console.log(`  fetching ${missing.length} missing YouTube titles via oEmbed…`);
    let i = 0;
    const worker = async () => {
      while (i < missing.length) {
        const id = missing[i++];
        try {
          const r = await fetch(`https://www.youtube.com/oembed?url=https://youtu.be/${id}&format=json`);
          cache[id] = r.ok ? (await r.json()).title : null;
        } catch {
          cache[id] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: 12 }, worker));
    // Always persist: this is a CACHE, not an output. Refetching 451 titles on
    // every dry run is slow and rude to YouTube. `null` means the video is
    // private/deleted → its chunks are excluded from the guest test, keeping the
    // demotion conservative.
    writeFileSync(TITLES_PATH, JSON.stringify(cache));
  }
  return cache;
}

const idx = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
const ids = Object.keys(idx);
const videoIds = [...new Set(ids.map((k) => idx[k].v))];
console.log(`content-index: ${ids.length} chunks / ${videoIds.length} videos`);

const titles = await loadTitles(videoIds);

const before = {};
for (const k of ids) before[idx[k].sk] = (before[idx[k].sk] || 0) + 1;
// Track the projected result separately so --dry-run still shows a real table.
const after = { ...before };

const reasons = { spans_speaker_change: 0, guest_absent: 0, alias_disproved: 0 };
let demoted = 0;

for (const k of ids) {
  const e = idx[k];
  if (!e.sk || e.sk === 'unknown') continue; // idempotent

  let reason = null;
  if (e.c.includes('>>')) reason = 'spans_speaker_change';
  else if (DISPROVED[e.sk]?.test(e.c)) reason = 'alias_disproved';
  else if (GUEST_RE[e.sk]) {
    const t = titles[e.v];
    if (t && !GUEST_RE[e.sk].test(t)) reason = 'guest_absent';
  }
  if (!reason) continue;

  reasons[reason]++;
  demoted++;
  after[e.sk]--;
  after.unknown = (after.unknown || 0) + 1;
  if (!DRY) {
    e.sk = 'unknown';
    e.skc = `demoted:${reason}`;
    // `m` ("speakersMentioned") is literally [currentSpeaker] — a copy of sk, not
    // real mentions. The grader prints it as "mentions:", so it must go too, or
    // the wrong name simply reappears under a different field name.
    e.m = [];
  }
}

console.log(`\n  demoted ${demoted} chunks (${((100 * demoted) / ids.length).toFixed(1)}% of corpus) to unknown:`);
for (const [r, n] of Object.entries(reasons)) console.log(`    ${r.padEnd(22)} ${n}`);

console.log('\n  speaker            before →  after');
for (const sk of [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((s) => (before[s] || 0) + (after[s] || 0) > 200)
  .sort((a, b) => (after[b] || 0) - (after[a] || 0))) {
  console.log(`    ${sk.padEnd(16)} ${String(before[sk] || 0).padStart(6)} → ${String(after[sk] || 0).padStart(6)}`);
}

if (DRY) {
  console.log('\n  --dry-run: content-index.json NOT modified');
} else {
  writeFileSync(INDEX_PATH, JSON.stringify(idx));
  console.log(`\n  wrote ${INDEX_PATH}`);
}

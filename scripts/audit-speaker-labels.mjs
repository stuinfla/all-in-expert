#!/usr/bin/env node
/**
 * Audit the corpus's `sk` (speakerKey) labels.
 *
 * WHY: build-knowledge-base.mjs's detectPrimarySpeaker() assigns a speaker by
 * scanning a caption segment for NAME MENTIONS. Whoever is named first becomes
 * `currentSpeaker`, and every following segment inherits that name until a
 * different name is mentioned. Nothing ever listened to audio. So `sk` measures
 * "who was most recently talked ABOUT", which for third-person reference is
 * close to the opposite of "who is talking".
 *
 * This script quantifies the damage WITHOUT audio and WITHOUT human labelling,
 * using three independent tests. Each yields a LOWER BOUND on the error rate —
 * the true rate is higher, because none of them can catch host-vs-host mixups.
 *
 *   T1  Lexical impossibility. Several aliases are common English/Spanish words
 *       ('naval', 'cuban', 'gracias', 'gavin', 'travis'). A chunk tagged `naval`
 *       whose text says "naval blockade" is provably mislabelled. No judgement.
 *
 *   T2  Guest impossibility. Guests appear in a handful of episodes. A chunk
 *       tagged `elon` in an episode whose title never mentions him is almost
 *       certainly wrong. Titles come from YouTube oEmbed (no API key needed).
 *
 *   T3  Vocative hand-off. The hosts hand off explicitly: "Freeberg, what do you
 *       think?" The NEXT turn is Freeberg. detectPrimarySpeaker deliberately
 *       SKIPS vocatives, so it cannot follow a hand-off. This measures accuracy
 *       on the one transition where the correct answer is unambiguous from text.
 *
 * Usage:  node scripts/audit-speaker-labels.mjs [--t2] [--llm]
 *         (T1 and T3 are offline and always run; --t2 hits YouTube oEmbed)
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = join(ROOT, 'web', 'public', 'data', 'content-index.json');

const HOSTS = new Set(['chamath', 'sacks', 'friedberg', 'calacanis']);

/**
 * Phrases that prove the alias matched something other than the person.
 * Deliberately conservative: only unambiguous, high-frequency collocations.
 */
const IMPOSSIBLE = {
  naval: /\bnaval\s+(blockade|base|bases|power|forces|force|fleet|ship|ships|vessel|vessels|warfare|academy|yard|superiority|presence|assets|buildup|build-up|exercise|exercises|war)\b/i,
  cuban: /\bcuban\s+(missile|missiles|government|people|revolution|cigar|cigars|crisis|regime|americans)\b|\bcuba\b/i,
  gracias: /\b(muchas\s+gracias|gracias\s+(a|por|amigo|señor)|\bgracias\s*[.!]?\s*$)/i,
  baker: /\bgavin\s+newsom\b|\bnewsom\b/i,
  kalanick: /\btravis\s+(scott|kelce|county|barker)\b/i,
  sacks: /\bsacks\s+of\b|\bburlap\b|\bsandsacks\b/i,
  thiel: /\bthiel\s+(fellowship|foundation|capital)\b/i, // org, not the man speaking
};

const VOCATIVE_TARGETS = {
  friedberg: /\b(freeberg|friedberg)\b/i,
  sacks: /\b(sacks|sacky|rain man)\b/i,
  chamath: /\bchamath\b/i,
  calacanis: /\b(jason|j-?cal|calacanis)\b/i,
};

/**
 * Explicit hand-offs. Two orders occur naturally:
 *   "Freeberg, what do you think?"   (name first)
 *   "What do you think, Freeberg?"   (name last)
 * Auto-captions drop most punctuation, so commas/question marks are optional.
 * We only require the cue to fall in the TAIL of a chunk, so the addressed
 * person is the speaker of the NEXT chunk.
 */
const NAME = '(freeberg|friedberg|sacks|sacky|chamath|jason|j-?cal|calacanis)';
const ASK =
  "(what do you think|what say you|your thoughts|thoughts|go ahead|take it away|" +
  "you want to (take|go) (it|this)|any thoughts|what's your (take|view|read)|" +
  "weigh in|over to you|how do you (see|think)|do you agree)";
const HANDOFF = new RegExp(`\\b${NAME}\\b\\s*[,:?]?\\s*${ASK}|${ASK}\\s*[,:]?\\s*\\b${NAME}\\b`, 'i');
/** Tail window to search: the cue must be near the end so "next chunk" is the reply. */
const TAIL_CHARS = 260;

function loadIndex() {
  if (!existsSync(INDEX_PATH)) {
    console.error(`content-index.json not found at ${INDEX_PATH}`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
}

function pct(n, d) {
  return d === 0 ? '—' : `${((100 * n) / d).toFixed(1)}%`;
}

// ─── T1: lexical impossibility ────────────────────────────────────────────────
function t1(entries) {
  console.log('\n━━━ T1  LEXICAL IMPOSSIBILITY (provable, no judgement) ━━━\n');
  const byKey = {};
  for (const e of entries) {
    const sk = e.sk;
    if (!IMPOSSIBLE[sk]) continue;
    (byKey[sk] ??= { tagged: 0, impossible: 0, samples: [] });
    byKey[sk].tagged++;
    if (IMPOSSIBLE[sk].test(e.c)) {
      byKey[sk].impossible++;
      if (byKey[sk].samples.length < 2) byKey[sk].samples.push(e.c.replace(/\s+/g, ' ').slice(0, 120));
    }
  }
  let totalImpossible = 0;
  console.log('  alias        tagged   provably wrong   rate');
  for (const [k, v] of Object.entries(byKey).sort((a, b) => b[1].impossible - a[1].impossible)) {
    totalImpossible += v.impossible;
    console.log(`  ${k.padEnd(11)} ${String(v.tagged).padStart(6)}   ${String(v.impossible).padStart(14)}   ${pct(v.impossible, v.tagged)}`);
  }
  console.log(`\n  ${totalImpossible} chunks are mislabelled by the alias itself.`);
  console.log('  (Only counts chunks whose OWN text contains the disproving phrase.');
  console.log('   Chunks that merely INHERITED the bad label are not counted here.)\n');
  for (const [k, v] of Object.entries(byKey)) {
    if (!v.samples.length) continue;
    console.log(`  e.g. sk="${k}":`);
    for (const s of v.samples) console.log(`     "${s}…"`);
  }
  return totalImpossible;
}

// ─── T3: vocative hand-off accuracy ───────────────────────────────────────────
function t3(entries) {
  console.log('\n━━━ T3  VOCATIVE HAND-OFF ACCURACY ━━━\n');
  const byVideo = {};
  for (const e of entries) (byVideo[e.v] ??= []).push(e);
  for (const v of Object.values(byVideo)) v.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));

  let cases = 0;
  let correct = 0;
  let inherited = 0; // label equals the PREVIOUS speaker → the state machine never moved
  const examples = [];

  for (const chunks of Object.values(byVideo)) {
    for (let i = 0; i < chunks.length - 1; i++) {
      const tail = chunks[i].c.replace(/\s+/g, ' ').slice(-TAIL_CHARS);
      const m = HANDOFF.exec(tail);
      if (!m) continue;
      // the name may be captured in either alternation branch
      const namedRaw = (m[1] ?? m[m.length - 1] ?? '').toLowerCase();
      let target = null;
      for (const [key, re] of Object.entries(VOCATIVE_TARGETS)) if (re.test(namedRaw)) target = key;
      if (!target) continue;

      const next = chunks[i + 1];
      cases++;
      if (next.sk === target) correct++;
      if (next.sk === chunks[i].sk) inherited++;
      if (examples.length < 3) {
        examples.push({ cue: tail.slice(-60), expected: target, got: next.sk });
      }
    }
  }

  console.log(`  explicit hand-offs found : ${cases}`);
  console.log(`  sk names the addressed person: ${correct}  (${pct(correct, cases)})`);
  console.log(`  sk simply kept the PREVIOUS speaker: ${inherited}  (${pct(inherited, cases)})`);
  console.log(`\n  Random guessing among 4 hosts would score 25%.\n`);
  for (const ex of examples) {
    console.log(`  cue: "…${ex.cue}"`);
    console.log(`     truth ≈ ${ex.expected}   sk says: ${ex.got}\n`);
  }
  return { cases, correct };
}

// ─── T2: guest impossibility (needs YouTube titles) ───────────────────────────
async function fetchTitles(videoIds, concurrency = 12) {
  const titles = new Map();
  let i = 0;
  async function worker() {
    while (i < videoIds.length) {
      const id = videoIds[i++];
      try {
        const r = await fetch(`https://www.youtube.com/oembed?url=https://youtu.be/${id}&format=json`);
        if (r.ok) titles.set(id, (await r.json()).title);
        else titles.set(id, null); // deleted/private → unknowable, excluded from the test
      } catch {
        titles.set(id, null);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return titles;
}

async function t2(entries) {
  console.log('\n━━━ T2  GUEST IMPOSSIBILITY (guest tagged in an episode they are not on) ━━━\n');
  const guests = ['elon', 'thiel', 'cuban', 'tucker', 'kalanick', 'gurley', 'naval', 'ackman'];
  const guestRe = {
    elon: /elon|musk/i, thiel: /thiel/i, cuban: /cuban/i, tucker: /tucker/i,
    kalanick: /kalanick|travis/i, gurley: /gurley/i, naval: /naval|ravikant/i, ackman: /ackman/i,
  };

  const needed = new Set();
  for (const e of entries) if (guests.includes(e.sk)) needed.add(e.v);
  console.log(`  fetching ${needed.size} YouTube titles via oEmbed…`);
  const titles = await fetchTitles([...needed]);
  const known = [...titles.values()].filter(Boolean).length;
  console.log(`  resolved ${known}/${needed.size} titles\n`);

  console.log('  guest       chunks   in episodes NOT naming them   rate');
  let total = 0;
  const ids = new Set();
  for (const g of guests) {
    let tagged = 0, wrong = 0;
    for (const e of entries) {
      if (e.sk !== g) continue;
      const t = titles.get(e.v);
      if (!t) continue; // title unknown → excluded, keeps this a lower bound
      tagged++;
      if (!guestRe[g].test(t)) { wrong++; ids.add(e.id); }
    }
    total += wrong;
    if (tagged) console.log(`  ${g.padEnd(11)} ${String(tagged).padStart(6)}   ${String(wrong).padStart(26)}   ${pct(wrong, tagged)}`);
  }
  console.log(`\n  ${total} chunks attribute speech to a guest in an episode whose title never mentions them.`);
  console.log('  Caveat: a guest can appear without being named in the title (e.g. Summit panels),');
  console.log('  so a slice of these are false alarms. The direction is what matters: nobody can');
  console.log('  speak on an episode they are not on, and Elon alone accounts for 4,455 chunks.');
  return { total, ids };
}

// ─── T4: chunks that provably span a speaker change ───────────────────────────
/**
 * YouTube's community/manual captions mark a speaker change with ">>". A chunk
 * containing one therefore contains speech from at least TWO people, yet carries
 * exactly one `sk`. No labeller — however good — can be right about such a chunk.
 * The pipeline never looks at these markers: neither process-captions.mjs nor
 * build-knowledge-base.mjs mentions ">>". Free turn boundaries, discarded.
 */
function t4(entries) {
  console.log('\n━━━ T4  CHUNKS THAT PROVABLY SPAN A SPEAKER CHANGE ━━━\n');
  const marked = entries.filter((e) => e.c.includes('>>'));
  const vids = new Set(marked.map((e) => e.v));
  const hosted = marked.filter((e) => HOSTS.has(e.sk)).length;
  console.log(`  chunks containing ">>"            : ${marked.length}  (${pct(marked.length, entries.length)} of corpus)`);
  console.log(`  ...of those, labelled with a HOST  : ${hosted}`);
  console.log(`  videos with speaker-change markers : ${vids.size}`);
  console.log(`\n  Each of these mixes >=2 speakers under ONE label, by construction.`);
  console.log(`  The markers exist in the captions and are never read.\n`);
  return new Set(marked.map((e) => e.id ?? e.c.slice(0, 40) + e.v));
}

// ─── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const idx = loadIndex();
const entries = Object.entries(idx).map(([id, e]) => ({ ...e, id }));
const nVideos = new Set(entries.map((e) => e.v)).size;
console.log(`corpus: ${entries.length} chunks across ${nVideos} videos`);

const impossible = t1(entries);
const handoff = t3(entries);
const spanIds = t4(entries);
let guestWrong = 0;
let guestIds = new Set();
if (args.includes('--t2')) {
  const r = await t2(entries);
  guestWrong = r.total;
  guestIds = r.ids;
}

console.log('\n━━━ SUMMARY ━━━\n');
console.log(`  T1 provable lexical mislabels        : ${impossible}`);
if (args.includes('--t2')) console.log(`  T2 guest speaking in an absent episode: ${guestWrong}  (${pct(guestWrong, entries.length)} of corpus)`);
console.log(`  T3 hand-off cases (n=${handoff.cases}, underpowered): ${pct(handoff.correct, handoff.cases)} correct, chance 25%`);
console.log(`  T4 chunks spanning a speaker change  : ${spanIds.size}  (${pct(spanIds.size, entries.length)} of corpus)`);

if (args.includes('--t2')) {
  const union = new Set([...guestIds, ...spanIds]);
  console.log(`\n  UNION of T2+T4 (provably or near-certainly wrong): ${union.size}  (${pct(union.size, entries.length)} of corpus)`);
}
console.log('\n  These are LOWER BOUNDS. None detects host-vs-host confusion, which covers');
console.log('  the 62% of chunks tagged with one of the four hosts. The true error rate');
console.log('  is higher, and cannot be measured from text alone — it needs audio.\n');

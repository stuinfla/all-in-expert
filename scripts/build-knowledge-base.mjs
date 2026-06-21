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
  },
  howery: {
    name: 'Ken Howery', tier: 'guest',
    role: 'Co-founder PayPal/Founders Fund, former US Ambassador to Sweden',
    lensDescription: 'Early PayPal mafia investor turned diplomat. Bridges Silicon Valley and geopolitics.',
    expertise: ['venture capital', 'diplomacy', 'PayPal mafia network', 'foreign policy', 'government'],
    biases: ['pro-innovation', 'Silicon Valley network', 'internationalist'],
    debateStyle: 'Measured, draws on both private-sector and government experience.'
  },
  doerr: {
    name: 'John Doerr', tier: 'guest',
    role: 'Chairman, Kleiner Perkins',
    lensDescription: 'Legendary VC who backed Google and Amazon early. Climate-tech advocate, OKR evangelist.',
    expertise: ['venture capital', 'climate tech', 'OKRs', 'Google/Amazon history', 'clean energy'],
    biases: ['pro-climate', 'long-term optimist', 'Silicon Valley establishment'],
    debateStyle: 'Principled, mission-driven, references specific portfolio outcomes and climate data.'
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

// ─── Per-turn chunking constants ─────────────────────────────────────────────
// Maximum words per turn-chunk before we force a split within the same speaker.
const MAX_TURN_WORDS = 200;

// Build a lookup structure: [{ speakerKey, regexes }] sorted longest alias first
// so "jason calacanis" matches before "jason".
const SPEAKER_ALIAS_LIST = Object.entries(SPEAKER_PROFILES).map(([key, profile]) => {
  // SPEAKER_PROFILES uses `expertise` array, not `aliases`. The alias list is in
  // process-captions.mjs's SPEAKERS dict. We replicate the relevant aliases here
  // so this file stays self-contained and consistent.
  const ALIASES = {
    chamath:   ['chamath palihapitiya', 'chamath', 'palihapitiya'],
    sacks:     ['david sacks', 'the rain man', 'sacky', 'sacks'],
    friedberg: ['david friedberg', 'the sultan of science', 'science corner', 'freeberg', 'friedberg'],
    calacanis: ['jason calacanis', 'j-cal', 'jcal', 'jason', 'calacanis'],
    gerstner:  ['brad gerstner', 'gerstner'],
    gurley:    ['bill gurley', 'gurley'],
    baker:     ['gavin baker', 'gavin'],
    thiel:     ['peter thiel', 'thiel'],
    ackman:    ['bill ackman', 'ackman'],
    gracias:   ['antonio gracias', 'gracias'],
    rabois:    ['keith rabois', 'rabois'],
    lonsdale:  ['joe lonsdale', 'lonsdale'],
    naval:     ['naval ravikant', 'naval', 'ravikant'],
    elon:      ['elon musk', 'musk', 'elon'],
    tucker:    ['tucker carlson', 'tucker'],
    kalanick:  ['travis kalanick', 'kalanick', 'travis'],
    cuban:     ['mark cuban', 'cuban'],
    shapiro:   ['ben shapiro', 'shapiro'],
    saagar:    ['saagar enjeti', 'saagar', 'enjeti'],
    howery:    ['ken howery', 'howery'],
    doerr:     ['john doerr', 'doerr'],
  };
  const aliases = (ALIASES[key] || []).slice().sort((a, b) => b.length - a.length);
  const regexes = aliases.map(a => new RegExp('\\b' + a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'));
  return { key, regexes };
});

/**
 * Detect whether an alias match at `pos` in `text` is being used as a vocative
 * (the speaker is ADDRESSING this person, not speaking AS them). Vocatives are
 * the dominant failure mode of first-mention attribution: when Jason says
 * "Chamath, what do you think?", the old heuristic attributed that turn to
 * Chamath because his name appeared first. This filter strips those signals.
 *
 * Patterns flagged as vocative:
 *   • "<Name>," / "<Name>?" / "<Name>!" / "<Name>:" — comma/question/exclaim/colon right after
 *   • ", <Name>" / "? <Name>" / "! <Name>" — preceded by sentence boundary punctuation
 *   • "<Name>" at start of segment followed by punctuation within ~6 chars
 */
function isVocativeMatch(lower, pos, aliasLen) {
  const after = lower.slice(pos + aliasLen, pos + aliasLen + 4);
  if (/^\s*[,?!:]/.test(after)) return true;
  const before = lower.slice(Math.max(0, pos - 6), pos);
  if (/[,?!:]\s*$/.test(before)) return true;
  // "hey/yo/look <Name>" addressing patterns
  if (/\b(hey|yo|look|listen|ok|okay|so|alright|tell us|tell me|ask|tell)\s*$/.test(before)) return true;
  return false;
}

/**
 * Detect the primary speaker in a text segment by counting NON-VOCATIVE alias
 * mentions per speaker. The speaker with the most non-vocative hits wins; ties
 * resolve to the earliest non-vocative match. Pure-vocative segments (only
 * addresses, no self-references) return 'unknown' so the secondary attribution
 * pass can recover via neighbour anchors.
 *
 * Replaces a prior "first-alias-mention" heuristic that mis-attributed any
 * "Chamath, what do you think?" address to Chamath (the addressee, not speaker).
 */
function detectPrimarySpeaker(text) {
  const lower = text.toLowerCase();
  const counts = {};
  let firstNonVocativeKey = null;
  let firstNonVocativePos = Infinity;

  for (const { key, regexes } of SPEAKER_ALIAS_LIST) {
    for (const re of regexes) {
      const global = new RegExp(re.source, 'gi');
      let m;
      while ((m = global.exec(lower)) !== null) {
        if (isVocativeMatch(lower, m.index, m[0].length)) continue;
        counts[key] = (counts[key] || 0) + 1;
        if (m.index < firstNonVocativePos) {
          firstNonVocativePos = m.index;
          firstNonVocativeKey = key;
        }
      }
    }
  }

  let bestKey = null;
  let bestCount = 0;
  for (const [k, c] of Object.entries(counts)) {
    if (c > bestCount) {
      bestCount = c;
      bestKey = k;
    }
  }
  return bestKey || firstNonVocativeKey || 'unknown';
}

/**
 * Build per-turn chunks from a transcript's raw segments (30-second units from
 * process-captions.mjs). A "turn" is a consecutive run of segments whose text
 * first introduces a speaker alias and continues until a DIFFERENT speaker alias
 * appears. Turns are capped at MAX_TURN_WORDS; longer monologues are split into
 * sub-turns that all share the same speakerKey.
 *
 * This produces single-speaker (or 'unknown') chunks without audio diarization.
 */
function buildTurnChunks(transcript) {
  const segments = transcript.chunks || []; // 30-second units
  const videoId = transcript.videoId;
  const turnChunks = [];

  // Walk segments, tracking current turn state
  let currentSpeaker = 'unknown';
  let currentText = '';
  let currentStartMs = 0;
  let currentEndMs = 0;
  let currentTopicSet = new Set();
  let turnIndex = 0;

  // Sentence-boundary look-ahead cap (Issue A fix).
  // After reaching MAX_TURN_WORDS, scan forward up to this many extra words
  // to find a sentence terminator (.!?) followed by a capital letter, then
  // close the chunk there. Prevents mid-sentence truncation.
  const SENTENCE_LOOKAHEAD = 60;

  /**
   * Find a sentence-boundary split point in `words` starting at `base`.
   * Scans forward up to SENTENCE_LOOKAHEAD words past `base` looking for a
   * word ending in '.', '!', or '?' (sentence terminator). If the NEXT word
   * starts with a capital letter (or the terminator is the last word), closes
   * the chunk at that position. Falls back to `base` if no boundary is found.
   */
  function findSentenceBoundary(words, base) {
    const maxLook = Math.min(words.length, base + SENTENCE_LOOKAHEAD);
    for (let i = base; i < maxLook; i++) {
      const w = words[i];
      if (/[.!?]['"]?$/.test(w)) {
        // Accept if this is the last word OR the next word starts with a capital
        const nextWord = words[i + 1];
        if (!nextWord || /^[A-Z"']/.test(nextWord)) {
          return i + 1; // split after this word (exclusive)
        }
      }
    }
    return base; // no boundary found — fall back to hard cut
  }

  function flushTurn(endMs) {
    if (!currentText.trim()) return;
    const words = currentText.trim().split(/\s+/);
    const topics = [...currentTopicSet];
    // If the turn exceeds MAX_TURN_WORDS, split it into sub-chunks
    // respecting sentence boundaries (Issue A fix).
    let wordOffset = 0;
    const spanMs = endMs - currentStartMs;
    while (wordOffset < words.length) {
      // Find a sentence boundary at or after MAX_TURN_WORDS from offset
      const hardCut = Math.min(wordOffset + MAX_TURN_WORDS, words.length);
      const splitAt = hardCut < words.length
        ? findSentenceBoundary(words, hardCut)
        : words.length;

      const slice = words.slice(wordOffset, splitAt);
      const sliceText = slice.join(' ');
      const sliceStartMs = currentStartMs + Math.round(spanMs * (wordOffset / words.length));
      const sliceEndMs   = currentStartMs + Math.round(spanMs * (splitAt / words.length));

      turnChunks.push({
        id: `${videoId}_turn_${turnIndex}`,
        videoId,
        chunkIndex: turnIndex,
        text: sliceText,
        startTime: formatTime(sliceStartMs),
        endTime: formatTime(sliceEndMs),
        startMs: sliceStartMs,
        endMs: sliceEndMs,
        topics,
        speakersMentioned: currentSpeaker === 'unknown' ? [] : [currentSpeaker],
        speakerKey: currentSpeaker,
        wordCount: slice.length,
      });
      turnIndex++;
      wordOffset = splitAt;
    }
  }

  for (const seg of segments) {
    const segSpeaker = detectPrimarySpeaker(seg.text);

    if (segSpeaker !== 'unknown' && segSpeaker !== currentSpeaker) {
      // Speaker boundary detected — flush current turn, start new one
      flushTurn(seg.startMs);
      currentSpeaker = segSpeaker;
      currentText = seg.text;
      currentStartMs = seg.startMs;
      currentEndMs = seg.endMs;
      currentTopicSet = new Set(seg.topics || []);
    } else {
      // Continue current turn
      if (currentText === '') {
        currentStartMs = seg.startMs;
        if (segSpeaker !== 'unknown') currentSpeaker = segSpeaker;
      }
      currentText += (currentText ? ' ' : '') + seg.text;
      currentEndMs = seg.endMs;
      for (const t of (seg.topics || [])) currentTopicSet.add(t);
    }
  }

  // Flush final turn
  flushTurn(currentEndMs);

  return turnChunks;
}

/**
 * Format milliseconds as HH:MM:SS (local copy; process-captions.mjs has its own).
 */
function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Secondary speaker-attribution pass.
 *
 * Relaxed fan-out heuristic (iter-4b):
 *
 * For each 'unknown' chunk at position i in an episode:
 *   - BEFORE anchor: nearest known-speaker chunk within ±3 turns (look back)
 *     AND within 60 seconds before c.startMs.
 *   - AFTER anchor: nearest known-speaker chunk within ±3 turns (look forward)
 *     AND within 30 seconds after c.startMs.
 *
 * Tier 1 — "medium" (both anchors, same speaker):
 *   Both before AND after anchor exist AND share the same speakerKey.
 *   → tag `likely_<speaker>`, sk_confidence='medium'.
 *
 * Tier 2 — "low-medium" (single anchor, tight window, no intervening speaker):
 *   Only ONE anchor exists within ±2 turns AND ±20 seconds, AND no other
 *   attributed chunk sits between that anchor and c.
 *   → tag `likely_<speaker>`, sk_confidence='low-medium'.
 *
 * Cap: a chunk in the middle of a long unknown run (>= 2 unknown chunks on
 * both sides within the walk window) stays unknown — propagation cap prevents
 * a stale anchor 30 s away from polluting a run.
 *
 * Mutates `chunks` in place.
 * Returns { medium, lowMedium } upgrade counts.
 */
function applySecondaryAttribution(chunks) {
  let mediumCount = 0;
  let lowMediumCount = 0;

  // Pre-compute per-chunk turn index within episode for O(1) distance checks.
  // We rely on the chunk order already being episode-contiguous (guaranteed by
  // buildTurnChunks which iterates one transcript at a time).
  const episodeTurnIdx = new Map(); // chunk index → turn index within episode
  let eTurn = 0;
  let lastVid = null;
  for (let i = 0; i < chunks.length; i++) {
    if (chunks[i].videoId !== lastVid) { eTurn = 0; lastVid = chunks[i].videoId; }
    episodeTurnIdx.set(i, eTurn++);
  }

  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c.speakerKey && c.speakerKey !== 'unknown') {
      c.sk_confidence = 'high';
      continue;
    }

    const cStart = c.startMs || 0;

    // ── BEFORE anchor: look back up to 3 turns, ≤ 60 s before ──────────────
    let before = null;
    let beforeIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (chunks[j].videoId !== c.videoId) break;
      const turnDist = (episodeTurnIdx.get(i) - episodeTurnIdx.get(j));
      if (turnDist > 3) break;
      const timeDist = cStart - (chunks[j].startMs || 0);
      if (timeDist > 60_000) break;
      const sk = chunks[j].speakerKey;
      if (sk && sk !== 'unknown' && !sk.startsWith('likely_')) {
        before = chunks[j]; beforeIdx = j;
        break;
      }
    }

    // ── AFTER anchor: look forward up to 3 turns, ≤ 30 s after ─────────────
    let after = null;
    let afterIdx = -1;
    for (let j = i + 1; j < chunks.length; j++) {
      if (chunks[j].videoId !== c.videoId) break;
      const turnDist = (episodeTurnIdx.get(j) - episodeTurnIdx.get(i));
      if (turnDist > 3) break;
      const timeDist = (chunks[j].startMs || 0) - cStart;
      if (timeDist > 30_000) break;
      const sk = chunks[j].speakerKey;
      if (sk && sk !== 'unknown' && !sk.startsWith('likely_')) {
        after = chunks[j]; afterIdx = j;
        break;
      }
    }

    // ── Tier 1: both anchors, same speaker ───────────────────────────────────
    if (before && after && before.speakerKey === after.speakerKey) {
      c.speakerKey = `likely_${before.speakerKey}`;
      c.sk_confidence = 'medium';
      mediumCount++;
      continue;
    }

    // ── Tier 2: single tight anchor (±2 turns, ±20 s), no intervening hit ───
    const tightBefore = (before &&
      (episodeTurnIdx.get(i) - episodeTurnIdx.get(beforeIdx)) <= 2 &&
      (cStart - (before.startMs || 0)) <= 20_000) ? before : null;

    const tightAfter = (after &&
      (episodeTurnIdx.get(afterIdx) - episodeTurnIdx.get(i)) <= 2 &&
      ((after.startMs || 0) - cStart) <= 20_000) ? after : null;

    const singleAnchor = tightBefore || tightAfter;
    const anchorIdx = tightBefore ? beforeIdx : afterIdx;

    if (singleAnchor) {
      // Verify no OTHER attributed speaker sits between singleAnchor and c
      const lo = Math.min(anchorIdx, i) + 1;
      const hi = Math.max(anchorIdx, i);
      let intervening = false;
      for (let k = lo; k < hi; k++) {
        const sk = chunks[k].speakerKey;
        if (sk && sk !== 'unknown' && !sk.startsWith('likely_')) { intervening = true; break; }
      }
      if (!intervening) {
        // Propagation cap: if the unknown run on BOTH sides spans ≥ 2 chunks
        // before we'd reach any known anchor beyond the tight window, skip.
        let unknownLeft = 0;
        for (let k = i - 1; k >= 0 && chunks[k].videoId === c.videoId; k--) {
          const sk = chunks[k].speakerKey;
          if (!sk || sk === 'unknown' || sk.startsWith('likely_')) unknownLeft++;
          else break;
        }
        let unknownRight = 0;
        for (let k = i + 1; k < chunks.length && chunks[k].videoId === c.videoId; k++) {
          const sk = chunks[k].speakerKey;
          if (!sk || sk === 'unknown' || sk.startsWith('likely_')) unknownRight++;
          else break;
        }
        if (unknownLeft >= 2 && unknownRight >= 2) {
          // Middle of a long unknown run — leave as unknown
          c.sk_confidence = 'low';
          continue;
        }
        c.speakerKey = `likely_${singleAnchor.speakerKey}`;
        c.sk_confidence = 'low-medium';
        lowMediumCount++;
        continue;
      }
    }

    c.sk_confidence = 'low';
  }

  return { medium: mediumCount, lowMedium: lowMediumCount };
}

/**
 * Build the knowledge entries from transcripts.
 * Uses per-turn chunking as the primary path (single-speaker chunks).
 * Falls back to longChunks (2-min windows) only if no chunks are available.
 */
function buildKnowledgeEntries(transcripts) {
  const entries = [];
  let turnTotal = 0;
  let unknownTotal = 0;
  let mediumTotal = 0;
  let lowMediumTotal = 0;

  for (const transcript of transcripts) {
    // Primary: per-turn chunks (new path)
    const turnChunks = buildTurnChunks(transcript);

    // Secondary attribution pass — only applies to turnChunks, which carry
    // a per-chunk videoId already. Long-chunk fallback skips this enrichment.
    if (turnChunks.length > 0) {
      // turnChunks built by buildTurnChunks don't carry videoId on each item;
      // attach it so the neighbor-walk respects episode boundaries.
      for (const tc of turnChunks) {
        if (!tc.videoId) tc.videoId = transcript.videoId;
      }
      const { medium, lowMedium } = applySecondaryAttribution(turnChunks);
      mediumTotal += medium;
      lowMediumTotal += lowMedium;
    }

    const chunks = turnChunks.length > 0 ? turnChunks : (transcript.longChunks || transcript.chunks);

    for (const chunk of chunks) {
      const speakerKey = chunk.speakerKey || 'unknown';
      if (turnChunks.length > 0) {
        turnTotal++;
        if (speakerKey === 'unknown') unknownTotal++;
      }
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
          speakerKey,
          sk_confidence: chunk.sk_confidence || (speakerKey === 'unknown' ? 'low' : 'high'),
          wordCount: chunk.wordCount,
          youtubeUrl: `https://youtube.com/watch?v=${transcript.videoId}&t=${Math.floor((chunk.startMs || 0) / 1000)}`
        }
      });
    }
  }

  if (turnTotal > 0) {
    const directLabeled = turnTotal - unknownTotal;
    const likelyTotal = mediumTotal + lowMediumTotal;
    const remainingUnknown = unknownTotal - likelyTotal;
    const directPct   = ((directLabeled   / turnTotal) * 100).toFixed(1);
    const mediumPct   = ((mediumTotal     / turnTotal) * 100).toFixed(1);
    const lowMedPct   = ((lowMediumTotal  / turnTotal) * 100).toFixed(1);
    const unknownPct  = ((remainingUnknown / turnTotal) * 100).toFixed(1);
    const totalPct    = (((directLabeled + likelyTotal) / turnTotal) * 100).toFixed(1);
    console.log(`  Speaker attribution breakdown (${turnTotal} turns):`);
    console.log(`    direct      : ${directLabeled} (${directPct}%)`);
    console.log(`    medium      : ${mediumTotal} (${mediumPct}%)  [both-neighbor match]`);
    console.log(`    low-medium  : ${lowMediumTotal} (${lowMedPct}%)  [single-neighbor, tight window]`);
    console.log(`    unknown     : ${remainingUnknown} (${unknownPct}%)`);
    console.log(`    total cover : ${totalPct}%`);
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

  // Write precomputed MiniLM embeddings to data/kb ONLY — these feed the RVF build
  // below. IMPORTANT: do NOT write web/public/data/embeddings.bin here. The SERVED
  // bin must be OpenAI-space (queries are OpenAI-embedded at serve time) and is owned
  // solely by scripts/build-embeddings-openai.mjs. Writing MiniLM vectors to the served
  // path would put the index in the wrong vector space and make semantic search return
  // noise — the exact bug that froze retrieval before the 2026-06-21 single-path fix.
  const embeddingsBin = new Float32Array(entries.length * DIMENSIONS);
  const idOrder = [];
  for (let i = 0; i < entries.length; i++) {
    embeddingsBin.set(vectors[i], i * DIMENSIONS);
    idOrder.push(entries[i].id);
  }
  writeFileSync(join(KB_DIR, 'embeddings.bin'), Buffer.from(embeddingsBin.buffer));
  writeFileSync(join(KB_DIR, 'embeddings-order.json'), JSON.stringify(idOrder));
  console.log(`MiniLM embeddings (kb/ only, feeds RVF): ${entries.length} × ${DIMENSIONS} Float32 = ${(embeddingsBin.byteLength / 1024 / 1024).toFixed(1)}MB`);

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
      c: entry.content,                              // text content
      v: entry.metadata.videoId,                     // video ID
      t: entry.metadata.startTime || '00:00:00',     // timestamp
      s: entry.metadata.startMs || 0,                // start ms
      p: entry.metadata.topics || [],                // topics
      m: entry.metadata.speakersMentioned || [],     // speakers mentioned
      sk: entry.metadata.speakerKey || 'unknown',    // primary speaker (per-turn)
      skc: entry.metadata.sk_confidence || 'low',    // 'high'|'medium'|'low' attribution confidence
      u: entry.metadata.youtubeUrl || ''             // youtube URL
    };
  }

  // Save content index to both KB dir and web/public/data for deployment
  const WEB_DATA_DIR = join(ROOT, 'web', 'public', 'data');
  mkdirSync(WEB_DATA_DIR, { recursive: true });

  writeFileSync(join(KB_DIR, 'content-index.json'), JSON.stringify(contentIndex));
  writeFileSync(join(WEB_DATA_DIR, 'content-index.json'), JSON.stringify(contentIndex));
  console.log(`Content index: ${Object.keys(contentIndex).length} entries (${(JSON.stringify(contentIndex).length / 1024 / 1024).toFixed(1)}MB)`);

  // Build episode-meta.json: videoId → {title, episodeNumber}
  // Joins episodes_metadata.json (title+date) with episode-dates.json (videoId+date).
  // Written to web/public/data so the API can resolve episode titles in citations.
  try {
    const EPISODES_META_PATH = join(ROOT, 'data', 'episodes', 'episodes_metadata.json');
    const EPISODE_DATES_PATH = join(WEB_DATA_DIR, 'episode-dates.json');
    if (existsSync(EPISODES_META_PATH) && existsSync(EPISODE_DATES_PATH)) {
      const metaList = JSON.parse(readFileSync(EPISODES_META_PATH, 'utf8'));
      const datesMap = JSON.parse(readFileSync(EPISODE_DATES_PATH, 'utf8'));
      // Map<date, title[]>: bonus drops or back-to-back releases can share a
      // date. The prior single-title map silently clobbered earlier titles.
      const byDate = new Map();
      for (const ep of metaList) {
        if (!ep.date || !ep.title) continue;
        const arr = byDate.get(ep.date);
        if (arr) arr.push(ep.title);
        else byDate.set(ep.date, [ep.title]);
      }
      // For multi-title dates, when more than one videoId resolves to the same
      // date we round-robin assign across the title list to avoid every video
      // colliding on a single title.
      const dateAssignmentCursor = new Map();
      const episodeMeta = {};
      let collisions = 0;
      for (const [videoId, date] of Object.entries(datesMap)) {
        const titles = byDate.get(date);
        if (!titles || titles.length === 0) continue;
        let title;
        if (titles.length === 1) {
          title = titles[0];
        } else {
          collisions++;
          const cursor = dateAssignmentCursor.get(date) || 0;
          title = titles[cursor % titles.length];
          dateAssignmentCursor.set(date, cursor + 1);
        }
        const epNumMatch = title.match(/\bE(\d{3,})\b/);
        episodeMeta[videoId] = {
          title,
          ...(epNumMatch ? { episodeNumber: parseInt(epNumMatch[1], 10) } : {})
        };
      }
      writeFileSync(join(WEB_DATA_DIR, 'episode-meta.json'), JSON.stringify(episodeMeta));
      console.log(`Episode metadata index: ${Object.keys(episodeMeta).length} entries (${collisions} duplicate-date assignments) → web/public/data/episode-meta.json`);
    }
  } catch (err) {
    console.warn(`episode-meta.json generation failed (non-fatal): ${err.message}`);
  }

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

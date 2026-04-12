import { NextRequest, NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// Content + RVF are bundled in public/data/ — ships with Vercel deployment
const DATA_DIR = join(process.cwd(), 'public', 'data');

interface ContentEntry {
  c: string;   // text content
  v: string;   // video ID
  t: string;   // timestamp
  s: number;   // start ms
  p: string[]; // topics
  m: string[]; // speakers mentioned
  u: string;   // youtube URL
}

// ─── Lazy caches ────────────────────────────────────────────────
let contentIndexCache: Record<string, ContentEntry> | null = null;
let embedderCache: any = null;
let rvfCache: any = null;
let episodeDatesCache: Record<string, string> | null = null;

async function getContentIndex(): Promise<Record<string, ContentEntry>> {
  if (contentIndexCache) return contentIndexCache;
  const indexPath = join(DATA_DIR, 'content-index.json');
  if (!existsSync(indexPath)) {
    throw new Error('Content index not found');
  }
  contentIndexCache = JSON.parse(readFileSync(indexPath, 'utf8'));
  return contentIndexCache!;
}

function getEpisodeDates(): Record<string, string> {
  if (episodeDatesCache) return episodeDatesCache;
  const datesPath = join(DATA_DIR, 'episode-dates.json');
  if (!existsSync(datesPath)) {
    episodeDatesCache = {};
    return episodeDatesCache;
  }
  episodeDatesCache = JSON.parse(readFileSync(datesPath, 'utf8'));
  return episodeDatesCache!;
}

let idfCache: Record<string, number> | null = null;
function getIdf(): Record<string, number> {
  if (idfCache) return idfCache;
  const idfPath = join(DATA_DIR, 'idf.json');
  if (!existsSync(idfPath)) {
    idfCache = {};
    return idfCache;
  }
  idfCache = JSON.parse(readFileSync(idfPath, 'utf8'));
  return idfCache!;
}

/**
 * Compute a recency weight multiplier for a given episode date.
 * Recent episodes get full weight (1.0); old episodes decay gently to a 0.4 floor.
 * Rationale: more recent episodes reflect more information the besties have
 * processed, making their most recent positions more accurate representations
 * of current views.
 */
function recencyWeight(videoId: string): number {
  const dates = getEpisodeDates();
  const dateStr = dates[videoId];
  if (!dateStr) return 0.85; // unknown date → slight penalty vs known-recent
  const episodeMs = new Date(dateStr).getTime();
  const ageDays = (Date.now() - episodeMs) / (1000 * 60 * 60 * 24);
  if (ageDays < 0) return 1.0;
  // Exponential decay with 180-day half-life, floored at 0.4
  return Math.max(0.4, 0.4 + 0.6 * Math.exp(-ageDays / 180));
}

async function getEmbedder() {
  if (embedderCache) return embedderCache;
  const { pipeline, env } = await import('@xenova/transformers');
  // Allow local-only model loading from node_modules
  (env as any).allowRemoteModels = true;
  (env as any).allowLocalModels = true;
  embedderCache = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
    quantized: true,
  });
  return embedderCache;
}

async function getRvf() {
  if (rvfCache) return rvfCache;
  try {
    const { RvfDatabase } = await import('@ruvector/rvf');
    const rvfPath = join(DATA_DIR, 'all-in-expert.rvf');
    if (!existsSync(rvfPath)) return null;
    rvfCache = await RvfDatabase.openReadonly(rvfPath);
    return rvfCache;
  } catch {
    return null;
  }
}

async function embedQuery(query: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  const output = await embedder(query, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

// Load bestie facts once per cold start — these are ground-truth overrides
let bestieFactsCache: Record<string, any> | null = null;
function getBestieFacts(): Record<string, any> {
  if (bestieFactsCache) return bestieFactsCache;
  const path = join(DATA_DIR, 'bestie-facts.json');
  if (!existsSync(path)) {
    bestieFactsCache = {};
    return bestieFactsCache;
  }
  bestieFactsCache = JSON.parse(readFileSync(path, 'utf8'));
  return bestieFactsCache!;
}

/**
 * Semantic search: embed query, search RVF (HNSW), then hydrate with content.
 * Falls back to keyword search if RVF unavailable.
 */
async function semanticSearch(query: string, limit = 30, speakerFilter?: string | null) {
  const index = await getContentIndex();
  const db = await getRvf();

  if (db) {
    try {
      const queryVec = await embedQuery(query);
      // Over-fetch so we have room to rerank by recency
      const rvfResults = await db.query(queryVec, limit * 3, { efSearch: 250 });
      const hydrated: Array<{
        id: string; entry: ContentEntry; distance: number; rawDistance: number;
      }> = [];
      for (const r of rvfResults) {
        const entry = index[r.id];
        if (!entry) continue;
        if (speakerFilter && !entry.m.includes(speakerFilter)) continue;
        const rec = recencyWeight(entry.v);
        // distance lower = better; divide by recency so recent = better
        hydrated.push({ id: r.id, entry, rawDistance: r.distance, distance: r.distance / rec });
      }
      hydrated.sort((a, b) => a.distance - b.distance);
      const top = hydrated.slice(0, limit);
      if (top.length > 0) {
        return { results: top, mode: 'semantic' as const };
      }
    } catch (err) {
      console.error('RVF search failed, falling back to keyword:', err);
    }
  }

  // ─── TF-IDF keyword search (heavy weight on rare terms) ─────
  // Tokenize query — keep everything of length 3+
  const queryTokens = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);

  // Stopwords — no signal for retrieval
  const stopWords = new Set([
    'what', 'would', 'will', 'about', 'think', 'they', 'this', 'that', 'from',
    'have', 'been', 'should', 'could', 'does', 'with', 'going', 'their', 'then',
    'than', 'them', 'when', 'where', 'there', 'these', 'those', 'here', 'into',
    'just', 'like', 'over', 'some', 'such', 'take', 'very', 'much', 'each',
    'make', 'most', 'said', 'says', 'back', 'been', 'were', 'was', 'are',
    'you', 'the', 'and', 'for', 'but', 'not', 'has', 'had', 'who', 'why',
    'how', 'all', 'any', 'can', 'did', 'get', 'got', 'her', 'him', 'his',
    'its', 'let', 'out', 'see', 'she', 'too', 'two', 'use', 'way',
    'bestie', 'besties', 'show',
  ]);

  // Use IDF lookup to weight terms. Terms not in IDF get a moderate default.
  const idf = getIdf();
  type QueryTerm = { term: string; weight: number; primary: boolean };
  const queryTerms: QueryTerm[] = [];
  const seenTerms = new Set<string>();

  for (const tok of queryTokens) {
    if (seenTerms.has(tok)) continue;
    seenTerms.add(tok);
    if (stopWords.has(tok)) continue;
    const termIdf = idf[tok] ?? 5.5; // unknown terms assumed rare
    // Primary term = IDF > 2.5 (appears in < ~8% of docs)
    queryTerms.push({ term: tok, weight: termIdf, primary: termIdf > 2.5 });
  }

  const primaryTerms = queryTerms.filter((t) => t.primary);
  const maxTheoreticalScore = queryTerms.reduce((s, t) => s + t.weight * 3, 0) || 1;

  // Score every document
  const scored: Array<{ id: string; entry: ContentEntry; distance: number; rawDistance: number }> = [];
  for (const [id, entry] of Object.entries(index)) {
    if (speakerFilter && !entry.m.includes(speakerFilter)) continue;

    const content = entry.c.toLowerCase();

    // Require at least one primary term to appear (huge quality boost)
    if (primaryTerms.length > 0) {
      const hasPrimary = primaryTerms.some((pt) => content.includes(pt.term));
      if (!hasPrimary) continue;
    }

    let score = 0;
    let matchedPrimary = 0;
    for (const qt of queryTerms) {
      // Count occurrences without regex overhead
      let count = 0;
      let idx_ = content.indexOf(qt.term);
      while (idx_ !== -1) {
        // Word-boundary check to avoid partial matches (manual, no regex)
        const before = idx_ === 0 ? ' ' : content[idx_ - 1];
        const after = content[idx_ + qt.term.length] || ' ';
        if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
          count++;
        }
        idx_ = content.indexOf(qt.term, idx_ + qt.term.length);
      }
      if (count > 0) {
        // TF-IDF: saturating TF * IDF weight
        const tf = 1 + Math.log(count); // log saturation
        score += tf * qt.weight;
        if (qt.primary) matchedPrimary++;
      }
    }

    // Bonus for matching multiple primary terms (all terms present = best match)
    if (primaryTerms.length > 1) {
      const coverage = matchedPrimary / primaryTerms.length;
      score *= 1 + coverage * 0.5;
    }

    if (score > 0) {
      // Normalize and convert to distance (lower = better)
      const normalized = Math.min(1, score / (maxTheoreticalScore * 0.5));
      const rawDistance = 1 - normalized;
      const rec = recencyWeight(entry.v);
      scored.push({ id, entry, rawDistance, distance: rawDistance / rec });
    }
  }

  scored.sort((a, b) => a.distance - b.distance);
  return { results: scored.slice(0, limit), mode: 'tfidf' as const };
}

// ─── Bestie profiles ─────────────────────────────────────────────

const SPEAKER_CONTEXT: Record<string, { name: string; short: string; lens: string; style: string; tier: 'core' | 'guest' }> = {
  chamath: {
    name: 'Chamath Palihapitiya', short: 'Chamath', tier: 'core',
    lens: 'Venture capitalist (Social Capital). Capital allocation, market efficiency, systemic risk. Contrarian macro views.',
    style: 'Bold, contrarian, numbers-heavy. Takes unpopular positions backed by data.',
  },
  sacks: {
    name: 'David Sacks', short: 'Sacks', tier: 'core',
    lens: 'Enterprise SaaS investor (Craft Ventures), former PayPal COO. Jan 2025+: White House AI & Crypto Czar.',
    style: 'Analytical, measured, builds logical arguments. Frames issues as systems problems.',
  },
  friedberg: {
    name: 'David Friedberg', short: 'Friedberg', tier: 'core',
    lens: 'The Production Board CEO. Science first-principles. Called "Sultan of Science." Often "Freeberg" in transcripts.',
    style: 'Methodical, science-first. Reframes political debates as scientific/economic questions.',
  },
  calacanis: {
    name: 'Jason Calacanis', short: 'Jason', tier: 'core',
    lens: 'Angel investor, LAUNCH CEO, podcast host/moderator. Startup ecosystem insider.',
    style: "Provocative, asks uncomfortable questions, plays devil's advocate.",
  },
  gerstner: { name: 'Brad Gerstner', short: 'Gerstner', tier: 'guest', lens: 'Altimeter Capital. Long-term tech growth. Category-defining franchises.', style: 'Measured, analytical, references specific companies and metrics.' },
  gurley: { name: 'Bill Gurley', short: 'Gurley', tier: 'guest', lens: 'Benchmark GP. Late-stage VC and market structure. Skeptical of regulatory capture.', style: 'Pointed, historical, references market failures and missteps.' },
  baker: { name: 'Gavin Baker', short: 'Baker', tier: 'guest', lens: 'Atreides Management CIO. AI compute economics and semiconductor cycles.', style: 'Highly technical, brings granular data on compute and capex.' },
  thiel: { name: 'Peter Thiel', short: 'Thiel', tier: 'guest', lens: 'Founders Fund, Palantir co-founder. Contrarian philosophy, monopoly theory.', style: 'Philosophical, challenges frames rather than facts.' },
  ackman: { name: 'Bill Ackman', short: 'Ackman', tier: 'guest', lens: 'Pershing Square. Activist public-markets investor. Sharp macro views.', style: 'Direct, combative, names individuals and institutions.' },
  gracias: { name: 'Antonio Gracias', short: 'Gracias', tier: 'guest', lens: 'Valor Equity. Operational VC, deep Elon/Tesla network. Led DOGE investigations.', style: 'Quietly confident, brings operational receipts.' },
  elon: { name: 'Elon Musk', short: 'Elon', tier: 'guest', lens: 'Tesla/SpaceX/xAI. First-principles engineer-entrepreneur.', style: 'Direct, engineering-focused, brings concrete physics to abstract debates.' },
  naval: { name: 'Naval Ravikant', short: 'Naval', tier: 'guest', lens: 'AngelList co-founder. Philosopher-investor on wealth and leverage.', style: 'Concise aphorisms, deep frameworks.' },
  tucker: { name: 'Tucker Carlson', short: 'Tucker', tier: 'guest', lens: 'Populist conservative media. Skeptical of institutions and interventionism.', style: 'Rhetorical, interview format.' },
  rabois: { name: 'Keith Rabois', short: 'Rabois', tier: 'guest', lens: 'Khosla Ventures. Contrarian startup investor.', style: 'Provocative, takes extreme positions.' },
  lonsdale: { name: 'Joe Lonsdale', short: 'Lonsdale', tier: 'guest', lens: 'Palantir co-founder, 8VC. Defense tech and policy reform.', style: 'Action-oriented, concrete solutions.' },
  cuban: { name: 'Mark Cuban', short: 'Cuban', tier: 'guest', lens: 'Serial entrepreneur. Direct-to-consumer, healthcare cost reform.', style: 'Direct, data-driven on specific industries.' },
  kalanick: { name: 'Travis Kalanick', short: 'Kalanick', tier: 'guest', lens: 'Uber founder, CloudKitchens CEO. Physical-world disruption.', style: 'Aggressive, operator-focused.' },
  shapiro: { name: 'Ben Shapiro', short: 'Shapiro', tier: 'guest', lens: 'Daily Wire. Conservative commentary.', style: 'Rapid, fact-heavy, confrontational.' },
  saagar: { name: 'Saagar Enjeti', short: 'Saagar', tier: 'guest', lens: 'Breaking Points. Populist political journalism.', style: 'Journalistic, historical context.' },
};

function sec(ms: number) {
  return Math.max(0, Math.floor(ms / 1000));
}

export async function POST(req: NextRequest) {
  try {
    const { query, speaker, mode } = await req.json();

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
    }

    // Semantic search with optional speaker filter
    const { results, mode: searchMode } = await semanticSearch(
      query,
      30,
      speaker || null
    );

    if (results.length === 0) {
      return NextResponse.json({
        report: 'No relevant segments found in the archive for this query. Try rephrasing or asking about a different topic.',
        segmentsFound: 0,
        totalEntries: Object.keys(await getContentIndex()).length,
        searchMode,
      });
    }

    // Build citation-enriched segment text for the LLM
    // Include episode date so Claude can apply the recency rule
    const epDates = getEpisodeDates();
    const segmentText = results
      .slice(0, 15)
      .map((r, i) => {
        const topics = r.entry.p.join(', ');
        const speakers = r.entry.m.length > 0 ? ` · voices: ${r.entry.m.join(', ')}` : '';
        const epDate = epDates[r.entry.v] || 'date-unknown';
        return `[${i + 1}] episode-date: ${epDate} · timestamp: ${r.entry.t} · topics: ${topics}${speakers}\nSEGMENT: "${r.entry.c.slice(0, 600)}"`;
      })
      .join('\n\n');

    // Structured citations for the response (frontend renders these separately)
    const citations = results.slice(0, 10).map((r, i) => ({
      n: i + 1,
      time: r.entry.t,
      date: epDates[r.entry.v] || null,
      videoId: r.entry.v,
      url: r.entry.u,
      topics: r.entry.p,
      speakers: r.entry.m,
      quote: r.entry.c.slice(0, 400),
      relevance: Number((1 - r.distance).toFixed(3)),
    }));

    // Load ground-truth facts about each bestie — OVERRIDES anything fuzzy from retrieval
    const bestieFacts = getBestieFacts();
    const factsText = Object.entries(bestieFacts)
      .map(([, f]: [string, any]) => {
        const positions = (f.current_positions || []).map((p: string) => `  - ${p}`).join('\n');
        return `• **${f.name}** — ${f.role}\n  Political: ${f.political_alignment}\n  Current positions:\n${positions}\n  Voice: ${f.style}`;
      })
      .join('\n\n');

    const speakerProfileText = Object.entries(SPEAKER_CONTEXT)
      .map(([, s]) => `• ${s.name} (${s.short}, ${s.tier}) — ${s.lens} | Style: ${s.style}`)
      .join('\n');

    const focus = speaker ? SPEAKER_CONTEXT[speaker] : null;
    const isForecast = mode === 'forecast';

    const systemPrompt = `You are writing in the voices of the All-In Podcast hosts. You have read hundreds of hours of their actual transcripts and know exactly how each one speaks, argues, and thinks.

YOU ARE NOT WRITING ANALYSIS. You are writing a synthesized round-table discussion — as if the four besties were together right now, debating the user's question. The output should read like a fresh All-In segment, not like an academic report about them.

═══ GROUND-TRUTH FACTS (AUTHORITATIVE, OVERRIDE RETRIEVAL) ═══

These are verified facts about the besties. If the retrieved transcript segments are ambiguous or contradictory on any of these points, THESE FACTS WIN. Never describe a bestie's political alignment, current role, or basic biography in a way that contradicts this section. The transcripts are the source for WHAT they've said on topics, but these facts are the source for WHO THEY ARE.

${factsText}

IMPORTANT: If the user asks "is X a Democrat or Republican?" or "what party does X support?" or "who did X vote for?", answer from the GROUND-TRUTH FACTS above, not from retrieval. Never hedge on verifiable facts.

═══ THE VOICES ═══

**JASON (Jason Calacanis)** — The host. He sets up topics, interrupts, hypes, and steers. Warm, theatrical, occasionally needs to be reined in. He asks the uncomfortable question and then says "this is wild" or "banger" when the answer surprises him. Signature beats: intro hype, "let's move on to the next topic", "best episode ever", earnest questions about founders. He's the one pulling the thread, not the one making the deepest point.

**CHAMATH (Chamath Palihapitiya)** — The contrarian with numbers. Blunt, confident, willing to be unpopular. Opens with "Look," or "Honestly," or "The reality is" and then drops a specific statistic or historical analogy. Big on capital allocation, power laws, 80-year cycles, Ray Dalio frameworks. Dismissive of consensus, allergic to vibes-based arguments. Will say "That's wrong" directly. Reaches for the macro frame even on micro questions.

**SACKS (David Sacks)** — The systems lawyer. Measured, methodical, builds an argument brick by brick. Frames things as "the question is really X" or "let me give you the framework here." Enterprise SaaS pattern-matcher. As of January 2025 he's White House AI & Crypto Czar, so post-2025 he speaks from inside the administration on anything policy-adjacent. Historical parallels are his thing. Rarely raises his voice; rarely backs down.

**FRIEDBERG (David Friedberg)** — The scientist who steps back. Always reframes political or business questions into economic / biological / physical first principles. Calmer than the others, longer time horizons, the one who says "actually, let's pull back — what does the biology/math/physics tell us?" Loves Science Corner. Skeptical of narratives without data. Sometimes lumped with Chamath on macro but he's the one who brings the hard-science lens.

═══ HOW TO WRITE THE OUTPUT ═══

The output is a ROUND TABLE DIALOGUE. Format it like a transcript:

**JASON:** [opens the topic — 1-2 sentences, often with a question or a hype line]

**CHAMATH:** [pushes back with data or a contrarian frame — 2-3 sentences, specific numbers when the segments have them]

**SACKS:** [provides the system-level framework — 2-3 sentences, often reframing the question]

**FRIEDBERG:** [pulls back to first principles or the underlying science/economics — 2-3 sentences]

(You can add additional turns — Jason responding, Chamath interrupting, Sacks pushing back — up to ~8-10 turns total.)

RULES FOR THE DIALOGUE:
1. Each turn is SHORT (1-3 sentences). This is conversation, not essay.
2. Use the ACTUAL segment content as the backbone — when a segment contains a direct quote from one of them, WORK IT INTO their turn using their voice. Prefix with citation markers in brackets like [3] at the end of the sentence that uses that segment.
3. Sound like them. Chamath's bluntness, Sacks' methodical framing, Friedberg's "let me step back," Jason's moderator energy. Mimic cadence, not just content.
4. Include disagreement. Real All-In segments have pushback — "that's not right, Chamath" or "yeah, but Sacks, the issue is…". Bring that tension in.
5. If a guest bestie (Gerstner, Baker, Gurley, Elon, etc.) is clearly referenced in the segments, include them as a turn: **GERSTNER:** ...
6. After the dialogue, add TWO short sections:
   - **## Where they land** — 2-3 bullet points of genuine consensus
   - **## Where they split** — 2-3 bullet points of real disagreement
7. End with a one-line **Confidence:** HIGH/MEDIUM/LOW note based on how much direct evidence was in the segments.

═══ EVIDENCE HANDLING ═══

The transcript segments are the ONLY source of truth. They come from 448 real episodes spanning April 2024 to present. **Each segment has a relevance score and, implicitly, a recency ranking** — more recent episodes have been up-ranked by the retrieval layer.

**RECENCY IS AUTHORITATIVE.** If two segments contradict each other — say, one from 2024 where a bestie held position A, and one from a 2026 episode where the same bestie now holds position B — **the newer view is what they actually think now**. People update on new information. The older view is historical context, not their current position. Write the dialogue using their CURRENT view (the most recent segment), and only mention the older position if the shift itself is interesting.

**QUOTING (IP-SAFE):**
- Prefer PARAPHRASE in their voice over long verbatim reproduction. A 30-word monologue in Chamath's cadence that captures his actual point is better than a 100-word transcript copy-paste.
- SHORT direct quotes (a memorable phrase or a single sentence) are fine — set them off with double quotes, e.g. Chamath says "look, the reality is this is a trillion-five market cap" [3].
- Do NOT reproduce any segment wholesale. Use its meaning and voice, not its literal sentences.
- Always attach [N] citation markers where the segment supports the claim.

**SEGMENT GAPS:** If the segments don't actually touch the user's topic, say so in voice ("I haven't dug into X yet, but on adjacent Y I've said…"). Don't fabricate.

**VOICE, NOT ANALYSIS:** Do NOT write "Chamath would likely say" or "Sacks would probably frame it as." Have them SAY it, in first person, as dialogue. You're writing a conversation, not a report.

═══ THE BESTIES & LENSES ═══
${speakerProfileText}`;

    let userPrompt: string;

    if (focus) {
      // Single-bestie deep dive — voice-matched monologue, not dialogue
      userPrompt = `QUESTION: "${query}"

Write in ${focus.name}'s voice — as if ${focus.short} is answering this question right now, pulling from what he's actually said on All-In.

Here are the retrieved transcript segments (ranked by relevance):

${segmentText}

Write a 4-6 paragraph response as ${focus.short} would say it. Use his cadence, his signature phrases, his framing style. Work his actual quotes from the segments into the response naturally — when a segment contains a direct quote from him, use it verbatim or near-verbatim and add [N] at the end of that sentence.

Do not write "Here is what ${focus.short} would say" or analyze him in the third person. Just write AS him, in first person, as a monologue. Imagine the user just asked him this on the show.

After the monologue, add:
- **## Where this sits in his thinking** (1 short paragraph connecting this take to his broader framework)
- **Confidence: HIGH/MEDIUM/LOW** (one line)`;
    } else if (isForecast) {
      // Forecast roundtable — same dialogue style but explicitly predictive
      userPrompt = `FORECASTING QUESTION: "${query}"

Produce a round-table discussion (as specified in your system prompt) where the besties debate and arrive at a prediction. Pull directly from the retrieved segments — when they contain relevant data, work those numbers into the dialogue.

Here are the retrieved transcript segments:

${segmentText}

Format:
1. **JASON:** opens with the forecasting question
2. **CHAMATH, SACKS, FRIEDBERG:** each take a turn with their prediction + reasoning, using segment evidence marked with [N]
3. Additional back-and-forth turns — let them disagree, let them build on each other
4. **## The consensus forecast** — 2-3 bullet prediction statements the group roughly agrees on
5. **## The dissent** — where one or two of them are out of step
6. **Confidence:** HIGH/MEDIUM/LOW based on segment evidence`;
    } else {
      // DEFAULT: voice-matched round-table dialogue
      userPrompt = `QUESTION: "${query}"

Produce a round-table discussion in the voices of the four besties (as specified in your system prompt). The output should read like a transcript of a fresh All-In segment about this exact question.

Here are the retrieved transcript segments (your only source of truth — use their actual words when possible):

${segmentText}

Format:
1. **JASON:** opens the topic (1-2 sentences)
2. **CHAMATH, SACKS, FRIEDBERG:** each take a turn, using actual segment content in their voice, with [N] citation markers
3. Additional back-and-forth — interruptions, agreements, pushback — until the topic is substantially covered (aim for 6-10 turns total)
4. **## Where they land** — 2-3 bullets of consensus
5. **## Where they split** — 2-3 bullets of disagreement
6. **Confidence:** HIGH/MEDIUM/LOW

Remember: SHORT turns (1-3 sentences), direct quotes where available, their actual cadence and signature phrases. This should feel like eavesdropping on a real conversation, not reading a report.`;
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    return NextResponse.json({
      report: text,
      citations,
      segmentsFound: results.length,
      totalEntries: Object.keys(await getContentIndex()).length,
      searchMode,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('API error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

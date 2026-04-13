import { NextRequest, NextResponse } from 'next/server';
import { after } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { cacheLookupMem, cacheLookupPiBrain, cacheStore, CachedResponse } from '@/lib/pi-brain';

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
let embeddingsBinCache: Float32Array | null = null;
let embeddingsOrderCache: string[] | null = null;
const EMBEDDING_DIMS = 384;

function getEmbeddingsBin(): { bin: Float32Array; order: string[] } | null {
  if (embeddingsBinCache && embeddingsOrderCache) {
    return { bin: embeddingsBinCache, order: embeddingsOrderCache };
  }
  try {
    const binPath = join(DATA_DIR, 'embeddings.bin');
    const orderPath = join(DATA_DIR, 'embeddings-order.json');
    if (!existsSync(binPath) || !existsSync(orderPath)) return null;
    const buf = readFileSync(binPath);
    // View the buffer as Float32Array
    embeddingsBinCache = new Float32Array(
      buf.buffer,
      buf.byteOffset,
      buf.byteLength / 4
    );
    embeddingsOrderCache = JSON.parse(readFileSync(orderPath, 'utf8'));
    return { bin: embeddingsBinCache, order: embeddingsOrderCache! };
  } catch (err) {
    console.error('Embeddings binary load failed:', err);
    return null;
  }
}

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
  try {
    console.log('[getEmbedder] loading @xenova/transformers...');
    const { pipeline, env } = await import('@xenova/transformers');
    (env as any).allowRemoteModels = true;
    (env as any).allowLocalModels = true;
    // Use /tmp for model cache on Vercel (only writable path)
    (env as any).cacheDir = '/tmp/xenova-cache';
    console.log('[getEmbedder] calling pipeline()...');
    embedderCache = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      quantized: true,
    });
    console.log('[getEmbedder] pipeline ready');
    return embedderCache;
  } catch (err) {
    console.error('[getEmbedder] failed to load:', err);
    throw err;
  }
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

/**
 * Embed the query using OpenAI text-embedding-3-small @ 384 dims.
 * This matches the embedding space of the precomputed doc vectors in embeddings.bin.
 * Cost per query: ~$0.00002. Latency: ~50-100ms.
 */
async function embedQuery(query: string): Promise<Float32Array> {
  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) {
    throw new Error('OPENAI_API_KEY not configured — required for semantic search');
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openaiKey}`,
    },
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: query,
      dimensions: 384,
      encoding_format: 'float',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenAI embeddings API error: ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  const vec = new Float32Array(data.data[0].embedding);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
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
 * Semantic search via precomputed embeddings binary + pure-JS cosine.
 * This is the primary search path — RVF native module doesn't boot in
 * Vercel serverless, so we ship vectors as Float32 blobs and do the
 * similarity math in plain JS. ~30ms for 15k vectors.
 */
async function semanticSearchBin(query: string, limit: number, speakerFilter?: string | null) {
  const index = await getContentIndex();
  const embeddings = getEmbeddingsBin();
  if (!embeddings) {
    console.log('[semanticSearchBin] embeddings binary not available');
    return null;
  }
  console.log(`[semanticSearchBin] loaded ${embeddings.order.length} vectors, embedding query...`);

  let queryVec: Float32Array;
  try {
    queryVec = await embedQuery(query);
    console.log(`[semanticSearchBin] query embedded, dims=${queryVec.length}`);
  } catch (err) {
    console.error('[semanticSearchBin] Query embedding failed:', err);
    return null;
  }

  const { bin, order } = embeddings;
  const N = order.length;
  // Vectors from the build script are already L2-normalized, so cosine == dot product
  const results: Array<{ id: string; entry: ContentEntry; distance: number; rawDistance: number }> = [];

  for (let i = 0; i < N; i++) {
    const offset = i * EMBEDDING_DIMS;
    let dot = 0;
    for (let j = 0; j < EMBEDDING_DIMS; j++) {
      dot += queryVec[j] * bin[offset + j];
    }
    const id = order[i];
    const entry = index[id];
    if (!entry) continue;
    if (speakerFilter && !entry.m.includes(speakerFilter)) continue;
    // Convert similarity (higher = better) to distance (lower = better), apply recency
    const rawDistance = 1 - dot;
    const rec = recencyWeight(entry.v);
    results.push({ id, entry, rawDistance, distance: rawDistance / rec });
  }

  results.sort((a, b) => a.distance - b.distance);
  return results.slice(0, limit);
}

/**
 * Semantic search: embed query, search RVF (HNSW), then hydrate with content.
 * Falls back to keyword search if RVF unavailable.
 */
async function semanticSearch(query: string, limit = 30, speakerFilter?: string | null) {
  const index = await getContentIndex();

  // Try the binary-based semantic search first (works in Vercel serverless)
  const binResults = await semanticSearchBin(query, limit, speakerFilter);
  if (binResults && binResults.length > 0) {
    return { results: binResults, mode: 'semantic' as const };
  }

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
  const reqStart = Date.now();
  try {
    const { query, speaker, mode } = await req.json();

    if (!query || typeof query !== 'string') {
      return NextResponse.json({ error: 'Query is required' }, { status: 400 });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 });
    }

    // ─── Tier 1: in-memory cache (sync, ~1ms) ──────────────────────
    const cacheKey = { query, speaker: speaker || null, mode: mode || null };
    const memHit = cacheLookupMem(cacheKey);
    if (memHit) {
      return NextResponse.json({
        ...memHit,
        cacheHit: true,
        cacheSource: 'mem',
        latencyMs: Date.now() - reqStart,
      });
    }

    // ─── Speculative parallel: pi-brain lookup || retrieval ────────
    // Run both concurrently. Pi-brain hit wins if it completes before
    // retrieval; otherwise we stick with retrieval and proceed to synthesis.
    const piBrainPromise = cacheLookupPiBrain(cacheKey).catch(() => null);
    const retrievalPromise = semanticSearch(query, 30, speaker || null);

    // Wait for either pi-brain to resolve (hit or miss) OR retrieval to finish.
    // Whichever completes first wins. On pi-brain miss (null resolve), we still
    // wait for retrieval. On retrieval finish before pi-brain, we discard
    // pi-brain and proceed.
    const raceResult = await Promise.race([
      piBrainPromise.then((v) => ({ kind: 'pi', value: v })),
      retrievalPromise.then((v) => ({ kind: 'retrieval', value: v })),
    ]);

    if (raceResult.kind === 'pi' && raceResult.value) {
      return NextResponse.json({
        ...raceResult.value,
        cacheHit: true,
        cacheSource: 'pi-brain',
        latencyMs: Date.now() - reqStart,
      });
    }

    // Either retrieval won the race, or pi-brain returned null. Ensure
    // retrieval's result is awaited (it may or may not be done yet).
    const { results, mode: searchMode } = await retrievalPromise;

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

═══ GROUND-TRUTH FACTS — ABSOLUTE OVERRIDE ═══

These are VERIFIED FACTS. They are more authoritative than anything in the retrieved transcript segments. Older transcripts may reflect positions the besties held YEARS AGO that have since changed — especially political alignment, which has realigned significantly since 2022. You MUST write the current state as described here, not a hedged "used to be X, now Y" hedge.

${factsText}

**ABSOLUTE RULES ABOUT THE FACTS:**
1. David Sacks is a REPUBLICAN. He works for Donald Trump as White House AI & Crypto Czar. He keynoted the 2024 Republican National Convention. He hosted a major Trump fundraiser. Do not call him "centrist", "moderate", "independent", "in the middle", or "a former Democrat who's now independent". He is a partisan Republican. If someone asks "is Sacks a Democrat or Republican?", the answer is REPUBLICAN — full stop — no qualification, no hedging, no "it's complicated".
2. Chamath Palihapitiya publicly endorsed Trump in 2024 and votes Republican.
3. Friedberg is libertarian-leaning but voted Trump in 2024.
4. Jason Calacanis is the most moderate, but even he has moved right on economic/cultural issues.
5. If the retrieved segments contain OLD quotes (pre-2024) where a bestie described themselves differently, those are HISTORICAL — the current state is what the FACTS say above. Write the dialogue in the present, reflecting current reality.
6. On any question about CURRENT political alignment, role, or bio fact — answer from FACTS, NOT from retrieval. The retrieval is for topical views, not biographical questions.

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

**CITATION DISCIPLINE — NON-NEGOTIABLE:**
1. EVERY substantive claim (number, position, prediction, event) MUST end with a [N] marker pointing to the segment that directly supports it. No free-floating assertions.
2. Do NOT cite a segment unless its text actually supports the specific claim. Citation [3] after a sentence means "segment 3 contains words that say this." Loose thematic connection is not enough.
3. If the retrieved segments don't cover a point, DON'T MAKE THE POINT. Say "I haven't dug into that specifically" in voice, or steer the dialogue to what the segments DO cover.
4. Never fabricate statistics, dates, people, or events. If a number isn't in the segments, don't invent one.
5. When multiple segments support a claim, cite the most recent: [4, 7] is fine; prefer the newer one first.

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

Write a 4-6 paragraph response as ${focus.short} would say it. Use his cadence, his signature phrases, his framing style.

**CITATION DISCIPLINE — SAME RULES AS DIALOGUE MODE, NO EXCEPTIONS:**
- EVERY substantive claim (number, prediction, named event, concrete position) MUST end with a [N] marker pointing to the specific segment that supports it.
- The segments are the ONLY permitted source of substance. If the segments don't cover the question, DON'T fabricate — say "I haven't dug into that specifically on the show" in his voice and pivot to what the segments DO contain about adjacent topics.
- Do NOT invent statistics, dates, names, or quotes. If it isn't in a segment, it doesn't exist.
- Short direct quotes from his segments are fine (double-quote them + [N]). Prefer paraphrase in his cadence for longer ideas.
- Minimum: each paragraph must cite at least one segment. A paragraph with zero [N] markers is a bug.

Do not write "Here is what ${focus.short} would say" or analyze him in the third person. Just write AS him, in first person, as a monologue. Imagine the user just asked him this on the show.

After the monologue, add:
- **## Where this sits in his thinking** (1 short paragraph connecting this take to his broader framework — cite segments where possible)
- **Confidence: HIGH/MEDIUM/LOW** (one line — LOW if the segments barely touched the question)`;
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
      // DEFAULT: classify first, then either factual answer OR round-table
      userPrompt = `QUESTION: "${query}"

═══ STEP 1: CLASSIFY THE QUESTION (silently — do NOT include this in your output) ═══

Decide INTERNALLY which type this is. Do not write "CLASSIFICATION:" or any meta-commentary in your response. Just pick one and start writing the appropriate output directly.

- **BIOGRAPHICAL FACT** — asks about a bestie's identity, party affiliation, current role, biography, or verifiable life facts. Examples: "Is Sacks a Republican?", "Who is Brad Gerstner?", "What's Chamath's background?", "Does Friedberg work at Google?"
- **TOPICAL OPINION** — asks about their views, takes, predictions, or analysis of a subject. Examples: "What does Chamath think about tariffs?", "Are the besties bullish on AI?", "Will Bitcoin hit 200k?"

Your first characters should be either "**David" (or whichever bestie) for a factual answer, or "**JASON:**" for a dialogue. No preamble, no meta.

═══ STEP 2: RESPOND ═══

**IF BIOGRAPHICAL FACT:**
Give a DIRECT ANSWER in 2-4 sentences from the GROUND-TRUTH FACTS section of your system prompt. No dialogue. No hedging. No "it's complicated." No "they say they're..." — just state the fact as it is. Then add a short context paragraph explaining how they arrived at their current position. Example for "Is Sacks a Republican?":

> David Sacks is a Republican. He is the White House AI & Crypto Czar in the Trump administration, appointed by President Trump in December 2024 and serving since January 2025. He delivered a keynote speech at the 2024 Republican National Convention and hosted a major Trump fundraiser in June 2024. While Sacks has sometimes described himself as an independent or former Democrat, his current affiliation — by both formal role and public advocacy — is unambiguously Republican.
>
> The shift is part of a broader realignment among Silicon Valley operators who moved right during the 2024 cycle over concerns about regulation, censorship, and the Biden administration's approach to crypto and AI.

NO dialogue, NO citations for biographical facts (the facts come from the system prompt, not retrieval).

**IF TOPICAL OPINION:**
Produce a round-table discussion in the voices of the four besties. Use the retrieved segments below as the source of truth for their takes, with [N] markers.

Here are the retrieved transcript segments:

${segmentText}

Format for topical:
1. **JASON:** opens the topic (1-2 sentences)
2. **CHAMATH, SACKS, FRIEDBERG:** each take a turn with segment content, [N] markers
3. Additional back-and-forth (6-10 turns total)
4. **## Where they land** — 2-3 consensus bullets
5. **## Where they split** — 2-3 disagreement bullets
6. **Confidence:** HIGH/MEDIUM/LOW

SHORT turns (1-3 sentences). Real voices. Current reality (not old self-descriptions from 2022).`;
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    const payload: CachedResponse = {
      report: text,
      citations,
      segmentsFound: results.length,
      totalEntries: Object.keys(await getContentIndex()).length,
      searchMode,
    };

    // Write-through to pi-brain for future cache hits. Runs AFTER the response
    // is sent so the user doesn't pay for network round-trip on a miss.
    after(() => cacheStore(cacheKey, payload));

    return NextResponse.json({
      ...payload,
      cacheHit: false,
      latencyMs: Date.now() - reqStart,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Internal server error';
    console.error('API error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

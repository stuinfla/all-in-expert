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
    const segmentText = results
      .slice(0, 15)
      .map((r, i) => {
        const topics = r.entry.p.join(', ');
        const speakers = r.entry.m.length > 0 ? ` · voices: ${r.entry.m.join(', ')}` : '';
        return `[CITATION ${i + 1}] ${r.entry.t} · ${topics}${speakers}\nURL: ${r.entry.u}\nTEXT: "${r.entry.c.slice(0, 700)}"`;
      })
      .join('\n\n');

    // Structured citations for the response (frontend renders these separately)
    const citations = results.slice(0, 10).map((r, i) => ({
      n: i + 1,
      time: r.entry.t,
      videoId: r.entry.v,
      url: r.entry.u,
      topics: r.entry.p,
      speakers: r.entry.m,
      quote: r.entry.c.slice(0, 400),
      relevance: Number((1 - r.distance).toFixed(3)),
    }));

    const speakerProfileText = Object.entries(SPEAKER_CONTEXT)
      .map(([, s]) => `• ${s.name} (${s.short}, ${s.tier}) — ${s.lens} | Style: ${s.style}`)
      .join('\n');

    const focus = speaker ? SPEAKER_CONTEXT[speaker] : null;
    const isForecast = mode === 'forecast';

    const systemPrompt = `You are the All-In Expert — an intelligence synthesis engine for the All-In Podcast (Chamath Palihapitiya, David Sacks, David Friedberg, Jason Calacanis, plus frequent guest besties: Brad Gerstner, Bill Gurley, Gavin Baker, Peter Thiel, Bill Ackman, Antonio Gracias, Elon Musk, Naval Ravikant, Travis Kalanick, Mark Cuban, and others).

You are reading raw transcript segments that were retrieved for a question. These segments come from conversations where the speakers aren't explicitly labeled — you need to infer who is speaking from context clues:
• Self-references ("I think", "my view")
• Names the speakers use for each other ("Chamath, Sacks, Freeberg/Friedberg, J-Cal/Jason")
• Topic expertise (science talk → usually Friedberg, enterprise SaaS → usually Sacks, macro/VC → often Chamath, startups/hosting → Jason)
• Characteristic phrases and speaking style
• Guest appearances when named (Gerstner, Gurley, Elon, etc.)

THE BESTIES AND THEIR LENSES:
${speakerProfileText}

YOUR JOB:
1. Read every segment carefully. The rare topic word in the query (e.g. "Anthropic", "tariffs", "DOGE") has been used for retrieval — those segments DO contain real discussion of it, even if the exact word density is low.
2. PULL VERBATIM QUOTES. When a segment contains an exchange like ">> position X" or ">> yeah but Y", attribute the speakers and quote directly. Use em-dashes to open quotes: —"the debt is like plaque in the arteries" (Chamath, on 2025 Dalio interview).
3. Attribute speakers using context — if a segment is clearly Chamath (uses his phrases, referenced as "you" when the speaker before said "Chamath"), say so explicitly.
4. If there's a PRESENT tense discussion from a recent episode (look at the segment timestamps and the "voices" metadata), cite it as their current view. Recency beats inference.
5. If segments genuinely don't touch the topic, say "The segments retrieved don't contain direct discussion of X from [bestie]" — don't pad with hypotheticals. But work hard first to find what IS there.
6. Confidence: HIGH when you have direct quotes, MEDIUM when inference from clear patterns, LOW only when extrapolating from lens alone.
7. Format: markdown headers (##), bold (**), italic (*), bullet lists (-). No em-dashes for list bullets (use "-"). Keep it tight.
8. Cite segments by number like [1], [3], [5] — these match the citation cards shown to the user.

WHEN THE QUERY TARGETS ONE BESTIE: work harder to find direct quotes from them specifically. Scan all 15 segments for speaking patterns that match their voice.

WHEN YOU CAN'T FIND DIRECT QUOTES: be honest that the available segments don't capture them on this exact topic, but still try to extract what their position WOULD be from their lens and any adjacent commentary.`;

    let userPrompt: string;

    if (focus) {
      userPrompt = `QUESTION: "${query}"

FOCUS: What would ${focus.name} think about this?

Here are the top semantic matches from the archive (scored by vector similarity):

${segmentText}

Provide a focused brief:
## ${focus.short}'s Position
(2-3 sentences summarizing their take)

## Evidence From The Archive
(Bullet points with citation refs like [CITATION 3], including direct quotes when they exist)

## Their Analytical Lens
(How they would frame/argue this, tied to their known expertise)

## Confidence: HIGH/MEDIUM/LOW
(One sentence explaining why)`;
    } else if (isForecast) {
      userPrompt = `FORECASTING QUESTION: "${query}"

Here are the top semantic matches from the archive:

${segmentText}

Produce a forecast report:
## The Forecast
(One clear prediction in 1-2 sentences)

## Bestie Positions
### Chamath (macro/capital lens)
### Sacks (enterprise/political lens)
### Friedberg (science/first-principles lens)
### Jason (startup/media lens)
(Each with prediction + reasoning + citation refs)

## Where They Agree
## Where They Diverge
## Confidence Assessment
(Based on evidence strength and their historical accuracy)`;
    } else {
      userPrompt = `QUESTION: "${query}"

Here are the top semantic matches from the archive:

${segmentText}

Produce an intelligence brief:
## Quick Answer
(2-3 sentence consensus answer)

## Chamath's Take
## Sacks' Take
## Friedberg's Take
## Jason's Take
(Each with their likely position + citation refs like [CITATION 3] + brief reasoning)

## Where They Agree
## Where They Diverge
## Confidence: HIGH/MEDIUM/LOW`;
    }

    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 3500,
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

# Ask the All-In Experts

**Live:** https://asktheallinexperts.vercel.app
**GitHub:** https://github.com/stuinfla/all-in-expert

An AI-powered intelligence system built on 448 episodes of the All-In Podcast. Ask a question and get a voice-matched round-table dialogue in the style of Chamath Palihapitiya, David Sacks, David Friedberg, and Jason Calacanis, grounded in real transcript citations.

Built by [IsoVision AI](https://isovision.ai).

---

## What it does

**Query in plain English**, get a synthesized All-In roundtable discussion:
- **Biographical questions** ("Is Sacks a Democrat or Republican?") → direct answer from ground-truth facts
- **Topical questions** ("What do the besties think about tariffs?") → voice-matched dialogue with citations
- **Forecast questions** ("Will Bitcoin hit 200K?") → predictive roundtable with confidence rating
- **Single-bestie focus** → monologue in that bestie's voice

Every substantive claim is cited back to a specific transcript segment with episode date, timestamp, and a YouTube deep-link.

---

## Architecture

### Data layer
- **448 episodes** of All-In Podcast transcripts (Apr 2024 – Apr 2026, ~5.8M words)
- **15,560 transcript chunks** (2-minute windows with topic/speaker tags)
- **1,288 chapter topics** extracted from RSS show notes
- **19 speaker profiles** (4 core besties + 15 frequent guests)
- **CC-licensed photos** from Wikimedia Commons (4 core besties)
- **Ground-truth facts file** (bestie-facts.json) overrides retrieval on biographical questions

### Retrieval
- **Semantic**: OpenAI text-embedding-3-small (384 dims) — consistent space for query + docs, pure-JS cosine over a 22.8MB Float32 binary (15,560 × 384)
- **Fallback**: TF-IDF with IDF-weighted term scoring (838KB IDF lookup precomputed from corpus)
- **Recency boost**: exponential decay with 180-day half-life, 0.4 floor — recent episodes rank higher when positions have evolved
- **Speaker filter**: optional filter on "voices" metadata

### Synthesis
- **Claude Haiku 4.5** for fast dialogue generation (~8-15s end-to-end)
- **Question classifier**: biographical → direct answer; topical → dialogue
- **System prompt** includes voice profiles + hard-override ground-truth facts

### Infrastructure
- **Next.js 16** App Router + Tailwind CSS
- **Deployed on Vercel** (static data bundled in `public/data/`)
- **Weekly auto-update** LaunchAgent (runs Saturdays 4 AM) pulls new episodes, rebuilds KB, redeploys
- **Domain**: asktheallinexperts.vercel.app

---

## Directory layout

```
All In Expert/
├── data/                           # Local data pipeline outputs (gitignored except episodes metadata)
│   ├── captions/                   # Raw YouTube auto-captions (json3)
│   ├── transcripts/                # Processed transcript chunks with topic/speaker tags
│   ├── kb/                         # Built knowledge base artifacts
│   ├── chapters/                   # Extracted chapter topics from RSS show notes
│   ├── qa/                         # QA harness results
│   └── episodes/                   # Episode metadata (RSS, YouTube IDs)
├── ruvector/                       # RuVector submodule (upstream, gitignored from working tree)
├── scripts/
│   ├── download-captions.mjs       # Batch download YouTube auto-captions via yt-dlp
│   ├── bulk-download.sh            # Shell version of caption downloader
│   ├── process-captions.mjs        # Parse captions into chunks with topic/speaker detection
│   ├── build-knowledge-base.mjs    # Build content-index + (legacy) xenova embeddings
│   ├── build-embeddings-openai.mjs # Re-embed with OpenAI for consistent serverless space
│   ├── build-idf.mjs               # Pre-compute IDF for keyword search fallback
│   ├── build-episode-dates.mjs     # Match YouTube IDs to RSS dates for recency weighting
│   ├── extract-chapters.mjs        # Parse RSS show notes for chapter topics
│   ├── build-episode-dates.mjs     # YouTube ID → episode date mapping
│   ├── refresh-kb.sh               # Full pipeline refresh
│   ├── weekly-update.sh            # Cron job target (runs Saturdays 4 AM)
│   └── qa-20-questions.mjs         # 20-question QA harness with Claude-as-judge grader
├── src/                            # CLI tools (not web app)
│   ├── query.mjs                   # Fast CLI search
│   └── synthesize.mjs              # CLI Claude-powered synthesizer
├── web/                            # Next.js web app
│   ├── public/
│   │   ├── data/                   # Bundled KB artifacts (ships with deployment)
│   │   │   ├── content-index.json       # 31MB: entry ID → text/meta
│   │   │   ├── embeddings.bin           # 22.8MB: Float32 semantic vectors (15560 × 384)
│   │   │   ├── embeddings-order.json    # ID order in the binary
│   │   │   ├── idf.json                 # 838KB: IDF lookup for keyword fallback
│   │   │   ├── episode-dates.json       # 10KB: videoId → date for recency
│   │   │   ├── speaker-profiles.json    # Speaker mention stats
│   │   │   ├── bestie-facts.json        # Ground-truth facts (overrides retrieval)
│   │   │   ├── chapters.json            # Episode chapter breakdown
│   │   │   ├── chapter-lookup.json      # Chapter ID → episode context
│   │   │   └── freshness.json           # Last-updated timestamp
│   │   └── images/besties/              # CC-licensed bestie photos
│   ├── src/app/
│   │   ├── page.tsx                # Main ask interface
│   │   ├── chapters/page.tsx       # Episode/topic browser
│   │   ├── api/ask/route.ts        # Synthesis endpoint
│   │   ├── api/chapters/route.ts   # Chapter browser endpoint
│   │   ├── globals.css             # Editorial dark theme
│   │   └── layout.tsx              # Root layout with fonts
│   ├── next.config.ts
│   └── vercel.json
└── .env                            # Local env (gitignored)
```

---

## Running it locally

```bash
# One-time setup
git clone https://github.com/stuinfla/all-in-expert.git
cd all-in-expert
git submodule update --init --recursive
npm install
cd web && npm install && cd ..

# Set env
cp .env.example .env
# Edit .env:
#   ANTHROPIC_API_KEY=sk-ant-...
#   OPENAI_API_KEY=sk-proj-...   # required for semantic search

# Full data pipeline (from scratch — can take 2+ hours)
bash scripts/bulk-download.sh 500        # download YouTube captions
node scripts/process-captions.mjs         # parse into chunks
node scripts/build-knowledge-base.mjs     # build content-index + RVF + fallback
node scripts/build-embeddings-openai.mjs  # OpenAI embeddings (~$0.10, 90s)
node scripts/build-idf.mjs                # IDF for keyword fallback
node scripts/build-episode-dates.mjs      # YouTube → RSS date map
node scripts/extract-chapters.mjs         # RSS chapter topics

# Run web app
cd web && npm run dev   # http://localhost:3000

# Deploy
cd web && vercel --prod --yes
```

---

## Querying

### Web
Visit https://asktheallinexperts.vercel.app and type your question.

### CLI
```bash
# Semantic search + Claude synthesis
node src/synthesize.mjs "Will there be a recession in 2026?"

# Fast keyword/vector search (no LLM)
node src/query.mjs "tariffs China trade war"
node src/query.mjs --profile chamath
```

### API
```bash
curl -X POST https://asktheallinexperts.vercel.app/api/ask \
  -H "Content-Type: application/json" \
  -d '{"query": "Is Sacks a Democrat or Republican?"}'
```

Response:
```json
{
  "report": "David Sacks is a Republican...",
  "citations": [
    { "n": 1, "date": "2026-04-10", "time": "00:07:53", "quote": "...", "url": "https://youtube.com/watch?v=...&t=473", "relevance": 0.87 }
  ],
  "segmentsFound": 30,
  "totalEntries": 15560,
  "searchMode": "semantic"
}
```

---

## Credits & rights

- **All podcast content, the "All-In" name, and all episode material** remain © their respective owners (Chamath Palihapitiya, David Sacks, David Friedberg, Jason Calacanis). This is an independent research tool that surfaces publicly-available material to make it more searchable. Not affiliated with the All-In Podcast.
- **Bestie photos**: Wikimedia Commons, CC BY-SA 4.0 / Public Domain (see footer of the app for individual credits).
- **Built on**: [RuVector](https://github.com/ruvnet/ruvector), [Cognitum One](https://cognitumone.com), Claude (Anthropic), OpenAI embeddings, Next.js, Vercel.
- **© 2026 IsoVision AI**

---

## Project status (as of 2026-04-12)

### What works
- ✅ 448 episodes processed, 5.8M words indexed
- ✅ Real semantic search locally (OpenAI text-embedding-3-small @ 384 dims)
- ✅ Pure-JS cosine over 22.8MB binary — no native deps, no RVF native-module issues
- ✅ Ground-truth facts override (Sacks correctly classified as Republican etc.)
- ✅ Voice-matched round-table dialogue format (Haiku 4.5, ~8-15s latency)
- ✅ Citations with episode date + timestamp + YouTube deep-links
- ✅ Recency weighting (180-day half-life, 0.4 floor)
- ✅ Chapter/topic browser at `/chapters` with 181 episodes of show-note data
- ✅ Editorial UI with real CC-licensed bestie photos
- ✅ Weekly auto-update LaunchAgent (Saturdays 4 AM)

### Known issues being worked
- ⚠️ Production `searchMode` showing `tfidf` instead of `semantic` — binary loading in Vercel serverless needs verification. Next step: check Vercel function logs and test with warm-cache.
- ⚠️ 20-question QA pilot averaged ~68/100; target is 98. Iterating on retrieval precision and citation accuracy.

### What's not yet built
- ❌ Speaker diarization (all "voices" metadata is keyword-based, not audio-diarized)
- ❌ Query caching / ReasoningBank
- ❌ Louvain community detection for topic clustering
- ❌ CoherenceMonitor for contradiction detection
- ❌ Streaming responses (perceived latency win)
- ❌ AIMDS middleware (per global CLAUDE.md rule #17)

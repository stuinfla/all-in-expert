# Ask the All-In Experts

**Live:** https://asktheallinexperts.vercel.app
**GitHub:** https://github.com/stuinfla/all-in-expert

An AI-powered intelligence system built on 203 episodes of the All-In Podcast (Apr 2024 – Jun 2026). Ask a question and get a voice-matched round-table dialogue in the style of Chamath Palihapitiya, David Sacks, David Friedberg, and Jason Calacanis, grounded in real transcript citations. Every numeric or specific claim is fact-checked against the cited transcript segments by a post-generation verifier (see ADR-027); ungrounded specifics are softened or removed before the response reaches you.

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
- **203 episodes** of All-In Podcast transcripts (Apr 2024 – Jun 2026, ~6M words)
- **31,215 transcript chunks** — alias-based **per-turn chunking** (single-speaker windows with sentence-boundary respect), 92.2% labeled with `speakerKey`
- **1,288 chapter topics** extracted from RSS show notes
- **23 speaker profiles** (4 core besties + 19 frequent guests including Gerstner, Musk, Naval, Thiel, Ackman, Howery, Doerr)
- **CC-licensed photos** from Wikimedia Commons (4 core besties)
- **Ground-truth facts file** (bestie-facts.json) overrides retrieval on biographical questions

### Retrieval
- **Embeddings**: OpenAI `text-embedding-3-small` (384 dims, L2-normalized) used for **both build and query** — single shared vector space. Query embedding is fetched per-request from the OpenAI API; the corpus matrix is the bundled `embeddings.bin`.
- **Hybrid search**: dense (cosine over 45.4MB `embeddings.bin`, 31,010 × 384) + sparse (**BM25-Okapi**, k1=1.5, b=0.75, via `idf.json` + `doc-lengths.json` avgdl=142.46) fused via **Reciprocal Rank Fusion** (k=60).
- **MMR diversity rerank** (λ=0.5 opinion / 0.7 biographical, additive same-episode penalty so negative cosines don't invert).
- **3-tier topical-relevance gate** on claim-bias multiplier (prevents off-topic claim-dense chunks rescuing themselves).
- **Recency boost**: 180-day half-life / 0.4 floor for biographical; **90d / 0.15 floor for opinion queries** when speaker filter applies.
- **Strict speaker mode**: UI toggle default-on when single bestie selected; skips filtered+unfiltered interleave for pure-speaker retrieval.
- RVF HNSW path exists in `pi-brain.ts` but is **disabled** in `/api/ask` — its index was built against the legacy MiniLM vectors and would mismatch the current OpenAI query space. Re-enabling requires rebuilding the HNSW index against `embeddings.bin`. See ADR-028.

### Synthesis
- **Claude Haiku 4.5** for dialogue generation, with **SSE streaming** (first-token ~2s).
- **Post-generation claim verifier** (`validate-citations.ts`): second Haiku pass extracts every numeric/legislative/specific claim and marks GROUNDED / INFERRED / UNGROUNDED against citations.
- **Hedge-or-refuse rewriter**: ungrounded claims are softened to hedges before the response reaches the user.
- **Question classifier**: biographical → direct answer; topical → dialogue; forecast → confidence-rated roundtable.
- **System prompt** includes voice profiles + voice-bleeding contrast paragraph + verbatim sample-quote few-shot (from `speaker-profiles.json`) + ground-truth facts.
- **Paraphrase disclaimer** in the user-facing UI and in the prompt itself.

### Safety
- **AIMDS middleware** (`@claude-flow/aidefence`) — inbound (400 on prompt injection) and outbound (audit-only via `after()` with structured `[AIDEFENCE-OUTBOUND]` log).

### Infrastructure
- **Next.js 16** App Router + Tailwind CSS, streaming server actions.
- **Deployed on Vercel** (static data bundled in `public/data/`).
- **Auto-update** LaunchAgent (`com.isovision.all-in-expert.weekly`) — runs **daily at 4 AM**, gated to rebuild only when the last successful refresh is ≥3 days old (effective cadence: every 3 days, weekly floor, same-day auto-retry after any failure). Each run: RSS + caption download → KB rebuild → **OpenAI embeddings (served bin)** → **TF-IDF rebuild** → chapter index → Vercel deploy + alias + cache warm + QA-CI regression check. A separate **watchdog** LaunchAgent (`…watchdog`, daily 10 AM) alerts (desktop + ntfy) if no successful refresh lands within 4 days or any run fails.
- **Observability**: `/api/health` (chunk count + QA score + verifier rollup), `/api/perf` (p50/p99 latency per stage), `[PERF]` structured logs.
- **Rate limit**: 200/day. `QA_BYPASS_TOKEN` env grants unmetered access for the regression harness.
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
│   ├── build-knowledge-base.mjs    # Build content-index + RVF (MiniLM embeddings, data/kb only)
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
│   │   │   ├── embeddings.bin           # 45.4MB: Float32 OpenAI semantic vectors (31010 × 384)
│   │   │   ├── embeddings-order.json    # ID order in the binary
│   │   │   ├── idf.json                 # 847KB: IDF lookup for BM25 sparse retrieval
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
node scripts/build-knowledge-base.mjs     # build content-index + RVF (MiniLM, data/kb only)
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
  "totalEntries": 31010,
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

## Project status (as of 2026-06-21)

> **2026-06-21 reliability + retrieval fix.** The auto-update had silently failed
> 2026-05-30 → 06-19 (a wiped `node_modules` crashed the pipeline before the
> commit/deploy steps, into an unwatched log). It's restored and hardened: dependency
> preflight self-heal, loud failure alerts (desktop + ntfy + independent watchdog),
> and an every-3-day gated cadence with same-day auto-retry. Also fixed a
> retrieval-coherence bug the outage had masked — the pipeline now rebuilds the
> **served OpenAI `embeddings.bin`** and the **TF-IDF index** on every run, so new
> episodes are actually retrievable (previously the served bin drifted to MiniLM
> space and the TF-IDF index went stale). One build path, matching the serve path.

### Earlier sprint (2026-05-13)

**Current measured score: 83.8 / 100** on the canonical 20-Q harness with Sonnet-grader. Five-iteration sprint moved the rubric from a 72/100 external-reviewer baseline. See `NEXT_SESSION.md` for the full per-dimension breakdown and the documented path to 92.

### What works (verified live this sprint)
- ✅ 203 episodes, ~6M words, **31,010 indexed segments** with 92.2% speaker-labeled
- ✅ OpenAI `text-embedding-3-small` (384d) for both build and query — single aligned vector space
- ✅ Speaker attribution counts non-vocative alias mentions (so "Chamath, what do you think?" no longer attributes the turn to Chamath)
- ✅ Hybrid dense + BM25 retrieval via RRF fusion
- ✅ MMR diversity reranking (additive penalty) + topical-relevance gate
- ✅ Strict speaker mode (UI toggle, 12/12 single-speaker citations on demand)
- ✅ Post-generation claim verifier (Haiku 4.5, 85% hit rate, ungrounded claims hedged), runs in `after()` so it doesn't gate the response
- ✅ FACT-CHECK UI card showing grounded/inferred/ungrounded counts
- ✅ SSE streaming (first-token ~2s vs prior ~30s blocking)
- ✅ AIMDS inbound/outbound (`@claude-flow/aidefence`)
- ✅ Ground-truth facts override
- ✅ Voice-matched round-table with verbatim sample-quote few-shot
- ✅ Citations with episode date + timestamp + YouTube deep-links + speakerKey
- ✅ Persistent visitor counter via abacus atomic INCR (display floor 10,001)
- ✅ Chapter/topic browser at `/chapters`
- ✅ Mobile-responsive UI verified at 375px
- ✅ Daily gated auto-update (every-3-day cadence) + watchdog + QA-CI regression gate
- ✅ /legal page with DMCA template + X-Robots-Tag + 280-char fair-use quote cap
- ✅ `/api/health` and `/api/perf` observability endpoints (telemetry forced to `/tmp` on Vercel)

### Known limitations
- ⚠️ **Speaker fidelity hard-capped at 80/100** without audio diarization. ~7.8% of chunks are unattributable from caption text alone (intros, cross-talk, cold opens). Pyannote.audio is the documented path past this cap.
- ⚠️ Post-gen verifier SOFTENS ungrounded claims but doesn't excise the offending sentences — biggest residual gap to 92. Documented fix is regenerate-in-limited-mode when `claimsUngrounded > 2`.
- ⚠️ RVF HNSW path is currently disabled because its index was built against legacy MiniLM vectors; rebuilding against the OpenAI matrix is the path to re-enable it (see ADR-028).
- ⚠️ `/api/perf` and `verifierStats.last100` write to Vercel `/tmp` — no cross-instance aggregation in the serverless fleet.

### Path past 92 (documented in NEXT_SESSION.md)
1. **Audio diarization** workstream — unlocks Speaker cap (+2.7 weighted points)
2. **Regenerate-in-limited-mode** rewriter — fix the verifier-softens-not-excises pattern (+4 points)
3. **Cross-encoder rerank** after BM25 — catch topical drift on idiom-rich queries (+2 points)
4. **Durable telemetry** — push verdicts to AgentDB or pi-brain instead of /tmp (+1 point)

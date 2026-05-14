# Ask the All-In Experts

**Live:** https://asktheallinexperts.vercel.app
**GitHub:** https://github.com/stuinfla/all-in-expert

An AI-powered intelligence system built on 186 episodes of the All-In Podcast (Apr 2024 – May 2026). Ask a question and get a voice-matched round-table dialogue in the style of Chamath Palihapitiya, David Sacks, David Friedberg, and Jason Calacanis, grounded in real transcript citations. Every numeric or specific claim is fact-checked against the cited transcript segments by a post-generation verifier (see ADR-027); ungrounded specifics are softened or removed before the response reaches you.

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
- **186 episodes** of All-In Podcast transcripts (Apr 2024 – May 2026, ~5.8M words)
- **31,215 transcript chunks** — alias-based **per-turn chunking** (single-speaker windows with sentence-boundary respect), 92.2% labeled with `speakerKey`
- **1,288 chapter topics** extracted from RSS show notes
- **23 speaker profiles** (4 core besties + 19 frequent guests including Gerstner, Musk, Naval, Thiel, Ackman, Howery, Doerr)
- **CC-licensed photos** from Wikimedia Commons (4 core besties)
- **Ground-truth facts file** (bestie-facts.json) overrides retrieval on biographical questions

### Retrieval
- **Embeddings**: local `Xenova/all-MiniLM-L6-v2` (384 dims, mean-pool + L2-normalize) — no external API at query time, single vector space for build and query.
- **Hybrid search**: dense (Xenova cosine over 47.9MB `embeddings.bin`) + sparse (**BM25-Okapi**, k1=1.5, b=0.75, via `idf.json` + `doc-lengths.json` avgdl=141.53) fused via **Reciprocal Rank Fusion** (k=60).
- **MMR diversity rerank** (λ=0.5 opinion / 0.7 biographical, same-episode 0.5 penalty).
- **3-tier topical-relevance gate** on claim-bias multiplier (prevents off-topic claim-dense chunks rescuing themselves).
- **Recency boost**: 180-day half-life / 0.4 floor for biographical; **90d / 0.15 floor for opinion queries** when speaker filter applies.
- **Strict speaker mode**: UI toggle default-on when single bestie selected; skips filtered+unfiltered interleave for pure-speaker retrieval.
- RVF HNSW path exists but is not currently the live path — see ADR-028.

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
- **Weekly auto-update** LaunchAgent (Saturdays 4 AM EDT) — RSS + caption download + KB rebuild + Vercel deploy + alias + cache warm + QA-CI regression check.
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

## Project status (as of 2026-05-13)

**Current measured score: 83.8 / 100** on the canonical 20-Q harness with Sonnet-grader. Five-iteration sprint moved the rubric from a 72/100 external-reviewer baseline. See `NEXT_SESSION.md` for the full per-dimension breakdown and the documented path to 92.

### What works (verified live this sprint)
- ✅ 186 episodes, ~5.8M words, **31,215 per-turn chunks** with 92.2% speaker-labeled
- ✅ Local Xenova embeddings (no OpenAI dependency at query time)
- ✅ Hybrid dense + BM25 retrieval via RRF fusion
- ✅ MMR diversity reranking + topical-relevance gate
- ✅ Strict speaker mode (UI toggle, 12/12 single-speaker citations on demand)
- ✅ Post-generation claim verifier (Haiku 4.5, 85% hit rate, ungrounded claims hedged)
- ✅ FACT-CHECK UI card showing grounded/inferred/ungrounded counts
- ✅ SSE streaming (first-token ~2s vs prior ~30s blocking)
- ✅ AIMDS inbound/outbound (`@claude-flow/aidefence`)
- ✅ Ground-truth facts override
- ✅ Voice-matched round-table with verbatim sample-quote few-shot
- ✅ Citations with episode date + timestamp + YouTube deep-links + speakerKey
- ✅ Persistent visitor counter via abacus atomic INCR (display floor 10,001)
- ✅ Chapter/topic browser at `/chapters`
- ✅ Mobile-responsive UI verified at 375px
- ✅ Weekly auto-update LaunchAgent + QA-CI regression gate
- ✅ /legal page with DMCA template + X-Robots-Tag + 280-char fair-use quote cap
- ✅ `/api/health` and `/api/perf` observability endpoints

### Known limitations
- ⚠️ **Speaker fidelity hard-capped at 80/100** without audio diarization. ~7.8% of chunks are unattributable from caption text alone (intros, cross-talk, cold opens). Pyannote.audio is the documented path past this cap.
- ⚠️ Post-gen verifier SOFTENS ungrounded claims but doesn't excise the offending sentences — biggest residual gap to 92. Documented fix is regenerate-in-limited-mode when `claimsUngrounded > 2`.
- ⚠️ RVF HNSW write hits `FsyncFailed 0x0303` on every rebuild — see ADR-028. Falls back to bin cosine (correct, ~30ms at 31k vectors).
- ⚠️ `/api/perf` and `verifierStats.last100` write to Vercel `/tmp` — no cross-instance aggregation in the serverless fleet.

### Path past 92 (documented in NEXT_SESSION.md)
1. **Audio diarization** workstream — unlocks Speaker cap (+2.7 weighted points)
2. **Regenerate-in-limited-mode** rewriter — fix the verifier-softens-not-excises pattern (+4 points)
3. **Cross-encoder rerank** after BM25 — catch topical drift on idiom-rich queries (+2 points)
4. **Durable telemetry** — push verdicts to AgentDB or pi-brain instead of /tmp (+1 point)

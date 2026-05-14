# All-In Expert — Next Session Handoff

**Last sprint: 2026-05-12 → 2026-05-13. Final score: 83.8/100 (canonical 20-Q harness, May 13 2026).**

## Where you are

Live at https://asktheallinexperts.vercel.app/. Five-iteration sprint moved
the quality rubric:

| Iter | Date | Score | Headline win |
|------|------|-------|--------------|
| pre  | 2026-05-12 | 72 | External reviewer baseline |
| 1    | 2026-05-12 | 73 | Local Xenova embeddings + AIMDS |
| 2    | 2026-05-12 | 81 | Hybrid RRF + MMR + few-shot voice examples |
| 3    | 2026-05-12 | 82 | Per-turn chunking + strict speaker mode |
| 4    | 2026-05-12 | 85 | Post-gen verifier + topical-relevance gate |
| 5    | 2026-05-13 | **83.8** | BM25 + FACT-CHECK UI + DMCA + rate-lift + canonical 20-Q live |

Iter-5 was the **first measured** score (prior iterations were code-only-inferred under rate-limit constraints). The 83.8 is the honest number against the canonical Sonnet-grader 20-Q harness with the bypass token active. It includes a 1.2pt regression vs iter-4 because the canonical grader is stricter than the iter-4 code-inferred deductions, and two questions (q04 Sacks-crypto = 42, q19 Friedberg-GLP-1 = 48) revealed a real failure mode the iter-4 estimate missed.

## What's live (final architecture)

### Search & retrieval
- **Local Xenova embeddings** (`Xenova/all-MiniLM-L6-v2`, 384d, mean-pool + L2-normalize)
- **BM25-Okapi sparse** (k1=1.5, b=0.75) via `idf.json` + `doc-lengths.json` (avgdl=141.53)
- **Hybrid via RRF** (k=60) fusing dense + BM25
- **MMR diversity** (λ=0.5 opinion / 0.7 biographical, same-episode 0.5 penalty)
- **3-tier topical-relevance gate** on claim-bias multiplier (bottom-half capped 1.05)
- **Claim-bearing rerank** + secondary swap (TOP_SWAP_RANK=30)
- **Per-turn alias chunking** — 31,215 chunks, 92.2% with speakerKey (single-neighbor secondary attribution added 0.3pp on top of direct alias matching; remaining 7.8% structurally unattributable from captions alone)
- **Strict speaker mode** — UI toggle default-on; skips filtered+unfiltered interleave
- RVF HNSW path exists but is not active due to fsync issue — see **ADR-028**

### Synthesis
- **Post-gen claim verifier** (`validate-citations.ts:verifyClaimsAgainstCitations`) — Haiku 4.5, JSON-strict, fail-open
- **Hedge-or-refuse rewriter** (`rewriteToHedge`) — second Haiku pass
- **HEDGE-OR-REFUSE system-prompt block** + thin-evidence gate
- **Voice-example block** — verbatim sample quotes from speaker-profiles.json
- **Voice-bleeding contrast paragraph** in prompt
- **Paraphrase disclaimer** in UI + prompt
- See **ADR-027** for verifier pipeline rationale

### UI
- **SSE streaming** (first-token ~2s)
- **FACT-CHECK card** — verifier counts + amber hedge state (page.tsx:1167-1245)
- **dataFreshness banner** — "Corpus current as of [date] · N episodes · K chunks"
- **STRICT MODE ACTIVE** badge
- **Why did you get this answer?** expander
- **Citation graceful fallback** (no "?" placeholders)
- **280-char fair-use quote** (IDF-anchored sentence selection)
- **Copyright footer** + `/legal` link
- **Mobile** validated clean at 375px

### Counter
- **Visitor count** via abacus.jasoncameron.dev atomic INCR (display floor 10,001)
- **Ratings** via pi.ruv.io memory store

### Safety
- **AIMDS middleware** (`@claude-flow/aidefence@3.0.2`) — inbound 400 on injection, outbound audit via `after()` with `[AIDEFENCE-OUTBOUND]` log

### Ops
- **Rate limit: 200/day**. Bypass via `QA_BYPASS_TOKEN` env (not committed)
- **/api/health** — chunk count, last QA score, verifier rollup, RVF/bin file sizes
- **/api/perf** — p50/p99 latency per stage (note: /tmp-bound on Vercel, no cross-instance aggregation)
- **Weekly auto-update** (Sat 04:00 EDT) — RSS + captions + KB rebuild + Vercel deploy + alias + cache-warm + QA-CI regression check
- **QA-CI** — fails on >3pt regression vs `data/qa/baseline.json`, or any q<60
- **Legal**: `/legal` page + DMCA template + X-Robots-Tag

## The honest gap to 92 (8.2 points)

Per the iter-5 QA report, the residual gap is concentrated in two places:

### Synthesis (72/100 — biggest drag, weight 13)
The verifier flags 85% of responses (hit rate) and hedges 85% (rewrite ran). But the rewriter **softens** ungrounded claims instead of **excising** them. q04 still narrates "an actual framework where builders know what the rules are before they ship" (not in any citation); q19 still mentions "AlphaFold 3" and specific receptor mechanisms. Grader correctly penalizes residual specifics.

**Fix**: replace rewrite-with-hedge with **regenerate-in-limited-mode** when `claimsUngrounded > 2`. Drop the offending paragraphs entirely and write "the corpus has limited direct material on this question." Est. +4 weighted points.

### Retrieval (84/100, weight 12)
BM25 is healthier than TF-IDF on speaker-locked queries. But lexical match can't discriminate Friedberg-banter ("Sultan of Science… heat lamp") from Friedberg-science (substantive GLP-1 content). Cross-encoder rerank of top-30 → top-12 would catch this.

**Fix**: add Haiku cross-encoder rerank after BM25, before final top-12 selection. Est. +2 weighted points.

### Architectural (86/100, weight 10)
`verifierStats.last100` and `/api/perf` write to `/tmp` on Vercel — ephemeral, no cross-instance aggregation. Telemetry is functionally invisible in production.

**Fix**: push verifier verdicts and perf samples to AgentDB or pi-brain (single row per request). Est. +1 weighted point.

### Speaker (HARD CAP 80/100, weight 18)
No path past 80 without audio diarization (pyannote.audio v3 on 186 episodes' source audio). Single biggest unlock available. Est. +2.7 weighted points to clear the cap to 95.

**Sum**: ~9.7 if all four ship cleanly → ~93.5. Hitting exactly 92 is achievable with the first three (regenerate-in-limited-mode + cross-encoder rerank + durable telemetry) — that's ~7 weighted points → ~91. The diarization sprint is the path past 92 honestly.

## Open follow-ups (smaller items)

1. **q17 temporal-confusion** — "Will there be a recession in 2026?" rendered in future tense. Inject "today's date" into the synthesis prompt with present-tense rule when month/year ≤ today.
2. **Howery coverage** — alias in SPEAKER_PROFILES, but transcripts don't contain "howery" anywhere (caption attribution gap upstream).
3. **`package.json` version pins** — `@ruvector/rvf@^0.2.1` and `ruvector@^0.2.22` violate CLAUDE.md Rule 6. Was the original cause of the weekly-update bug; unpin carefully.
4. **X-Robots-Tag missing on /api/ask** — added to /legal Response but not on the synthesis route.
5. **DMCA email** (`takedown@asktheallinexperts.vercel.app`) — not verified end-to-end. Needs MX record or alias to a real inbox.
6. **Verifier hover tooltips** — currently `title=` attribute, could be a styled popover.

## Files index

- **ADRs**: `docs/adr/0027-post-generation-claim-verifier.md`, `docs/adr/0028-rvf-fsync-known-issue.md`
- **APIs**: `web/src/app/api/ask/route.ts` (synthesis), `/api/health`, `/api/perf`, `/api/chapters`, `/api/visit`, `/api/stats`, `/api/rate`
- **Libs**: `web/src/lib/validate-citations.ts` (verifier), `rate-limit.ts`, `engagement.ts`, `pi-brain.ts`, `perf-stats.ts`, `rerank.ts`
- **Build**: `scripts/build-knowledge-base.mjs`, `scripts/build-idf.mjs` (now produces doc-lengths.json), `scripts/process-captions.mjs`, `scripts/extract-chapters.mjs`
- **QA**: `scripts/qa-20-questions.mjs` + `scripts/qa-ci.mjs` (canonical pair). One-shot variants archived in `scripts/archive/`.
- **Ops**: `scripts/weekly-update.sh`, `scripts/cache-warm.mjs`, `scripts/cache-warm-queries.json`
- **Data**: `data/qa/baseline.json` (81), `data/qa/latest.json` (83.8, iter-5), `data/qa/verifier-stats.jsonl`

## Security notes

- `QA_BYPASS_TOKEN=e8a16ab3-e106-4641-8cb5-2e13a1b890e4` lives in Vercel production env. Never commit. Already in `.gitignore` patterns. Local export: `export QA_BYPASS_TOKEN=…` before running `node scripts/qa-ci.mjs`.
- Token grants unmetered API access. Rotate if leaked.

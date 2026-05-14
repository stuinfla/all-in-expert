# Next Session Pickup — All-In Expert

**Read this first on session restart. Full memory also in `~/.claude/projects/-Users-stuartkerr-Code-All-In-Expert/memory/`.**

## Immediate priorities (in order)

### 1. Fix production semantic search (blocks everything else)
Production returns `searchMode: "tfidf"` instead of `"semantic"` despite embeddings.bin being deployed. See `memory/production_debug.md`. Start with:
```bash
cd "/Users/stuartkerr/Code/All In Expert/web"
vercel logs https://asktheallinexperts.vercel.app | grep -E "semanticSearchBin|embedQuery"
```
Figure out which step is failing (binary load vs OpenAI embed), fix, redeploy, verify with:
```bash
curl -s -X POST https://asktheallinexperts.vercel.app/api/ask \
  -H "Content-Type: application/json" \
  -d '{"query":"anthropic"}' | python3 -c "import sys,json;print(json.load(sys.stdin).get('searchMode'))"
# expect: semantic
```

### 2. Integrate Pi-Brain (Stuart's last explicit ask)
`memory/pi_brain_integration.md` has the full plan. TL;DR:
- Pi-Brain is at `https://pi.ruv.io/sse` (globally loaded MCP, 21 tools)
- Primary win: query-cache pre-retrieval → near-instant repeat answers
- Load tools via ToolSearch with query `+pi-brain` or explore with no filter
- Pattern: check pi-brain → if cached → return instantly; else → retrieve+synthesize → store back

### 3. Re-run the 20-question QA harness
```bash
cd "/Users/stuartkerr/Code/All In Expert"
node scripts/qa-20-questions.mjs            # full 20
node scripts/qa-20-questions.mjs --pilot    # first 5
```
Target: avg ≥ 98. First pilot scored ~67 before the IDF/Haiku/facts fixes — never re-run.
Fix anything <85, redeploy, re-run.

## Key facts to remember

- **Live URL**: https://asktheallinexperts.vercel.app
- **Last deployed commit**: `090ce3d` on main
- **Domain alias** auto-points to latest deploy; always run `vercel alias set <new-url> asktheallinexperts.vercel.app` after `vercel --prod`
- **Env vars in Vercel**: ANTHROPIC_API_KEY, OPENAI_API_KEY, DATABASE_URL, DB_HOST (all production)
- **Auto-update cron**: `com.isovision.all-in-expert.weekly` at `~/Library/LaunchAgents/`, runs Saturdays 4 AM
- **All four bestie photos** are CC-licensed from Wikimedia Commons with credits in footer

## Data pipeline order (if rebuilding from scratch)
```bash
bash scripts/bulk-download.sh 500          # YouTube captions
node scripts/process-captions.mjs          # parse chunks
node scripts/build-knowledge-base.mjs      # content-index + RVF
node scripts/build-embeddings-openai.mjs   # OpenAI vectors (~$0.10)
node scripts/build-idf.mjs                  # IDF for fallback
node scripts/build-episode-dates.mjs       # recency map
node scripts/extract-chapters.mjs          # RSS chapters
```

## What NOT to rebuild
- Don't touch the bestie photos or footer attributions — CC BY-SA 4.0 requires them
- Don't swap the embedding model without re-running build-embeddings-openai.mjs
- Don't delete `bestie-facts.json` — it's the ground-truth override layer that fixed the Sacks/Republican issue

## Open questions for Stuart on pickup
- Is $0.10/rebuild for OpenAI embeddings acceptable long-term?
- Should the 20Q QA harness run on every deploy as a pre-check, or only manually?
- Does the Pi-Brain integration plan (cache + voting + drift) match his vision?

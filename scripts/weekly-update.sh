#!/bin/bash
# Auto-update for All-In Expert KB.
# Refreshes RSS, downloads new episode captions, rebuilds the knowledge base,
# and redeploys to Vercel.
#
# Scheduled DAILY at 4:00 AM by LaunchAgent com.isovision.all-in-expert.weekly
# and invoked with "--if-stale 3": it only does the heavy rebuild when the KB
# is >= 3 days old, so effective cadence is "every 3 days" with a same-day
# automatic retry after any failure. An independent watchdog
# (com.isovision.all-in-expert.watchdog) alerts if the KB ever goes stale.
#
# HISTORY: silently dead 2026-05-30 .. 2026-06-19 because node_modules was wiped
# (git-ignored, so no git signal) -> ERR_MODULE_NOT_FOUND crashed the pipeline
# before commit/deploy, into an unwatched log. The preflight check + EXIT-trap
# alert + watchdog below exist to make that class of silent failure impossible.

set -o pipefail
ROOT="/Users/stuartkerr/Code/All In Expert"
LOG_DIR="$HOME/.claude/logs"
LOG_FILE="$LOG_DIR/all-in-expert-weekly.log"
mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] $*" | tee -a "$LOG_FILE"
}

# --- pinned toolchain: avoid the /usr/local node v22 vs /opt/homebrew v25
#     ambiguity that the LaunchAgent PATH would otherwise resolve unpredictably.
export PATH="$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
NODE="/opt/homebrew/bin/node"
NPM="/opt/homebrew/bin/npm"

# --- pipeline secrets: load from .env + web/.env.local and EXPORT so EVERY child
#     node step inherits them under the bare launchd env (PATH+HOME only). General
#     cure for the 2026-06/07 class — a secret present in the interactive shell but
#     absent from the daemon: build-embeddings needs OPEN_AI_KEY, cache-warm needs
#     QA_BYPASS_TOKEN, qa-ci needs ANTHROPIC_API_KEY (qa-ci.mjs explicitly expects
#     the parent shell to export it). Parse — never `source` — to avoid executing
#     file contents. Values are never logged. Later file wins (web/.env.local last).
export_secret() {  # $1=VAR  $2=file
    [ -f "$2" ] || return 0
    local line val
    line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$1=" "$2" 2>/dev/null | tail -1)
    [ -n "$line" ] || return 0
    val=${line#*=}                        # value after first '='
    val=${val%$'\r'}                      # strip trailing CR (CRLF files)
    val=${val#[\"\']}; val=${val%[\"\']}  # strip one layer of surrounding quotes
    [ -n "$val" ] && export "$1=$val"
}
for _envf in "$ROOT/.env" "$ROOT/web/.env.local"; do
    for _k in OPEN_AI_KEY OPENAI_API_KEY ANTHROPIC_API_KEY QA_BYPASS_TOKEN AIE_NTFY_TOPIC; do
        export_secret "$_k" "$_envf"
    done
done

# ntfy phone push. On ntfy.sh the topic name IS the credential — anyone who knows
# it can read these alerts or publish spoofed ones. It therefore lives ONLY in
# .env (git-ignored) and in the Vercel env, never in this file: the previous
# hardcoded fallback sat in a PUBLIC repo. Rotated 2026-07-09.
# If it is unset we still log + desktop-notify; we just cannot push to the phone.
AIE_NTFY_TOPIC="${AIE_NTFY_TOPIC:-}"
ntfy_push() {  # $1=title  $2=body  $3=priority(default high)  $4=tags(default warning)
    [ -n "$AIE_NTFY_TOPIC" ] || return 0
    curl -sf --max-time 10 -H "Title: $1" -H "Priority: ${3:-high}" -H "Tags: ${4:-warning}" \
        -d "$2" "https://ntfy.sh/${AIE_NTFY_TOPIC}" >/dev/null 2>&1 || true
}

STATUS_FILE="$LOG_DIR/all-in-expert-weekly.status"
# Timestamp of the last ACTUAL completed rebuild+deploy. Distinct from STATUS_FILE
# on purpose: STATUS tracks "did the last run error?", REFRESH_TS_FILE tracks "when
# did data last actually refresh?". The gate measures staleness against THIS file —
# a daily skip must NOT touch it, or the 3-day clock would reset forever and the KB
# would silently re-freeze.
REFRESH_TS_FILE="$LOG_DIR/all-in-expert-last-refresh.ts"
ALERT_LOG="$LOG_DIR/all-in-expert-ALERTS.log"
LOCK_DIR="$LOG_DIR/all-in-expert-weekly.lock"
CURRENT_STEP="startup"
RUN_OK=0
DID_FULL_RUN=0   # set to 1 only after a full pipeline completes (NOT on a gate skip)

# --- single-instance lock (mkdir is atomic; flock is unavailable on macOS) ---
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "Another weekly-update run holds the lock — exiting."
    exit 0
fi

# --- keep the Mac awake for the whole run. On 2026-07-03 the KB rebuild died at
#     9% (exit 0, killed mid-embed) because the machine idle-slept at 4am. caffeinate
#     -w "$$" asserts "no idle/system sleep" until THIS pid exits, then stops itself.
caffeinate -i -s -w "$$" 2>/dev/null &

# --- loud failure on ANY exit path. The 3-week silent outage happened because
#     failures only landed in an unwatched logfile. This trap ends that: every
#     non-OK exit writes a .status file, an ALERTS line, and a desktop alert.
finish() {
    local ec=$?
    rmdir "$LOCK_DIR" 2>/dev/null
    if [ "$RUN_OK" = "1" ]; then
        echo "OK $(date '+%Y-%m-%dT%H:%M:%S%z')" > "$STATUS_FILE"
        # Only a real rebuild advances the freshness clock — skips must not.
        [ "$DID_FULL_RUN" = "1" ] && date '+%Y-%m-%dT%H:%M:%S%z' > "$REFRESH_TS_FILE"
    else
        echo "FAILED step=$CURRENT_STEP exit=$ec $(date '+%Y-%m-%dT%H:%M:%S%z')" > "$STATUS_FILE"
        log "‼️ WEEKLY UPDATE FAILED at step: $CURRENT_STEP (exit $ec)"
        echo "[$(date '+%F %T %Z')] FAILED step=$CURRENT_STEP exit=$ec" >> "$ALERT_LOG"
        /usr/bin/osascript -e "display notification \"Failed at: $CURRENT_STEP — KB NOT updated\" with title \"⚠️ All-In Expert update FAILED\" sound name \"Basso\"" 2>/dev/null || true
        ntfy_push "⚠️ All-In Expert update FAILED" "Failed at: $CURRENT_STEP (exit $ec). KB NOT updated — check all-in-expert-weekly.log" urgent "rotating_light"
    fi
}
trap finish EXIT

# --- staleness gate. Daily LaunchAgent passes "--if-stale 3": skip the rebuild
#     only if the last ACTUAL rebuild (REFRESH_TS_FILE) was < N days ago. A skip
#     does NOT advance that clock, so the cadence stays a true "every N days".
#     Retry-on-failure is automatic: a failed run never writes REFRESH_TS_FILE,
#     so the next day still reads as stale and re-runs (self-healing).
if [ "$1" = "--if-stale" ]; then
    MAXAGE="$2"; shift 2
    LAST_REFRESH=""
    [ -f "$REFRESH_TS_FILE" ] && LAST_REFRESH=$(cat "$REFRESH_TS_FILE" 2>/dev/null)
    if [ -n "$LAST_REFRESH" ] && \
       "$NODE" -e "const a=(Date.now()-Date.parse('$LAST_REFRESH'))/864e5;process.exit((a>=0&&a<$MAXAGE)?0:1)" 2>/dev/null; then
        log "Last rebuild < ${MAXAGE}d ago ($LAST_REFRESH) — skipping (heartbeat)."
        RUN_OK=1
        exit 0
    fi
    log "Last rebuild missing or >= ${MAXAGE}d ago — refresh needed."
fi

log "═══ Weekly All-In Expert update starting ═══"
cd "$ROOT" || { log "ERROR: Cannot cd to $ROOT"; exit 1; }

# 0. Preflight — the EXACT guard for the 2026-05-30 outage. Verify required
#    deps resolve; self-heal with npm ci if node_modules was wiped; fail loud
#    if they still can't load (rather than crashing silently mid-pipeline).
CURRENT_STEP="preflight (dependencies)"
log "Preflight: verifying toolchain + dependencies..."
[ -x "$NODE" ] || { log "ERROR: node missing at $NODE"; exit 1; }
need=0
for pkg in fast-xml-parser @xenova/transformers @ruvector/rvf ruvector; do
    [ -d "node_modules/$pkg" ] || { log "  missing dep: $pkg"; need=1; }
done
if [ "$need" = "1" ]; then
    log "Dependencies missing — self-healing via npm ci..."
    "$NPM" ci >> "$LOG_FILE" 2>&1 || "$NPM" install >> "$LOG_FILE" 2>&1 || { log "ERROR: npm install failed"; exit 1; }
fi
"$NODE" --input-type=module -e "await import('fast-xml-parser');await import('@xenova/transformers');await import('@ruvector/rvf');" >> "$LOG_FILE" 2>&1 || { log "ERROR: required modules unresolved after install"; exit 1; }
log "Preflight OK."

# 0b. Preflight — required secrets. THE FIX for the 2026-06/07 silent-failure loop:
#     the OpenAI key lived only in the interactive shell, absent from .env and the
#     LaunchAgent env, so step 6b (built 20 min in) died on `!apiKey` every night.
#     Check it HERE — present AND live — so a missing/expired key fails in seconds
#     through the same finish() alert path, never again after a wasted rebuild.
#     Loads the exact same sources the embed script uses (.env + web/.env.local).
CURRENT_STEP="preflight (OpenAI key)"
log "Preflight: verifying OpenAI key (resolve + live)..."
"$NODE" --input-type=module -e '
import { config } from "dotenv";
config({ path: ".env" }); config({ path: "web/.env.local" });
const key = process.env.OPEN_AI_KEY || process.env.OPENAI_API_KEY;
if (!key) { console.error("OpenAI key MISSING from process env + .env + web/.env.local"); process.exit(1); }
const r = await fetch("https://api.openai.com/v1/embeddings", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
  body: JSON.stringify({ model: "text-embedding-3-small", input: "preflight", dimensions: 384 }),
});
if (!r.ok) { console.error("OpenAI key REJECTED: HTTP " + r.status + " " + (await r.text()).slice(0, 160)); process.exit(1); }
console.log("OpenAI key live (HTTP 200).");
' >> "$LOG_FILE" 2>&1 || { log "ERROR: OpenAI key preflight failed — key missing or not live (fix .env OPEN_AI_KEY)"; exit 1; }
log "Preflight OpenAI key OK (live)."

# 1. Refresh RSS feed (get latest episodes)
CURRENT_STEP="RSS download"
log "Refreshing RSS feed..."
# Retry transient blips (the 06-27/06-28 curl failures that nuked whole runs) and
# download to a temp file first so a partial fetch can never clobber a good feed.
curl -sL --retry 4 --retry-delay 5 --retry-all-errors --max-time 90 \
    "https://rss.libsyn.com/shows/254861/destinations/1928300.xml" \
    -o "data/episodes/rss_feed.xml.tmp" \
    && [ -s "data/episodes/rss_feed.xml.tmp" ] \
    && grep -q "<rss" "data/episodes/rss_feed.xml.tmp" \
    && mv "data/episodes/rss_feed.xml.tmp" "data/episodes/rss_feed.xml" || {
    rm -f "data/episodes/rss_feed.xml.tmp"
    log "ERROR: RSS download failed after retries (persistent outage — existing feed kept)"
    exit 1
}
log "RSS feed refreshed ($(wc -c < data/episodes/rss_feed.xml) bytes)"

# 2. Re-parse RSS into metadata JSON
CURRENT_STEP="RSS parse"
log "Parsing RSS metadata..."
python3 -c "
import xml.etree.ElementTree as ET
import json
from datetime import datetime

tree = ET.parse('data/episodes/rss_feed.xml')
root = tree.getroot()
ns = {'itunes': 'http://www.itunes.com/dtds/podcast-1.0.dtd'}

episodes = []
for item in root.findall('.//item'):
    title = item.find('title').text if item.find('title') is not None else ''
    pub_date = item.find('pubDate').text if item.find('pubDate') is not None else ''
    enclosure = item.find('enclosure')
    audio_url = enclosure.get('url', '') if enclosure is not None else ''
    duration = item.find('itunes:duration', ns)
    dur_text = duration.text if duration is not None else ''
    try:
        dt = datetime.strptime(pub_date.strip(), '%a, %d %b %Y %H:%M:%S %z')
        date_str = dt.strftime('%Y-%m-%d')
        year = dt.year
        month = dt.month
    except:
        date_str = pub_date
        year = 0
        month = 0
    if year >= 2024 and (year > 2024 or month >= 4):
        episodes.append({
            'title': title, 'date': date_str,
            'audio_url': audio_url, 'duration': dur_text
        })
with open('data/episodes/episodes_metadata.json', 'w') as f:
    json.dump(episodes, f, indent=2)
print(f'{len(episodes)} episodes')
" >> "$LOG_FILE" 2>&1 || { log "ERROR: RSS parse failed"; exit 1; }

# 3. Refresh YouTube video ID list
CURRENT_STEP="YouTube catalog"
log "Refreshing YouTube video catalog..."
# Write to .tmp then mv. The old form redirected straight onto the TSV, and the
# shell TRUNCATES a redirect target before the command runs — so when yt-dlp
# failed, the "existing TSV" the WARN claimed to keep had already been destroyed.
# Found 2026-07-09 with the file sitting at 0 bytes.
if yt-dlp --flat-playlist --print "%(id)s\t%(title)s" \
        "https://www.youtube.com/@allin/videos" 2>/dev/null \
        > data/episodes/all_video_ids_raw.tsv.tmp \
        && [ -s data/episodes/all_video_ids_raw.tsv.tmp ]; then
    mv data/episodes/all_video_ids_raw.tsv.tmp data/episodes/all_video_ids_raw.tsv
else
    rm -f data/episodes/all_video_ids_raw.tsv.tmp
    log "WARN: yt-dlp flat-playlist failed or returned nothing; existing TSV preserved"
fi
if [ -s data/episodes/all_video_ids_raw.tsv ]; then
    # Fix literal \t issue
    python3 -c "
with open('data/episodes/all_video_ids_raw.tsv','r') as f:
    c = f.read()
with open('data/episodes/all_video_ids.tsv','w') as f:
    f.write(c.replace('\\\\t', '\t'))
"
    rm -f data/episodes/all_video_ids_raw.tsv
    log "YouTube catalog: $(wc -l < data/episodes/all_video_ids.tsv) videos"
fi

# 4. Download any new episode captions
CURRENT_STEP="caption download"
log "Downloading new captions..."
bash scripts/bulk-download.sh 500 >> "$LOG_FILE" 2>&1 || {
    log "WARN: Some caption downloads failed (continuing)"
}

# 5. Reprocess transcripts (includes new episodes)
CURRENT_STEP="transcript processing"
log "Reprocessing transcripts..."
"$NODE" scripts/process-captions.mjs >> "$LOG_FILE" 2>&1 || {
    log "ERROR: Transcript processing failed"
    exit 1
}

# 6. Rebuild knowledge base with real embeddings
CURRENT_STEP="KB rebuild"
log "Rebuilding knowledge base..."
rm -f data/kb/all-in-expert.rvf 2>/dev/null
"$NODE" scripts/build-knowledge-base.mjs >> "$LOG_FILE" 2>&1 || {
    log "ERROR: KB rebuild failed"
    exit 1
}

# 6b. Build the SERVED semantic index in OpenAI vector space. build-knowledge-base
#     (step 6) only writes MiniLM vectors to data/kb for the RVF build; the serve path
#     embeds queries with OpenAI, so web/public/data/embeddings.bin MUST be OpenAI-space
#     or cosine search returns noise. This script is the single owner of the served bin.
CURRENT_STEP="OpenAI embeddings (served bin)"
log "Building OpenAI embeddings (served bin)..."
"$NODE" scripts/build-embeddings-openai.mjs >> "$LOG_FILE" 2>&1 || {
    log "ERROR: OpenAI embedding build failed (OPENAI_API_KEY / OPEN_AI_KEY set?)"
    exit 1
}

# 6c. Rebuild the TF-IDF / BM25 sparse index so new episodes are weighted correctly
#     (route.ts reads idf.json + doc-lengths.json for the sparse retrieval leg).
CURRENT_STEP="TF-IDF index"
log "Rebuilding TF-IDF index..."
"$NODE" scripts/build-idf.mjs >> "$LOG_FILE" 2>&1 || {
    log "ERROR: TF-IDF index build failed"
    exit 1
}

# 7. Rebuild chapter index (topics from show notes)
CURRENT_STEP="chapter extraction"
log "Rebuilding chapter index..."
"$NODE" scripts/extract-chapters.mjs >> "$LOG_FILE" 2>&1 || {
    log "ERROR: Chapter extraction failed"
    exit 1
}

# 8. Rebuild episode-dates for recency weighting
CURRENT_STEP="episode dates"
log "Rebuilding episode dates map..."
"$NODE" scripts/build-episode-dates.mjs >> "$LOG_FILE" 2>&1 || {
    log "WARN: Episode dates build failed (continuing)"
}

# 9. Commit data changes
CURRENT_STEP="git commit/push"
log "Committing data changes..."
cd "$ROOT"
git add web/public/data/ data/kb/_manifest.json 2>/dev/null
if git diff --cached --quiet; then
    log "No data changes to commit"
else
    git commit -m "Weekly KB refresh: $(date '+%Y-%m-%d')

Auto-generated by weekly-update.sh
- Refreshed RSS, captions, transcripts
- Rebuilt RVF knowledge base
- Re-indexed chapters from show notes

🤖 Automated weekly update" >> "$LOG_FILE" 2>&1
    git push origin main >> "$LOG_FILE" 2>&1 || log "WARN: Git push failed"
fi

# 10. Deploy to Vercel — capture stdout so we can parse the new deployment URL
CURRENT_STEP="vercel deploy"
log "Deploying to Vercel..."
cd "$ROOT/web"
DEPLOY_OUT=$(vercel --prod --yes --scope stuart-kerrs-projects 2>&1); VC_RC=$?
echo "$DEPLOY_OUT" >> "$LOG_FILE"
# Fail loud if vercel returned non-zero AND no production URL is present. Capture
# VC_RC on the SAME line as the vercel call — the previous check read $? from the
# echo above (always 0), so a FAILED deploy could never trip this branch and the
# run would 'succeed' with stale prod. Match the real URL, not the never-present
# literal "Production:" (vercel prints "Production   https://web-…", no colon).
if [ "$VC_RC" -ne 0 ] && ! echo "$DEPLOY_OUT" | grep -qE 'https://web-[a-z0-9]+-stuart-kerrs-projects\.vercel\.app'; then
    log "ERROR: Vercel deploy failed (rc=$VC_RC)"
    exit 1
fi
DEPLOY_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://web-[a-z0-9]+-stuart-kerrs-projects\.vercel\.app' | head -1)

# 11. Re-alias asktheallinexperts.vercel.app → fresh deployment
if [ -z "$DEPLOY_URL" ]; then
    log "WARN: Could not extract deployment URL from Vercel output; alias not updated"
else
    log "Aliasing $DEPLOY_URL → asktheallinexperts.vercel.app"
    vercel alias set "$DEPLOY_URL" asktheallinexperts.vercel.app --scope stuart-kerrs-projects >> "$LOG_FILE" 2>&1 || {
        log "WARN: Re-alias failed"
    }
fi

# 11b. Warm response cache so first real user after deploy doesn't pay
# full cold-start latency. Best-effort — cache-warm.mjs always exits 0,
# and we additionally wrap with `|| log "WARN: ..."` so even a fatal
# script crash can't fail the weekly pipeline.
cd "$ROOT"
CURRENT_STEP="cache warm"
log "Warming response cache..."
"$NODE" scripts/cache-warm.mjs >> "$LOG_FILE" 2>&1 || log "WARN: Cache warm partial"

# 12. QA regression check — runs the 20-Q harness against prod, compares
# vs data/qa/baseline.json, flags regressions in the log. Never blocks
# the weekly pipeline; the qa-ci script exits 0 on infra issues and only
# exits 1 on real quality regressions (which we log as WARN here so the
# rest of the run still completes).
cd "$ROOT"
CURRENT_STEP="QA regression"
log "Running QA regression check..."
# QA stays deliberately NON-BLOCKING: a quality dip must never stop a data
# refresh (qa-ci.mjs exits 0 on infra problems, 1 only on a real regression).
# But non-blocking must not mean invisible. Until 2026-07-09 a regression was a
# lone WARN buried in this log — and the harness had in fact been silently
# skipping for weeks (no ANTHROPIC_API_KEY under launchd), so nobody noticed.
# Now: every regression writes a durable ALERTS line, and the phone rings only
# when it got WORSE than the last run — otherwise a known, unchanged failure
# would page on every single run until it was fixed, and get tuned out.
QA_STATE_FILE="$LOG_DIR/all-in-expert-qa.state"   # "<overall>|<sorted below-floor ids>"
qa_signature() {
    "$NODE" -e '
      const fs = require("fs");
      const latest = "data/qa/latest.json", base = "data/qa/baseline.json";
      if (!fs.existsSync(latest) || !fs.existsSync(base)) { process.stdout.write(""); process.exit(0); }
      const j = JSON.parse(fs.readFileSync(latest, "utf8"));
      const floor = JSON.parse(fs.readFileSync(base, "utf8")).perQuestionFloor ?? 60;
      const below = (j.perQuestion || []).filter((q) => q.overall > 0 && q.overall < floor).map((q) => q.id).sort();
      process.stdout.write(`${j.overall}|${below.join(",")}`);
    ' 2>/dev/null
}
if "$NODE" scripts/qa-ci.mjs >> "$LOG_FILE" 2>&1; then
    log "QA regression check: PASS"
    qa_signature > "$QA_STATE_FILE"
else
    NEW_SIG=$(qa_signature); OLD_SIG=$(cat "$QA_STATE_FILE" 2>/dev/null || true)
    NEW_OVERALL=${NEW_SIG%%|*}; NEW_BELOW=${NEW_SIG#*|}
    OLD_OVERALL=${OLD_SIG%%|*}; OLD_BELOW=${OLD_SIG#*|}
    log "WARN: QA regression detected (overall=${NEW_OVERALL:-?} below_floor=[${NEW_BELOW}])"
    echo "[$(date '+%F %T %Z')] QA REGRESSION overall=${NEW_OVERALL:-?} below_floor=[${NEW_BELOW}]" >> "$ALERT_LOG"

    WORSE=0
    [ -z "$OLD_SIG" ] && WORSE=1          # first observation — say it once
    for _q in ${NEW_BELOW//,/ }; do       # a question that newly fell below the floor
        case ",$OLD_BELOW," in *",$_q,"*) ;; *) WORSE=1 ;; esac
    done
    # overall dropped 2+ points since last run (a 1-point move is grader jitter)
    if [ -n "$NEW_OVERALL" ] && [ -n "$OLD_OVERALL" ] && [ "$NEW_OVERALL" -le "$((OLD_OVERALL - 2))" ]; then
        WORSE=1
    fi

    if [ "$WORSE" = "1" ]; then
        ntfy_push "⚠️ All-In Expert QA regression" \
            "overall=${NEW_OVERALL:-?} (was ${OLD_OVERALL:-n/a}); below floor: [${NEW_BELOW}]. KB still refreshed." \
            high "chart_with_downwards_trend"
        log "QA regression WORSE than last run — phone alert sent."
    else
        log "QA regression unchanged vs last run — ALERTS entry only, no phone push."
    fi
    qa_signature > "$QA_STATE_FILE"
fi

# 12b. Publish the QA summary into the deployed bundle. /api/health can ONLY read
# web/public/data/qa-{latest,baseline}.json in production: Vercel bundles just
# web/ (cwd=/var/task), so the repo-root data/qa/ never ships. Nothing published
# these before 2026-07-09, so qaLatest was permanently null and health fell back
# to a May-2026 baseline advertising 81 while the real score was 67.
#
# These land in the NEXT deploy, not this one — QA necessarily runs against the
# build that is already live, so prod always reports the previous run's score.
# That is correct and intentional; the timestamp in the payload makes it legible.
# They also get auto-committed, since step 9 stages web/public/data/.
for _qa in latest baseline; do
    if [ -f "data/qa/$_qa.json" ]; then
        cp -f "data/qa/$_qa.json" "web/public/data/qa-$_qa.json" \
            || log "WARN: could not publish qa-$_qa.json into the bundle"
    fi
done

RUN_OK=1
DID_FULL_RUN=1
log "═══ Weekly update complete ═══"
echo "" >> "$LOG_FILE"

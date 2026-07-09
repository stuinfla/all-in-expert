#!/bin/bash
# Independent freshness watchdog for the All-In Expert KB.
#
# Reads the weekly-update .status file (last run errored?) and the last-rebuild
# timestamp file (when data actually last refreshed) and raises a LOUD, user-
# visible alert if the last run FAILED OR no rebuild happened within the ceiling.
# Intentionally lightweight and ALERT-ONLY — it never rebuilds anything, so it
# cannot loop or interfere with the refresh job.
#
# This is the backstop: even if com.isovision.all-in-expert.weekly gets unloaded
# or wedged (the failure mode that hid for 3 weeks in June 2026), THIS agent
# still notices the data went stale and tells you.
#
# Scheduled DAILY at 10:00 by LaunchAgent com.isovision.all-in-expert.watchdog
# (10am so the desktop notification lands when someone is actually at the Mac).

ROOT="/Users/stuartkerr/Code/All In Expert"
LOG_DIR="$HOME/.claude/logs"
ALERT_LOG="$LOG_DIR/all-in-expert-ALERTS.log"
HEARTBEAT_LOG="$LOG_DIR/all-in-expert-heartbeat.log"
STATUS_FILE="$LOG_DIR/all-in-expert-weekly.status"
REFRESH_TS_FILE="$LOG_DIR/all-in-expert-last-refresh.ts"   # last ACTUAL rebuild (not skips)
CEILING_DAYS=4          # target cadence is 3 days; alarm once we blow past 4
NODE="/opt/homebrew/bin/node"
[ -x "$NODE" ] || NODE="/usr/local/bin/node"
# ntfy phone push — dedicated topic (subscribe to it once in the ntfy app).
# The topic name IS the credential on ntfy.sh, so it lives only in .env
# (git-ignored) — this repo is public and the old hardcoded topic was readable
# by anyone. Parse, never `source`: .env must not be executed. Rotated 2026-07-09.
# launchd gives this script only PATH+HOME, so nothing is inherited from a shell.
if [ -z "${AIE_NTFY_TOPIC:-}" ] && [ -f "$ROOT/.env" ]; then
    _line=$(grep -E '^[[:space:]]*(export[[:space:]]+)?AIE_NTFY_TOPIC=' "$ROOT/.env" 2>/dev/null | tail -1)
    _val=${_line#*=}; _val=${_val%$'\r'}; _val=${_val#[\"\']}; _val=${_val%[\"\']}
    AIE_NTFY_TOPIC="$_val"
fi
# Empty topic ⇒ no phone push. ALERTS log + desktop notification still fire.
AIE_NTFY_TOPIC="${AIE_NTFY_TOPIC:-}"

mkdir -p "$LOG_DIR"
cd "$ROOT" || exit 0
ts() { date '+%F %T %Z'; }

alert() {
    echo "[$(ts)] WATCHDOG ALERT: $1" >> "$ALERT_LOG"
    /usr/bin/osascript -e "display notification \"$1\" with title \"⚠️ All-In Expert KB STALE\" sound name \"Basso\"" 2>/dev/null || true
    [ -n "$AIE_NTFY_TOPIC" ] && curl -sf --max-time 10 \
        -H "Title: ⚠️ All-In Expert KB STALE" -H "Priority: urgent" -H "Tags: rotating_light" \
        -d "$1" "https://ntfy.sh/${AIE_NTFY_TOPIC}" >/dev/null 2>&1 || true
}

# Two independent health signals (deliberately NOT freshness.json — a partial
# build bumps that without deploying, masking a dead pipeline):
#   1. STATUS_FILE   — did the LAST run error? (catches a fresh failure fast)
#   2. REFRESH_TS_FILE — when did data ACTUALLY last rebuild? (catches a stalled
#      or unloaded job: this clock only advances on a real rebuild, so if the job
#      dies it ages past the ceiling and we alert).
STATE=""
[ -f "$STATUS_FILE" ] && read -r STATE _ < "$STATUS_FILE"
LAST_REFRESH=""
[ -f "$REFRESH_TS_FILE" ] && LAST_REFRESH=$(cat "$REFRESH_TS_FILE" 2>/dev/null)

if [ "$STATE" = "FAILED" ]; then
    alert "Last KB refresh FAILED ($(cat "$STATUS_FILE")). Check ${LOG_DIR}/all-in-expert-weekly.log"
elif [ -n "$LAST_REFRESH" ] && \
     "$NODE" -e "const a=(Date.now()-Date.parse('$LAST_REFRESH'))/864e5;process.exit((a>=0&&a<=$CEILING_DAYS)?0:1)" 2>/dev/null; then
    AGE=$("$NODE" -e "console.log(((Date.now()-Date.parse('$LAST_REFRESH'))/864e5).toFixed(2))" 2>/dev/null)
    echo "[$(ts)] watchdog OK: last rebuild ${AGE}d ago" >> "$HEARTBEAT_LOG"
else
    alert "No KB rebuild within ${CEILING_DAYS}d (last rebuild: ${LAST_REFRESH:-NEVER}). Check ${LOG_DIR}/all-in-expert-weekly.log"
fi

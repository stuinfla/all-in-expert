#!/bin/bash
# Bulk download YouTube auto-captions for All-In Podcast
# Usage: ./scripts/bulk-download.sh [batch_size]
# Skips already-downloaded files automatically

set -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CAPTIONS_DIR="$ROOT/data/captions"
VIDEO_IDS_FILE="$ROOT/data/episodes/all_video_ids.tsv"
BATCH_SIZE="${1:-50}"
DELAY=2

mkdir -p "$CAPTIONS_DIR"

total=0
downloaded=0
skipped=0
failed=0

while IFS=$'\t' read -r vid title; do
    [ -z "$vid" ] && continue
    total=$((total + 1))

    # Skip if already downloaded
    if [ -f "$CAPTIONS_DIR/${vid}.en.json3" ]; then
        skipped=$((skipped + 1))
        continue
    fi

    # Stop at batch size
    if [ $downloaded -ge $BATCH_SIZE ]; then
        echo "Batch limit ($BATCH_SIZE) reached. Run again to continue."
        break
    fi

    echo -n "[$((downloaded + 1))/$BATCH_SIZE] $vid - ${title:0:60}... "

    if yt-dlp --write-auto-subs --sub-lang en --sub-format json3 --skip-download \
        --extractor-args "youtube:player_client=default" --no-warnings \
        -o "$CAPTIONS_DIR/%(id)s" \
        "https://www.youtube.com/watch?v=${vid}" >/dev/null 2>&1; then
        echo "OK"
        downloaded=$((downloaded + 1))
    else
        echo "FAIL"
        failed=$((failed + 1))
    fi

    sleep $DELAY
done < "$VIDEO_IDS_FILE"

echo ""
echo "=== Summary ==="
echo "Total in catalog: $total"
echo "Downloaded this run: $downloaded"
echo "Previously cached: $skipped"
echo "Failed: $failed"
echo "Total captions on disk: $(ls "$CAPTIONS_DIR"/*.json3 2>/dev/null | wc -l | tr -d ' ')"

#!/bin/bash
# Refresh the knowledge base: process captions + rebuild RVF + rebuild profiles
# Run after downloading new captions
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== Processing captions ==="
node scripts/process-captions.mjs

echo ""
echo "=== Rebuilding knowledge base ==="
rm -f data/kb/all-in-expert.rvf 2>/dev/null
node scripts/build-knowledge-base.mjs

echo ""
echo "=== Done ==="
echo "Query with: node src/query.mjs \"your question\""

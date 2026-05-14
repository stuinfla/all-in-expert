#!/usr/bin/env node
/**
 * Build IDF (inverse document frequency) lookup for the keyword search path.
 * Rare terms get high IDF weight — so a segment mentioning "anthropic" scores
 * far above one mentioning "besties" even if both match the query.
 *
 * Output 1: idf.json — { term: idf_score } for all terms appearing in >=2 docs.
 * Output 2: doc-lengths.json — { [chunkId]: tokenCount, "__avgdl__": number }
 *   Required for BM25-Okapi scoring in tfidfSearch (k1=1.5, b=0.75).
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CONTENT_INDEX = join(ROOT, 'web', 'public', 'data', 'content-index.json');
const OUT_LOCAL = join(ROOT, 'data', 'kb', 'idf.json');
const OUT_WEB = join(ROOT, 'web', 'public', 'data', 'idf.json');
const OUT_DOC_LENGTHS_LOCAL = join(ROOT, 'data', 'kb', 'doc-lengths.json');
const OUT_DOC_LENGTHS_WEB = join(ROOT, 'web', 'public', 'data', 'doc-lengths.json');

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && w.length < 30);
}

function main() {
  console.log('Loading content index...');
  const index = JSON.parse(readFileSync(CONTENT_INDEX, 'utf8'));
  const docIds = Object.keys(index);
  const N = docIds.length;
  console.log(`${N} documents`);

  const docFreq = {};
  // Per-document token counts for BM25 avgdl computation
  const docLengths = {};
  let totalTokens = 0;

  for (const id of docIds) {
    const tokens = tokenize(index[id].c);
    docLengths[id] = tokens.length;
    totalTokens += tokens.length;

    const uniqueTokens = new Set(tokens);
    for (const t of uniqueTokens) {
      docFreq[t] = (docFreq[t] || 0) + 1;
    }
  }

  // Compute avgdl for BM25
  const avgdl = totalTokens / N;
  docLengths['__avgdl__'] = avgdl;
  console.log(`avgdl = ${avgdl.toFixed(2)} tokens/chunk`);

  // Compute IDF for terms appearing in 2+ docs (ignore hapax legomena + stopwords)
  const idf = {};
  for (const [term, df] of Object.entries(docFreq)) {
    if (df < 2) continue;
    idf[term] = Math.log(N / df);
  }

  // Stats
  const sorted = Object.entries(idf).sort((a, b) => b[1] - a[1]);
  console.log(`${Object.keys(idf).length} unique terms indexed`);
  console.log('\nRarest (highest IDF):');
  for (const [t, v] of sorted.slice(0, 10)) {
    console.log(`  ${t.padEnd(20)} ${v.toFixed(3)}  (df=${docFreq[t]})`);
  }

  console.log('\nCommon terms (lowest IDF):');
  for (const [t, v] of sorted.slice(-10)) {
    console.log(`  ${t.padEnd(20)} ${v.toFixed(3)}  (df=${docFreq[t]})`);
  }

  // Check specific words
  console.log('\nQuery terms of interest:');
  for (const t of ['anthropic', 'openai', 'chamath', 'besties', 'think', 'about', 'tariffs', 'debt']) {
    const v = idf[t];
    const df = docFreq[t];
    console.log(`  ${t.padEnd(12)} idf=${v ? v.toFixed(3) : 'N/A'}  df=${df || 0}`);
  }

  mkdirSync(dirname(OUT_LOCAL), { recursive: true });
  mkdirSync(dirname(OUT_WEB), { recursive: true });
  writeFileSync(OUT_LOCAL, JSON.stringify(idf));
  writeFileSync(OUT_WEB, JSON.stringify(idf));

  writeFileSync(OUT_DOC_LENGTHS_LOCAL, JSON.stringify(docLengths));
  writeFileSync(OUT_DOC_LENGTHS_WEB, JSON.stringify(docLengths));

  const idfSizeKB = (JSON.stringify(idf).length / 1024).toFixed(0);
  const dlSizeKB = (JSON.stringify(docLengths).length / 1024).toFixed(0);
  console.log(`\nSaved idf.json (${idfSizeKB}KB)`);
  console.log(`Saved doc-lengths.json (${dlSizeKB}KB, ${N} entries + __avgdl__=${avgdl.toFixed(2)})`);
}

main();

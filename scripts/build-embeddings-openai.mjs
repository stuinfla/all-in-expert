#!/usr/bin/env node
/**
 * Re-embed all content segments using OpenAI text-embedding-3-small @ 384 dims.
 *
 * Why: The production app runs in Vercel serverless where @xenova/transformers
 * is unreliable (native WASM + model download over slow paths). OpenAI embeddings
 * are trivially cheap (~$0.10 for the full corpus), reliable everywhere, and
 * give us query/doc vectors in the same space so cosine similarity actually works.
 *
 * Input:  web/public/data/content-index.json
 * Output: web/public/data/embeddings.bin (Float32, 15560 × 384)
 *         web/public/data/embeddings-order.json (ID list in same order)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
config({ path: join(ROOT, '.env') });
config({ path: join(ROOT, 'web', '.env.local') });

const DIMS = 384;
const BATCH_SIZE = 100;
const RETRY_LIMIT = 3;

const CONTENT_INDEX = join(ROOT, 'web', 'public', 'data', 'content-index.json');
const OUT_BIN = join(ROOT, 'web', 'public', 'data', 'embeddings.bin');
const OUT_ORDER = join(ROOT, 'web', 'public', 'data', 'embeddings-order.json');
const LOCAL_BIN = join(ROOT, 'data', 'kb', 'embeddings.bin');
const LOCAL_ORDER = join(ROOT, 'data', 'kb', 'embeddings-order.json');

async function embedBatch(texts, apiKey) {
  let attempt = 0;
  while (attempt < RETRY_LIMIT) {
    try {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: 'text-embedding-3-small',
          input: texts,
          dimensions: DIMS,
          encoding_format: 'float',
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      return data.data.map((d) => d.embedding);
    } catch (err) {
      attempt++;
      console.error(`  Batch retry ${attempt}/${RETRY_LIMIT}: ${err.message}`);
      if (attempt >= RETRY_LIMIT) throw err;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

function normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  return vec;
}

async function main() {
  const apiKey = process.env.OPEN_AI_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Set OPEN_AI_KEY or OPENAI_API_KEY in .env or web/.env.local');
    process.exit(1);
  }

  console.log('Loading content index...');
  const index = JSON.parse(readFileSync(CONTENT_INDEX, 'utf8'));
  const ids = Object.keys(index);
  const N = ids.length;
  console.log(`${N} segments to embed`);

  const embeddings = new Float32Array(N * DIMS);
  const start = Date.now();
  let done = 0;

  for (let i = 0; i < N; i += BATCH_SIZE) {
    const batchIds = ids.slice(i, i + BATCH_SIZE);
    const batchTexts = batchIds.map((id) => index[id].c.slice(0, 2000));

    const vectors = await embedBatch(batchTexts, apiKey);

    for (let j = 0; j < vectors.length; j++) {
      const v = normalize(vectors[j]);
      embeddings.set(v, (i + j) * DIMS);
    }

    done += vectors.length;
    const elapsed = (Date.now() - start) / 1000;
    const rate = done / elapsed;
    const eta = ((N - done) / rate).toFixed(0);
    if (done % (BATCH_SIZE * 10) === 0 || done === N) {
      console.log(`  ${done}/${N} (${(done / N * 100).toFixed(1)}%) · ${rate.toFixed(1)}/sec · ETA ${eta}s`);
    }
  }

  console.log(`\nTotal: ${((Date.now() - start) / 1000).toFixed(1)}s`);

  // Write binary and order
  mkdirSync(dirname(OUT_BIN), { recursive: true });
  mkdirSync(dirname(LOCAL_BIN), { recursive: true });
  writeFileSync(OUT_BIN, Buffer.from(embeddings.buffer));
  writeFileSync(LOCAL_BIN, Buffer.from(embeddings.buffer));
  writeFileSync(OUT_ORDER, JSON.stringify(ids));
  writeFileSync(LOCAL_ORDER, JSON.stringify(ids));

  const mb = (embeddings.byteLength / 1024 / 1024).toFixed(1);
  console.log(`\nSaved embeddings.bin (${mb}MB) + embeddings-order.json`);
  console.log('Dimensions: 384, Model: text-embedding-3-small');
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});

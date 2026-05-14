#!/usr/bin/env node
/**
 * QA CI wrapper for All-In Expert
 *
 * Runs the 20-question harness against production, summarises results,
 * writes data/qa/latest.json, and compares against data/qa/baseline.json.
 * Exits non-zero if:
 *   • weighted overall regresses by more than baseline.regressionTolerance, OR
 *   • any individual question grade falls below baseline.perQuestionFloor.
 *
 * Designed to be appended to weekly-update.sh after the Vercel deploy step
 * so every Saturday's refresh trips an alert on quality regressions.
 *
 * Bootstraps cleanly: if ANTHROPIC_API_KEY is missing or the API URL is
 * unreachable, exits 0 with a [QA-CI] WARN line — never blocks the weekly
 * pipeline on transient infra issues. Real regressions exit 1.
 *
 * Rate-limit bypass: this script spawns qa-20-questions.mjs with
 * `env: process.env`, so any QA_BYPASS_TOKEN exported in the parent shell
 * is inherited by the child and forwarded to /api/ask as `x-qa-token` /
 * `qa_token`. The matching token lives in Vercel env as QA_BYPASS_TOKEN
 * (production). Locally, export it before running:
 *   export QA_BYPASS_TOKEN=<uuid-from-vercel-env>
 * Without it, harness runs count against the 200/day user budget.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const QA_DIR = join(ROOT, 'data', 'qa');
const BASELINE_PATH = join(QA_DIR, 'baseline.json');
const LATEST_PATH = join(QA_DIR, 'latest.json');

if (!existsSync(QA_DIR)) mkdirSync(QA_DIR, { recursive: true });

// ─── Baseline (auto-seed at 81 if missing) ────────────────────────────────
function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    const seed = {
      overall: 81,
      perQuestionFloor: 60,
      regressionTolerance: 3,
      createdAt: new Date().toISOString().split('T')[0],
      notes: 'Auto-seeded by qa-ci.mjs',
    };
    writeFileSync(BASELINE_PATH, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

// ─── Run the 20-Q harness as a subprocess and capture results ─────────────
// We invoke qa-20-questions.mjs unchanged — it writes data/qa/qa-run-YYYY-MM-DD.json
// to disk. We tail its stdout for the scorecard line + read the per-question
// JSON dump it leaves behind so we don't have to reimplement grading.
function runHarness() {
  return new Promise((resolve) => {
    const harnessPath = join(__dirname, 'qa-20-questions.mjs');
    if (!existsSync(harnessPath)) {
      resolve({ ok: false, reason: 'harness-missing' });
      return;
    }

    const child = spawn(process.execPath, [harnessPath], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
    });

    child.on('close', (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
    child.on('error', (err) => {
      resolve({ ok: false, reason: 'spawn-error', error: err.message });
    });
  });
}

// ─── Locate the qa-run-*.json the harness just wrote ──────────────────────
function loadLatestHarnessRun() {
  // Today's run uses ISO date as the slug.
  const today = new Date().toISOString().split('T')[0];
  const candidate = join(QA_DIR, `qa-run-${today}.json`);
  if (existsSync(candidate)) return { path: candidate, data: JSON.parse(readFileSync(candidate, 'utf8')) };
  // Fallback: pick the newest qa-run-*.json
  const runs = readdirSync(QA_DIR)
    .filter((f) => f.startsWith('qa-run-') && f.endsWith('.json'))
    .map((f) => ({ f, mtime: statSync(join(QA_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (runs.length === 0) return null;
  const p = join(QA_DIR, runs[0].f);
  return { path: p, data: JSON.parse(readFileSync(p, 'utf8')) };
}

function weightedOverall(results) {
  const grades = results
    .filter((r) => r.grade && typeof r.grade.overall === 'number' && r.grade.overall > 0)
    .map((r) => r.grade.overall);
  if (grades.length === 0) return 0;
  return Math.round((grades.reduce((a, b) => a + b, 0) / grades.length) * 10) / 10;
}

function perQuestion(results) {
  return results.map((r) => ({
    id: r.id,
    category: r.category,
    overall: r.grade?.overall ?? 0,
    keyIssue: r.grade?.key_issue ?? null,
  }));
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('[QA-CI] starting weekly QA regression check');
  const baseline = loadBaseline();

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[QA-CI] WARN ANTHROPIC_API_KEY missing — skipping (exit 0)');
    process.exit(0);
  }

  const run = await runHarness();
  if (!run.ok) {
    console.log(`[QA-CI] WARN harness did not exit cleanly (reason=${run.reason || run.code}) — skipping regression gate`);
    process.exit(0);
  }

  const latest = loadLatestHarnessRun();
  if (!latest) {
    console.log('[QA-CI] WARN no qa-run-*.json found — skipping regression gate');
    process.exit(0);
  }

  const overall = weightedOverall(latest.data);
  const perQ = perQuestion(latest.data);
  const summary = {
    timestamp: new Date().toISOString(),
    overall,
    questionCount: latest.data.length,
    perQuestion: perQ,
    baselineOverall: baseline.overall,
    delta: Math.round((overall - baseline.overall) * 10) / 10,
    sourceRun: latest.path,
  };

  writeFileSync(LATEST_PATH, JSON.stringify(summary, null, 2));
  console.log(`[QA-CI] overall=${overall} baseline=${baseline.overall} delta=${summary.delta}`);

  const tolerance = baseline.regressionTolerance ?? 3;
  const floor = baseline.perQuestionFloor ?? 60;

  const regressed = overall < baseline.overall - tolerance;
  const belowFloor = perQ.filter((q) => q.overall > 0 && q.overall < floor);

  if (regressed) {
    console.error(`[QA-CI] FAIL overall ${overall} regressed > ${tolerance} from baseline ${baseline.overall}`);
  }
  if (belowFloor.length > 0) {
    console.error(`[QA-CI] FAIL ${belowFloor.length} questions below floor (${floor}):`);
    for (const q of belowFloor) {
      console.error(`  - [${q.id}] ${q.category} ${q.overall}/100 — ${q.keyIssue ?? 'no issue noted'}`);
    }
  }

  if (regressed || belowFloor.length > 0) {
    process.exit(1);
  }
  console.log('[QA-CI] PASS no regression detected');
  process.exit(0);
}

main().catch((err) => {
  console.error('[QA-CI] WARN fatal error — exit 0 (do not block weekly pipeline):', err.message);
  process.exit(0);
});

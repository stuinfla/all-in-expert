## scripts/archive/

One-shot QA harnesses written during the iter-2/iter-3 rate-limited QA passes.
Kept for diff context against the canonical harness — do not run.

- **qa-subset.mjs** (2026-05-12) — 12-question compressed grader used when the
  daily rate limit blocked full runs. Compressed grader is ~10-15 pts harsher
  than canonical; do not use for scoring.
- **qa-remaining.mjs** (2026-05-12) — companion that re-graded the 5 worst
  questions from a prior subset run.

The canonical QA pair is `scripts/qa-20-questions.mjs` (harness) +
`scripts/qa-ci.mjs` (CI wrapper). Use those.

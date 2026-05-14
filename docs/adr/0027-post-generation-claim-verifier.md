# ADR-027: Post-Generation Claim Verifier

## Status
Accepted (2026-05-13)

## Context
The All-In Expert app synthesizes podcast-host voices from retrieved transcript chunks via Claude. QA found that the LLM, even with a strong "ONLY source of truth" system prompt rule, would fabricate specific claims (Section 338 of the tariff act, $100k/student figures, etc.) when retrieved chunks were topically near but claim-poor. System-prompt-only enforcement was demonstrably insufficient — measured fabrications on q04, q07, q11, q15, q17.

## Decision
Add a post-generation verification stage between Claude's draft and the user-facing response. Implementation:

1. **`verifyClaimsAgainstCitations(draftReport, citations, query)`** — runs Claude Haiku 4.5 in JSON-strict mode. Extracts every numeric/legislative/specific claim from the draft and tags each as GROUNDED, INFERRED, or UNGROUNDED based on citation match.

2. **`rewriteToHedge(draftReport, ungroundedClaims)`** — if any UNGROUNDED claims exist, second Haiku pass rewrites the affected paragraphs to soften the claims into hedges.

3. **Response payload** — every API response carries a `verification: { claimsTotal, claimsGrounded, claimsInferred, claimsUngrounded, hedgesApplied, verificationMs }` block. Frontend renders a "FACT-CHECK" footer so users see grounding status.

4. **Fail-open** — verifier errors do not block the response. Original draft passes through unchanged on any failure.

5. **Telemetry** — every verifier invocation appends to `data/qa/verifier-stats.jsonl` (per-day rollup): `{ts, query, claimsTotal, claimsUngrounded, hedgesApplied, verificationMs}`. Lets us prove the verifier is firing in production and measure hedge rate over time.

## Consequences
- **Positive**: structural defense against synthesis fabrication (the QA-deduction #1 issue). User-visible trust signal via fact-check footer.
- **Negative**: +1.5-3.5s latency per request when ungrounded claims present. Two extra Haiku API calls. Slight cost increase.
- **Neutral**: claim extraction quality depends on Haiku's structured output reliability — fail-open keeps this safe.

## Alternatives Considered
- System-prompt-only enforcement (current state pre-verifier): demonstrably insufficient.
- Structured-output forcing via Anthropic's tool-use mode: more reliable but more complex; Phase 2 if Haiku free-form proves unreliable.
- Citation-density floor (refuse-to-answer if &lt;3 citations on entity): too restrictive; verifier is a softer guardrail.

## Files
- /web/src/lib/validate-citations.ts (verifier + hedger functions)
- /web/src/app/api/ask/route.ts (wiring in both streaming and non-streaming paths)
- /web/src/app/page.tsx (FACT-CHECK UI footer — added Move 1)
- /data/qa/verifier-stats.jsonl (telemetry log)

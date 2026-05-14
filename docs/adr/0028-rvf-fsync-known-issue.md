# ADR-028: RVF FsyncFailed Known Issue (workaround in place)

## Status
Accepted (2026-05-13)

## Context

Every KB rebuild via `scripts/build-knowledge-base.mjs` hits the following
error when writing the HNSW vector index:

```
RVF error 0x0303: FsyncFailed  (Durable write (fsync) failed)
```

This has been reproducible across at least 5 rebuild attempts spanning
iter-2 through iter-5 of the May 12-13 2026 sprint. It fires on
`db.close()` after vectors have been written. The error appears to be a
filesystem-level issue (sandbox or quota related) rather than a logic bug
in the RVF native module.

## Workaround
The build script catches the error and falls back to the JSON+`embeddings.bin`
flat-binary representation:

```
log: "RVF not available (Durable write (fsync) failed: RVF error 0x0303: FsyncFailed), falling back to JSON format"
```

The API path (`route.ts:semanticSearch`) tries RVF first via
`semanticSearchRvf()`; if RVF is missing it falls through to
`semanticSearchBin()` over the flat `embeddings.bin`. At 31,215 vectors x
384 dims this O(n) cosine costs ~30ms per query — fine at this scale.
HNSW would be sub-1ms but is not currently used in production due to the
fsync error.

## Decision
**Accept the fallback as the live path.** The bin scan is correct (same
Xenova 384d embedding space) and fast enough for current corpus size.
The RVF path code stays in place so it activates automatically once the
fsync issue is resolved upstream.

## Trigger to revisit
- Corpus grows past ~75k chunks (bin scan latency >100ms p99)
- `@ruvector/rvf` releases a patch addressing the fsync error
- We move the build off the sandboxed environment to a host where fsync
  works reliably (e.g., bare M3 Max with full disk access)

## Files
- /scripts/build-knowledge-base.mjs (RVF write attempt + JSON fallback)
- /web/src/app/api/ask/route.ts (semanticSearchRvf → semanticSearchBin fallback)
- /web/public/data/all-in-expert.rvf (sometimes 0 bytes / sometimes prior-run remnant)
- /web/public/data/embeddings.bin (live retrieval target)

## Diagnostic notes (for future investigator)
- `RvfDatabase.create()` succeeds; vectors `add()` succeeds; only the
  final `close()` / fsync fails. Suggests the bytes are written but the
  durability barrier fails — probably a sandbox `fsync` syscall denial.
- Reproducible across Node 20 and Node 25 on macOS 14.
- Not blocked by free disk space (`df -h .` shows >100GB free).
- Try: running the build outside any sandbox; or upgrading
  `@ruvector/rvf` (currently `^0.2.1`); or adding a configurable `--no-fsync`
  flag upstream.

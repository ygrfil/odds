# Scripts DOX

## Purpose
- Owns root-level utility scripts for local benchmarking and static asset precompression.

## Ownership
- `bench.sh` owns repeatable local startup, preview, simulation, and static transfer benchmarks, writing results under `.bench/`.
- `precompress-static.sh` owns gzip/brotli precompression for deployed static assets.

## Local Contracts
- Benchmark output belongs in `.bench/`; do not treat generated benchmark logs as source.
- Scripts must resolve paths relative to the repository root rather than relying on the caller's current directory.
- Keep script behavior compatible with the README examples.

## Work Guidance
- Use `set -euo pipefail` for shell scripts.
- Prefer explicit environment-variable overrides for benchmark settings.
- Keep output machine-readable where existing consumers use JSON or line-oriented files.

## Verification
- Run `bash -n scripts/bench.sh scripts/precompress-static.sh` after script edits.
- For benchmark behavior changes, run `./scripts/bench.sh` when runtime cost is acceptable, or document why it was skipped.

## Child DOX Index
- No child AGENTS.md files currently.

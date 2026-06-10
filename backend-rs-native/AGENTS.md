# Backend DOX

## Purpose
- Owns the Rust HTTP server package `odds`.
- Serves the static web app, exposes simulation and preview APIs, enforces request/runtime limits, and adapts frontend requests to `native-sim`.

## Ownership
- `Cargo.toml` owns backend dependencies and package metadata.
- `src/main.rs` owns Axum routes, request/response structs, range parsing, percentile prewarm behavior, progress state, and native simulation orchestration.
- `src/cache.rs` owns reusable in-process cache primitives, including byte-budgeted eviction used by prepared sampler caches.
- `src/config.rs` owns environment-driven limits, runtime caps, heavy-request concurrency permits, and static-root resolution.
- `src/static_assets.rs` owns static asset cache headers for `index.html`, `src/` assets, and precompressed/versioned percentile table files.

## Local Contracts
- Keep API shapes stable for `src/engine.js`, `src/app.js`, and the iOS bundled web app.
- Keep simulation correctness delegated to `native-sim`; backend range compilation and request preparation must preserve intended hand pools, board/dead cards, weights, and percentile profile semantics.
- Runtime caps and body limits must remain explicit and configurable through documented env vars.
- Static file serving must continue to support the root `index.html` plus `src/` assets, including precompressed assets produced by `scripts/precompress-static.sh`.

## Work Guidance
- Prefer focused Rust changes in `src/main.rs` unless a shared simulation concern belongs in `native-sim`.
- Keep serde field casing aligned with the JavaScript clients.
- Be conservative with global caches and `OnceLock` data; percentile prewarm and request latency are user-visible.

## Verification
- Run `cargo check -p odds`.
- For API behavior or simulation integration changes, run `cargo test --workspace` when feasible.
- For served-app changes, run `cargo run -p odds --release` and smoke test `/api/health`, `/api/sim/run`, and the browser UI.

## Child DOX Index
- No child AGENTS.md files currently.

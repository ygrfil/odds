# Native Simulation DOX

## Purpose
- Owns the core Rust poker simulation engine used by the backend, CLI runner, and iOS FFI crate.
- Implements hand evaluation orchestration, range plans, exact percentile table support, pool building, coverage, tags, confidence stopping, and runtime stopping.

## Ownership
- `Cargo.toml` owns simulation crate dependencies.
- `build.rs` owns generated or embedded build-time simulation data behavior.
- `src/lib.rs` owns the public simulation API and JSON request runner.
- `src/main.rs` owns the stdin/stdout CLI wrapper around `run_request_json`.

## Local Contracts
- Preserve JSON compatibility for `backend-rs-native`, `ios/native-sim-ffi`, and any CLI consumers.
- Keep public structs and enum variants stable unless every caller is updated in the same change.
- Simulation changes must protect card uniqueness, variant hand-size rules, board/dead validation, weighted range semantics, and deterministic seeding behavior.
- Exact percentile table semantics must stay synchronized with frontend percentile table labels and backend profile selection.

## Work Guidance
- Prefer correctness and reproducibility before micro-optimizing.
- Keep parallelism explicit through Rayon worker settings; avoid hidden global behavior changes that alter API results unexpectedly.
- Avoid adding large generated data directly to source unless the ownership and regeneration path are documented here or in a child doc.

## Verification
- Run `cargo check -p native-sim`.
- For engine behavior changes, run `cargo test --workspace` when feasible.
- Use the CLI with representative JSON requests for focused simulation contract checks.

## Child DOX Index
- No child AGENTS.md files currently.

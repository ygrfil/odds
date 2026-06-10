# iOS Native Simulation FFI DOX

## Purpose
- Owns the Rust static library crate that exposes `native-sim` to Swift through a C ABI.

## Ownership
- `Cargo.toml` owns crate metadata and the `staticlib` output configuration.
- `src/lib.rs` owns exported C symbols, pointer handling, UTF-8 conversion, JSON serialization, and string-freeing behavior.

## Local Contracts
- Exported symbol names must remain aligned with Swift `NativeSimBridge`.
- All FFI entry points must tolerate null or invalid input safely and return JSON-shaped errors where possible.
- Strings returned to Swift must be allocated with `CString::into_raw` and released through `odds_native_free_string`.
- Request/response JSON must remain compatible with `native-sim::run_request_json` and `src/native-ios.js`.

## Work Guidance
- Keep the C ABI narrow; prefer evolving JSON payloads over adding many exported functions.
- Avoid panics across the FFI boundary.
- Keep dependency additions minimal because this crate is built for iOS device and simulator targets.

## Verification
- Run `cargo check -p odds-native-sim-ffi`.
- Run `ios/PokerOddsLab/Scripts/build-rust-native-sim.sh` when Apple Rust targets are installed.

## Child DOX Index
- No child AGENTS.md files currently.

# iOS DOX

## Purpose
- Owns iOS packaging for Poker Odds Lab, including the Swift wrapper app, bundled web assets, and Rust static-library bridge.
- The iOS app runs calculations on-device through `native-sim` linked via `ios/native-sim-ffi`.

## Ownership
- `PokerOddsLab/` owns the Xcode project, Swift app, asset catalog, privacy manifest, App Store readiness notes, scripts, and copied web bundle.
- `native-sim-ffi/` owns the C ABI static library crate used by Swift.

## Local Contracts
- The iOS shell loads bundled files from `PokerOddsLab/PokerOddsLab/WebApp` through the private `pokerodds://` URL scheme.
- Bundled web assets are a copy of root `index.html` and `src/`; edit root web sources first and sync with `PokerOddsLab/Scripts/sync-web-assets.sh`.
- The iOS build injects local/native flags and must not call the Rust HTTP backend for calculations.
- If the native bridge is unavailable, the app must report an error instead of falling back to JavaScript simulation.

## Work Guidance
- Keep Swift bridge message shapes aligned with `src/native-ios.js` and `ios/native-sim-ffi`.
- Keep Xcode project changes minimal and review generated project diffs carefully.
- Do not hand-edit generated `RustBridge/build` artifacts.

## Verification
- Run `ios/PokerOddsLab/Scripts/sync-web-assets.sh` after root web asset changes that should ship on iOS.
- Run `ios/PokerOddsLab/Scripts/build-rust-native-sim.sh` when changing the FFI crate or bridge build behavior and the required Apple targets are installed.
- Build or archive in Xcode for Swift, signing, asset, or project changes; document when local signing/platform constraints prevent that.

## Child DOX Index
- `ios/PokerOddsLab/AGENTS.md`: Swift wrapper app, Xcode project, scripts, App Store documents, assets, and bundled web assets.
- `ios/native-sim-ffi/AGENTS.md`: Rust C ABI static library for the iOS native simulation bridge.

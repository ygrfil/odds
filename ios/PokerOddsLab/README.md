# Poker Odds Lab iOS

This is the local-only iOS wrapper for Poker Odds Lab.

- Calculations run on-device through the Rust `native-sim` engine linked into the app.
- The app loads bundled files from `PokerOddsLab/WebApp` through the private `pokerodds://` URL scheme.
- `window.POKER_ODDS_LAB_FORCE_LOCAL` is injected before the app starts, so the iOS build does not call the Rust HTTP backend.
- The JavaScript simulation fallback is disabled in the iOS shell. If the native bridge is unavailable, the app reports an error instead of calculating in JS.

## Refresh Bundled Web Assets

From the repository root:

```bash
ios/PokerOddsLab/Scripts/sync-web-assets.sh
```

Open `ios/PokerOddsLab/PokerOddsLab.xcodeproj` in Xcode, choose your signing team, set the final bundle identifier, then archive for App Store Connect.

## Rust iOS Engine

The Xcode target runs `Scripts/build-rust-native-sim.sh` before linking. The script builds the `odds-native-sim-ffi` static library for the active iOS platform and links it into Swift through `NativeSimBridge.swift`.

If Xcode reports a missing Rust target, install it once:

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios
```

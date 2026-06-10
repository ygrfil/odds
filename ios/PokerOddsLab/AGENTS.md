# PokerOddsLab iOS App DOX

## Purpose
- Owns the native iOS app wrapper and Xcode project for Poker Odds Lab.
- Hosts the bundled web UI and connects it to the Rust native simulation library through Swift.

## Ownership
- `PokerOddsLab/*.swift` owns app entry, local web view loading, URL scheme behavior, and native bridge messaging.
- `PokerOddsLab/Assets.xcassets` owns app icon and asset catalog contents.
- `PokerOddsLab/PrivacyInfo.xcprivacy` owns the privacy manifest.
- `PokerOddsLab/WebApp` is a synced copy of root web assets; it is not the primary source.
- `Scripts/build-rust-native-sim.sh` owns Xcode-triggered Rust static library builds.
- `Scripts/sync-web-assets.sh` owns refreshing the bundled web app from root sources.
- `APP_STORE_READINESS.md` and `README.md` own iOS release notes and local iOS workflow docs.

## Local Contracts
- Keep `PokerOddsLab/WebApp` synchronized from root `index.html` and `src/` using `Scripts/sync-web-assets.sh`.
- Swift bridge responses must satisfy the callback contract in `src/native-ios.js`.
- The app must force local/native simulation and avoid backend HTTP simulation calls.
- Xcode build settings must continue to link the Rust static library produced under `RustBridge/build`.

## Work Guidance
- Prefer changing root frontend files before changing bundled `WebApp` files directly.
- Keep shell scripts portable for Xcode-launched environments where shell PATH is minimal.
- Review `project.pbxproj` diffs for accidental signing, user-local, or generated noise.

## Verification
- Run `Scripts/sync-web-assets.sh` after source web changes.
- Run `Scripts/build-rust-native-sim.sh` for Rust bridge changes when Apple Rust targets are installed.
- Build in Xcode for Swift, asset, project, or release-readiness changes when possible.

## Child DOX Index
- No child AGENTS.md files currently.

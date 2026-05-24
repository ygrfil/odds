# App Store Readiness Notes

## Current app behavior

- Poker Odds Lab is a self-contained strategy calculator.
- It does not offer real-money gaming, wagering, contests, prizes, user accounts, ads, analytics, or third-party SDKs.
- Web content is bundled in the app and rendered through `WKWebView`.
- Navigation is restricted to the bundled `pokerodds://` local asset scheme and `about:`.
- Simulations run on device through the bundled native Rust library.

## App Store Connect entries

- Category: Utilities.
- Privacy Policy URL: required in App Store Connect before submission.
- App Privacy: use "Data Not Collected" if the app stays as implemented here.
- Tracking: No.
- Review notes: mention that the app is a poker strategy/equity calculator only and does not include gambling, betting, deposits, withdrawals, prizes, or purchases.

## Local size snapshot

- `ios/PokerOddsLab/PokerOddsLab/WebApp`: about 35 MB raw, about 12.3 MB compressed.
- `ios/PokerOddsLab/RustBridge/build/iphoneos/libodds_native_sim_ffi.a`: about 37 MB before Xcode links and strips the Release app.
- `ios/PokerOddsLab/DerivedData`: generated build cache; ignored and not part of the submitted app.

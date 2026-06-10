# Web Frontend DOX

## Purpose
- Owns the browser UI loaded by root `index.html`.
- Coordinates user input, range previews, backend simulation calls, iOS native bridge calls, card parsing, result formatting, styles, and static percentile data.

## Ownership
- `app.js` owns UI state, event wiring, validation previews, settings, import/export, and bombpot interactions.
- `engine.js` owns backend simulation dispatch and local/iOS fallback rules.
- `native-ios.js` and `native-sim-request.js` own the JavaScript side of the iOS bridge contract.
- `cards.js`, `tag-utils.js`, `result-format.js`, `percentile-profiles.js`, and `live-info-utils.js` own shared frontend parsing/formatting utilities.
- `live-info-worker.js` owns live preview worker behavior.
- `percentile-tables-*.js` are static data modules; regenerate or update them deliberately and keep consumers compatible.
- `styles.css` owns the visual system for the static UI.

## Local Contracts
- The Rust backend is the supported simulation runtime for browser use; do not add a silent JavaScript simulation fallback.
- Preserve the iOS shell contract: when `window.POKER_ODDS_LAB_FORCE_LOCAL` is set, simulation must use the native iOS bridge or report a clear error.
- Keep frontend request/response shapes aligned with `backend-rs-native` and `native-sim` serde contracts.
- If changing source assets that ship to iOS, update the bundled copy with `ios/PokerOddsLab/Scripts/sync-web-assets.sh` or document why not.

## Work Guidance
- Use plain modern JavaScript modules; this frontend currently has no bundler or package manager.
- Keep DOM selectors and element IDs synchronized with root `index.html`.
- Keep user-facing simulation limits and timeout assumptions synchronized with backend runtime caps.
- Avoid expanding static table payloads without considering backend static compression and iOS bundle size.

## Verification
- Run `cargo run -p odds --release` from the repo root and test the app through `http://localhost:8789/index.html` for UI or frontend behavior changes.
- For bridge-shape changes, also run `cargo check --workspace` because Rust request types are part of the contract.

## Child DOX Index
- No child AGENTS.md files currently.

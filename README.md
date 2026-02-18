# Poker Odds Lab

Rust-native poker equity calculator with a static frontend served by the backend.

## Supported games
- Hold'em
- PLO4
- PLO5
- PLO6

## Run (recommended)
From project root:

```bash
cargo run --release --manifest-path backend-rs-native/Cargo.toml
```

Open:
- `http://localhost:8789/index.html`

## Browser-only fallback
```bash
python3 -m http.server 8080
```

Open:
- `http://localhost:8080/index.html`

This mode skips backend APIs and runs simulation in-browser.

## API endpoints
- `GET /api/health`
- `POST /api/sim/run`
- `POST /api/sim/preview/tag`
- `POST /api/sim/preview/range`

## Project layout
- `backend-rs-native/`: Axum server + API handlers
- `native-sim/`: Rust simulation engine
- `index.html` + `src/`: frontend UI and browser workers

## Notes
- Player count: 2 to 6.
- Monte Carlo + exact mode (exact when all players are exact suited hands).
- Range syntax includes combinators, macros, weighted atoms, and percentile forms.

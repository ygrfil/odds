# Poker Odds Lab

Desktop-first web app for poker equity calculations:
- Hold'em
- PLO4
- PLO5
- PLO6

## Features
- 2 players by default, `+ Player` up to max 6
- Dark mode only UI
- Range vs range, range vs hand (enter exact hand as range)
- Preflop / flop / turn / river (board input 0-5 cards)
- Stop button for manual run control
- Optional confidence-based early stop (95% CI) with iteration cap as hard upper bound
- Always uses maximum available browser workers automatically
- Automatic mode selection:
  - Exhaustive (exact) when all players are exact suited hands
  - Monte Carlo for any real range input
- Adaptive candidate-pool sampling for restrictive postflop filters (e.g. `@f`, `@fd`, `@set`)
- Outputs: equity, win/tie/loss, combo counts, hand class breakdown
- Local persistence (`localStorage`)
- Export/import setup+results as `.json`
- Quick-pick filters (`@tp`, `@2p`, `@set`, `@fd`, `@f`, etc.)
- Native backend mode (Rust) with automatic frontend fallback to browser engine when backend is not running

## Run locally (recommended)
Run the native backend from project root:

```bash
cargo run --release --manifest-path backend-rs-native/Cargo.toml
```

Open:
- `http://localhost:8789/index.html`

The UI automatically uses the native backend when available.

## Browser-only fallback
If you want to run without backend:

```bash
python3 -m http.server 8080
```

Open:
- `http://localhost:8080/index.html`

In this mode, calculations run fully in the browser.

## Native backend API
- `GET /api/health`
- `POST /api/sim/run`
- `POST /api/sim/preview/tag`
- `POST /api/sim/preview/range`

## Syntax support (v1)
Implemented:
- Combinators: `,`, `:`, `!`
- Parentheses
- Card literals and wildcards (`*`)
- Rank/suit variable patterns (`x y z w`, `R O N`)
- Top-off wildcards for game card counts
- Weighted atoms (`@N`)
- Core macros: `$s`, `$o`, `$ds`, `$ss`, `$np`, `$op`, `$tp`, `$nt`, `$B`, `$M`, `$Z`, `$L`, `$N`, `$F`, `$R`, `$W`, `$0g`, `$1g`, `$2g`
- Simple spans and `+`/`-` rank progression forms
- Percentile forms (`15%`, `30%-50%`)
- PLO4/PLO5 `%` ranges use precomputed true-equity-vs-random top-% cutoffs (Monte Carlo native precompute, deterministic exact-by-count selection, 0.001% resolution)

Notes:
- This is a practical compatibility engine for PPT-like workflows, not a byte-for-byte PPT parser clone yet.
- PLO4/PLO5 true-equity tables are Monte Carlo estimates (not exhaustive exact equities).
- Hold'em/PLO6 percentiles currently use sampled heuristic fallback unless you precompute dedicated true-equity tables for them.
- Stud-specific syntax (`|` streets) is not included because this app targets Hold'em/PLO only.
- Exhaustive auto-mode requires exact suited hands for all players (e.g. `AsKdQsTd`). It is mathematically exact for those inputs.

## Performance notes
- Native mode uses all available CPU cores by default.
- Native mode supports confidence-stop and reports actual iterations completed.
- Browser mode remains available as fallback and is slower for wide PLO range-vs-range workloads.

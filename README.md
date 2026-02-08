# Poker Odds Lab (Browser-only)

Desktop-first web app for Monte Carlo poker equity calculations:
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
- Always uses maximum available browser workers automatically
- Method selector: Monte Carlo or Exhaustive (exact-hands mode)
- Adaptive candidate-pool sampling for restrictive postflop filters (e.g. `@flush`, `@fd`, `@set`)
- Outputs: equity, win/tie/loss, combo counts, hand class breakdown
- Local persistence (`localStorage`)
- Export/import setup+results as `.json`
- Quick-pick filters (`@set`, `@2p`, `@fd`, `@flush`, etc.)

## Run locally
From project root:

```bash
python3 -m http.server 8080
```

Open:
- `http://localhost:8080/index.html`

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
- Percentile forms (`15%`, `30%-50%`) via fast heuristic strength model

Notes:
- This is a practical compatibility engine for PPT-like workflows, not a byte-for-byte PPT parser clone yet.
- Percentile ranges are heuristic in v1 (not PPT exact percentile tables).
- Stud-specific syntax (`|` streets) is not included because this app targets Hold'em/PLO only.
- Exhaustive mode requires exact suited hands for all players (e.g. `AsKdQsTd`). It is mathematically exact for those inputs.

## Performance notes
- Engine optimized for lower allocation and faster evaluation loops.
- Current local benchmark (short capped run, this machine):
  - Hold'em 2-way random vs random: ~9k iterations/s
  - PLO4 2-way random vs random: ~4.4k iterations/s
  - PLO6 4-way random vs random: ~600 iterations/s

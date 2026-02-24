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
cargo run -p odds --release
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
- `POST /api/sim/preview/tags`
- `POST /api/sim/preview/range`

## Production deploy (Proxmox LXC)
Recommended path for this project: run the Rust binary directly under `systemd` inside the LXC (no Docker-in-LXC).

Why this is best here:
- One process serves API + frontend static files.
- Lower memory/CPU overhead than nested container stacks.
- Native `systemd` restart policy + journald logs.

### One-command install
From project root inside your LXC:

```bash
chmod +x deploy/lxc/install.sh
./deploy/lxc/install.sh
```

Optional:

```bash
./deploy/lxc/install.sh --domain odds.example.com
./deploy/lxc/install.sh --port 8790
./deploy/lxc/install.sh --no-nginx
```

### One-command update
After you push new changes to GitHub, run this on the LXC:

```bash
./deploy/lxc/update.sh
```

It will:
- `git pull --ff-only` from your current branch
- auto-detect your deployed port and nginx mode
- rerun install/redeploy with those settings

Optional:

```bash
./deploy/lxc/update.sh --no-pull
./deploy/lxc/update.sh --branch master
./deploy/lxc/update.sh --port 8080 --no-nginx
```

The installer also creates a global alias command:

```bash
odds-update
```

Check what version is currently served:

```bash
curl http://127.0.0.1/build-info.json
```

### 1) Build and stage app files
Run inside your LXC:

```bash
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev ca-certificates curl git nginx
curl https://sh.rustup.rs -sSf | sh -s -- -y
source "$HOME/.cargo/env"

git clone <your-repo-url> /tmp/poker-odds-lab
cd /tmp/poker-odds-lab
cargo build -p odds --release

sudo useradd --system --home /opt/odds --shell /usr/sbin/nologin odds || true
sudo mkdir -p /opt/odds
sudo install -m 755 target/release/odds /opt/odds/odds
sudo cp index.html /opt/odds/index.html
sudo cp -R src /opt/odds/src
sudo chown -R odds:odds /opt/odds
```

### 2) Install systemd service
Use `deploy/lxc/systemd/odds.service`:

```bash
sudo cp deploy/lxc/systemd/odds.service /etc/systemd/system/odds.service
sudo systemctl daemon-reload
sudo systemctl enable --now odds
sudo systemctl status odds --no-pager
curl http://127.0.0.1:8789/api/health
```

### 3) Put Nginx in front (recommended)
Use `deploy/lxc/nginx/odds.conf`:

```bash
sudo cp deploy/lxc/nginx/odds.conf /etc/nginx/sites-available/odds
sudo ln -sf /etc/nginx/sites-available/odds /etc/nginx/sites-enabled/odds
sudo nginx -t
sudo systemctl restart nginx
```

Then open `http://<LXC_IP>/index.html`.

### Cloudflare bridge notes
- Keep API request runtime under Cloudflare edge timeout; installer defaults set simulation/bombpot runtime to `55s` and preview runtime to `45s`.
- Nginx config trusts `CF-Connecting-IP` only from localhost (`cloudflared` on the same node), so per-IP rate limiting works correctly.
- Nginx `/api/` location has explicit request/connection limits and tighter upstream timeouts to fail fast under overload.

### Runtime env vars
- `PORT` (default `8789`)
- `HOST` (default `0.0.0.0`)
- `APP_STATIC_ROOT` (default current working directory)
- `RUST_LOG` (default `odds=info,tower_http=info`)
- `PREWARM_PERCENTILES` (default `true`)
- `PREWARM_PERCENTILES_BLOCKING` (default `false`, when `true` warms tables before accepting traffic)
- `SIM_MAX_RUNTIME_MS` (default unset; LXC installer sets `55000`)
- `PREVIEW_MAX_RUNTIME_MS` (default `45000`)
- `BOMBPOT_MAX_RUNTIME_MS` (default unset; LXC installer sets `55000`)
- `SIM_MAX_RUNTIME_MS_CAP` (default `3600000`; installer sets `90000`)
- `BOMBPOT_MAX_RUNTIME_MS_CAP` (default `3600000`; installer sets `90000`)
- `REQUEST_BODY_LIMIT_BYTES` (default `262144`)

## Benchmark
Run repeatable local benchmarks (startup, percentile cold/warm latency, sim API, static transfer):

```bash
chmod +x scripts/bench.sh
./scripts/bench.sh
```

Optional overrides:

```bash
RUNS=10 ITER_CAP=300000 PORT_BASE=9100 ./scripts/bench.sh
```

Optionally benchmark with precompressed static assets (`.gz` and optional `.br`) enabled:

```bash
PRECOMPRESS_STATIC=1 ./scripts/bench.sh
```

Compare two benchmark summaries:

```bash
./scripts/bench.sh compare /path/to/before/summary.json /path/to/after/summary.json
```

## Project layout
- `backend-rs-native/`: Axum server + API handlers
- `native-sim/`: Rust simulation engine
- `index.html` + `src/`: frontend UI and browser workers

## Notes
- Player count: 2 to 6.
- Monte Carlo + exact mode (exact when all players are exact suited hands).
- Range syntax includes combinators, macros, weighted atoms, and percentile forms.
- Random hand selection from candidate pools uses bounded partial-shuffle sampling (uniform without replacement), removing probabilistic unbounded loops without changing result accuracy.

#!/usr/bin/env bash
set -euo pipefail

APP_NAME="odds"
APP_USER="odds"
APP_GROUP="odds"
APP_DIR="/opt/odds"
ENV_DIR="/etc/odds"
SERVICE_PATH="/etc/systemd/system/${APP_NAME}.service"
NGINX_SITE="/etc/nginx/sites-available/${APP_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${APP_NAME}"

PORT="8789"
DOMAIN="_"
ENABLE_NGINX="true"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"

usage() {
  cat <<'EOF'
One-command installer for Poker Odds Lab on Debian/Ubuntu LXC.

Usage:
  ./deploy/lxc/install.sh [options]

Options:
  --repo-dir <path>   Project path (default: script-relative repo root)
  --port <port>       Backend port for the app service (default: 8789)
  --domain <domain>   Nginx server_name (default: _)
  --no-nginx          Skip nginx reverse proxy setup
  --help              Show help
EOF
}

log() {
  printf '[install] %s\n' "$*"
}

die() {
  printf '[install] ERROR: %s\n' "$*" >&2
  exit 1
}

run_build_user() {
  local cmd="$1"
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    sudo -u "${SUDO_USER}" -H bash -lc "$cmd"
  else
    bash -lc "$cmd"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      [[ $# -ge 2 ]] || die "--repo-dir requires a value"
      REPO_DIR="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || die "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    --domain)
      [[ $# -ge 2 ]] || die "--domain requires a value"
      DOMAIN="$2"
      shift 2
      ;;
    --no-nginx)
      ENABLE_NGINX="false"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1"
      ;;
  esac
done

[[ "$PORT" =~ ^[0-9]+$ ]] || die "PORT must be numeric"
(( PORT >= 1 && PORT <= 65535 )) || die "PORT must be between 1 and 65535"

[[ -f "${REPO_DIR}/Cargo.toml" ]] || die "Cargo.toml not found in ${REPO_DIR}"
[[ -f "${REPO_DIR}/index.html" ]] || die "index.html not found in ${REPO_DIR}"
[[ -d "${REPO_DIR}/src" ]] || die "src/ directory not found in ${REPO_DIR}"

if [[ $EUID -eq 0 ]]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || die "sudo is required"
  SUDO="sudo"
fi

log "Installing OS packages"
$SUDO apt-get update
$SUDO DEBIAN_FRONTEND=noninteractive apt-get install -y \
  build-essential \
  pkg-config \
  libssl-dev \
  ca-certificates \
  curl \
  git \
  nginx

log "Installing/updating Rust stable toolchain for build user"
run_build_user '
set -euo pipefail
if ! command -v cargo >/dev/null 2>&1; then
  curl https://sh.rustup.rs -sSf | sh -s -- -y
fi
source "$HOME/.cargo/env"
rustup toolchain install stable --profile minimal >/dev/null
rustup default stable >/dev/null
'

log "Building release binary"
run_build_user "
set -euo pipefail
source \"\$HOME/.cargo/env\"
cd \"${REPO_DIR}\"
cargo build -p odds --release
"

log "Creating service account and staging app files in ${APP_DIR}"
$SUDO useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${APP_USER}" 2>/dev/null || true
$SUDO install -d -m 755 -o "${APP_USER}" -g "${APP_GROUP}" "${APP_DIR}"
$SUDO install -m 755 "${REPO_DIR}/target/release/odds" "${APP_DIR}/odds"
$SUDO cp "${REPO_DIR}/index.html" "${APP_DIR}/index.html"
$SUDO rm -rf "${APP_DIR}/src"
$SUDO cp -R "${REPO_DIR}/src" "${APP_DIR}/src"
$SUDO chown -R "${APP_USER}:${APP_GROUP}" "${APP_DIR}"

log "Writing environment file"
$SUDO install -d -m 755 "${ENV_DIR}"
$SUDO tee "${ENV_DIR}/${APP_NAME}.env" >/dev/null <<EOF
RUST_LOG=odds=info,tower_http=warn
PREWARM_PERCENTILES=true
EOF
$SUDO chmod 640 "${ENV_DIR}/${APP_NAME}.env"

log "Installing systemd service"
$SUDO tee "${SERVICE_PATH}" >/dev/null <<EOF
[Unit]
Description=Poker Odds Lab backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_GROUP}
WorkingDirectory=${APP_DIR}
Environment=PORT=${PORT}
Environment=HOST=127.0.0.1
Environment=APP_STATIC_ROOT=${APP_DIR}
EnvironmentFile=-${ENV_DIR}/${APP_NAME}.env
ExecStart=${APP_DIR}/odds
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
LimitNOFILE=65535

[Install]
WantedBy=multi-user.target
EOF

if [[ "${ENABLE_NGINX}" == "true" ]]; then
  log "Installing nginx reverse proxy config"
  $SUDO tee "${NGINX_SITE}" >/dev/null <<EOF
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  $SUDO ln -sfn "${NGINX_SITE}" "${NGINX_LINK}"
  if [[ -L /etc/nginx/sites-enabled/default ]]; then
    $SUDO rm -f /etc/nginx/sites-enabled/default
  fi
  $SUDO nginx -t
fi

log "Starting services"
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now "${APP_NAME}"
$SUDO systemctl restart "${APP_NAME}"

if [[ "${ENABLE_NGINX}" == "true" ]]; then
  $SUDO systemctl enable --now nginx
  $SUDO systemctl reload nginx
fi

log "Checking health endpoint"
healthy="false"
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null; then
    healthy="true"
    break
  fi
  sleep 1
done

if [[ "${healthy}" != "true" ]]; then
  $SUDO journalctl -u "${APP_NAME}" -n 120 --no-pager >&2 || true
  die "health check failed at http://127.0.0.1:${PORT}/api/health"
fi

LAN_IP="$(hostname -I | awk '{print $1}')"
if [[ "${ENABLE_NGINX}" == "true" ]]; then
  if [[ "${DOMAIN}" == "_" ]]; then
    PUBLIC_URL="http://${LAN_IP}/index.html"
  else
    PUBLIC_URL="http://${DOMAIN}/index.html"
  fi
else
  PUBLIC_URL="http://${LAN_IP}:${PORT}/index.html"
fi

log "Install complete"
printf '\nService: %s\nHealth:  http://127.0.0.1:%s/api/health\nOpen:    %s\n\n' "${APP_NAME}" "${PORT}" "${PUBLIC_URL}"

#!/usr/bin/env bash
set -euo pipefail

APP_NAME="odds"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
SERVICE_PATH="/etc/systemd/system/${APP_NAME}.service"
NGINX_SITE="/etc/nginx/sites-available/${APP_NAME}"
NGINX_LINK="/etc/nginx/sites-enabled/${APP_NAME}"

BRANCH=""
DO_PULL="true"
PORT=""
DOMAIN=""
ENABLE_NGINX=""

usage() {
  cat <<'EOF'
Update helper for Poker Odds Lab on LXC.

Usage:
  ./deploy/lxc/update.sh [options]

Options:
  --repo-dir <path>   Project path (default: script-relative repo root)
  --branch <name>     Git branch for pull (default: current branch)
  --no-pull           Skip git pull and only redeploy
  --port <port>       Override backend port
  --domain <domain>   Override nginx server_name
  --no-nginx          Force no-nginx mode
  --help              Show help
EOF
}

log() {
  printf '[update] %s\n' "$*"
}

die() {
  printf '[update] ERROR: %s\n' "$*" >&2
  exit 1
}

detect_port_from_service() {
  local file="$1"
  if [[ -f "$file" ]]; then
    sed -n 's/^Environment=PORT=//p' "$file" | tail -n 1
  fi
}

detect_domain_from_nginx() {
  local file="$1"
  if [[ -f "$file" ]]; then
    sed -n 's/^[[:space:]]*server_name[[:space:]]\+\([^;][^;]*\);/\1/p' "$file" | head -n 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo-dir)
      [[ $# -ge 2 ]] || die "--repo-dir requires a value"
      REPO_DIR="$2"
      shift 2
      ;;
    --branch)
      [[ $# -ge 2 ]] || die "--branch requires a value"
      BRANCH="$2"
      shift 2
      ;;
    --no-pull)
      DO_PULL="false"
      shift
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

[[ -d "${REPO_DIR}" ]] || die "repo dir not found: ${REPO_DIR}"
[[ -f "${REPO_DIR}/deploy/lxc/install.sh" ]] || die "install script not found in ${REPO_DIR}"

cd "${REPO_DIR}"

if [[ "${DO_PULL}" == "true" ]]; then
  if [[ -z "${BRANCH}" ]]; then
    BRANCH="$(git branch --show-current)"
  fi
  [[ -n "${BRANCH}" ]] || die "could not determine git branch; pass --branch explicitly"
  log "Pulling latest code from origin/${BRANCH}"
  git pull --ff-only origin "${BRANCH}"
fi

if [[ -z "${PORT}" ]]; then
  PORT="$(detect_port_from_service "${SERVICE_PATH}")"
fi
if [[ -z "${PORT}" ]]; then
  PORT="8789"
fi

if [[ -z "${ENABLE_NGINX}" ]]; then
  if [[ -e "${NGINX_LINK}" ]]; then
    ENABLE_NGINX="true"
  else
    ENABLE_NGINX="false"
  fi
fi

if [[ "${ENABLE_NGINX}" == "true" ]]; then
  if [[ -z "${DOMAIN}" ]]; then
    DOMAIN="$(detect_domain_from_nginx "${NGINX_SITE}")"
  fi
  if [[ -z "${DOMAIN}" ]]; then
    DOMAIN="_"
  fi
fi

install_cmd=(./deploy/lxc/install.sh --port "${PORT}")
if [[ "${ENABLE_NGINX}" == "true" ]]; then
  install_cmd+=(--domain "${DOMAIN}")
else
  install_cmd+=(--no-nginx)
fi

log "Redeploying (port=${PORT}, nginx=${ENABLE_NGINX})"
"${install_cmd[@]}"

log "Update complete"

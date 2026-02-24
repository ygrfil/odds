#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${1:-$(pwd)}"

if [[ ! -d "${ROOT_DIR}" ]]; then
  echo "root directory not found: ${ROOT_DIR}" >&2
  exit 1
fi

compress_gzip() {
  local file="$1"
  gzip -9 -f -k "${file}"
}

compress_brotli() {
  local file="$1"
  brotli -q 6 -f -k "${file}"
}

main() {
  local -a files=()
  if [[ -f "${ROOT_DIR}/index.html" ]]; then
    files+=("${ROOT_DIR}/index.html")
  fi
  if [[ -f "${ROOT_DIR}/build-info.json" ]]; then
    files+=("${ROOT_DIR}/build-info.json")
  fi
  if [[ -d "${ROOT_DIR}/src" ]]; then
    local -a src_files
    mapfile -t src_files < <(
      find "${ROOT_DIR}/src" -type f \
        \( -name '*.js' -o -name '*.css' -o -name '*.json' -o -name '*.mjs' \) \
        ! -name '*.gz' \
        ! -name '*.br' \
        | sort
    )
    files+=("${src_files[@]}")
  fi

  if [[ ${#files[@]} -eq 0 ]]; then
    echo "[precompress] no static assets found under ${ROOT_DIR}"
    return 0
  fi

  echo "[precompress] root: ${ROOT_DIR}"
  echo "[precompress] files: ${#files[@]}"

  local gzip_count=0
  local br_count=0
  local has_brotli=0
  if command -v brotli >/dev/null 2>&1; then
    has_brotli=1
  fi

  local file
  for file in "${files[@]}"; do
    compress_gzip "${file}"
    gzip_count=$((gzip_count + 1))
    if [[ "${has_brotli}" == "1" ]]; then
      compress_brotli "${file}"
      br_count=$((br_count + 1))
    fi
  done

  if [[ "${has_brotli}" == "1" ]]; then
    echo "[precompress] wrote ${gzip_count} gzip and ${br_count} brotli assets"
  else
    echo "[precompress] wrote ${gzip_count} gzip assets (brotli not found, skipped)"
  fi
}

main "$@"

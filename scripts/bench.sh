#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_PATH="${ROOT_DIR}/target/release/odds"
RUNS="${RUNS:-7}"
PORT_BASE="${PORT_BASE:-8920}"
ITER_CAP="${ITER_CAP:-200000}"
BUILD_RELEASE="${BUILD_RELEASE:-1}"
PRECOMPRESS_STATIC="${PRECOMPRESS_STATIC:-0}"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/.bench/$(date +%Y%m%d-%H%M%S)}"

mkdir -p "${OUT_DIR}"

STARTUP_FALSE_FILE="${OUT_DIR}/startup_false_ms.txt"
STARTUP_BG_FILE="${OUT_DIR}/startup_bgprewarm_ms.txt"
STARTUP_BLOCK_FILE="${OUT_DIR}/startup_blocking_prewarm_ms.txt"
PCT_COLD_FILE="${OUT_DIR}/preview_pct_cold_s.txt"
PCT_WARM_FILE="${OUT_DIR}/preview_pct_warm_s.txt"
NONPCT_FILE="${OUT_DIR}/preview_nonpct_s.txt"
SIM_FILE="${OUT_DIR}/sim_run_s.txt"
STATIC_RAW_TIME_FILE="${OUT_DIR}/static_raw_time_s.txt"
STATIC_RAW_BYTES_FILE="${OUT_DIR}/static_raw_bytes.txt"
STATIC_GZ_TIME_FILE="${OUT_DIR}/static_gzip_time_s.txt"
STATIC_GZ_BYTES_FILE="${OUT_DIR}/static_gzip_bytes.txt"

usage() {
  cat <<'EOF'
Usage:
  scripts/bench.sh
  scripts/bench.sh compare <before_summary.json> <after_summary.json>

Run mode env vars:
  RUNS=7 ITER_CAP=200000 PORT_BASE=8920 BUILD_RELEASE=1 PRECOMPRESS_STATIC=0 OUT_DIR=...
EOF
}

log() {
  printf '[bench] %s\n' "$*"
}

now_ms() {
  python3 - <<'PY'
import time
print(time.time() * 1000.0)
PY
}

SERVER_PID=""

cleanup_server() {
  if [[ -n "${SERVER_PID}" ]] && kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
    kill "${SERVER_PID}" >/dev/null 2>&1 || true
    wait "${SERVER_PID}" >/dev/null 2>&1 || true
  fi
  SERVER_PID=""
}

trap cleanup_server EXIT

start_server() {
  local prewarm="$1"
  local prewarm_blocking="$2"
  local port="$3"
  local logfile="${OUT_DIR}/server_${prewarm}_${prewarm_blocking}_${port}.log"
  PREWARM_PERCENTILES="${prewarm}" \
  PREWARM_PERCENTILES_BLOCKING="${prewarm_blocking}" \
  PORT="${port}" \
  HOST=127.0.0.1 \
  APP_STATIC_ROOT="${ROOT_DIR}" \
    "${BIN_PATH}" >"${logfile}" 2>&1 &
  SERVER_PID=$!

  for _ in $(seq 1 500); do
    if curl -fsS "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.02
    if ! kill -0 "${SERVER_PID}" >/dev/null 2>&1; then
      break
    fi
  done

  log "server failed to start on port ${port}; tailing log:"
  tail -n 80 "${logfile}" || true
  return 1
}

measure_startup() {
  local prewarm="$1"
  local prewarm_blocking="$2"
  local port="$3"
  local t0 t1 ms
  t0="$(now_ms)"
  start_server "${prewarm}" "${prewarm_blocking}" "${port}"
  t1="$(now_ms)"
  ms="$(python3 - <<PY
t0=float("${t0}")
t1=float("${t1}")
print(f"{(t1-t0):.3f}")
PY
)"
  printf '%s\n' "${ms}"
  cleanup_server
}

measure_preview_triplet() {
  local port="$1"
  local pct_payload='{"boardText":"","variant":"plo4","rangeText":"15%","percentileProfile":"ours"}'
  local nonpct_payload='{"boardText":"","variant":"plo4","rangeText":"AA","percentileProfile":"ours"}'
  local t_pct_cold t_pct_warm t_nonpct

  start_server false false "${port}"
  t_pct_cold="$(curl -s -o /dev/null -w '%{time_total}' -H 'content-type: application/json' -d "${pct_payload}" "http://127.0.0.1:${port}/api/sim/preview/range")"
  t_pct_warm="$(curl -s -o /dev/null -w '%{time_total}' -H 'content-type: application/json' -d "${pct_payload}" "http://127.0.0.1:${port}/api/sim/preview/range")"
  t_nonpct="$(curl -s -o /dev/null -w '%{time_total}' -H 'content-type: application/json' -d "${nonpct_payload}" "http://127.0.0.1:${port}/api/sim/preview/range")"
  cleanup_server

  printf '%s\n' "${t_pct_cold}" >>"${PCT_COLD_FILE}"
  printf '%s\n' "${t_pct_warm}" >>"${PCT_WARM_FILE}"
  printf '%s\n' "${t_nonpct}" >>"${NONPCT_FILE}"
}

measure_sim() {
  local port="$1"
  local sim_payload
  sim_payload="$(cat <<JSON
{"config":{"variant":"holdem","percentileProfile":"ours","iterationCap":${ITER_CAP},"board":"","dead":"","players":[{"name":"P1","range":"AA"},{"name":"P2","range":"*"}]}}
JSON
)"
  start_server false false "${port}"
  for _ in $(seq 1 "${RUNS}"); do
    curl -s -o /dev/null -w '%{time_total}\n' \
      -H 'content-type: application/json' \
      -d "${sim_payload}" \
      "http://127.0.0.1:${port}/api/sim/run" >>"${SIM_FILE}"
  done
  cleanup_server
}

measure_static() {
  local port="$1"
  local raw gz raw_bytes raw_time gz_bytes gz_time
  start_server false false "${port}"
  for _ in $(seq 1 "${RUNS}"); do
    raw="$(curl -s -o /dev/null -w '%{size_download} %{time_total}' "http://127.0.0.1:${port}/src/percentile-tables.js")"
    gz="$(curl --compressed -s -o /dev/null -w '%{size_download} %{time_total}' "http://127.0.0.1:${port}/src/percentile-tables.js")"
    raw_bytes="$(awk '{print $1}' <<<"${raw}")"
    raw_time="$(awk '{print $2}' <<<"${raw}")"
    gz_bytes="$(awk '{print $1}' <<<"${gz}")"
    gz_time="$(awk '{print $2}' <<<"${gz}")"
    printf '%s\n' "${raw_bytes}" >>"${STATIC_RAW_BYTES_FILE}"
    printf '%s\n' "${raw_time}" >>"${STATIC_RAW_TIME_FILE}"
    printf '%s\n' "${gz_bytes}" >>"${STATIC_GZ_BYTES_FILE}"
    printf '%s\n' "${gz_time}" >>"${STATIC_GZ_TIME_FILE}"
  done
  cleanup_server
}

print_summary() {
  python3 - "${OUT_DIR}" <<'PY'
import json
import math
import os
import statistics
import sys

out_dir = sys.argv[1]

def load(name):
    path = os.path.join(out_dir, name)
    if not os.path.exists(path):
        return []
    vals = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            s = line.strip()
            if not s:
                continue
            vals.append(float(s))
    return vals

def stats(vals):
    if not vals:
        return None
    arr = sorted(vals)
    p50 = statistics.median(arr)
    p95_idx = max(0, min(len(arr) - 1, math.ceil(len(arr) * 0.95) - 1))
    return {
        "n": len(arr),
        "min": arr[0],
        "p50": p50,
        "p95": arr[p95_idx],
        "max": arr[-1],
        "mean": statistics.fmean(arr),
    }

metrics = {
    "startup_false_ms": stats(load("startup_false_ms.txt")),
    "startup_bgprewarm_ms": stats(load("startup_bgprewarm_ms.txt")),
    "startup_blocking_prewarm_ms": stats(load("startup_blocking_prewarm_ms.txt")),
    "preview_pct_cold_s": stats(load("preview_pct_cold_s.txt")),
    "preview_pct_warm_s": stats(load("preview_pct_warm_s.txt")),
    "preview_nonpct_s": stats(load("preview_nonpct_s.txt")),
    "sim_run_s": stats(load("sim_run_s.txt")),
    "static_raw_time_s": stats(load("static_raw_time_s.txt")),
    "static_raw_bytes": stats(load("static_raw_bytes.txt")),
    "static_gzip_time_s": stats(load("static_gzip_time_s.txt")),
    "static_gzip_bytes": stats(load("static_gzip_bytes.txt")),
}

summary_path = os.path.join(out_dir, "summary.json")
with open(summary_path, "w", encoding="utf-8") as f:
    json.dump(metrics, f, indent=2)

def fmt(name, unit):
    m = metrics.get(name)
    if not m:
        return f"{name}: n/a"
    return (
        f"{name}: n={m['n']} min={m['min']:.4f}{unit} "
        f"p50={m['p50']:.4f}{unit} p95={m['p95']:.4f}{unit} "
        f"max={m['max']:.4f}{unit} mean={m['mean']:.4f}{unit}"
    )

print(fmt("startup_false_ms", "ms"))
print(fmt("startup_bgprewarm_ms", "ms"))
print(fmt("startup_blocking_prewarm_ms", "ms"))
print(fmt("preview_pct_cold_s", "s"))
print(fmt("preview_pct_warm_s", "s"))
print(fmt("preview_nonpct_s", "s"))
print(fmt("sim_run_s", "s"))
print(fmt("static_raw_time_s", "s"))
print(fmt("static_raw_bytes", "B"))
print(fmt("static_gzip_time_s", "s"))
print(fmt("static_gzip_bytes", "B"))
print(f"summary_json: {summary_path}")
PY
}

compare_summaries() {
  local before_json="$1"
  local after_json="$2"
  python3 - "${before_json}" "${after_json}" <<'PY'
import json
import math
import sys

before_path, after_path = sys.argv[1], sys.argv[2]
with open(before_path, "r", encoding="utf-8") as f:
    before = json.load(f)
with open(after_path, "r", encoding="utf-8") as f:
    after = json.load(f)

keys = sorted(set(before.keys()) | set(after.keys()))
print(f"before: {before_path}")
print(f"after:  {after_path}")
for key in keys:
    b = before.get(key) or {}
    a = after.get(key) or {}
    bp = b.get("p50")
    ap = a.get("p50")
    if bp is None or ap is None:
        print(f"{key}: n/a")
        continue
    if bp == 0:
        delta_pct = math.inf if ap != 0 else 0.0
    else:
        delta_pct = ((ap - bp) / bp) * 100.0
    sign = "+" if delta_pct > 0 else ""
    print(f"{key}: p50 {bp:.6f} -> {ap:.6f} ({sign}{delta_pct:.2f}%)")
PY
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "compare" ]]; then
  [[ $# -eq 3 ]] || {
    usage
    exit 1
  }
  compare_summaries "$2" "$3"
  exit 0
fi

log "output directory: ${OUT_DIR}"
if [[ "${BUILD_RELEASE}" == "1" ]]; then
  log "building release binary"
  (cd "${ROOT_DIR}" && cargo build -p odds --release >/dev/null)
fi
if [[ "${PRECOMPRESS_STATIC}" == "1" ]]; then
  log "precompressing static assets"
  "${ROOT_DIR}/scripts/precompress-static.sh" "${ROOT_DIR}" >/dev/null
fi
if [[ ! -x "${BIN_PATH}" ]]; then
  echo "missing binary: ${BIN_PATH}" >&2
  exit 1
fi

: >"${STARTUP_FALSE_FILE}"
: >"${STARTUP_BG_FILE}"
: >"${STARTUP_BLOCK_FILE}"
: >"${PCT_COLD_FILE}"
: >"${PCT_WARM_FILE}"
: >"${NONPCT_FILE}"
: >"${SIM_FILE}"
: >"${STATIC_RAW_TIME_FILE}"
: >"${STATIC_RAW_BYTES_FILE}"
: >"${STATIC_GZ_TIME_FILE}"
: >"${STATIC_GZ_BYTES_FILE}"

log "measuring startup (${RUNS} runs each: no prewarm, background prewarm, blocking prewarm)"
for i in $(seq 1 "${RUNS}"); do
  port=$((PORT_BASE + (i % 10)))
  measure_startup false false "${port}" >>"${STARTUP_FALSE_FILE}"
  measure_startup true false "$((port + 10))" >>"${STARTUP_BG_FILE}"
  measure_startup true true "$((port + 20))" >>"${STARTUP_BLOCK_FILE}"
done

log "measuring preview latency (${RUNS} cold starts)"
for i in $(seq 1 "${RUNS}"); do
  measure_preview_triplet "$((PORT_BASE + 100 + (i % 10)))"
done

log "measuring simulation latency (${RUNS} requests)"
measure_sim "$((PORT_BASE + 200))"

log "measuring static transfer (${RUNS} requests)"
measure_static "$((PORT_BASE + 300))"

log "summary"
print_summary

#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$IOS_DIR/../.." && pwd)"
WEBAPP_DIR="$IOS_DIR/PokerOddsLab/WebApp"

rm -rf "$WEBAPP_DIR"
mkdir -p "$WEBAPP_DIR"

cp "$REPO_ROOT/index.html" "$WEBAPP_DIR/index.html"
cp -R "$REPO_ROOT/src" "$WEBAPP_DIR/src"

find "$WEBAPP_DIR" -name ".DS_Store" -delete

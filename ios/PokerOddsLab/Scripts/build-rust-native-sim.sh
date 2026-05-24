#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IOS_PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$IOS_PROJECT_DIR/../.." && pwd)"
PLATFORM="${PLATFORM_NAME:-iphoneos}"
ARCHS_VALUE="${ARCHS:-arm64}"
CONFIGURATION_VALUE="${CONFIGURATION:-Release}"
OUT_DIR="$IOS_PROJECT_DIR/RustBridge/build/$PLATFORM"
LIB_NAME="libodds_native_sim_ffi.a"

mkdir -p "$OUT_DIR"

if [[ -f "$HOME/.cargo/env" ]]; then
  # Xcode launched from Finder/Dock often does not inherit the shell PATH.
  # Load Rust's environment explicitly so cargo/rustup are available.
  # shellcheck disable=SC1091
  source "$HOME/.cargo/env"
fi
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v cargo >/dev/null 2>&1 || ! command -v rustup >/dev/null 2>&1; then
  echo "Rust toolchain not found from Xcode." >&2
  echo "Install Rust from https://rustup.rs, then run:" >&2
  echo "  rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios" >&2
  exit 1
fi

target_for_arch() {
  local arch="$1"
  case "$PLATFORM:$arch" in
    iphoneos:arm64) echo "aarch64-apple-ios" ;;
    iphonesimulator:arm64) echo "aarch64-apple-ios-sim" ;;
    iphonesimulator:x86_64) echo "x86_64-apple-ios" ;;
    *) echo "" ;;
  esac
}

built_libs=()
cd "$REPO_ROOT"
for arch in $ARCHS_VALUE; do
  target="$(target_for_arch "$arch")"
  if [[ -z "$target" ]]; then
    echo "Unsupported Rust iOS target for PLATFORM_NAME=$PLATFORM arch=$arch" >&2
    exit 1
  fi

  if ! rustup target list --installed | grep -qx "$target"; then
    echo "Rust target $target is not installed; installing with rustup target add $target"
    rustup target add "$target"
  fi

  profile_dir="debug"
  if [[ "$CONFIGURATION_VALUE" != "Debug" ]]; then
    cargo build -p odds-native-sim-ffi --target "$target" --release
    profile_dir="release"
  else
    cargo build -p odds-native-sim-ffi --target "$target"
  fi
  built_libs+=("$REPO_ROOT/target/$target/$profile_dir/$LIB_NAME")
done

if [[ "${#built_libs[@]}" -eq 1 ]]; then
  cp "${built_libs[0]}" "$OUT_DIR/$LIB_NAME"
else
  lipo -create "${built_libs[@]}" -output "$OUT_DIR/$LIB_NAME"
fi

echo "Built $OUT_DIR/$LIB_NAME"

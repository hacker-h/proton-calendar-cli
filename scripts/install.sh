#!/bin/sh
set -eu

repo="hacker-h/proton-calendar-cli"
base_url=${PC_INSTALL_BASE_URL:-"https://github.com/$repo/releases"}
version=latest
install_dir=${PC_INSTALL_DIR:-${XDG_BIN_HOME:-"$HOME/.local/bin"}}

usage() {
  cat <<'USAGE'
Install pc from GitHub release binaries.

Usage:
  install.sh [--version <tag>] [--dir <path>]

Options:
  --version <tag>  Install a specific release tag, for example v1.10.0.
  --dir <path>     Install into this writable directory. Defaults to $XDG_BIN_HOME or $HOME/.local/bin.
  -h, --help       Show this help.

Environment:
  PC_INSTALL_DIR       Override the install directory.
  PC_INSTALL_BASE_URL  Override the GitHub releases base URL for tests or mirrors.
USAGE
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || fail "need $1"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || fail "--version requires a tag"
      version=$2
      shift 2
      ;;
    --dir)
      [ "$#" -ge 2 ] || fail "--dir requires a path"
      install_dir=$2
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

[ -n "$install_dir" ] || fail "install directory cannot be empty"
[ -n "$version" ] || fail "version cannot be empty"

need uname
need mktemp
need mkdir
need chmod
need cp
need mv
need rm

detect_asset() {
  os=$(uname -s 2>/dev/null || true)
  arch=$(uname -m 2>/dev/null || true)

  case "$os" in
    Linux)
      platform=linux
      ;;
    Darwin)
      platform=macos
      if [ "$arch" = x86_64 ] && command -v sysctl >/dev/null 2>&1 && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || printf 0)" = 1 ]; then
        arch=arm64
      fi
      ;;
    MINGW*|MSYS*|CYGWIN*|Windows_NT)
      fail "Windows is not supported by this POSIX installer; download pc-windows-x64.exe from GitHub Releases"
      ;;
    *)
      fail "unsupported OS: $os"
      ;;
  esac

  case "$arch" in
    x86_64|amd64)
      cpu=x64
      ;;
    arm64|aarch64)
      cpu=arm64
      ;;
    *)
      fail "unsupported architecture: $arch"
      ;;
  esac

  case "$platform-$cpu" in
    linux-x64)
      asset=pc-linux-x64
      ;;
    macos-arm64)
      asset=pc-macos-arm64
      ;;
    macos-x64)
      asset=pc-macos-x64
      ;;
    *)
      fail "no release binary for $platform-$cpu"
      ;;
  esac
}

download() {
  url=$1
  out=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$out"
  else
    fail "need curl or wget"
  fi
}

sha256_file() {
  file=$1
  if command -v sha256sum >/dev/null 2>&1; then
    set -f
    set -- $(sha256sum "$file")
    set +f
    printf '%s\n' "$1"
  elif command -v shasum >/dev/null 2>&1; then
    set -f
    set -- $(shasum -a 256 "$file")
    set +f
    printf '%s\n' "$1"
  else
    fail "need sha256sum or shasum"
  fi
}

release_url() {
  file=$1
  if [ "$version" = latest ]; then
    printf '%s/latest/download/%s\n' "$base_url" "$file"
    return
  fi

  tag=$version
  case "$tag" in
    v*) ;;
    *) tag="v$tag" ;;
  esac
  printf '%s/download/%s/%s\n' "$base_url" "$tag" "$file"
}

detect_asset

tmp_dir=$(mktemp -d 2>/dev/null || mktemp -d -t pc-install)
temp_install=
trap 'rm -rf "$tmp_dir"; if [ -n "${temp_install:-}" ]; then rm -f "$temp_install"; fi' EXIT HUP INT TERM

binary_path=$tmp_dir/$asset
checksum_path=$tmp_dir/$asset.sha256

download "$(release_url "$asset")" "$binary_path"
download "$(release_url "$asset.sha256")" "$checksum_path"

checksum_line=
IFS= read -r checksum_line < "$checksum_path" || [ -n "$checksum_line" ] || fail "unable to read checksum file"
set -f
set -- $checksum_line
set +f
expected_hash=${1:-}
checksum_name=${2:-}
[ -n "$expected_hash" ] || fail "checksum file is empty"
[ "$checksum_name" = "$asset" ] || fail "checksum file is for $checksum_name, expected $asset"

actual_hash=$(sha256_file "$binary_path")
[ "$actual_hash" = "$expected_hash" ] || fail "checksum mismatch for $asset"

chmod 755 "$binary_path"
help_output=$({ "$binary_path" --help || true; } 2>&1)
case "$help_output" in
  *"pc - Proton Calendar CLI"*) ;;
  *) fail "downloaded $asset did not pass smoke check" ;;
esac

mkdir -p "$install_dir"
[ -d "$install_dir" ] || fail "$install_dir is not a directory"
[ -w "$install_dir" ] || fail "$install_dir is not writable; use --dir or PC_INSTALL_DIR"

temp_install=$install_dir/.pc.$$.tmp
target=$install_dir/pc
cp "$binary_path" "$temp_install"
chmod 755 "$temp_install"
mv "$temp_install" "$target"

printf 'Installed pc to %s\n' "$target"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *)
    printf 'Add pc to your PATH:\n'
    printf '  export PATH="%s:$PATH"\n' "$install_dir"
    ;;
esac

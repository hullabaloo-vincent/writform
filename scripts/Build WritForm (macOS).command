#!/bin/bash
#
# Double-clickable macOS build script.
#
# Builds WritForm.app from source on this machine. Because the app is compiled
# locally rather than downloaded, macOS never attaches the quarantine flag —
# so the result opens with no Gatekeeper warning and no `xattr` incantation.
#
# Checks (and offers to install) everything the build needs: Xcode Command
# Line Tools, Node, and Rust. Nothing is installed without asking first.
#
# The `.command` extension is what makes Finder run this in Terminal on a
# double-click; a plain `.sh` would open in a text editor instead.

set -uo pipefail

# --------------------------------------------------------------- appearance

if [ -t 1 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

step()  { printf '\n%s==>%s %s%s%s\n' "$BLUE" "$RESET" "$BOLD" "$1" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
err()   { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
info()  { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }

# Keep the Terminal window readable after a double-click, win or lose.
pause_and_exit() {
  local code="${1:-0}"
  if [ -t 0 ]; then
    printf '\n%sPress Return to close this window.%s ' "$DIM" "$RESET"
    read -r _ || true
  fi
  exit "$code"
}

fail() {
  err "$1"
  printf '\n%sBuild failed.%s If you are stuck, open an issue with the output above:\n' "$RED" "$RESET"
  printf '  https://github.com/hullabaloo-vincent/writform/issues\n'
  pause_and_exit 1
}

# Ask a yes/no question. Defaults to yes; auto-yes when non-interactive.
confirm() {
  local prompt="$1" reply
  if [ ! -t 0 ]; then
    info "non-interactive, assuming yes: $prompt"
    return 0
  fi
  printf '  %s%s%s [Y/n] ' "$BOLD" "$prompt" "$RESET"
  read -r reply || return 1
  case "$reply" in
    [nN]*) return 1 ;;
    *)     return 0 ;;
  esac
}

# ------------------------------------------------------------------ prelude

# A double-click starts in the home directory, so anchor to the repo root.
cd "$(dirname "${BASH_SOURCE[0]}")/.." || fail "cannot locate the repository"
REPO_ROOT="$(pwd)"

printf '%s\n' "$BOLD"
printf '  WritForm — build from source\n'
printf '%s' "$RESET"
printf '  %sCompiles the app on this Mac. Because it is built here rather than%s\n' "$DIM" "$RESET"
printf '  %sdownloaded, macOS will not quarantine it — it just opens.%s\n' "$DIM" "$RESET"
printf '  %sFirst build takes a while (Rust compiles a lot); later ones are fast.%s\n' "$DIM" "$RESET"

[ "$(uname -s)" = "Darwin" ] || fail "this script is for macOS. On Linux/Windows use: npm ci && npx tauri build"
[ -f "$REPO_ROOT/apps/desktop/src-tauri/tauri.conf.json" ] || \
  fail "run this from inside the writform repository (expected apps/desktop/src-tauri/)"

step "Checking what this build needs"
info "$(sw_vers -productName) $(sw_vers -productVersion) on $(uname -m)"

# ------------------------------------------------------- Xcode Command Line Tools

if xcode-select -p >/dev/null 2>&1; then
  ok "Xcode Command Line Tools"
else
  warn "Xcode Command Line Tools are missing (needed to link native code)"
  if confirm "Install them now? A macOS installer window will open."; then
    xcode-select --install >/dev/null 2>&1 || true
    info "Finish the install in the window that just opened, then press Return here."
    [ -t 0 ] && read -r _
    xcode-select -p >/dev/null 2>&1 || fail "still not found — re-run this script once the install finishes"
    ok "Xcode Command Line Tools installed"
  else
    fail "cannot build without the Command Line Tools"
  fi
fi

# ------------------------------------------------------------------ Node.js

NODE_MIN_MAJOR=20
NODE_MIN_MINOR=19   # Vite 7 requires Node 20.19+ or 22.12+

node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node --version 2>/dev/null)"; v="${v#v}"
  major="${v%%.*}"; minor="${v#*.}"; minor="${minor%%.*}"
  [ "$major" -gt "$NODE_MIN_MAJOR" ] && return 0
  [ "$major" -eq "$NODE_MIN_MAJOR" ] && [ "$minor" -ge "$NODE_MIN_MINOR" ] && return 0
  return 1
}

if node_version_ok; then
  ok "Node $(node --version)"
else
  if command -v node >/dev/null 2>&1; then
    warn "Node $(node --version) is too old (need ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+)"
  else
    warn "Node is not installed (need ${NODE_MIN_MAJOR}.${NODE_MIN_MINOR}+)"
  fi
  if command -v brew >/dev/null 2>&1; then
    if confirm "Install the current Node LTS with Homebrew?"; then
      brew install node@22 || fail "Homebrew could not install Node"
      # Keg-only formulae are not linked into PATH automatically.
      for p in "$(brew --prefix)/opt/node@22/bin" "$(brew --prefix)/bin"; do
        [ -d "$p" ] && PATH="$p:$PATH"
      done
      export PATH
      node_version_ok || fail "Node still not on PATH — open a new Terminal and re-run this script"
      ok "Node $(node --version)"
    else
      fail "Node is required to build the interface"
    fi
  else
    err "Homebrew is not installed, so this script cannot install Node for you."
    info "Install Node 22 LTS from https://nodejs.org (the .pkg installer), then re-run this script."
    fail "Node is required to build the interface"
  fi
fi

command -v npm >/dev/null 2>&1 || fail "npm is missing even though Node is installed — reinstall Node"

# -------------------------------------------------------------------- Rust

if command -v cargo >/dev/null 2>&1; then
  ok "Rust $(rustc --version 2>/dev/null | cut -d' ' -f2)"
  if ! command -v rustup >/dev/null 2>&1; then
    # rust-toolchain.toml pins 1.90.0, but only rustup honours it.
    warn "Rust was not installed via rustup, so the pinned toolchain is ignored"
    info "If the build fails with a compiler error, install rustup from https://rustup.rs"
  fi
else
  warn "Rust is not installed (the app core is written in Rust)"
  if confirm "Install Rust via rustup? This is the official installer."; then
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path \
      || fail "rustup install failed"
    # shellcheck disable=SC1091
    [ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
    export PATH="$HOME/.cargo/bin:$PATH"
    command -v cargo >/dev/null 2>&1 || fail "cargo still not found — open a new Terminal and re-run this script"
    ok "Rust $(rustc --version | cut -d' ' -f2) installed"
  else
    fail "Rust is required to build the app"
  fi
fi

# ------------------------------------------------------------------- build

step "Installing interface dependencies"
cd "$REPO_ROOT/apps/desktop" || fail "cannot enter apps/desktop"
if [ -f package-lock.json ]; then
  npm ci || fail "npm ci failed"
else
  npm install || fail "npm install failed"
fi
ok "dependencies ready"

step "Building WritForm (this is the slow part — grab a coffee)"
# --bundles app: just the .app, no DMG/installer wrapper needed locally.
# createUpdaterArtifacts=false: the updater artifact would demand the
# project's private signing key, which only the release pipeline has.
npx tauri build \
  --bundles app \
  --config '{"bundle":{"createUpdaterArtifacts":false}}' \
  || fail "the build failed — the compiler output above says why"

APP_PATH="$REPO_ROOT/target/release/bundle/macos/WritForm.app"
[ -d "$APP_PATH" ] || fail "build reported success but WritForm.app is missing"
ok "built $APP_PATH"

# Confirm the bundle is properly signed; an invalid signature is the thing
# that makes macOS call an app "damaged".
if codesign --verify --strict "$APP_PATH" >/dev/null 2>&1; then
  ok "code signature valid (ad-hoc)"
else
  warn "code signature could not be verified — the app may still run, but report this"
fi

# ---------------------------------------------------------------- install

step "Installing"
if confirm "Move WritForm.app to your Applications folder?"; then
  if [ -e "/Applications/WritForm.app" ]; then
    if confirm "WritForm is already in Applications. Replace it?"; then
      rm -rf "/Applications/WritForm.app" || fail "could not remove the old copy"
    else
      info "keeping the existing copy; the fresh build stays in target/release/bundle/macos/"
      open -R "$APP_PATH"
      printf '\n%sDone.%s\n' "$GREEN" "$RESET"
      pause_and_exit 0
    fi
  fi
  cp -R "$APP_PATH" /Applications/ || fail "could not copy to /Applications"
  ok "installed to /Applications/WritForm.app"
  FINAL="/Applications/WritForm.app"
else
  info "left in place: $APP_PATH"
  FINAL="$APP_PATH"
fi

printf '\n%s%sWritForm is ready.%s\n' "$BOLD" "$GREEN" "$RESET"
info "Built on this Mac, so it is not quarantined — it opens like any other app."

if confirm "Open WritForm now?"; then
  open "$FINAL" || warn "could not launch it; open it from Finder"
else
  open -R "$FINAL"
fi

pause_and_exit 0

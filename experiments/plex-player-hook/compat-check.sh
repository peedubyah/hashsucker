#!/usr/bin/env bash
# Version-gated compatibility probe for the Plex HTPC local executor experiment.
# Read-only. Does not modify Plex. Exits 0 only when the pinned build is present.
set -euo pipefail
PINNED="1.71.1.346"
BIN="${PLEX_HTPC_BIN:-/opt/plex-htpc/Plex}"
if [[ ! -x "$BIN" ]]; then
  echo "plex htpc binary not found at $BIN" >&2
  exit 2
fi
VER="$("$BIN" --version 2>/dev/null | head -1 || true)"
echo "detected: $VER"
if [[ "$VER" != *"$PINNED"* ]]; then
  echo "unsupported build (expected $PINNED). Refusing to proceed." >&2
  exit 1
fi
echo "compatible build detected"

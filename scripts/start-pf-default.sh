#!/bin/bash
# Start a fresh hy4-data-plane proof container with the P12 default-ON image.
# Unlike start-pf.sh, this variant OMITS PREFETCH_ENABLED entirely so the
# new default (default-ON) fires. PREFETCH_MODE is still set explicitly so
# auto-vs-try/wait is observable.
#
# Usage: start-pf-default.sh <name> <port> <volume> <prefetch_mode auto|try|wait>

set -e
NAME="$1"
PORT="$2"
VOL="$3"
PFM="$4"

if [ -z "$NAME" ] || [ -z "$PORT" ] || [ -z "$VOL" ] || [ -z "$PFM" ]; then
  echo "usage: start-pf-default.sh <name> <port> <volume> <prefetch_mode auto|try|wait>"
  exit 2
fi

docker run -d \
  --name "$NAME" \
  --network hashsucker_default \
  -p "127.0.0.1:${PORT}:3001" \
  -v "${VOL}:/data" \
  --restart unless-stopped \
  -e LISTEN="0.0.0.0:3001" \
  -e CONTROL_URL="http://media-search:3000/api" \
  -e CACHE_ROOT="/data/cache" \
  -e TORBOX_API_KEY="77640450-ccff-4cd9-a234-8882c4a06628" \
  -e REALDEBRID_API_KEY="ZGEV7DKXDVCHZP5FVAX2RNSTSPIHTQUY4FVMX2K2HRPFRURTDRJA" \
  -e PREFETCH_MODE="$PFM" \
  -e PREFETCH_AHEAD_CHUNKS=1 \
  -e PREFETCH_SEQUENTIAL_THRESHOLD=2 \
  -e RUST_LOG=info \
  hy4-data-plane:local

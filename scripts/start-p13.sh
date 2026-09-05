#!/bin/bash
# Start a fresh hy4-data-plane P13 proof container with the new image
# (hy4-data-plane:p13) and an explicit HY4_FORCE_PROVIDER env-var.
#
# Usage: start-p13.sh <name> <port> <volume> <force_provider_spec>
#   force_provider_spec = empty string ""  -> filter DISABLED (full providers)
#   force_provider_spec = "tfId:provider,provider" -> restrict to that allowlist
#   force_provider_spec = "tfId:provider,provider;tfId2:provider" -> multi
#
# Example:
#   start-p13.sh p13-dp 3011 p13-vol-2 ""  # no filter
#   start-p13.sh p13-dp 3011 p13-vol-2 \
#     "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d:torbox"  # TB-only
#   start-p13.sh p13-dp 3011 p13-vol-2 \
#     "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d:realdebrid"  # RD-only
#   start-p13.sh p13-dp 3011 p13-vol-2 \
#     "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d:torbox,realdebrid"  # both (default)

set -e
NAME="$1"
PORT="$2"
VOL="$3"
FORCE_PROVIDER="$4"

if [ -z "$NAME" ] || [ -z "$PORT" ] || [ -z "$VOL" ]; then
  echo "usage: start-p13.sh <name> <port> <volume> <force_provider_spec_or_empty>"
  exit 2
fi

# Remove any existing container with this name (ignore errors).
docker rm -f "$NAME" >/dev/null 2>&1 || true
sleep 1

# Base docker run args. Cache volume persists across restarts so restart
# proofs can observe the cache-hit behaviour on the same data.
DOCKER_ARGS=(
  --name "$NAME"
  --network hashsucker_default
  -p "127.0.0.1:${PORT}:3001"
  -v "${VOL}:/data"
  --restart unless-stopped
  -e LISTEN="0.0.0.0:3001"
  -e CONTROL_URL="http://media-search:3000/api"
  -e CACHE_ROOT="/data/cache"
  -e TORBOX_API_KEY="77640450-ccff-4cd9-a234-8882c4a06628"
  -e REALDEBRID_API_KEY="ZGEV7DKXDVCHP5FVAX2RNSTSPIHTQUY4FVMX2K2HRPFRURTDRJA"
  -e RUST_LOG=info
)

# Only pass HY4_FORCE_PROVIDER when non-empty.
if [ -n "$FORCE_PROVIDER" ]; then
  DOCKER_ARGS+=( -e "HY4_FORCE_PROVIDER=${FORCE_PROVIDER}" )
  echo "[p13] HY4_FORCE_PROVIDER=${FORCE_PROVIDER}"
else
  echo "[p13] HY4_FORCE_PROVIDER (unset) -> no filter"
fi

docker run -d "${DOCKER_ARGS[@]}" hy4-data-plane:p13
sleep 4
echo "DOCKER-STARTED"

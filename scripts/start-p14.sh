#!/bin/bash
# Start a fresh hy4-data-plane P14 proof container with the new image
# (hy4-data-plane:p14) and explicit HY4_FORCE_PROVIDER + HY4_FORCE_FAIL_PROVIDER.
#
# Usage: start-p14.sh <name> <port> <volume> <force_provider_spec> <force_fail_provider_spec>
#   force_provider_spec = empty string ""  -> allowlist DISABLED (full providers)
#   force_provider_spec = "tfId:provider,provider" -> restrict to that allowlist
#   force_fail_provider_spec = empty string "" -> deny DISABLED
#   force_fail_provider_spec = "tfId:provider" -> deny that single provider slot
#
# Example:
#   start-p14.sh p14-dp-rdonly 3012 p14-vol-1 \
#     "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d:realdebrid" ""  # RD-only, no fault
#   start-p14.sh p14-dp-dual 3013 p14-vol-1 \
#     "" "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d:torbox"  # both providers, TB denied
#   start-p14.sh p14-dp-dual 3013 p14-vol-1 \
#     "" "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d:realdebrid"  # both providers, RD denied

set -e
NAME="$1"
PORT="$2"
VOL="$3"
FORCE_PROVIDER="$4"
FORCE_FAIL_PROVIDER="$5"

if [ -z "$NAME" ] || [ -z "$PORT" ] || [ -z "$VOL" ]; then
  echo "usage: start-p14.sh <name> <port> <volume> <force_provider_spec_or_empty> <force_fail_provider_spec_or_empty>"
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
  -e REALDEBRID_API_KEY="ZGEV7DKXDVCHZP5FVAX2RNSTSPIHTQUY4FVMX2K2HRPFRURTDRJA"
  -e RUST_LOG=info
)

# Only pass HY4_FORCE_PROVIDER when non-empty.
if [ -n "$FORCE_PROVIDER" ]; then
  DOCKER_ARGS+=( -e "HY4_FORCE_PROVIDER=${FORCE_PROVIDER}" )
  echo "[p14] HY4_FORCE_PROVIDER=${FORCE_PROVIDER}"
else
  echo "[p14] HY4_FORCE_PROVIDER (unset) -> no allowlist filter"
fi

# Only pass HY4_FORCE_FAIL_PROVIDER when non-empty.
if [ -n "$FORCE_FAIL_PROVIDER" ]; then
  DOCKER_ARGS+=( -e "HY4_FORCE_FAIL_PROVIDER=${FORCE_FAIL_PROVIDER}" )
  echo "[p14] HY4_FORCE_FAIL_PROVIDER=${FORCE_FAIL_PROVIDER}"
else
  echo "[p14] HY4_FORCE_FAIL_PROVIDER (unset) -> no slot fault"
fi

docker run -d "${DOCKER_ARGS[@]}" hy4-data-plane:p14
sleep 4
echo "DOCKER-STARTED"

#!/bin/bash
# Start a fresh hy4-data-plane P14/P15 proof container with the new image
# (hy4-data-plane:p15) and explicit HY4_FORCE_PROVIDER + HY4_FORCE_FAIL_PROVIDER
# + HY4_FORCE_SLOT_FAILURE.
#
# Usage: start-p14.sh <name> <port> <volume> <force_provider_spec> <force_fail_provider_spec> <force_slot_failure_spec> [image]
#   force_provider_spec = empty string ""  -> allowlist DISABLED (full providers)
#   force_provider_spec = "tfId:provider,provider" -> restrict to that allowlist
#   force_fail_provider_spec = empty string "" -> deny DISABLED (pre-construction)
#   force_fail_provider_spec = "tfId:provider" -> deny that single provider slot pre-construction
#   force_slot_failure_spec = empty string "" -> runtime fault DISABLED
#   force_slot_failure_spec = "tfId:provider" -> runtime fault that single slot
#   force_slot_failure_spec = "tfId:torbox;tfId:realdebrid" -> both runtime faults
#   image = "hy4-data-plane:p15" (default) or "hy4-data-plane:p14" etc.
#
# Example:
#   start-p14.sh p14-dp-rdonly 3012 p14-vol-1 \
#     "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d:realdebrid" "" ""   # RD-only, no fault
#   start-p14.sh p15-dp-tb-to-rd 3014 p15-vol-1 \
#     "" "" "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d:torbox"   # TB->RD runtime fault

set -e
NAME="$1"
PORT="$2"
VOL="$3"
FORCE_PROVIDER="$4"
FORCE_FAIL_PROVIDER="$5"
FORCE_SLOT_FAILURE="$6"
IMAGE="${7:-hy4-data-plane:p15}"

if [ -z "$NAME" ] || [ -z "$PORT" ] || [ -z "$VOL" ]; then
  echo "usage: start-p14.sh <name> <port> <volume> <force_provider_spec_or_empty> <force_fail_provider_spec_or_empty> <force_slot_failure_spec_or_empty> [image]"
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
  echo "[start] HY4_FORCE_PROVIDER=${FORCE_PROVIDER}"
else
  echo "[start] HY4_FORCE_PROVIDER (unset) -> no allowlist filter"
fi

# Only pass HY4_FORCE_FAIL_PROVIDER when non-empty.
if [ -n "$FORCE_FAIL_PROVIDER" ]; then
  DOCKER_ARGS+=( -e "HY4_FORCE_FAIL_PROVIDER=${FORCE_FAIL_PROVIDER}" )
  echo "[start] HY4_FORCE_FAIL_PROVIDER=${FORCE_FAIL_PROVIDER}"
else
  echo "[start] HY4_FORCE_FAIL_PROVIDER (unset) -> no pre-construction slot filter"
fi

# Only pass HY4_FORCE_SLOT_FAILURE when non-empty.
if [ -n "$FORCE_SLOT_FAILURE" ]; then
  DOCKER_ARGS+=( -e "HY4_FORCE_SLOT_FAILURE=${FORCE_SLOT_FAILURE}" )
  echo "[start] HY4_FORCE_SLOT_FAILURE=${FORCE_SLOT_FAILURE}"
else
  echo "[start] HY4_FORCE_SLOT_FAILURE (unset) -> no runtime fault"
fi

# HY4_FORCE_SLOT_ORDER (P15 bench): re-order the slot list so a specific
# provider is FIRST. Combined with HY4_FORCE_SLOT_FAILURE, this lets the
# bench force any provider as the first-tried slot.
HY4_FORCE_SLOT_ORDER="${HY4_FORCE_SLOT_ORDER:-}"
if [ -n "$HY4_FORCE_SLOT_ORDER" ]; then
  DOCKER_ARGS+=( -e "HY4_FORCE_SLOT_ORDER=${HY4_FORCE_SLOT_ORDER}" )
  echo "[start] HY4_FORCE_SLOT_ORDER=${HY4_FORCE_SLOT_ORDER}"
else
  echo "[start] HY4_FORCE_SLOT_ORDER (unset) -> S-1 order preserved"
fi

docker run -d "${DOCKER_ARGS[@]}" "${IMAGE}"
sleep 4
echo "DOCKER-STARTED"

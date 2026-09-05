#!/bin/bash
# Restart pf-off / pf-a / pf-b with the freshly built hy4-data-plane:local image
# preserving each container's named volume (cache state).

set -e

ENV_FILE="$1"
PORT="$2"
NAME="$3"
VOLUME="$4"

if [ -z "$ENV_FILE" ] || [ -z "$PORT" ] || [ -z "$NAME" ] || [ -z "$VOLUME" ]; then
  echo "usage: restart-pf.sh <env-file> <host-port> <name> <volume>"
  exit 2
fi

# Read env file (one KEY=VAL per line; comments skipped) into --env args
mapfile -t env_lines < <(grep -v '^[[:space:]]*#' "$ENV_FILE" | grep -v '^[[:space:]]*$' || true)

# Stop + remove existing container with this name (if any)
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "[restart-pf] removing existing container $NAME"
  docker rm -f "$NAME" >/dev/null
fi

echo "[restart-pf] starting $NAME (port $PORT) with volume $VOLUME"
docker run -d \
  --name "$NAME" \
  --network hashsucker_default \
  -p "127.0.0.1:${PORT}:3001" \
  -v "${VOLUME}:/data" \
  --restart unless-stopped \
  $(printf -- '--env %q ' "${env_lines[@]}") \
  hy4-data-plane:local

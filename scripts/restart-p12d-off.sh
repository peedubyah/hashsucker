#!/bin/bash
# Restart the container with PREFETCH_ENABLED=0 (kill switch).
# Usage: restart-p12d-off.sh <name> <port> <volume>
set +e
NAME="$1"
PORT="$2"
VOL="$3"

docker rm -f "$NAME" >/dev/null 2>&1
docker volume rm "$VOL" >/dev/null 2>&1
sleep 2

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
  -e REALDEBRID_API_KEY="ZGEV7DKXDVCHP5FVAX2RNSTSPIHTQUY4FVMX2K2HRPFRURTDRJA" \
  -e PREFETCH_ENABLED=0 \
  -e PREFETCH_MODE=auto \
  -e PREFETCH_AHEAD_CHUNKS=1 \
  -e PREFETCH_SEQUENTIAL_THRESHOLD=2 \
  -e RUST_LOG=info \
  hy4-data-plane:local

sleep 4
echo "DOCKER-STARTED"

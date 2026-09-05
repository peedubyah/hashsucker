#!/bin/bash
# P12 default-ON container with PREFETCH_MODE=wait (forces the prefetch to
# wait briefly for the capability, then fill ahead). Used to exercise the
# served/joined path on a single-capability workload where spare_capacity=0.
set +e
docker rm -f "$1" >/dev/null 2>&1
docker volume rm "$3" >/dev/null 2>&1
sleep 2
docker run -d \
  --name "$1" \
  --network hashsucker_default \
  -p "127.0.0.1:$2:3001" \
  -v "$3:/data" \
  --restart unless-stopped \
  -e LISTEN="0.0.0.0:3001" \
  -e CONTROL_URL="http://media-search:3000/api" \
  -e CACHE_ROOT="/data/cache" \
  -e TORBOX_API_KEY="77640450-ccff-4cd9-a234-8882c4a06628" \
  -e REALDEBRID_API_KEY="ZGEV7DKXDVCHZP5FVAX2RNSTSPIHTQUY4FVMX2K2HRPFRURTDRJA" \
  -e PREFETCH_MODE=wait \
  -e PREFETCH_AHEAD_CHUNKS=1 \
  -e PREFETCH_SEQUENTIAL_THRESHOLD=2 \
  -e RUST_LOG=info \
  hy4-data-plane:local
sleep 3
docker exec "$1" sh -c "ls /data/cache; echo WAIT-START-DONE"

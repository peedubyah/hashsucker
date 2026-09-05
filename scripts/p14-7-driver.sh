#!/bin/bash
# P14-7 driver: RD stale-runtime repair.
# Set RD_TTL_SECONDS=5 so the cached RD capability expires after 5s.
# Serve a range, sleep past TTL, serve another range. The second must
# re-acquire (cap.acq++) and serve 206 with the same reference SHAs.

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p14-dp-rd-stale"
PORT="3017"
VOL="p14-vol-rd-stale"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p14"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p14-7] ==== STEP 0: S-1 pre-check ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/pre  : /' | tee "${LOGDIR}/p14-7-pre-s1-${TIMESTAMP}.txt"

echo "[p14-7] ==== STEP 1: start container, RD-only + RD_TTL_SECONDS=5 ===="
docker rm -f "${NAME}" >/dev/null 2>&1 || true
sleep 1
DOCKER_ARGS=(
  --name "${NAME}"
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
  -e "HY4_FORCE_PROVIDER=${TFID}:realdebrid"
  -e "RD_TTL_SECONDS=5"
)
docker run -d "${DOCKER_ARGS[@]}" hy4-data-plane:p14
sleep 4
echo "DOCKER-STARTED"

echo "[p14-7] ==== STEP 2: health probe ===="
for i in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p14-7] healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p14-7] ==== STEP 3: bench (phase1 acquire, sleep, phase3 reacquire) ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p14
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p14-7-rd-stale-phase1" \
  node p14-7-rd-stale.mjs 2>&1 | tee "${LOGDIR}/p14-7-phase1-${TIMESTAMP}.log"
PHASE1_RC=${PIPESTATUS[0]}

echo "[p14-7] ==== STEP 4: container log capture ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE|rd |p1[34]" | tee "${LOGDIR}/p14-7-containerlog-${TIMESTAMP}.txt" || true

echo "[p14-7] ==== STEP 5: S-1 post-check ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/post : /' | tee "${LOGDIR}/p14-7-post-s1-${TIMESTAMP}.txt"

echo "[p14-7] ==== DONE (phase1_rc=${PHASE1_RC}) ===="
exit $PHASE1_RC

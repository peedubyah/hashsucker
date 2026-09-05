#!/bin/bash
# P13-8 driver: stale-state repair across container restart.
# Same shape as p13-2-driver.sh but on the dual container (3013).

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p13-dp-dual"
PORT="3013"
VOL="p13-dp-dual-vol"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p13"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p13-8] ==== STEP 0: ensure dual container is up ===="
if ! curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics" 2>/dev/null; then
  echo "[p13-8] dual container not healthy; (re)starting"
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  sleep 2
  bash /c/src/hashsucker/scripts/start-p13.sh "${NAME}" "${PORT}" "${VOL}" "${TFID}:torbox,realdebrid"
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
      echo "[p13-8] healthy on attempt $i"; break
    fi
    sleep 1
  done
fi

echo "[p13-8] ==== STEP 1: phase 1 bench (pre-restart) ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p13
DUAL_DP="${DP_URL}" TFID="${TFID}" LABEL="p13-8-pre" \
  node p13-8-stale-repair.mjs 2>&1 | tee "${LOGDIR}/p13-8-pre-${TIMESTAMP}.log" || true
# Note: this bench internally waits for an external restart. We do the restart below.

echo "[p13-8] ==== STEP 2: container restart (env + volume preserved) ===="
docker rm -f "${NAME}" >/dev/null 2>&1 || true
sleep 2
bash /c/src/hashsucker/scripts/start-p13.sh "${NAME}" "${PORT}" "${VOL}" "${TFID}:torbox,realdebrid"

for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p13-8] post-restart healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p13-8] ==== STEP 3: phase 2 bench (post-restart) ===="
DUAL_DP="${DP_URL}" TFID="${TFID}" LABEL="p13-8-post" \
  node p13-8-stale-repair.mjs 2>&1 | tee "${LOGDIR}/p13-8-post-${TIMESTAMP}.log" || true

echo "[p13-8] ==== STEP 4: container log capture ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE_PROVIDER|p13" | tail -10 | tee "${LOGDIR}/p13-8-containerlog-${TIMESTAMP}.txt" || true

echo "[p13-8] ==== DONE ===="

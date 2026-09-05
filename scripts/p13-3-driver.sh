#!/bin/bash
# P13-3 driver: RealDebrid-only proof.
# Mirrors p13-2-driver.sh but with HY4_FORCE_PROVIDER=:realdebrid.
# The bench script (p13-3-rd-only.mjs) reuses p13-2-tb-only.mjs logic via env.

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p13-dp-rdonly"
PORT="3012"
VOL="p13-dp-rd-vol"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p13"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p13-3] ==== STEP 0: S-1 durable state pre-check (must show BOTH providers) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/pre  : /' | tee "${LOGDIR}/p13-3-pre-s1-${TIMESTAMP}.txt"

echo "[p13-3] ==== STEP 1: start container with HY4_FORCE_PROVIDER=:realdebrid ===="
bash /c/src/hashsucker/scripts/start-p13.sh "${NAME}" "${PORT}" "${VOL}" "${TFID}:realdebrid"

echo "[p13-3] ==== STEP 2: container health probe ===="
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p13-3] healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p13-3] ==== STEP 3: phase 1 bench (range + seek, NO restart yet) ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p13
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p13-3-rdonly-phase1" \
  node p13-2-tb-only.mjs 2>&1 | tee "${LOGDIR}/p13-3-phase1-${TIMESTAMP}.log"
PHASE1_RC=${PIPESTATUS[0]}

echo "[p13-3] ==== STEP 4: container restart (env preserved) ===="
docker rm -f "${NAME}" >/dev/null 2>&1 || true
sleep 2
bash /c/src/hashsucker/scripts/start-p13.sh "${NAME}" "${PORT}" "${VOL}" "${TFID}:realdebrid"

for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p13-3] post-restart healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p13-3] ==== STEP 5: phase 2 bench (re-run, post-restart) ===="
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p13-3-rdonly-phase2" \
  node p13-2-tb-only.mjs 2>&1 | tee "${LOGDIR}/p13-3-phase2-${TIMESTAMP}.log"
PHASE2_RC=${PIPESTATUS[0]}

echo "[p13-3] ==== STEP 6: container log capture (look for HY4_FORCE_PROVIDER line) ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE_PROVIDER|p13" | tee "${LOGDIR}/p13-3-containerlog-${TIMESTAMP}.txt" || true

echo "[p13-3] ==== STEP 7: S-1 durable state post-check (must STILL show BOTH) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/post : /' | tee "${LOGDIR}/p13-3-post-s1-${TIMESTAMP}.txt"

echo "[p13-3] ==== DONE (phase1_rc=${PHASE1_RC} phase2_rc=${PHASE2_RC}) ===="

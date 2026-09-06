#!/bin/bash
# P13-2 driver: TorBox-only proof.
#
# Sequence:
#   1. Verify S-1 durable state for the frozen tfId has BOTH providers.
#   2. Start a fresh P13 container with HY4_FORCE_PROVIDER=tf_5de34a78...:torbox.
#   3. Capture container log baseline.
#   4. Run p13-2-tb-only.mjs phase 1 (range+seek+restart probe, no restart yet).
#   5. Restart the container (cache volume preserved, env preserved).
#   6. Run p13-2-tb-only.mjs phase 2 (post-restart reads).
#   7. Capture container log, find HY4_FORCE_PROVIDER stderr line, confirm.
#   8. Verify S-1 durable state STILL has BOTH providers (no DB side effects).

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p13-dp-tbonly"
PORT="3011"
VOL="p13-dp-vol"
DP_URL="http://127.0.0.1:${PORT}"
S1_URL="http://127.0.0.1:3300"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p13"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p13-2] ==== STEP 0: S-1 durable state pre-check (must show BOTH providers) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/pre  : /' | tee "${LOGDIR}/p13-2-pre-s1-${TIMESTAMP}.txt"

echo "[p13-2] ==== STEP 1: start container with HY4_FORCE_PROVIDER=:torbox ===="
bash /c/src/hashsucker/scripts/start-p13.sh "${NAME}" "${PORT}" "${VOL}" "${TFID}:torbox"

echo "[p13-2] ==== STEP 2: container health probe ===="
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p13-2] healthy on attempt $i"
    break
  fi
  echo "[p13-2] attempt $i: not ready"
  sleep 1
done

echo "[p13-2] ==== STEP 3: phase 1 bench (range + seek, NO restart yet) ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p13
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p13-2-tbonly-phase1" \
  node p13-2-tb-only.mjs 2>&1 | tee "${LOGDIR}/p13-2-phase1-${TIMESTAMP}.log"
PHASE1_RC=${PIPESTATUS[0]}

echo "[p13-2] ==== STEP 4: container restart (env preserved) ===="
# The bench script signals "WAITING-RESTART" and the wrapper does the restart.
# We restart the container in-place: rm + run again with the SAME env.
docker rm -f "${NAME}" >/dev/null 2>&1 || true
sleep 2
bash /c/src/hashsucker/scripts/start-p13.sh "${NAME}" "${PORT}" "${VOL}" "${TFID}:torbox"

# Wait for it to come back.
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p13-2] post-restart healthy on attempt $i"
    break
  fi
  sleep 1
done

echo "[p13-2] ==== STEP 5: phase 2 bench (re-run, post-restart) ===="
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p13-2-tbonly-phase2" \
  node p13-2-tb-only.mjs 2>&1 | tee "${LOGDIR}/p13-2-phase2-${TIMESTAMP}.log"
PHASE2_RC=${PIPESTATUS[0]}

echo "[p13-2] ==== STEP 6: container log capture (look for HY4_FORCE_PROVIDER line) ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE_PROVIDER|p13" | tee "${LOGDIR}/p13-2-containerlog-${TIMESTAMP}.txt" || true

echo "[p13-2] ==== STEP 7: S-1 durable state post-check (must STILL show BOTH) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/post : /' | tee "${LOGDIR}/p13-2-post-s1-${TIMESTAMP}.txt"

echo "[p13-2] ==== DONE (phase1_rc=${PHASE1_RC} phase2_rc=${PHASE2_RC}) ===="

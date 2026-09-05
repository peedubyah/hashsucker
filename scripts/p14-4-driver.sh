#!/bin/bash
# P14-4 driver: TB->RD shielding proof.
# Start a fresh dual-provider container (no allowlist). Set
# HY4_FORCE_FAIL_PROVIDER=tf_5de34a78...:torbox so the TB slot is
# surgically removed. The RD slot must then serve 206 with the same
# reference SHAs the TB slot normally serves.

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p14-dp-tb-to-rd"
PORT="3014"
VOL="p14-vol-tb-to-rd"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p14"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p14-4] ==== STEP 0: S-1 durable state pre-check (must show BOTH providers) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/pre  : /' | tee "${LOGDIR}/p14-4-pre-s1-${TIMESTAMP}.txt"

echo "[p14-4] ==== STEP 1: start container, HY4_FORCE_FAIL_PROVIDER=:torbox ===="
bash /c/src/hashsucker/scripts/start-p14.sh "${NAME}" "${PORT}" "${VOL}" "" "${TFID}:torbox"

echo "[p14-4] ==== STEP 2: container health probe ===="
for i in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p14-4] healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p14-4] ==== STEP 3: phase 1 bench (3 ranges, RD must serve with TB reference SHAs) ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p14
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p14-4-tb-to-rd-phase1" \
  node p14-4-tb-to-rd.mjs 2>&1 | tee "${LOGDIR}/p14-4-phase1-${TIMESTAMP}.log"
PHASE1_RC=${PIPESTATUS[0]}

echo "[p14-4] ==== STEP 4: container log capture (look for HY4_FORCE_FAIL_PROVIDER line) ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE|p1[34]" | tee "${LOGDIR}/p14-4-containerlog-${TIMESTAMP}.txt" || true

echo "[p14-4] ==== STEP 5: S-1 durable state post-check (must STILL show BOTH) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/post : /' | tee "${LOGDIR}/p14-4-post-s1-${TIMESTAMP}.txt"

echo "[p14-4] ==== DONE (phase1_rc=${PHASE1_RC}) ===="
exit $PHASE1_RC

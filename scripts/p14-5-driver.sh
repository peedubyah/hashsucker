#!/bin/bash
# P14-5 driver: RD->TB shielding proof (mirror of P14-4).
# HY4_FORCE_FAIL_PROVIDER=:realdebrid so the RD slot is surgically removed.
# TB slot must serve 206 with the reference SHAs.

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p14-dp-rd-to-tb"
PORT="3015"
VOL="p14-vol-rd-to-tb"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p14"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p14-5] ==== STEP 0: S-1 durable state pre-check ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/pre  : /' | tee "${LOGDIR}/p14-5-pre-s1-${TIMESTAMP}.txt"

echo "[p14-5] ==== STEP 1: start container, HY4_FORCE_FAIL_PROVIDER=:realdebrid ===="
bash /c/src/hashsucker/scripts/start-p14.sh "${NAME}" "${PORT}" "${VOL}" "" "${TFID}:realdebrid"

echo "[p14-5] ==== STEP 2: container health probe ===="
for i in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p14-5] healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p14-5] ==== STEP 3: phase 1 bench (TB slot serves with reference SHAs) ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p14
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p14-5-rd-to-tb-phase1" \
  node p14-5-rd-to-tb.mjs 2>&1 | tee "${LOGDIR}/p14-5-phase1-${TIMESTAMP}.log"
PHASE1_RC=${PIPESTATUS[0]}

echo "[p14-5] ==== STEP 4: container log capture (look for HY4_FORCE_FAIL_PROVIDER) ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE|p1[34]" | tee "${LOGDIR}/p14-5-containerlog-${TIMESTAMP}.txt" || true

echo "[p14-5] ==== STEP 5: S-1 durable state post-check ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/post : /' | tee "${LOGDIR}/p14-5-post-s1-${TIMESTAMP}.txt"

echo "[p14-5] ==== DONE (phase1_rc=${PHASE1_RC}) ===="
exit $PHASE1_RC

#!/bin/bash
# P14-6 driver: both providers fault -> 502 PROVIDER_EXHAUSTED.
# Use HY4_FORCE_FAIL_PROVIDER with BOTH providers (semicolon-separated).

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p14-dp-both-dead"
PORT="3016"
VOL="p14-vol-both-dead"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p14"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p14-6] ==== STEP 0: S-1 pre-check ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/pre  : /' | tee "${LOGDIR}/p14-6-pre-s1-${TIMESTAMP}.txt"

echo "[p14-6] ==== STEP 1: start container, BOTH providers denied ===="
bash /c/src/hashsucker/scripts/start-p14.sh "${NAME}" "${PORT}" "${VOL}" "" "${TFID}:torbox;${TFID}:realdebrid"

echo "[p14-6] ==== STEP 2: health probe ===="
for i in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p14-6] healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p14-6] ==== STEP 3: bench - both ranges must return 502 PROVIDER_EXHAUSTED ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p14
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p14-6-both-dead-phase1" \
  node p14-6-both-dead.mjs 2>&1 | tee "${LOGDIR}/p14-6-phase1-${TIMESTAMP}.log"
PHASE1_RC=${PIPESTATUS[0]}

echo "[p14-6] ==== STEP 4: container log capture ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE|PROVIDER_EXHAUSTED|p1[34]" | tee "${LOGDIR}/p14-6-containerlog-${TIMESTAMP}.txt" || true

echo "[p14-6] ==== STEP 5: S-1 post-check ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/post : /' | tee "${LOGDIR}/p14-6-post-s1-${TIMESTAMP}.txt"

echo "[p14-6] ==== DONE (phase1_rc=${PHASE1_RC}) ===="
exit $PHASE1_RC

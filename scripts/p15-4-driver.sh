#!/bin/bash
# P15-4 driver: BOTH runtime slots fail -> 502 PROVIDER_EXHAUSTED.
# Fresh cache volume, no allowlist, HY4_FORCE_SLOT_FAILURE with BOTH providers.

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p15-dp-both-fail"
PORT="3016"
# FRESH volume per run (timestamp) so cache state is not carried over.
VOL="p15-vol-both-fail-$(date -u +%s)"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p15"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p15-4] ==== STEP 0: S-1 pre-check ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/pre  : /' | tee "${LOGDIR}/p15-4-pre-s1-${TIMESTAMP}.txt"

echo "[p15-4] ==== STEP 1: start container, FRESH vol, BOTH providers runtime-failed ===="
bash /c/src/hashsucker/scripts/start-p14.sh "${NAME}" "${PORT}" "${VOL}" "" "" "${TFID}:torbox;${TFID}:realdebrid" hy4-data-plane:p15

echo "[p15-4] ==== STEP 2: health probe ===="
for i in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p15-4] healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p15-4] ==== STEP 3: bench (2 ranges must return 502 PROVIDER_EXHAUSTED) ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p15
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p15-4-both-runtime-fail-phase1" \
  node p15-4-both-runtime-fail.mjs 2>&1 | tee "${LOGDIR}/p15-4-phase1-${TIMESTAMP}.log"
PHASE1_RC=${PIPESTATUS[0]}

echo "[p15-4] ==== STEP 4: container log capture ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE|PROVIDER_EXHAUSTED|slot_|p15" | tee "${LOGDIR}/p15-4-containerlog-${TIMESTAMP}.txt" || true

echo "[p15-4] ==== STEP 5: S-1 post-check ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/post : /' | tee "${LOGDIR}/p15-4-post-s1-${TIMESTAMP}.txt"

echo "[p15-4] ==== DONE (phase1_rc=${PHASE1_RC}) ===="
exit $PHASE1_RC

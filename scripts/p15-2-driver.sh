#!/bin/bash
# P15-2 driver: TB->RD actual in-manager shielding.
# Fresh cache volume (no prior chunks), no allowlist (BOTH coords enter manager).
# HY4_FORCE_SLOT_FAILURE=tfId:torbox so the runtime fault fires INSIDE the
# manager when the torbox slot attempts acquire. RD slot survives.

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p15-dp-tb-to-rd"
PORT="3014"
# FRESH volume per run (timestamp) so cache state is not carried over.
VOL="p15-vol-tb-to-rd-$(date -u +%s)"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p15"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p15-2] ==== STEP 0: S-1 pre-check (must show BOTH providers) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/pre  : /' | tee "${LOGDIR}/p15-2-pre-s1-${TIMESTAMP}.txt"

echo "[p15-2] ==== STEP 1: start container, FRESH vol, HY4_FORCE_SLOT_ORDER=:torbox + HY4_FORCE_SLOT_FAILURE=:torbox ===="
HY4_FORCE_SLOT_ORDER="${TFID}:torbox" bash /c/src/hashsucker/scripts/start-p14.sh "${NAME}" "${PORT}" "${VOL}" "" "" "${TFID}:torbox" hy4-data-plane:p15

echo "[p15-2] ==== STEP 2: health probe ===="
for i in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p15-2] healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p15-2] ==== STEP 3: bench (3 uncached ranges, TB attempt+fail, RD serve) ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p15
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p15-2-tb-to-rd-phase1" \
  node p15-2-tb-to-rd.mjs 2>&1 | tee "${LOGDIR}/p15-2-phase1-${TIMESTAMP}.log"
PHASE1_RC=${PIPESTATUS[0]}

echo "[p15-2] ==== STEP 4: container log capture ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE|p1[34]|slot_|p15" | tee "${LOGDIR}/p15-2-containerlog-${TIMESTAMP}.txt" || true

echo "[p15-2] ==== STEP 5: S-1 post-check (must STILL show BOTH) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/post : /' | tee "${LOGDIR}/p15-2-post-s1-${TIMESTAMP}.txt"

echo "[p15-2] ==== DONE (phase1_rc=${PHASE1_RC}) ===="
exit $PHASE1_RC

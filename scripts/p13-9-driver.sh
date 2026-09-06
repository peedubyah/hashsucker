#!/bin/bash
# P13-9 driver: mixed provider + restart. Cycle the dual container
# through TB-only, dual, and RD-only gate configurations, reading the
# same ranges at each step. The Slice 4 cache volume is preserved
# across all three restarts.

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p13-dp-dual"
PORT="3013"
VOL="p13-dp-dual-vol"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p13"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

cycle() {
  local FORCE="$1"
  local PHASE="$2"
  echo "[p13-9] --- cycle: PHASE=${PHASE} FORCE=${FORCE} ---"
  docker rm -f "${NAME}" >/dev/null 2>&1 || true
  sleep 2
  bash /c/src/hashsucker/scripts/start-p13.sh "${NAME}" "${PORT}" "${VOL}" "${FORCE}"
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics" 2>/dev/null; then
      echo "[p13-9] ${PHASE} healthy on attempt $i"; break
    fi
    sleep 1
  done
  cd /c/src/hashsucker/hy4-data-plane/bench/p13
  DP="${DP_URL}" TFID="${TFID}" PHASE="${PHASE}" \
    node p13-9-mixed-restart.mjs 2>&1 | tee "${LOGDIR}/p13-9-${PHASE}-${TIMESTAMP}.log" || true
}

# Phase 1: TB-only
cycle "${TFID}:torbox" "p13-9-1-tbonly"
# Phase 2: dual
cycle "${TFID}:torbox,realdebrid" "p13-9-2-dual"
# Phase 3: RD-only
cycle "${TFID}:realdebrid" "p13-9-3-rdonly"

# Phase 4: S-1 re-fetch to confirm durable state still has BOTH
echo "[p13-9] --- final S-1 re-check ---"
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/final: /' | tee "${LOGDIR}/p13-9-final-s1-${TIMESTAMP}.txt"

# Phase 5: container log capture
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE_PROVIDER" | tail -20 | tee "${LOGDIR}/p13-9-containerlog-${TIMESTAMP}.txt" || true

echo "[p13-9] ==== DONE ===="

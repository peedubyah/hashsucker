#!/bin/bash
# P14-2 driver: RealDebrid-only real-bytes proof.
# Uses the new hy4-data-plane:p14 image (which contains the /torrents-based
# RD acquisition fix). Asserts RD-derived 1-MiB range SHAs match the TB
# reference SHAs (52daa79d4aff / 977afd3ce097 / 11c81ee706e0).

set -e

TFID="tf_5de34a78-0a1a-410b-8de5-76ded2680e7d"
NAME="p14-dp-rdonly"
PORT="3012"
VOL="p14-vol-rd"
DP_URL="http://127.0.0.1:${PORT}"
LOGDIR="/c/src/hashsucker/hy4-data-plane/bench/p14"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")

mkdir -p "${LOGDIR}"

echo "[p14-2] ==== STEP 0: S-1 durable state pre-check (must show BOTH providers) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/pre  : /' | tee "${LOGDIR}/p14-2-pre-s1-${TIMESTAMP}.txt"

echo "[p14-2] ==== STEP 1: start container with HY4_FORCE_PROVIDER=:realdebrid ===="
bash /c/src/hashsucker/scripts/start-p14.sh "${NAME}" "${PORT}" "${VOL}" "${TFID}:realdebrid" ""

echo "[p14-2] ==== STEP 2: container health probe ===="
for i in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p14-2] healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p14-2] ==== STEP 3: phase 1 bench (3 ranges, SHA-matched) ===="
cd /c/src/hashsucker/hy4-data-plane/bench/p14
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p14-2-rdonly-phase1" \
  node p14-2-rd-only.mjs 2>&1 | tee "${LOGDIR}/p14-2-phase1-${TIMESTAMP}.log"
PHASE1_RC=${PIPESTATUS[0]}

echo "[p14-2] ==== STEP 4: container restart (env preserved, cache volume preserved) ===="
docker rm -f "${NAME}" >/dev/null 2>&1 || true
sleep 2
bash /c/src/hashsucker/scripts/start-p14.sh "${NAME}" "${PORT}" "${VOL}" "${TFID}:realdebrid" ""

for i in 1 2 3 4 5 6 7 8 9 10 12 14 16 18 20; do
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/metrics"; then
    echo "[p14-2] post-restart healthy on attempt $i"; break
  fi
  sleep 1
done

echo "[p14-2] ==== STEP 5: phase 2 bench (post-restart, byte-stability check) ===="
DP_URL="${DP_URL}" TFID="${TFID}" LABEL="p14-2-rdonly-phase2" \
  node p14-2-rd-only.mjs 2>&1 | tee "${LOGDIR}/p14-2-phase2-${TIMESTAMP}.log"
PHASE2_RC=${PIPESTATUS[0]}

echo "[p14-2] ==== STEP 6: container log capture (look for HY4_FORCE_PROVIDER + rd msg) ===="
docker logs "${NAME}" 2>&1 | grep -E "HY4_FORCE|p1[34]|rd " | tee "${LOGDIR}/p14-2-containerlog-${TIMESTAMP}.txt" || true

echo "[p14-2] ==== STEP 7: S-1 durable state post-check (must STILL show BOTH) ===="
python "C:/src/hashsucker/scripts/p13-s1-check.py" | sed 's/^/post : /' | tee "${LOGDIR}/p14-2-post-s1-${TIMESTAMP}.txt"

echo "[p14-2] ==== DONE (phase1_rc=${PHASE1_RC} phase2_rc=${PHASE2_RC}) ===="
exit $((PHASE1_RC + PHASE2_RC))

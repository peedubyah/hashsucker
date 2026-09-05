#!/bin/bash
# Run P12 pattern-D in two halves with a docker restart between them.
# Phase 1: read 0..7, dump snapshot, then docker restart the container,
# wait 6s for the container to come back up, then Phase 2: re-read 0..3 + new
# chunks 15..16.
#
# Usage: run-p12-d.sh <container_name> <port> <log_path>
set -e
NAME="$1"
PORT="$2"
LOG="$3"

LOG_DIR="$(dirname "$LOG")"
mkdir -p "$LOG_DIR"

cd /c/src/hashsucker

# Phase 1: read 0..7, no restart
DP_URL="http://127.0.0.1:${PORT}" node hy4-data-plane/bench/p12-soak-D.mjs > "$LOG" 2>&1 &
BENCH_PID=$!
# Wait until the bench has printed PHASE-1 done (i.e. reads 0..7) — give it 12s
sleep 12

# Restart
echo "[p12-D-runner] restarting container $NAME" >> "$LOG"
docker restart "$NAME" >> "$LOG" 2>&1

# Wait for the bench to finish (it sleeps 6s for the restart and then continues)
wait $BENCH_PID
echo "[p12-D-runner] bench complete" >> "$LOG"

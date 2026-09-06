#!/bin/bash
# P12 pattern D: long sequential, restart, then verify cache re-acquire
# Usage: p12-d-driver.sh <name> <port> <volume>
# Runs the bench in pieces, restarting the container between them.

set -u
NAME="${1:-p12-pf-d-1}"
PORT="${2:-3016}"
VOL="${3:-p12-pf-d-1-vol}"
LOG="${4:-/c/Users/patri/p12-d-final.log}"
: > "$LOG"

cd /c/src/hashsucker

restart_container() {
  echo "[D-driver] restarting $NAME on port $PORT vol=$VOL" | tee -a "$LOG"
  docker rm -f "$NAME" >/dev/null 2>&1
  sleep 1
  docker volume rm "$VOL" >/dev/null 2>&1
  sleep 1
  bash /c/src/hashsucker/scripts/restart-p12d.sh "$NAME" "$PORT" "$VOL" >/dev/null 2>&1
  sleep 2
  echo "[D-driver] container back up" | tee -a "$LOG"
}

run_phase1() {
  echo "[D-driver] PHASE 1: pre-restart sequential 0..7" | tee -a "$LOG"
  DP_URL="http://127.0.0.1:${PORT}" LABEL="p12-D" node hy4-data-plane/bench/p12-soak-D-phase1.mjs 2>>"$LOG"
}

run_phase3() {
  echo "[D-driver] PHASE 3: post-restart reads" | tee -a "$LOG"
  DP_URL="http://127.0.0.1:${PORT}" LABEL="p12-D" node hy4-data-plane/bench/p12-soak-D-phase3.mjs 2>>"$LOG"
}

restart_container
run_phase1
restart_container
run_phase3

echo "[D-driver] done" | tee -a "$LOG"

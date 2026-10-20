#!/usr/bin/env bash
# Phase B/C/D: Concurrent OFF vs ON A/B test.
# For each size N, fires N concurrent 8MiB reads at distinct offsets.
# Measures TTFB, wall time, and scheduler-lane counters.
set -u
cd /home/patrick/src/hashsucker

TFID="${TFID:-tf_5de34a78-0a1a-410b-8de5-76ded2680e7d}"
PORT="${DP_PORT:-3001}"
HOST="${DP_HOST:-data-plane}"
LABEL="${LABEL:-baseline}"
CHUNK_SIZE="${CHUNK_SIZE:-8388608}"   # 8 MiB
SIZES="${SIZES:-1,2,4,8,16,32}"
OUT="${OUT:-/home/patrick/hashsucker/artifacts/ab-concurrent.jsonl}"
GATE_STATE="${GATE_STATE:-OFF}"

edge_curl() { docker exec hashsucker-edge-1 curl -s "$@"; }

echo "=== Concurrent A/B driver: gate=${GATE_STATE} ==="
echo "  tfId=${TFID} host=${HOST}:${PORT} chunk_size=${CHUNK_SIZE}"
echo "  sizes=${SIZES} output=${OUT}"

# Discover file size.
SIZE=$(edge_curl "http://${HOST}:${PORT}/files/${TFID}" -H "Range: bytes=0-0" -o /dev/null -D /dev/stderr 2>&1 | grep -i content-range | sed -n 's|.*bytes 0-0/\([0-9]*\).*|\1|p')
[[ -z "$SIZE" ]] && { echo "ERROR: no content-range"; exit 1; }
echo "  file_size=${SIZE}"

# Snapshot metrics before.
METRICS_BEFORE=$(edge_curl "http://${HOST}:${PORT}/metrics")
echo "  metrics_before: lane_a=$(echo "$METRICS_BEFORE" | python3 -c "import sys,json; print(json.load(sys.stdin)['cache']['scheduler_lane_a_chunks'])") lane_b=$(echo "$METRICS_BEFORE" | python3 -c "import sys,json; print(json.load(sys.stdin)['cache']['scheduler_lane_b_chunks'])")"

IFS=',' read -ra SIZE_ARR <<< "$SIZES"
for N in "${SIZE_ARR[@]}"; do
  N=$(echo "$N" | tr -d ' ')
  echo "  --- N=${N} ---"
  # Spread offsets across the file to avoid cache hits (use 100GB spacing)
  OFFSET_SPACING=$(( 100 * 1024 * 1024 ))  # 100MB spacing between demand ranges
  t_start=$(date +%s%N)
  PIDS=()
  TTFBS=()
  for (( i=0; i<N; i++ )); do
    # Each demand: 1 chunk at offset i*spacing (cold, no overlap)
    DEMAND_OFFSET=$(( i * OFFSET_SPACING ))
    c_start=$DEMAND_OFFSET
    c_end=$((c_start + CHUNK_SIZE - 1))
    (( c_end >= SIZE )) && c_end=$((SIZE - 1))
    # Fire concurrently in background
    (
      TTFB=$(edge_curl "http://${HOST}:${PORT}/files/${tf_id}" -H "Range: bytes=${c_start}-${c_end}" -o /dev/null -w '%{time_starttransfer}')
      echo "$TTFB"
    ) &
    PIDS+=($!)
  done
  # Collect results
  for pid in "${PIDS[@]}"; do
    wait "$pid"
  done
  t_end=$(date +%s%N)
  wall_ms=$(( (t_end - t_start) / 1000000 ))
  echo "  N=${N}: wall_ms=${wall_ms}"
done

# Snapshot metrics after.
METRICS_AFTER=$(edge_curl "http://${HOST}:${PORT}/metrics")
mkdir -p "$(dirname "$OUT")"
jq -n \
  --arg label "$LABEL" \
  --arg gateState "$GATE_STATE" \
  --argjson metricsBefore "$METRICS_BEFORE" \
  --argjson metricsAfter "$METRICS_AFTER" \
  --arg sizes "$SIZES" \
  '{label: $label, gateState: $gateState, sizes: $sizes, metricsBefore: $metricsBefore, metricsAfter: $metricsAfter}' >> "$OUT"
echo "=== Done: gate=${GATE_STATE} ==="

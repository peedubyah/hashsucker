#!/usr/bin/env bash
# Phase B: Baseline OFF workload sizes — cold reads at several chunk-count sizes.
set -u
cd /home/patrick/src/hashsucker

TFID="${TFID:-tf_5de34a78-0a1a-410b-8de5-76ded2680e7d}"
PORT="${DP_PORT:-3001}"
HOST="${DP_HOST:-data-plane}"
LABEL="${LABEL:-baseline-off}"
CHUNK_SIZE="${CHUNK_SIZE:-8388608}"
SIZES="${SIZES:-1,2,4,8,16,32}"
OUT="${OUT:-/home/patrick/hashsucker/artifacts/ab-baseline-off.jsonl}"

edge_curl() { docker exec hashsucker-edge-1 curl -s "$@"; }

echo "=== Phase B: baseline OFF ==="
echo "  tfId=${TFID} host=${HOST}:${PORT} chunk_size=${CHUNK_SIZE}"

SIZE=$(edge_curl "http://${HOST}:${PORT}/files/${TFID}" -H "Range: bytes=0-0" -o /dev/null -D /dev/stderr 2>&1 | grep -i content-range | sed -n 's|.*bytes 0-0/\([0-9]*\).*|\1|p')
[[ -z "$SIZE" ]] && { echo "ERROR: no content-range"; exit 1; }
echo "  file_size=${SIZE}"

METRICS_BEFORE=$(edge_curl "http://${HOST}:${PORT}/metrics")
echo "  metrics_before captured"

IFS=',' read -ra SIZE_ARR <<< "$SIZES"
OFFSET=0
for N in "${SIZE_ARR[@]}"; do
  N=$(echo "$N" | tr -d ' ')
  START=$OFFSET
  END=$((START + N * CHUNK_SIZE - 1))
  (( END >= SIZE )) && END=$((SIZE - 1))
  echo "  --- size=N=${N} range=${START}-${END} ---"
  t_start=$(date +%s%N)
  for (( i=0; i<N; i++ )); do
    c_start=$((START + i * CHUNK_SIZE))
    c_end=$((c_start + CHUNK_SIZE - 1))
    (( c_end >= SIZE )) && c_end=$((SIZE - 1))
    TTFB=$(edge_curl "http://${HOST}:${PORT}/files/${TFID}" -H "Range: bytes=${c_start}-${c_end}" -o /dev/null -w '%{time_starttransfer}')
    echo "    chunk $((i+1))/${N}: TTFB=${TTFB}s"
  done
  t_end=$(date +%s%N)
  wall_ms=$(( (t_end - t_start) / 1000000 ))
  echo "  size=${N} wall_ms=${wall_ms}"
  OFFSET=$((OFFSET + N * CHUNK_SIZE + CHUNK_SIZE))
done

METRICS_AFTER_FULL=$(edge_curl "http://${HOST}:${PORT}/metrics")
mkdir -p "$(dirname "$OUT")"

# Build output JSON safely using jq
jq -n \
  --arg label "$LABEL" \
  --arg tfId "$TFID" \
  --argjson fileSize "$SIZE" \
  --argjson chunkSize "$CHUNK_SIZE" \
  --arg sizes "$SIZES" \
  --arg gateState "OFF" \
  --argjson metricsBefore "$METRICS_BEFORE" \
  --argjson metricsAfter "$METRICS_AFTER_FULL" \
  '{label: $label, tfId: $tfId, fileSize: $fileSize, chunkSize: $chunkSize, sizes: $sizes, gateState: $gateState, metricsBefore: $metricsBefore, metricsAfter: $metricsAfter}' >> "$OUT"

echo "=== Phase B complete. Summary appended to ${OUT} ==="

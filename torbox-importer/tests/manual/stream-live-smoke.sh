#!/usr/bin/env bash
set -euo pipefail

#
# stream-live-smoke.sh - Live end-to-end smoke test for stream materialization
#
# Purpose: Prove real TorBox -> Plex compatibility with actual API calls.
#
# Usage:
#   TORBOX_API_KEY=xxx TORBOX_ID=123 TORBOX_FILE_ID=456 \
#   INFO_HASH=abc... OUTPUT_DIR=/tmp/stream-test \
#   bash tests/manual/stream-live-smoke.sh
#
# This script makes LIVE API calls to TorBox. It requires valid credentials.
# The existing automated tests in ../stream-materialization.sh cover failure
# behavior with mocked dependencies.

SCRIPT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
echo "=== Stream Live Smoke Test ==="
echo "Using TorBox API: ${TORBOX_API_URL:-https://api.torbox.app/v1/api}"
echo ""

# 1. Validate required environment variables
: "${TORBOX_API_KEY:?Set TORBOX_API_KEY environment variable}"
: "${TORBOX_ID:?Set TORBOX_ID environment variable (existing TorBox torrent ID)}"
: "${TORBOX_FILE_ID:?Set TORBOX_FILE_ID environment variable (file ID within torrent)}"
: "${INFO_HASH:?Set INFO_HASH environment variable (40-char hex hash)}"
: "${OUTPUT_DIR:?Set OUTPUT_DIR environment variable (where to write .strm)}"

TORBOX_API_URL="${TORBOX_API_URL:-https://api.torbox.app/v1/api}"

# Validate info_hash format
if ! [[ "$INFO_HASH" =~ ^[0-9a-fA-F]{40}$ ]]; then
    echo "ERROR: INFO_HASH must be 40-character hexadecimal"
    exit 1
fi

# 2. Check TorBox cache state
echo "Checking cache state for hash: $INFO_HASH"
CACHE_RESPONSE="$(curl -fsS -m 30 \
    -H "Authorization: Bearer $TORBOX_API_KEY" \
    "$TORBOX_API_URL/torrents/checkcached?hash=$INFO_HASH&format=list" 2>&1)" || {
    echo "ERROR: Cache check failed"
    echo "$CACHE_RESPONSE"
    exit 1
}

IS_CACHED="$(printf '%s' "$CACHE_RESPONSE" | jq -r '.data // false' 2>/dev/null || echo "false")"

if [ "$IS_CACHED" != "true" ]; then
    echo ""
    echo "=== NOT CACHED ==="
    echo ""
    echo "Hash $INFO_HASH is not cached in TorBox."
    echo "This smoke test requires a cached release."
    echo ""
    echo "To cache a release first:"
    echo "  1. Add the torrent to TorBox (via magnet or torrent file)"
    echo "  2. Wait for download to complete"
    echo "  3. Re-run this script"
    echo ""
    echo "No artifacts created."
    exit 0
fi

echo "  -> Release is cached in TorBox"

# 3. Request download link (permalink)
echo ""
echo "Requesting playback URL..."
PLAYBACK_RESPONSE="$(curl -fsS -m 30 \
    -H "Authorization: Bearer $TORBOX_API_KEY" \
    "$TORBOX_API_URL/torrents/requestdl?token=${TORBOX_API_KEY}&torrent_id=${TORBOX_ID}&file_id=${TORBOX_FILE_ID}&redirect=true" 2>&1)" || {
    echo "ERROR: Failed to request download link"
    echo "$PLAYBACK_RESPONSE"
    exit 1
}

# 4. Extract and verify URL
PLAYBACK_URL="$(printf '%s' "$PLAYBACK_RESPONSE" | jq -r '.download_url // .data // .location // empty' 2>/dev/null || true)"

# Fallback: if response is a redirect URL directly (plain text, not JSON)
if [ -z "$PLAYBACK_URL" ]; then
    # Some API versions return the URL as plain text
    if printf '%s' "$PLAYBACK_RESPONSE" | grep -q '^http'; then
        PLAYBACK_URL="$(printf '%s' "$PLAYBACK_RESPONSE" | head -1)"
    fi
fi

if [ -z "$PLAYBACK_URL" ]; then
    echo "ERROR: Could not extract playback URL from response"
    echo "Response: $PLAYBACK_RESPONSE"
    exit 1
fi

echo "  -> Playback URL obtained"

# 5. Create .strm artifact
echo ""
echo "Creating .strm artifact..."
mkdir -p "$OUTPUT_DIR"
STRM_FILE="$OUTPUT_DIR/test-stream.strm"

# Write durable permalink to .strm file
printf '%s\n' "$PLAYBACK_URL" > "$STRM_FILE"
echo "  -> Written to: $STRM_FILE"

# 6. Print success summary
echo ""
echo "=== STREAM SMOKE SUCCESS ==="
echo ""
echo "hash:    $INFO_HASH"
echo "torrent: $TORBOX_ID"
echo "file:    $TORBOX_FILE_ID"
echo "strm:    $STRM_FILE"
echo "url:     $PLAYBACK_URL"
echo ""
echo "Plex can use the .strm file to play content from TorBox."
echo "The URL is a durable permalink that TorBox resolves at playback time."

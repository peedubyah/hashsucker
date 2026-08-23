#!/bin/sh
set -eu

#
# stream-request.sh - Stream materializer
#
# Pipeline: info_hash -> cache check -> playback reference -> .strm
#
# Does NOT use: torbox_id, torrent creation, file selection, download
# Those are download-path operations.

REQUEST_ID="${1:?usage: stream-request.sh REQUEST_ID}"

: "${TORBOX_API_KEY:?TORBOX_API_KEY required}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"
APP_ROOT="${APP_ROOT:-/app}"
SCRIPTS_DIR="${SCRIPTS_DIR:-${TORBOX_SCRIPTS_DIR:-$APP_ROOT/scripts}}"
TORBOX_API_URL="${TORBOX_API_URL:-https://api.torbox.app/v1/api}"
STRM_OUTPUT_PATH="${STRM_OUTPUT_PATH:-/strm}"

log() {
    printf '%s\n' "stream[$REQUEST_ID]: $*" >&2
}

sqlq() {
    local value="$1"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

fail_request() {
    local msg="$1"
    local escaped
    escaped="$(sqlq "$msg")"

    sqlite3 "$DB" "UPDATE requests SET state='failed', last_error=$escaped, updated_at=CURRENT_TIMESTAMP WHERE request_id=$(sqlq "$REQUEST_ID");"

    log "FAILED: $msg"
    exit 1
}

# Load request metadata
REQUEST_INFO="$(
    sqlite3 -separator '|' "$DB" "SELECT handling_mode, media_type, scope, media_id, lower(info_hash), COALESCE(release_title, ''), state, COALESCE(release_filename, '') FROM requests WHERE request_id=$(sqlq "$REQUEST_ID");"
)"

if [ -z "$REQUEST_INFO" ]; then
    log "request not found"
    exit 1
fi

IFS='|' read -r HANDLING_MODE MEDIA_TYPE SCOPE MEDIA_ID INFO_HASH RELEASE_TITLE REQUEST_STATE RELEASE_FILENAME \
    <<< "$REQUEST_INFO"

if [ "$HANDLING_MODE" != "stream" ]; then
    log "not a stream request: $HANDLING_MODE"
    exit 1
fi

case "$REQUEST_STATE" in
    processing) ;;
    done|already_present|failed)
        log "request already terminal: $REQUEST_STATE"
        exit 0
        ;;
    *)
        log "unexpected request state: $REQUEST_STATE"
        exit 1
        ;;
esac

if ! [[ "$INFO_HASH" =~ ^[0-9a-f]{40}$ ]]; then
    fail_request "invalid info hash: $INFO_HASH"
fi

log "stream materialization for hash: $INFO_HASH"

# Step 1: Check TorBox cache by info_hash
log "checking TorBox cache state for hash $INFO_HASH"

CACHE_RESPONSE="$(
    curl -fsS -m 15 \
        -H "Authorization: Bearer $TORBOX_API_KEY" \
        "$TORBOX_API_URL/torrents/checkcached?hash=$INFO_HASH&format=list" 2>&1
)" || {
    fail_request "cache check failed: cannot determine TorBox state"
}

IS_CACHED="$(printf '%s' "$CACHE_RESPONSE" | jq -r '.data // false' 2>/dev/null || echo "false")"

if [ "$IS_CACHED" != "true" ]; then
    fail_request "release not cached in TorBox (hash: $INFO_HASH)"
fi

log "release confirmed cached in TorBox"

# Step 2: Resolve playback target from existing TorBox torrent list
log "resolving playback target for hash $INFO_HASH"

LIST_RESPONSE="$(
    curl -fsS -m 15 \
        -H "Authorization: Bearer $TORBOX_API_KEY" \
        "$TORBOX_API_URL/torrents/mylist?bypass_cache=true" 2>&1
)" || {
    fail_request "failed to retrieve TorBox torrent list"
}

# Find torrent and files for our hash
TORBOX_ID="$(printf '%s' "$LIST_RESPONSE" | jq -r '.data[] | select(.hash == "'$INFO_HASH'") | .id' 2>/dev/null | head -1)"

if [ -z "$TORBOX_ID" ] || [ "$TORBOX_ID" = "null" ]; then
    fail_request "cached hash not found in TorBox torrent list"
fi

# Pick the largest file as the main content
BEST_FILE="$(printf '%s' "$LIST_RESPONSE" | jq -r --arg tid "$TORBOX_ID" '.data[] | select(.id == ($tid | tonumber)) | .files | sort_by(-.size) | .[0]' 2>/dev/null)"

if [ -z "$BEST_FILE" ] || [ "$BEST_FILE" = "null" ]; then
    fail_request "no playable files found for cached hash"
fi

FILE_ID="$(printf '%s' "$BEST_FILE" | jq -r '.id' 2>/dev/null)"
FILE_NAME="$(printf '%s' "$BEST_FILE" | jq -r '.name // empty' 2>/dev/null)"

if [ -z "$FILE_ID" ] || [ "$FILE_ID" = "null" ]; then
    fail_request "could not resolve file_id for playback"
fi

log "resolved playback target: torrent=$TORBOX_ID file=$FILE_ID"

# Step 3: Build durable TorBox permalink
PLAYBACK_URL="${TORBOX_API_URL}/torrents/requestdl?token=${TORBOX_API_KEY}&torrent_id=${TORBOX_ID}&file_id=${FILE_ID}&redirect=true"
log "durable permalink created"

# Step 4: Resolve media title for .strm artifact naming
RESOLVED_TITLE="$RELEASE_TITLE"
if [ -z "$RESOLVED_TITLE" ] || [ "$RESOLVED_TITLE" = "Unknown" ]; then
    if [ -n "$RELEASE_FILENAME" ]; then
        RESOLVED_TITLE="$RELEASE_FILENAME"
        RESOLVED_TITLE="${RESOLVED_TITLE%.*}"
    elif [ -n "$FILE_NAME" ]; then
        RESOLVED_TITLE="$FILE_NAME"
        RESOLVED_TITLE="${RESOLVED_TITLE%.*}"
    fi
fi

if [ -z "$RESOLVED_TITLE" ] || [ "$RESOLVED_TITLE" = "Unknown" ]; then
    fail_request "cannot determine media title for artifact naming"
fi

# Extract year from title
YEAR=""
case "$RESOLVED_TITLE" in
    *\([0-9][0-9][0-9][0-9]\)*)
        YEAR="$(printf '%s' "$RESOLVED_TITLE" | grep -oE '\([0-9]{4}\)' | tail -1 | tr -d '()')"
        RESOLVED_TITLE="$(printf '%s' "$RESOLVED_TITLE" | sed 's/ ([0-9]\{4\})//g' | sed 's/ *$//')"
        ;;
esac

# Step 5: Materialize .strm artifact
log "materializing .strm artifact: $RESOLVED_TITLE"

set +e
STRM_PATH="$("$SCRIPTS_DIR/strm-writer.sh" "$RESOLVED_TITLE" "$YEAR" "$MEDIA_TYPE" "$PLAYBACK_URL" "$STRM_OUTPUT_PATH")"
STRM_RC=$?
set -e

if [ $STRM_RC -ne 0 ]; then
    fail_request "strm materialization failed"
fi

log "strm artifact created: $STRM_PATH"

# Step 6: Mark request complete
sqlite3 "$DB" "UPDATE requests SET state='done', last_error=NULL, updated_at=CURRENT_TIMESTAMP WHERE request_id=$(sqlq "$REQUEST_ID");"

log "stream materialization complete"
exit 0

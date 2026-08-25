#!/usr/bin/env bash
set -euo pipefail

#
# stream-materialization.sh - Tests for refactored stream materialization
#
# Pipeline: media_id + media_type -> stable resolver URL -> .strm
#
# The .strm now encodes the stable Hashsucker resolver URL
# (http://<host>/stream/:type/:mediaId), not a transient provider URL.
# No TorBox API calls are made during materialization.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/test.db"
STRM_DIR="$TMP/strm"
mkdir -p "$STRM_DIR"

HASH='0123456789abcdef0123456789abcdef01234567'
TORBOX_ID=50

HASHSUCKER_BASE_URL="http://localhost:8080"

# Initialize database
sqlite3 "$DB" <<SQL
CREATE TABLE jobs (
    torbox_id INTEGER PRIMARY KEY,
    info_hash TEXT NOT NULL,
    torrent_name TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'discovered',
    media_type TEXT,
    arr_target TEXT,
    first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error TEXT
);
CREATE TABLE files (
    torbox_id INTEGER NOT NULL,
    file_id INTEGER NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0,
    download_state TEXT NOT NULL DEFAULT 'pending',
    local_path TEXT,
    arr_match TEXT,
    arr_rejection TEXT,
    imported INTEGER NOT NULL DEFAULT 0,
    library_path TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (torbox_id, file_id)
);
CREATE TABLE requests (
    request_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    provider TEXT NOT NULL,
    handling_mode TEXT NOT NULL DEFAULT 'download',
    media_type TEXT NOT NULL,
    scope TEXT NOT NULL,
    media_id TEXT NOT NULL,
    base_media_id TEXT,
    season INTEGER,
    episodes_json TEXT NOT NULL DEFAULT '[]',
    info_hash TEXT NOT NULL,
    file_index INTEGER,
    release_key TEXT,
    release_title TEXT,
    release_filename TEXT,
    release_size INTEGER,
    state TEXT NOT NULL DEFAULT 'processing',
    source_path TEXT,
    torbox_id INTEGER,
    provider_created INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error TEXT
);
SQL

# Insert a stream request
insert_stream_request() {
    local request_id="$1"
    local title="$2"
    local media_id="${3:-tmdb:268}"
    local media_type="${4:-movie}"
    local scope="${5:-movie}"
    sqlite3 "$DB" <<SQL
INSERT INTO requests (request_id, created_at, provider, handling_mode, media_type, scope, media_id, info_hash, release_title, state, release_key)
VALUES ('$request_id', '2026-08-23T00:00:00.000Z', 'torbox', 'stream', '$media_type', '$scope', '$media_id', '$HASH', '$title', 'processing', '$HASH:torrent');
SQL
}

# Helper to run stream-request.sh with mocked environment
run_stream_request() {
    local request_id="$1"
    TORBOX_DB="$DB" \
    TORBOX_API_KEY="test-key" \
    TORBOX_API_URL="https://api.torbox.app/v1/api" \
    STRM_OUTPUT_PATH="$STRM_DIR" \
    APP_ROOT="$ROOT" \
    HASHSUCKER_BASE_URL="$HASHSUCKER_BASE_URL" \
    "$ROOT/scripts/stream-request.sh" "$request_id"
}

# ===== Test 1: Stream request creates .strm with stable resolver URL =====
echo "Test 1: Stream request creates .strm with stable resolver URL"

insert_stream_request "stream-basic" "Batman (1989)"

run_stream_request "stream-basic"

# Verify .strm artifact was created
if [ -f "$STRM_DIR/Movies/Batman (1989)/Batman (1989).strm" ]; then
    echo "  PASS: .strm artifact created at expected path"
else
    echo "  FAIL: .strm artifact not found"
    exit 1
fi

# Verify request state is done
STATE="$(sqlite3 "$DB" "SELECT state FROM requests WHERE request_id='stream-basic';")"
if [ "$STATE" = "done" ]; then
    echo "  PASS: request state is 'done'"
else
    echo "  FAIL: request state is '$STATE', expected 'done'"
    exit 1
fi

# Verify stable resolver URL persisted (NOT a provider URL)
EXPECTED_URL="${HASHSUCKER_BASE_URL}/stream/movie/tmdb:268"
STRM_CONTENT="$(cat "$STRM_DIR/Movies/Batman (1989)/Batman (1989).strm")"
if [ "$STRM_CONTENT" = "$EXPECTED_URL" ]; then
    echo "  PASS: stable resolver URL persisted"
else
    echo "  FAIL: resolver URL not found in .strm"
    echo "  Expected: $EXPECTED_URL"
    echo "  Actual: $STRM_CONTENT"
    exit 1
fi

# ===== Test 2: Resolver URL does not contain provider-specific path =====
echo "Test 2: Resolver URL does not contain provider-specific path"

STRM_CONTENT="$(cat "$STRM_DIR/Movies/Batman (1989)/Batman (1989).strm")"
if printf '%s' "$STRM_CONTENT" | grep -qE 'torrents/requestdl|token='; then
    echo "  FAIL: .strm contains provider URL, should be resolver URL"
    echo "  Content: $STRM_CONTENT"
    exit 1
else
    echo "  PASS: .strm does not contain provider URL"
fi

# ===== Test 3: Stream request makes NO TorBox API calls =====
echo "Test 3: Stream request makes no TorBox API calls"

CALL_LOG="$TMP/api_calls"
rm -f "$CALL_LOG"
touch "$CALL_LOG"

# Override curl to log calls (but stream-request.sh shouldn't call it)
cat > "$TMP/curl" <<'CURL'
#!/bin/sh
echo "$@" >> "CALL_LOG_PLACEHOLDER"
printf '%s\n' '{"success":true}'
CURL
sed -i "s|CALL_LOG_PLACEHOLDER|$CALL_LOG|g" "$TMP/curl"
chmod +x "$TMP/curl"

insert_stream_request "stream-no-api" "Test Movie (2024)"

PATH="$TMP:$PATH" run_stream_request "stream-no-api"

if [ -s "$CALL_LOG" ]; then
    echo "  FAIL: stream-request made API calls (should be zero)"
    cat "$CALL_LOG"
    exit 1
else
    echo "  PASS: stream-request made zero API calls"
fi

# ===== Test 4: Download mode behavior unchanged =====
echo "Test 4: Download mode behavior remains unchanged"

sqlite3 "$DB" <<SQL
INSERT INTO requests (request_id, created_at, provider, handling_mode, media_type, scope, media_id, info_hash, release_title, state, torbox_id, release_key)
VALUES ('download-req-1', '2026-08-23T00:00:00.000Z', 'torbox', 'download', 'movie', 'movie', 'tmdb:268', '$HASH', 'Batman (1989)', 'processing', $TORBOX_ID, '$HASH:torrent');
SQL

rm -rf "$STRM_DIR/Movies/Batman (1989)"
if run_stream_request "download-req-1" 2>/dev/null; then
    echo "  FAIL: stream-request should reject download requests"
    exit 1
else
    echo "  PASS: stream-request correctly rejected download request"
fi

# Verify no .strm artifact was created for download request
if [ -d "$STRM_DIR/Movies/Batman (1989)" ]; then
    echo "  FAIL: .strm artifact should not exist for download request"
    exit 1
else
    echo "  PASS: no .strm artifact created for download request"
fi

# ===== Test 5: Stream request works without torbox_id =====
echo "Test 5: Stream request works without torbox_id"

insert_stream_request "stream-no-job" "Another Movie (2023)"

# Verify no torbox_id in request
TORBOX_ID_IN_DB="$(sqlite3 "$DB" "SELECT torbox_id FROM requests WHERE request_id='stream-no-job';")"
if [ -n "$TORBOX_ID_IN_DB" ] && [ "$TORBOX_ID_IN_DB" != "" ]; then
    echo "  FAIL: test setup error - request should not have torbox_id"
    exit 1
fi

run_stream_request "stream-no-job"

STATE="$(sqlite3 "$DB" "SELECT state FROM requests WHERE request_id='stream-no-job';")"
if [ "$STATE" = "done" ]; then
    echo "  PASS: stream materialization succeeded without torbox_id"
else
    echo "  FAIL: request state is '$STATE', expected 'done'"
    exit 1
fi

echo ""
echo "All stream materialization tests passed!"
echo ""
echo "Summary:"
echo "  - Stream writes stable Hashsucker resolver URL (not provider URL)"
echo "  - Stream makes zero TorBox API calls"
echo "  - Stream never creates new TorBox torrents"
echo "  - Download path is unaffected by stream changes"

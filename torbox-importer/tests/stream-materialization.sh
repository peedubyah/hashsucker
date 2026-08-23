#!/usr/bin/env bash
set -euo pipefail

#
# stream-materialization.sh - Tests for refactored stream materialization
#
# Pipeline: info_hash -> cache check -> playback reference -> .strm

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/test.db"
STRM_DIR="$TMP/strm"
mkdir -p "$STRM_DIR"

HASH='0123456789abcdef0123456789abcdef01234567'
TORBOX_ID=50
FILE_ID=5001

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

# Helper: write mock curl that returns cached=true
write_cached_mock() {
    cat > "$TMP/curl" <<'CURL'
#!/bin/sh
URL=""
skip_next=0
for arg in "$@"; do
    if [ "$skip_next" -eq 1 ]; then
        skip_next=0
        continue
    fi
    case "$arg" in
        -H|-m|-f|-s|-S|-g|--get) skip_next=1; continue ;;
        http*) URL="$arg" ;;
    esac
done

case "$URL" in
    *checkcached*)
        printf '%s\n' '{"success":true,"data":true}'
        ;;
    *mylist*)
        printf '%s\n' '{"success":true,"data":[{"id":50,"hash":"0123456789abcdef0123456789abcdef01234567","name":"Batman.1989.720p","files":[{"id":5001,"name":"Batman.1989.720p.mkv","size":720000000}]}]}'
        ;;
    *)
        printf '%s\n' '{"success":true}'
        ;;
esac
CURL
    chmod +x "$TMP/curl"
}

# Helper: write mock curl that returns cached=false
write_uncached_mock() {
    cat > "$TMP/curl" <<'CURL'
#!/bin/sh
URL=""
skip_next=0
for arg in "$@"; do
    if [ "$skip_next" -eq 1 ]; then
        skip_next=0
        continue
    fi
    case "$arg" in
        -H|-m|-f|-s|-S|-g|--get) skip_next=1; continue ;;
        http*) URL="$arg" ;;
    esac
done

case "$URL" in
    *checkcached*)
        printf '%s\n' '{"success":true,"data":false}'
        ;;
    *)
        printf '%s\n' '{"success":true}'
        ;;
esac
CURL
    chmod +x "$TMP/curl"
}

# Insert a stream request (no torbox_id needed)
insert_stream_request() {
    local request_id="$1"
    local title="$2"
    sqlite3 "$DB" <<SQL
INSERT INTO requests (request_id, created_at, provider, handling_mode, media_type, scope, media_id, info_hash, release_title, state, release_key)
VALUES ('$request_id', '2026-08-23T00:00:00.000Z', 'torbox', 'stream', 'movie', 'movie', 'tmdb:268', '$HASH', '$title', 'processing', '$HASH:torrent');
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
    PATH="$TMP:$PATH" \
    "$ROOT/scripts/stream-request.sh" "$request_id"
}

# ===== Test 1: Stream request with cached hash creates .strm =====
echo "Test 1: Stream request with cached hash creates .strm artifact"

write_cached_mock
insert_stream_request "stream-cached" "Batman (1989)"

run_stream_request "stream-cached"

# Verify .strm artifact was created
if [ -f "$STRM_DIR/Movies/Batman (1989)/Batman (1989).strm" ]; then
    echo "  PASS: .strm artifact created at expected path"
else
    echo "  FAIL: .strm artifact not found"
    exit 1
fi

# Verify request state is done
STATE="$(sqlite3 "$DB" "SELECT state FROM requests WHERE request_id='stream-cached';")"
if [ "$STATE" = "done" ]; then
    echo "  PASS: request state is 'done'"
else
    echo "  FAIL: request state is '$STATE', expected 'done'"
    exit 1
fi

# Verify durable permalink persisted
STRM_CONTENT="$(cat "$STRM_DIR/Movies/Batman (1989)/Batman (1989).strm")"
if printf '%s' "$STRM_CONTENT" | grep -qE 'torrents/requestdl\?.*&torrent_id=[0-9]+&file_id=[0-9]+&redirect=true'; then
    echo "  PASS: durable TorBox permalink persisted"
else
    echo "  FAIL: durable permalink not found in .strm"
    echo "  Content: $STRM_CONTENT"
    exit 1
fi

# ===== Test 2: Stream request with uncached hash fails cleanly =====
echo "Test 2: Stream request with uncached hash fails cleanly"

write_uncached_mock
rm -rf "$STRM_DIR/Movies/Uncached Movie"
insert_stream_request "stream-uncached" "Uncached Movie"

if run_stream_request "stream-uncached" 2>/dev/null; then
    echo "  FAIL: stream-request should fail for uncached hash"
    exit 1
fi

# Verify request state is failed
STATE="$(sqlite3 "$DB" "SELECT state FROM requests WHERE request_id='stream-uncached';")"
if [ "$STATE" = "failed" ]; then
    echo "  PASS: request state is 'failed'"
else
    echo "  FAIL: request state is '$STATE', expected 'failed'"
    exit 1
fi

# Verify no .strm artifact was created
if [ -d "$STRM_DIR/Movies/Uncached Movie" ]; then
    echo "  FAIL: partial artifact directory should not exist"
    exit 1
else
    echo "  PASS: no partial artifact created for failed resolution"
fi

# ===== Test 3: Stream request never invokes torrent creation path =====
echo "Test 3: Stream request never invokes torrent creation path"

# Track API calls - use cached mock but with call logging
CALL_LOG="$TMP/api_calls"
rm -f "$CALL_LOG"

cat > "$TMP/curl" <<'CURL'
#!/bin/sh
URL=""
skip_next=0
for arg in "$@"; do
    if [ "$skip_next" -eq 1 ]; then
        skip_next=0
        continue
    fi
    case "$arg" in
        -H|-m|-f|-s|-S|-g|--get) skip_next=1; continue ;;
        http*) URL="$arg" ;;
    esac
done

# Log the call
echo "$URL" >> "CALL_LOG_PLACEHOLDER"

case "$URL" in
    *checkcached*)
        printf '%s\n' '{"success":true,"data":true}'
        ;;
    *mylist*)
        printf '%s\n' '{"success":true,"data":[{"id":50,"hash":"0123456789abcdef0123456789abcdef01234567","name":"Test","files":[{"id":5001,"name":"Test.mkv","size":1000}]}]}'
        ;;
    *)
        printf '%s\n' '{"success":true}'
        ;;
esac
CURL
# Fix placeholder in mock (bash heredoc limitation)
sed -i "s|CALL_LOG_PLACEHOLDER|$CALL_LOG|g" "$TMP/curl"
chmod +x "$TMP/curl"

rm -rf "$STRM_DIR/Movies/Test Movie"
insert_stream_request "stream-no-create" "Test Movie"

run_stream_request "stream-no-create"

# Verify create torrent was NOT called (no createtorrent in call log)
if [ -f "$CALL_LOG" ] && grep -q "createtorrent" "$CALL_LOG"; then
    echo "  FAIL: stream path called create torrent endpoint"
    cat "$CALL_LOG"
    exit 1
else
    echo "  PASS: create torrent endpoint was not called"
fi

# ===== Test 4: Download mode behavior unchanged =====
echo "Test 4: Download mode behavior remains unchanged"

# stream-request.sh should reject download requests
write_cached_mock
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

write_cached_mock
insert_stream_request "stream-no-job" "Batman (1989)"

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
echo "  - Stream uses info_hash as canonical identity (not torbox_id)"
echo "  - Stream checks cache, resolves existing torrent, creates .strm"
echo "  - Stream never creates new TorBox torrents"
echo "  - Download path is unaffected by stream changes"

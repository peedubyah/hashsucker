#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/importer.db"
HASH='0123456789abcdef0123456789abcdef01234567'

make_request() {
    local path="$1"
    local request_id="$2"
    local release_json="$3"
    jq -n \
        --arg request_id "$request_id" \
        --arg hash "$HASH" \
        --argjson release "$release_json" '
        {
          version: 1,
          requestId: $request_id,
          createdAt: "2026-08-21T00:00:00.000Z",
          provider: "torbox",
          intent: {
            mediaType: "tv",
            streamType: "series",
            scope: "episode",
            mediaId: "tt2085059:7:3",
            baseMediaId: "tt2085059",
            season: 7,
            episodes: [3]
          },
          release: ({
            infoHash: $hash,
            title: "Black.Mirror.S07E03.mkv",
            filename: "Black.Mirror.S07E03.mkv",
            size: 1000
          } + $release)
        }
    ' > "$path"
}

# Existing unversioned databases are migrated in place and migration is idempotent.
sqlite3 "$DB" <<SQL
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
INSERT INTO requests (request_id,created_at,provider,media_type,scope,media_id,episodes_json,info_hash)
VALUES ('historical','2026-08-20T00:00:00.000Z','torbox','movie','movie','tt0082971','[]',upper('$HASH'));
SQL

TORBOX_DB="$DB" "$ROOT/scripts/db-init.sh" >/dev/null
sqlite3 "$DB" "UPDATE requests SET release_key='stale-key' WHERE request_id='historical';"
TORBOX_DB="$DB" "$ROOT/scripts/db-init.sh" >/dev/null
[[ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('requests') WHERE name IN ('file_index','release_key');")" == 2 ]]
[[ "$(sqlite3 "$DB" "SELECT lower(info_hash) || '|' || COALESCE(file_index, -1) || '|' || release_key FROM requests WHERE request_id='historical';")" == "$HASH|-1|$HASH:torrent" ]]

make_request "$TMP/legacy.json" legacy '{}'
make_request "$TMP/null.json" null-index "{\"fileIndex\":null,\"releaseKey\":\"$HASH:torrent\"}"
make_request "$TMP/zero.json" zero-index "{\"fileIndex\":0,\"releaseKey\":\"$HASH:0\"}"
make_request "$TMP/one.json" one-index "{\"fileIndex\":1,\"releaseKey\":\"$HASH:1\"}"

for file in legacy null zero one; do
    "$ROOT/validate-request.sh" "$TMP/$file.json" >/dev/null
    TORBOX_DB="$DB" APP_ROOT="$ROOT" "$ROOT/scripts/ingest-request.sh" "$TMP/$file.json" >/dev/null
done

[[ "$(sqlite3 -separator '|' "$DB" "SELECT request_id, COALESCE(file_index, -1), release_key FROM requests WHERE request_id IN ('legacy','null-index','zero-index','one-index') ORDER BY request_id;")" == $'legacy|-1|'"$HASH"$':torrent\nnull-index|-1|'"$HASH"$':torrent\none-index|1|'"$HASH"$':1\nzero-index|0|'"$HASH"':0' ]]

# Duplicate delivery is idempotent; changing exact identity under one requestId fails closed.
TORBOX_DB="$DB" APP_ROOT="$ROOT" "$ROOT/scripts/ingest-request.sh" "$TMP/zero.json" >/dev/null
jq ".release.fileIndex = 1 | .release.releaseKey = \"$HASH:1\"" "$TMP/zero.json" > "$TMP/collision.json"
if TORBOX_DB="$DB" APP_ROOT="$ROOT" "$ROOT/scripts/ingest-request.sh" "$TMP/collision.json" >/dev/null 2>&1; then
    echo 'immutable release identity collision unexpectedly succeeded' >&2
    exit 1
fi

for invalid in mismatched negative fractional unsafe string missing-key missing-index; do
    cp "$TMP/zero.json" "$TMP/$invalid.json"
done
jq ".release.releaseKey = \"$HASH:torrent\"" "$TMP/mismatched.json" > "$TMP/mismatched.tmp" && mv "$TMP/mismatched.tmp" "$TMP/mismatched.json"
jq ".release.fileIndex = -1 | .release.releaseKey = \"$HASH:-1\"" "$TMP/negative.json" > "$TMP/negative.tmp" && mv "$TMP/negative.tmp" "$TMP/negative.json"
jq ".release.fileIndex = 1.5 | .release.releaseKey = \"$HASH:1.5\"" "$TMP/fractional.json" > "$TMP/fractional.tmp" && mv "$TMP/fractional.tmp" "$TMP/fractional.json"
jq ".release.fileIndex = 9007199254740992 | .release.releaseKey = \"$HASH:9007199254740992\"" "$TMP/unsafe.json" > "$TMP/unsafe.tmp" && mv "$TMP/unsafe.tmp" "$TMP/unsafe.json"
jq ".release.fileIndex = \"0\"" "$TMP/string.json" > "$TMP/string.tmp" && mv "$TMP/string.tmp" "$TMP/string.json"
jq 'del(.release.releaseKey)' "$TMP/missing-key.json" > "$TMP/missing-key.tmp" && mv "$TMP/missing-key.tmp" "$TMP/missing-key.json"
jq 'del(.release.fileIndex)' "$TMP/missing-index.json" > "$TMP/missing-index.tmp" && mv "$TMP/missing-index.tmp" "$TMP/missing-index.json"

for invalid in mismatched negative fractional unsafe string missing-key missing-index; do
    if "$ROOT/validate-request.sh" "$TMP/$invalid.json" >/dev/null 2>&1; then
        echo "invalid identity unexpectedly accepted: $invalid" >&2
        exit 1
    fi
done

# Provider file identity remains independently keyed by TorBox file_id.
sqlite3 "$DB" <<SQL
INSERT INTO jobs (torbox_id, info_hash, torrent_name) VALUES (99, '$HASH', 'Provider torrent');
INSERT INTO files (torbox_id, file_id, path, size, selected) VALUES (99, 7001, 'provider/file.mkv', 1000, 1);
UPDATE requests SET torbox_id=99 WHERE request_id='zero-index';
SQL
[[ "$(sqlite3 -separator '|' "$DB" "SELECT r.file_index, f.file_id FROM requests r JOIN files f ON f.torbox_id=r.torbox_id WHERE r.request_id='zero-index' AND f.selected=1;")" == '0|7001' ]]

echo 'release identity contract tests passed'

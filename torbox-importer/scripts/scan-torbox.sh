#!/bin/sh
set -eu

: "${TORBOX_API_KEY:?TORBOX_API_KEY is required}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"
API_URL="${TORBOX_API_URL:-https://api.torbox.app/v1/api}"

TMP="$(mktemp)"
SQL="$(mktemp)"

trap 'rm -f "$TMP" "$SQL"' EXIT HUP INT TERM

log() {
    printf '%s\n' "scan-torbox: $*" >&2
}

curl -fsS \
    -H "Authorization: Bearer $TORBOX_API_KEY" \
    "$API_URL/torrents/mylist?bypass_cache=true" \
    > "$TMP"

COUNT="$(jq '.data | length' "$TMP")"
log "TorBox returned $COUNT torrent(s)"

jq -r '
    def sqlq:
        "\u0027"
        + (tostring | gsub("\u0027"; "\u0027\u0027"))
        + "\u0027";

    .data[] |

    "INSERT INTO jobs (torbox_id, info_hash, torrent_name, last_seen, updated_at) VALUES (\(.id), \((.hash // "") | sqlq), \((.name // "") | sqlq), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(torbox_id) DO UPDATE SET info_hash=excluded.info_hash, torrent_name=excluded.torrent_name, last_seen=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP;",

    (
        . as $torrent
        | (.files // [])[]
        | "INSERT INTO files (torbox_id, file_id, path, size, updated_at) VALUES (\($torrent.id), \(.id), \((.name // "") | sqlq), \(.size // 0), CURRENT_TIMESTAMP) ON CONFLICT(torbox_id, file_id) DO UPDATE SET path=excluded.path, size=excluded.size, updated_at=CURRENT_TIMESTAMP;"
    )
' "$TMP" > "$SQL"

{
    printf '%s\n' 'PRAGMA foreign_keys=ON;'
    printf '%s\n' 'BEGIN IMMEDIATE;'
    cat "$SQL"
    printf '%s\n' 'COMMIT;'
} | sqlite3 "$DB"

log "database updated"

#!/usr/bin/env bash
set -euo pipefail

REQUEST_ID="${1:?usage: ensure-torbox-job.sh REQUEST_ID}"

: "${TORBOX_API_KEY:?TORBOX_API_KEY required}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"
TORBOX_API_URL="${TORBOX_API_URL:-https://api.torbox.app/v1/api}"

log() {
    printf '%s\n' "ensure-torbox[$REQUEST_ID]: $*" >&2
}

sqlq() {
    local value="$1"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

REQUEST_INFO="$(
    sqlite3 -separator '|' "$DB" "
        SELECT
            provider,
            media_type,
            scope,
            lower(info_hash),
            state
        FROM requests
        WHERE request_id=$(sqlq "$REQUEST_ID");
    "
)"

if [ -z "$REQUEST_INFO" ]; then
    log "request not found"
    exit 1
fi

IFS='|' read -r PROVIDER MEDIA_TYPE SCOPE INFO_HASH REQUEST_STATE <<< "$REQUEST_INFO"

case "$PROVIDER" in
    torbox|auto)
        ;;
    *)
        log "request provider is not TorBox-compatible: $PROVIDER"
        exit 1
        ;;
esac

if [ "$REQUEST_STATE" != "processing" ]; then
    log "request is not processing: $REQUEST_STATE"
    exit 3
fi

if ! [[ "$INFO_HASH" =~ ^[0-9a-f]{40}$ ]]; then
    log "invalid info hash"
    exit 1
fi

find_job() {
    sqlite3 "$DB" "
        SELECT torbox_id
        FROM jobs
        WHERE lower(info_hash)=lower($(sqlq "$INFO_HASH"))
        ORDER BY last_seen DESC;
    "
}

MATCHES="$(find_job)"
MATCH_COUNT="$(
    printf '%s\n' "$MATCHES" |
    grep -c . || true
)"

if [ "$MATCH_COUNT" -gt 1 ]; then
    log "multiple TorBox jobs match request hash"
    exit 1
fi

if [ "$MATCH_COUNT" -eq 1 ]; then
    JOB_ID="$MATCHES"

    sqlite3 "$DB" "
        UPDATE requests
        SET torbox_id=$JOB_ID,
            updated_at=CURRENT_TIMESTAMP
        WHERE request_id=$(sqlq "$REQUEST_ID");
    "

    log "existing TorBox job: $JOB_ID"
    printf '%s\n' "$JOB_ID"
    exit 0
fi

MAGNET="magnet:?xt=urn:btih:$INFO_HASH"

log "adding cached torrent to TorBox"

RESPONSE="$(
    curl -fsS \
        -H "Authorization: Bearer $TORBOX_API_KEY" \
        -F "magnet=$MAGNET" \
        -F "add_only_if_cached=true" \
        "$TORBOX_API_URL/torrents/createtorrent"
)"

if ! printf '%s' "$RESPONSE" | jq -e '.success == true' >/dev/null; then
    DETAIL="$(
        printf '%s' "$RESPONSE" |
        jq -r '.detail // .error // "unknown TorBox error"'
    )"

    log "TorBox refused create: $DETAIL"
    exit 1
fi

#
# This request caused us to create the provider item.
# Persist ownership immediately so a crash/retry cannot lose that fact.
#
sqlite3 "$DB" "
    UPDATE requests
    SET provider_created=1,
        updated_at=CURRENT_TIMESTAMP
    WHERE request_id=$(sqlq "$REQUEST_ID");
"

#
# Let the normal scanner become authoritative for TorBox inventory.
#
for _ in $(seq 1 20); do

    /config/scripts/scan-torbox.sh >/dev/null ||
        true

    MATCHES="$(find_job)"
    MATCH_COUNT="$(
        printf '%s\n' "$MATCHES" |
        grep -c . || true
    )"

    if [ "$MATCH_COUNT" -gt 1 ]; then
        log "multiple TorBox jobs appeared for request hash"
        exit 1
    fi

    if [ "$MATCH_COUNT" -eq 1 ]; then
        JOB_ID="$MATCHES"

        sqlite3 "$DB" "
            UPDATE requests
            SET torbox_id=$JOB_ID,
                updated_at=CURRENT_TIMESTAMP
            WHERE request_id=$(sqlq "$REQUEST_ID");
        "

        log "TorBox job discovered: $JOB_ID"
        printf '%s\n' "$JOB_ID"
        exit 0
    fi

    sleep 1
done

log "TorBox accepted torrent but scanner never observed matching job"
exit 1

#!/usr/bin/env bash
set -euo pipefail

REQUEST_ID="${1:?usage: settle-request.sh REQUEST_ID}"

: "${TORBOX_API_KEY:?TORBOX_API_KEY required}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"
TORBOX_API_URL="${TORBOX_API_URL:-https://api.torbox.app/v1/api}"

log() {
    printf '%s\n' "settle[$REQUEST_ID]: $*" >&2
}

sqlq() {
    local value="$1"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

REQUEST_INFO="$(
    sqlite3 -separator '|' "$DB" "
        SELECT
            state,
            provider,
            lower(info_hash),
            COALESCE(torbox_id, ''),
            provider_created,
            COALESCE(source_path, '')
        FROM requests
        WHERE request_id=$(sqlq "$REQUEST_ID");
    "
)"

if [ -z "$REQUEST_INFO" ]; then
    log "request not found"
    exit 1
fi

IFS='|' read -r STATE PROVIDER INFO_HASH TORBOX_ID PROVIDER_CREATED SOURCE_PATH \
    <<< "$REQUEST_INFO"

case "$STATE" in
    already_present|done|failed)
        ;;
    *)
        log "request is not terminal: $STATE"
        exit 3
        ;;
esac

if [ -z "$SOURCE_PATH" ] || [ ! -f "$SOURCE_PATH" ]; then
    log "request source file missing: $SOURCE_PATH"
    exit 1
fi

#
# Failed requests deliberately retain provider material.
#
if [ "$STATE" = "failed" ]; then
    log "failed request; provider source retained"
    /config/scripts/finalize-request.sh "$SOURCE_PATH"
    exit 0
fi

#
# A request that is already_present has satisfied Arr verification,
# but process-tv.sh never ran, so request-owned TorBox material may remain.
#
if [ "$STATE" = "already_present" ] &&
   [ "$PROVIDER_CREATED" -eq 1 ]; then

    case "$PROVIDER" in
        torbox|auto)
            ;;
        *)
            log "owned provider cleanup unsupported for provider: $PROVIDER"
            exit 1
            ;;
    esac

    if [ -z "$TORBOX_ID" ]; then
        log "provider_created=1 but torbox_id is missing"
        exit 1
    fi

    #
    # Before deleting anything, prove that this TorBox ID still represents
    # the exact hash carried by this request.
    #
    LIST="$(
        curl -fsS \
            -H "Authorization: Bearer $TORBOX_API_KEY" \
            "$TORBOX_API_URL/torrents/mylist?bypass_cache=true"
    )"

    PRESENT="$(
        printf '%s' "$LIST" |
        jq \
            --argjson id "$TORBOX_ID" '
            any(.data[]?; .id == $id)
        '
    )"

    if [ "$PRESENT" = "true" ]; then

        PROVIDER_HASH="$(
            printf '%s' "$LIST" |
            jq -r \
                --argjson id "$TORBOX_ID" '
                .data[]
                | select(.id == $id)
                | .hash
                ' |
            tr '[:upper:]' '[:lower:]'
        )"

        if [ "$PROVIDER_HASH" != "$INFO_HASH" ]; then
            log "REFUSING cleanup: TorBox ID hash does not match request"
            exit 1
        fi

        log "deleting request-owned TorBox job $TORBOX_ID"

        curl -fsS \
            -H "Authorization: Bearer $TORBOX_API_KEY" \
            -H 'Content-Type: application/json' \
            -X POST \
            --data \
                "{\"torrent_id\":$TORBOX_ID,\"operation\":\"delete\"}" \
            "$TORBOX_API_URL/torrents/controltorrent" |
        jq -e '.success == true' >/dev/null ||
            {
                log "TorBox delete request failed"
                exit 1
            }
    else
        log "request-owned TorBox job already absent"
    fi

    #
    # Deletion may be briefly stale in mylist.
    #
    REMOVED=0

    for _ in $(seq 1 20); do

        PRESENT="$(
            curl -fsS \
                -H "Authorization: Bearer $TORBOX_API_KEY" \
                "$TORBOX_API_URL/torrents/mylist?bypass_cache=true" |
            jq \
                --argjson id "$TORBOX_ID" '
                any(.data[]?; .id == $id)
            '
        )"

        if [ "$PRESENT" = "false" ]; then
            REMOVED=1
            break
        fi

        sleep 2
    done

    if [ "$REMOVED" -ne 1 ]; then
        log "TorBox deletion did not converge"
        exit 1
    fi

    log "request-owned TorBox cleanup confirmed"

elif [ "$STATE" = "already_present" ]; then

    #
    # The matching provider item predated this request.
    #
    log "provider item not request-owned; leaving it untouched"
fi

#
# state=done already implies the processor performed and verified provider
# cleanup. At this point the queue file can simply be finalized.
#
/config/scripts/finalize-request.sh "$SOURCE_PATH"

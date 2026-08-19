#!/bin/sh
set -eu

POLL_INTERVAL="${POLL_INTERVAL:-10}"
DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

log() {
    printf '%s\n' "worker: $*" >&2
}

log "starting TorBox importer"
log "poll interval: ${POLL_INTERVAL}s"

/config/scripts/db-init.sh >/dev/null

while :; do

    #
    # Process at most one explicit frontend request per loop.
    #
    # Resume anything already claimed first. This makes container restarts
    # safe: processing/ is durable and process-request.sh is idempotent.
    #
    REQUEST_FILE=""

    for CANDIDATE in /requests/processing/*.json; do
        [ -e "$CANDIDATE" ] || break
        REQUEST_FILE="$CANDIDATE"
        break
    done

    if [ -z "$REQUEST_FILE" ]; then
        if CLAIMED="$(/config/claim-request.sh)"; then
            REQUEST_FILE="$CLAIMED"
        else
            CLAIM_RC=$?

            if [ "$CLAIM_RC" -ne 3 ]; then
                log "request claim failed: rc=$CLAIM_RC"
            fi
        fi
    fi

    if [ -n "$REQUEST_FILE" ]; then
        log "processing request $REQUEST_FILE"

        if /config/scripts/process-request.sh "$REQUEST_FILE"; then
            log "request processing complete"
        else
            REQUEST_RC=$?
            log "request processing stopped: rc=$REQUEST_RC"
        fi
    fi

    #
    # Refresh TorBox inventory.
    #
    if ! /config/scripts/scan-torbox.sh; then
        log "TorBox scan failed"
        sleep "$POLL_INTERVAL"
        continue
    fi

    #
    # Classify every newly discovered job.
    #
    for JOB_ID in $(
        sqlite3 "$DB" "
            SELECT torbox_id
            FROM jobs
            WHERE state='discovered'
            ORDER BY first_seen;
        "
    ); do
        log "dispatching new job $JOB_ID"

        if ! /config/scripts/dispatch-job.sh "$JOB_ID"; then
            log "dispatcher error on job $JOB_ID"
        fi
    done

    #
    # Process exactly one legacy movie job at a time.
    #
    # Explicit request-driven TV jobs are handled above by process-request.sh.
    #
    MOVIE_JOB="$(
        sqlite3 "$DB" "
            SELECT torbox_id
            FROM jobs
            WHERE media_type='movie'
              AND arr_target='radarr'
              AND state IN (
                  'inspected',
                  'downloading',
                  'downloaded',
                  'evaluating',
                  'importing',
                  'cleaning'
              )
            ORDER BY first_seen
            LIMIT 1;
        "
    )"

    if [ -n "$MOVIE_JOB" ]; then
        log "processing movie job $MOVIE_JOB"

        if ! /config/scripts/process-movie.sh "$MOVIE_JOB"; then
            log "movie job $MOVIE_JOB stopped; inspect database state"
        fi
    fi

    sleep "$POLL_INTERVAL"
done

#!/bin/sh
set -eu

POLL_INTERVAL="${POLL_INTERVAL:-10}"
DB="${TORBOX_DB:-/config/state/torbox-importer.db}"
APP_ROOT="${APP_ROOT:-/app}"
SCRIPTS_DIR="${SCRIPTS_DIR:-${TORBOX_SCRIPTS_DIR:-$APP_ROOT/scripts}}"

log() {
    printf '%s\n' "worker: $*" >&2
}

log "starting TorBox importer"
log "poll interval: ${POLL_INTERVAL}s"

"$SCRIPTS_DIR/db-init.sh" >/dev/null

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
        if CLAIMED="$("$APP_ROOT/claim-request.sh")"; then
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

        if "$SCRIPTS_DIR/process-request.sh" "$REQUEST_FILE"; then
            log "request processing complete"
        else
            REQUEST_RC=$?
            log "request processing stopped: rc=$REQUEST_RC"
        fi
    fi

    #
    # Refresh TorBox inventory.
    #
    if ! "$SCRIPTS_DIR/scan-torbox.sh"; then
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

        if ! "$SCRIPTS_DIR/dispatch-job.sh" "$JOB_ID"; then
            log "dispatcher error on job $JOB_ID"
        fi
    done

    #
    # Process exactly one legacy movie job at a time.
    #
    # Explicit request-driven movie and TV jobs are handled above by process-request.sh.
    # Exclude any movie job that is associated with a queue request (by torbox_id or info_hash).
    #
    MOVIE_JOB="$(
        sqlite3 "$DB" "
            SELECT j.torbox_id
            FROM jobs j
            WHERE j.media_type='movie'
              AND j.arr_target='radarr'
              AND j.state IN (
                  'inspected',
                  'downloading',
                  'downloaded',
                  'evaluating',
                  'importing',
                  'cleaning'
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM requests r
                  WHERE r.torbox_id=j.torbox_id
                     OR (r.info_hash IS NOT NULL AND lower(r.info_hash)=lower(j.info_hash))
              )
            ORDER BY j.first_seen
            LIMIT 1;
        "
    )"

    if [ -n "$MOVIE_JOB" ]; then
        log "processing movie job $MOVIE_JOB"

        if ! "$SCRIPTS_DIR/process-movie.sh" "$MOVIE_JOB"; then
            MOVIE_STATE="$(
                sqlite3 "$DB" "
                    SELECT COALESCE(state, '')
                    FROM jobs
                    WHERE torbox_id=$MOVIE_JOB;
                "
            )"

            case "$MOVIE_STATE" in
                failed|done|already_present)
                    log "movie job $MOVIE_JOB stopped in terminal state: $MOVIE_STATE"
                    ;;
                *)
                    MOVIE_ERROR="Movie processor exited unexpectedly while job was ${MOVIE_STATE:-unknown}"
                    MOVIE_ERROR_SQL="$(printf '%s' "$MOVIE_ERROR" | sed "s/'/''/g")"

                    log "movie job $MOVIE_JOB: $MOVIE_ERROR"

                    sqlite3 "$DB" "
                        UPDATE jobs
                        SET state='failed',
                            last_error='$MOVIE_ERROR_SQL',
                            updated_at=CURRENT_TIMESTAMP
                        WHERE torbox_id=$MOVIE_JOB;
                    "
                    ;;
            esac
        fi
    fi

    sleep "$POLL_INTERVAL"
done

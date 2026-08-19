#!/usr/bin/env bash
set -euo pipefail

FILE="${1:?usage: process-request.sh REQUEST.json}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"
SCRIPTS_DIR="${TORBOX_SCRIPTS_DIR:-/config/scripts}"

log() {
    printf '%s\n' "request-consumer: $*" >&2
}

if [[ ! -f "$FILE" ]]; then
    log "request file missing: $FILE"
    exit 1
fi

#
# Persist and validate the handoff first.
#
"$SCRIPTS_DIR/ingest-request.sh" "$FILE"

REQUEST_ID="$(jq -r '.requestId' "$FILE")"

get_request_state() {
    sqlite3 "$DB" "
        SELECT state
        FROM requests
        WHERE request_id='$REQUEST_ID';
    "
}

get_job_state() {
    sqlite3 "$DB" "
        SELECT state
        FROM jobs
        WHERE torbox_id=$JOB_ID;
    "
}

STATE="$(get_request_state)"

#
# Duplicate delivery of an already-terminal request.
#
case "$STATE" in
    done|already_present|failed)
        log "request already terminal: $STATE"
        "$SCRIPTS_DIR/settle-request.sh" "$REQUEST_ID"
        exit 0
        ;;
    processing)
        ;;
    *)
        log "unexpected request state: $STATE"
        exit 1
        ;;
esac

MEDIA_TYPE="$(
    sqlite3 "$DB" "
        SELECT media_type
        FROM requests
        WHERE request_id='$REQUEST_ID';
    "
)"

SCOPE="$(
    sqlite3 "$DB" "
        SELECT scope
        FROM requests
        WHERE request_id='$REQUEST_ID';
    "
)"

#
# Unattended request modes are deliberately explicit.
#
case "$MEDIA_TYPE/$SCOPE" in
    tv/episode|movie/movie)
        ;;
    *)
        log "unsupported unattended request type: $MEDIA_TYPE/$SCOPE"
        exit 3
        ;;
esac

#
# Ensure the requested release exists in TorBox and link the provider job.
#
JOB_ID="$(
    "$SCRIPTS_DIR/ensure-torbox-job.sh" "$REQUEST_ID"
)"

if [[ -z "$JOB_ID" ]]; then
    log "ensure-torbox-job returned no job id"
    exit 1
fi

log "request linked to TorBox job $JOB_ID"

JOB_STATE="$(get_job_state)"

#
# A completed TV job may still point at a retained provider resource.
#
# This happens when the torrent was created outside the importer (for
# example TBM), an earlier episode was imported, and the TorBox season
# pack was deliberately retained.
#
# Reuse is allowed only after proving that TorBox still has this exact
# ID and that its hash still matches our job.
#
if [[ "$JOB_STATE" == "done" ]]; then

    JOB_HASH="$(
        sqlite3 "$DB" "
            SELECT lower(info_hash)
            FROM jobs
            WHERE torbox_id=$JOB_ID;
        "
    )"

    LIST="$(
        curl -fsS \
            -H "Authorization: Bearer $TORBOX_API_KEY" \
            "${TORBOX_API_URL:-https://api.torbox.app/v1/api}/torrents/mylist?bypass_cache=true"
    )"

    PROVIDER_HASH="$(
        printf '%s' "$LIST" |
        jq -r \
            --argjson id "$JOB_ID" '
                .data[]
                | select(.id == $id)
                | .hash
            ' |
        tr '[:upper:]' '[:lower:]'
    )"

    if [[ -n "$PROVIDER_HASH" && "$PROVIDER_HASH" == "$JOB_HASH" ]]; then

        if [[ "$MEDIA_TYPE" == "movie" ]]; then
            JOB_CLASSIFICATION="$(
                sqlite3 -separator '|' "$DB" "
                    SELECT COALESCE(media_type, ''), COALESCE(arr_target, '')
                    FROM jobs
                    WHERE torbox_id=$JOB_ID;
                "
            )"

            if [[ "$JOB_CLASSIFICATION" != "movie|radarr" ]]; then
                log "completed retained job is not a proven Radarr movie"
                exit 3
            fi

            log "completed movie job has retained matching source; reopening inspection"
            sqlite3 "$DB" "
                UPDATE jobs
                SET state='inspected',
                    last_error=NULL,
                    updated_at=CURRENT_TIMESTAMP
                WHERE torbox_id=$JOB_ID;
            "
            JOB_STATE="inspected"
        else
            log "completed TV job has retained matching source; reopening selection"

            sqlite3 "$DB" "
                UPDATE files
                SET selected=0,
                    arr_rejection=NULL,
                    updated_at=CURRENT_TIMESTAMP
                WHERE torbox_id=$JOB_ID;

                UPDATE jobs
                SET state='awaiting_selection',
                    last_error=NULL,
                    updated_at=CURRENT_TIMESTAMP
                WHERE torbox_id=$JOB_ID;
            "

            JOB_STATE="awaiting_selection"
        fi

    else
        log "completed job has no reusable matching TorBox source"
        exit 3
    fi
fi

#
# A genuinely new TorBox item still needs media classification.
#

if [[ "$JOB_STATE" == "discovered" ]]; then
    log "dispatching job $JOB_ID"

    if ! "$SCRIPTS_DIR/dispatch-job.sh" "$JOB_ID"; then
        log "dispatcher failed for job $JOB_ID"
        exit 1
    fi

    JOB_STATE="$(get_job_state)"
fi

STATE="$(get_request_state)"

case "$STATE" in
    already_present|done|failed)
        log "request became terminal during dispatch: $STATE"
        "$SCRIPTS_DIR/settle-request.sh" "$REQUEST_ID"
        exit 0
        ;;
esac

#
# A TV job may have been discovered before its explicit request existed.
#
# Now that the request is persisted, retry only file selection. Do NOT
# redispatch/reclassify the already-known TV job.
#
if [[ "$JOB_STATE" == "awaiting_selection" && "$MEDIA_TYPE" == "tv" ]]; then
    log "explicit intent now available; retrying TV selection for job $JOB_ID"

    if ! "$SCRIPTS_DIR/select-tv-files.sh" "$JOB_ID"; then
        JOB_STATE="$(get_job_state)"
        STATE="$(get_request_state)"

        case "$STATE" in
            already_present|done|failed)
                "$SCRIPTS_DIR/settle-request.sh" "$REQUEST_ID"
                exit 0
                ;;
        esac

        log "TV selection still requires attention: job state=$JOB_STATE"
        exit 3
    fi

    JOB_STATE="$(get_job_state)"
    STATE="$(get_request_state)"

    case "$STATE" in
        already_present|done|failed)
            log "request became terminal during selection: $STATE"
            "$SCRIPTS_DIR/settle-request.sh" "$REQUEST_ID"
            exit 0
            ;;
    esac
fi

if [[ "$MEDIA_TYPE" == "movie" ]]; then
    case "$JOB_STATE" in
        inspected|downloading|downloaded|evaluating|importing|cleaning|already_present)
            "$SCRIPTS_DIR/validate-movie-request-match.sh" "$REQUEST_ID" "$JOB_ID" >/dev/null
            ;;
    esac
fi

if [[ "$MEDIA_TYPE" == "movie" && "$JOB_STATE" == "already_present" ]]; then
    "$SCRIPTS_DIR/sync-movie-request-state.sh" "$REQUEST_ID" "$JOB_ID" >/dev/null
    "$SCRIPTS_DIR/settle-request.sh" "$REQUEST_ID"
    exit 0
fi

#
# Explicit TV request selected something that genuinely needs importing.
#
case "$JOB_STATE" in
    inspected|downloading|downloaded|evaluating|importing|cleaning)
        log "processing $MEDIA_TYPE job $JOB_ID"

        if [[ "$MEDIA_TYPE" == "movie" ]]; then
            PROCESSOR="$SCRIPTS_DIR/process-movie.sh"
        else
            PROCESSOR="$SCRIPTS_DIR/process-tv.sh"
        fi

        if ! "$PROCESSOR" "$JOB_ID"; then
            if [[ "$MEDIA_TYPE" == "movie" ]]; then
                "$SCRIPTS_DIR/sync-movie-request-state.sh" "$REQUEST_ID" "$JOB_ID" >/dev/null || true
            fi

            STATE="$(get_request_state)"

            if [[ "$STATE" == "failed" ]]; then
                "$SCRIPTS_DIR/settle-request.sh" "$REQUEST_ID"
            fi

            exit 1
        fi
        ;;

    awaiting_selection)
        log "$MEDIA_TYPE job still requires manual selection; leaving request in processing"
        exit 3
        ;;

    failed)
        log "job is failed"
        if [[ "$MEDIA_TYPE" == "movie" ]]; then
            "$SCRIPTS_DIR/sync-movie-request-state.sh" "$REQUEST_ID" "$JOB_ID" >/dev/null
            "$SCRIPTS_DIR/settle-request.sh" "$REQUEST_ID"
        fi
        exit 1
        ;;

    *)
        log "unexpected job state after selection: $JOB_STATE"
        exit 1
        ;;
esac

if [[ "$MEDIA_TYPE" == "movie" ]]; then
    "$SCRIPTS_DIR/sync-movie-request-state.sh" "$REQUEST_ID" "$JOB_ID" >/dev/null
fi

STATE="$(get_request_state)"

case "$STATE" in
    done|already_present|failed)
        "$SCRIPTS_DIR/settle-request.sh" "$REQUEST_ID"
        ;;
    *)
        log "processor returned but request is not terminal: $STATE"
        exit 1
        ;;
esac

log "request complete: $REQUEST_ID ($STATE)"

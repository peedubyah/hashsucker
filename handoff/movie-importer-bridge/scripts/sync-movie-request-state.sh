#!/usr/bin/env bash
set -euo pipefail

REQUEST_ID="${1:?usage: sync-movie-request-state.sh REQUEST_ID TORBOX_ID}"
JOB_ID="${2:?usage: sync-movie-request-state.sh REQUEST_ID TORBOX_ID}"
DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

sqlq() {
    local value="$1"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

JOB_INFO="$(
    sqlite3 -separator '|' "$DB" "
        SELECT state, COALESCE(last_error, '')
        FROM jobs
        WHERE torbox_id=$JOB_ID;
    "
)"

if [[ -z "$JOB_INFO" ]]; then
    echo "movie request job not found: $JOB_ID" >&2
    exit 1
fi

JOB_STATE="${JOB_INFO%%|*}"
JOB_ERROR="${JOB_INFO#*|}"

case "$JOB_STATE" in
    done|already_present|failed)
        ;;
    *)
        echo "movie job is not terminal: $JOB_ID ($JOB_STATE)" >&2
        exit 3
        ;;
esac

sqlite3 "$DB" "
    UPDATE requests
    SET state=$(sqlq "$JOB_STATE"),
        torbox_id=$JOB_ID,
        last_error=$(sqlq "$JOB_ERROR"),
        updated_at=CURRENT_TIMESTAMP
    WHERE request_id=$(sqlq "$REQUEST_ID")
      AND state='processing'
      AND media_type='movie'
      AND scope='movie'
      AND torbox_id=$JOB_ID;
"

UPDATED="$(
    sqlite3 "$DB" "
        SELECT state
        FROM requests
        WHERE request_id=$(sqlq "$REQUEST_ID")
          AND media_type='movie'
          AND scope='movie'
          AND torbox_id=$JOB_ID;
    "
)"

if [[ "$UPDATED" != "$JOB_STATE" ]]; then
    echo "movie request terminal propagation refused: $REQUEST_ID" >&2
    exit 1
fi

printf '%s\n' "$UPDATED"

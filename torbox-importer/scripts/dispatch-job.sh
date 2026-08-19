#!/bin/bash
set -euo pipefail

JOB_ID="${1:?usage: dispatch-job.sh TORBOX_ID}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

log() {
    printf '%s\n' "dispatch[$JOB_ID]: $*" >&2
}

#
# Only dispatch genuinely new jobs.
#
JOB_INFO="$(
    sqlite3 -separator '|' "$DB" "
        SELECT state, COALESCE(media_type, '')
        FROM jobs
        WHERE torbox_id=$JOB_ID;
    "
)"

if [ -z "$JOB_INFO" ]; then
    log "job not found"
    exit 1
fi

STATE="${JOB_INFO%%|*}"
MEDIA_TYPE="${JOB_INFO#*|}"

if [ "$STATE" != "discovered" ]; then
    log "state is '$STATE'; nothing to dispatch"
    exit 0
fi

if [ -n "$MEDIA_TYPE" ]; then
    log "job already classified as '$MEDIA_TYPE'; refusing redispatch"
    exit 0
fi

#
# Examine only real-looking video files.
# Samples are deliberately ignored here exactly as in the TV selector.
#
VIDEO_NAMES="$(
    sqlite3 "$DB" "
        SELECT path
        FROM files
        WHERE torbox_id=$JOB_ID
          AND (
            lower(path) LIKE '%.mkv'
            OR lower(path) LIKE '%.mp4'
            OR lower(path) LIKE '%.m4v'
          )
          AND lower(path) NOT LIKE '%sample%'
        ORDER BY file_id;
    "
)"

if [ -z "$VIDEO_NAMES" ]; then
    sqlite3 "$DB" "
        UPDATE jobs
        SET state='awaiting_selection',
            last_error='No usable video files',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "

    log "no usable video files"
    exit 0
fi

VIDEO_COUNT="$(printf '%s\n' "$VIDEO_NAMES" | grep -c . || true)"

log "examining $VIDEO_COUNT video file(s)"

#
# Explicit episode syntax gets first priority.
#
# Examples:
#   Show.S05E07.mkv
#   Show.S05E07E08.mkv
#   Show.5x07.mkv
#
# This prevents a movie year like 2016 from ever being handed to Sonarr
# as though it were S20E16.
#
if printf '%s\n' "$VIDEO_NAMES" |
    grep -Eiq \
        'S[0-9]{1,2}E[0-9]{1,3}|[0-9]{1,2}x[0-9]{1,3}'
then
    log "explicit episode token found → TV candidate"

    exec /config/scripts/select-tv-files.sh "$JOB_ID"
fi

#
# No explicit episode syntax.
# Let the movie inspector attempt a strong Radarr identification.
#
log "no episode token → movie candidate"

exec /config/scripts/inspect-job.sh "$JOB_ID"

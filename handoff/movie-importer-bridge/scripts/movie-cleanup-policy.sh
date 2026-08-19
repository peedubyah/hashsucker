#!/usr/bin/env bash
set -euo pipefail

JOB_ID="${1:?usage: movie-cleanup-policy.sh TORBOX_ID}"
DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

REQUEST_COUNT="$(
    sqlite3 "$DB" "
        SELECT COUNT(*)
        FROM requests
        WHERE state='processing'
          AND media_type='movie'
          AND scope='movie'
          AND torbox_id=$JOB_ID;
    "
)"

OWNED_COUNT="$(
    sqlite3 "$DB" "
        SELECT COUNT(*)
        FROM requests
        WHERE state='processing'
          AND media_type='movie'
          AND scope='movie'
          AND provider IN ('torbox', 'auto')
          AND provider_created=1
          AND torbox_id=$JOB_ID;
    "
)"

if [[ "$REQUEST_COUNT" -eq 0 ]]; then
    printf '%s\n' 'delete-legacy'
elif [[ "$OWNED_COUNT" -gt 0 ]]; then
    printf '%s\n' 'delete-request-owned'
else
    printf '%s\n' 'retain-preexisting'
fi

#!/usr/bin/env bash
set -euo pipefail

JOB_ID="${1:?usage: movie-cleanup-policy.sh TORBOX_ID}"
DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

JOB_HASH="$(
    sqlite3 "$DB" "
        SELECT lower(info_hash)
        FROM jobs
        WHERE torbox_id=$JOB_ID;
    "
)"

sqlq() {
    local value="$1"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

REQUEST_COUNT="$(
    sqlite3 "$DB" "
        SELECT COUNT(*)
        FROM requests
        WHERE state='processing'
          AND (
            torbox_id=$JOB_ID
            OR ($([[ -n "$JOB_HASH" ]] && printf 'lower(info_hash)=%s' "$(sqlq "$JOB_HASH")" || printf '0=1'))
          );
    "
)"

OWNED_COUNT="$(
    sqlite3 "$DB" "
        SELECT COUNT(*)
        FROM requests
        WHERE state='processing'
          AND provider IN ('torbox', 'auto')
          AND provider_created=1
          AND (
            torbox_id=$JOB_ID
            OR ($([[ -n "$JOB_HASH" ]] && printf 'lower(info_hash)=%s' "$(sqlq "$JOB_HASH")" || printf '0=1'))
          );
    "
)"

if [[ "$REQUEST_COUNT" -eq 0 ]]; then
    printf '%s\n' 'delete-legacy'
elif [[ "$REQUEST_COUNT" -gt 1 ]]; then
    # Multiple active requests reference this job or hash; retain fail-safe to prevent breaking concurrent/pending requests
    printf '%s\n' 'retain-preexisting'
elif [[ "$OWNED_COUNT" -gt 0 ]]; then
    printf '%s\n' 'delete-request-owned'
else
    printf '%s\n' 'retain-preexisting'
fi

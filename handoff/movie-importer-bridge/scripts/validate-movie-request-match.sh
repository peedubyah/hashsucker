#!/usr/bin/env bash
set -euo pipefail

REQUEST_ID="${1:?usage: validate-movie-request-match.sh REQUEST_ID TORBOX_ID}"
JOB_ID="${2:?usage: validate-movie-request-match.sh REQUEST_ID TORBOX_ID}"
: "${RADARR_API_KEY:?RADARR_API_KEY required}"
: "${RADARR_URL:?RADARR_URL required}"
DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

sqlq() {
    local value="$1"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

REQUEST_MEDIA_ID="$(
    sqlite3 "$DB" "
        SELECT media_id
        FROM requests
        WHERE request_id=$(sqlq "$REQUEST_ID")
          AND state='processing'
          AND media_type='movie'
          AND scope='movie'
          AND torbox_id=$JOB_ID;
    "
)"

ARR_MATCH="$(
    sqlite3 "$DB" "
        SELECT arr_match
        FROM files
        WHERE torbox_id=$JOB_ID
          AND selected=1
        LIMIT 1;
    "
)"

TMDB_ID="${ARR_MATCH#tmdb:}"
if ! [[ "$TMDB_ID" =~ ^[0-9]+$ ]]; then
    echo "selected movie has no valid TMDB classification" >&2
    exit 1
fi

case "$REQUEST_MEDIA_ID" in
    tmdb:"$TMDB_ID")
        ;;
    tt[0-9]*)
        RADARR_IMDB_ID="$(
            curl -fsS \
                -H "X-Api-Key: $RADARR_API_KEY" \
                --get \
                --data-urlencode "term=tmdb:$TMDB_ID" \
                "$RADARR_URL/api/v3/movie/lookup" |
            jq -r --argjson tmdb "$TMDB_ID" '[.[] | select(.tmdbId == $tmdb)][0].imdbId // empty'
        )"

        if [[ "$RADARR_IMDB_ID" != "$REQUEST_MEDIA_ID" ]]; then
            echo "requested IMDb ID does not match Radarr-classified movie" >&2
            exit 1
        fi
        ;;
    *)
        echo "unsupported or mismatched movie request ID: $REQUEST_MEDIA_ID" >&2
        exit 1
        ;;
esac

printf 'MATCHED: %s -> tmdb:%s\n' "$REQUEST_MEDIA_ID" "$TMDB_ID"

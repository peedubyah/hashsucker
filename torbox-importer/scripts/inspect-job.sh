#!/bin/sh
set -eu

JOB_ID="${1:?usage: inspect-job.sh TORBOX_ID}"

: "${RADARR_API_KEY:?}"
: "${RADARR_URL:?}"
: "${SONARR_API_KEY:?}"
: "${SONARR_URL:?}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

log() {
    printf '%s\n' "inspect-job[$JOB_ID]: $*" >&2
}

sqlq() {
    printf '%s' "$1" | sed "s/'/''/g"
}

FILE_ROW="$(
    sqlite3 -separator '|' "$DB" "
        SELECT file_id, path, size
        FROM files
        WHERE torbox_id=$JOB_ID
          AND (
            lower(path) LIKE '%.mkv'
            OR lower(path) LIKE '%.mp4'
            OR lower(path) LIKE '%.m4v'
          )
        ORDER BY size DESC
        LIMIT 1;
    "
)"

if [ -z "$FILE_ROW" ]; then
    sqlite3 "$DB" "
        UPDATE jobs
        SET state='awaiting_selection',
            last_error='No recognized video files',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "
    log "no video files"
    exit 0
fi

FILE_ID="$(printf '%s' "$FILE_ROW" | cut -d'|' -f1)"
FILE_PATH="$(printf '%s' "$FILE_ROW" | cut -d'|' -f2)"
TITLE="${FILE_PATH##*/}"

log "candidate file_id=$FILE_ID: $TITLE"

RADARR_PARSE="$(
    curl -fsS \
      -H "X-Api-Key: $RADARR_API_KEY" \
      --get \
      --data-urlencode "title=$TITLE" \
      "$RADARR_URL/api/v3/parse"
)"

MOVIE_TITLE="$(printf '%s' "$RADARR_PARSE" | jq -r '.parsedMovieInfo.movieTitle // empty')"
YEAR="$(printf '%s' "$RADARR_PARSE" | jq -r '.parsedMovieInfo.year // 0')"

if [ -z "$MOVIE_TITLE" ] || [ "$YEAR" -le 1900 ]; then
    sqlite3 "$DB" "
        UPDATE jobs
        SET state='awaiting_selection',
            last_error='No confident Radarr title/year parse',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "
    log "not confidently movie-shaped"
    exit 0
fi

RADARR_MATCH="$(
    curl -fsS \
      -H "X-Api-Key: $RADARR_API_KEY" \
      --get \
      --data-urlencode "term=$MOVIE_TITLE $YEAR" \
      "$RADARR_URL/api/v3/movie/lookup" |
    jq --arg title "$MOVIE_TITLE" --argjson year "$YEAR" '
      def norm:
        ascii_downcase | gsub("[^a-z0-9]"; "");

      ($title | norm) as $needle |

      [
        .[]
        | select(.year == $year)
        | (.title | norm) as $candidate
        | select(
            ($candidate | contains($needle))
            or
            ($needle | contains($candidate))
          )
      ][0] // empty
    '
)"

TMDB_ID="$(printf '%s' "$RADARR_MATCH" | jq -r '.tmdbId // 0')"

if [ "$TMDB_ID" -eq 0 ]; then
    sqlite3 "$DB" "
        UPDATE jobs
        SET state='awaiting_selection',
            last_error='Radarr lookup did not produce confident movie match',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "
    log "Radarr lookup not confident"
    exit 0
fi

# Sonarr sanity guard. If Sonarr has a similarly named show from the same year,
# don't automatically call it a movie.
SONARR_CONFLICT="$(
    curl -fsS \
      -H "X-Api-Key: $SONARR_API_KEY" \
      --get \
      --data-urlencode "term=$MOVIE_TITLE" \
      "$SONARR_URL/api/v3/series/lookup" |
    jq --arg title "$MOVIE_TITLE" --argjson year "$YEAR" '
      def norm:
        ascii_downcase | gsub("[^a-z0-9]"; "");

      ($title | norm) as $needle |

      any(
        .[];
        (.year == $year)
        and (
          ((.title | norm) | contains($needle))
          or
          ($needle | contains(.title | norm))
        )
      )
    '
)"

if [ "$SONARR_CONFLICT" = "true" ]; then
    sqlite3 "$DB" "
        UPDATE jobs
        SET state='awaiting_selection',
            last_error='Both Sonarr and Radarr appear plausible',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "
    log "Sonarr conflict; leaving untouched"
    exit 0
fi

sqlite3 "$DB" "
    UPDATE files
    SET selected=0,
        updated_at=CURRENT_TIMESTAMP
    WHERE torbox_id=$JOB_ID;

    UPDATE files
    SET selected=1,
        arr_match='tmdb:$TMDB_ID',
        updated_at=CURRENT_TIMESTAMP
    WHERE torbox_id=$JOB_ID
      AND file_id=$FILE_ID;

    UPDATE jobs
    SET state='inspected',
        media_type='movie',
        arr_target='radarr',
        last_error=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE torbox_id=$JOB_ID;

    INSERT INTO events (torbox_id,event_type,message)
    VALUES (
      $JOB_ID,
      'classified',
      'movie tmdb:$TMDB_ID'
    );
"

log "movie → TMDB $TMDB_ID"

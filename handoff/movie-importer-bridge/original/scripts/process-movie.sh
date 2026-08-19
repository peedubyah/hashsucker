#!/bin/sh
set -eu

JOB_ID="${1:?usage: process-movie.sh TORBOX_ID}"

: "${TORBOX_API_KEY:?}"
: "${RADARR_API_KEY:?}"
: "${RADARR_URL:?}"
: "${RADARR_ROOT_FOLDER:=/data/Movies}"
: "${RADARR_PROFILE_HD:=4}"
: "${RADARR_PROFILE_4K_WEB:=7}"
: "${RADARR_PROFILE_4K_BLU:=8}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"
TORBOX_API_URL="${TORBOX_API_URL:-https://api.torbox.app/v1/api}"

log() {
    printf '%s\n' "movie[$JOB_ID]: $*" >&2
}

sqlq() {
    printf '%s' "$1" | sed "s/'/''/g"
}

fail_job() {
    MSG="$1"
    ESC="$(sqlq "$MSG")"

    sqlite3 "$DB" "
        UPDATE jobs
        SET state='failed',
            last_error='$ESC',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;

        INSERT INTO events (torbox_id,event_type,message)
        VALUES ($JOB_ID,'failed','$ESC');
    "

    log "FAILED: $MSG"
    exit 1
}

CURRENT_STATE="$(
    sqlite3 "$DB" "
      SELECT state
      FROM jobs
      WHERE torbox_id=$JOB_ID;
    "
)"

FILE_ROW="$(
    sqlite3 -separator '|' "$DB" "
      SELECT file_id,path,size,arr_match
      FROM files
      WHERE torbox_id=$JOB_ID
        AND selected=1
      LIMIT 1;
    "
)"

[ -n "$FILE_ROW" ] || fail_job "No selected movie file"

FILE_ID="$(printf '%s' "$FILE_ROW" | cut -d'|' -f1)"
FILE_PATH="$(printf '%s' "$FILE_ROW" | cut -d'|' -f2)"
EXPECTED_SIZE="$(printf '%s' "$FILE_ROW" | cut -d'|' -f3)"
ARR_MATCH="$(printf '%s' "$FILE_ROW" | cut -d'|' -f4)"

TMDB_ID="${ARR_MATCH#tmdb:}"

case "$TMDB_ID" in
    ''|*[!0-9]*) fail_job "Invalid TMDB match: $ARR_MATCH" ;;
esac

NAME="${FILE_PATH##*/}"
STAGE="/downloads/.torbox-importer/$JOB_ID"
LOCAL_FILE="$STAGE/$NAME"

# Parse quality to select only the broad Radarr profile lane.
PARSE="$(
    curl -fsS \
      -H "X-Api-Key: $RADARR_API_KEY" \
      --get \
      --data-urlencode "title=$NAME" \
      "$RADARR_URL/api/v3/parse"
)"

RESOLUTION="$(printf '%s' "$PARSE" | jq -r '.parsedMovieInfo.quality.quality.resolution // 0')"
SOURCE="$(printf '%s' "$PARSE" | jq -r '.parsedMovieInfo.quality.quality.source // ""' | tr '[:upper:]' '[:lower:]')"

if [ "$RESOLUTION" -le 1080 ] && [ "$RESOLUTION" -gt 0 ]; then
    PROFILE="$RADARR_PROFILE_HD"
elif [ "$RESOLUTION" -eq 2160 ]; then
    case "$SOURCE" in
        bluray|remux)
            PROFILE="$RADARR_PROFILE_4K_BLU"
            ;;
        *)
            PROFILE="$RADARR_PROFILE_4K_WEB"
            ;;
    esac
else
    fail_job "Unsupported/ambiguous quality: ${SOURCE}-${RESOLUTION}"
fi

# Find existing movie.
MOVIE_JSON="$(
    curl -fsS \
      -H "X-Api-Key: $RADARR_API_KEY" \
      "$RADARR_URL/api/v3/movie" |
    jq --argjson tmdb "$TMDB_ID" '
      [.[] | select(.tmdbId == $tmdb)][0] // empty
    '
)"

MOVIE_ID="$(printf '%s' "$MOVIE_JSON" | jq -r '.id // 0')"

# Add it if this is a new acquisition.
if [ "$MOVIE_ID" -eq 0 ]; then
    log "adding TMDB $TMDB_ID to Radarr"

    LOOKUP="$(
        curl -fsS \
          -H "X-Api-Key: $RADARR_API_KEY" \
          --get \
          --data-urlencode "term=tmdb:$TMDB_ID" \
          "$RADARR_URL/api/v3/movie/lookup" |
        jq '.[0]'
    )"

    MOVIE_JSON="$(
        printf '%s\n' "$LOOKUP" |
        jq \
          --arg root "$RADARR_ROOT_FOLDER" \
          --argjson profile "$PROFILE" '
          . + {
            rootFolderPath: $root,
            qualityProfileId: $profile,
            monitored: true,
            addOptions: {
              searchForMovie: false
            }
          }
        ' |
        curl -fsS \
          -H "X-Api-Key: $RADARR_API_KEY" \
          -H 'Content-Type: application/json' \
          -X POST \
          --data-binary @- \
          "$RADARR_URL/api/v3/movie"
    )"

    MOVIE_ID="$(printf '%s' "$MOVIE_JSON" | jq -r '.id // 0')"
    [ "$MOVIE_ID" -gt 0 ] || fail_job "Radarr movie creation failed"
fi

HAS_FILE="$(printf '%s' "$MOVIE_JSON" | jq -r '.hasFile // false')"

# If this job was already in/after import and the exact-size library file exists,
# recover from a container/script interruption and continue cleanup.
if [ "$HAS_FILE" = "true" ]; then
    EXISTING_SIZE="$(printf '%s' "$MOVIE_JSON" | jq -r '.movieFile.size // 0')"

    case "$CURRENT_STATE" in
        importing|cleaning)
            if [ "$EXISTING_SIZE" = "$EXPECTED_SIZE" ]; then
                log "existing exact-size Radarr file confirms previous import"
                goto_cleanup=1
            else
                fail_job "Radarr file exists after interrupted import but size differs"
            fi
            ;;
        *)
            sqlite3 "$DB" "
              UPDATE jobs
              SET state='already_present',
                  last_error='Movie already has a file; upgrade policy not enabled',
                  updated_at=CURRENT_TIMESTAMP
              WHERE torbox_id=$JOB_ID;
            "
            log "movie already present; leaving TorBox source untouched"
            exit 0
            ;;
    esac
else
    goto_cleanup=0
fi

if [ "$goto_cleanup" -eq 0 ]; then

    mkdir -p "$STAGE"

    sqlite3 "$DB" "
      UPDATE jobs
      SET state='downloading',
          updated_at=CURRENT_TIMESTAMP
      WHERE torbox_id=$JOB_ID;

      UPDATE files
      SET download_state='downloading',
          updated_at=CURRENT_TIMESTAMP
      WHERE torbox_id=$JOB_ID
        AND file_id=$FILE_ID;
    "

    HAVE_SIZE=0
    if [ -f "$LOCAL_FILE" ]; then
        HAVE_SIZE="$(stat -c '%s' "$LOCAL_FILE")"
    fi

    if [ "$HAVE_SIZE" != "$EXPECTED_SIZE" ]; then
        DOWNLOADED=0

        for ATTEMPT in 1 2 3; do
            log "download attempt $ATTEMPT"

            DOWNLOAD_URL="$(
                curl -fsS --get \
                  --data-urlencode "token=$TORBOX_API_KEY" \
                  --data-urlencode "torrent_id=$JOB_ID" \
                  --data-urlencode "file_id=$FILE_ID" \
                  --data-urlencode "redirect=false" \
                  "$TORBOX_API_URL/torrents/requestdl" |
                jq -er '.data'
            )" || continue

            if aria2c \
                --continue=true \
                --split=8 \
                --max-connection-per-server=8 \
                --min-split-size=16M \
                --connect-timeout=10 \
                --timeout=30 \
                --max-tries=2 \
                --retry-wait=2 \
                --lowest-speed-limit=1M \
                --file-allocation=none \
                --auto-file-renaming=false \
                --allow-overwrite=false \
                --dir="$STAGE" \
                --out="$NAME" \
                "$DOWNLOAD_URL"
            then
                ACTUAL_SIZE="$(stat -c '%s' "$LOCAL_FILE")"

                if [ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ]; then
                    DOWNLOADED=1
                    break
                fi
            fi

            log "attempt $ATTEMPT failed; requesting fresh TorBox URL"
        done

        [ "$DOWNLOADED" -eq 1 ] || fail_job "Download failed or size verification failed"
    fi

    sqlite3 "$DB" "
      UPDATE jobs
      SET state='downloaded',
          updated_at=CURRENT_TIMESTAMP
      WHERE torbox_id=$JOB_ID;

      UPDATE files
      SET download_state='completed',
          updated_at=CURRENT_TIMESTAMP
      WHERE torbox_id=$JOB_ID
        AND file_id=$FILE_ID;
    "

    log "download verified"

    sqlite3 "$DB" "
      UPDATE jobs
      SET state='evaluating',
          updated_at=CURRENT_TIMESTAMP
      WHERE torbox_id=$JOB_ID;
    "

    CANDIDATES="$(
        curl -fsS \
          -H "X-Api-Key: $RADARR_API_KEY" \
          --get \
          --data-urlencode "folder=$STAGE" \
          --data-urlencode "filterExistingFiles=true" \
          "$RADARR_URL/api/v3/manualimport"
    )"

    ACCEPTABLE="$(
        printf '%s' "$CANDIDATES" |
        jq --argjson movie "$MOVIE_ID" '
          [
            .[]
            | select(.movie.id == $movie)
            | select((.rejections | length) == 0)
          ]
        '
    )"

    COUNT="$(printf '%s' "$ACCEPTABLE" | jq 'length')"

    [ "$COUNT" -eq 1 ] || fail_job "Radarr did not return exactly one acceptable import candidate"

    CANDIDATE="$(printf '%s' "$ACCEPTABLE" | jq '.[0]')"

    PAYLOAD="$(
        printf '%s' "$CANDIDATE" |
        jq '{
          name: "ManualImport",
          importMode: "move",
          files: [
            {
              path: .path,
              movieId: .movie.id,
              quality: .quality,
              languages: .languages,
              releaseGroup: .releaseGroup,
              indexerFlags: (.indexerFlags // 0)
            }
          ]
        }'
    )"

    sqlite3 "$DB" "
      UPDATE jobs
      SET state='importing',
          updated_at=CURRENT_TIMESTAMP
      WHERE torbox_id=$JOB_ID;
    "

    COMMAND_ID="$(
        printf '%s' "$PAYLOAD" |
        curl -fsS \
          -H "X-Api-Key: $RADARR_API_KEY" \
          -H 'Content-Type: application/json' \
          -X POST \
          --data-binary @- \
          "$RADARR_URL/api/v3/command" |
        jq -r '.id'
    )"

    IMPORT_OK=0

    for _ in $(seq 1 60); do
        STATUS="$(
            curl -fsS \
              -H "X-Api-Key: $RADARR_API_KEY" \
              "$RADARR_URL/api/v3/command/$COMMAND_ID"
        )"

        STATE="$(printf '%s' "$STATUS" | jq -r '.status')"

        case "$STATE" in
            completed)
                IMPORT_OK=1
                break
                ;;
            failed)
                break
                ;;
        esac

        sleep 2
    done

    [ "$IMPORT_OK" -eq 1 ] || fail_job "Radarr ManualImport failed or timed out"

    VERIFY="$(
        curl -fsS \
          -H "X-Api-Key: $RADARR_API_KEY" \
          "$RADARR_URL/api/v3/movie/$MOVIE_ID"
    )"

    VERIFY_HAS="$(printf '%s' "$VERIFY" | jq -r '.hasFile')"
    VERIFY_SIZE="$(printf '%s' "$VERIFY" | jq -r '.movieFile.size // 0')"

    [ "$VERIFY_HAS" = "true" ] || fail_job "Radarr import completed but movie hasFile=false"
    [ "$VERIFY_SIZE" = "$EXPECTED_SIZE" ] || fail_job "Radarr library file size does not match TorBox source"

    LIBRARY_PATH="$(
        printf '%s' "$VERIFY" |
        jq -r '.path + "/" + .movieFile.relativePath'
    )"

    ESC_PATH="$(sqlq "$LIBRARY_PATH")"

    sqlite3 "$DB" "
      UPDATE files
      SET imported=1,
          download_state='completed',
          library_path='$ESC_PATH',
          updated_at=CURRENT_TIMESTAMP
      WHERE torbox_id=$JOB_ID
        AND file_id=$FILE_ID;

      UPDATE jobs
      SET state='cleaning',
          updated_at=CURRENT_TIMESTAMP
      WHERE torbox_id=$JOB_ID;
    "

    log "Radarr import verified"
fi

# CLEANUP
PRESENT="$(
    curl -fsS \
      -H "Authorization: Bearer $TORBOX_API_KEY" \
      "$TORBOX_API_URL/torrents/mylist?bypass_cache=true" |
    jq --argjson id "$JOB_ID" '
      any(.data[]?; .id == $id)
    '
)"

if [ "$PRESENT" = "true" ]; then
    curl -fsS \
      -H "Authorization: Bearer $TORBOX_API_KEY" \
      -H 'Content-Type: application/json' \
      -X POST \
      --data "{\"torrent_id\":$JOB_ID,\"operation\":\"delete\"}" \
      "$TORBOX_API_URL/torrents/controltorrent" |
      jq -e '.success == true' >/dev/null
fi

REMOVED=0

for _ in $(seq 1 20); do
    PRESENT="$(
        curl -fsS \
          -H "Authorization: Bearer $TORBOX_API_KEY" \
          "$TORBOX_API_URL/torrents/mylist?bypass_cache=true" |
        jq --argjson id "$JOB_ID" '
          any(.data[]?; .id == $id)
        '
    )"

    if [ "$PRESENT" = "false" ]; then
        REMOVED=1
        break
    fi

    sleep 2
done

[ "$REMOVED" -eq 1 ] || fail_job "TorBox deletion did not converge"

# rmdir deliberately refuses to delete anything unexpected.
rmdir "$STAGE" 2>/dev/null || true

sqlite3 "$DB" "
  UPDATE jobs
  SET state='done',
      last_error=NULL,
      updated_at=CURRENT_TIMESTAMP
  WHERE torbox_id=$JOB_ID;

  INSERT INTO events (torbox_id,event_type,message)
  VALUES (
    $JOB_ID,
    'completed',
    'Radarr import verified and TorBox source removed'
  );
"

log "DONE"

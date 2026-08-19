#!/bin/bash
set -euo pipefail

JOB_ID="${1:?usage: process-tv.sh TORBOX_ID}"

: "${TORBOX_API_KEY:?TORBOX_API_KEY required}"
: "${SONARR_API_KEY:?SONARR_API_KEY required}"
: "${SONARR_URL:?SONARR_URL required}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"
TORBOX_API_URL="${TORBOX_API_URL:-https://api.torbox.app/v1/api}"

STAGE="/downloads/.torbox-importer/$JOB_ID"

log() {
    printf '%s\n' "tv[$JOB_ID]: $*" >&2
}

sqlq() {
    printf '%s' "$1" | sed "s/'/''/g"
}

fail_job() {
    local msg="$1"
    local escaped

    escaped="$(sqlq "$msg")"

    sqlite3 "$DB" "
        UPDATE jobs
        SET state='failed',
            last_error='$escaped',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;

        UPDATE requests
        SET state='failed',
            torbox_id=$JOB_ID,
            last_error='$escaped',
            updated_at=CURRENT_TIMESTAMP
        WHERE state='processing'
          AND media_type='tv'
          AND scope='episode'
          AND provider IN ('torbox', 'auto')
          AND lower(info_hash) = (
              SELECT lower(info_hash)
              FROM jobs
              WHERE torbox_id=$JOB_ID
          );

        INSERT INTO events (
            torbox_id,
            event_type,
            message
        )
        VALUES (
            $JOB_ID,
            'failed',
            '$escaped'
        );
    "

    log "FAILED: $msg"
    exit 1
}

#
# Make sure this really is an inspected Sonarr TV job.
#
JOB_INFO="$(
    sqlite3 -separator '|' "$DB" "
        SELECT
            state,
            COALESCE(media_type, ''),
            COALESCE(arr_target, '')
        FROM jobs
        WHERE torbox_id=$JOB_ID;
    "
)"

[ -n "$JOB_INFO" ] || fail_job "Job does not exist"

JOB_STATE="$(printf '%s' "$JOB_INFO" | cut -d'|' -f1)"
MEDIA_TYPE="$(printf '%s' "$JOB_INFO" | cut -d'|' -f2)"
ARR_TARGET="$(printf '%s' "$JOB_INFO" | cut -d'|' -f3)"

[ "$MEDIA_TYPE" = "tv" ] ||
    fail_job "Job is not classified as TV"

[ "$ARR_TARGET" = "sonarr" ] ||
    fail_job "Job is not assigned to Sonarr"

case "$JOB_STATE" in
    inspected|downloading|downloaded|evaluating|importing|cleaning)
        ;;
    *)
        fail_job "Unexpected job state: $JOB_STATE"
        ;;
esac

#
# Get only files Sonarr's selector explicitly approved.
#
SELECTED="$(
    sqlite3 -json "$DB" "
        SELECT
            file_id,
            path,
            size,
            arr_match
        FROM files
        WHERE torbox_id=$JOB_ID
          AND selected=1
        ORDER BY file_id;
    "
)"

SELECTED_COUNT="$(printf '%s' "$SELECTED" | jq 'length')"

[ "$SELECTED_COUNT" -gt 0 ] ||
    fail_job "No selected TV files"

#
# Every selected file must point at the same Sonarr series.
#
SERIES_ID="$(
    printf '%s' "$SELECTED" |
    jq -r '
        [
            .[].arr_match
            | capture("^sonarr:(?<id>[0-9]+):").id
        ]
        | unique
        | if length == 1
          then .[0]
          else empty
          end
    '
)"

[ -n "$SERIES_ID" ] ||
    fail_job "Selected files do not resolve to one Sonarr series"

log "$SELECTED_COUNT selected file(s), Sonarr series $SERIES_ID"

#
# Protect against two torrent paths collapsing to the same basename.
#
DUPLICATE_NAMES="$(
    printf '%s' "$SELECTED" |
    jq -r '.[].path | split("/")[-1]' |
    sort |
    uniq -d
)"

if [ -n "$DUPLICATE_NAMES" ]; then
    fail_job "Selected files contain duplicate basenames"
fi

#
# If we're already in cleaning state, an earlier invocation completed import.
#
if [ "$JOB_STATE" != "cleaning" ]; then

    mkdir -p "$STAGE"

    sqlite3 "$DB" "
        UPDATE jobs
        SET state='downloading',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "

    #
    # Download each selected TorBox file independently.
    #
    while IFS= read -r ROW; do

        FILE_ID="$(printf '%s' "$ROW" | jq -r '.file_id')"
        TORBOX_PATH="$(printf '%s' "$ROW" | jq -r '.path')"
        EXPECTED_SIZE="$(printf '%s' "$ROW" | jq -r '.size')"

        NAME="${TORBOX_PATH##*/}"
        LOCAL_FILE="$STAGE/$NAME"

        log "file_id=$FILE_ID → $NAME"

        sqlite3 "$DB" "
            UPDATE files
            SET download_state='downloading',
                updated_at=CURRENT_TIMESTAMP
            WHERE torbox_id=$JOB_ID
              AND file_id=$FILE_ID;
        "

        ACTUAL_SIZE=0

        if [ -f "$LOCAL_FILE" ]; then
            ACTUAL_SIZE="$(stat -c '%s' "$LOCAL_FILE")"

            if [ "$ACTUAL_SIZE" -gt "$EXPECTED_SIZE" ]; then
                fail_job \
                    "Existing staged file is larger than expected: $NAME"
            fi
        fi

        #
        # Exact-size file already exists: don't redownload it.
        #
        if [ "$ACTUAL_SIZE" = "$EXPECTED_SIZE" ]; then

            log "already complete: $NAME"

        else

            DOWNLOAD_OK=0

            #
            # Outer retry requests a fresh CDN URL each time.
            #
            for ATTEMPT in 1 2 3; do

                log "download attempt $ATTEMPT: $NAME"

                DOWNLOAD_URL="$(
                    curl -fsS --get \
                        --data-urlencode "token=$TORBOX_API_KEY" \
                        --data-urlencode "torrent_id=$JOB_ID" \
                        --data-urlencode "file_id=$FILE_ID" \
                        --data-urlencode "redirect=false" \
                        "$TORBOX_API_URL/torrents/requestdl" |
                    jq -er '.data'
                )" || {
                    log "requestdl failed on attempt $ATTEMPT"
                    continue
                }

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
                        DOWNLOAD_OK=1
                        break
                    fi

                    log \
                        "size mismatch after attempt $ATTEMPT: expected=$EXPECTED_SIZE actual=$ACTUAL_SIZE"
                fi

                log "requesting fresh TorBox URL"
            done

            [ "$DOWNLOAD_OK" -eq 1 ] ||
                fail_job "Download failed or size verification failed: $NAME"
        fi

        sqlite3 "$DB" "
            UPDATE files
            SET download_state='completed',
                updated_at=CURRENT_TIMESTAMP
            WHERE torbox_id=$JOB_ID
              AND file_id=$FILE_ID;
        "

        log "verified: $NAME"

    done < <(
        printf '%s' "$SELECTED" |
        jq -c '.[]'
    )

    sqlite3 "$DB" "
        UPDATE jobs
        SET state='downloaded',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "

    log "all selected downloads verified"

    #
    # Ask Sonarr to evaluate the complete staging directory.
    #
    sqlite3 "$DB" "
        UPDATE jobs
        SET state='evaluating',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "

    CANDIDATES="$(
        curl -fsS \
            -H "X-Api-Key: $SONARR_API_KEY" \
            --get \
            --data-urlencode "folder=$STAGE" \
            --data-urlencode "filterExistingFiles=true" \
            "$SONARR_URL/api/v3/manualimport"
    )"

    #
    # Build the exact paths we downloaded.
    #
    EXPECTED_PATHS="$(
        printf '%s' "$SELECTED" |
        jq \
            --arg stage "$STAGE" '
            [
                .[]
                | (
                    $stage
                    + "/"
                    + (.path | split("/")[-1])
                )
            ]
        '
    )"

    #
    # Consider only candidates corresponding to files we explicitly selected.
    #
    MATCHED="$(
        printf '%s' "$CANDIDATES" |
        jq \
            --argjson paths "$EXPECTED_PATHS" '
            [
                .[]
                | select(
                    .path as $p
                    | ($paths | index($p)) != null
                )
            ]
        '
    )"

    MATCHED_COUNT="$(printf '%s' "$MATCHED" | jq 'length')"

    if [ "$MATCHED_COUNT" -ne "$SELECTED_COUNT" ]; then
        log "Sonarr returned $MATCHED_COUNT/$SELECTED_COUNT expected candidates"

        printf '%s\n' "$MATCHED" |
            jq '.[] | {path, rejections}' >&2

        fail_job \
            "Sonarr did not identify every selected staged file"
    fi

    #
    # Make sure Sonarr agrees all files belong to the expected series.
    #
    WRONG_SERIES="$(
        printf '%s' "$MATCHED" |
        jq \
            --argjson series "$SERIES_ID" '
            [
                .[]
                | select(.series.id != $series)
            ]
            | length
        '
    )"

    [ "$WRONG_SERIES" -eq 0 ] ||
        fail_job "Sonarr matched a staged file to the wrong series"

    #
    # Reject the entire operation if even one selected file is rejected.
    #
    REJECTED_COUNT="$(
        printf '%s' "$MATCHED" |
        jq '
            [
                .[]
                | select(
                    ((.rejections // []) | length) > 0
                )
            ]
            | length
        '
    )"

    if [ "$REJECTED_COUNT" -gt 0 ]; then

        log "Sonarr rejected selected file(s):"

        printf '%s' "$MATCHED" |
        jq -r '
            .[]
            | select(
                ((.rejections // []) | length) > 0
            )
            | .path as $path
            | (.rejections | map(.reason // tostring) | join("; ")) as $why
            | "  \($path): \($why)"
        ' >&2

        fail_job \
            "Sonarr rejected $REJECTED_COUNT selected file(s)"
    fi

    #
    # Remember exactly which episode IDs Sonarr says these files represent.
    #
    EXPECTED_EPISODE_IDS="$(
        printf '%s' "$MATCHED" |
        jq '
            [
                .[]
                | .episodes[]
                | .id
            ]
            | unique
        '
    )"

    EXPECTED_EPISODE_COUNT="$(
        printf '%s' "$EXPECTED_EPISODE_IDS" |
        jq 'length'
    )"

    [ "$EXPECTED_EPISODE_COUNT" -gt 0 ] ||
        fail_job "Sonarr returned no episode identities"

    #
    # Build one ManualImport command containing every acceptable selected file.
    #
    PAYLOAD="$(
        printf '%s' "$MATCHED" |
        jq '
            {
                name: "ManualImport",
                importMode: "move",

                files: [
                    .[]
                    | {
                        path: .path,
                        seriesId: .series.id,
                        episodeIds: [
                            .episodes[]
                            | .id
                        ],
                        quality: .quality,
                        languages: .languages,
                        releaseGroup: .releaseGroup,
                        indexerFlags: (.indexerFlags // 0)
                    }
                ]
            }
        '
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
            -H "X-Api-Key: $SONARR_API_KEY" \
            -H 'Content-Type: application/json' \
            -X POST \
            --data-binary @- \
            "$SONARR_URL/api/v3/command" |
        jq -er '.id'
    )" || fail_job "Failed to start Sonarr ManualImport"

    log "Sonarr ManualImport command $COMMAND_ID"

    IMPORT_OK=0

    #
    # Maximum ~2 minutes.
    #
    for _ in $(seq 1 60); do

        STATUS="$(
            curl -fsS \
                -H "X-Api-Key: $SONARR_API_KEY" \
                "$SONARR_URL/api/v3/command/$COMMAND_ID"
        )"

        COMMAND_STATE="$(
            printf '%s' "$STATUS" |
            jq -r '.status'
        )"

        case "$COMMAND_STATE" in
            completed)

                RESULT="$(
                    printf '%s' "$STATUS" |
                    jq -r '.result // ""'
                )"

                log "Sonarr command completed: $RESULT"

                IMPORT_OK=1
                break
                ;;

            failed)

                printf '%s\n' "$STATUS" |
                    jq '{status,result,message}' >&2

                break
                ;;
        esac

        sleep 2
    done

    [ "$IMPORT_OK" -eq 1 ] ||
        fail_job "Sonarr ManualImport failed or timed out"

    #
    # Don't trust only the command completion.
    # Re-query Sonarr's actual episode state.
    #
    AFTER="$(
        curl -fsS \
            -H "X-Api-Key: $SONARR_API_KEY" \
            "$SONARR_URL/api/v3/episode?seriesId=$SERIES_ID"
    )"

    FOUND_COUNT="$(
        printf '%s' "$AFTER" |
        jq \
            --argjson ids "$EXPECTED_EPISODE_IDS" '
            [
                .[]
                | select(
                    .id as $id
                    | ($ids | index($id)) != null
                )
            ]
            | length
        '
    )"

    [ "$FOUND_COUNT" -eq "$EXPECTED_EPISODE_COUNT" ] ||
        fail_job "Not all expected episodes exist in Sonarr after import"

    STILL_MISSING="$(
        printf '%s' "$AFTER" |
        jq \
            --argjson ids "$EXPECTED_EPISODE_IDS" '
            [
                .[]
                | select(
                    .id as $id
                    | ($ids | index($id)) != null
                )
                | select(.hasFile != true)
            ]
            | length
        '
    )"

    [ "$STILL_MISSING" -eq 0 ] ||
        fail_job "$STILL_MISSING expected episode(s) still have no file"

    log "Sonarr episode state verifies import"

    #
    # Since ManualImport used move mode, all downloaded media should be gone.
    # If something remains, fail closed rather than deleting it.
    #
    if find "$STAGE" \
        -mindepth 1 \
        -maxdepth 1 \
        -print -quit |
        grep -q .
    then
        log "unexpected staging contents remain:"

        find "$STAGE" \
            -mindepth 1 \
            -maxdepth 1 \
            -printf '  %f\n' >&2

        fail_job \
            "Staging directory is not empty after verified Sonarr import"
    fi

    sqlite3 "$DB" "
        UPDATE files
        SET imported=1,
            download_state='completed',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID
          AND selected=1;

        UPDATE jobs
        SET state='cleaning',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "

    log "all selected files imported"
fi


#
# Provider cleanup starts only after Sonarr verification, and only when
# this importer owns the provider resource.
#
OWNED_REQUESTS="$(
    sqlite3 "$DB" "
        SELECT COUNT(*)
        FROM requests
        WHERE state='processing'
          AND media_type='tv'
          AND scope='episode'
          AND provider IN ('torbox', 'auto')
          AND provider_created=1
          AND lower(info_hash)=(
              SELECT lower(info_hash)
              FROM jobs
              WHERE torbox_id=$JOB_ID
          );
    "
)"

EVENT_MESSAGE="Sonarr imports verified; TorBox source retained"

if [ "$OWNED_REQUESTS" -gt 0 ]; then

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
            "$TORBOX_API_URL/torrents/mylist?bypass_cache=true"
    )"

    PRESENT="$(
        printf '%s' "$LIST" |
        jq \
            --argjson id "$JOB_ID" '
            any(
                .data[]?;
                .id == $id
            )
        '
    )"

    if [ "$PRESENT" = "true" ]; then

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

        if [ -z "$PROVIDER_HASH" ] ||
           [ "$PROVIDER_HASH" != "$JOB_HASH" ]; then
            fail_job \
                "REFUSING TorBox cleanup: provider ID hash does not match job"
        fi

        log "deleting request-owned TorBox torrent"

        curl -fsS \
            -H "Authorization: Bearer $TORBOX_API_KEY" \
            -H 'Content-Type: application/json' \
            -X POST \
            --data \
                "{\"torrent_id\":$JOB_ID,\"operation\":\"delete\"}" \
            "$TORBOX_API_URL/torrents/controltorrent" |
        jq -e '.success == true' >/dev/null ||
            fail_job "TorBox delete request failed"

        #
        # TorBox can briefly return stale mylist data after accepting a delete.
        #
        REMOVED=0

        for _ in $(seq 1 20); do

            PRESENT="$(
                curl -fsS \
                    -H "Authorization: Bearer $TORBOX_API_KEY" \
                    "$TORBOX_API_URL/torrents/mylist?bypass_cache=true" |
                jq \
                    --argjson id "$JOB_ID" '
                    any(
                        .data[]?;
                        .id == $id
                    )
                '
            )"

            if [ "$PRESENT" = "false" ]; then
                REMOVED=1
                break
            fi

            sleep 2
        done

        [ "$REMOVED" -eq 1 ] ||
            fail_job "TorBox deletion did not converge"

        log "request-owned TorBox deletion confirmed"

    else
        log "request-owned TorBox torrent already absent"
    fi

    EVENT_MESSAGE="Sonarr imports verified and request-owned TorBox source removed"

else
    log "TorBox source not request-owned; retaining provider item"
fi

#
# Deliberately use rmdir, never rm -rf.
#
if [ -d "$STAGE" ]; then
    rmdir "$STAGE" ||
        fail_job "Could not remove supposedly empty staging directory"
fi

sqlite3 "$DB" "
    UPDATE jobs
    SET state='done',
        last_error=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE torbox_id=$JOB_ID;

    UPDATE requests
    SET state='done',
        torbox_id=$JOB_ID,
        last_error=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE state='processing'
      AND media_type='tv'
      AND scope='episode'
      AND provider IN ('torbox', 'auto')
      AND lower(info_hash)=(
          SELECT lower(info_hash)
          FROM jobs
          WHERE torbox_id=$JOB_ID
      );

    INSERT INTO events (
        torbox_id,
        event_type,
        message
    )
    VALUES (
        $JOB_ID,
        'completed',
        '$EVENT_MESSAGE'
    );
"
log "DONE"

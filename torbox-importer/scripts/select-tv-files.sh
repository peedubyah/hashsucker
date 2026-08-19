#!/bin/bash
set -euo pipefail

JOB_ID="${1:?usage: select-tv-files.sh TORBOX_ID}"

: "${SONARR_API_KEY:?SONARR_API_KEY required}"
: "${SONARR_URL:?SONARR_URL required}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

PARSED="$TMPDIR/parsed.jsonl"
RESULTS="$TMPDIR/results.jsonl"

log() {
    printf '%s\n' "select-tv[$JOB_ID]: $*" >&2
}

fail_ambiguous() {
    local msg="$1"
    local escaped

    escaped="$(printf '%s' "$msg" | sed "s/'/''/g")"

    sqlite3 "$DB" "
        UPDATE jobs
        SET state='awaiting_selection',
            last_error='$escaped',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "

    log "AMBIGUOUS: $msg"
    exit 0
}

#
# Make sure the job exists and don't allow this TV selector to mutate
# something already classified as a movie.
#

JOB_INFO="$(
    sqlite3 -separator '|' "$DB" "
        SELECT
            state,
            COALESCE(media_type, ''),
            lower(COALESCE(info_hash, ''))
        FROM jobs
        WHERE torbox_id=$JOB_ID;
    "
)"

if [ -z "$JOB_INFO" ]; then
    log "job does not exist"
    exit 1
fi

IFS='|' read -r JOB_STATE EXISTING_TYPE JOB_HASH <<< "$JOB_INFO"

if [ -n "$EXISTING_TYPE" ] && [ "$EXISTING_TYPE" != "tv" ]; then
    log "refusing to touch job already classified as '$EXISTING_TYPE'"
    exit 1
fi

#
# Explicit request intent, when present, overrides the old
# "download every missing episode represented by this torrent" behavior.
#
# Multiple episode requests may legitimately point at the same season pack,
# so aggregate all active requested S/E pairs for this info hash.
#
EXPLICIT_REQUEST=0
REQUESTED_PAIRS='[]'

if [ -n "$JOB_HASH" ]; then

    REQUEST_ROWS="$(
        sqlite3 -json "$DB" "
            SELECT
                request_id,
                season,
                episodes_json
            FROM requests
            WHERE lower(info_hash)=lower('$JOB_HASH')
              AND state='processing'
              AND media_type='tv'
              AND scope='episode'
            ORDER BY created_at;
        "
    )"

    REQUEST_COUNT="$(
        printf '%s' "$REQUEST_ROWS" |
        jq 'length'
    )"

    if [ "$REQUEST_COUNT" -gt 0 ]; then

        REQUESTED_PAIRS="$(
            printf '%s' "$REQUEST_ROWS" |
            jq -c '
                [
                    .[]
                    | .season as $season
                    | (.episodes_json | fromjson? // [])[]
                    | {
                        season: $season,
                        episode: .
                    }
                ]
                | unique_by([.season, .episode])
            '
        )"

        PAIR_COUNT="$(
            printf '%s' "$REQUESTED_PAIRS" |
            jq 'length'
        )"

        if [ "$PAIR_COUNT" -eq 0 ]; then
            fail_ambiguous \
                "Explicit request exists but contains no usable episode intent"
        fi

        EXPLICIT_REQUEST=1

        REQUEST_LABEL="$(
            printf '%s' "$REQUESTED_PAIRS" |
            jq -r '
                map(
                    "S"
                    + (.season | tostring)
                    + "E"
                    + (.episode | tostring)
                )
                | join(",")
            '
        )"

        log "explicit request intent: $REQUEST_LABEL"
    fi
fi

#
# Never infer human intent from Sonarr's missing-episode state.
#
# A TorBox TV item with no explicit request may be a single episode,
# season pack, or something added for unrelated reasons.
#
if [ "$EXPLICIT_REQUEST" -ne 1 ]; then

    sqlite3 "$DB" "
        UPDATE files
        SET selected=0,
            arr_rejection='explicit request intent required',
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID;
    "

    fail_ambiguous \
        "TV job has no explicit request intent"
fi

#
# Get usable video files from TorBox metadata already stored in SQLite.
# Ignore obvious samples.
#
FILES="$(
    sqlite3 -json "$DB" "
        SELECT file_id, path, size
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

COUNT="$(printf '%s' "$FILES" | jq 'length')"

if [ "$COUNT" -eq 0 ]; then
    fail_ambiguous "No usable video files"
fi

log "examining $COUNT video file(s)"

#
# Parse every TorBox filename through Sonarr.
#
# Important:
# We require an explicit episode-shaped token before trusting Sonarr's parser.
# This prevents things like Rogue.One.2016 from becoming nonsense S20E16.
#
while IFS= read -r ROW; do

    FILE_ID="$(printf '%s' "$ROW" | jq -r '.file_id')"
    PATHNAME="$(printf '%s' "$ROW" | jq -r '.path')"
    SIZE="$(printf '%s' "$ROW" | jq -r '.size')"

    NAME="${PATHNAME##*/}"

    if ! printf '%s\n' "$NAME" |
        grep -Eiq 'S[0-9]{1,2}E[0-9]{1,3}|[0-9]{1,2}x[0-9]{1,3}'
    then
        jq -nc \
            --argjson file_id "$FILE_ID" \
            --arg path "$PATHNAME" \
            --argjson size "$SIZE" \
            '{
                file_id: $file_id,
                path: $path,
                size: $size,
                ok: false,
                reason: "no explicit episode token"
            }' >> "$PARSED"

        continue
    fi

    if ! PARSE="$(
        curl -fsS \
            -H "X-Api-Key: $SONARR_API_KEY" \
            --get \
            --data-urlencode "title=$NAME" \
            "$SONARR_URL/api/v3/parse"
    )"; then
        fail_ambiguous "Sonarr parse API failed"
    fi

    SERIES="$(
        printf '%s' "$PARSE" |
        jq -r '.parsedEpisodeInfo.seriesTitle // empty'
    )"

    SEASON="$(
        printf '%s' "$PARSE" |
        jq -r '.parsedEpisodeInfo.seasonNumber // -1'
    )"

    EPISODES="$(
        printf '%s' "$PARSE" |
        jq -c '.parsedEpisodeInfo.episodeNumbers // []'
    )"

    if [ -z "$SERIES" ] ||
       [ "$SEASON" -lt 0 ] ||
       [ "$(printf '%s' "$EPISODES" | jq 'length')" -eq 0 ]
    then
        jq -nc \
            --argjson file_id "$FILE_ID" \
            --arg path "$PATHNAME" \
            --argjson size "$SIZE" \
            '{
                file_id: $file_id,
                path: $path,
                size: $size,
                ok: false,
                reason: "Sonarr could not identify episode"
            }' >> "$PARSED"

        continue
    fi

    jq -nc \
        --argjson file_id "$FILE_ID" \
        --arg path "$PATHNAME" \
        --argjson size "$SIZE" \
        --arg series "$SERIES" \
        --argjson season "$SEASON" \
        --argjson episodes "$EPISODES" \
        '{
            file_id: $file_id,
            path: $path,
            size: $size,
            ok: true,
            series: $series,
            season: $season,
            episodes: $episodes
        }' >> "$PARSED"

done < <(
    printf '%s' "$FILES" |
    jq -c '.[]'
)

#
# If any actual video file could not safely be understood as TV,
# stop the entire torrent. No partial action on ambiguous content.
#
BAD_COUNT="$(
    jq -s '
        [.[] | select(.ok == false)]
        | length
    ' "$PARSED"
)"

if [ "$BAD_COUNT" -gt 0 ]; then
    log "unrecognized video file(s):"

    jq -r '
        select(.ok == false)
        | "  \(.path): \(.reason)"
    ' "$PARSED" >&2

    fail_ambiguous "$BAD_COUNT video file(s) could not be safely identified"
fi

#
# With explicit intent, every requested episode must actually be represented
# somewhere in the torrent. Otherwise never silently convert "not found"
# into "already present".
#
if [ "$EXPLICIT_REQUEST" -eq 1 ]; then

    while IFS= read -r WANT; do

        WANT_SEASON="$(printf '%s' "$WANT" | jq -r '.season')"
        WANT_EPISODE="$(printf '%s' "$WANT" | jq -r '.episode')"

        if ! jq -e \
            --argjson season "$WANT_SEASON" \
            --argjson episode "$WANT_EPISODE" '
                select(
                    .ok == true
                    and .season == $season
                    and (.episodes | index($episode) != null)
                )
            ' "$PARSED" >/dev/null
        then
            fail_ambiguous \
                "Requested S${WANT_SEASON}E${WANT_EPISODE} is not represented in torrent"
        fi

    done < <(
        printf '%s' "$REQUESTED_PAIRS" |
        jq -c '.[]'
    )
fi

#
# Every parsed video file must belong to the same series.
#
SERIES_COUNT="$(
    jq -rs '
        [
            .[].series
            | ascii_downcase
            | gsub("[^a-z0-9]"; "")
        ]
        | unique
        | length
    ' "$PARSED"
)"

if [ "$SERIES_COUNT" -ne 1 ]; then
    fail_ambiguous "Torrent appears to contain multiple series"
fi

SERIES_TITLE="$(
    jq -rs '
        [
            .[]
            | select(.ok == true)
            | .series
        ][0] // empty
    ' "$PARSED"
)"

log "Sonarr parsed series: $SERIES_TITLE"

#
# Match the parsed name against an ACTUAL series already managed by Sonarr.
#
SONARR_SERIES="$(
    curl -fsS \
        -H "X-Api-Key: $SONARR_API_KEY" \
        "$SONARR_URL/api/v3/series"
)"

#
# Prefer the explicit request's external media identity over filename-derived
# series titles. Filename parsers may legally return names such as
# "Black Mirror 2011" while Sonarr stores title="Black Mirror", year=2011.
#
IFS='|' read -r REQUEST_MEDIA_ID_COUNT REQUEST_MEDIA_ID <<< "$(
    sqlite3 -separator '|' "$DB" "
        SELECT
            COUNT(DISTINCT lower(base_media_id)),
            COALESCE(MIN(lower(base_media_id)), '')
        FROM requests
        WHERE state='processing'
          AND media_type='tv'
          AND scope='episode'
          AND provider IN ('torbox', 'auto')
          AND lower(info_hash)=(
              SELECT lower(info_hash)
              FROM jobs
              WHERE torbox_id=$JOB_ID
          )
          AND base_media_id IS NOT NULL
          AND trim(base_media_id) <> '';
    "
)"

if [ "$REQUEST_MEDIA_ID_COUNT" -gt 1 ]; then
    fail_ambiguous \
        "Active requests disagree on series identity"
fi

if [ "$REQUEST_MEDIA_ID_COUNT" -eq 1 ] &&
   [[ "$REQUEST_MEDIA_ID" =~ ^tt[0-9]+$ ]]; then

    log "resolving Sonarr series by request IMDb ID: $REQUEST_MEDIA_ID"

    MATCHES="$(
        printf '%s' "$SONARR_SERIES" |
        jq \
            --arg imdb "$REQUEST_MEDIA_ID" '
            [
                .[]
                | select(
                    ((.imdbId // "") | ascii_downcase) == $imdb
                )
            ]
        '
    )"

else

    #
    # Fallback for request identities that do not provide a usable IMDb ID.
    #
    MATCHES="$(
        printf '%s' "$SONARR_SERIES" |
        jq \
            --arg title "$SERIES_TITLE" '
            def norm:
                ascii_downcase
                | gsub("[^a-z0-9]"; "");

            ($title | norm) as $needle |

            [
                .[]
                | select(
                    (.title | norm) == $needle
                    or
                    any(
                        .alternateTitles[]?;
                        (.title | norm) == $needle
                    )
                )
            ]
        '
    )"
fi

MATCH_COUNT="$(
    printf '%s' "$MATCHES" |
    jq 'length'
)"

if [ "$MATCH_COUNT" -ne 1 ]; then
    fail_ambiguous \
        "Series is not uniquely matched to an existing Sonarr series"
fi

SERIES_ID="$(
    printf '%s' "$MATCHES" |
    jq -r '.[0].id'
)"

CANONICAL_TITLE="$(
    printf '%s' "$MATCHES" |
    jq -r '.[0].title'
)"

log "matched Sonarr series $SERIES_ID: $CANONICAL_TITLE"

#
# THIS is the point at which TV classification is actually proven.
#
# Only now is it safe to clear/rebuild selection metadata.
#
sqlite3 "$DB" "
    UPDATE files
    SET selected=0,
        arr_match=NULL,
        arr_rejection=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE torbox_id=$JOB_ID;
"

#
# One Sonarr request gives us the entire episode state for this series.
#
EPISODE_STATE="$(
    curl -fsS \
        -H "X-Api-Key: $SONARR_API_KEY" \
        "$SONARR_URL/api/v3/episode?seriesId=$SERIES_ID"
)"

#
# Decide every TorBox video file independently.
#
while IFS= read -r ROW; do

    FILE_ID="$(printf '%s' "$ROW" | jq -r '.file_id')"
    PATHNAME="$(printf '%s' "$ROW" | jq -r '.path')"
    SEASON="$(printf '%s' "$ROW" | jq -r '.season')"
    EPISODES="$(printf '%s' "$ROW" | jq -c '.episodes')"

    #
    # Explicit request mode:
    #
    # A file with no requested episodes is ignored even if Sonarr says that
    # episode is missing.
    #
    # A physical multi-episode file mixing requested and unrequested episodes
    # is unsafe because importing it would import more than was requested.
    #
    if [ "$EXPLICIT_REQUEST" -eq 1 ]; then

        REQUESTED_IN_FILE=0
        UNREQUESTED_IN_FILE=0

        while IFS= read -r EP; do

            if printf '%s' "$REQUESTED_PAIRS" |
                jq -e \
                    --argjson season "$SEASON" \
                    --argjson episode "$EP" '
                        any(
                            .[];
                            .season == $season
                            and .episode == $episode
                        )
                    ' >/dev/null
            then
                REQUESTED_IN_FILE=$((REQUESTED_IN_FILE + 1))
            else
                UNREQUESTED_IN_FILE=$((UNREQUESTED_IN_FILE + 1))
            fi

        done < <(
            printf '%s' "$EPISODES" |
            jq -r '.[]'
        )

        if [ "$REQUESTED_IN_FILE" -eq 0 ]; then

            EP_LABEL="$(
                printf '%s' "$EPISODES" |
                jq -r \
                    --argjson season "$SEASON" '
                    map(
                        "S"
                        + ($season | tostring)
                        + "E"
                        + (. | tostring)
                    )
                    | join(",")
                '
            )"

            jq -nc \
                --argjson file_id "$FILE_ID" \
                --arg label "$EP_LABEL" \
                '{
                    file_id: $file_id,
                    selected: false,
                    label: $label,
                    ambiguous: false,
                    reason: "not requested"
                }' >> "$RESULTS"

            continue
        fi

        if [ "$UNREQUESTED_IN_FILE" -gt 0 ]; then

            EP_LABEL="$(
                printf '%s' "$EPISODES" |
                jq -r \
                    --argjson season "$SEASON" '
                    map(
                        "S"
                        + ($season | tostring)
                        + "E"
                        + (. | tostring)
                    )
                    | join(",")
                '
            )"

            jq -nc \
                --argjson file_id "$FILE_ID" \
                --arg label "$EP_LABEL" \
                '{
                    file_id: $file_id,
                    selected: false,
                    label: $label,
                    ambiguous: true,
                    reason: "physical file mixes requested and unrequested episodes"
                }' >> "$RESULTS"

            continue
        fi
    fi

    PRESENT=0
    MISSING=0
    UNKNOWN=0

    while IFS= read -r EP; do

        FOUND="$(
            printf '%s' "$EPISODE_STATE" |
            jq \
                --argjson season "$SEASON" \
                --argjson episode "$EP" '
                [
                    .[]
                    | select(
                        .seasonNumber == $season
                        and
                        .episodeNumber == $episode
                    )
                ][0] // empty
            '
        )"

        if [ -z "$FOUND" ]; then
            UNKNOWN=$((UNKNOWN + 1))
            continue
        fi

        HAS_FILE="$(
            printf '%s' "$FOUND" |
            jq -r '.hasFile'
        )"

        if [ "$HAS_FILE" = "true" ]; then
            PRESENT=$((PRESENT + 1))
        else
            MISSING=$((MISSING + 1))
        fi

    done < <(
        printf '%s' "$EPISODES" |
        jq -r '.[]'
    )

    EP_LABEL="$(
        printf '%s' "$EPISODES" |
        jq -r \
            --argjson season "$SEASON" '
            map(
                "S"
                + ($season | tostring)
                + "E"
                + (. | tostring)
            )
            | join(",")
        '
    )"

    if [ "$UNKNOWN" -gt 0 ]; then

        jq -nc \
            --argjson file_id "$FILE_ID" \
            --arg label "$EP_LABEL" \
            --arg reason "episode not found in Sonarr" \
            '{
                file_id: $file_id,
                selected: false,
                label: $label,
                ambiguous: true,
                reason: $reason
            }' >> "$RESULTS"

    elif [ "$MISSING" -gt 0 ] && [ "$PRESENT" -gt 0 ]; then

        #
        # A single physical file contains both episodes we already have
        # and episodes we do not have.
        #
        # Don't guess about replacement/import behavior.
        #
        jq -nc \
            --argjson file_id "$FILE_ID" \
            --arg label "$EP_LABEL" \
            --arg reason \
                "multi-episode file mixes present and missing episodes" \
            '{
                file_id: $file_id,
                selected: false,
                label: $label,
                ambiguous: true,
                reason: $reason
            }' >> "$RESULTS"

    elif [ "$MISSING" -gt 0 ]; then

        if [ "$EXPLICIT_REQUEST" -eq 1 ]; then
            REASON="requested and missing"
        else
            REASON="missing"
        fi

        jq -nc \
            --argjson file_id "$FILE_ID" \
            --arg label "$EP_LABEL" \
            --arg reason "$REASON" \
            '{
                file_id: $file_id,
                selected: true,
                label: $label,
                ambiguous: false,
                reason: $reason
            }' >> "$RESULTS"

    else

        if [ "$EXPLICIT_REQUEST" -eq 1 ]; then
            REASON="requested episode already present"
        else
            REASON="already present"
        fi

        jq -nc \
            --argjson file_id "$FILE_ID" \
            --arg label "$EP_LABEL" \
            --arg reason "$REASON" \
            '{
                file_id: $file_id,
                selected: false,
                label: $label,
                ambiguous: false,
                reason: $reason
            }' >> "$RESULTS"

    fi
done < <(
    jq -c '.' "$PARSED"
)

#
# Never partially act on an ambiguous torrent.
#
AMBIGUOUS="$(
    jq -s '
        [.[] | select(.ambiguous == true)]
        | length
    ' "$RESULTS"
)"

if [ "$AMBIGUOUS" -gt 0 ]; then

    log "ambiguous file(s):"

    jq -r '
        select(.ambiguous == true)
        | "  \(.label): \(.reason)"
    ' "$RESULTS" >&2

    fail_ambiguous \
        "$AMBIGUOUS episode file(s) need manual review"
fi

#
# Store Sonarr's decisions in SQLite.
#
while IFS= read -r RESULT; do

    FILE_ID="$(printf '%s' "$RESULT" | jq -r '.file_id')"
    SELECTED="$(printf '%s' "$RESULT" | jq -r '.selected')"
    LABEL="$(printf '%s' "$RESULT" | jq -r '.label')"
    REASON="$(printf '%s' "$RESULT" | jq -r '.reason')"

    if [ "$SELECTED" = "true" ]; then

        SEL=1
        REJECTION="NULL"

        log "SELECT $LABEL"

    else

        SEL=0

        ESC_REASON="$(
            printf '%s' "$REASON" |
            sed "s/'/''/g"
        )"

        REJECTION="'$ESC_REASON'"

        log "SKIP   $LABEL ($REASON)"
    fi

    ESC_MATCH="$(
        printf 'sonarr:%s:%s' "$SERIES_ID" "$LABEL" |
        sed "s/'/''/g"
    )"

    sqlite3 "$DB" "
        UPDATE files
        SET selected=$SEL,
            arr_match='$ESC_MATCH',
            arr_rejection=$REJECTION,
            updated_at=CURRENT_TIMESTAMP
        WHERE torbox_id=$JOB_ID
          AND file_id=$FILE_ID;
    "

done < <(
    jq -c '.' "$RESULTS"
)

SELECTED_COUNT="$(
    jq -s '
        [.[] | select(.selected == true)]
        | length
    ' "$RESULTS"
)"

#
# Nothing needs downloading.
#
if [ "$SELECTED_COUNT" -eq 0 ]; then

    if [ "$EXPLICIT_REQUEST" -eq 1 ]; then

        #
        # Explicit request was successfully resolved, but every requested
        # episode already exists in Sonarr.
        #
        # The job and every active episode request for this hash are terminal.
        #
        sqlite3 "$DB" "
            UPDATE jobs
            SET state='already_present',
                media_type='tv',
                arr_target='sonarr',
                last_error=NULL,
                updated_at=CURRENT_TIMESTAMP
            WHERE torbox_id=$JOB_ID;

            UPDATE requests
            SET state='already_present',
                torbox_id=$JOB_ID,
                last_error=NULL,
                updated_at=CURRENT_TIMESTAMP
            WHERE lower(info_hash)=lower('$JOB_HASH')
              AND state='processing'
              AND media_type='tv'
              AND scope='episode';

            INSERT INTO events (
                torbox_id,
                event_type,
                message
            )
            VALUES (
                $JOB_ID,
                'tv_request_already_present',
                'All explicitly requested episodes already exist in Sonarr'
            );
        "

        log "all requested episodes already present"

    else

        #
        # Legacy/non-request path retains the original behavior.
        #
        sqlite3 "$DB" "
            UPDATE jobs
            SET state='already_present',
                media_type='tv',
                arr_target='sonarr',
                last_error=NULL,
                updated_at=CURRENT_TIMESTAMP
            WHERE torbox_id=$JOB_ID;

            INSERT INTO events (
                torbox_id,
                event_type,
                message
            )
            VALUES (
                $JOB_ID,
                'tv_already_present',
                'All represented episodes already exist in Sonarr'
            );
        "

        log "all episodes already present"
    fi

    exit 0
fi

#
# At least one missing episode file has been selected.
#
sqlite3 "$DB" "
    UPDATE jobs
    SET state='inspected',
        media_type='tv',
        arr_target='sonarr',
        last_error=NULL,
        updated_at=CURRENT_TIMESTAMP
    WHERE torbox_id=$JOB_ID;

    INSERT INTO events (
        torbox_id,
        event_type,
        message
    )
    VALUES (
        $JOB_ID,
        'tv_selection',
        '$SELECTED_COUNT episode file(s) selected'
    );
"

log "$SELECTED_COUNT file(s) selected for download"

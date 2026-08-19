#!/usr/bin/env bash
set -euo pipefail

FILE="${1:?usage: ingest-request.sh REQUEST.json}"
DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

if [[ ! -f "$FILE" ]]; then
    echo "request file not found: $FILE" >&2
    exit 1
fi

/config/validate-request.sh "$FILE" >/dev/null

sqlq() {
    local value="$1"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

REQUEST_ID="$(jq -r '.requestId' "$FILE")"
CREATED_AT="$(jq -r '.createdAt' "$FILE")"
PROVIDER="$(jq -r '.provider' "$FILE")"

MEDIA_TYPE="$(jq -r '.intent.mediaType' "$FILE")"
SCOPE="$(jq -r '.intent.scope' "$FILE")"
MEDIA_ID="$(jq -r '.intent.mediaId' "$FILE")"
BASE_MEDIA_ID="$(jq -r '.intent.baseMediaId // ""' "$FILE")"

SEASON="$(jq -r '.intent.season // empty' "$FILE")"
EPISODES_JSON="$(jq -c '.intent.episodes // []' "$FILE")"

INFO_HASH="$(
    jq -r '.release.infoHash' "$FILE" |
    tr '[:upper:]' '[:lower:]'
)"

RELEASE_TITLE="$(jq -r '.release.title // ""' "$FILE")"
RELEASE_FILENAME="$(jq -r '.release.filename // ""' "$FILE")"
RELEASE_SIZE="$(jq -r '.release.size // empty' "$FILE")"

[[ -n "$SEASON" ]] && SEASON_SQL="$SEASON" || SEASON_SQL="NULL"
[[ -n "$RELEASE_SIZE" ]] && SIZE_SQL="$RELEASE_SIZE" || SIZE_SQL="NULL"

sqlite3 "$DB" "
INSERT INTO requests (
    request_id,
    created_at,
    provider,
    media_type,
    scope,
    media_id,
    base_media_id,
    season,
    episodes_json,
    info_hash,
    release_title,
    release_filename,
    release_size,
    state,
    source_path,
    updated_at
)
VALUES (
    $(sqlq "$REQUEST_ID"),
    $(sqlq "$CREATED_AT"),
    $(sqlq "$PROVIDER"),
    $(sqlq "$MEDIA_TYPE"),
    $(sqlq "$SCOPE"),
    $(sqlq "$MEDIA_ID"),
    $(sqlq "$BASE_MEDIA_ID"),
    $SEASON_SQL,
    $(sqlq "$EPISODES_JSON"),
    $(sqlq "$INFO_HASH"),
    $(sqlq "$RELEASE_TITLE"),
    $(sqlq "$RELEASE_FILENAME"),
    $SIZE_SQL,
    'processing',
    $(sqlq "$FILE"),
    CURRENT_TIMESTAMP
)
ON CONFLICT(request_id) DO UPDATE SET
    source_path=excluded.source_path,
    updated_at=CURRENT_TIMESTAMP
WHERE requests.created_at       = excluded.created_at
  AND requests.provider         = excluded.provider
  AND requests.media_type       = excluded.media_type
  AND requests.scope            = excluded.scope
  AND requests.media_id         = excluded.media_id
  AND COALESCE(requests.base_media_id, '')
      = COALESCE(excluded.base_media_id, '')
  AND COALESCE(requests.season, -1)
      = COALESCE(excluded.season, -1)
  AND requests.episodes_json    = excluded.episodes_json
  AND lower(requests.info_hash) = lower(excluded.info_hash);
"

STORED="$(
    sqlite3 -separator '|' "$DB" "
        SELECT
            created_at,
            provider,
            media_type,
            scope,
            media_id,
            COALESCE(base_media_id, ''),
            COALESCE(season, -1),
            episodes_json,
            lower(info_hash)
        FROM requests
        WHERE request_id=$(sqlq "$REQUEST_ID");
    "
)"

EXPECTED="$(
    printf '%s|%s|%s|%s|%s|%s|%s|%s|%s' \
        "$CREATED_AT" \
        "$PROVIDER" \
        "$MEDIA_TYPE" \
        "$SCOPE" \
        "$MEDIA_ID" \
        "$BASE_MEDIA_ID" \
        "${SEASON:--1}" \
        "$EPISODES_JSON" \
        "$INFO_HASH"
)"

if [[ "$STORED" != "$EXPECTED" ]]; then
    echo "requestId collision with different immutable payload: $REQUEST_ID" >&2
    exit 1
fi

printf 'INGESTED: %s\n' "$REQUEST_ID"

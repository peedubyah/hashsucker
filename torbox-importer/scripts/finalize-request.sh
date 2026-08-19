#!/usr/bin/env bash
set -euo pipefail

FILE="${1:?usage: finalize-request.sh REQUEST.json}"

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"
REQUEST_ROOT="${REQUEST_ROOT:-/requests}"

DONE_DIR="$REQUEST_ROOT/done"
FAILED_DIR="$REQUEST_ROOT/failed"

if [[ ! -f "$FILE" ]]; then
    echo "request file not found: $FILE" >&2
    exit 1
fi

/config/validate-request.sh "$FILE" >/dev/null

REQUEST_ID="$(jq -r '.requestId' "$FILE")"

sqlq() {
    local value="$1"
    value="${value//\'/\'\'}"
    printf "'%s'" "$value"
}

STATE="$(
    sqlite3 "$DB" "
        SELECT state
        FROM requests
        WHERE request_id=$(sqlq "$REQUEST_ID");
    "
)"

if [[ -z "$STATE" ]]; then
    echo "request not found in database: $REQUEST_ID" >&2
    exit 1
fi

case "$STATE" in
    done|already_present)
        TARGET_DIR="$DONE_DIR"
        ;;
    failed)
        TARGET_DIR="$FAILED_DIR"
        ;;
    processing)
        echo "request is not terminal: $REQUEST_ID ($STATE)" >&2
        exit 3
        ;;
    *)
        echo "refusing unknown request state: $REQUEST_ID ($STATE)" >&2
        exit 1
        ;;
esac

mkdir -p "$TARGET_DIR"

BASENAME="$(basename "$FILE")"
DEST="$TARGET_DIR/$BASENAME"

if [[ -e "$DEST" ]]; then
    echo "destination already exists: $DEST" >&2
    exit 1
fi

mv "$FILE" "$DEST"

sqlite3 "$DB" "
    UPDATE requests
    SET source_path=$(sqlq "$DEST"),
        updated_at=CURRENT_TIMESTAMP
    WHERE request_id=$(sqlq "$REQUEST_ID");
"

printf 'FINALIZED: %s -> %s\n' "$REQUEST_ID" "$DEST"

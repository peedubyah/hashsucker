#!/bin/sh
set -eu

#
# strm-writer.sh - Plex-compatible .strm materializer
#
# Writes a Plex-compatible .strm artifact containing a durable playback URL.
# This module is intentionally provider-agnostic: it receives a fully-resolved
# durable URL and does not know about TorBox, ranking, or Plex internals.
#
# Usage: strm-writer.sh TITLE YEAR MEDIA_TYPE PLAYBACK_URL OUTPUT_ROOT
#
# Inputs:
#   TITLE        - Media title (e.g., "Batman")
#   YEAR         - Release year (e.g., "1989")
#   MEDIA_TYPE   - "movie" or "tv"
#   PLAYBACK_URL - Durable redirect/permalink URL for playback
#   OUTPUT_ROOT  - Base directory for .strm output (e.g., /strm)
#
# Output structure:
#   $OUTPUT_ROOT/Movies/
#     Batman (1989)/
#       Batman (1989).strm
#   $OUTPUT_ROOT/TV Shows/
#     Show Title (2020)/
#       Season 01/
#         Show Title (2020) - S01E01.strm
#

TITLE="${1:?usage: strm-writer.sh TITLE YEAR MEDIA_TYPE PLAYBACK_URL OUTPUT_ROOT}"
YEAR="${2:?usage: strm-writer.sh TITLE YEAR MEDIA_TYPE PLAYBACK_URL OUTPUT_ROOT}"
MEDIA_TYPE="${3:?usage: strm-writer.sh TITLE YEAR MEDIA_TYPE PLAYBACK_URL OUTPUT_ROOT}"
PLAYBACK_URL="${4:?usage: strm-writer.sh TITLE YEAR MEDIA_TYPE PLAYBACK_URL OUTPUT_ROOT}"
OUTPUT_ROOT="${5:?usage: strm-writer.sh TITLE YEAR MEDIA_TYPE PLAYBACK_URL OUTPUT_ROOT}"

log() {
    printf '%s\n' "strm-writer: $*" >&2
}

# Sanitize title for filesystem use: replace path-unsafe characters.
sanitize() {
    printf '%s' "$1" | sed 's|/|_|g; s|:|_|g; s|?|_|g; s|"|_|g; s|\*|_|g; s|<|_|g; s|>|_|g'
}

SAFE_TITLE="$(sanitize "$TITLE")"
YEAR_PART=""
[ -n "$YEAR" ] && YEAR_PART=" ($YEAR)"

case "$MEDIA_TYPE" in
    movie)
        MEDIA_DIR="Movies"
        FILENAME="${SAFE_TITLE}${YEAR_PART}.strm"
        ;;
    tv)
        MEDIA_DIR="TV Shows"
        FILENAME="${SAFE_TITLE}${YEAR_PART}.strm"
        ;;
    *)
        log "unsupported media type: $MEDIA_TYPE"
        exit 1
        ;;
esac

DEST_DIR="$OUTPUT_ROOT/$MEDIA_DIR/${SAFE_TITLE}${YEAR_PART}"
DEST_FILE="$DEST_DIR/$FILENAME"

# Fail closed: if the file already exists, do not overwrite.
if [ -e "$DEST_FILE" ]; then
    log "strm artifact already exists: $DEST_FILE"
    exit 1
fi

mkdir -p "$DEST_DIR"

# Atomic write: write to temp file, then move into place.
TMP="$(mktemp "$DEST_FILE.XXXXXX")"
trap 'rm -f "$TMP"' EXIT HUP INT TERM

printf '%s\n' "$PLAYBACK_URL" > "$TMP"
mv "$TMP" "$DEST_FILE"

log "strm artifact created: $DEST_FILE"
printf '%s\n' "$DEST_FILE"

#!/usr/bin/env bash
set -euo pipefail

incoming="/requests/incoming"
processing="/requests/processing"
failed="/requests/failed"

mkdir -p "$incoming" "$processing" "$failed"

log() {
    printf '%s\n' "claim-request: $*" >&2
}

for src in "$incoming"/*.json; do
    [[ -e "$src" ]] || exit 3

    name="$(basename "$src")"
    dst="$processing/$name"

    if ! mv -n "$src" "$dst" 2>/dev/null; then
        continue
    fi

    # mv -n can succeed without moving if destination already exists.
    [[ ! -e "$src" ]] || continue

    log "claimed $dst"

    if /config/validate-request.sh "$dst" >&2; then
        printf '%s\n' "$dst"
        exit 0
    fi

    log "invalid request; moving to failed"
    mv "$dst" "$failed/$name"
    exit 1
done

exit 3

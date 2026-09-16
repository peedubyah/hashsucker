#!/bin/sh
# torbox-importer entrypoint (deployment-sanity tranche): same ownership
# contract as media-search. Fresh `docker compose up` lets Docker
# auto-create bind sources as root:root, but the worker runs as
# PUID:PGID (Unraid default 99:100), so first boot crash-loops on
# `mkdir: cannot create directory '/config/state': Permission denied`.
# This entrypoint repairs ownership ONLY where the runtime user cannot
# already write, then drops privileges and execs the worker. No-op on
# correctly-owned trees (production behavior unchanged).
#
# /requests and /strm are SHARED with media-search: repair grants the
# share group rwx without touching the owner (never flaps between the
# two writers' private UIDs). Private dirs (/config, /downloads) repair
# owner-only.
set -eu

RUNTIME_USER="${PUID:-99}"
RUNTIME_GROUP="${PGID:-100}"
SHARE_GROUP="${MEDIA_SEARCH_QUEUE_GID:-100}"

repair_private() {
    DIR="$1"
    if [ -e "$DIR" ] || mkdir -p "$DIR" 2>/dev/null; then
        if ! su-exec "$RUNTIME_USER:$SHARE_GROUP" test -w "$DIR" 2>/dev/null; then
            chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$DIR" 2>/dev/null || true
        fi
    fi
}

repair_shared() {
    DIR="$1"
    if [ -e "$DIR" ] || mkdir -p "$DIR" 2>/dev/null; then
        if ! su-exec "$RUNTIME_USER:$SHARE_GROUP" test -w "$DIR" 2>/dev/null; then
            chgrp -R "$SHARE_GROUP" "$DIR" 2>/dev/null || true
            chmod -R g+rwx "$DIR" 2>/dev/null || true
        fi
    fi
}

for DIR in /config /downloads; do
    repair_private "$DIR"
done
for DIR in /requests /strm; do
    repair_shared "$DIR"
done

exec su-exec "$RUNTIME_USER:$SHARE_GROUP" "$@"

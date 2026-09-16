#!/bin/sh
# media-search entrypoint (packaging tranche): make host bind mounts
# writable for the non-root runtime user without requiring the operator
# to pre-chown anything.
#
# Fresh `docker compose up` lets Docker auto-create bind sources as
# root:root. The image runs as node:node, so first boot would crash-loop
# on `unable to open database file` (and Unraid appdata owned by
# nobody:users would fail the same way). This entrypoint repairs
# ownership ONLY where the runtime user cannot already write, then drops
# privileges and execs the server. No-op on correctly-owned trees
# (production behavior unchanged: zero chown calls when writable).
set -eu

RUNTIME_USER="node"
RUNTIME_GROUP="node"
# Group that mediates the queue/STRM shares with the torbox-importer
# (Unraid users group; mirrors compose MEDIA_SEARCH_QUEUE_GID).
SHARE_GROUP="${MEDIA_SEARCH_QUEUE_GID:-100}"

repair_private() {
    DIR="$1"
    if [ -e "$DIR" ] || mkdir -p "$DIR" 2>/dev/null; then
        if ! su-exec "$RUNTIME_USER:$SHARE_GROUP" test -w "$DIR" 2>/dev/null; then
            chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$DIR" 2>/dev/null || true
        fi
    fi
}

# Shared dirs converge on group mediation only (never chown the owner —
# two writers must never fight over it): when the runtime user cannot
# write, grant the share group rwx recursively. The importer does the
# same, so repair converges regardless of boot order: media-search
# reaches the dirs via its group_add membership, the importer via its
# primary group.
repair_shared() {
    DIR="$1"
    if [ -e "$DIR" ] || mkdir -p "$DIR" 2>/dev/null; then
        if ! su-exec "$RUNTIME_USER:$SHARE_GROUP" test -w "$DIR" 2>/dev/null; then
            chgrp -R "$SHARE_GROUP" "$DIR" 2>/dev/null || true
            chmod -R g+rwx "$DIR" 2>/dev/null || true
        fi
    fi
}

for DIR in /data /download /permanent; do
    repair_private "$DIR"
done
for DIR in /requests /strm; do
    repair_shared "$DIR"
done

# Queue transport shape: the importer + readiness expect the four queue
# subdirectories to exist. They are created lazily at runtime otherwise,
# which leaves /health/ready unhealthy on a fresh install until the
# first request settles. Ensuring them here makes readiness honest from
# first boot; the shared group repair above keeps them writable (it runs
# before this block only for pre-existing paths, so re-verify below —
# repair_shared is idempotent and order-free).
for SUB in incoming processing done failed; do
    mkdir -p "/requests/$SUB" 2>/dev/null || true
done
for P in /requests /requests/incoming /requests/processing /requests/done /requests/failed /strm; do
    if [ -e "$P" ] || mkdir -p "$P" 2>/dev/null; then
        if ! su-exec "$RUNTIME_USER:$SHARE_GROUP" test -w "$P" 2>/dev/null; then
            chgrp -R "$SHARE_GROUP" "$P" 2>/dev/null || true
            chmod -R g+rwx "$P" 2>/dev/null || true
        fi
    fi
done

exec su-exec "$RUNTIME_USER:$SHARE_GROUP" "$@"

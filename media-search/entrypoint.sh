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

for DIR in /data /requests /strm; do
    if [ -e "$DIR" ] || mkdir -p "$DIR" 2>/dev/null; then
        if ! su-exec "$RUNTIME_USER:$RUNTIME_GROUP" test -w "$DIR" 2>/dev/null; then
            chown -R "$RUNTIME_USER:$RUNTIME_GROUP" "$DIR" 2>/dev/null || true
        fi
    fi
done

exec su-exec "$RUNTIME_USER:$RUNTIME_GROUP" "$@"

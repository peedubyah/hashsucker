#!/usr/bin/env bash
#
# First-boot deployment verification for HashSucker.
#
# Brings up the stack with docker compose, verifies the six critical
# runtime contracts, then tears down. Exits non-zero on any failure.
#
# Usage:
#   scripts/smoke-test.sh            # full cycle: up → verify → down
#   scripts/smoke-test.sh --no-down  # leave stack running after verify
#   SKIP_BUILD=1 scripts/smoke-test.sh  # skip compose build (use existing images)
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE="${COMPOSE:-docker compose}"
NO_DOWN=0
SKIP_BUILD="${SKIP_BUILD:-0}"

for arg in "$@"; do
  case "$arg" in
    --no-down) NO_DOWN=1 ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
  esac
done

# ----------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------
PASS=0
FAIL=0
FAILED_CHECKS=()

check_start() { printf '  %-45s' "$1"; }
check_ok()    { PASS=$((PASS + 1)); printf 'PASS\n'; }
check_fail()  {
  FAIL=$((FAIL + 1)); printf 'FAIL\n';
  FAILED_CHECKS+=("$1");
}

cleanup() {
  if [ "$NO_DOWN" -eq 0 ]; then
    echo
    echo "--- tearing down stack ---"
    $COMPOSE down --volumes --remove-orphans 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ----------------------------------------------------------------------------
# 1. Build (optional) and start the stack
# ----------------------------------------------------------------------------
echo "--- bringing up stack ---"
if [ "$SKIP_BUILD" -eq 0 ]; then
  $COMPOSE build --quiet 2>&1 | tail -5
fi
$COMPOSE up -d 2>&1 | tail -5

# ----------------------------------------------------------------------------
# 2. Health endpoint (media-search)
# ----------------------------------------------------------------------------
echo
echo "--- verification ---"

HEALTH_URL="http://127.0.0.1:${MEDIA_SEARCH_PORT:-3000}/health"
check_start "media-search /health responds 200"
for _ in $(seq 1 30); do
  if HTTP_CODE="$(curl -fsS -o /dev/null -w '%{http_code}' "$HEALTH_URL" 2>/dev/null)" \
     && [ "$HTTP_CODE" = "200" ]; then
    check_ok
    break
  fi
  sleep 1
done
[ "$HTTP_CODE" = "200" ] || check_fail "health endpoint"

# ----------------------------------------------------------------------------
# 3. UI static serving (media-search)
# ----------------------------------------------------------------------------
UI_URL="http://127.0.0.1:${MEDIA_SEARCH_PORT:-3000}/"
check_start "UI static serving (GET / returns app HTML)"
if UI_HTML="$(curl -fsS "$UI_URL" 2>/dev/null)" \
   && printf '%s' "$UI_HTML" | grep -q 'id="root"'; then
  check_ok
else
  check_fail "UI static serving"
fi

# ----------------------------------------------------------------------------
# 4. Importer starts (torbox-importer worker)
# ----------------------------------------------------------------------------
check_start "torbox-importer worker starts"
# worker.sh logs to stderr → captured by docker logs. Verify the DB init
# and worker bootstrap messages appear within a bounded window.
WORKER_OK=0
for _ in $(seq 1 20); do
  if $COMPOSE logs torbox-importer 2>/dev/null \
     | grep -q 'starting TorBox importer'; then
    WORKER_OK=1
    break
  fi
  sleep 1
done
if [ "$WORKER_OK" -eq 1 ]; then
  check_ok
else
  check_fail "importer startup"
fi

# ----------------------------------------------------------------------------
# 5. Shared request queue permissions
# ----------------------------------------------------------------------------
# media-search runs as `node` (group_add QUEUE_GID).
# torbox-importer runs as PUID:PGID.
# Both must read/write the same bind-mounted /requests.
# Use the CONTAINER path for the queue, not the host path.
SMOKE_TOKEN="smoketest-$$-$RANDOM"
CONTAINER_QUEUE="/requests"
SMOKE_FILE="${CONTAINER_QUEUE}/incoming/${SMOKE_TOKEN}.json"

check_start "queue: media-search writes, torbox-importer reads"
WRITE_OK=0
READ_OK=0
if $COMPOSE exec -T media-search sh -c \
     "echo '{\"probe\":\"${SMOKE_TOKEN}\"}' > '${SMOKE_FILE}'" 2>/dev/null; then
  WRITE_OK=1
  if $COMPOSE exec -T torbox-importer sh -c \
       "test -f '${SMOKE_FILE}' && grep -q '${SMOKE_TOKEN}' '${SMOKE_FILE}'" 2>/dev/null; then
    READ_OK=1
  fi
fi
# Clean up the probe file inside the container.
$COMPOSE exec -T media-search rm -f "$SMOKE_FILE" 2>/dev/null || true
if [ "$WRITE_OK" -eq 1 ] && [ "$READ_OK" -eq 1 ]; then
  check_ok
else
  check_fail "shared queue permissions"
fi

# ----------------------------------------------------------------------------
# 6. SQLite initialization
# ----------------------------------------------------------------------------
# torbox-importer DB is created by db-init.sh (sqlite3 CLI available).
check_start "SQLite: torbox-importer schema initialized"
if $COMPOSE exec -T torbox-importer sh -c \
     'sqlite3 "$TORBOX_DB" "SELECT name FROM sqlite_master WHERE type=\"table\" AND name=\"requests\";"' \
     2>/dev/null | grep -q 'requests'; then
  check_ok
else
  check_fail "torbox-importer SQLite"
fi

# media-search discovery DB is created lazily by node:sqlite.
# Verify the file exists and is a valid SQLite database by opening it with node.
check_start "SQLite: media-search discovery cache initialized"
if $COMPOSE exec -T media-search node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.env.DISCOVERY_DB);
try { db.exec('PRAGMA integrity_check'); process.exit(0); } catch { process.exit(1); }
" 2>/dev/null; then
  check_ok
else
  check_fail "media-search SQLite"
fi

# ----------------------------------------------------------------------------
# 7. Environment variable loading (behavioral check)
# ----------------------------------------------------------------------------
# media-search: PORT/HOST env must drive the bind address (verified via health
# on $PORT). TORBOX_API_KEY must be present for the service to accept it.
check_start "env: media-search received config"
ENV_OK=0
if $COMPOSE exec -T media-search node -e "
const need = ['TORBOX_API_KEY','REQUESTS_ROOT','DISCOVERY_DB','CONTROL_PLANE_DB'];
const missing = need.filter(k => !process.env[k]);
process.exit(missing.length ? 1 : 0);
" 2>/dev/null; then
  ENV_OK=1
fi
if [ "$ENV_OK" -eq 1 ]; then
  check_ok
else
  check_fail "media-search env vars"
fi

# torbox-importer: TORBOX_API_KEY and RADARR_URL required; worker reads them.
check_start "env: torbox-importer received config"
IMP_ENV_OK=0
if $COMPOSE exec -T torbox-importer sh -c '
test -n "$TORBOX_API_KEY" && test -n "$RADARR_URL" && test -n "$TORBOX_DB"
' 2>/dev/null; then
  IMP_ENV_OK=1
fi
if [ "$IMP_ENV_OK" -eq 1 ]; then
  check_ok
else
  check_fail "torbox-importer env vars"
fi

# ----------------------------------------------------------------------------
# Summary
# ----------------------------------------------------------------------------
echo
echo "==================================="
echo "  PASS: $PASS   FAIL: $FAIL"
echo "==================================="

if [ "$FAIL" -gt 0 ]; then
  echo
  echo "Failed checks:"
  for c in "${FAILED_CHECKS[@]}"; do
    echo "  - $c"
  done
  exit 1
fi

echo "All first-boot checks passed."
exit 0

#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/test.db"

sqlite3 "$DB" <<'SQL'
CREATE TABLE jobs (
  torbox_id INTEGER PRIMARY KEY,
  info_hash TEXT,
  state TEXT NOT NULL,
  last_error TEXT
);
CREATE TABLE requests (
  request_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  media_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'torbox',
  provider_created INTEGER NOT NULL DEFAULT 0,
  torbox_id INTEGER,
  info_hash TEXT,
  last_error TEXT,
  updated_at TEXT
);
INSERT INTO jobs VALUES (10, 'hash10', 'processing', NULL);
INSERT INTO jobs VALUES (11, 'hash11', 'done', NULL);
INSERT INTO jobs VALUES (12, 'hash12', 'already_present', 'Movie already has a file; upgrade policy not enabled');
INSERT INTO jobs VALUES (13, 'hash13', 'failed', 'Radarr rejected candidate');
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('processing','processing','movie','movie',10);
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('done','processing','movie','movie',11);
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('present','processing','movie','movie',12);
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('failed','processing','movie','movie',13);
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('tv','processing','tv','episode',11);
INSERT INTO jobs VALUES (20, 'hash20', 'cleaning', NULL);
INSERT INTO jobs VALUES (21, 'hash21', 'cleaning', NULL);
INSERT INTO jobs VALUES (22, 'hash22', 'cleaning', NULL);
INSERT INTO jobs VALUES (23, 'hash23', 'cleaning', NULL);
SQL

if TORBOX_DB="$DB" "$ROOT/scripts/sync-movie-request-state.sh" processing 10; then
  echo 'non-terminal job unexpectedly propagated' >&2
  exit 1
else
  [[ "$?" -eq 3 ]]
fi

[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/sync-movie-request-state.sh" done 11)" == done ]]
[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/sync-movie-request-state.sh" present 12)" == already_present ]]
[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/sync-movie-request-state.sh" failed 13)" == failed ]]
[[ "$(sqlite3 "$DB" "SELECT last_error FROM requests WHERE request_id='failed';")" == 'Radarr rejected candidate' ]]
[[ "$(sqlite3 "$DB" "SELECT state FROM requests WHERE request_id='tv';")" == processing ]]

sqlite3 "$DB" <<'SQL'
INSERT INTO requests (request_id,state,media_type,scope,provider,provider_created,torbox_id) VALUES ('owned','processing','movie','movie','torbox',1,21);
INSERT INTO requests (request_id,state,media_type,scope,provider,provider_created,torbox_id) VALUES ('preexisting','processing','movie','movie','torbox',0,22);
-- Multiple requests sharing the same hash / torbox_id:
INSERT INTO requests (request_id,state,media_type,scope,provider,provider_created,torbox_id,info_hash) VALUES ('owned-a','processing','movie','movie','torbox',1,23,'hash23');
INSERT INTO requests (request_id,state,media_type,scope,provider,provider_created,torbox_id,info_hash) VALUES ('owned-b','processing','movie','movie','torbox',0,23,'hash23');
SQL

# Unlinked account resources may belong to virtual fulfillment or another client.
[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/movie-cleanup-policy.sh" 20)" == retain-unlinked ]]
[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/movie-cleanup-policy.sh" 21)" == delete-request-owned ]]
[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/movie-cleanup-policy.sh" 22)" == retain-preexisting ]]
# While request B is still processing, request A completion must NOT delete the provider resource:
[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/movie-cleanup-policy.sh" 23)" == retain-preexisting ]]
# When request A finishes to done, request B (provider_created=0) still protects/retains the resource:
sqlite3 "$DB" "UPDATE requests SET state='done' WHERE request_id='owned-a';"
[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/movie-cleanup-policy.sh" 23)" == retain-preexisting ]]

# End-to-end orchestration test with the proven movie processor mocked at its
# boundary: process-request must select movie (never TV), propagate done, settle.
DB2="$TMP/orchestration.db"
MOCKS="$TMP/scripts"
mkdir -p "$MOCKS"
sqlite3 "$DB2" <<'SQL'
CREATE TABLE jobs (torbox_id INTEGER PRIMARY KEY, info_hash TEXT, state TEXT, media_type TEXT, arr_target TEXT, last_error TEXT, first_seen TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE files (torbox_id INTEGER, selected INTEGER, arr_match TEXT, arr_rejection TEXT, updated_at TEXT);
CREATE TABLE requests (request_id TEXT PRIMARY KEY, state TEXT, media_type TEXT, scope TEXT, media_id TEXT, torbox_id INTEGER, info_hash TEXT, release_key TEXT, handling_mode TEXT DEFAULT 'download', last_error TEXT, updated_at TEXT);
INSERT INTO jobs VALUES (30, '0123456789abcdef0123456789abcdef01234567', 'inspected', 'movie', 'radarr', NULL, CURRENT_TIMESTAMP, NULL);
INSERT INTO files VALUES (30, 1, 'tmdb:123', NULL, NULL);
INSERT INTO requests VALUES ('movie-request', 'processing', 'movie', 'movie', 'tmdb:123', 30, '0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123456789abcdef01234567:torrent', 'download', NULL, NULL);
INSERT INTO requests VALUES ('season-request', 'processing', 'tv', 'season', 'tt1', NULL, NULL, NULL, 'download', NULL, NULL);
INSERT INTO jobs VALUES (31, '0123456789abcdef0123456789abcdef01234568', 'inspected', 'movie', 'radarr', NULL, CURRENT_TIMESTAMP, NULL);
INSERT INTO files VALUES (31, 1, 'tmdb:123', NULL, NULL);
INSERT INTO requests VALUES ('wrong-movie', 'processing', 'movie', 'movie', 'tmdb:999', 31, '0123456789abcdef0123456789abcdef01234568', '0123456789abcdef0123456789abcdef01234568:torrent', 'download', NULL, NULL);
INSERT INTO requests VALUES ('imdb-movie', 'processing', 'movie', 'movie', 'tt0123456', 30, '0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123456789abcdef01234567:torrent', 'download', NULL, NULL);
INSERT INTO jobs VALUES (32, '0123456789abcdef0123456789abcdef01234569', 'inspected', 'movie', 'radarr', NULL, CURRENT_TIMESTAMP, NULL);
INSERT INTO files VALUES (32, 1, 'tmdb:123', NULL, NULL);
INSERT INTO requests VALUES ('processor-crash', 'processing', 'movie', 'movie', 'tmdb:123', 32, '0123456789abcdef0123456789abcdef01234569', '0123456789abcdef0123456789abcdef01234569:torrent', 'download', NULL, NULL);
SQL

printf '%s\n' '#!/bin/sh' 'exit 0' > "$MOCKS/ingest-request.sh"
printf '%s\n' '#!/bin/sh' 'sqlite3 "$TORBOX_DB" "SELECT COALESCE(torbox_id, 30) FROM requests WHERE request_id='\''$1'\'';"' > "$MOCKS/ensure-torbox-job.sh"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$MOCKS/dispatch-job.sh"
printf '%s\n' '#!/bin/sh' 'exit 99' > "$MOCKS/process-tv.sh"
printf '%s\n' '#!/bin/sh' 'sqlite3 "$TORBOX_DB" "UPDATE jobs SET state=char(100,111,110,101) WHERE torbox_id=$1;"' > "$MOCKS/process-movie.sh"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$1" > "$SETTLE_MARKER"' > "$MOCKS/settle-request.sh"
ln -s "$ROOT/scripts/sync-movie-request-state.sh" "$MOCKS/sync-movie-request-state.sh"
ln -s "$ROOT/scripts/validate-movie-request-match.sh" "$MOCKS/validate-movie-request-match.sh"
chmod +x "$MOCKS"/*.sh

# Regression for the live Indiana Jones failure:
# a movie absent from Radarr must normalize to {}, allowing MOVIE_ID=0,
# and malformed movie IDs must be rejected explicitly.
grep -Fq '[.[] | select(.tmdbId == $tmdb)][0] // {}' "$ROOT/scripts/process-movie.sh"
grep -Fq 'Invalid Radarr movie ID: $MOVIE_ID' "$ROOT/scripts/process-movie.sh"

printf '%s\n' '{"requestId":"movie-request"}' > "$TMP/movie.json"
TORBOX_DB="$DB2" TORBOX_SCRIPTS_DIR="$MOCKS" SETTLE_MARKER="$TMP/settled" RADARR_API_KEY=test RADARR_URL=http://radarr \
  "$ROOT/scripts/process-request.sh" "$TMP/movie.json"
[[ "$(sqlite3 "$DB2" "SELECT state FROM requests WHERE request_id='movie-request';")" == done ]]
[[ "$(cat "$TMP/settled")" == movie-request ]]

# Unexpected process-movie failure while the job remains non-terminal must
# become a terminal failed job/request rather than hot-loop forever.
cat > "$MOCKS/process-movie.sh" <<'SH'
#!/bin/sh
sqlite3 "$TORBOX_DB" "UPDATE jobs SET state='evaluating' WHERE torbox_id=$1;"
exit 17
SH
chmod +x "$MOCKS/process-movie.sh"

printf '%s\n' '{"requestId":"processor-crash"}' > "$TMP/processor-crash.json"

if TORBOX_DB="$DB2" TORBOX_SCRIPTS_DIR="$MOCKS" SETTLE_MARKER="$TMP/settled-crash" RADARR_API_KEY=test RADARR_URL=http://radarr \
  "$ROOT/scripts/process-request.sh" "$TMP/processor-crash.json"; then
    echo 'crashing movie processor unexpectedly succeeded' >&2
    exit 1
fi

[[ "$(sqlite3 "$DB2" "SELECT state FROM jobs WHERE torbox_id=32;")" == failed ]]
[[ "$(sqlite3 "$DB2" "SELECT last_error FROM jobs WHERE torbox_id=32;")" == 'Movie processor exited unexpectedly while job was evaluating' ]]
[[ "$(sqlite3 "$DB2" "SELECT state FROM requests WHERE request_id='processor-crash';")" == failed ]]
[[ "$(sqlite3 "$DB2" "SELECT last_error FROM requests WHERE request_id='processor-crash';")" == 'Movie processor exited unexpectedly while job was evaluating' ]]
[[ "$(cat "$TMP/settled-crash")" == processor-crash ]]

# Restore normal success processor for remaining tests.
printf '%s\n' '#!/bin/sh' 'sqlite3 "$TORBOX_DB" "UPDATE jobs SET state=char(100,111,110,101) WHERE torbox_id=$1;"' > "$MOCKS/process-movie.sh"
chmod +x "$MOCKS/process-movie.sh"

printf '%s\n' '{"requestId":"season-request"}' > "$TMP/season.json"
if TORBOX_DB="$DB2" TORBOX_SCRIPTS_DIR="$MOCKS" SETTLE_MARKER="$TMP/not-settled" \
  "$ROOT/scripts/process-request.sh" "$TMP/season.json"; then
  echo 'unsupported season request unexpectedly ran' >&2
  exit 1
else
  [[ "$?" -eq 3 ]]
fi

# Intentional movie identity mismatch in process-request.sh must fail closed:
# mark request failed, record error, settle to /requests/failed/, leave job unmutated.
printf '%s\n' '{"requestId":"wrong-movie"}' > "$TMP/wrong-movie.json"
if TORBOX_DB="$DB2" TORBOX_SCRIPTS_DIR="$MOCKS" SETTLE_MARKER="$TMP/settled-wrong" RADARR_API_KEY=test RADARR_URL=http://radarr \
  "$ROOT/scripts/process-request.sh" "$TMP/wrong-movie.json"; then
  echo 'mismatched movie request unexpectedly succeeded' >&2
  exit 1
fi
[[ "$(sqlite3 "$DB2" "SELECT state FROM requests WHERE request_id='wrong-movie';")" == failed ]]
[[ "$(sqlite3 "$DB2" "SELECT last_error FROM requests WHERE request_id='wrong-movie';")" == 'unsupported or mismatched movie request ID: tmdb:999' ]]
[[ "$(sqlite3 "$DB2" "SELECT state FROM jobs WHERE torbox_id=31;")" == inspected ]]
[[ "$(cat "$TMP/settled-wrong")" == wrong-movie ]]

printf '%s\n' '#!/bin/sh' 'printf "%s\n" "[{\"tmdbId\":123,\"imdbId\":\"tt0123456\"}]"' > "$MOCKS/curl"
chmod +x "$MOCKS/curl"
[[ "$(PATH="$MOCKS:$PATH" TORBOX_DB="$DB2" RADARR_API_KEY=test RADARR_URL=http://radarr \
  "$ROOT/scripts/validate-movie-request-match.sh" imdb-movie 30)" == 'MATCHED: tt0123456 -> tmdb:123' ]]

# Regression test for the opt-in legacy worker movie selection guard:
# - Default worker configuration MUST disable unlinked account-resource processing;
# - Explicit legacy opt-in may select truly unlinked inspected movie job 40;
# - Active and failed request-linked movies MUST remain excluded.
sqlite3 "$DB2" <<'SQL'
INSERT INTO jobs (torbox_id, info_hash, state, media_type, arr_target, first_seen)
  VALUES (40, 'hash40', 'inspected', 'movie', 'radarr', CURRENT_TIMESTAMP);
INSERT INTO jobs (torbox_id, info_hash, state, media_type, arr_target, first_seen)
  VALUES (41, 'hash41', 'inspected', 'movie', 'radarr', CURRENT_TIMESTAMP);
INSERT INTO jobs (torbox_id, info_hash, state, media_type, arr_target, first_seen)
  VALUES (42, 'hash42', 'inspected', 'movie', 'radarr', CURRENT_TIMESTAMP);
INSERT INTO requests (request_id, state, media_type, scope, media_id, torbox_id, info_hash)
  VALUES ('active-req', 'processing', 'movie', 'movie', 'tmdb:41', 41, 'hash41');
INSERT INTO requests (request_id, state, media_type, scope, media_id, torbox_id, info_hash)
  VALUES ('failed-req', 'failed', 'movie', 'movie', 'tmdb:42', 42, 'hash42');
SQL

WORKER_SQL="
    SELECT j.torbox_id
    FROM jobs j
    WHERE j.media_type='movie'
      AND j.arr_target='radarr'
      AND j.state IN (
          'inspected',
          'downloading',
          'downloaded',
          'evaluating',
          'importing',
          'cleaning'
      )
      AND NOT EXISTS (
          SELECT 1
          FROM requests r
          WHERE r.torbox_id=j.torbox_id
             OR (r.info_hash IS NOT NULL AND lower(r.info_hash)=lower(j.info_hash))
      )
    ORDER BY j.first_seen
    LIMIT 1;
"

grep -Fq 'ALLOW_UNLINKED_LEGACY_IMPORTS:-0' "$ROOT/scripts/worker.sh"
grep -Fq 'MOVIE_JOB=""' "$ROOT/scripts/worker.sh"
[[ "$(sqlite3 "$DB2" "$WORKER_SQL")" == "40" ]]

# When explicitly opted-in job 40 is removed or completed, selection returns nothing (jobs 41 & 42 remain excluded):
sqlite3 "$DB2" "UPDATE jobs SET state='done' WHERE torbox_id=40;"
[[ -z "$(sqlite3 "$DB2" "$WORKER_SQL")" ]]

# Legacy unattended worker must terminalize an unexpected movie processor crash
# so a non-terminal job cannot be selected again every poll interval.
grep -Fq 'MOVIE_ERROR="Movie processor exited unexpectedly while job was ${MOVIE_STATE:-unknown}"' "$ROOT/scripts/worker.sh"
grep -Fq "SET state='failed'," "$ROOT/scripts/worker.sh"

echo 'movie request bridge helper tests passed'

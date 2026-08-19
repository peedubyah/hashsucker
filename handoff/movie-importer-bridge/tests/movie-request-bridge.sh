#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
DB="$TMP/test.db"

sqlite3 "$DB" <<'SQL'
CREATE TABLE jobs (
  torbox_id INTEGER PRIMARY KEY,
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
  last_error TEXT,
  updated_at TEXT
);
INSERT INTO jobs VALUES (10, 'processing', NULL);
INSERT INTO jobs VALUES (11, 'done', NULL);
INSERT INTO jobs VALUES (12, 'already_present', 'Movie already has a file; upgrade policy not enabled');
INSERT INTO jobs VALUES (13, 'failed', 'Radarr rejected candidate');
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('processing','processing','movie','movie',10);
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('done','processing','movie','movie',11);
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('present','processing','movie','movie',12);
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('failed','processing','movie','movie',13);
INSERT INTO requests (request_id,state,media_type,scope,torbox_id) VALUES ('tv','processing','tv','episode',11);
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
INSERT INTO jobs VALUES (20, 'cleaning', NULL);
INSERT INTO jobs VALUES (21, 'cleaning', NULL);
INSERT INTO jobs VALUES (22, 'cleaning', NULL);
INSERT INTO requests (request_id,state,media_type,scope,provider,provider_created,torbox_id) VALUES ('owned','processing','movie','movie','torbox',1,21);
INSERT INTO requests (request_id,state,media_type,scope,provider,provider_created,torbox_id) VALUES ('preexisting','processing','movie','movie','torbox',0,22);
SQL

[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/movie-cleanup-policy.sh" 20)" == delete-legacy ]]
[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/movie-cleanup-policy.sh" 21)" == delete-request-owned ]]
[[ "$(TORBOX_DB="$DB" "$ROOT/scripts/movie-cleanup-policy.sh" 22)" == retain-preexisting ]]

# End-to-end orchestration test with the proven movie processor mocked at its
# boundary: process-request must select movie (never TV), propagate done, settle.
DB2="$TMP/orchestration.db"
MOCKS="$TMP/scripts"
mkdir -p "$MOCKS"
sqlite3 "$DB2" <<'SQL'
CREATE TABLE jobs (torbox_id INTEGER PRIMARY KEY, info_hash TEXT, state TEXT, media_type TEXT, arr_target TEXT, last_error TEXT, updated_at TEXT);
CREATE TABLE files (torbox_id INTEGER, selected INTEGER, arr_match TEXT, arr_rejection TEXT, updated_at TEXT);
CREATE TABLE requests (request_id TEXT PRIMARY KEY, state TEXT, media_type TEXT, scope TEXT, media_id TEXT, torbox_id INTEGER, last_error TEXT, updated_at TEXT);
INSERT INTO jobs VALUES (30, '0123456789abcdef0123456789abcdef01234567', 'inspected', 'movie', 'radarr', NULL, NULL);
INSERT INTO files VALUES (30, 1, 'tmdb:123', NULL, NULL);
INSERT INTO requests VALUES ('movie-request', 'processing', 'movie', 'movie', 'tmdb:123', 30, NULL, NULL);
INSERT INTO requests VALUES ('season-request', 'processing', 'tv', 'season', 'tt1', NULL, NULL, NULL);
INSERT INTO requests VALUES ('wrong-movie', 'processing', 'movie', 'movie', 'tmdb:999', 30, NULL, NULL);
INSERT INTO requests VALUES ('imdb-movie', 'processing', 'movie', 'movie', 'tt0123456', 30, NULL, NULL);
SQL

printf '%s\n' '#!/bin/sh' 'exit 0' > "$MOCKS/ingest-request.sh"
printf '%s\n' '#!/bin/sh' 'printf "30\n"' > "$MOCKS/ensure-torbox-job.sh"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$MOCKS/dispatch-job.sh"
printf '%s\n' '#!/bin/sh' 'exit 99' > "$MOCKS/process-tv.sh"
printf '%s\n' '#!/bin/sh' 'sqlite3 "$TORBOX_DB" "UPDATE jobs SET state=char(100,111,110,101) WHERE torbox_id=$1;"' > "$MOCKS/process-movie.sh"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$1" > "$SETTLE_MARKER"' > "$MOCKS/settle-request.sh"
ln -s "$ROOT/scripts/sync-movie-request-state.sh" "$MOCKS/sync-movie-request-state.sh"
ln -s "$ROOT/scripts/validate-movie-request-match.sh" "$MOCKS/validate-movie-request-match.sh"
chmod +x "$MOCKS"/*.sh

printf '%s\n' '{"requestId":"movie-request"}' > "$TMP/movie.json"
TORBOX_DB="$DB2" TORBOX_SCRIPTS_DIR="$MOCKS" SETTLE_MARKER="$TMP/settled" RADARR_API_KEY=test RADARR_URL=http://radarr \
  "$ROOT/scripts/process-request.sh" "$TMP/movie.json"
[[ "$(sqlite3 "$DB2" "SELECT state FROM requests WHERE request_id='movie-request';")" == done ]]
[[ "$(cat "$TMP/settled")" == movie-request ]]

printf '%s\n' '{"requestId":"season-request"}' > "$TMP/season.json"
if TORBOX_DB="$DB2" TORBOX_SCRIPTS_DIR="$MOCKS" SETTLE_MARKER="$TMP/not-settled" \
  "$ROOT/scripts/process-request.sh" "$TMP/season.json"; then
  echo 'unsupported season request unexpectedly ran' >&2
  exit 1
else
  [[ "$?" -eq 3 ]]
fi

if TORBOX_DB="$DB2" RADARR_API_KEY=test RADARR_URL=http://radarr \
  "$ROOT/scripts/validate-movie-request-match.sh" wrong-movie 30; then
  echo 'mismatched movie request unexpectedly validated' >&2
  exit 1
fi

printf '%s\n' '#!/bin/sh' 'printf "%s\n" "[{\"tmdbId\":123,\"imdbId\":\"tt0123456\"}]"' > "$MOCKS/curl"
chmod +x "$MOCKS/curl"
[[ "$(PATH="$MOCKS:$PATH" TORBOX_DB="$DB2" RADARR_API_KEY=test RADARR_URL=http://radarr \
  "$ROOT/scripts/validate-movie-request-match.sh" imdb-movie 30)" == 'MATCHED: tt0123456 -> tmdb:123' ]]

echo 'movie request bridge helper tests passed'

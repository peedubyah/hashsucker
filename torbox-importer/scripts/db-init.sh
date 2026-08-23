#!/bin/sh
set -eu

DB="${TORBOX_DB:-/config/state/torbox-importer.db}"

mkdir -p "$(dirname "$DB")"

sqlite3 "$DB" <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS jobs (
    torbox_id       INTEGER PRIMARY KEY,
    info_hash       TEXT NOT NULL,
    torrent_name    TEXT NOT NULL,

    state           TEXT NOT NULL DEFAULT 'discovered',
    media_type      TEXT,
    arr_target      TEXT,

    first_seen      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    last_error      TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_hash
ON jobs(info_hash);

CREATE INDEX IF NOT EXISTS idx_jobs_state
ON jobs(state);


CREATE TABLE IF NOT EXISTS files (
    torbox_id       INTEGER NOT NULL,
    file_id         INTEGER NOT NULL,

    path            TEXT NOT NULL,
    size            INTEGER NOT NULL,

    selected        INTEGER NOT NULL DEFAULT 0,

    download_state  TEXT NOT NULL DEFAULT 'pending',
    local_path      TEXT,

    arr_match       TEXT,
    arr_rejection   TEXT,

    imported        INTEGER NOT NULL DEFAULT 0,
    library_path    TEXT,

    updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (torbox_id, file_id),

    FOREIGN KEY (torbox_id)
        REFERENCES jobs(torbox_id)
        ON DELETE CASCADE
);


CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    torbox_id       INTEGER,

    event_type      TEXT NOT NULL,
    message         TEXT,

    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (torbox_id)
        REFERENCES jobs(torbox_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS requests (
    request_id        TEXT PRIMARY KEY,

    created_at        TEXT NOT NULL,
    provider          TEXT NOT NULL,
    handling_mode     TEXT NOT NULL DEFAULT 'download',

    media_type        TEXT NOT NULL,
    scope             TEXT NOT NULL,

    media_id          TEXT NOT NULL,
    base_media_id     TEXT,

    season            INTEGER,
    episodes_json     TEXT NOT NULL DEFAULT '[]',

    info_hash         TEXT NOT NULL,
    file_index        INTEGER,
    release_key       TEXT,

    release_title     TEXT,
    release_filename  TEXT,
    release_size      INTEGER,

    state             TEXT NOT NULL DEFAULT 'processing',
    source_path       TEXT,

    torbox_id         INTEGER,
    provider_created  INTEGER NOT NULL DEFAULT 0,

    updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_hash
ON requests(info_hash);

CREATE INDEX IF NOT EXISTS idx_requests_state
ON requests(state);
SQL

if [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('requests') WHERE name='file_index';")" -eq 0 ]; then
    sqlite3 "$DB" "ALTER TABLE requests ADD COLUMN file_index INTEGER;"
fi

if [ "$(sqlite3 "$DB" "SELECT COUNT(*) FROM pragma_table_info('requests') WHERE name='release_key';")" -eq 0 ]; then
    sqlite3 "$DB" "ALTER TABLE requests ADD COLUMN release_key TEXT;"
fi

sqlite3 "$DB" <<'SQL'
UPDATE requests
SET info_hash=lower(info_hash);

UPDATE requests
SET release_key=info_hash || ':' ||
    CASE
        WHEN file_index IS NULL THEN 'torrent'
        ELSE CAST(file_index AS TEXT)
    END;

CREATE INDEX IF NOT EXISTS idx_requests_release_key
ON requests(release_key);
SQL

printf '%s\n' "db-init: initialized $DB"


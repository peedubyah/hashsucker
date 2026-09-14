# HashSucker on Unraid

Installs with the Compose Manager plugin. No source checkout, no build
step, no dashboard — startup logs and one diagnostics URL tell you everything.

## Install

1. Install **Compose Manager** from Community Applications.
2. Create a stack directory, e.g. `/boot/config/plugins/compose.manager/projects/hashsucker/`.
3. Copy `compose.yaml` and `.env.unraid.example` (as `.env`) from the
   [repo](https://github.com/peedubyah/hashsucker) into it.
4. Edit `.env`:
   - `TORBOX_API_KEY=` **or** `REALDEBRID_API_KEY=` (at least one; both is fine)
   - paths are prefilled for standard shares (`/mnt/user/appdata/hashsucker`,
     `/mnt/user/media/hashsucker`); `PUID=99`/`PGID=100` is usually correct.
5. In the stack directory: `docker compose pull && docker compose up -d`
   (Compose Manager runs the equivalent when you start the stack).

## What to expect

- `docker logs <stack>-media-search-1` prints a readiness summary within
  seconds: `ready`, your provider(s) `ok`, absent integrations `skipped`
  (skipped is normal, not a failure).
- The corpus then bootstraps in the background (`usable-partial` +
  progress in `/api/diagnostics`); **requests work immediately**.
- `HASHSUCKER_VERSION=latest` tracks stable releases. Pin `v0.1.0` for
  immutable deploys. `main` is the dev channel — don't use it here.
- Point Plex/Jellyfin at `HASHSUCKER_MEDIA_PATH` (`.../media/hashsucker`);
  published `.strm` files appear under `<path>/strm`.
- Back up the two SQLite DBs under the appdata path (see below). The
  media path holds regenerable STRM files only.

## Later

Add Seerr (requests), Sonarr/Radarr (upcoming monitoring), Prowlarr
(candidates), or Plex/Jellyfin (refresh) by uncommenting their lines in
`.env` and recreating the stack. Nothing else is required.

## Backup and restore

Back up physical files, not logical tables. The two SQLite DB files are
backed up whole; individual tables inside may still be logically
regenerable (they just ride along in the file). Queue files, STRM
output, and `hy4-cache` are explicitly not required.

**Back up (physical units):**

- `<data>/discovery/discovery-cache.db` — whole file via
  `sqlite3 … ".backup …"` or with the stack stopped; never copy `-wal`
  files alone. Holds authoritative state (handoffs, intents, VFS
  entries, request history) plus regenerable tables (corpus candidates,
  observations, enrichment/probe queues) that rebuild on their own.
- `<data>/discovery/control-plane.db` — same discipline. Holds
  authoritative state (placements, TorrentFiles, bindings, library).

**Safe to discard (transient transport, not authoritative):**

- `<data>/queue/` (`incoming/`, `processing/`, `done/`, `failed/`) —
  file transport from media-search to the torbox-importer
  (`incoming/<requestId>.json`, claimed into `processing/`, settled
  into `done/`/`failed/`). Nothing durable lives only in a queue
  file: any fulfilled outcome is already a DB handoff. A stranded
  `incoming/`/`processing/` file at backup time is an importer job
  that simply won't resume — restore without it loses no library
  truth (verified: restore with an empty queue kept all 104
  handoffs, 27 intents, 65 VFS entries). `done/`/`failed/` are
  terminal history; `.actions.log` is audit history.
- `<data>/torbox-importer/`, `<data>/downloads/` — importer state and
  staging; rescanned/recreated.
- `*-shm` / `*-wal` files, `test.sqlite`, stale `*.backup.*` copies.

**Do not back up (proven regenerable/disposable):**

- `<media>/strm/` — republished deterministically from handoffs on
  next request (verified: restore without it, rerequest, STRM returns).
- `hy4-cache` volume — grid chunk cache; a miss re-fetches from the
  provider and serves correctly (verified on an empty cache).

**Permanent promotion output (only if you enabled promotion):**

- The `HASHSUCKER_PERMANENT_PATH` root (`/permanent` by default)
  contains media bytes you own — NOT cache, NOT regenerable. Protect
  it under your normal media backup policy, like any other owned
  movie/show folder.
- HashSucker DB state remains the authoritative metadata (what is
  permanent lives in the `promotions` table inside `control-plane.db`,
  covered by the DB backup above). Restoring DBs without the
  permanent files degrades gracefully: the provider-backed ladder
  serves the item again until you re-promote.
- `hy4-cache` stays disposable and `<media>/strm/` stays regenerable
  whether or not promotion is enabled: promoting an item never
  changes what those two stores mean.

**Restore procedure:**

1. Fresh install per above (empty dirs are fine).
2. Stop the stack. Copy the two `.db` files into
   `<data>/discovery/` (that sub-path matters: the container derives
   its DB path by appending `/discovery` to the data root).
3. Start the stack. Diagnostics should report `ready` with the corpus
   `usable` immediately — no bootstrap.
4. Rerequest anything: handoffs, intents, and VFS entries survive
   verbatim (verified identical counts); first rerequest republishes
   STRM files in milliseconds.
5. First playback re-fills `hy4-cache` transparently.

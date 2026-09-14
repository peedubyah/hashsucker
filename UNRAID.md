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
- Back up the appdata path (DBs, queue, importer state). The media path
  holds regenerable STRM files only.

## Later

Add Seerr (requests), Sonarr/Radarr (upcoming monitoring), Prowlarr
(candidates), or Plex/Jellyfin (refresh) by uncommenting their lines in
`.env` and recreating the stack. Nothing else is required.

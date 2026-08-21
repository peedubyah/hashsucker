# media-search

> **ARCHIVED PRE-CONSOLIDATION COMPONENT README:** Non-authoritative. Use [`../../media-search/README.md`](../../media-search/README.md); the browser/deployment/request claims below are stale.

A single-container browser application for finding media releases and submitting explicit TV episode requests to the torbox-importer shared queue.

## Supported workflow

The MVP supports title search, TV season/episode selection, normalized Stremio torrent releases, server-side TorBox cache indicators, explicit release selection, queue submission, and queued/processing/done/failed status polling. Movies can appear in search, but movie, season, series, and multi-episode requests are visibly disabled and rejected by the API.

An episode request remains an episode request even when the selected torrent is a whole-season pack. For example, selecting a 61 GB Season 7 release for S07E03 writes `scope: "episode"`, `season: 7`, and `episodes: [3]`. The importer selects the physical file.

## Configuration

Copy `.env.example` to `.env` and set:

- `TORBOX_API_KEY`: TorBox server-side API key.
- `STREMIO_ADDON_MANIFEST_URL`: discovery-only Stremio addon manifest URL. Configure the addon to return torrent info hashes without embedding debrid credentials.
- `MEDIA_SEARCH_PORT`: browser port on the Unraid host; defaults to `3000`.
- `REQUESTS_HOST_PATH`: shared queue root on Unraid; defaults to `/mnt/database/appdata/media-request-queue`.
- `DISCOVERY_CACHE_PATH`: SQLite discovery cache path; defaults to `/config/discovery-cache.db`.

The browser never receives these values. The queue root must contain (or allow the container to create) `incoming`, `processing`, `done`, and `failed`. Both media-search and torbox-importer must mount the same host root at `/requests`.

Choose a `MEDIA_SEARCH_PORT` that is not already used by another Unraid service. Port 3000 is valid but commonly occupied.

## Local test and run

```sh
npm test
TORBOX_API_KEY=... STREMIO_ADDON_MANIFEST_URL=... REQUESTS_ROOT=/tmp/media-requests npm start
```

Open `http://localhost:3000`. Healthcheck: `http://localhost:3000/health`.

## Docker and Unraid deployment

Copy the repository to any persistent project directory on Unraid. Application source is copied into the image and is not read from a development-host mount.

```sh
cp .env.example .env
# Edit .env; set TORBOX_API_KEY and STREMIO_ADDON_MANIFEST_URL.
docker compose build
docker compose up -d
docker compose ps
curl --fail http://localhost:3000/health
```

To copy from a workstation first:

```sh
DEPLOY_TARGET=root@unraid:/mnt/user/appdata/media-search-project ./deploy.sh
```

Then create `.env` and run Compose on Unraid. The container remains the image's unprivileged `node` user (UID/GID 1000). `compose.yaml` adds supplementary GID 100 so it can use the proven shared-spool ownership model: host owner/group `99:100`, directories group-writable and setgid (`2775`). Do not remove `group_add: ["100"]`; newly queued files should inherit ownership `1000:100`. No Docker socket, importer appdata, SQLite database, SSH service, source bind mount, or development server is required at runtime.

## API summary

- `GET /api/search?q=...`
- `GET /api/media?type=series&id=...`
- `GET /api/releases?type=series&mediaId=...:season:episode`
- `POST /api/requests` (single explicit TV episode only)
- `GET /api/requests/:requestId`
- `GET /health`

Failures are fail-closed. TorBox cache-check failure is shown as “Cache unknown,” not “Not cached.”

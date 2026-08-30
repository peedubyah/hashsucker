# Operations

Deploying, configuring, and verifying HashSucker. For the component model see
[`architecture.md`](architecture.md).

## 1. Deployment

Root `compose.yaml` is the authoritative topology. `media-search/compose.yaml` is stale and must
not be treated as production authority.

| Service | Built from | Ports | Volumes |
|---|---|---|---|
| `media-search` | `./media-search` | `${MEDIA_SEARCH_BIND_ADDRESS:-127.0.0.1}:${MEDIA_SEARCH_PORT:-3000}:3000` | discovery DB at `/data`, request queue at `/requests`, `.strm` output at `/strm` |
| `torbox-importer` | `./torbox-importer` | none | config at `/config`, request queue at `/requests`, downloads at `/downloads`, `.strm` at `/strm` |
| `edge` | `caddy:2-alpine` | `${EDGE_BIND_ADDRESS:-0.0.0.0}:${EDGE_PORT:-8080}:8080` | `./edge/Caddyfile` (read-only) |

All three run `restart: unless-stopped` with `no-new-privileges`. `media-search` joins
`MEDIA_SEARCH_QUEUE_GID` so it can write to the shared queue. `torbox-importer` runs as
`PUID:PGID`.

```sh
cp .env.example .env
docker compose up -d --build
scripts/smoke-test.sh
```

## 2. Environment reference

Names and purposes only. Never commit a populated `.env`; `.env.example` ships with empty
placeholders for every secret.

### Required — compose will not start without these

`TORBOX_API_KEY`, `REQUESTS_HOST_PATH`, `TORBOX_IMPORTER_HOST_PATH`, `DOWNLOADS_HOST_PATH`,
`RADARR_URL`, `RADARR_API_KEY`, `SONARR_URL`, `SONARR_API_KEY`.

### Secrets

`TORBOX_API_KEY`, `REALDEBRID_API_KEY`, `RADARR_API_KEY`, `SONARR_API_KEY`, `JELLYFIN_API_KEY`,
`SEERR_API_KEY`, `SEERR_WEBHOOK_TOKEN`, `PLEX_TOKEN`.

Provider tokens must never reach browser code and must never cross the edge boundary.

### Storage

| Variable | Default | Purpose |
|---|---|---|
| `DISCOVERY_DB` | `/data/discovery-cache.db` | Corpus SQLite; unset means in-memory |
| `CONTROL_PLANE_DB` | `/data/control-plane.db` | Control-plane SQLite |
| `TORBOX_DB` | `/config/state/torbox-importer.db` | Importer state |
| `REQUESTS_ROOT` | `/requests` | Filesystem request queue root |
| `STRM_OUTPUT_PATH` | `/strm` | `.strm` publish target |
| `STATIC_ROOT` | `/app/public` in the image | Built UI; unset means no static serving |
| `EVENT_STORE_DB` | — | Operator lifecycle event store |
| `SEARCH_DECISIONS_DB` | — | Search decision telemetry store |

### Playback

| Variable | Default | Purpose |
|---|---|---|
| `RESOLVER_BASE_URL` | `http://localhost:8080` | Base URL baked into every `.strm` |
| `REALDEBRID_MOUNT_PATH` | — | Root for mount scope `default` |
| `TORBOX_MOUNT_PATH` | — | Root for mount scope `torbox` |
| `CANONICAL_LIBRARY_PATH` | — | Root for mount scope `canonical` |
| `STREAM_AVAILABILITY_MAX_AGE_MS` | `300000` | Observation freshness window |
| `STREAM_PROVIDER_CHECK_TIMEOUT_MS` | `3000` | Provider check timeout |
| `TORBOX_API_URL` | `https://api.torbox.app/v1/api` | TorBox API base |
| `RESOLVER_PROFILE` | `0` | Set `1` to enable per-stage timing headers |

### Discovery sources

`TORZNAB_URLS` (JSON array of indexer definitions), `COMET_TORBOX_MANIFEST_URL`,
`COMET_REALDEBRID_MANIFEST_URL`, `COMET_MANIFEST_URL`, `TORRENTIO_TORBOX_MANIFEST_URL`,
`TORRENTIO_REALDEBRID_MANIFEST_URL`, `CINEMETA_BASE_URL`.

### Ingress and notifications

`SEERR_URL`, `SEERR_API_KEY`, `SEERR_WEBHOOK_TOKEN`, `JELLYFIN_URL`, `JELLYFIN_MEDIA_ROOT`,
`PLEX_WATCHLIST_BASE`.

### Network and runtime

`MEDIA_SEARCH_BIND_ADDRESS` (`127.0.0.1`), `MEDIA_SEARCH_PORT` (`3000`), `EDGE_BIND_ADDRESS`
(`0.0.0.0`), `EDGE_PORT` (`8080`), `MEDIA_SEARCH_QUEUE_GID` (`100`), `PUID` (`99`),
`PGID` (`100`), `POLL_INTERVAL` (`10`), `HASHSUCKER_BASE_URL`,
`ALLOW_UNLINKED_LEGACY_IMPORTS` (unset = off), `METADATA_CACHE_TTL_MS` (`300000`),
`METADATA_CACHE_MAX_ENTRIES` (`500`).

## 3. Running locally

Requires Node 24+.

```sh
cd media-search
npm ci
npm test
npm run dev        # watch mode, uses .env.local when present
```

| Script | Purpose |
|---|---|
| `start` | Start the API |
| `dev` | Watch mode |
| `test` | Backend suite |
| `test:stage3`, `test:stage3:ranking` | Ranking and fixture suites |
| `dmm:ingest`, `dmm:seed-probes` | Corpus ingestion |
| `cache:probe`, `availability`, `canary` | Diagnostics |
| `enrichment` | Identity enrichment CLI |
| `media-request`, `media-request-batch` | Request CLI |
| `intents` | Intent CLI — not the server runtime |
| `search` | Legacy search CLI, **not** the active discovery path |
| `realdebrid` | Real-Debrid inspection |

The UI package (`media-search/ui`) has `build`, `lint`, `typecheck`, `preview`, and `test:watch`.
For frontend development run Vite separately; it proxies `/api` to port 3000. The UI is a
prototype — no season/episode picker and no status polling.

## 4. First-boot verification

`scripts/smoke-test.sh` brings the stack up and runs eight read-only probes:

1. `GET /health` returns `200` (30 retries, 1 s apart).
2. `GET /` returns HTML containing `id="root"` — the Vite build is being served.
3. `docker logs torbox-importer` contains `starting TorBox importer`.
4. **Cross-service queue permissions** — `media-search` writes a probe file into
   `/requests/incoming/`, `torbox-importer` reads it, then the file is removed.
5. Importer SQLite exposes a `requests` table.
6. Discovery SQLite opens under `node:sqlite` and `PRAGMA integrity_check` passes.
7. `media-search` has `TORBOX_API_KEY`, `REQUESTS_ROOT`, `DISCOVERY_DB`, `CONTROL_PLANE_DB`.
8. `torbox-importer` has `TORBOX_API_KEY`, `RADARR_URL`, `TORBOX_DB`.

Exit `0` on all-pass, `1` with a failure list otherwise. Flags: `--no-down` leaves the stack
running, `SKIP_BUILD=1` skips the image build. The script does not modify data, and it exercises
no discovery, provider, or Arr behaviour — it is a wiring check, not an integration test.

## 5. Health and operator surface

`GET /health` is liveness; `GET /health/ready` is readiness (200 or 503).

`GET /api/control-plane/health` reports mount reachability for `realdebrid-zurg`,
`torbox-webdav`, and `canonical-library`, and self-identifies as `mode: read-only-shadow`. It
checks reachability only — it does **not** verify read-only enforcement.

The `/api/operator/*` routes give a read-only console over the filesystem queue and lifecycle
events, plus queue control: list with `?filter=`, request detail, retry, reset,
delete-orphan, inspect, worker status, logs, search-debug, event streams, and diagnostics.

## 6. Control plane in production — what is actually running

The control plane is live but deliberately inert. Know this before reading its state:

| Component | Runtime state |
|---|---|
| `store.js` | Wired and authoritative |
| `canonical-path.js` | Wired; used by the store and both WebDAV modules |
| `reconciler.js` | `planReconciliation` only, in `mode: 'shadow'`. `executeReconciliation` has no runtime caller — plans are computed and never applied |
| `health.js` | Wired, read-only-shadow |
| `rd-zurg-slice.js` | Only the pure projection function runs. The mutating factory is never constructed |
| `repair-planner.js`, `repair-executor.js` | No runtime callers |
| `src/lib/acquisition/**` | No runtime callers outside tests |

Reconciliation planning runs in `mode: 'shadow'` and repair execution has no runtime caller, so
planned repairs are computed and never applied.

## 7. Known operational risks

### Security

- **A TorBox API key was committed in this repository's history and requires rotation.** The value
  is not present in the working tree, but removing a file does not revoke a credential and history
  was not rewritten. Rotate the key.
- **Mutation routes have no application authentication.** Any caller who can reach the port can
  ingest, mutate, or submit resource-consuming work. There is no auth middleware in the
  application at all — keep the default loopback bind, or put an authenticated trusted reverse
  proxy in front and keep the API off the public interface.
- Any reverse proxy placed in front must forward `Range` untouched and must not buffer media, or
  playback breaks. HTTP Basic Auth is not usable — it breaks Plex clients.
- Mounts are expected to be read-only. Credentials and database paths must not cross the edge
  boundary.

### Correctness

- DMM ingestion fails against current source fragments; the compatible importer is unwired.
- `GET /api/search?q=` (no `type`/`mediaId`) routes through Cinemeta's catalog endpoint, which
  returns static popular results for every query. Title search does not work.
- The importer worker resumes the first file in `/requests/processing/` before claiming any new
  `incoming` request, so a request that never completes is retried ahead of new work every loop.
- No runtime path executes a planned repair or an acquisition decision: `repair-planner.js`,
  `repair-executor.js`, and `src/lib/acquisition/**` have no runtime callers. A degraded binding is
  observed, not corrected.
- Cleanup deletes a provider resource only when exactly one `processing` request references the job
  or hash **and** that request created the resource itself (`provider IN ('torbox','auto')` and
  `provider_created=1`). Every other case is retained: unlinked account inventory is treated as
  observation, not ownership.

### Configuration discrepancies to fix

- `STRM_HOST_PATH` defaults differ between `media-search` and `torbox-importer` — the two services
  can end up writing to different directories.
- `RESOLVER_BASE_URL` defaults to `http://localhost:8080` for `media-search`, while
  `torbox-importer` is given `http://media-search:3000` for the same variable. Set it explicitly.
- `CINEMETA_BASE_URL` appears (commented out) in `.env.example` but is not referenced by
  `compose.yaml`, so setting it has no effect on a compose deployment.
- The `discovery-data` volume is declared but unused; both databases use bind mounts.

## 8. Scheduling

There is no in-process scheduler. Nothing runs on a timer except an in-memory metadata cache TTL
sweep.

- The **request queue** is drained by the `torbox-importer` container polling at `POLL_INTERVAL`.
- **Seerr ingress** is push — Seerr calls the webhook.
- **Plex Watchlist ingress** is manual. `scripts/plex-watchlist-ingest.mjs` has no cron, timer, or
  scheduler behind it; an operator runs it on the host, where it loads `.env` from the repository
  root and writes directly to `DISCOVERY_DB`.

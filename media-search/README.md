# media-search

Node.js API and current control-plane prototype for HashSucker.

## Current responsibilities

- Cinemeta title search and media lookup with an in-memory metadata cache.
- SQLite/FTS5 release-corpus storage and retrieval.
- Local release ranking.
- Live Torrentio/Comet/Torznab discovery and normalization.
- Atomic publication of explicit physical-acquisition requests to a shared filesystem queue.
- Operator-triggered DMM ingestion and attribute parsing.

It does **not** serve the React application, directly place Real-Debrid content, expose WebDAV/rclone media, or maintain a canonical virtual library. See the root [`HANDOFF.md`](../HANDOFF.md) for current defects and target boundaries.

## Local development

Requires Node.js 24+.

```sh
npm ci
npm test
npm run dev
```

Useful scripts:

- `npm start` — start the API.
- `npm run dev` — watch mode using `.env.local` when present.
- `npm run search` — legacy search CLI; this is not the active server release-discovery path.
- `npm test` — backend test suite.

The API defaults to `http://localhost:3000`. `GET /health` verifies process health. `/` returns 404 because there is no static frontend route.

For frontend development, run `npm run dev` separately in `../ui`; Vite proxies `/api` to port 3000.

## Active configuration

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | HTTP listen address |
| `REQUESTS_ROOT` | Shared physical-request queue root; defaults to `/requests` |
| `DISCOVERY_DB` | Discovery SQLite file; unset means in-memory |
| `CINEMETA_BASE_URL` | Optional Cinemeta base URL |
| `METADATA_CACHE_TTL_MS`, `METADATA_CACHE_MAX_ENTRIES` | Metadata cache limits |
| `TORBOX_API_KEY` | Torrentio/TorBox live discovery; direct checks only on the legacy CLI path |
| `REALDEBRID_API_KEY` | Torrentio/Real-Debrid live discovery only; not a direct provider adapter |
| `COMET_MANIFEST_URL` | Optional Comet discovery source |
| `TORZNAB_URLS` | JSON array of Torznab endpoint definitions |

`STREMIO_ADDON_MANIFEST_URL` is not read by current source. `DISCOVERY_CACHE_PATH` belongs to a legacy search path; the server uses `DISCOVERY_DB`.

Never expose provider tokens to browser code.

## Deployment status

Root `compose.yaml` is the relevant repository topology. It currently:

- deploys this API and `torbox-importer`;
- mounts only `/requests` for this service;
- does not set/persist `DISCOVERY_DB`;
- does not deploy the React UI.

`media-search/compose.yaml` is a stale standalone topology and should not be treated as production authority until reconciled.

The current Dockerfile copies source but does not install `lz-string`; clean-image deployment is a known Stage 0 defect. Do not describe the image as production-ready.

## Current release-search behavior

`GET /api/search?type=...&mediaId=...` combines local corpus and live sources, but local retrieval is not selected-media scoped, live results receive score `0`, no final global rerank occurs, and merge identity is info hash only. Treat output as prototype recommendations.

## DMM ingestion status

`POST /api/ingest/dmm` reaches a runner that recognizes only a script-call wrapper. Sampled current fragments use iframe/hash, so the reachable path fails before decoding them. `src/lib/ingestion/dmm.js` is compatible with sampled current fragments but is only used by tests/manual code and is not a package script or server/deployment entrypoint.

## API

The current HTTP contract is documented once in [`src/api/API_CONTRACT.md`](src/api/API_CONTRACT.md). Mutation routes currently have no application authentication and must remain behind a trusted boundary until Stage 0 access controls are implemented.

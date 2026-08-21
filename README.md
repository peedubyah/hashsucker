# HashSucker

HashSucker is a media release-intelligence and fulfillment control plane. It is intended to turn a large hash corpus and live discovery evidence into exact, provider-backed media placements and a stable virtual library for Plex or other players.

## Problem

Debrid providers expose cache, placement, file, and transport state in provider-specific ways. Release names and torrent hashes are not themselves stable media identity, and repeatedly probing every plausible hash is expensive. HashSucker aims to own the decisions and durable identity above those systems while delegating byte transport to mature tools.

## Current implementation — verified 2026-08-21

The repository currently provides a prototype discovery API and a comparatively mature physical-import fallback:

- `media-search/` searches Cinemeta metadata, a local SQLite/FTS5 release corpus, Torrentio/Comet, and Torznab sources.
- The local corpus stores exact `(infoHash, fileIndex)` candidates, parsed release attributes, media associations, and provider observations.
- `torbox-importer/` consumes an atomic filesystem queue, acquires through TorBox, and invokes Sonarr/Radarr `ManualImport` for an explicit movie or one TV episode.
- `ui/` is a React/Vite release-comparison prototype built into and served by the production `media-search` image.
- Backend, frontend, importer, clean-image, startup, and restart-persistence validation pass, but several correctness defects remain.

Important limitations:

- Local corpus retrieval is not constrained by the selected media ID.
- Local and live candidates are not globally ranked.
- Exact file identity collapses to hash-only during result merge, UI row identity, request handoff, and importer persistence.
- Provider-observation age is ignored by ranking.
- The reachable DMM ingestion endpoint does not recognize the current iframe/hash source wrapper; a compatible importer exists but is not wired to runtime.
- Mutation endpoints have no application authentication. Root Compose binds to loopback by default; use an authenticated trusted reverse proxy before publishing beyond localhost.
- A TorBox credential formerly committed in local addon configuration remains exposed in Git history and requires owner rotation.

Treat current discovery recommendations as prototype output. The local importer safeguards are stronger, but that path is the secondary fulfillment mode rather than the target primary product.

## Target direction

```text
large hash corpus
  → release/media intelligence
  → efficient provider-specific cache probing
  → provider placement
  → provider-authoritative file mapping
  → mature provider transport
  → stable provider-independent virtual library
  → Plex / players
```

HashSucker is the **control plane**: intent, exact release selection, desirability, cache-probe policy, confirmed provider observations, placement records, canonical bindings, reconciliation, and telemetry.

Zurg, provider WebDAV, and rclone are the **data plane**: remote-file exposure, mounting, seeking, buffering, and byte delivery. A custom HashSucker byte proxy is not a primary goal.

Local download plus Sonarr/Radarr import remains supported as an explicit secondary policy.

Release desirability, a provider-specific cache prior, fresh confirmed provider state, placement state, and library/playback health are separate concepts. None may silently stand in for another.

## Repository map

| Path | Role |
|---|---|
| `media-search/` | Node control-plane prototype: metadata, corpus, discovery, ranking, request publication |
| `torbox-importer/` | Shell/SQLite executor for secondary TorBox download plus Arr import |
| `ui/` | React/Vite prototype built into the production `media-search` image |
| `docs/` | Current architecture, model, pipeline, roadmap, risks, decisions, and evidence |
| `handoff/` | Historical importer bridge artifacts, not current runtime authority |
| `compose.yaml` | Current two-service topology with same-origin UI/API and persistent discovery storage |

## Development

Requirements: Node.js 24+, npm, and Bash. Container deployment additionally requires Docker Compose or an equivalent configured container CLI.

Backend:

```sh
cd media-search
npm ci
npm test
npm run dev
```

Frontend, in another terminal:

```sh
cd ui
npm ci
npm test
npm run dev
```

Vite proxies `/api` to the backend at `http://localhost:3000`. The backend itself serves API routes only; `/` is not a browser application.

For the current container topology, copy `.env.example` to `.env`, create the three required host directories with ownership compatible with the configured IDs, and run `docker compose up -d --build`. Open `http://127.0.0.1:3000` by default. Discovery state is stored in the Compose-managed `discovery-data` volume; importer state remains under `TORBOX_IMPORTER_HOST_PATH`.

The UI/API is intentionally loopback-only because mutation routes have no application authentication. Put an authenticated trusted reverse proxy in front before changing `MEDIA_SEARCH_BIND_ADDRESS`. Rotate the historically exposed TorBox credential before provider use.

## Read next

1. [`HANDOFF.md`](HANDOFF.md) — durable invariants, boundaries, authority, roadmap intent, and resumption constraints.
2. [`docs/project-state.md`](docs/project-state.md) — machine-generated current repository/integration facts; update with `node scripts/update-project-state.mjs`.
3. [`docs/architecture.md`](docs/architecture.md) — current and target architecture.
4. [`docs/data-model.md`](docs/data-model.md) — implemented storage and target entities.
5. [`docs/pipeline.md`](docs/pipeline.md) — current and target flows.
6. [`docs/roadmap.md`](docs/roadmap.md) — staged, reversible implementation order.
7. [`docs/known-gaps.md`](docs/known-gaps.md) — current defect and risk register.
8. [`docs/audit/8-21-audit.md`](docs/audit/8-21-audit.md) — canonical evidence baseline for this assessment.

`docs/archive/` contains historical or superseded material for archaeology only. It is not authoritative unless a current document explicitly cites a narrow piece of evidence.

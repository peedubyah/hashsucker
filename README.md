# HashSucker

HashSucker is a media release-intelligence and fulfillment control plane. It is intended to turn a large hash corpus and live discovery evidence into exact, provider-backed media placements and a stable virtual library for Plex or other players.

## Problem

Debrid providers expose cache, placement, file, and transport state in provider-specific ways. Release names and torrent hashes are not themselves stable media identity, and repeatedly probing every plausible hash is expensive. HashSucker aims to own the decisions and durable identity above those systems while delegating byte transport to mature tools.

## Current implementation — verified 2026-08-21

The repository currently provides a prototype discovery API and a comparatively mature physical-import fallback:

- `media-search/` searches Cinemeta metadata, a local SQLite/FTS5 release corpus, Torrentio/Comet, and Torznab sources.
- The local corpus stores exact `(infoHash, fileIndex)` candidates, parsed release attributes, media associations, and provider observations.
- `torbox-importer/` consumes an atomic filesystem queue, acquires through TorBox, and invokes Sonarr/Radarr `ManualImport` for an explicit movie or one TV episode.
- `ui/` is a separate React/Vite release-comparison prototype.
- Backend and frontend tests pass, but several correctness and deployment defects remain.

Important limitations:

- Local corpus retrieval is not constrained by the selected media ID.
- Local and live candidates are not globally ranked.
- Exact file identity collapses to hash-only during result merge, UI row identity, request handoff, and importer persistence.
- Provider-observation age is ignored by ranking.
- The reachable DMM ingestion endpoint does not recognize the current iframe/hash source wrapper; a compatible importer exists but is not wired to runtime.
- Root Compose does not deploy the UI or persist the discovery database.
- The backend image does not install its runtime dependency in a clean build.
- Mutation endpoints have no application authentication.

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
| `ui/` | Separate React/Vite prototype; not deployed by root Compose |
| `docs/` | Current architecture, model, pipeline, roadmap, risks, decisions, and evidence |
| `handoff/` | Historical importer bridge artifacts, not current runtime authority |
| `compose.yaml` | Current two-service backend/importer topology; incomplete for target deployment |

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

For the current container topology, copy `.env.example` to `.env` and review `compose.yaml`. Do not treat `docker compose up` as production-ready until roadmap Stage 0 is complete: clean-image dependencies, UI deployment, persistent `DISCOVERY_DB`, authentication/network controls, and secret rotation must be resolved.

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

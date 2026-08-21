# HashSucker Media Stack

A self-contained media discovery, search, and acquisition pipeline for Unraid.

Two services share a durable request queue:

```
browser → media-search → /requests queue → torbox-importer → Sonarr/Radarr
```

- **media-search** — browser UI + API for searching releases, selecting episodes, and submitting explicit requests.
- **torbox-importer** — worker that claims requests, acquires files from TorBox, and imports them via Sonarr/Radarr.

## Services

| Service | Container | Role |
|---------|-----------|------|
| media-search | `media-stack-search` | Search UI, release discovery, request submission |
| torbox-importer | `media-stack-importer` | TorBox acquisition, file selection, Arr import |

## Quick Start

```sh
git clone <repo-url> media-stack
cd media-stack
cp .env.example .env
# Edit .env — set TORBOX_API_KEY, RADARR_URL, RADARR_API_KEY, SONARR_URL, SONARR_API_KEY
docker compose up -d
```

Open `http://localhost:3000`.

Healthcheck: `curl http://localhost:3000/health`.

## Configuration

All configuration is via environment variables in `.env`. See `.env.example` for the full list.

### Required

| Variable | Purpose |
|----------|---------|
| `TORBOX_API_KEY` | TorBox API key (used by both services) |
| `RADARR_URL` | Radarr base URL |
| `RADARR_API_KEY` | Radarr API key |
| `SONARR_URL` | Sonarr base URL |
| `SONARR_API_KEY` | Sonarr API key |
| `REQUESTS_HOST_PATH` | Shared queue directory on host |

### Optional

| Variable | Purpose |
|----------|---------|
| `REALDEBRID_API_KEY` | Enable Real-Debrid provider discovery |
| `TORZNAB_URLS` | Torznab endpoint configuration (JSON array) |
| `MEDIA_SEARCH_PORT` | Host port for the browser UI (default: 3000) |
| `POLL_INTERVAL` | Importer poll interval in seconds (default: 10) |

## Architecture

### Request Flow

```
1. User searches in browser UI
2. media-search queries Stremio/Torznab providers + TorBox cache
3. User selects a release and explicit episode intent
4. media-search writes request to /requests/incoming
5. torbox-importer claims request, acquires from TorBox
6. torbox-importer selects physical files, downloads, imports via Arr
7. Request moves to /requests/done or /requests/failed
```

### Service Boundaries

**media-search owns:**
- Media discovery and search
- Release normalization and ranking
- Explicit user intent capture
- Request submission
- Coarse lifecycle display

**media-search does NOT:**
- Mutate importer state
- Delete provider resources
- Read importer SQLite directly
- Reimplement importer file selection logic

**torbox-importer owns:**
- TorBox resource lifecycle
- Physical file selection and download
- Sonarr/Radarr import and verification
- Authoritative import state
- Provider cleanup (only when safe)

### Shared Queue

Both services mount the same host directory at `/requests`:

```
/requests
  ├── incoming     ← media-search writes here
  ├── processing   ← torbox-importer claims here
  ├── done
  └── failed
```

The queue is the authoritative transport. Do not replace it with a direct HTTP API.

## Safety Invariants

### Provider Deletion

Never delete TorBox resources unless ALL conditions are proven:
1. Resource belongs to the request
2. Provider ID and hash match
3. Downstream import is verified
4. No other active request depends on it

Ambiguous ownership fails closed.

### Import Identity

Never weaken identity validation to make an import succeed. Explicit episode intent controls file selection — no guessing.

### Failure Behavior

Processor errors become terminal failures. No hot retry loops. Failures preserve provider resources and diagnostic state.

## Documentation

| Document | Purpose |
|----------|---------|
| `CODEX.md` | Implementation contract, architecture boundaries, safety invariants |
| `ai-handover.md` | Current implementation state, recent decisions, safe extension points |
| `docs/architecture.md` | Pipeline architecture, layer responsibilities, data ownership |
| `docs/enrichment-architecture.md` | Media identity enrichment system design |
| `docs/evaluation/ENRICHMENT-EVALUATION-2026-08-21.md` | Measured parser/enrichment effectiveness (62 real DMM samples) |
| `docs/decisions/001-discovery-cache.md` | SQLite cache architecture decision record |
| `media-search/README.md` | media-search service details, local development |
| `torbox-importer/README.md` | torbox-importer service details |

## Development

### media-search

```sh
cd media-search
npm test
TORBOX_API_KEY=... npm start
```

### torbox-importer

```sh
cd torbox-importer
./tests/movie-request-bridge.sh
```

## License

[Your license here]

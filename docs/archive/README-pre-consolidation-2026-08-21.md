# HashSucker

> **ARCHIVED PRE-CONSOLIDATION README:** Non-authoritative. Use [`../../README.md`](../../README.md) and [`../../HANDOFF.md`](../../HANDOFF.md).

Media discovery, search, and acquisition pipeline for Unraid.

## What It Does

HashSucker ingests release candidates from DMM hashlists and live sources, resolves them to known media identities, ranks them, and hands off explicit user requests to an importer that acquires files via TorBox and imports them through Sonarr/Radarr.

## Components

| Component | Location | Purpose |
|-----------|----------|---------|
| media-search | `media-search/` | Browser UI + API for search, enrichment, request submission |
| torbox-importer | `torbox-importer/` | Worker: claims requests, acquires files, imports via Arrs |
| ui | `ui/` | Vite/React/TypeScript frontend |

## Quick Start

```sh
git clone <repo-url> media-stack
cd media-stack
cp .env.example .env
# Edit .env — set TORBOX_API_KEY, RADARR_URL, RADARR_API_KEY, SONARR_URL, SONARR_API_KEY
docker compose up -d
```

Open `http://localhost:3000`.

## Documentation

| Document | Purpose |
|----------|---------|
| `XHIGH-HANDOFF.md` | **Start here** — architecture handoff for new agents |
| `CODEX.md` | Implementation contract, boundaries, safety invariants |
| `docs/architecture.md` | Current runtime architecture |
| `docs/data-model.md` | Persistent schema and relationships |
| `docs/pipeline.md` | Actual data flows |
| `docs/known-gaps.md` | Unresolved work backlog |
| `docs/decisions/` | Architectural decision records |
| `docs/evaluation/` | Empirical measurements |
| `docs/archive/` | Historical/superseded designs |

## Development

```sh
# Backend
cd media-search && npm test

# Frontend
cd ui && npm run dev

# Deploy
docker compose up -d

# Health check
curl http://localhost:3000/health
```

## License

[Your license here]

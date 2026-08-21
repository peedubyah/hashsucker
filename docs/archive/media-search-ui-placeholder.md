# UI Directory

> **ARCHIVED REDUNDANT PLACEHOLDER:** Non-authoritative. The actual frontend is documented in [`../../ui/README.md`](../../ui/README.md).

This directory was reserved for a future frontend application.

The backend runtime served API endpoints from `src/server/` and did
not include a bundled frontend. A separate branch was expected to add the frontend
into this directory.

## Backend API

The backend exposes the following endpoints:

- `GET /api/search?q=<query>` — Cinemeta title search
- `GET /api/search?mediaId=<id>&type=<type>` — Unified release discovery (DMM + live + ranking)
- `GET /api/search/internal?q=<query>` — DMM corpus FTS5 search
- `GET /api/search/stats` — Index statistics
- `GET /api/media?type=<type>&id=<id>` — Cinemeta media lookup
- `POST /api/requests` — Submit a media request
- `GET /api/requests/<requestId>` — Request status
- `POST /api/ingest/dmm` — Trigger DMM hashlist ingestion
- `POST /api/attributes/run` — Trigger release attribute parsing
- `GET /health` — Health check

# UI Directory

This directory is reserved for the future frontend application.

The current backend runtime serves API endpoints from `src/server/` and does
not include a bundled frontend. A separate branch will add the frontend
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

# HashSucker — Architecture Handoff

> **First file for new architecture/refactor agents.**
> Last verified: 2026-08-21.

---

## 1. Product Objective

HashSucker is a media discovery, search, and acquisition pipeline. It ingests release candidates from DMM hashlists and live sources, resolves them to known media identities, ranks them, and hands off explicit user requests to an importer that acquires files via TorBox and imports them through Sonarr/Radarr.

## 2. Major Components

| Component | Location | Role |
|-----------|----------|------|
| media-search | `media-search/` | Browser UI + API for search, enrichment, request submission |
| torbox-importer | `torbox-importer/` | Worker that claims requests, acquires files, imports via Arrs |
| ui | `ui/` | Vite/React frontend (co-located with media-search historically) |

## 3. Runtime Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Browser (ui/)                                                       │
│  React 19 + Vite + TypeScript                                       │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ media-search (Node ESM, src/server/index.js)                        │
│  ├─ /api/search          → Cinemeta catalog search                  │
│  ├─ /api/releases        → FTS5 release search (DMM corpus)        │
│  ├─ /api/requests        → Request submission                      │
│  ├─ /api/ingest/dmm      → Trigger DMM ingestion                   │
│  └─ /api/attributes/run  → Trigger filename parsing                │
│                                                                     │
│  Discovery Cache (SQLite, src/lib/discovery/cache.js)              │
│  ├─ candidates           — torrent identity (infoHash, fileIndex)   │
│  ├─ release_attributes   — parsed filename metadata                │
│  ├─ candidate_media      — media identity associations             │
│  ├─ provider_observations — cache status per provider              │
│  └─ release_search       — FTS5 virtual table                      │
│                                                                     │
│  Enrichment Layer (src/lib/discovery/enrichment-sources/)           │
│  ├─ cinemeta.js          — Cinemeta catalog lookup (implemented)   │
│  └─ confidence.js        — scoring module                          │
│                                                                     │
│  Ranking (src/lib/discovery/ranking.js)                             │
│  └─ Pure function: relevance × quality × confidence × identity     │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ /requests queue (shared filesystem)                                 │
│  ├─ incoming/            ← media-search writes                     │
│  ├─ processing/          ← torbox-importer claims                  │
│  ├─ done/                                                                     │
│  └─ failed/                                                           │
└─────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│ torbox-importer (shell scripts, SQLite state)                       │
│  ├─ worker.sh            — poll loop                                │
│  ├─ claim-request.sh     — atomic queue claim                       │
│  ├─ process-request.sh   — handle frontend requests                 │
│  ├─ scan-torbox.sh       — refresh TorBox inventory                 │
│  ├─ process-movie.sh     — movie import flow                        │
│  ├─ process-tv.sh        — TV import flow                           │
│  └─ movie-cleanup-policy.sh — safe provider cleanup                │
└─────────────────────────────────────────────────────────────────────┘
```

## 4. Implemented Capabilities

| Capability | File(s) | Status |
|-----------|---------|--------|
| DMM hashlist ingestion | `dmm-ingestion-runner.js`, `adapters/dmm.js` | ✅ Verified |
| Filename parsing (PTN-style regex) | `parser-adapter.js` | ✅ 100% success on 62 samples |
| FTS5 full-text search | `search-engine.js` | ✅ Implemented |
| Composite ranking | `ranking.js` | ✅ Pure function, explainable |
| Cinemeta enrichment | `enrichment-sources/cinemeta.js` | ✅ Implemented |
| Confidence scoring | `enrichment-sources/confidence.js` | ✅ base + bonuses, clamped [0,1] |
| Media associations | `enrichment.js` | ✅ Additive, higher confidence wins |
| Provider observation separation | `cache.js` | ✅ Separate table |
| Persistent SQLite storage | `cache.js` | ✅ WAL mode |
| Request queue transport | `requests/` filesystem | ✅ Proven v1 transport |
| Browser UI | `ui/` | ✅ Vite/React/TS |
| Search/release/request APIs | `media-search/src/server/app.js` | ✅ Tested |

## 5. Critical Module Boundaries

### Discovery Cache (`src/lib/discovery/cache.js`)
- Identity: `(info_hash, file_index_key)` — exact, never fuzzy merged
- Provider observations: separate table, never in candidates
- Cache failures swallowed: live discovery is authoritative

### Release Attributes (`src/lib/discovery/release_attributes.js`)
- Evidence only — NOT media identity
- Multiple parsers per candidate (PK: `info_hash + file_index_key + source`)
- Higher confidence wins on conflict (equal → latest wins)

### Enrichment (`src/lib/discovery/enrichment.js`)
- Additive only — never removes existing associations
- Writes only `candidate_media`, never mutates candidates
- Unknown matches remain unknown (no forced associations)

### Ranking (`src/lib/discovery/ranking.js`)
- Pure function — no I/O, no API calls, no provider knowledge
- Weights must sum to 1.0
- Unknown provider = neutral (0.5), not penalty

## 6. Architectural Invariants

1. Candidate identity is physical `(infoHash, fileIndex)`, not media identity
2. Release attributes are evidence, not identity
3. Provider observations are separate from media associations
4. Enrichment is optional and additive
5. The shared filesystem queue is the authoritative transport (not HTTP)
6. Live discovery is source of truth; cache is a substrate
7. Higher confidence wins on conflict; equal confidence → latest wins
8. Unknown provider state = neutral, not penalty
9. Secrets never leave the server (browser talks only to media-search)

## 7. Test/Build Commands

```sh
# Backend tests
cd media-search && npm test

# Frontend dev
cd ui && npm run dev

# Frontend build
cd ui && npm run build

# Full stack deploy
docker compose up -d

# Health check
curl http://localhost:3000/health
```

## 8. Known Unresolved Areas

See `docs/known-gaps.md` for full list. Highest priority:

- No automated scheduler for DMM ingestion or enrichment
- No provider observation hydration (TorBox cache status always empty)
- Parser edge cases (year-at-start, foreign titles, packs)
- No TMDB/IMDb enrichment source yet

## 9. Canonical Documentation Map

| Document | Purpose |
|----------|---------|
| `README.md` | Human-facing project overview |
| `CODEX.md` | Implementation contract, boundaries, safety invariants |
| `docs/architecture.md` | Current runtime architecture |
| `docs/data-model.md` | Persistent schema and relationships |
| `docs/pipeline.md` | Actual data flows |
| `docs/known-gaps.md` | Unresolved work backlog |
| `docs/decisions/` | Architectural decision records |
| `docs/evaluation/` | Empirical measurements |
| `docs/archive/` | Historical/superseded designs |
| `media-search/src/api/API_CONTRACT.md` | Frontend API contract |
| `handoff/` | Historical importer bridge artifacts |

## 10. Important Notes

- **`docs/archive/`** contains superseded designs — useful for archaeology, not current truth
- **`handoff/`** contains historical importer bridge code — do not repurpose
- **API_CONTRACT.md** has unresolved merge conflicts — needs cleanup
- **Tests:** 267+ backend tests, 4 UI component tests

# Architecture Boundaries — HashSucker System Layers

**Date:** 2026-08-23  
**Scope:** Single map of ownership boundaries for the HashSucker materialization architecture  
**Complements:** `CONTRACTS.md` (contracts), `STATE-MACHINE-REFERENCE.md` (lifecycle states), `MATERIALIZATION-REGISTRY-SCHEMA.md` (schema)  
**Constraints:** No code; no schema; boundary documentation only

---

## 1. System Layer Map

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              HASHSUCKER SYSTEM                                   │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐   ┌─────────────┐         │
│  │  Discovery  │──▶│   Corpus    │──▶│ Acquisition │──▶│  Placement  │         │
│  │  (search,   │   │  Evidence   │   │   Intent    │   │  (provider  │         │
│  │   rank)     │   │  (persist)  │   │  (decide)   │   │   request)  │         │
│  └─────────────┘   └──────┬──────┘   └──────┬──────┘   └──────┬──────┘         │
│                           │                  │                  │                │
│                           ▼                  ▼                  ▼                │
│                    ┌─────────────────────────────────────────────────┐          │
│                    │          MATERIALIZATION REGISTRY               │          │
│                    │                                                 │          │
│                    │  ┌─────────────┐       ┌─────────────────────┐  │          │
│                    │  │  Placements │       │  Materialization    │  │          │
│                    │  │  (who holds │       │  State (can become  │  │          │
│                    │  │   content)  │       │   bytes right now)  │  │          │
│                    │  └──────┬──────┘       └──────────┬──────────┘  │          │
│                    │         │                         │             │          │
│                    │         ▼                         ▼             │          │
│                    │  ┌─────────────────────────────────────────┐   │          │
│                    │  │         Provider Adapter                │   │          │
│                    │  │  (resolve, refresh, getStatus)          │   │          │
│                    │  └─────────────────────────────────────────┘   │          │
│                    │                                                 │          │
│                    │  ┌─────────────────────────────────────────┐   │          │
│                    │  │         Resolver Endpoint              │   │          │
│                    │  │  GET /media/{info_hash}/{file_index}   │   │          │
│                    │  └─────────────────────────────────────────┘   │          │
│                    └─────────────────────────────────────────────────┘          │
│                           │                                                     │
│                           ▼                                                     │
│                    ┌─────────────────────────────────────────────────┐          │
│                    │          Consumer Adapters                      │          │
│                    │  .strm │ WebDAV │ FUSE │ HTTP Proxy            │          │
│                    └─────────────────────────────────────────────────┘          │
│                           │                                                     │
│                           ▼                                                     │
│                    ┌─────────────────────────────────────────────────┐          │
│                    │          Playback Clients                       │          │
│                    │  Plex │ Jellyfin │ Infuse │ Kodi │ Direct      │          │
│                    └─────────────────────────────────────────────────┘          │
│                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Layer Definitions

### 2.1 Discovery Layer

| Property | Value |
|----------|-------|
| **Owns** | User query processing, search execution, candidate ranking, confidence scoring |
| **Does NOT own** | Content identity, provider state, playback URLs, lifecycle |
| **Inputs** | User search queries, corpus search index |
| **Outputs** | Ranked candidate list with confidence scores |
| **Persistence** | None (stateless; reads from corpus) |
| **Key Files** | `src/parser.js`, `src/builder.js`, `src/index.js` |

#### Discovery Projections (Implemented)

Three read-only feature projections extract evidence from corpus data:

| Projection | Function | Purpose |
|------------|----------|---------|
| 2O — Persistence | `createCorpusPersistenceFeatures()` | Temporal bounds, survival rate, lifecycle transitions |
| 2P — Topology | `createCorpusTopologyFeatures()` | File composition, structure detection, playable target heuristics |
| 2Q — Confidence | `createCorpusConfidenceFeatures()` | Weighted confidence: persistence (0.40) + topology (0.40) + metadata (0.20) |

All projections are pure read-only queries over existing tables. No schema additions. No writes.

### 2.2 Corpus Evidence Layer

| Property | Value |
|----------|-------|
| **Owns** | Hash identity (`info_hash`, `file_index`, `file_index_key`), release metadata, persistence evidence, search index |
| **Does NOT own** | Provider state, acquisition intent, playback URLs, lifecycle state |
| **Inputs** | Ingested DMM payloads, parsed release attributes |
| **Outputs** | Stable content identity, searchable metadata |
| **Persistence** | `candidates` table, `release_attributes` table, `release_search` FTS5 |
| **Key Files** | `src/corpus-db.js`, `src/ingest.js`, `src/dmm-decoder.js`, `src/parser.js` |

### 2.3 Acquisition Intent Layer

| Property | Value |
|----------|-------|
| **Owns** | Decisions about what content to acquire, when to place, priority ordering |
| **Does NOT own** | Provider API calls, placement execution, lifecycle state |
| **Inputs** | Ranked candidates from Discovery, user configuration |
| **Outputs** | Acquisition orders (what to place, on which provider) |
| **Persistence** | Configuration only (acquisition rules, provider preferences) |
| **Key Files** | Future (not yet implemented) |

### 2.4 Placement Layer

| Property | Value |
|----------|-------|
| **Owns** | Provider selection, placement request initiation, provider resource ID tracking |
| **Does NOT own** | URL resolution, lifecycle state, consumer paths, playback behavior |
| **Inputs** | Acquisition orders, provider configuration |
| **Outputs** | Placement records (provider + resource ID + status) |
| **Persistence** | `placements` table (in Materialization Registry) |
| **Key Files** | Future (not yet implemented) |

### 2.5 Materialization Registry

| Property | Value |
|----------|-------|
| **Owns** | Current playable state (`acquiring`/`available`/`expired`/`repairing`/`failed`), active placement pointer, URL freshness, lifecycle event history |
| **Does NOT own** | Corpus identity (referenced via FK), provider resource IDs (foreign keys only), playback URLs (resolved on demand), consumer paths |
| **Inputs** | Placement records, provider adapter responses, resolver requests |
| **Outputs** | Current lifecycle state, active placement pointer, cached URLs |
| **Persistence** | `placements`, `materialization_state`, `resolved_urls`, `materialization_events` tables |
| **Key Files** | `MATERIALIZATION-REGISTRY-SCHEMA.md` |

### 2.6 Provider Adapter

| Property | Value |
|----------|-------|
| **Owns** | Status → lifecycle state mapping, URL production, URL refresh, failure reason translation, TTL reporting |
| **Does NOT own** | HTTP contract, state machine, Range decision, .strm generation, event logging, identity resolution, lifecycle state |
| **Inputs** | `MediaIdentity` (info_hash, file_index), current `PlayableSource` |
| **Outputs** | `PlayableSource` (url, mode, expires_at), `PlacementStatus` (state, failure_reason) |
| **Persistence** | None (stateless adapter) |
| **Key Files** | `PROVIDER-INTERFACE.md` |

### 2.7 Resolver

| Property | Value |
|----------|-------|
| **Owns** | HTTP endpoint contract (302/200/206/4xx/5xx), URL lifecycle management, state machine execution, Range decision (redirect vs proxy), .strm generation, event logging |
| **Does NOT own** | Provider API calls (delegates to adapter), consumer paths, placement decisions |
| **Inputs** | `GET /media/{info_hash}/{file_index}`, HTTP Range headers |
| **Outputs** | 302 redirect, 200 proxy, 206 partial content, 4xx/5xx error responses |
| **Persistence** | Reads from Materialization Registry; logs events |
| **Key Files** | `RESOLVER-DESIGN.md` |

### 2.8 Consumer Adapter

| Property | Value |
|----------|-------|
| **Owns** | Directory structure, virtual paths, naming conventions, protocol translation (WebDAV, FUSE, .strm) |
| **Does NOT own** | Lifecycle state, placement decisions, provider state, resolver behavior |
| **Inputs** | Resolver endpoint URL, corpus metadata |
| **Outputs** | `.strm` files, WebDAV directory listings, FUSE filesystem interface |
| **Persistence** | Configuration (path templates, naming rules) |
| **Key Files** | Future (not yet implemented) |

### 2.9 Playback Client

| Property | Value |
|----------|-------|
| **Owns** | Media decoding, user interface, library management, seeking behavior |
| **Does NOT own** | Content acquisition, placement, resolution, materialization |
| **Inputs** | `.strm` files, WebDAV/FUSE mounts, HTTP URLs |
| **Outputs** | Audio/video playback |
| **Persistence** | Library database, watch history, user preferences |
| **Key Files** | External (Plex, Jellyfin, Infuse, Kodi) |

---

## 3. Data Flow Between Layers

### 3.1 Query-to-Playback Flow

```
User Query
    │
    ▼
Discovery ──────────▶ Corpus (search for matches)
    │
    ▼
Acquisition Intent ──▶ Corpus (mark candidate for placement)
    │
    ▼
Placement ───────────▶ Provider API (add magnet, select files)
    │
    ▼
Materialization ─────▶ Provider Adapter (resolve URL)
    │
    ▼
Resolver ◀──────────── Consumer (request /media/{hash}/{index})
    │
    ▼
CDN ◀──────────────── Resolver (302 redirect or 200 proxy)
    │
    ▼
Playback Client (stream bytes)
```

### 3.2 URL Refresh Flow

```
URL expires (TTL check)
    │
    ▼
Resolver ───────────▶ Provider Adapter (refresh)
    │
    ▼
Provider API (POST /unrestrict/link)
    │
    ▼
Materialization ─────▶ resolved_urls table (upsert)
    │
    ▼
Resolver ───────────▶ Consumer (serve fresh URL)
```

### 3.3 Provider Failure Flow

```
Provider error (404, 429, 503)
    │
    ▼
Provider Adapter ───▶ Resolver (throw ProviderError)
    │
    ▼
Materialization ─────▶ materialization_state (state = 'failed')
    │                      materialization_events (log failure)
    ▼
Resolver ───────────▶ Alternate placement check
    │
    ├── Found ───────▶ Switch active placement, state = 'acquiring'
    │
    └── Not found ───▶ Return 410 Gone
```

---

## 4. Anti-Boundary Rules

See `CONTRACTS.md` §4 for explicit boundary violations to avoid.

---

## 5. References

- **Architecture:** `MATERIALIZATION-ARCHITECTURE.md`
- **Registry Schema:** `MATERIALIZATION-REGISTRY-SCHEMA.md`
- **Provider Interface:** `PROVIDER-INTERFACE.md`
- **Resolver Design:** `RESOLVER-DESIGN.md`
- **Zurg Analysis:** `ZURG-INTEGRATION-ANALYSIS.md`

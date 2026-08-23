# Anti-Patterns — Do Not Cross These Boundaries

**Date:** 2026-08-23  
**Scope:** Explicit boundary violations to avoid in HashSucker implementation  
**Complements:** `ARCHITECTURE-BOUNDARIES.md` (boundaries), `CONTRACTS.md` (contracts)  
**Constraints:** No code; no schema; anti-pattern documentation only

---

## 1. Identity Boundary Violations

### 1.1 Do Not: Use Provider Resource ID as Identity

**Violation:** Using RD torrent ID (`ABC123DEF456`) as the primary key for content.

**Why it's wrong:**
- Resource IDs are provider-specific (different format for TorBox, Premiumize)
- Resource IDs are mutable (delete and re-add torrent → new ID)
- Resource IDs are not portable across providers

**Correct approach:** Use `(info_hash, file_index_key)` as canonical identity. Store provider resource IDs as foreign keys in `placements` table.

### 1.2 Do Not: Use CDN URL as Identity

**Violation:** Using `https://cdn.rd.com/file.mkv?token=abc` as a stable identifier.

**Why it's wrong:**
- CDN URLs expire in ~24 hours
- CDN URLs are provider-specific
- CDN URLs are token-bound (cannot be reused after expiry)

**Correct approach:** Use `(info_hash, file_index_key)` as identity. Resolve CDN URLs on demand via provider adapter.

### 1.3 Do Not: Use Filesystem Path as Identity

**Violation:** Using `/movies/Movie.Name.2024.mkv` as a stable identifier.

**Why it's wrong:**
- Paths are consumer-specific (Plex wants one structure, Jellyfin another)
- Paths are configurable (user can change naming conventions)
- Paths can collide (same filename for different content)

**Correct approach:** Use `(info_hash, file_index_key)` as identity. Let consumer adapters compute paths from metadata.

---

## 2. Registry Boundary Violations

### 2.1 Do Not: Store Plex Paths in Registry

**Violation:** Adding a `plex_path` column to `materialization_state`.

**Why it's wrong:**
- Plex paths are consumer-layer concern
- Different consumers need different paths
- Paths change when user renames files or changes library structure

**Correct approach:** Store paths in consumer adapter configuration. Registry stores only identity, placement, and lifecycle state.

### 2.2 Do Not: Store CDN URLs as Permanent Records

**Violation:** Storing CDN URLs in a permanent `playback_urls` table without TTL.

**Why it's wrong:**
- CDN URLs expire (~24h)
- Stale URLs cause playback failures
- Permanent storage creates "stale URL" failure mode

**Correct approach:** Cache URLs temporarily in `resolved_urls` with `expires_at`. Refresh on demand. Never treat URLs as permanent.

### 2.3 Do Not: Store Corpus Metadata in Registry

**Violation:** Adding `title`, `year`, `resolution`, `codec` columns to `materialization_state`.

**Why it's wrong:**
- Metadata is corpus-layer concern
- Duplicating metadata creates sync issues
- Metadata changes independently of materialization state

**Correct approach:** Reference corpus tables via foreign key. Join to `candidates` and `release_attributes` when metadata is needed.

### 2.4 Do Not: Store Quality Scores in Registry

**Violation:** Adding a `quality_score` column to `materialization_state`.

**Why it's wrong:**
- Quality is discovery/ranking concern
- Quality scores are derived from release attributes
- Quality is independent of materialization state

**Correct approach:** Compute quality scores in discovery layer. Registry tracks only availability, not quality.

---

## 3. Provider Adapter Boundary Violations

### 3.1 Do Not: Rank Releases in Provider Adapter

**Violation:** Provider adapter chooses between multiple candidates based on quality.

**Why it's wrong:**
- Ranking is upstream of materialization
- Adapter receives an identity; it does not choose between candidates
- Ranking requires corpus metadata; adapter is provider-specific black box

**Correct approach:** Ranking happens in discovery layer. Adapter only resolves URLs for already-chosen content.

### 3.2 Do Not: Parse Filenames in Provider Adapter

**Violation:** Provider adapter extracts title/year/resolution from filenames.

**Why it's wrong:**
- Parsing happened during ingest
- Adapter operates on already-resolved identity
- Parsing is corpus-layer concern

**Correct approach:** Parsing happens in `src/parser.js`. Adapter receives structured identity, not raw filenames.

### 3.3 Do Not: Manage Plex Paths in Provider Adapter

**Violation:** Provider adapter generates Plex-compatible folder structures.

**Why it's wrong:**
- Library layout is consumer concern
- Adapter produces byte sources, not filesystem layouts
- Different consumers need different layouts

**Correct approach:** Adapter returns `PlayableSource` (URL + metadata). Consumer adapter handles path generation.

### 3.4 Do Not: Expose WebDAV from Provider Adapter

**Violation:** Provider adapter implements WebDAV protocol.

**Why it's wrong:**
- WebDAV is consumer transport
- Adapter produces byte sources, not filesystem interfaces
- WebDAV is Phase 2 concern

**Correct approach:** Adapter returns `PlayableSource`. WebDAV adapter (consumer layer) wraps resolver endpoint.

### 3.5 Do Not: Cache URLs Long-Term in Provider Adapter

**Violation:** Provider adapter maintains an in-memory cache of CDN URLs.

**Why it's wrong:**
- URL lifecycle is resolver's responsibility
- Adapter is stateless; caching belongs in registry
- In-memory cache lost on restart

**Correct approach:** Adapter resolves URLs on demand. Resolver caches in `resolved_urls` table with TTL.

### 3.6 Do Not: Handle HTTP Range in Provider Adapter

**Violation:** Provider adapter proxies bytes and handles Range requests.

**Why it's wrong:**
- Range decision is resolver's job
- Adapter returns URL; resolver decides redirect vs proxy
- HTTP semantics are not provider-specific

**Correct approach:** Adapter returns `PlayableSource` with `mode: "redirect" | "proxy"`. Resolver handles Range based on mode.

---

## 4. Resolver Boundary Violations

### 4.1 Do Not: Make Acquisition Decisions in Resolver

**Violation:** Resolver decides what content to place on provider.

**Why it's wrong:**
- Acquisition is upstream of materialization
- Resolver maps identity → URL; it does not choose what to acquire
- Acquisition requires ranking/selection logic

**Correct approach:** Acquisition intent comes from upstream layer. Resolver only serves already-placed content.

### 4.2 Do Not: Call Provider API Directly from Resolver

**Violation:** Resolver calls `POST /unrestrict/link` directly.

**Why it's wrong:**
- Provider API details belong in adapter
- Resolver should be provider-agnostic
- Changing providers requires modifying resolver

**Correct approach:** Resolver calls `provider.resolve()` / `provider.refresh()`. Adapter handles API details.

### 4.3 Do Not: Store Consumer Paths in Resolver

**Violation:** Resolver generates Plex paths or WebDAV paths.

**Why it's wrong:**
- Paths are consumer concern
- Resolver owns HTTP contract, not filesystem layout
- Different consumers need different paths

** **Correct approach:** Resolver returns stable URL. Consumer adapters compute paths.

### 4.4 Do Not: Implement WebDAV in Resolver

**Violation:** Resolver implements PROPFIND, LOCK, UNLOCK methods.

**Why it's wrong:**
- WebDAV is consumer transport
- Resolver is HTTP endpoint, not filesystem
- WebDAV is Phase 2 concern

**Correct approach:** Resolver implements `GET /media/{hash}/{index}`. WebDAV adapter wraps resolver.

---

## 5. Consumer Adapter Boundary Violations

### 5.1 Do Not: Store Consumer Paths in Registry

**Violation:** Consumer adapter writes Plex paths back to materialization registry.

**Why it's wrong:**
- Paths are consumer-specific
- Registry is shared across consumers
- Paths change independently of materialization state

**Correct approach:** Consumer adapter manages its own path configuration. Registry is path-agnostic.

### 5.2 Do Not: Call Provider API from Consumer Adapter

**Violation:** WebDAV adapter calls RD API directly to resolve URLs.

**Why it's wrong:**
- Provider API details belong in adapter
- Consumer adapter should use resolver endpoint
- Couples consumer to specific provider

**Correct approach:** Consumer adapter calls `GET /media/{hash}/{index}`. Resolver handles provider interaction.

### 5.3 Do Not: Generate .strm with CDN URLs

**Violation:** .strm file contains `https://cdn.rd.com/file.mkv?token=abc`.

**Why it's wrong:**
- CDN URLs expire in ~24h
- Expired .strm files cause playback failures
- .strm must be stable forever

**Correct approach:** .strm contains resolver URL (`http://host/media/{hash}/{index}`). Resolver URL is stable; CDN URL is ephemeral.

---

## 6. Corpus Layer Boundary Violations

### 6.1 Do Not: Store Provider State in Corpus Tables

**Violation:** Adding `rd_status`, `rd_resource_id` columns to `candidates` table.

**Why it's wrong:**
- Corpus tables are immutable discovery snapshots
- Provider state is ephemeral and mutable
- Couples discovery to playback availability

**Correct approach:** Store provider state in `placements` table. Reference corpus identity via foreign key.

### 6.2 Do Not: Store Lifecycle State in Corpus Tables

**Violation:** Adding `materialization_state` column to `candidates` table.

**Why it's wrong:**
- Lifecycle state changes frequently
- Corpus tables are append-only evidence
- State machine belongs in materialization registry

**Correct approach:** Store lifecycle state in `materialization_state` table. Reference corpus identity via foreign key.

### 6.3 Do Not: Call Provider API from Ingest Pipeline

**Violation:** `src/ingest.js` calls RD API to check torrent status.

**Why it's wrong:**
- Ingest is discovery-layer concern
- Provider API is materialization-layer concern
- Couples ingestion to playback availability

**Correct approach:** Ingest pipeline stores discovery evidence. Materialization registry tracks provider state separately.

---

## 7. Summary of Forbidden Crossings

| From | To | Forbidden Action |
|------|----|------------------|
| Any layer | Identity | Use provider resource ID, CDN URL, or path as identity |
| Registry | Corpus | Store title, year, resolution, quality scores in registry |
| Registry | Consumer | Store Plex paths, WebDAV paths, .strm contents in registry |
| Registry | Provider | Store permanent CDN URLs in registry |
| Adapter | Discovery | Rank releases, parse filenames, decide quality |
| Adapter | Consumer | Manage Plex paths, expose WebDAV, generate .strm |
| Adapter | Resolver | Cache URLs long-term, handle HTTP Range |
| Resolver | Acquisition | Decide what to place on provider |
| Resolver | Provider | Call provider API directly |
| Resolver | Consumer | Generate Plex paths, implement WebDAV |
| Consumer | Provider | Call provider API directly |
| Consumer | Registry | Write consumer paths back to registry |
| Corpus | Provider | Store provider state or lifecycle state in corpus tables |

---

## 8. References

- **Architecture Boundaries:** `ARCHITECTURE-BOUNDARIES.md`
- **Contracts:** `CONTRACTS.md`
- **Provider Interface:** `PROVIDER-INTERFACE.md` §2
- **Registry Schema:** `MATERIALIZATION-REGISTRY-SCHEMA.md` §8
- **Zurg Analysis:** `ZURG-INTEGRATION-ANALYSIS.md` §4

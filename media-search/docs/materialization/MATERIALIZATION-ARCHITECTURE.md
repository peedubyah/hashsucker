# Media Materialization Architecture

**Date:** 2026-08-23  
**Scope:** Post-acquisition materialization layer for HashSucker  
**References:** Zurg (debridmediamanager/zurg), Plex/Jellyfin library specs, WebDAV (RFC 4918), Real-Debrid API  
**Constraints:** No code changes; no Zurg integration; Zurg treated as architectural reference only

---

## 1. Problem Statement

HashSucker's current pipeline ends at **Placement Observation**:

```
User query → Discovery → Candidate ranking → Confidence/evidence
    → Acquisition intent → Placement → Placement observation
```

But consumers (Plex, Jellyfin, WebDAV clients, .strm players) need something **after** placement observation:

```
Placement observation → ??? → Playback/library consumption
```

This document defines the missing **Materialization Layer**: the contract between "I acquired a thing" and "a media client can play it."

---

## 2. Materialization Requirements

### 2.1 What Media Clients Require

| Consumer | Requirement | Protocol |
|----------|-------------|----------|
| **Plex** | File-system-like access to media files with correct naming/folder structure | Local FS, NFS, SMB, or rclone mount |
| **Jellyfin** | Same as Plex — expects files in library folders with metadata provider IDs | Local FS, NFS, SMB |
| **WebDAV client** | HTTP PROPFIND (directory listing) + GET (file content) with proper `Content-Length`, `Last-Modified`, `Content-Type` | WebDAV (RFC 4918) |
| **.strm (Kodi/Plex)** | A text file containing a single URL pointing to the media file | File with URL inside |
| **Infuse** | WebDAV or SMB server with direct file access | WebDAV/SMB |
| **Direct HTTP player** | A URL that returns the media file with HTTP range support (206 Partial Content) | HTTP/1.1 Range |

### 2.2 Plex Library Expectations

**Movie structure:**
```
/Movies/
  Movie Name (2024) [imdbid-tt1234567]/
    Movie Name (2024) [imdbid-tt1234567].mkv
    Movie Name (2024) [imdbid-tt1234567].srt  (optional subtitle)
```

**TV structure:**
```
/TV Shows/
  Show Name (2020) [tvdbid-123456]/
    Season 01/
      Show Name - S01E01 - Episode Title.mkv
      Show Name - S01E02 - Episode Title.mkv
    Season 02/
      Show Name - S02E01 - Episode Title.mkv
```

**Key requirements:**
- Folder name must include `(year)` for movies
- Metadata provider IDs (`[imdbid-...]`, `[tvdbid-...]`) strongly recommended
- Video file must be a supported container: MKV, MP4, AVI, M4V, MOV, TS, M2TS
- External subtitles: SRT, ASS, SUB, IDX (same base filename as video)
- Plex scans periodically; new files appear after next scan

### 2.3 Jellyfin Library Expectations

Nearly identical to Plex:
- `Movie Name (year)` folder naming
- `[metadata provider id]` optional but recommended
- Same video container support
- External subtitles supported
- Real-time file watching (inotify) — faster detection than Plex polling

### 2.4 WebDAV Requirements

A WebDAV server must implement:

| Method | Purpose | Required Headers |
|--------|---------|------------------|
| `PROPFIND` | Directory listing (files + metadata) | `Depth: 1`, returns XML with `d:multistatus` |
| `GET` | File download | `Content-Length`, `Content-Type`, `Last-Modified`, `ETag` |
| `HEAD` | File metadata without body | Same as GET but no body |
| `OPTIONS` | Advertise WebDAV support | `DAV: 1, 2`, `Allow: OPTIONS, GET, HEAD, PROPFIND` |

**Critical for streaming:** The server **MUST** support `Range` requests (`Accept-Ranges: bytes`, `206 Partial Content`). Without range support, Plex/Jellyfin cannot seek.

### 2.5 .strm Files

A `.strm` file is a plain text file containing a single URL:

```
https://real-debrid.com/dl/abc123/filename.mkv
```

**Plex .strm usage:**
- Place `.strm` file in library folder with proper naming
- Plex reads the URL and streams directly
- No local storage consumed
- URL must be directly playable (not a landing page)

**Kodi .strm usage:**
- Same concept — text file with URL
- Kodi resolves and plays via its player core

### 2.6 HTTP Playback Requirements

For direct HTTP playback (e.g., via .strm or direct URL):

| Requirement | Why |
|-------------|-----|
| `Content-Length` header | Player needs total file size for progress bar |
| `Accept-Ranges: bytes` | Player needs to seek (206 Partial Content) |
| `Content-Type: video/x-matroska` etc. | Player needs MIME type |
| `Content-Disposition: attachment` (optional) | Forces download vs inline |
| Stable URL for duration of playback | URL must not expire mid-stream |
| CDN edge caching | Low-latency delivery |

---

## 3. Current HashSucker Architecture Mapping

### 3.1 Existing Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                     CURRENT PIPELINE                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  User query                                                     │
│      │                                                          │
│      ▼                                                          │
│  Discovery ──→ DMM hashlists (GitHub Trees API)                │
│      │          - infoHash, filename, bytes                     │
│      │                                                          │
│      ▼                                                          │
│  Ingest ──→ SQLite (candidates + release_attributes)           │
│      │       - FTS5 index for text search                       │
│      │       - Identity: (info_hash, file_index_key)            │
│      │                                                          │
│      ▼                                                          │
│  Parse ──→ Filename → structured attributes                    │
│      │      - resolution, source, codec, audio, season/episode  │
│      │                                                          │
│      ▼                                                          │
│  Rank ──→ Composite score (relevance + quality + confidence)   │
│      │     - BM25 from FTS                                      │
│      │     - Deterministic tie-breakers                         │
│      │                                                          │
│      ▼                                                          │
│  Acquisition intent ──→ "I want this specific (hash, file)"    │
│      │                                                          │
│      ▼                                                          │
│  Placement ──→ Provider adapter (e.g., Real-Debrid)            │
│      │         - POST /torrents/addMagnet                       │
│      │         - POST /torrents/selectFiles/{id}                │
│      │                                                          │
│      ▼                                                          │
│  Placement observation ──→ Poll GET /torrents/info/{id}        │
│      │                      - status: downloaded?               │
│      │                      - links[] populated?                │
│      │                                                          │
│      ▼                                                          │
│  ★ END OF CURRENT PIPELINE ★                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 The Missing Layer

```
Placement observation
      │
      ▼
┌─────────────────────────────────────────────────────────────────┐
│                  MISSING: MATERIALIZATION LAYER                 │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. Acquired Media Identity                                     │
│     - What exactly did we get? (hash + file index)              │
│     - Map to corpus candidate for metadata                      │
│                                                                 │
│  2. Provider Resource Mapping                                   │
│     - RD torrent ID → unrestricted link                         │
│     - Link lifecycle (ephemeral? refreshable?)                  │
│                                                                 │
│  3. File Inventory Resolution                                   │
│     - Which file(s) in the torrent?                             │
│     - Size, path, selected status                               │
│                                                                 │
│  4. Playback Locator Generation                                 │
│     - Direct HTTP URL (for .strm / WebDAV)                      │
│     - Virtual filesystem path (for Plex/Jellyfin)               │
│                                                                 │
│  5. Lifecycle State Tracking                                    │
│     - Is the link still valid?                                  │
│     - When does it expire?                                      │
│     - Can it be refreshed?                                      │
│                                                                 │
│  6. Repair / Replacement State                                  │
│     - If link expired, can we get a new one?                    │
│     - If torrent died, can we re-place?                         │
│     - If provider failed, can we switch providers?              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
      │
      ▼
  Playback / Library consumption
```

---

## 4. Required Contracts

### 4.1 Acquired Media Identity

**Question:** Should `infoHash + fileIndex` remain the canonical file identity?

**Answer:** Yes, but with augmentation.

```yaml
acquired_media_identity:
  # Canonical identity (from corpus)
  info_hash: "40-char-hex"          # SHA-1 of torrent info dict
  file_index: integer | null        # null = torrent-level, 0+ = specific file
  
  # Provider placement identity
  provider: "real-debrid" | "torbox" | ...
  provider_resource_id: "opaque-string"  # RD torrent ID, TorBox torrent ID, etc.
  
  # Placement metadata
  placed_at: ISO8601_timestamp
  placement_status: "processing" | "ready" | "failed" | "expired"
  
  # Link to original corpus candidate (for metadata enrichment)
  corpus_candidate_ref: "(info_hash, file_index_key)"
```

**Rationale:**
- `info_hash + file_index` is the **content identity** — it survives provider changes
- `provider_resource_id` is the **placement identity** — it's ephemeral and provider-specific
- Both are needed: content identity for dedup/metadata, placement identity for lifecycle operations

### 4.2 Provider Resource Mapping

**Question:** Are provider resource IDs only external references?

**Answer:** Yes. They are **not** stable content identifiers.

```yaml
provider_resource_mapping:
  provider: "real-debrid"
  resource_id: "ABC123DEF456"          # From addMagnet response
  resource_uri: "https://real-debrid.com/torrent/ABC123DEF456"
  
  # Current state (from polling)
  status: "downloaded"                 # Mapped from RD status strings
  progress: 100                        # 0-100
  
  # Links (populated when ready)
  unrestricted_links:
    - url: "https://hoster.com/file.mkv"
      file_index: 1
      bytes: 123456789
      content_type: "video/x-matroska"
      
  # Lifecycle
  added_at: ISO8601
  completed_at: ISO8601 | null
  expires_at: ISO8601 | null          # If RD has link expiration
```

### 4.3 File Inventory

```yaml
file_inventory:
  torrent_id: "ABC123DEF456"
  files:
    - index: 1
      path: "/Movie.2024.2160p.mkv"
      bytes: 8589934592                  # 8 GB
      selected: true
      unrestricted_url: "https://cdn.rd.com/..."  # null until ready
      
    - index: 2
      path: "/Movie.2024.2160p.nfo"
      bytes: 4096
      selected: false                    # Not selected = not downloaded
      unrestricted_url: null
```

**Key insight:** File selection is mandatory in RD. The adapter must call `selectFiles` after `addMagnet`. The file inventory tells us which files are available for playback.

### 4.4 Playback Locator

**Question:** How should ephemeral provider URLs be represented?

**Answer:** As a **resolvable reference**, not a stored URL.

```yaml
playback_locator:
  # Identity (stable)
  info_hash: "40-char-hex"
  file_index: 1
  
  # Current resolved URL (ephemeral)
  resolved_url: "https://cdn.rd.com/file.mkv?token=abc"
  resolved_at: ISO8601
  expires_at: ISO8601 | null           # If known
  
  # Resolution method
  resolution_method: "on_demand"       # vs "cached" vs "prefetched"
  
  # For WebDAV/virtual filesystem
  virtual_path: "/movies/Movie.2024.2160p.mkv"
  
  # For .strm generation
  strm_content: "https://cdn.rd.com/file.mkv?token=abc"
```

**Critical design decision:** The playback locator should be **resolved on-demand**, not stored. Provider URLs are ephemeral (RD links expire). The contract is: "Given an acquired media identity, produce a playable URL right now."

### 4.5 Lifecycle State

```yaml
lifecycle_state:
  # Current state machine
  state: "acquiring" | "available" | "expired" | "failed" | "repairing"
  
  # State transitions
  # 
  # acquiring → available    (placement complete, links ready)
  # available → expired      (link expired, needs refresh)
  # available → failed       (torrent dead, no seeders)
  # expired   → repairing    (attempting link refresh)
  # failed    → repairing    (attempting re-placement)
  # repairing → available    (success)
  # repairing → failed       (permanent failure)
  
  # History
  state_history:
    - state: "acquiring"
      at: ISO8601
    - state: "available"
      at: ISO8601
      
  # Retry tracking
  repair_attempts: 0
  max_repair_attempts: 3
  last_repair_at: ISO8601 | null
```

### 4.6 Repair / Replacement State

```yaml
repair_state:
  # What failed
  failure_reason: "link_expired" | "torrent_dead" | "provider_error" | "no_seeders"
  
  # Repair strategy
  strategy: "refresh_link" | "re_place" | "switch_provider" | "abandon"
  
  # For switch_provider
  original_provider: "real-debrid"
  replacement_provider: "torbox" | null
  replacement_resource_id: "..." | null
  
  # For re-place (same provider)
  new_resource_id: "..." | null
  
  # Outcome
  repaired: boolean
  repaired_at: ISO8601 | null
```

---

## 5. Architecture Comparison

### 5.1 Zurg-Style Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      ZURG ARCHITECTURE                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Existing RD account                                            │
│      │                                                          │
│      ▼                                                          │
│  Zurg (Go server)                                               │
│      │                                                          │
│      ├──→ WebDAV server (port 9999)                            │
│      │    /dav/ → virtual filesystem                           │
│      │    - Lists RD torrents as folders                        │
│      │    - Files served on-demand via RD unrestricted links    │
│      │    - PROPFIND returns synthetic directory listings       │
│      │    - GET proxies to RD CDN with range support            │
│      │                                                          │
│      ├──→ API server                                            │
│      │    - /api/torrents/list                                  │
│      │    - /api/torrents/{id}/files                            │
│      │    - /api/torrents/{id}/dl                               │
│      │                                                          │
│      └──→ Background sync                                       │
│           - Polls RD /torrents every N seconds                  │
│           - Maintains local cache of torrent metadata           │
│           - Refreshes unrestricted links before expiration       │
│                                                                 │
│      │                                                          │
│      ▼                                                          │
│  Consumer layer                                                 │
│      │                                                          │
│      ├──→ rclone mount (WebDAV → local FS)                     │
│      │    └──→ Plex/Jellyfin library scan                       │
│      │                                                          │
│      ├──→ Infuse (native WebDAV client)                        │
│      │                                                          │
│      └──→ Direct WebDAV clients                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Zurg's key design decisions:**
1. **Virtual filesystem** — RD torrents appear as folders, files appear as regular files
2. **On-demand link resolution** — URLs are generated when a file is accessed, not pre-computed
3. **Background refresh** — Links are refreshed before they expire
4. **WebDAV as the universal protocol** — Works with rclone, Infuse, any WebDAV client
5. **No local storage** — Files are streamed from RD CDN, never written to disk

### 5.2 HashSucker-Style Architecture (Proposed)

```
┌─────────────────────────────────────────────────────────────────┐
│                  HASHSUCKER ARCHITECTURE                        │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  User intent (query)                                            │
│      │                                                          │
│      ▼                                                          │
│  Intelligent acquisition                                        │
│      │                                                          │
│      ├──→ Discovery (DMM hashlists)                            │
│      ├──→ Ranking (composite score)                            │
│      ├──→ Confidence/evidence                                   │
│      └──→ Provider selection (multi-provider)                  │
│                                                                 │
│      │                                                          │
│      ▼                                                          │
│  Placement + Observation                                        │
│      │                                                          │
│      └──→ Provider adapter (RD, TorBox, etc.)                  │
│                                                                 │
│      │                                                          │
│      ▼                                                          │
│  ★ NEW: Materialization contract ★                             │
│      │                                                          │
│      ├──→ Acquired media identity (hash + file index)          │
│      ├──→ Provider resource mapping (ephemeral links)          │
│      ├──→ File inventory (which files are ready)               │
│      ├──→ Playback locator (resolvable URL)                    │
│      ├──→ Lifecycle state (available/expired/repairing)         │
│      └──→ Repair/replacement state                             │
│                                                                 │
│      │                                                          │
│      ▼                                                          │
│  Consumer interface (pluggable)                                 │
│      │                                                          │
│      ├──→ WebDAV server (for Plex/Jellyfin via rclone)         │
│      ├──→ .strm generator (for Kodi/direct playback)           │
│      ├──→ HTTP proxy (for direct URL playback)                 │
│      └──→ Virtual FS mount (for local library scan)            │
│                                                                 │
│      │                                                          │
│      ▼                                                          │
│  Plex / Jellyfin / Infuse / Kodi / etc.                        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 5.3 What to Borrow from Zurg

| Zurg Feature | Borrow? | Notes |
|--------------|---------|-------|
| WebDAV as universal interface | **Yes** | Cleanest way to serve to multiple consumers |
| On-demand link resolution | **Yes** | URLs are ephemeral; resolve at access time |
| Background link refresh | **Yes** | Prevents mid-playback expiration |
| Virtual filesystem abstraction | **Yes** | Decouples provider from consumer |
| rclone integration | **Yes** | Battle-tested WebDAV→FS bridge |
| Go implementation | **No** | Use Node.js (HashSucker's language) |
| RD-specific caching layer | **No** | Abstract to multi-provider |
| Pre-built Docker image | **Maybe** | Nice-to-have, not core |

### 5.4 What Should Remain Custom

| HashSucker Feature | Why Custom |
|--------------------|------------|
| Intent-driven acquisition | Zurg has no acquisition logic — it just mirrors existing RD library |
| Multi-provider support | Zurg is RD-only; HashSucker should abstract providers |
| Corpus-backed metadata | Zurg has no metadata enrichment; HashSucker has parsed release attributes |
| Confidence/evidence scoring | Zurg has no ranking; HashSucker has composite scoring |
| Repair lifecycle | Zurg has no repair concept; HashSucker needs it for reliability |

---

## 6. Focus Areas

### 6.1 Repair Lifecycle

**Problem:** Links expire. Torrents die. Providers fail.

**Required repair flows:**

```
Link expired:
  1. Detect expiration (404/403 on access, or proactive TTL check)
  2. Call POST /unrestrict/link again with original hoster link
  3. Update playback_locator.resolved_url
  4. Resume playback

Torrent dead (no seeders):
  1. Detect via status=dead or no progress for N hours
  2. Re-place: POST /torrents/addMagnet with same magnet link
  3. Wait for new torrent to complete
  4. Update provider_resource_id and links

Provider failure (rate limit, auth error):
  1. Detect via 429/401/403
  2. Switch to alternate provider (TorBox, etc.)
  3. Re-place on new provider
  4. Update provider + resource ID
```

**State machine:**

```
                    ┌──────────────┐
                    │  acquiring   │
                    └──────┬───────┘
                           │ placement complete
                           ▼
                    ┌──────────────┐
            ┌───────│  available   │◄──────────────┐
            │       └──────┬───────┘               │
            │              │                        │
     link expired    torrent dead            repair success
            │              │                        │
            ▼              ▼                        │
     ┌─────────────┐ ┌──────────┐                  │
     │  repairing  │→│  failed  │                  │
     └──────┬──────┘ └──────────┘                  │
            │                                       │
            └───────────────────────────────────────┘
```

### 6.2 Stale Link Handling

**Problem:** RD unrestricted links expire (typically 24-72 hours, but not documented).

**Strategies:**

| Strategy | Pros | Cons |
|----------|------|------|
| **Refresh on access** | Always fresh | Adds latency to first access |
| **Background refresh** | No latency hit | Wastes API calls on unused links |
| **TTL-based refresh** | Predictable | Need to know expiration window |
| **Lazy refresh + retry** | Efficient | May fail mid-playback |

**Recommendation:** Hybrid approach:
- Track `resolved_at` and assume 24h TTL
- Background refresh when TTL < 2h remaining
- On access, if link is expired, refresh synchronously and retry

### 6.3 Provider Replacement

**Problem:** A provider may not have the content, or may fail permanently.

**Contract:**

```yaml
provider_replacement:
  # Original placement
  original:
    provider: "real-debrid"
    resource_id: "ABC123"
    info_hash: "..."
    file_index: 1
    
  # Replacement (if original failed)
  replacement:
    provider: "torbox"
    resource_id: "TB-456"
    info_hash: "..."        # Same content, different provider
    file_index: 1
    
  # Selection logic
  selection_strategy: "failover"  | "load_balance" | "cost_optimized"
  
  # Failover order
  provider_priority:
    - "real-debrid"
    - "torbox"
    - "premiumize"
```

**Key insight:** `info_hash + file_index` is the **portable identity**. Provider resource IDs are not. The materialization layer must be able to say: "I want to play (hash=abc, file=1)" and have it resolve to whatever provider currently has that content.

### 6.4 Duplicate Media Handling

**Problem:** Same content may exist in multiple torrents (different releases, different providers).

**Contract:**

```yaml
duplicate_media:
  # Content identity (what the user wants)
  content_identity:
    title: "Movie Name"
    year: 2024
    resolution: "2160p"
    source: "BluRay"
    
  # All known placements of this content
  placements:
    - provider: "real-debrid"
      info_hash: "abc123"
      file_index: 1
      resource_id: "RD-001"
      status: "available"
      link_quality: "original"  # vs "transcoded"
      
    - provider: "torbox"
      info_hash: "abc123"       # Same hash = same torrent
      file_index: 1
      resource_id: "TB-001"
      status: "available"
      
    - provider: "real-debrid"
      info_hash: "def456"       # Different torrent, same content
      file_index: 2
      resource_id: "RD-002"
      status: "available"
      
  # Selection
  preferred_placement: 0  # Index into placements array
  selection_reason: "provider_priority" | "link_freshness" | "quality"
```

### 6.5 Multi-Provider Support

**Goal:** Avoid provider-specific lock-in.

**Abstraction:**

```yaml
provider_capabilities:
  real-debrid:
    supports_cache_check: false
    supports_placement: true
    supports_file_selection: true
    supports_link_refresh: true
    link_ttl_hours: 24  # Inferred
    rate_limit: "250/min"
    
  torbox:
    supports_cache_check: true   # TorBox has /torrents/checkcached
    supports_placement: true
    supports_file_selection: true
    supports_link_refresh: true
    link_ttl_hours: 168  # 1 week (documented)
    rate_limit: "100/min"
```

**Materialization layer must:**
1. Abstract provider differences behind a common interface
2. Allow runtime provider selection
3. Track which provider has which content
4. Failover between providers transparently

---

## 7. Proposed Generic Materialization Contract

### 7.1 Core Interface

```yaml
# The materialization contract — what HashSucker exposes after acquisition

MaterializationService:
  # Input: What the user wants
  input:
    content_query: "Movie Name 2024 2160p"
    content_identity: (info_hash, file_index) | null  # If known
    
  # Output: How to play it
  output:
    playback_locator:
      resolved_url: "https://cdn.rd.com/file.mkv?token=abc"
      virtual_path: "/movies/Movie.Name.2024.2160p.mkv"
      strm_content: "https://cdn.rd.com/file.mkv?token=abc"
      
    metadata:
      title: "Movie Name"
      year: 2024
      resolution: "2160p"
      source: "BluRay"
      codec: "x265"
      audio: "DTS-HD"
      duration_seconds: 7200
      bytes: 8589934592
      
    lifecycle:
      state: "available"
      resolved_at: ISO8601
      expires_at: ISO8601 | null
      repair_available: true
```

### 7.2 The Resolver Endpoint

The materialization layer's core abstraction is a **stable HTTP resolver endpoint**:

```
GET /media/{content_identity}
        │
        ▼
materialization resolver
        │
        ├── check lifecycle
        ├── refresh link if needed
        ├── choose provider
        └── stream bytes
```

All consumers — `.strm`, WebDAV, FUSE — point to this stable URL. The resolver handles:
- **Content identity resolution** — `(info_hash, file_index)` → current provider placement
- **Lifecycle check** — Is the media available, expired, or failed?
- **Link refresh** — If expired, re-resolve before streaming
- **Provider selection** — Choose the best provider based on availability/freshness/priority
- **Byte streaming** — Stream bytes from the resolved CDN URL with range support

The resolver URL is **stable** even though the underlying CDN URL is ephemeral. Consumers never see provider URLs directly.

### 7.3 Consumer Adapters

Each consumer type binds to the resolver endpoint, not to provider URLs:

```yaml
StrmAdapter:
  # Generates .strm files for Kodi/Plex
  # Contains a stable URL: http://hashsucker:port/media/{info_hash}/{file_index}
  # The .strm is stable even when the underlying CDN URL changes
  
WebDAVAdapter:
  # Implements WebDAV protocol over the resolver endpoint
  # PROPFIND → list virtual directories
  # GET → internally calls /media/{content_identity} and streams result
  # .strm files and WebDAV GET both resolve through the same endpoint
  
VirtualFsAdapter:
  # FUSE or similar virtual filesystem
  # Presents materialized media as local files
  # On read, calls GET /media/{content_identity} and streams
  
HttpProxyAdapter:
  # Optional: HTTP proxy that wraps the resolver
  # Same as the resolver endpoint but with additional auth/rate-limiting
```

**Key insight:** The `.strm` file is not the abstraction — it is one consumer of the abstraction. All consumers share the same resolver endpoint.

### 7.4 State Model

```
┌─────────────────────────────────────────────────────────────────┐
│                    MATERIALIZATION STATE MODEL                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Content Identity (stable)                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ info_hash + file_index + corpus metadata                 │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │                                      │
│                          ▼                                      │
│  Placement (provider-specific, ephemeral)                       │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ provider + resource_id + status + links[]                │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │                                      │
│                          ▼                                      │
│  Playback Locator (resolved on-demand)                          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ resolved_url + virtual_path + strm_content + expires_at  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │                                      │
│                          ▼                                      │
│  Lifecycle (state machine)                                      │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ acquiring → available → expired → repairing → available  │  │
│  │                    ↓                                     │  │
│  │                  failed                                  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 8. Recommended Minimal Implementation Scope

### Phase 1: Core Contract + Resolver Endpoint (Required)

| Component | Scope | Effort |
|-----------|-------|--------|
| **Acquired media identity** | `info_hash + file_index + provider + resource_id` | Low |
| **Playback locator** | On-demand URL resolution from provider | Medium |
| **Lifecycle state** | Track `acquiring/available/expired/failed` | Low |
| **Resolver endpoint** | `GET /media/{content_identity}` — stable URL, resolves and streams | Medium |
| **.strm adapter (optional)** | Write `.strm` files pointing to resolver endpoint | Low |

The resolver endpoint is the **single source of truth** for all consumers. It:
1. Accepts `GET /media/{info_hash}/{file_index}`
2. Checks lifecycle state
3. Refreshes link if expired
4. Chooses best provider
5. Streams bytes from the resolved CDN URL with range support

The `.strm` file is just one consumer — it contains the resolver URL, not the CDN URL.

### Phase 2: WebDAV Adapter (Recommended)

| Component | Scope | Effort |
|-----------|-------|--------|
| **WebDAV protocol** | PROPFIND + GET with range support | Medium |
| **Virtual directory structure** | Map acquired media to Plex/Jellyfin naming | Medium |
| **Resolver integration** | WebDAV GET delegates to resolver endpoint | Low |
| **rclone integration** | Document rclone mount config | Low |

WebDAV GET internally calls the resolver endpoint. The virtual filesystem is a view over the same resolver.

### Phase 3: FUSE/VFS (If Real Need)

| Component | Scope | Effort |
|-----------|-------|--------|
| **FUSE mount** | Present materialized media as local files | High |
| **Resolver integration** | FUSE read delegates to resolver endpoint | Low |

Only build if there is a real need that WebDAV cannot serve. FUSE adds significant complexity (kernel module, platform-specific behavior).

### Phase 4: Repair Lifecycle (Recommended)

| Component | Scope | Effort |
|-----------|-------|--------|
| **Link refresh** | Detect expired links, re-call unrestrict | Low |
| **Re-placement** | Detect dead torrents, re-add magnet | Medium |
| **Provider failover** | Switch provider on permanent failure | Medium |
| **Background refresh** | Proactive link refresh before expiration | Low |

### Phase 5: Multi-Provider (Future)

| Component | Scope | Effort |
|-----------|-------|--------|
| **Provider abstraction** | Common interface for RD/TorBox/etc. | Medium |
| **Provider selection** | Priority-based with failover | Medium |
| **Duplicate detection** | Same content across providers | High |
| **Cost optimization** | Choose cheapest provider | High |

---

## 9. Things NOT Worth Building

| Feature | Why Not |
|---------|---------|
| **Local file cache** | Defeats the purpose of debrid services; storage is expensive |
| **Transcoding** | Plex/Jellyfin handle this; don't duplicate |
| **Full metadata agent** | Plex/Jellyfin have their own metadata agents |
| **Download manager** | RD/TorBox handle downloads; we just place and observe |
| **BitTorrent client** | Debrid services are the torrent client |
| **VPN/proxy layer** | User's responsibility; out of scope |
| **Multi-user support** | Single-user assumption is fine for now |
| **Web UI for materialization** | CLI is sufficient; Plex/Jellyfin are the UI |
| **Real-time notifications** | Polling is sufficient; no webhooks available from RD |
| **Zurg-compatible WebDAV** | Don't need 100% compatibility; just need Plex/Jellyfin to work |

---

## 10. Summary

### Key Insights

1. **The materialization layer is a resolver, not a store.** It maps `(info_hash, file_index)` → playable URL on-demand via a stable `GET /media/{content_identity}` endpoint.

2. **Provider resource IDs are ephemeral.** Only `info_hash + file_index` is stable across providers.

3. **The resolver endpoint is the universal abstraction.** One stable URL serves `.strm` files, WebDAV GET, FUSE reads, and direct HTTP playback. Consumers never see provider URLs directly.

4. **The `.strm` file is not the abstraction — it is a consumer.** It contains the resolver URL, not the CDN URL.

5. **Links expire.** The layer must handle refresh transparently.

6. **Repair is a first-class concern.** Link refresh, re-placement, and provider failover are core features.

7. **Zurg solves the same problem but differently.** Zurg mirrors an existing RD library; HashSucker intelligently acquires then materializes.

### Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        HASHSUCKER MATERIALIZATION                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│   User Intent                                                           │
│       │                                                                 │
│       ▼                                                                 │
│   ┌──────────────┐     ┌──────────────────────────────────────────────┐ │
│   │  Acquisition │────→│         MATERIALIZATION LAYER                │ │
│   │  (existing)  │     │                                              │ │
│   └──────────────┘     │  ┌────────────────────────────────────────┐  │ │
│                        │  │  Acquired Media Identity               │  │ │
│                        │  │  (info_hash, file_index, provider,     │  │ │
│                        │  │   resource_id, status)                 │  │ │
│                        │  └──────────────────┬─────────────────────┘  │ │
│                        │                     │                        │ │
│                        │                     ▼                        │ │
│                        │  ┌────────────────────────────────────────┐  │ │
│                        │  │  Playback Locator                      │  │ │
│                        │  │  (resolved_url, virtual_path,          │  │ │
│                        │  │   strm_content, expires_at)            │  │ │
│                        │  └──────────────────┬─────────────────────┘  │ │
│                        │                     │                        │ │
│                        │                     ▼                        │ │
│                        │  ┌────────────────────────────────────────┐  │ │
│                        │  │  Lifecycle Manager                     │  │ │
│                        │  │  (state machine, repair, refresh)      │  │ │
│                        │  └──────────────────┬─────────────────────┘  │ │
│                        │                     │                        │ │
│                        └─────────────────────┼────────────────────────┘ │
│                                              │                          │
│                                              ▼                          │
│                              ┌───────────────────────────────────────┐  │
│                              │     RESOLVER ENDPOINT                 │  │
│                              │     GET /media/{content_identity}     │  │
│                              │     (stable URL, streams bytes)       │  │
│                              └───────────────────┬───────────────────┘  │
│                                                  │                      │
│                          ┌───────────────────────┼───────────────────┐  │
│                          │                       │                   │  │
│                          ▼                       ▼                   ▼  │
│                   ┌────────────┐          ┌────────────┐     ┌────────┐│
│                   │   WebDAV   │          │   .strm    │     │  HTTP  ││
│                   │   Server   │          │  Files     │     │  Play  ││
│                   └─────┬──────┘          └─────┬──────┘     └───┬────┘│
│                         │                      │                │     │
│                         ▼                      ▼                ▼     │
│                   ┌──────────┐          ┌──────────┐      ┌──────────┐  │
│                   │  Plex    │          │   Kodi   │      │  Direct  │  │
│                   │Jellyfin  │          │  .strm   │      │  Player  │  │
│                   │ Infuse   │          │  files   │      │          │  │
│                   └──────────┘          └──────────┘      └──────────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 11. References

- **Zurg:** debridmediamanager/zurg-public — Real-Debrid WebDAV server
- **Plex naming:** support.plex.tv/articles/naming-and-organizing-your-movie-media-files/
- **Jellyfin naming:** jellyfin.org/docs/general/server/media/movies/
- **WebDAV:** RFC 4918 — Web Distributed Authoring and Versioning
- **Real-Debrid API:** api.real-debrid.com (documented in REALDEBRID-EXECUTION-STRUCTURE.md)
- **rclone:** rclone.org — WebDAV to filesystem mount

# Contracts — HashSucker Layer Interfaces

**Date:** 2026-08-23  
**Scope:** Stable contracts extracted from existing architecture documents  
**Complements:** `ARCHITECTURE-BOUNDARIES.md` (boundaries), `STATE-MACHINE-REFERENCE.md` (lifecycle states)  
**Constraints:** No code; no schema; contract documentation only

---

## 1. Identity Contract

### 1.1 Definition

```
MediaIdentity:
  info_hash: string          # 40-char lowercase hex SHA-1
  file_index: integer | null # null = torrent-level identity
  file_index_key: integer    # -1 when file_index is NULL (SQLite convention)
```

### 1.2 Owner

**Corpus Evidence Layer** — defines and validates identity semantics.

### 1.3 Used By

| Layer | Usage |
|-------|-------|
| Acquisition Intent | Selects content for placement |
| Placement | Creates placement records keyed by identity |
| Materialization Registry | References identity via foreign key |
| Provider Adapter | Receives identity for resolve/refresh/getStatus |
| Resolver | Maps identity → placement → URL |

### 1.4 Validation Rules

- `info_hash`: 40-character lowercase hex string (SHA-1)
- `file_index`: null or integer ≥ 0
- `file_index_key`: -1 when `file_index` is null; equals `file_index` otherwise

### 1.5 Never Replaced By

| Not Identity | Why |
|--------------|-----|
| Provider resource IDs | Opaque, provider-specific, mutable |
| CDN URLs | Ephemeral, expires in ~24h |
| Filesystem paths | Consumer-specific, configurable |
| Surrogate UUIDs | Add indirection without value in single-resolver system |

### 1.6 Source

`HANDOFF.md` §1, `MATERIALIZATION-REGISTRY-SCHEMA.md` §3.1, `PROVIDER-INTERFACE.md` §3.3

---

## 2. Corpus Evidence Projection Contracts

### 2.1 Persistence Projection (2O)

```
PersistenceFeatures:
  identity: { infoHash: string, fileIndex: number }
  temporal: {
    firstObserved: number|null,
    lastObserved: number|null,
    ageMs: number|null
  }
  persistence: {
    versionsObserved: number,
    versionsAvailable: number,
    survivalRate: number|null
  }
  lifecycle: {
    currentlyPresent: boolean,
    addedCount: number,
    removedCount: number,
    churnCount: number
  }
```

**Input:** Corpus version history (`versions.getVersionHistory()`, `candidates`, `corpus_observations`)

**Output:** Normalized persistence features describing how a candidate survived across corpus snapshots

**Owner:** Corpus Evidence Layer (Discovery)

**Contract:**
- Pure read-only query over existing tables
- No schema additions
- No UPDATE/DELETE on any table
- Deterministic output
- Safe when no history exists

### 2.2 Topology Projection (2P)

```
TopologyFeatures:
  identity: { infoHash: string, fileIndex: number }
  files: {
    totalFiles: number,
    mediaFiles: number,
    nonMediaFiles: number,
    videoFiles: number,
    subtitleFiles: number,
    archiveFiles: number
  }
  structure: {
    singleFileMedia: boolean,
    hasExtras: boolean,
    hasSamples: boolean,
    hasSeasonStructure: boolean,
    largestFileRatio: number|null
  }
  quality: {
    likelyPlayableTarget: boolean,
    topologyConfidence: number|null,
    warnings: string[]
  }
```

**Input:** `candidates` table (all file indexes for info_hash), `release_attributes` table

**Output:** Normalized topology features describing file composition and structural patterns

**Owner:** Corpus Evidence Layer (Discovery)

**Contract:**
- Pure read-only query over existing tables
- No schema additions
- No UPDATE/DELETE on any table
- Classifies files by extension (video, subtitle, archive, audio, image, nfo)
- Detects samples, extras, season structure
- Deterministic output
- Safe when no candidate or attribute data exists
- Preserves file_index null vs 0 identity distinction

### 2.3 Confidence Projection (2Q)

```
ConfidenceFeatures:
  identity: { infoHash: string, fileIndex: number, fileIndexKey: number }
  evidence: {
    persistence: PersistenceFeatures,
    topology: TopologyFeatures,
    metadata: { ReleaseAttributes: Array }
  }
  confidence: {
    overall: number,  // 0-1 weighted score
    components: {
      persistence: number,  // weight: 0.40
      topology: number,     // weight: 0.40
      metadata: number      // weight: 0.20
    }
  }
  warnings: string[]
```

**Input:** Persistence features + Topology features + Release attributes

**Output:** Weighted confidence score answering "How confident are we that this identity represents the intended playable media object?"

**Owner:** Corpus Evidence Layer (Discovery)

**Confidence model:**
- `overall = persistence * 0.40 + topology * 0.40 + metadata * 0.20`
- Persistence: survival rate (0-60%), current presence (0-25%), version observations (0-15%)
- Topology: base confidence + playable target bonus - sample penalty - multiple video penalty - non-media penalty
- Metadata: fraction of populated fields (media_type, resolution, codec, audio, source_type, release_group, language)

**Warnings:**
- `corpus_not_persistent`: survivalRate < 0.5
- `sample_present`: topology has samples
- `multiple_video_candidates`: more than 1 video file
- `low_topology_confidence`: topologyConfidence < 0.4
- `no_files`: topology has no files
- `missing_metadata`: no release attributes found

**Contract:**
- Pure read-only combination of 2O + 2P + metadata
- No ML, no learned scoring
- Deterministic output
- Safe when no evidence exists

### 2.4 Implementation Location

All three projections are implemented in `Docs/corpus docs.js`:

| Projection | Export | Status |
|------------|--------|--------|
| 2O — Persistence | `createCorpusPersistenceFeatures(versions)` | Implemented |
| 2P — Topology | `createCorpusTopologyFeatures(cache)` | Implemented |
| 2Q — Confidence | `createCorpusConfidenceFeatures({ cache, versions })` | Implemented |

### 2.5 Source

`Docs/corpus docs.js` (corpus evidence projection implementations)

---

## 2. Placement Contract

### 2.1 Definition

```
Placement:
  placement_id: UUID
  info_hash: string          # FK → candidates
  file_index_key: integer    # FK → candidates
  provider: string           # "real-debrid", "torbox", etc.
  provider_resource_id: string # Opaque provider-side ID
  status: "pending" | "complete" | "failed"
  created_at: ISO8601
  updated_at: ISO8601
```

### 2.2 Input

`MediaIdentity` (from Acquisition Intent layer)

### 2.3 Output

| Field | Description |
|-------|-------------|
| `provider` | Which provider holds this content |
| `provider_resource_id` | Opaque provider-side identifier |
| `status` | Provider-facing placement status |

### 2.4 Owner

**Placement Layer** — creates and manages placement records.

### 2.5 Used By

| Layer | Usage |
|-------|-------|
| Materialization Registry | Stores placement records |
| Provider Adapter | Uses `provider_resource_id` to resolve/refresh URLs |
| Resolver | Reads active placement for playback |

### 2.6 Semantics

- **One identity, many placements:** Multiple providers can hold the same content
- **One active placement:** Only one placement is used for playback at a time
- **Provider resource ID is opaque:** Registry does not parse or interpret it

### 2.7 Source

`MATERIALIZATION-REGISTRY-SCHEMA.md` §3.2

---

## 3. Playable Source Contract

### 3.1 Definition

```
PlayableSource:
  url: string                # CDN URL (ephemeral)
  mode: "redirect" | "proxy" # Does CDN support Range?
  expires_at: ISO8601        # URL expiry timestamp
  bytes: integer | null      # File size (if known)
  content_type: string | null # MIME type (if known)
```

### 3.2 Input

`MediaIdentity` (from resolver)

### 3.3 Output

| Field | Description |
|-------|-------------|
| `url` | CDN URL for playback (expires in ~24h) |
| `mode` | Whether to 302 redirect or 200 proxy |
| `expires_at` | When this URL becomes invalid |

### 3.4 Owner

**Provider Adapter** — produces and refreshes playable sources.

### 3.5 Used By

| Layer | Usage |
|-------|-------|
| Resolver | Serves URL to client (redirect or proxy) |
| Materialization Registry | Caches URL temporarily in `resolved_urls` |

### 3.6 Semantics

- **URL is ephemeral:** ~24h TTL, token-bound, provider-specific
- **Mode determines HTTP behavior:** `redirect` = 302 to CDN; `proxy` = resolver streams bytes
- **TTL is provider-reported:** Each provider may have different URL lifetime

### 3.7 Source

`PROVIDER-INTERFACE.md` §3.3

---

## 4. Materialization State Contract

### 4.1 Definition

```
MaterializationState:
  info_hash: string          # PK, FK → candidates
  file_index_key: integer    # PK, FK → candidates
  active_placement_id: UUID  # FK → placements (nullable)
  state: "acquiring" | "available" | "expired" | "repairing" | "failed"
  resolved_at: ISO8601 | null
  expires_at: ISO8601 | null
  failure_reason: string | null
  retry_count: integer
  max_retries: integer
  created_at: ISO8601
  updated_at: ISO8601
```

### 4.2 Input

- Placement status (from provider adapter)
- Resolver requests (triggers refresh, state transitions)

### 4.3 Output

| Field | Description |
|-------|-------------|
| `state` | Current lifecycle position |
| `active_placement_id` | Which placement is used for playback |
| `resolved_at` / `expires_at` | URL freshness window |
| `failure_reason` | Canonical failure reason (if failed) |

### 4.4 Owner

**Materialization Registry** — owns lifecycle state.

### 4.5 Used By

| Layer | Usage |
|-------|-------|
| Resolver | Checks state before serving content |
| Repair Orchestrator (future) | Queries failed states for repair |

### 4.6 Semantics

- **State is identity-centric, not placement-centric:** If one placement works, state is `available`
- **Active placement is the pointer to current provider**
- **Failure reason is canonical:** Provider-specific codes translated to uniform values

### 4.7 Source

`MATERIALIZATION-REGISTRY-SCHEMA.md` §3.3, `RESOLVER-DESIGN.md` §4

---

## 5. Playback Contract

### 5.1 Definition

```
PlaybackRequest:
  info_hash: string          # From URL
  file_index: integer | null # From URL (~ = null)
  range: string | null       # HTTP Range header

PlaybackResponse:
  status: 302 | 200 | 206 | 4xx | 5xx
  location: string | null    # CDN URL (for 302)
  body: stream | null        # Byte stream (for 200/206)
  headers: map               # Content-Type, Accept-Ranges, etc.
```

### 5.2 Input

`GET /media/{info_hash}/{file_index}` (from consumer)

### 5.3 Output

| Response | Meaning |
|----------|---------|
| 302 Found | Redirect to CDN URL (preferred) |
| 200 OK | Proxied bytes (fallback when CDN lacks Range) |
| 206 Partial Content | Proxied bytes with Range (seeking) |
| 404 Not Found | Unknown identity |
| 410 Gone | Permanent failure |
| 423 Locked | Repair in progress |
| 429 Too Many Requests | Rate limited |
| 502 Bad Gateway | Provider error |
| 503 Service Unavailable | Acquiring (not yet ready) |
| 504 Gateway Timeout | Provider timeout |

### 5.4 Owner

**Resolver** — owns the HTTP contract.

### 5.5 Used By

| Layer | Usage |
|-------|-------|
| Consumer Adapters | Point clients to resolver endpoint |
| Playback Clients | Receive bytes or follow redirect |

### 5.6 Semantics

- **Stable URL:** `GET /media/{info_hash}/{file_index}` never changes
- **Ephemeral target:** CDN URL changes on refresh
- **Range support:** 302 passthrough or proxy seek

### 5.7 Source

`RESOLVER-DESIGN.md` §2

---

## 6. .strm Contract

### 6.1 Definition

```
StrmFile:
  path: string               # Consumer library path
  content: string            # Single line: resolver URL
```

### 6.2 Input

`MediaIdentity` + resolver base URL

### 6.3 Output

File content: `http://hashsucker:port/media/{info_hash}/{file_index}`

### 6.4 Owner

**Consumer Adapter** (.strm generator)

### 6.5 Semantics

- **Contains resolver URL, not CDN URL** — resolver URL is stable forever
- **Never needs updating** — even when CDN URL changes
- **One .strm per playable file** — consumer decides naming and placement

### 6.6 Source

`RESOLVER-DESIGN.md` §8

---

## 7. Event Contract

### 7.1 Definition

```
MaterializationEvent:
  event_id: UUID
  event_type: "state_transition" | "refresh_attempt" | "repair_attempt" | "placement_switch"
  timestamp: ISO8601
  info_hash: string
  file_index_key: integer
  from_state: string | null
  to_state: string
  trigger: string
  provider: string | null
  resource_id: string | null
  placement_id: UUID | null
  failure_reason: string | null
```

### 7.2 Input

State transitions in materialization lifecycle

### 7.3 Output

Append-only event record

### 7.4 Owner

**Materialization Registry** — logs all state transitions

### 7.5 Used By

| Layer | Usage |
|-------|-------|
| Repair Orchestrator (future) | Consumes events to trigger repair |
| Observability (future) | Debugging, monitoring, analytics |

### 7.6 Semantics

- **Append-only:** No updates, no deletes
- **Immutable history:** Audit trail of all transitions
- **Identity + provider context:** Every event links to identity and provider

### 7.7 Source

`MATERIALIZATION-REGISTRY-SCHEMA.md` §5

---

## 8. URL Cache Contract

### 8.1 Definition

```
ResolvedUrl:
  info_hash: string          # PK, FK → candidates
  file_index_key: integer    # PK, FK → candidates
  placement_id: UUID         # FK → placements
  resolved_url: string       # CDN URL
  resolved_at: ISO8601
  expires_at: ISO8601
  bytes: integer | null
  content_type: string | null
```

### 8.2 Input

`PlayableSource` (from provider adapter)

### 8.3 Output

Cached CDN URL with TTL

### 8.4 Owner

**Materialization Registry** — caches URLs temporarily

### 8.5 Used By

| Layer | Usage |
|-------|-------|
| Resolver | Checks cache before calling provider |

### 8.6 Semantics

- **Temporary cache:** URLs expire (default ~24h TTL)
- **Performance optimization:** Avoids provider API calls on every request
- **Not authoritative:** If cache is stale, resolver calls provider adapter

### 8.7 Source

`MATERIALIZATION-REGISTRY-SCHEMA.md` §3.4

---

## 9. Provider Error Contract

### 9.1 Definition

```
ProviderError (base):
  code: string
  message: string

AuthError:
  code: "auth_error"

RateLimitError:
  code: "rate_limited"
  retry_after: integer

NotFoundError:
  code: "not_found"

ProviderError:
  code: "provider_error"
```

### 9.2 Input

Provider API failures

### 9.3 Output

Canonical error classification

### 9.4 Owner

**Provider Adapter** — translates provider-specific errors to canonical errors

### 9.5 Used By

| Layer | Usage |
|-------|-------|
| Resolver | Maps errors to HTTP status codes |

### 9.6 Semantics

- **Provider-agnostic:** All adapters throw same error types
- **Determines HTTP response:** AuthError → 410, RateLimitError → 429, etc.

### 9.7 Source

`PROVIDER-INTERFACE.md` §3.3

---

## 11. Contract Summary

| Contract | Owner | Input | Output |
|----------|-------|-------|--------|
| Identity | Corpus | DMM payloads | `(info_hash, file_index_key)` |
| Persistence (2O) | Discovery | Corpus version history | Temporal, persistence, lifecycle features |
| Topology (2P) | Discovery | Candidates + release_attributes | File composition, structure, quality |
| Confidence (2Q) | Discovery | 2O + 2P + metadata | Weighted confidence score |
| Placement | Placement Layer | `MediaIdentity` | Provider + resource ID |
| Playable Source | Provider Adapter | `MediaIdentity` | CDN URL + TTL |
| Materialization State | Registry | Placement status | Lifecycle state |
| Playback | Resolver | `GET /media/...` | 302/200/206/4xx/5xx |
| .strm | Consumer Adapter | `MediaIdentity` | Resolver URL file |
| Event | Registry | State transitions | Append-only log |
| URL Cache | Registry | `PlayableSource` | Temporary CDN URL |
| Provider Error | Provider Adapter | Provider API failure | Canonical error |

---

## 12. References

- **Architecture:** `MATERIALIZATION-ARCHITECTURE.md`
- **Registry Schema:** `MATERIALIZATION-REGISTRY-SCHEMA.md`
- **Provider Interface:** `PROVIDER-INTERFACE.md`
- **Resolver Design:** `RESOLVER-DESIGN.md`
- **Corpus Evidence:** `Docs/corpus docs.js`

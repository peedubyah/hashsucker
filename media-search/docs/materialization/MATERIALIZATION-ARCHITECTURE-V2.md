# Media Materialization Architecture V2

**Date:** 2026-08-23
**Status:** Canonical — supersedes MATERIALIZATION-ARCHITECTURE.md
**Scope:** Post-acquisition materialization layer for HashSucker, reflecting the actual control-plane implementation
**References:** ARCHITECTURE-BOUNDARIES.md, CONTRACTS.md, STATE-MACHINE-REFERENCE.md, MATERIALIZATION-REGISTRY-SCHEMA.md, PROVIDER-INTERFACE.md, RESOLVER-DESIGN.md, MATERIALIZATION-RECONCILIATION.md
**Constraints:** Documentation only; no code; no schema; no implementation changes

---

## 1. Purpose

This document is the **canonical** architecture for HashSucker's materialization layer.

It supersedes `MATERIALIZATION-ARCHITECTURE.md`, which described an earlier simplified model. The actual system has evolved into a richer control-plane architecture with:

- Capability-based provider adapters (not monolithic provider interface)
- Filesystem-exposure observation (not CDN-redirect-only)
- Multi-table control plane with explicit separation of placement, readiness, inventory, mapping, exposure, binding, lifecycle, and repair
- Content-derived identity `(info_hash, file_index_key)` preserved across all boundaries

This document maps the **actual** architecture while preserving the ownership principles from the original documentation.

---

## 2. Architecture Flow

```
Corpus Identity
(info_hash + file_index_key)
        │
        v
Acquisition Layer
(decision → intent → execution request)
        │
        v
Provider Execution Adapters
        │
        v
Control Plane Store
        │
        +----------------+
        |                |
        v                v
Provider Placement   Lifecycle State
        │
        v
Provider File Inventory
        │
        v
Candidate File Mapping
        │
        v
Exposure Observation
        │
        v
Binding
        │
        v
Resolver / Consumer Projection
        │
        v
Playback
```

---

## 3. Ownership Boundaries

### 3.1 Corpus Owns

- **Identity**: `(info_hash, file_index, file_index_key)` — stable, content-derived, portable across providers
- **Metadata**: Release attributes (title, year, resolution, codec, audio, source_type, release_group, language)
- **Evidence**: Persistence observations, topology features, confidence scores, survival history
- **Ranking inputs**: Static evidence projections (2O persistence, 2P topology, 2Q confidence)

Corpus does NOT own:
- Provider state
- Placement decisions
- Playback URLs
- Lifecycle state
- Repair history
- Consumer paths

### 3.2 Acquisition Owns

- **Placement decisions**: Which content to acquire, when to place, priority ordering
- **Provider/account selection**: Which provider and account scope to target
- **Execution requests**: The command to place content on a provider

Acquisition does NOT own:
- Provider API calls (delegates to adapters)
- Placement observation (control plane concern)
- Lifecycle state
- Consumer paths

### 3.3 Provider Adapters Own

- **Provider API interaction**: All direct communication with provider services
- **Provider capability implementation**: The nine discrete capabilities exposed by the adapter system

Provider adapters do NOT own:
- HTTP contract (resolver concern)
- State machine lifecycle
- Range decision
- .strm generation
- Event logging
- Identity resolution
- Corpus metadata

### 3.4 Control Plane Owns

- **Placement records**: `provider_placements`, `provider_placement_observations`
- **Readiness observations**: `provider_readiness_observations`
- **File inventory**: `provider_files`, `provider_inventory_snapshots`
- **Mappings**: `candidate_file_mappings`
- **Exposures**: `exposures`, `zurg_metadata_observations`
- **Bindings**: `bindings`
- **Lifecycle history**: `lifecycle_events`
- **Repair state**: `repair_transactions`, `repair_steps`
- **Library items**: `library_items`, `library_paths`

Control plane does NOT own:
- Corpus identity (referenced via foreign key, not stored)
- Playback URLs (resolved on demand or exposed via filesystem transport)
- Consumer paths (Plex, WebDAV, .strm are consumer layer)
- Acquisition decisions

### 3.5 Resolver Owns

- **Turning canonical bindings/exposures into playback access**: The `GET /media/{info_hash}/{file_index}` endpoint
- **HTTP contract**: Status codes, headers, redirect/proxy decision, Range handling
- **Byte delivery behavior**: Streaming, partial content, error responses

Resolver does NOT own:
- Provider API calls (delegates to adapters via control plane)
- Placement decisions
- Consumer paths
- Content selection

### 3.6 Consumer Adapters Own

- **Plex paths**: Folder structure, naming conventions
- **.strm**: File content with resolver URL
- **WebDAV**: Directory listings, virtual paths
- **FUSE**: Filesystem interface
- **Library presentation**: Catalog organization, metadata display

Consumers do NOT own:
- Lifecycle state
- Placement decisions
- Provider state
- Resolver behavior

---

## 4. Obsolete Assumptions Retired

### 4.1 Resolver Model

**OLD:**
```
resolver → provider → CDN URL
```

**NEW:**
```
resolver → control-plane projection → exposure/transport → bytes
```

The original documentation assumed the resolver would call a provider adapter to obtain a CDN URL and redirect the client to it. The actual system observes filesystem exposures (e.g., via Zurg/rclone mounts) and serves bytes through the control-plane projection. CDN URLs are ephemeral and provider-specific; filesystem exposures are the stable transport layer.

### 4.2 Provider Resource ID Identity

**OLD:**
```
provider resource ID as identity
```

**NEW:**
```
provider resource ID as placement foreign key
```

Provider resource IDs (e.g., RD torrent IDs) are opaque, mutable, and provider-specific. They are foreign keys in `provider_placements`, never canonical identity. A repair operation may replace a resource ID with a new one for the same hash; the identity survives.

### 4.3 Torrent-Centric Identity

**OLD:**
```
torrent-centric identity
```

**NEW:**
```
(info_hash, file_index_key) identity
```

The system identifies exact file-level media objects, not torrent-level containers. `file_index_key = -1` represents torrent-level identity (NULL file index); `file_index_key >= 0` represents a specific file within a torrent. This distinction is preserved across all tables.

### 4.4 Filesystem-First Architecture

**OLD:**
```
filesystem-first architecture
```

**NEW:**
```
control-plane-first architecture
```

The original model treated the filesystem as the primary abstraction. The actual system treats the control plane as the authoritative source of truth. Filesystem observations are one type of exposure evidence; the control plane models placement, readiness, inventory, mapping, exposure, binding, lifecycle, and repair as separate concerns.

---

## 5. Control Plane Model

### 5.1 Purpose

The control plane is the authoritative source of truth for everything between "I want this media" and "bytes are flowing". It separates distinct concepts that the original documentation collapsed into a single `materialization_state` table.

### 5.2 Table Relationships

#### 5.2.1 provider_placements

The placement record. Represents: "Provider X was asked to hold content Y."

| Column | Purpose |
|--------|---------|
| `provider` | Provider identifier (e.g., `realdebrid`, `torbox`) |
| `account_scope` | Account shard within provider |
| `info_hash` | Corpus identity reference |
| `provider_resource_id` | Opaque provider-side identifier |
| `state` | `pending`, `ready`, `degraded`, `error`, `removed`, `unknown` |
| `ownership` | `owned`, `reused`, `external`, `unknown` |
| `provenance` | Where this placement came from |
| `idempotency_key` | Deduplication key |
| `failure_category` | Structured failure reason |
| `observed_at`, `expires_at` | Observation freshness |

#### 5.2.2 provider_placement_observations

Cache of "I looked up this hash on this provider and found/not-found a placement."

| Column | Purpose |
|--------|---------|
| `observation_state` | `present`, `missing`, `error` |
| `placement_id` | Links to placement if present |
| `source` | What produced this observation |

#### 5.2.3 provider_readiness_observations

"Is this placement ready to serve bytes right now?"

| Column | Purpose |
|--------|---------|
| `state` | `pending`, `ready`, `degraded`, `error`, `removed`, `unknown` |
| `source` | What produced this observation |

#### 5.2.4 provider_files

Provider-authoritative file inventory for a placement.

| Column | Purpose |
|--------|---------|
| `provider_file_id` | Opaque provider-side file identifier |
| `path`, `name`, `size` | File metadata from provider |
| `selected` | Whether this file was selected for download |
| `corpus_file_index` | Mapped corpus file index |
| `present` | Whether file is currently present |
| `missing_since` | When file was first observed missing |

#### 5.2.5 candidate_file_mappings

Maps corpus candidate files to provider files.

| Column | Purpose |
|--------|---------|
| `info_hash`, `file_index`, `file_index_key` | Corpus identity |
| `placement_id`, `provider_file_id` | Provider-side reference |
| `state` | `mapped`, `ambiguous`, `missing`, `stale` |
| `method` | How the mapping was determined |
| `authoritative` | Whether mapping is authoritative |

#### 5.2.6 exposures

Observed filesystem exposures of provider files.

| Column | Purpose |
|--------|---------|
| `placement_id`, `provider_file_id` | Provider-side reference |
| `transport` | Transport type (e.g., `zurg`, `webdav`) |
| `exposure_key` | Opaque exposure identifier |
| `relative_path` | Path within transport |
| `state` | `pending`, `visible`, `missing`, `degraded`, `error`, `unknown` |
| `read_only` | Whether exposure is read-only |

#### 5.2.7 zurg_metadata_observations

Sanitized Zurg `.zurgtorrent` metadata observations.

| Column | Purpose |
|--------|---------|
| `observation_state` | `present`, `missing`, `error` |
| `zurg_state` | Zurg torrent state |
| `metadata_path` | Path to `.zurgtorrent` file |

This observer exposes sanitized torrent/file repair metadata without claiming Real-Debrid placement authority or mount visibility.

#### 5.2.8 bindings

Links a library item to a specific placement, provider file, and exposure.

| Column | Purpose |
|--------|---------|
| `library_item_id` | Library item reference |
| `library_path_id` | Canonical path reference |
| `info_hash`, `file_index`, `file_index_key` | Corpus identity |
| `placement_id`, `provider_file_id` | Provider-side reference |
| `exposure_id` | Exposure reference |
| `version` | Binding version for optimistic concurrency |
| `status` | `active`, `superseded`, `degraded`, `failed` |
| `valid_from`, `superseded_at` | Temporal bounds |

Only one binding per library item is `active` at a time.

#### 5.2.9 lifecycle_events

Append-only history of lifecycle milestones for library items.

| Column | Purpose |
|--------|---------|
| `milestone` | `requested`, `checked`, `placed`, `provider-ready`, `exposed`, `exact-file-mapped`, `bound`, `cataloged`, `playable` |
| `status` | `pending`, `satisfied`, `degraded`, `failed`, `unknown` |
| `failure_category` | Structured failure reason (required for `failed`) |
| `occurred_at` | When the milestone was reached |

#### 5.2.10 repair_transactions

Durable repair transactions for degraded or failed bindings.

| Column | Purpose |
|--------|---------|
| `plan_key` | Deterministic plan identifier |
| `info_hash`, `file_index`, `file_index_key` | Corpus identity |
| `expected_binding_version` | Binding version this repair targets |
| `status` | `planned`, `authorized`, `executing`, `failed`, `succeeded` |
| `plan` | JSON repair plan |
| `authorized_actions` | JSON authorized action subset |
| `authorized_by` | Who authorized the repair |

#### 5.2.11 repair_steps

Individual steps within a repair transaction.

| Column | Purpose |
|--------|---------|
| `action` | Step action type |
| `status` | `running`, `succeeded`, `failed` |
| `attempt` | Attempt number |
| `request`, `result` | JSON request/response |

#### 5.2.12 library_items

Canonical media items.

| Column | Purpose |
|--------|---------|
| `identity_key` | Stable library identity key |
| `media_type` | `movie` or `episode` |
| `media_id` | External media identifier |
| `edition_key` | Edition disambiguation |
| `desired_state` | `present` or `absent` |

#### 5.2.13 library_paths

Canonical paths for library items.

| Column | Purpose |
|--------|---------|
| `canonical_path` | Current canonical path |
| `preferred_path` | Preferred path before collision handling |
| `collision_key` | Collision resolution key |
| `active` | Whether this path is active |

---

## 6. Provider Interface Reconciliation

### 6.1 Original Interface

The original documentation described a three-method provider interface:

```yaml
resolve(identity: MediaIdentity) -> PlayableSource
refresh(identity: MediaIdentity, current: PlayableSource) -> PlayableSource
getStatus(identity: MediaIdentity) -> PlacementStatus
```

### 6.2 Actual Implementation — Capability Model

The implementation uses **capability-based adapters**. Each provider implements a subset of nine discrete capabilities:

| Capability | Methods | Purpose |
|------------|---------|---------|
| `cache-observation` | `observeCache()` | Observe provider cache state |
| `placement-lookup` | `lookupPlacement()` | Look up existing placement |
| `placement-create` | `createPlacement()` | Create new placement |
| `resource-readiness` | `observeReadiness()` | Observe placement readiness |
| `file-inventory` | `getFileInventory()` | Get file inventory |
| `file-selection` | `selectKnownFiles()` | Select known files for placement |
| `repair-request` | `requestRepair()` | Request repair action |
| `exposure` | `observeExposure()` | Observe filesystem exposure |
| `removal` | `removeOwnedResource()` | Remove owned resource |

### 6.3 Relationship

The original `resolve()`, `refresh()`, and `getStatus()` methods are **conceptual boundaries** — the user-facing contract. The implementation uses capability adapters that are **composed into higher-level orchestration behavior**:

```
resolve() ≈ placement-lookup + placement-observe + resource-readiness + file-inventory + exposure-observe
refresh() ≈ placement-create + file-selection + resource-readiness + file-inventory
getStatus() ≈ placement-lookup + resource-readiness
```

The capability model is preserved. The documented three-method interface is implemented as orchestration wrappers over capabilities, not as a replacement for them.

---

## 7. Lifecycle Model

### 7.1 Placement Lifecycle

**Owner:** `provider_placements.state`

```
pending → ready → degraded → error → removed → unknown
```

| State | Meaning |
|-------|---------|
| `pending` | Provider processing placement |
| `ready` | Provider holds content, ready for bytes |
| `degraded` | Provider holds content but degraded |
| `error` | Provider reports permanent error |
| `removed` | Placement removed |
| `unknown` | State unknown |

### 7.2 Materialization/Playback Lifecycle

**Owner:** `lifecycle_events` (projection over library item)

```
requested → checked → placed → provider-ready → exposed → exact-file-mapped → bound → cataloged → playable
```

| Milestone | Meaning |
|-----------|---------|
| `requested` | Library item requested |
| `checked` | Acquisition checked |
| `placed` | Provider placement created |
| `provider-ready` | Provider reports ready |
| `exposed` | Filesystem exposure observed |
| `exact-file-mapped` | Corpus file mapped to provider file |
| `bound` | Active binding created |
| `cataloged` | Consumer catalog updated |
| `playable` | Playback confirmed |

Each milestone has status: `pending`, `satisfied`, `degraded`, `failed`, `unknown`.

### 7.3 Binding Lifecycle

**Owner:** `bindings.status`

```
active → superseded → degraded → failed
```

| State | Meaning |
|-------|---------|
| `active` | Current active binding |
| `superseded` | Replaced by newer binding version |
| `degraded` | Binding degraded but not failed |
| `failed` | Binding permanently failed |

### 7.4 Repair Lifecycle

**Owner:** `repair_transactions.status`

```
planned → authorized → executing → failed → succeeded
```

| State | Meaning |
|-------|---------|
| `planned` | Repair plan created |
| `authorized` | Repair authorized |
| `executing` | Repair executing |
| `failed` | Repair failed |
| `succeeded` | Repair succeeded |

### 7.5 Exposure Lifecycle

**Owner:** `exposures.state`

```
pending → visible → missing → degraded → error → unknown
```

| State | Meaning |
|-------|---------|
| `pending` | Exposure observed but not yet confirmed |
| `visible` | Exposure visible on transport |
| `missing` | Exposure no longer visible |
| `degraded` | Exposure degraded |
| `error` | Exposure error |
| `unknown` | Exposure state unknown |

### 7.6 Why Separate Projections

These are **separate projections** over the same underlying reality:

- **Placement lifecycle** answers: "Does the provider hold this content?"
- **Materialization lifecycle** answers: "What journey has this content taken from request to playback?"
- **Binding lifecycle** answers: "Is the library item actively linked to a placement?"
- **Repair lifecycle** answers: "Is repair in progress or completed?"
- **Exposure lifecycle** answers: "Is this file visible on the transport right now?"

The original documentation collapsed these into a single 5-state machine (`acquiring → available → expired → repairing → failed`). The actual system models each dimension independently, which is more expressive and avoids conflating distinct failure modes.

---

## 8. Zurg Relationship

### 8.1 Useful Concepts Preserved

| Concept | Preservation |
|---------|--------------|
| **Repair** | Zurg has an independent torrent/file repair state machine. HashSucker models repair as separate durable transactions. |
| **Refresh** | Zurg refreshes unrestricted links before expiration. HashSucker models refresh through capability-based re-observation. |
| **Exposure** | Zurg presents a virtual filesystem via WebDAV. HashSucker observes filesystem exposures as evidence in the `exposures` table. |
| **Filesystem projection** | Zurg's `.zurgtorrent` is a persisted local source of truth. HashSucker observes this via `zurg_metadata_observations` without claiming RD placement authority. |

### 8.2 Rejected Assumptions

| Assumption | Rejection |
|------------|-----------|
| RD torrent ID as identity | RD torrent IDs are opaque, mutable, and provider-specific. They are foreign keys in `provider_placements`, never canonical identity. |
| Filesystem as primary abstraction | Filesystem is one transport type. The control plane is the authoritative source of truth; filesystem observations are exposure evidence. |
| Provider coupling | Zurg is RD-only. HashSucker abstracts providers via capability adapters. |

### 8.3 Zurg's Role

Zurg is a **consumer/exposure pattern**, not the architecture.

- Zurg provides a WebDAV interface to RD torrents
- HashSucker observes the Zurg mount as one type of filesystem exposure
- The `zurg_metadata_observations` table captures sanitized Zurg metadata
- Zurg repair state is observed but not authoritative for HashSucker lifecycle

---

## 9. Implementation Phases

### Phase A: Corpus/Evidence Foundation

**Status:** Implemented

Corpus evidence projections provide static evidence for ranking:
- 2O: Persistence features (temporal bounds, survival rate, lifecycle transitions)
- 2P: Topology features (file composition, structure detection, playable target heuristics)
- 2Q: Confidence features (weighted combination of persistence, topology, metadata)

These projections are pure read-only queries over existing tables. No schema additions.

### Phase B: Acquisition/Control-Plane Wiring

**Status:** Partial

Acquisition decision and intent slices are implemented as pure boundaries. Control plane store schema exists with tables for placements, readiness, inventory, mappings, exposures, bindings, lifecycle, and repair.

Remaining work:
- Wire acquisition intent to provider execution adapters
- Implement resolver endpoint
- Wire resolver to control plane and exposure transport

### Phase C: Exposure and Binding

**Status:** Partial

Exposure observation foundations exist for filesystem paths and Zurg metadata. Binding logic creates versioned links between library items, placements, provider files, and exposures.

Remaining work:
- Wire exposure observers to live mounts
- Implement binding reconciliation
- Implement repair execution

### Phase D: Resolver and Consumer Projections

**Status:** Not started

The resolver endpoint (`GET /media/{info_hash}/{file_index}`) is the primary missing component. It must be designed around the existing filesystem-exposure model, consuming:

1. Active binding lookup
2. Exposure freshness check
3. Placement readiness check
4. Byte delivery (streaming + Range support)

Consumer adapters (WebDAV, .strm, FUSE) will wrap the resolver endpoint.

### Phase E: Reliability/Repair Automation

**Status:** Foundation implemented

Repair control plane exists: repair plans, durable transactions, step recording, action authorization. The executor is a controlled dependency-injected boundary.

Remaining work:
- Wire repair executor to live provider capabilities
- Implement background refresh
- Implement multi-provider failover
- Implement rate limit awareness

---

## 10. Architecture Invariants

### 10.1 Identity Invariants

- **Identity remains content-derived**: `(info_hash, file_index_key)` is the canonical identity. It is never replaced by provider resource IDs, CDN URLs, filesystem paths, or surrogate UUIDs.
- **Provider state never mutates corpus identity**: Provider additions, removals, repairs, and replacements do not change the corpus identity.
- **One identity, many placements**: A single `(info_hash, file_index_key)` can have zero or more placements across providers.

### 10.2 Separation Invariants

- **Placement is not exposure**: A provider holding content does not mean the file is visible on a transport.
- **Exposure is not binding**: A visible file is not necessarily linked to a library item.
- **Binding is not playback success**: An active binding does not guarantee successful playback.
- **Ranking does not occur during acquisition**: Ranking happens in discovery; acquisition combines ranked candidates with provider reality.

### 10.3 Ownership Invariants

- **Resolver does not choose content**: The resolver maps identity to bytes; it does not decide what to acquire.
- **Consumers do not own lifecycle state**: Consumers present content; the control plane owns lifecycle state.
- **Provider adapters do not own HTTP semantics**: Adapters produce capability observations; the resolver owns the HTTP contract.

### 10.4 Observation Invariants

- **Observations are scoped and expiring**: Every observation has a source, scope, authority kind, and expiration.
- **Observations are append-only**: Observation history is never mutated; new observations supersede old ones.
- **Missing exposure is not provider deletion**: A missing filesystem exposure does not imply the provider deleted the resource.
- **Zurg metadata is not provider authority**: Zurg state is evidence, not authoritative provider placement state.

---

## 11. What Changed from MATERIALIZATION-ARCHITECTURE.md

### 11.1 Structural Changes

| Aspect | V1 (Old) | V2 (New) |
|--------|----------|----------|
| Identity | `(info_hash, file_index)` with augmentation discussion | `(info_hash, file_index_key)` — exact match to existing tables |
| Placement model | Single `placements` table | `provider_placements` + `provider_placement_observations` + `provider_readiness_observations` |
| State machine | Single 5-state machine (`acquiring → available → expired → repairing → failed`) | Multiple independent projections (placement, lifecycle, binding, repair, exposure) |
| Provider interface | `resolve()`, `refresh()`, `getStatus()` | 9 capability adapters composed into orchestration |
| Resolver model | CDN redirect (302 to RD CDN) | Filesystem-exposure projection (read from transport) |
| URL caching | `resolved_urls` table | No URL caching; exposures are the cache |
| Repair | Simple refresh/replace | Durable repair transactions with plans, authorization, and steps |
| Zurg | Borrow as architecture | Observe as exposure pattern |
| Schema | New tables to build | Existing tables; no new schema |

### 11.2 Conceptual Changes

| Concept | V1 (Old) | V2 (New) |
|---------|----------|----------|
| Materialization registry | New registry tables | Existing control plane store |
| Active placement | Stored in `materialization_state` | Derived from `bindings` table |
| URL freshness | `expires_at` in `resolved_urls` | Exposure freshness in `exposures` |
| Provider selection | Resolver picks provider | Control plane binding determines provider |
| Playback target | Ephemeral CDN URL | Stable filesystem exposure |
| Failure handling | `failed` is terminal | Repair transactions with durability |

### 11.3 Implementation Phases Changed

| Phase | V1 (Old) | V2 (New) |
|-------|----------|----------|
| A | Corpus evidence projections | Same (implemented) |
| B | Build registry + provider interface + Wire acquisition + resolver + consumers |
| C | Consumers | Exposure + binding + repair execution |
| D | Reliability | Resolver + consumer projections |
| E | — | Reliability/repair automation |

---

## 12. What Was Intentionally Preserved

### 12.1 Ownership Principles

- Corpus owns identity and metadata
- Provider adapters own provider API interaction
- Control plane owns placement/readiness/inventory/mapping/exposure/binding/lifecycle/repair
- Resolver owns HTTP contract and byte delivery
- Consumers own presentation

### 12.2 Identity Contract

```yaml
MediaIdentity:
  info_hash: string          # 40-char lowercase hex SHA-1
  file_index: integer | null # null = torrent-level identity
  file_index_key: integer    # -1 when file_index is NULL
```

### 12.3 Error Classification

```yaml
AuthError:         { code: "auth_error", message: string }
RateLimitError:    { code: "rate_limited", retry_after: integer }
NotFoundError:     { code: "not_found", message: string }
ProviderError:     { code: "provider_error", message: string }
```

### 12.4 Resolver HTTP Contract

| Status | Meaning |
|--------|---------|
| 200 | Success (proxy mode) |
| 206 | Partial content (Range request) |
| 302 | Redirect to transport |
| 404 | Unknown identity |
| 410 | Placement permanently failed |
| 429 | Rate limited |
| 502 | Provider error |
| 504 | Provider timeout |

### 12.5 Anti-Patterns

All anti-patterns from ANTI-PATTERNS.md are preserved:
- Do not use provider resource ID as identity
- Do not use CDN URL as identity
- Do not use filesystem path as identity
- Do not store consumer paths in registry
- Do not store CDN URLs as permanent records
- Do not rank releases in provider adapter
- Do not make acquisition decisions in resolver

### 12.6 Confidence Model

```yaml
ConfidenceFeatures:
  overall: number  # 0-1 weighted score
  components:
    persistence: number  # weight: 0.40
    topology: number     # weight: 0.40
    metadata: number     # weight: 0.20
```

---

## 13. Document Status

This document is **canonical** for the materialization layer.

- `MATERIALIZATION-ARCHITECTURE.md` is **superseded**
- `MATERIALIZATION-REGISTRY-SCHEMA.md` describes an earlier schema; the actual schema is in `src/lib/control-plane/store.js`
- `PROVIDER-INTERFACE.md` describes the conceptual interface; the actual implementation uses capability adapters in `src/lib/providers/capabilities.js`
- `RESOLVER-DESIGN.md` describes the resolver contract; the actual resolver is not yet implemented
- `ARCHITECTURE-BOUNDARIES.md`, `CONTRACTS.md`, `STATE-MACHINE-REFERENCE.md`, `ANTI-PATTERNS.md` remain valid as complementary documentation

---

## 14. No Code or Schema Changes

This document makes **no code changes** and **no schema changes**.

All tables referenced exist in `src/lib/control-plane/store.js`. All capabilities referenced exist in `src/lib/providers/capabilities.js`. All lifecycle milestones exist in `src/lib/control-plane/lifecycle.js`.

This is documentation only.

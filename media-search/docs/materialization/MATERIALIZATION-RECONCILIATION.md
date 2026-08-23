# Materialization Reconciliation — Documented Architecture vs. Existing Implementation

**Date:** 2026-08-23
**Scope:** Map documented materialization contracts onto the existing codebase
**Constraints:** No code changes; architecture mapping only

---

## 1. Identity Mapping

### Documented Contract

```
MediaIdentity:
  info_hash: string
  file_index: integer | null
  file_index_key: integer    # -1 when file_index is NULL
```

### Existing Implementation

| Table | Identity Columns | Matches Contract? |
|-------|-----------------|-------------------|
| `candidates` | `info_hash`, `file_index`, `file_index_key` | ✅ Exact match |
| `candidate_file_mappings` | `info_hash`, `file_index`, `file_index_key`, `release_key` | ✅ Superset |
| `provider_placements` | `info_hash`, `provider_resource_id` | ⚠️ No `file_index_key` |
| `provider_files` | `placement_id`, `provider_file_id`, `corpus_file_index` | ⚠️ Different keying |
| `library_items` | `identity_key` | ❌ Different abstraction |

### Two Identity Layers in Existing Code

**Layer 1 — Content Identity** (matches documented contract):
```js
// release-contract.js — createReleaseIdentity(infoHash, fileIndex)
{
  infoHash: "40-char-hex",
  fileIndex: null | integer,
  releaseKey: "${infoHash}:${fileIndex ?? 'torrent'}"
}
```

**Layer 2 — Library Identity** (NOT in documented contract):
```js
// canonical-path.js — createLibraryIdentityKey({ mediaType, mediaId, editionKey })
"movie:tt1234567:default"
"episode:tt1234567:s01e03:default"
```

Library identity represents **desired media** (a movie or episode), not a specific file instance. It is used for:
- `library_items` table — "I want this media to be present"
- `bindings` table — links a desired media item to a specific placement + provider file + exposure

### Mapping Table

| Documented Concept | Existing Table | Existing Column | Notes |
|---|---|---|---|
| `(info_hash, file_index_key)` | `candidates` | `info_hash`, `file_index`, `file_index_key` | Exact match |
| `(info_hash, file_index_key)` | `candidate_file_mappings` | `info_hash`, `file_index`, `file_index_key` | Adds provider-file binding |
| N/A (library concept) | `library_items` | `identity_key` | Maps media IDs to stable library item IDs |
| N/A (binding concept) | `bindings` | `info_hash`, `file_index`, `file_index_key` | Links library item to placement + provider file |

### Verdict

**No new identity abstraction needed.** The documented `(info_hash, file_index_key)` contract maps directly to existing tables. The existing system has an *additional* library-identity layer for media management, but this supplements — not conflicts with — the documented content-identity contract.

---

## 2. Placement Mapping

### Documented Contract

```
Placement:
  placement_id: UUID
  info_hash: string
  file_index_key: integer
  provider: string
  provider_resource_id: string
  status: "pending" | "complete" | "failed"
  created_at: ISO8601
  updated_at: ISO8601
```

### Existing Implementation

| Table | Role | Authority |
|-------|------|-----------|
| `provider_placements` | Authoritative placement record | **Primary** — the placement itself |
| `provider_placement_observations` | Lookup cache | **Secondary** — "what I saw when I looked up this hash" |
| `provider_readiness_observations` | Readiness state | **Secondary** — "is this placement ready to serve bytes" |

### Field Mapping

| Documented Field | Existing Table | Existing Column | Semantics |
|---|---|---|---|
| `placement_id` | `provider_placements` | `id` | UUID primary key |
| `info_hash` | `provider_placements` | `info_hash` | Torrent identity |
| `file_index_key` | `provider_placements` | — | ⚠️ Not stored (placement is torrent-level) |
| `provider` | `provider_placements` | `provider` | e.g., `"realdebrid"` |
| `provider_resource_id` | `provider_placements` | `provider_resource_id` | Opaque provider-side ID |
| `status` | `provider_placements` | `state` | See state mapping below |
| `created_at` | `provider_placements` | `created_at` | Integer ms timestamp |
| `updated_at` | `provider_placements` | `updated_at` | Integer ms timestamp |
| — | `provider_placements` | `account_scope` | Multi-account support |
| — | `provider_placements` | `ownership` | `owned` / `reused` / `external` / `unknown` |
| — | `provider_placements` | `provenance` | Where this placement came from |
| — | `provider_placements` | `idempotency_key` | Dedup key |
| — | `provider_placements` | `failure_category` | Structured failure reason |
| — | `provider_placements` | `observed_at` / `expires_at` | Observation freshness |

### State Mapping

| Documented Status | Existing `state` | Notes |
|---|---|---|
| `pending` | `pending` | Exact match |
| `complete` | `ready` | Ready to serve bytes |
| `failed` | `error` | Permanent failure |
| — | `degraded` | Degraded but not failed |
| — | `removed` | Placement removed |
| — | `unknown` | State unknown |

### Verdict

**`provider_placements` IS the documented `placements` table.** It is a strict superset — all documented fields exist, plus additional columns for multi-account support, ownership tracking, provenance, and structured failure reporting. The documented `file_index_key` is absent because placements are torrent-level; file-level mapping happens in `candidate_file_mappings`.

---

## 3. Materialization State Mapping

### Documented Contract

```
acquiring → available → expired → repairing → failed
```

### Existing Implementation — Three Interacting Systems

**System A — Placement State** (`provider_placements.state`):
```
pending → ready → degraded → error → removed → unknown
```

**System B — Lifecycle Milestones** (`lifecycle_events.milestone` + `status`):
```
requested → checked → placed → provider-ready → exposed → exact-file-mapped → bound → cataloged → playable
```

**System C — Binding State** (`bindings.status`):
```
active → superseded → degraded → failed
```

**System D — Repair Transactions** (`repair_transactions.status`):
```
planned → authorized → executing → failed → succeeded
```

**System E — Exposure Freshness** (`exposures.state` + TTL):
```
pending → visible → missing → degraded → error → unknown
```

### Composite Mapping

| Documented State | Existing Equivalent | Determined By |
|---|---|---|
| `acquiring` | `lifecycle: placed` + `readiness: pending` + `binding: none` | Placement created but no active binding |
| `available` | `lifecycle: playable` + `readiness: ready` + `binding: active` + `exposure: visible` | Active binding with fresh visible exposure |
| `expired` | `readiness: ready` + `exposure: stale` OR `exposure: missing` | Placement ready but exposure TTL expired |
| `repairing` | `repair_transactions: executing` OR `binding: degraded` | Repair in progress |
| `failed` | `binding: failed` OR `repair_transactions: failed` OR `readiness: error` | No valid placement or all placements exhausted |

### State Transition Mapping

| Documented Transition | Existing Equivalent |
|---|---|
| `acquiring → available` | Binding created (`bindings: active`) + exposure visible |
| `available → expired` | Exposure TTL expires (`exposure.expires_at < now`) |
| `expired → repairing` | Repair transaction created (`repair_transactions: executing`) |
| `repairing → available` | New binding version created (`bindings: active`) |
| `repairing → failed` | Max retries exceeded OR auth error |
| `failed → acquiring` | New placement created, new binding attempted |

### Why the Existing System is More Expressive

The documented 5-state machine collapses three distinct concepts that the existing system separates:

1. **Provider readiness** — "Does the provider hold this content?" (`provider_readiness_observations`)
2. **Filesystem exposure** — "Is this file visible on the transport?" (`exposures`)
3. **Binding liveness** — "Is the library item actively linked to this placement?" (`bindings`)

The existing lifecycle milestones (`requested → checked → placed → provider-ready → exposed → exact-file-mapped → bound → cataloged → playable`) describe the *full journey* of a piece of content from request to playback, which the documented state machine compresses.

### Verdict

**Do NOT force a new state machine.** The existing system is more expressive and already models the full lifecycle. The documented 5-state machine can be derived as a *projection* over existing tables:

```sql
-- Pseudocode: derive documented state from existing tables
SELECT
  CASE
    WHEN binding.status = 'active' AND exposure.state = 'visible'
      AND exposure.expires_at > NOW() THEN 'available'
    WHEN binding.status = 'active' AND exposure.expires_at <= NOW() THEN 'expired'
    WHEN repair.status = 'executing' THEN 'repairing'
    WHEN binding.status = 'failed' THEN 'failed'
    ELSE 'acquiring'
  END AS documented_state
FROM binding
JOIN exposure ON ...
LEFT JOIN repair ON ...
```

---

## 4. Resolver Boundary

### Documented Contract

```
GET /media/{info_hash}/{file_index}
        │
        ▼
materialization resolver
        │
        ├── check lifecycle
        ├── refresh link if needed
        ├── choose provider
        └── stream bytes
```

### Existing Architecture — Two Divergent Models

The documented resolver assumes a **CDN-redirect model**:
```
Request → Resolver → RD CDN URL → 302 Redirect → Client streams from CDN
```

The existing codebase implements a **filesystem-exposure model**:
```
Request → Resolver → Zurg filesystem mount → Read file → Serve bytes to client
```

Evidence:
- `zurg-metadata.js` — reads `.zurgtorrent` files from a RD data directory
- `filesystem-exposure.js` — observes files on a read-only transport (Zurg mount)
- `exposures` table — tracks filesystem visibility, not CDN URL freshness
- No CDN URL resolution, no 302 redirect logic, no `resolved_urls` table

### What the Missing Resolver Should Consume

Given the existing architecture, the resolver should consume:

```
GET /media/{info_hash}/{file_index}
        │
        ▼
1. Lookup active binding
   WHERE info_hash = ? AND file_index_key = ?
   → binding.placement_id
   → binding.provider_file_id
   → binding.exposure_id
        │
        ▼
2. Check exposure freshness
   FROM exposures WHERE id = binding.exposure_id
   → exposure.state = 'visible'?
   → exposure.expires_at > now?
        │
        ▼
3. Check placement readiness
   FROM provider_readiness_observations
   WHERE placement_id = binding.placement_id
   → state = 'ready'?
        │
        ▼
4. Serve bytes
   IF exposure.visible AND placement.ready:
     → Read from filesystem transport (exposure.exposure_key, relative_path)
     → Return 200 with bytes OR 206 for Range requests
   ELSE IF exposure.expired:
     → Trigger repair (create repair transaction)
     → Return 503 with Retry-After
   ELSE:
     → Return 404 / 410 / 502 as appropriate
```

### Missing Contract Definition

```yaml
# What the resolver consumes from the existing control plane

ResolverInput:
  info_hash: string          # From URL
  file_index: integer | null # From URL

ResolverQuery:
  # Step 1: Find active binding
  binding: SELECT * FROM bindings
           WHERE info_hash = ? AND file_index_key = ? AND status = 'active'
  # Step 2: Check exposure
  exposure: SELECT * FROM exposures WHERE id = ?
  # Step 3: Check readiness
  readiness: SELECT * FROM provider_readiness_observations WHERE placement_id = ?

ResolverDecision:
  - IF binding = null: → 404 (unknown_identity)
  - IF readiness.state = 'error': → 410 (placement_failed)
  - IF exposure.state = 'missing': → 503 (retry_after = repair_eta)
  - IF exposure.state = 'visible' AND exposure.expires_at > now:
      → 200 with bytes OR 206 for Range
  - IF exposure.expires_at <= now:
      → trigger repair, 503 (retry_after = 30)
```

### Key Difference from Documented Contract

| Aspect | Documented | Existing Architecture |
|--------|-----------|----------------------|
| Playable source | CDN URL (ephemeral, ~24h TTL) | Filesystem path (Zurg mount) |
| Refresh mechanism | `provider.refresh()` → new CDN URL | Re-observe filesystem exposure |
| Redirect vs proxy | 302 to CDN OR 200 proxy | Direct 200 read from filesystem |
| State tracked in | `resolved_urls` table | `exposes` table |
| Provider interaction | RD API call to unrestrict link | No API call — read from mount |

### Verdict

The resolver is the **primary missing component** but it must be designed around the existing filesystem-exposure model, not the documented CDN-redirect model. The contract above defines what it should consume. Implementing it requires:

1. A new HTTP route: `GET /media/{info_hash}/{file_index}`
2. Binding lookup logic
3. Exposure freshness check
4. Filesystem read (streaming + Range support)
5. Error mapping to documented status codes (404/410/429/502/503/504)

---

## 5. Provider Interface Reconciliation

### Documented Contract

```yaml
resolve(identity: MediaIdentity) -> PlayableSource
refresh(identity: MediaIdentity, current: PlayableSource) -> PlayableSource
getStatus(identity: MediaIdentity) -> PlacementStatus
```

### Existing Implementation — Capability Model

```yaml
observeCache → provider_observations
lookupPlacement → provider_placement_observations
createPlacement → provider_placements
observeReadiness → provider_readiness_observations
getFileInventory → provider_files
selectKnownFiles → file selection
requestRepair → repair
observeExposure → exposures
removeOwnedResource → removal
```

### Mapping

| Documented Method | Existing Capability Equivalent | Composed From |
|---|---|---|
| `resolve()` | — (does not exist) | `lookupPlacement` + `observeReadiness` + `getFileInventory` + `selectKnownFiles` + `observeExposure` |
| `refresh()` | — (does not exist) | `observeReadiness` + `observeExposure` |
| `getStatus()` | — (does not exist) | `observeReadiness` + `observeExposure` → map to canonical state |

### Two Possible Reconciliation Strategies

**Strategy A — Documented methods become orchestration wrappers:**

```yaml
# Pseudocode — documented methods as orchestration over capabilities

resolve(identity):
  placement = lookupPlacement(identity)
  readiness = observeReadiness(placement)
  inventory = getFileInventory(placement)
  mapping = chooseExactFile(identity, inventory)
  exposure = observeExposure(placement, mapping)
  return PlayableSource from exposure

refresh(identity, current):
  readiness = observeReadiness(current.placement)
  exposure = observeExposure(current.placement, current.mapping)
  return updated PlayableSource

getStatus(identity):
  placement = lookupPlacement(identity)
  readiness = observeReadiness(placement)
  exposure = observeExposure(placement)
  return mapToCanonicalState(readiness, exposure)
```

**Strategy B — Capabilities extend with composite methods:**

Add three new capabilities that compose existing ones:
- `RESOLVE: { resolve(identity) }`
- `REFRESH: { refresh(identity, current) }`
- `GET_STATUS: { getStatus(identity) }`

These would be implemented as orchestration wrappers, not new provider logic.

### Recommendation: Strategy A

**Do not extend the capability model.** Instead, implement the documented methods as **control-plane orchestration functions** that compose existing capabilities. This:

1. Preserves the granular capability model
2. Adds the documented interface without replacing anything
3. Keeps provider adapters stateless and single-responsibility
4. Makes the documented methods testable as pure orchestration

### What Changes

| Component | Current | Proposed |
|---|---|---|
| `PROVIDER_CAPABILITIES` enum | 9 capabilities | No change |
| `createProviderAdapter()` | Validates capabilities | No change |
| `createRealDebridProvider()` | Returns capability map | No change |
| **New: Control-plane orchestration layer** | — | `resolve()`, `refresh()`, `getStatus()` as pure functions over capabilities |
| **New: Resolver endpoint** | — | Consumes orchestration layer |

### Verdict

The capability model is **more granular and more testable** than the documented interface. The documented `resolve()`/`refresh()`/`getStatus()` should be implemented as orchestration wrappers — not replacements for capabilities. This preserves the existing architecture while providing the documented contract surface.

---

## 6. Output Summary

### Architecture Mapping Table

| Documented Concept | Existing Implementation | Status |
|---|---|---|
| `(info_hash, file_index_key)` identity | `candidates`, `candidate_file_mappings`, `release-contract.js` | ✅ Direct match |
| `placements` table | `provider_placements` | ✅ Superset |
| `materialization_state` | `bindings` + `provider_readiness_observations` + `exposures` | ✅ Distributed |
| `acquiring/available/expired/repairing/failed` | `lifecycle_events` + `repair_transactions` + `bindings.status` | ✅ Derivable |
| `GET /media/{hash}/{file}` resolver | — | ❌ Missing |
| `resolve()` / `refresh()` / `getStatus()` | — | ❌ Missing (compose from capabilities) |
| `resolved_urls` table | `exposures` table (filesystem, not CDN) | ⚠️ Different mechanism |
| `PlayableSource` (CDN URL) | `ExposureObservation` (filesystem path) | ⚠️ Different model |
| Provider adapter `resolve()` | Capability-based adapter | ⚠️ Different interface |

### Missing Components List

| # | Component | Type | Priority |
|---|-----------|------|----------|
| 1 | `GET /media/{info_hash}/{file_index}` resolver | HTTP endpoint | **Critical** — playback surface |
| 2 | Binding lookup query | Query function | **Critical** — resolver dependency |
| 3 | Exposure freshness check | Query function | **Critical** — resolver dependency |
| 4 | Filesystem byte streaming | I/O layer | **Critical** — resolver core |
| 5 | `resolve()` orchestration | Pure function | **Medium** — documented interface |
| 6 | `refresh()` orchestration | Pure function | **Medium** — documented interface |
| 7 | `getStatus()` orchestration | Pure function | **Medium** — documented interface |
| 8 | Error-to-HTTP mapping | Mapping function | **Medium** — resolver responses |
| 9 | Range request support (RFC 7233) | HTTP layer | **Low** — playback quality |
| 10 | CDN preflight (if adding CDN model later) | Optimization | **Deferred** — not yet needed |

### Proposed Implementation Order

```
Phase B-1: Resolver Core
  ├─ GET /media/{info_hash}/{file_index} route
  ├─ Binding lookup query
  ├─ Exposure freshness check
  └─ Filesystem byte streaming (200 response)

Phase B-2: Resolver Robustness
  ├─ Error-to-HTTP mapping (404/410/429/502/503/504)
  ├─ Range request support (206 partial content)
  └─ Repair trigger on expired exposure (503 + Retry-After)

Phase B-3: Documented Interface
  ├─ resolve() orchestration wrapper
  ├─ refresh() orchestration wrapper
  └─ getStatus() orchestration wrapper

Phase B-4: Consumer Adapters
  ├─ .strm generator (resolver URL, not CDN URL)
  ├─ WebDAV adapter (wraps resolver)
  └─ FUSE adapter (wraps resolver)
```

### Documents That Need Updating

| Document | Section | Issue | Action |
|---|---|---|---|
| `MATERIALIZATION-REGISTRY-SCHEMA.md` | §3 | Describes `placements`, `materialization_state`, `resolved_urls`, `materialization_events` tables that don't exist | Update to reflect actual `provider_placements`, `bindings`, `exposures`, `repair_transactions` schema |
| `PROVIDER-INTERFACE.md` | §3 | Describes `resolve()`/`refresh()`/`getStatus()` as direct adapter methods | Update to describe them as orchestration wrappers over capability model |
| `RESOLVER-DESIGN.md` | §2-3 | Assumes CDN-redirect model with 302/200 decision | Update to reflect filesystem-exposure model with direct streaming |
| `STATE-MACHINE-REFERENCE.md` | §3 | Documents 5-state materialization machine | Update to show how existing `bindings` + `readiness` + `exposures` derive the documented states |
| `MATERIALIZATION-ARCHITECTURE.md` | §7 | Describes resolver consuming `resolved_urls` | Update to reflect resolver consuming `exposures` + `bindings` |
| `IMPLEMENTATION-ORDER.md` | §3 | Phase B assumes building registry + resolver from scratch | Update to reflect: registry exists, resolver is missing, interface is additive |
| `CONTRACTS.md` | §3 | `PlayableSource` defined as CDN URL | Update to reflect filesystem path as primary playable source |
| `ANTI-PATTERNS.md` | §3.5 | "Do not cache URLs long-term in provider adapter" | Still valid — but note that `exposures` table is the canonical URL/path cache |
| `ARCHITECTURE-BOUNDARIES.md` | §2.6 | Provider adapter "owns URL production" | Update: provider adapter owns exposure observation; Zurg owns URL/path production |
| `DOCUMENT-HIERARCHY.md` | §2.1 | Lists `MATERIALIZATION-REGISTRY-SCHEMA.md` as canonical for schema | Add note that actual schema is in `src/lib/control-plane/store.js` |

---

## Key Insights

1. **The existing system is more sophisticated than the docs describe.** The control-plane store, lifecycle milestones, repair planner, and filesystem-exposure model represent a more complete materialization architecture than the documented CDN-redirect model.

2. **The divergence is in the playback mechanism, not the architecture.** Both approaches solve "map identity → playable bytes" but through different mechanisms:
   - **Documented:** RD CDN URL → 302 redirect
   - **Existing:** Zurg filesystem mount → direct read

3. **No identity conflict.** The documented `(info_hash, file_index_key)` contract is fully respected. The existing system adds a library-identity layer for media management, but this is supplementary.

4. **The capability model is superior to the documented interface.** The 9-capability adapter is more granular, testable, and composable than the 3-method interface. The documented methods should be built *on top of* the capability model, not replace it.

5. **The resolver is the critical missing piece.** Everything else — placements, bindings, exposures, readiness, lifecycle, repair — is implemented. The resolver is the single component that binds them together for playback.

6. **Repair is more advanced than documented.** The existing repair system (`repair_planner.js`, `repair_executor.js`, `repair_transactions` table) is a complete, authorized, audited repair orchestrator — far beyond the documented "repairing" state.

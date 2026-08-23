# Resolver Implementation Plan

**Date:** 2026-08-23
**Status:** Specification — no code, no schema, no migrations
**Supersedes:** `RESOLVER-DESIGN.md` (CDN-redirect model retired per `MATERIALIZATION-ARCHITECTURE-V2.md` §4.1)
**Complements:** `MATERIALIZATION-ARCHITECTURE-V2.md`, `ACQUISITION-CONTRACT.md`, `ARCHITECTURE-BOUNDARIES.md`, `CONTRACTS.md`
**Scope:** Define the smallest possible implementation path for `GET /media/{info_hash}/{file_index}` against the existing control-plane store

---

## 1. Resolver Ownership Boundary

### 1.1 Resolver OWNS

| Responsibility | Description |
|----------------|-------------|
| HTTP endpoint contract | `GET /media/{info_hash}/{file_index}` — request parsing, response codes, headers |
| Identity normalization | Parse and validate `(info_hash, file_index)` from URL path into canonical identity |
| Binding resolution | Locate the active binding for a given identity through the control plane |
| Exposure selection | Select a valid exposure from the binding |
| Byte delivery semantics | Determine transport (filesystem read / proxy / redirect) and serve bytes |
| HTTP status mapping | Map control-plane state to 200/206/404/410/423/503 |
| Range request handling | Honor `Range` headers for seek-heavy clients (Plex) |

### 1.2 Resolver DOES NOT Own

| Not Owned | Owner | Why |
|-----------|-------|-----|
| Ranking | Stage 3 (`ranking.js`) | Upstream of acquisition |
| Candidate selection | `acquisition/decision.js` | Acquisition boundary |
| Provider selection | `acquisition/policy.js` | Acquisition boundary |
| Placement creation | `acquisition/execution.js` → provider adapter | Acquisition/control-plane boundary |
| Provider API calls | Provider capability adapters | Control-plane observation layer |
| Repair decisions | `control-plane/reconciler.js` | Control-plane layer |
| Lifecycle state transitions | `control-plane/store.js` events | Control-plane owns `lifecycle_events` |
| Library naming / paths | `control-plane/canonical-path.js` | Control-plane owns `library_paths` |
| Metadata extraction | DMM ingestion pipeline | Discovery layer |

The resolver is a **read-only projection layer**. It consumes finalized control-plane state. It never writes to the control plane, never calls providers, never mutates lifecycle.

---

## 2. Input Contract

### 2.1 Request Shape

```
GET /media/{info_hash}/{file_index}
```

**Examples:**

| Request | Meaning |
|---------|---------|
| `GET /media/abc123def.../0` | First file in torrent `abc123def...` |
| `GET /media/abc123def.../2` | Third file in torrent |
| `GET /media/abc123def.../torrent` | Torrent-level identity (no specific file) |

**Optional headers:**

| Header | Behavior |
|--------|----------|
| `Range: bytes=start-end` | Partial content request — resolver honors if transport supports it |
| `If-None-Match` | Reserved for future caching — currently ignored (cache-control: no-store) |

### 2.2 Identity Normalization

Follows `release-contract.js → createReleaseIdentity(infoHash, fileIndex)`:

| Input | Normalization | Validation |
|-------|---------------|------------|
| `info_hash` | Lowercase | Must match `/^[0-9a-f]{40}$/` |
| `file_index` | Integer or `"torrent"` | `"torrent"` → `null` (torrent-level); integer must be ≥ 0 |
| Derived `file_index_key` | `-1` when `file_index` is `null`; otherwise equals `file_index` | Used for all control-plane lookups |
| Derived `release_key` | `${infoHash}:${fileIndex === null ? 'torrent' : fileIndex}` | Canonical identity string |

**Existing code reference:** `media-search/src/api/release-contract.js` — `createReleaseIdentity()`, `validateReleaseIdentity()`. Reuse directly; do not re-implement.

### 2.3 Invalid Identity Behavior

| Condition | HTTP Response | Body |
|-----------|---------------|------|
| `info_hash` not 40-char hex | `400 Bad Request` | `{ "error": "infoHash must be 40 hexadecimal characters" }` |
| `file_index` not integer or `"torrent"` | `400 Bad Request` | `{ "error": "fileIndex must be torrent or a non-negative integer" }` |
| `file_index` negative integer | `400 Bad Request` | `{ "error": "fileIndex must be torrent or a non-negative integer" }` |

These are input validation errors, consistent with `app.js` error handling pattern: `/invalid|required|.../i.test(error.message)` → `400`.

---

## 3. Control Plane Lookup Path

The resolver walks a **read-only path** through existing tables. No writes. No new tables.

### 3.1 Lookup Sequence

```
Step 1: Receive (info_hash, file_index)
            │
            ▼
Step 2: Normalize → release_key, file_index_key
            │
            ▼
Step 3: Query bindings WHERE status='active'
        AND info_hash = ? AND file_index_key = ?
            │
            ├── No binding found ──▶ 410 (or 404 if never bound)
            │
            ▼
Step 4: Read binding.exposure_id
            │
            ▼
Step 5: Query exposures WHERE id = ?
            │
            ├── exposure.state ≠ 'visible' ──▶ 423 or 503
            │
            ▼
Step 6: Read binding.placement_id, binding.provider_file_id
            │
            ▼
Step 7: Query provider_files WHERE placement_id = ? AND provider_file_id = ?
            │
            ├── provider_file.present ≠ 1 ──▶ 423 or 503
            │
            ▼
Step 8: Determine transport from exposure.transport + exposure.relative_path
            │
            ▼
Step 9: Serve bytes
```

### 3.2 Key Relationship: Why `bindings` is the Entry Point

The `bindings` table (`store.js` §5.2.8) is the **single entry point** because it already resolves the many-to-many relationship:

| From | Via | To |
|------|-----|----|
| Library item | `bindings` | Active placement + provider file + exposure |
| Identity | `candidate_file_mappings` | Placement + provider file (but NOT exposure) |
| Placement | `exposures` | Multiple possible exposures (only binding selects one) |

The binding is the **authoritative resolution**: it links a library item to exactly one placement, one provider file, and one exposure. The resolver does not need to choose — the binding has already chosen.

### 3.3 Existing Store Methods to Use

The resolver should use these existing `store.js` methods. **None need modification.**

| Method | Returns | Resolver Use |
|--------|---------|--------------|
| `listBindings(libraryItemId)` | All bindings for item | Historical/debug only |
| `listActiveBindingsForPlacement(placementId)` | Active bindings for placement | Not primary path |
| `getReconciliationSnapshot(libraryItemId, identity)` | Full snapshot | Debug/observable only |
| Direct SQL on `bindings` table | Active binding by identity | **Primary lookup** |

**Note:** There is no existing `findActiveBindingByIdentity(infoHash, fileIndexKey)` method. The resolver needs a thin query:

```sql
SELECT * FROM bindings
WHERE info_hash = ?
  AND file_index_key = ?
  AND status = 'active'
LIMIT 1;
```

This is a **new query on an existing table**. No schema change. No new method required in `store.js` — the resolver can prepare and execute this query directly against `store.db` or a new thin accessor.

### 3.4 Identity vs. Library Item

Two identity layers exist (per `MATERIALIZATION-RECONCILIATION.md` §1):

| Layer | Key | Used By |
|-------|-----|---------|
| **Content identity** | `(info_hash, file_index_key)` / `release_key` | Candidate mappings, placements, files, exposures, bindings |
| **Library identity** | `identity_key` = `movie:tt1234:default` | `library_items`, `library_paths` |

The resolver operates on **content identity**. It does not need `library_items` or `library_paths` for byte delivery. Those are consumer-layer concerns (Plex paths, .strm generation).

**Lookup path:**

```
(info_hash, file_index_key)
    │
    ▼
bindings (WHERE info_hash = ? AND file_index_key = ? AND status = 'active')
    │
    ├── binding.placement_id
    ├── binding.provider_file_id
    └── binding.exposure_id
          │
          ▼
exposures (WHERE id = ?)
    │
    ├── exposure.transport
    ├── exposure.relative_path
    └── exposure.state
```

---

## 4. Exposure Semantics

### 4.1 State Decoupling

Per `ACQUISITION-CONTRACT.md` §7 invariants:

```
Placement state  ≠  Exposure state  ≠  Binding state  ≠  Playback success
```

Each is an **independent observation** with its own freshness window:

| Layer | Table | State Column | Meaning |
|-------|-------|--------------|---------|
| Placement | `provider_placements` | `state` | Provider holds content: `pending`, `ready`, `degraded`, `error`, `removed`, `unknown` |
| Readiness | `provider_readiness_observations` | `state` | Ready to serve bytes: same state set |
| File presence | `provider_files` | `present` | File currently in inventory: `0` or `1` |
| Exposure | `exposures` | `state` | Visible on mount: `pending`, `visible`, `missing`, `degraded`, `error`, `unknown` |
| Binding | `bindings` | `status` | Active binding: `active`, `superseded`, `degraded`, `failed` |

The resolver only consumes the **final available projection**: a binding with `status = 'active'` that references an exposure with `state = 'visible'`.

### 4.2 When Exposure ≠ Ready

| Placement State | Exposure State | Binding State | Resolver Behavior |
|-----------------|----------------|---------------|-------------------|
| `ready` | `visible` | `active` | **Serve bytes** (200/206) |
| `ready` | `missing` | `active` | 423 — mount not visible, placement healthy |
| `ready` | `visible` | `degraded` | 503 — binding degraded, repair may be in progress |
| `degraded` | `visible` | `active` | 503 — placement degraded, bytes may be unreliable |
| `error` | `missing` | `failed` | 410 — permanently unavailable |
| any | any | no binding | 404 or 410 |

### 4.3 Freshness Windows

Every observation has `observed_at` and `expires_at`. The resolver should check freshness but **does not own freshness enforcement**:

| Observation | Freshness Field | Stale If |
|-------------|-----------------|----------|
| Binding | `reconciled_at` | Not in schema — binding is versioned, not time-fresh |
| Exposure | `observed_at`, `expires_at` | `expires_at <= now` |
| File presence | `inventory_observed_at`, `inventory_expires_at` | `inventory_expires_at <= now` |

If the resolver encounters a stale exposure observation, it does **not** trigger re-observation. It returns `503` and lets the observation layer refresh independently.

---

## 5. Transport Model

### 5.1 Architecture Decision

**The resolver reads from exposed filesystem paths. This is not a CDN redirect model.**

Per `MATERIALIZATION-ARCHITECTURE-V2.md` §4.1:

> The actual system observes filesystem exposures (e.g., via Zurg/rclone mounts) and serves bytes through the control-plane projection. CDN URLs are ephemeral and provider-specific; filesystem exposures are the stable transport layer.

**Transport determination:**

```
exposure.transport
    │
    ├── "zurg" ──▶ filesystem read from mount path + relative_path
    │
    ├── "webdav" ──▶ HTTP proxy to WebDAV endpoint
    │
    └── (future) ──▶ redirect to external transport
```

### 5.2 Transport Modes

| Mode | Current Support | Implementation |
|------|-----------------|----------------|
| **Filesystem read** | Primary — Zurg/rclone mounts expose local paths | Node.js `fs.createReadStream()` with Range support |
| **HTTP proxy** | Future — WebDAV backends | Node.js `http.request()` streaming through |
| **Redirect** | Not currently used — retired per V2 §4.1 | Would return 302 to external URL |

The resolver does **not** decide between redirect/proxy based on CDN capabilities (old model). It selects transport based on `exposure.transport`.

### 5.3 Filesystem Path Construction

For `transport = 'zurg'`:

```
mount_root (from deployment config) + relative_path (from exposure) → absolute filesystem path
```

`mount_scope` is a **logical identifier** (e.g., `'default'`, `'mount-a'`), not a filesystem path segment. The resolver MUST resolve the actual mount root from deployment configuration (environment variables), not from the database.

**Mount resolution boundary:**

| mount_scope | Deployment Config | Example Root |
|-------------|-------------------|--------------|
| `default` | `REALDEBRID_MOUNT_PATH` env var | `/mnt/zurg` |
| `torbox` | `TORBOX_MOUNT_PATH` env var | `/mnt/torbox` |
| `canonical` | `CANONICAL_LIBRARY_PATH` env var | `/mnt/library` |

This is a **deployment configuration boundary** — the resolver reads mount roots at startup, not at request time. Mount roots are not persisted to the database (no `mount_registry` table). This matches the existing pattern in `health.js` which inspects mounts via env vars.

Example:
- `mount_scope`: `default` → resolved via `REALDEBRID_MOUNT_PATH` → `/mnt/zurg`
- `relative_path`: `Movie (2024)/Movie.2024.1080p.mkv`
- Resolved path: `/mnt/zurg/Movie (2024)/Movie.2024.1080p.mkv`

**Path safety:** Resolver MUST validate resolved path remains within the configured mount root. No path traversal. Use `path.resolve()` + `path.relative()` check. Do NOT reuse `app.js → sendStatic()` — that function is hardcoded to the UI asset directory and cannot serve media bytes from arbitrary mount roots. A new `serveMedia` function with mount-root-aware path safety is required.

**NULL relative_path:** `exposure.relative_path` is nullable. If `relative_path` is NULL, the resolver MUST return `423 Locked` — the exposure exists but has no locatable bytes. This is distinct from `exposure.state = 'missing'` (which means the file was expected but not found).

### 5.4 File Size

From `provider_files.size` — the provider-reported file size. Used for:
- `Content-Length` header on 200 responses
- Range validation on 206 responses

---

## 6. HTTP Contract

### 6.1 Success Responses

| Code | Condition | Headers |
|------|-----------|---------|
| `200 OK` | Full byte stream | `Content-Length`, `Content-Type`, `Accept-Ranges: bytes`, `Cache-Control: no-store` |
| `206 Partial Content` | Range request satisfied | `Content-Range: bytes start-end/total`, `Content-Length`, `Accept-Ranges: bytes` |
| `304 Not Modified` | (Reserved — not currently implemented) | — |

**Content-Type:** Derived from file extension (`provider_files.name` or `exposure.relative_path`) using the same `CONTENT_TYPES` map pattern in `app.js`. Default: `application/octet-stream`.

### 6.2 Failure Responses

| Code | Condition | Meaning |
|------|-----------|---------|
| `400 Bad Request` | Invalid identity (bad info_hash, bad file_index) | Client error |
| `404 Not Found` | Identity never had a binding (no `bindings` row exists) | Content not in library |
| `410 Gone` | Binding exists but `status = 'failed'`; or no active binding and identity was previously known | Permanently unavailable |
| `423 Locked` | Exposure not visible (`state ≠ 'visible'`); or placement not ready | Temporary — mount/placement state blocking |
| `503 Service Unavailable` | Stale observations; binding `degraded`; exposure `degraded` | Temporary — may recover without intervention |
| `502 Bad Gateway` | Filesystem error reading from mount | Upstream observation error |

### 6.3 Error Response Body Format

Consistent with `app.js` error pattern:

```json
{ "error": "descriptive message" }
```

| Code | Example Body |
|------|-------------|
| 400 | `{ "error": "infoHash must be 40 hexadecimal characters" }` |
| 404 | `{ "error": "No active binding for this identity" }` |
| 410 | `{ "error": "Binding failed — content permanently unavailable" }` |
| 423 | `{ "error": "Exposure not visible on mount" }` |
| 503 | `{ "error": "Binding degraded — repair in progress" }` |
| 502 | `{ "error": "Failed to read from exposure transport" }` |

---

## 7. Range Handling

### 7.1 Plex Seek Behavior

Plex clients issue `Range: bytes=N-` requests for:
- Initial probe (small range to read container metadata)
- Seeking to arbitrary positions during playback
- Resume from last position

**Requirement:** Resolver MUST support `Range` headers for seek-heavy clients.

### 7.2 Where Range Support Belongs

Range support lives in the **resolver**, not the transport layer. The resolver:

1. Parses `Range: bytes=start-end` from request headers
2. Validates range against `provider_files.size`
3. Passes range to the transport reader:
   - **Filesystem:** `fs.createReadStream(path, { start, end })`
   - **Proxy:** Forwards `Range` header to upstream
4. Returns `206 Partial Content` with `Content-Range` header

### 7.3 Range Edge Cases

| Condition | Behavior |
|-----------|----------|
| No Range header | Full 200 response |
| `Range: bytes=0-` | Full 200 (or 206 with `Content-Range: bytes 0-N/N`) |
| `Range: bytes=100-200` | 206 with bytes 100–200 |
| `Range: bytes=100-` | 206 with bytes 100 to end |
| `Range: bytes=-500` | 206 with last 500 bytes (suffix) |
| Range exceeds file size | `416 Range Not Satisfiable` |
| Multiple ranges (multipart) | `206` with single range only (simplify — reject multi-range with 200 full content) |

### 7.4 Range Delegation

The resolver does **not** delegate Range handling to the client or upstream. It fully resolves the range and:
- For filesystem transport: reads the exact byte range
- For proxy transport: forwards the range and streams the response

The resolver is the range authority because it owns the `Content-Length` (from `provider_files.size`) and validates bounds.

---

## 8. Lifecycle Relationship

### 8.1 Resolver Observes, Does Not Own

The resolver **reads** lifecycle state but **never writes** to `lifecycle_events`. The lifecycle is owned by the control-plane store and the reconciler.

| Resolver Action | Lifecycle Effect |
|-----------------|------------------|
| Successful byte delivery | None — playback confirmation is future work |
| Failed byte delivery | None — resolver returns error code, does not log lifecycle event |
| Exposure missing | None — observation layer handles independently |

### 8.2 Placement State ≠ Exposure State ≠ Binding State

This is the critical architectural insight from `MATERIALIZATION-ARCHITECTURE-V2.md` §7:

- **Placement state** (`provider_placements.state`) — provider-side holding status
- **Readiness state** (`provider_readiness_observations.state`) — can provider serve bytes
- **Exposure state** (`exposures.state`) — is the file visible on a mount
- **Binding state** (`bindings.status`) — is there an active library→placement link
- **Lifecycle projection** (`lifecycle_events`) — append-only history of milestones

These are **independent observation streams**. The resolver consumes the binding as the authoritative "ready for playback" signal, but does not assume that binding implies live exposure. It still checks `exposure.state = 'visible'` before serving.

### 8.3 The Binding is the Cut Point

The binding (`bindings` table) is the **commit point** where the system decides: "this specific placement + provider file + exposure serves this library item." The resolver trusts this decision but verifies exposure freshness.

If the binding is stale or exposure is missing, the resolver returns error — it does not attempt to repair, re-observe, or create new placements.

---

## 9. Missing Implementation Seams

### 9.1 What Exists

| Component | Status | Location |
|-----------|--------|----------|
| Control-plane store | ✅ Implemented | `src/lib/control-plane/store.js` |
| Bindings table | ✅ Implemented | `store.js` §5.2.8 |
| Exposures table | ✅ Implemented | `store.js` §5.2.6 |
| Identity normalization | ✅ Implemented | `src/api/release-contract.js` |
| HTTP server framework | ✅ Implemented | `src/server/app.js` |
| Acquisition boundary | ✅ Implemented | `src/lib/acquisition/*.js` |
| Provider adapters | ✅ Implemented | `src/lib/providers/*.js` |

### 9.2 What Is Missing

| Missing Piece | Size | Location |
|---------------|------|----------|
| `GET /media/{info_hash}/{file_index}` route | Small — add to `app.js` | `src/server/app.js` |
| Resolver module (lookup + transport) | Medium — new file | `src/lib/resolver/resolver.js` |
| Binding-by-identity query | Small — new SQL query | Uses existing `bindings` table |
| Filesystem read with Range support | Small — Node.js `fs` | `src/lib/resolver/transport.js` |
| Exposure freshness check | Tiny — inline | `src/lib/resolver/resolver.js` |
| Mount resolution config | Small — env var lookup at startup | `src/lib/resolver/mounts.js` |
| `serveMedia` function (mount-root-aware) | Small — new function | `src/lib/resolver/transport.js` |

### 9.3 What to Avoid

| Anti-Pattern | Why |
|--------------|-----|
| Creating a `resolved_urls` table | Old CDN-redirect model — retired per V2 §4.1 |
| Building a resolver state machine | Existing lifecycle handles state; resolver is stateless |
| Adding provider API calls to resolver | Resolver is read-only; provider calls belong to observation layer |
| Caching bytes in resolver | Resolver is a projection; cache at filesystem or CDN level |
| Creating new identity columns | `(info_hash, file_index_key)` is canonical; already in bindings |

### 9.4 Reuse Over Rebuild

| Existing Code | Resolver Uses It For |
|---------------|---------------------|
| `createReleaseIdentity(infoHash, fileIndex)` | Normalize request path |
| `bindings` table (direct SQL) | Primary lookup |
| `exposures` table | Transport + freshness check |
| `provider_files.size` | Content-Length + range validation |
| `app.js` error handler (`isInput ? 400 : 502`) | Consistent error responses |
| `app.js` `CONTENT_TYPES` map | MIME type resolution |
| `health.js` mount inspection pattern | Mount root resolution via env vars |

---

## 10. Implementation Order

### Phase 1: Read-Only Lookup Layer

**Goal:** Given `(info_hash, file_index)`, return binding + exposure data as JSON.

| Task | File | Effort |
|------|------|--------|
| Add `GET /media/lookup/{info_hash}/{file_index}` route | `app.js` | Small |
| Implement identity parsing (reuse `createReleaseIdentity`) | `resolver.js` | Small |
| Query bindings by identity | `resolver.js` | Small |
| Query exposure by binding.exposure_id | `resolver.js` | Small |
| Return JSON: `{ binding, exposure, transport, ready }` | `resolver.js` | Small |

**Verification:** `curl http://localhost:3000/media/lookup/{hash}/{index}` returns binding/exposure state.

### Phase 2: HTTP Endpoint with Byte Delivery

**Goal:** Serve actual bytes for valid, visible bindings.

| Task | File | Effort |
|------|------|--------|
| Add `GET /media/{info_hash}/{file_index}` route | `app.js` | Small |
| Implement filesystem transport (read from exposure path) | `transport.js` | Small |
| Map binding/exposure state to HTTP status codes | `resolver.js` | Small |
| Set `Content-Length`, `Content-Type`, `Accept-Ranges` headers | `resolver.js` | Small |
| Return error codes (404/410/423/503) for non-byte states | `resolver.js` | Small |

**Verification:** `curl -I http://localhost:3000/media/{hash}/{index}` returns 200 with headers. `curl` with invalid hash returns 400.

### Phase 3: Streaming and Range Handling

**Goal:** Support Plex seek behavior with Range requests.

| Task | File | Effort |
|------|------|--------|
| Parse `Range` header | `resolver.js` | Small |
| Validate range against `provider_files.size` | `resolver.js` | Small |
| Implement `fs.createReadStream(path, { start, end })` | `transport.js` | Small |
| Return `206` with `Content-Range` header | `resolver.js` | Small |
| Handle edge cases (suffix range, out-of-bounds) | `resolver.js` | Small |
| Backpressure handling (stream piping) | `transport.js` | Small |

**Verification:** `curl -H "Range: bytes=0-1023" http://localhost:3000/media/{hash}/{index}` returns 206 with first 1KB.

### Phase 4: Observability

**Goal:** Make resolver behavior observable without adding new state.

| Task | File | Effort |
|------|------|--------|
| Log request latency (start → bytes served / error) | `resolver.js` | Small |
| Log cache-miss vs cache-miss (binding found / not found) | `resolver.js` | Small |
| Expose resolver stats via existing `/api/control-plane/health` | `health.js` | Small |
| Error logging (filesystem errors, stale exposures) | `resolver.js` | Small |

**Verification:** Check logs for resolver timing. Check health endpoint includes resolver stats.

---

## Appendix A: Reference — Store Methods Used

| Store Method | Resolver Usage |
|--------------|----------------|
| `listBindings(libraryItemId)` | Debug/observable only |
| `getReconciliationSnapshot(libraryItemId, identity)` | Debug/observable only |
| `db.prepare('SELECT * FROM bindings WHERE ...')` | **Primary lookup** |
| `db.prepare('SELECT * FROM exposures WHERE id = ?')` | Exposure verification |
| `db.prepare('SELECT * FROM provider_files WHERE ...')` | Size for Content-Length |

No new store methods required. The resolver prepares SQL directly against the existing `db` export from `store.js`.

## Appendix B: Request Flow Summary

```
Client (Plex/Web/Jellyfin)
    │
    ▼
GET /media/{info_hash}/{file_index}
    │
    ▼
┌─────────────────────────────────────┐
│  Resolver (resolver.js)             │
│                                     │
│  1. Parse identity from path        │
│  2. Normalize via createReleaseId   │
│  3. Query bindings table            │
│  4. Verify exposure.visible         │
│  5. Determine transport             │
│  6. Serve bytes or return error     │
└─────────────────────────────────────┘
    │
    ├── Success ──▶ 200/206 bytes from filesystem/proxy
    │
    └── Failure ──▶ 400/404/410/423/503
```

## Appendix C: No Code/Schema Changes Made

This document is **specification only**. No code was written. No schema was created. No migrations were proposed. No provider work was defined.

The resolver is a new consumer of existing tables. The only new artifacts are:
- A new route in `app.js`
- A new `src/lib/resolver/` module directory

Both consume existing structures without modification.

---

**End of document.**

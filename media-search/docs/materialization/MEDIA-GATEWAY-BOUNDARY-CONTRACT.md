# Media Gateway Boundary Contract

**Date:** 2026-08-23  
**Status:** Contract — normative constraints on media gateway behavior  
**Supersedes:** `MEDIA-GATEWAY-BOUNDARY-ANALYSIS.md` (analysis → contract)  
**Grounded in:** `MATERIALIZATION-ARCHITECTURE-V2.md`, `RESOLVER-IMPLEMENTATION-PLAN.md`, `ARCHITECTURE-BOUNDARIES.md`, `CONTRACTS.md`  
**Cross-checked against:** `REVERSE-PROXY-BOUNDARY-ANALYSIS.md`, `DEPLOYMENT-BOUNDARY-ANALYSIS.md`, `STATE-MACHINE-REFERENCE.md`  
**Constraints:** No code; no schema; no implementation; no architecture changes; resolver design and V2 architecture unchanged

---

## 1. Purpose

This document defines the **normative boundary** of the media gateway. It answers five questions contractually:

1. What does the gateway **own**?
2. What are its **transport semantics**?
3. What **crosses the edge boundary**?
4. What data may the gateway **read**?
5. What are its **forbidden responsibilities**?

Each answer is stated as a MUST / MUST NOT / MAY constraint. Violations break the contract.

---

## 2. Exact Gateway Ownership

### 2.1 Identity

| ID | Constraint |
|----|------------|
| **GW-OWN-1** | The media gateway **MUST** be the runtime implementation of the resolver contract defined in `RESOLVER-IMPLEMENTATION-PLAN.md`. |
| **GW-OWN-2** | The media gateway **MUST** implement exactly one HTTP endpoint: `GET /media/{info_hash}/{file_index}`. |
| **GW-OWN-3** | The media gateway **MUST** own identity normalization via `createReleaseIdentity(infoHash, fileIndex)` from `release-contract.js`. No re-implementation. |

### 2.2 Binding and Exposure

| ID | Constraint |
|----|------------|
| **GW-OWN-4** | The media gateway **MUST** resolve playback by reading the `bindings` table where `info_hash = ? AND file_index_key = ? AND status = 'active'`. |
| **GW-OWN-5** | The media gateway **MUST** verify `exposures.state = 'visible'` for the exposure referenced by `binding.exposure_id` before serving bytes. |
| **GW-OWN-6** | The media gateway **MUST** determine transport mode from `exposure.transport` (`zurg` or `webdav`). No other transport modes are currently valid. |

### 2.3 Byte Delivery

| ID | Constraint |
|----|------------|
| **GW-OWN-7** | The media gateway **MUST** own byte delivery in all supported transport modes. |
| **GW-OWN-8** | The media gateway **MUST** own `Range` header parsing, validation against `provider_files.size`, and `206 Partial Content` response construction. |
| **GW-OWN-9** | The media gateway **MUST** set `Content-Length`, `Content-Type`, `Accept-Ranges: bytes`, and `Cache-Control: no-store` on success responses. |
| **GW-OWN-10** | The media gateway **MUST** map binding/exposure state to HTTP status codes per `RESOLVER-IMPLEMENTATION-PLAN.md` §6.2. |

### 2.4 Failure Classification

| ID | Constraint |
|----|------------|
| **GW-OWN-11** | The media gateway **MUST** return `400` for invalid identity input. |
| **GW-OWN-12** | The media gateway **MUST** return `404` when no binding exists for the identity. |
| **GW-OWN-13** | The media gateway **MUST** return `410` when a binding exists but `status = 'failed'` or the identity was previously known but no active binding remains. |
| **GW-OWN-14** | The media gateway **MUST** return `423` when `exposure.state ≠ 'visible'` or `exposure.relative_path` is NULL. |
| **GW-OWN-15** | The media gateway **MUST** return `502` on filesystem read errors (transport failure). |
| **GW-OWN-16** | The media gateway **MUST** return `503` on stale observations, degraded bindings, or degraded exposures. |

### 2.5 Process Identity

| ID | Constraint |
|----|------------|
| **GW-OWN-17** | The media gateway **SHOULD** run as a separate process from the control-plane API. |
| **GW-OWN-18** | The media gateway **MUST** bind to loopback or an internal Docker network only. It MUST NOT bind to a publicly-reachable interface. |
| **GW-OWN-19** | The media gateway **MUST NOT** require direct inbound connections from the edge proxy beyond the routed `/media/*` path. |

---

## 3. Transport Semantics

### 3.1 Architecture Decision (Normative)

| ID | Constraint |
|----|------------|
| **GW-TRANS-1** | The media gateway **MUST** read bytes from exposed filesystem paths. This is the primary and currently only production transport. |
| **GW-TRANS-2** | The CDN redirect model (`302` to provider CDN) is **retired** per `MATERIALIZATION-ARCHITECTURE-V2.md` §4.1. The media gateway **MUST NOT** implement redirect-to-CDN transport. |
| **GW-TRANS-3** | The media gateway **MAY** implement HTTP proxy transport to WebDAV backends in a future phase. This is not currently required. |

### 3.2 Filesystem Transport

| ID | Constraint |
|----|------------|
| **GW-TRANS-4** | For `exposure.transport = 'zurg'`, the media gateway **MUST** construct the absolute filesystem path by resolving the mount root from deployment configuration (environment variables) and appending `exposure.relative_path`. |
| **GW-TRANS-5** | The media gateway **MUST** resolve mount roots at startup, not at request time. |
| **GW-TRANS-6** | The media gateway **MUST** validate that the resolved path remains within the configured mount root. Path traversal is forbidden. |
| **GW-TRANS-7** | The media gateway **MUST** use `fs.createReadStream(path, { start, end })` for Range-aware reads. |
| **GW-TRANS-8** | The media gateway **MUST** use `provider_files.size` for `Content-Length` and Range validation. |
| **GW-TRANS-9** | The media gateway **MUST** reject suffix ranges and multi-range requests with a single 200 full-content response (simplification per `RESOLVER-IMPLEMENTATION-PLAN.md` §7.3). |

### 3.3 Streaming

| ID | Constraint |
|----|------------|
| **GW-TRANS-10** | The media gateway **MUST** stream bytes without buffering the entire content. |
| **GW-TRANS-11** | The media gateway **MUST** handle backpressure correctly when piping streams to the client. |
| **GW-TRANS-12** | The media gateway **MUST** respect connection lifecycle: close CDN/upstream connections on client disconnect. |

### 3.4 Mount Configuration

| ID | Constraint |
|----|------------|
| **GW-TRANS-13** | Mount roots **MUST** be read from environment variables (e.g., `REALDEBRID_MOUNT_PATH`, `TORBOX_MOUNT_PATH`). |
| **GW-TRANS-14** | `mount_scope` in the database is a **logical identifier only**. The media gateway **MUST** resolve it to a filesystem path via deployment configuration, NOT via database lookup. |
| **GW-TRANS-15** | There is **no** `mount_registry` table. The media gateway **MUST NOT** create one. |

---

## 4. What Crosses the Edge Boundary

### 4.1 Inbound (Edge Proxy → Media Gateway)

| ID | Constraint |
|----|------------|
| **GW-EDGE-1** | Only HTTP `GET /media/{info_hash}/{file_index}` requests **MUST** cross the edge boundary to the media gateway. |
| **GW-EDGE-2** | The `Range` header **MUST** be forwarded unchanged from the edge proxy. |
| **GW-EDGE-3** | The `If-Range` and `If-Modified-Since` headers **MUST** be forwarded unchanged (though the media gateway currently ignores `If-Modified-Since`). |
| **GW-EDGE-4** | The edge proxy **MUST** strip `X-Resolver-*` internal headers before forwarding responses back to clients. |
| **GW-EDGE-5** | The edge proxy **MUST NOT** buffer response bodies for `/media/*` paths. |
| **GW-EDGE-6** | The edge proxy **MUST** disable response buffering for `/media/*` to preserve Range semantics. |

### 4.2 Outbound (Media Gateway → Edge Proxy → Client)

| ID | Constraint |
|----|------------|
| **GW-EDGE-7** | HTTP status codes, `Content-Length`, `Content-Type`, `Content-Range`, `Accept-Ranges`, and `Cache-Control` headers **MUST** be set by the media gateway. |
| **GW-EDGE-8** | The response body **MUST** be a raw byte stream or nothing (error responses are JSON with no byte body). |
| **GW-EDGE-9** | The media gateway **MUST NOT** set cookies, session tokens, or authentication headers. |
| **GW-EDGE-10** | The media gateway **MUST NOT** emit `X-Resolver-*` or any internal-state headers to the edge proxy. |

### 4.3 What MUST NOT Cross

| ID | Constraint |
|----|------------|
| **GW-EDGE-11** | Provider API keys **MUST NOT** cross the edge boundary. They are used only between the media gateway and provider CDNs (future WebDAV proxy mode) or by provider adapters (observation layer, not gateway). |
| **GW-EDGE-12** | Database connection strings **MUST NOT** cross the edge boundary. |
| **GW-EDGE-13** | Filesystem mount paths **MUST NOT** cross the edge boundary. The gateway resolves mount roots internally; they never leave the trusted zone. |
| **GW-EDGE-14** | Control-plane write operations **MUST NOT** cross the edge boundary. The gateway is read-only. |
| **GW-EDGE-15** | Corpus metadata, release evidence, and ranking scores **MUST NOT** cross the edge boundary. |

---

## 5. What Data the Gateway Can Read

### 5.1 Authorized Read Tables

| Table | Columns Used | Purpose |
|-------|--------------|---------|
| `bindings` | `info_hash`, `file_index`, `file_index_key`, `status`, `placement_id`, `provider_file_id`, `exposure_id`, `version`, `valid_from`, `superseded_at` | Primary lookup: find active binding by identity |
| `exposures` | `id`, `placement_id`, `provider_file_id`, `transport`, `exposure_key`, `relative_path`, `state`, `read_only`, `observed_at`, `expires_at` | Transport determination and freshness check |
| `provider_files` | `id`, `placement_id`, `provider_file_id`, `path`, `name`, `size`, `selected`, `corpus_file_index`, `present`, `missing_since`, `inventory_observed_at`, `inventory_expires_at` | `Content-Length`, Range validation, filename for `Content-Type` |

### 5.2 Authorized Read Queries

| ID | Constraint |
|----|------------|
| **GW-READ-1** | The media gateway **MUST** query `bindings` directly: `SELECT * FROM bindings WHERE info_hash = ? AND file_index_key = ? AND status = 'active' LIMIT 1`. |
| **GW-READ-2** | The media gateway **MUST** query `exposures` by `id`: `SELECT * FROM exposures WHERE id = ?` (using `binding.exposure_id`). |
| **GW-READ-3** | The media gateway **MAY** read `provider_files.size` and `provider_files.name` for `Content-Length` and `Content-Type` derivation. |
| **GW-READ-4** | The media gateway **MAY** check `exposures.observed_at` and `exposures.expires_at` for freshness. Stale observations result in `503`, not re-observation. |
| **GW-READ-5** | The media gateway **MAY** check `provider_files.inventory_observed_at` and `provider_files.inventory_expires_at` for file presence freshness. |

### 5.3 Forbidden Reads

| ID | Constraint |
|----|------------|
| **GW-READ-6** | The media gateway **MUST NOT** read from `lifecycle_events`. Lifecycle history is owned by the control plane and reconciler. |
| **GW-READ-7** | The media gateway **MUST NOT** read from `repair_transactions` or `repair_steps`. Repair state is owned by the repair control plane. |
| **GW-READ-8** | The media gateway **MUST NOT** read from `library_items` or `library_paths`. Library identity is a consumer-layer concern. The gateway operates on content identity only. |
| **GW-READ-9** | The media gateway **MUST NOT** read from `provider_placements` directly. The binding already resolves placement; the gateway does not query placement state independently. |
| **GW-READ-10** | The media gateway **MUST NOT** read from `provider_placement_observations` or `provider_readiness_observations`. These are observation-layer concerns. |
| **GW-READ-11** | The media gateway **MUST NOT** read from `candidate_file_mappings`. The binding already resolves the file mapping. |
| **GW-READ-12** | The media gateway **MUST NOT** read from `zurg_metadata_observations`. Zurg metadata is observation evidence, not gateway input. |
| **GW-READ-13** | The media gateway **MUST NOT** read from `discovery-cache.db` or any corpus/evidence tables. The corpus is upstream of the binding. |
| **GW-READ-14** | The media gateway **MUST NOT** read provider API state (e.g., TorBox account status, RD torrent state). The binding is the projection of that state. |

### 5.4 Read Semantics

| ID | Constraint |
|----|------------|
| **GW-READ-15** | All reads by the media gateway **MUST** be against the existing control-plane store (`store.db`). The gateway **MUST NOT** create a separate database. |
| **GW-READ-16** | The media gateway **MUST** use prepared SQL queries against the existing `db` export from `store.js`. |
| **GW-READ-17** | The media gateway **MUST NOT** write to any table. It is a read-only projection layer. |

---

## 6. Forbidden Responsibilities

### 6.1 Transport

| ID | Constraint |
|----|------------|
| **GW-FORBID-1** | The media gateway **MUST NOT** terminate TLS. TLS termination is the edge proxy's responsibility. |
| **GW-FORBID-2** | The media gateway **MUST NOT** implement authentication. Authentication is enforced at the edge. The gateway trusts the edge's routing decision. |
| **GW-FORBID-3** | The media gateway **MUST NOT** implement rate limiting. Rate limiting is the edge's responsibility. |
| **GW-FORBID-4** | The media gateway **MUST NOT** implement request logging for audit. Access logging is the edge's responsibility. |

### 6.2 Control Plane

| ID | Constraint |
|----|------------|
| **GW-FORBID-5** | The media gateway **MUST NOT** call provider APIs directly. Provider interaction belongs to the capability adapter layer. |
| **GW-FORBID-6** | The media gateway **MUST NOT** create, update, or delete provider placements. Placement is upstream of the binding. |
| **GW-FORBID-7** | The media gateway **MUST NOT** write to `lifecycle_events`. Playback success/failure is not currently a lifecycle event (future work). |
| **GW-FORBID-8** | The media gateway **MUST NOT** trigger re-observation. If an exposure is stale, the gateway returns `503` and lets the observation layer refresh independently. |
| **GW-FORBID-9** | The media gateway **MUST NOT** trigger repair. Repair is owned by the repair control plane. |
| **GW-FORBID-10** | The media gateway **MUST NOT** create or modify bindings. Bindings are created by the reconciler. |

### 6.3 Identity and Library

| ID | Constraint |
|----|------------|
| **GW-FORBID-11** | The media gateway **MUST NOT** create or modify library items or library paths. These are consumer-layer concerns. |
| **GW-FORBID-12** | The media gateway **MUST NOT** read corpus metadata, release evidence, or ranking inputs. The gateway consumes the binding, not the corpus. |
| **GW-FORBID-13** | The media gateway **MUST NOT** implement consumer adapters (Plex paths, `.strm` generation, WebDAV, FUSE). These wrap the gateway's HTTP endpoint but are not the gateway. |
| **GW-FORBID-14** | The media gateway **MUST NOT** choose which provider to serve. The binding determines the provider. |

### 6.4 State

| ID | Constraint |
|----|------------|
| **GW-FORBID-15** | The media gateway **MUST NOT** cache resolved URLs. The CDN-redirect model is retired; there are no URLs to cache. |
| **GW-FORBID-16** | The media gateway **MUST NOT** maintain a state machine. It is stateless across requests; it reads the current binding state on each request. |
| **GW-FORBID-17** | The media gateway **MUST NOT** buffer media bytes in memory for caching purposes. |
| **GW-FORBID-18** | The media gateway **MUST NOT** create a `resolved_urls` table. This anti-pattern is retired per `MATERIALIZATION-ARCHITECTURE-V2.md` §4.1. |

---

## 7. Failure Handling Constraints

### 7.1 Edge Proxy Failure

| ID | Constraint |
|----|------------|
| **GW-FAIL-1** | If the edge proxy fails, existing media streams **MUST** continue unaffected. The media gateway is a separate process. |
| **GW-FAIL-2** | The media gateway **MUST** be independently restartable from the edge proxy. |

### 7.2 Media Gateway Failure

| ID | Constraint |
|----|------------|
| **GW-FAIL-3** | If the media gateway fails, the control-plane API **MUST** remain functional. Search, discovery, and acquisition continue. |
| **GW-FAIL-4** | If the media gateway fails, existing playback sessions **MAY** be interrupted. This is acceptable; clients retry. |

### 7.3 Stale Observation

| ID | Constraint |
|----|------------|
| **GW-FAIL-5** | If `exposures.expires_at <= now`, the media gateway **MUST** return `503 Service Unavailable`. It MUST NOT attempt to refresh the exposure. |
| **GW-FAIL-6** | If `exposure.state = 'missing'`, the media gateway **MUST** return `423 Locked`. It MUST NOT infer provider deletion. |

### 7.4 Mount Unavailable

| ID | Constraint |
|----|------------|
| **GW-FAIL-7** | If the filesystem mount is unreachable (ENOSPC, EIO, ENOENT on read), the media gateway **MUST** return `502 Bad Gateway`. |
| **GW-FAIL-8** | If `exposure.relative_path` is NULL, the media gateway **MUST** return `423 Locked`. |

---

## 8. Boundary Summary

### 8.1 Gateway IS

- Runtime implementation of `GET /media/{info_hash}/{file_index}`
- Read-only projection layer over `bindings` + `exposures` + `provider_files`
- Byte streamer with Range support
- Failure classifier (400/404/410/423/502/503)
- Consumer of the binding as the cut point

### 8.2 Gateway IS NOT

- TLS terminator
- Authenticator
- Rate limiter
- Provider API caller
- Placement creator
- Lifecycle writer
- Repair orchestrator
- Consumer adapter (Plex/WebDAV/.strm/FUSE)
- CDN redirector (retired model)
- Library path manager

### 8.3 Gateway Reads

| Authorized | Forbidden |
|------------|-----------|
| `bindings` | `lifecycle_events` |
| `exposures` | `repair_transactions` / `repair_steps` |
| `provider_files` (size, name) | `library_items` / `library_paths` |
| Mount root config (env vars) | `provider_placements` |
| | `candidate_file_mappings` |
| | `zurg_metadata_observations` |
| | `discovery-cache.db` (corpus) |
| | Provider API state |

### 8.4 Gateway Writes

| Allowed | Forbidden |
|---------|-----------|
| Nothing — read-only | Any table |

---

## 9. Compliance Verification

A media gateway implementation **complies** with this contract if:

1. It implements only `GET /media/{info_hash}/{file_index}`.
2. It reads only from `bindings`, `exposures`, and `provider_files`.
3. It writes nothing.
4. It binds to loopback/internal only.
5. It does not call provider APIs.
6. It does not create/modify bindings or placements.
7. It returns only the status codes listed in §2.4.
8. It does not implement TLS, auth, or rate limiting.
9. It resolves mount roots from env vars at startup.
10. It uses `fs.createReadStream` for filesystem transport.

An implementation that violates any **MUST** constraint is non-compliant.

---

## 10. Relationship to Prior Documents

| Prior Document | Relationship |
|----------------|--------------|
| `RESOLVER-IMPLEMENTATION-PLAN.md` | Ground truth for resolver behavior. This contract extracts normative constraints from it. |
| `MATERIALIZATION-ARCHITECTURE-V2.md` | Ground truth for control-plane model. This contract respects V2's ownership boundaries (§3.5) and transport decision (§4.1). |
| `MEDIA-GATEWAY-BOUNDARY-ANALYSIS.md` | Analysis superseded by this contract. Where analysis recommended, this contract requires. |
| `REVERSE-PROXY-BOUNDARY-ANALYSIS.md` | Complementary. Defines the edge layer; this contract defines the gateway layer behind it. |
| `DEPLOYMENT-BOUNDARY-ANALYSIS.md` | Complementary. Defines zones; this contract defines gateway behavior within the trusted zone. |
| `ARCHITECTURE-BOUNDARIES.md` | Upstream boundary rules; this contract is a downstream refinement. |
| `CONTRACTS.md` | Upstream contract patterns; this contract follows the same MUST/MUST NOT/MAY pattern. |

---

**End of contract.**

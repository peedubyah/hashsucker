# Provider Adapter — Ownership Boundary & Phase 1 Interface

**Date:** 2026-08-23  
**Scope:** Contract between the materialization resolver and provider adapters  
**Complements:** `RESOLVER-DESIGN.md` (resolver endpoint), `REALDEBRID-EXECUTION-STRUCTURE.md` (RD API)  
**Constraints:** No code; no RD-specific logic; no WebDAV/FUSE; no UI; boundary only

---

## 1. Ownership Boundary

The materialization layer splits into two ownership zones:

```
┌─────────────────────────────────────────────────────────────────┐
│                    RESOLVER (owns this)                         │
│                                                                 │
│  HTTP contract • URL lifecycle • State machine • Range decision │
│  .strm generation • Event log • Identity resolution             │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              PROVIDER ADAPTER (owns this)                 │  │
│  │                                                           │  │
│  │  Status → state mapping  • URL production  • URL refresh  │  │
│  │  Failure reason translation  • TTL reporting              │  │
│  │                                                           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.1 Resolver Owns

| Responsibility | Why |
|----------------|-----|
| HTTP endpoint contract (302/200/206/4xx/5xx) | Consumer-facing contract; provider-agnostic |
| URL lifecycle (freshness, refresh trigger, expiry buffer) | All providers share the same lifecycle model |
| State machine (`acquiring → available → expired → repairing → failed`) | Uniform across providers |
| Range support decision (redirect vs proxy) | HTTP-level concern, not provider-specific |
| .strm generation | Consumer adapter, not provider concern |
| Event logging (lifecycle_event schema) | Uniform schema regardless of provider |
| Identity resolution (`info_hash + file_index` → placement record) | Corpus identity is provider-agnostic |
| Retry/failure classification (404/410/423/429/502/503/504) | HTTP semantics, not provider semantics |

### 1.2 Provider Adapter Owns

| Responsibility | Why |
|----------------|-----|
| Status → lifecycle state mapping | Each provider has different status values |
| URL production (produce playable byte source from placement) | Provider-specific API calls |
| URL refresh (re-resolve expired link) | Provider-specific API calls |
| Failure reason translation (provider error → canonical reason) | Provider-specific error codes |
| TTL reporting (how long a URL remains valid) | Provider-specific URL semantics |
| Range capability detection (does this CDN support Range?) | Provider-specific CDN behavior |

### 1.3 Neither Owns

| Responsibility | Actual Owner |
|----------------|--------------|
| Acquisition decision (what to place, when) | Placement layer (upstream) |
| Release ranking / quality scoring | Discovery/ranking layer (upstream) |
| Filename parsing / metadata extraction | Ingest/parser layer (upstream) |
| Library path management (Plex folder structure) | Consumer adapter (downstream) |
| WebDAV / FUSE filesystem export | Consumer adapter (downstream) |
| Transcoding | Client (downstream) |

---

## 2. Things Provider Adapters Must NOT Do

Explicitly forbidden responsibilities.

Provider adapters must NOT:

| Forbidden | Rationale |
|-----------|-----------|
| **Rank releases** | Ranking is upstream of materialization. The adapter receives an identity; it does not choose between candidates. |
| **Parse filenames** | Parsing happened during ingest. The adapter operates on already-resolved identity. |
| **Decide quality** | Quality is a discovery/ranking concern. The adapter produces bytes, not judgments. |
| **Manage Plex paths** | Library layout is a consumer concern. The adapter does not know where files live on disk. |
| **Generate .strm files** | .strm generation is a consumer adapter concern. The adapter produces URLs, not library artifacts. |
| **Expose WebDAV** | WebDAV is a consumer transport. The adapter produces byte sources, not filesystem interfaces. |
| **Know UI concepts** | The adapter has no knowledge of players, libraries, or user interfaces. |
| **Perform acquisition decisions** | The adapter refreshes URLs for already-placed content. It does not decide what to place. |
| **Cache URLs long-term** | URLs are ephemeral. The adapter resolves on demand; the resolver manages freshness windows. |
| **Maintain lifecycle state** | State is the resolver's responsibility. The adapter reports status; the resolver owns the state machine. |
| **Handle HTTP Range directly** | Range passthrough/proxy is the resolver's job. The adapter returns a URL; the resolver decides how to serve it. |
| **Coordinate across providers** | Multi-provider failover is the resolver's job. Each adapter is a single-provider black box. |

Provider adapters only:

> **"Given a media identity, produce or refresh a playable byte source."**

---

## 3. Phase 1 Interface — Minimum Viable Abstraction

### 3.1 Design Goals

- One provider today (Real-Debrid)
- Multiple providers later (TorBox, Premiumize)
- No rewrite when adding providers

### 3.2 Core Methods

```yaml
# Pseudocode — interface contract only

interface ProviderAdapter:

  # Produce a playable byte source for a placed identity.
  # Called on first request or after URL expiry.
  # Returns: { url, mode, expires_at, bytes, content_type }
  # Throws: AuthError | RateLimitError | NotFoundError | ProviderError
  resolve(identity: MediaIdentity) -> PlayableSource

  # Refresh an expired URL without creating a new placement.
  # Called when URL freshness check fails.
  # Returns: { url, expires_at }
  # Throws: AuthError | RateLimitError | NotFoundError | ProviderError
  refresh(identity: MediaIdentity, current: PlayableSource) -> PlayableSource

  # Report current lifecycle state for a placement.
  # Maps provider-specific status → canonical lifecycle state.
  # Returns: { state, failure_reason }
  getStatus(identity: MediaIdentity) -> PlacementStatus
```

### 3.3 Data Structures

```yaml
# Corpus identity — stable, portable, provider-agnostic
MediaIdentity:
  info_hash: string          # 40-char lowercase hex SHA-1
  file_index: integer | null # null = torrent-level
  file_index_key: integer    # -1 when file_index is NULL (SQLite convention)

# What the adapter returns — a playable byte source
PlayableSource:
  url: string                # CDN URL (ephemeral)
  mode: "redirect" | "proxy" # Does CDN support Range?
  expires_at: ISO8601        # URL expiry timestamp
  bytes: integer | null      # File size (if known)
  content_type: string | null # MIME type (if known)

# What the adapter reports — current lifecycle state
PlacementStatus:
  state: "acquiring" | "available" | "expired" | "repairing" | "failed"
  failure_reason: "no_seeders" | "auth_error" | "rate_limited" | "provider_error" | null
  provider_resource_id: string | null  # Opaque provider-side ID

# Error types — provider-agnostic failure classification
AuthError:         { code: "auth_error", message: string }
RateLimitError:    { code: "rate_limited", retry_after: integer }
NotFoundError:     { code: "not_found", message: string }
ProviderError:     { code: "provider_error", message: string }
```

### 3.4 Method Semantics

#### `resolve(identity)`

| Aspect | Contract |
|--------|----------|
| **Input** | `MediaIdentity` — corpus identity only |
| **Output** | `PlayableSource` — URL + metadata |
| **Idempotent** | Yes — same identity returns equivalent source |
| **Side effects** | None (read-only against provider API) |
| **On auth failure** | Throw `AuthError` |
| **On rate limit** | Throw `RateLimitError` with `retry_after` |
| **On not found** | Throw `NotFoundError` |
| **On provider error** | Throw `ProviderError` |

#### `refresh(identity, current)`

| Aspect | Contract |
|--------|----------|
| **Input** | `MediaIdentity` + current `PlayableSource` |
| **Output** | New `PlayableSource` with fresh URL |
| **Idempotent** | No — produces a new URL each call |
| **Side effects** | May invalidate old URL (provider-dependent) |
| **On failure** | Same error types as `resolve()` |

#### `getStatus(identity)`

| Aspect | Contract |
|--------|----------|
| **Input** | `MediaIdentity` |
| **Output** | `PlacementStatus` — state + reason |
| **Idempotent** | Yes |
| **Side effects** | None |
| **On failure** | Same error types as `resolve()` |

### 3.5 Status Mapping Contract

Each adapter must map provider-specific status values to canonical lifecycle states:

| Canonical State | Meaning |
|-----------------|---------|
| `acquiring` | Placement in progress; no playable URL yet |
| `available` | Playable URL ready |
| `expired` | URL expired; refresh may recover |
| `repairing` | Refresh/re-placement in progress |
| `failed` | Permanent failure; no recovery without re-placement |

Provider-specific status values are the adapter's implementation detail. The resolver never sees them.

### 3.6 What Can Wait

| Feature | Phase | Why It Can Wait |
|---------|-------|-----------------|
| **Multi-provider failover** | 5 | Single provider is sufficient for Phase 1 |
| **Background refresh** | 4 | Synchronous refresh on request is sufficient |
| **CDN preflight cache** | 4 | HEAD check per request is acceptable initially |
| **Rate limit coordination** | 4 | Single-user assumption; no cross-provider coordination needed |
| **Provider health monitoring** | 5 | Not needed until multi-provider |
| **URL pooling / connection reuse** | 4 | Optimization, not correctness |
| **Streaming proxy with backpressure** | 4 | Only needed if CDN lacks Range (proxy mode) |
| **Authentication refresh** | 4 | Long-lived tokens; manual refresh sufficient |

---

## 4. Implementation Scope

### 4.1 Components to Build

| Component | Owner | Complexity |
|-----------|-------|------------|
| Provider interface (3 methods) | Shared contract | Low |
| Real-Debrid adapter | Provider adapter | Medium |
| Status mapping (RD → canonical) | RD adapter | Low |
| URL production (RD unrestricted link) | RD adapter | Medium |
| URL refresh (RD re-unrestrict) | RD adapter | Medium |
| Error classification (RD → canonical) | RD adapter | Low |

### 4.2 Components NOT in Scope

| Component | Why |
|-----------|-----|
| TorBox / Premiumize adapter | Phase 5 |
| Multi-provider selection | Phase 5 |
| Background refresh scheduler | Phase 4 |
| WebDAV server | Phase 2 |
| FUSE filesystem | Phase 3 |
| Local file cache | Never (defeats debrid purpose) |
| Transcoding | Client concern |

---

## 5. Summary

The provider adapter boundary is:

1. **Resolver owns:** HTTP contract, lifecycle, state machine, Range decision, .strm generation, events
2. **Adapter owns:** Status mapping, URL production, URL refresh, failure translation, TTL reporting
3. **Adapter does NOT own:** Ranking, parsing, quality, paths, .strm files, WebDAV, UI, acquisition

The Phase 1 interface is three methods:

- `resolve(identity) → PlayableSource`
- `refresh(identity, current) → PlayableSource`
- `getStatus(identity) → PlacementStatus`

With two data structures:

- `PlayableSource` — what the adapter produces
- `PlacementStatus` — what the adapter reports

Everything else can wait.

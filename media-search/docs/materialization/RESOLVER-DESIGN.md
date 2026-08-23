# HTTP Materialization Resolver — Design Specification

**Date:** 2026-08-23  
**Scope:** Minimal `GET /media/{info_hash}/{file_index}` resolver endpoint  
**Complements:** `MATERIALIZATION-ARCHITECTURE.md` (architecture), `REALDEBRID-EXECUTION-STRUCTURE.md` (provider API)  
**Constraints:** No WebDAV; no FUSE; no provider acquisition code modification; no local file cache

---

## 1. Problem Statement

The materialization layer (defined in MATERIALIZATION-ARCHITECTURE.md §7) requires a concrete **resolver endpoint** — the single source of truth that maps stable content identity to playable bytes:

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

This document specifies the minimal HTTP contract for that endpoint, including:
- Request/response schemas
- Redirect vs proxy architecture
- HTTP Range support
- Provider URL lifecycle handling
- Failure modes and degradation
- Lifecycle events for future repair
- Required tests

---

## 2. Endpoint Contract

### 2.1 URL Pattern

```
GET /media/{info_hash}/{file_index}
```

| Parameter | Format | Example |
|-----------|--------|---------|
| `info_hash` | 40-char lowercase hex SHA-1 | `abc123def456...` |
| `file_index` | `null` or integer ≥ 0 | `null`, `0`, `1`, `42` |

**URL encoding:** `file_index=null` is encoded as `~` (tilde) for URL safety:

```
GET /media/abc123def456.../~
GET /media/abc123def456.../0
GET /media/abc123def456.../1
```

**Rationale:** Tilde is URL-safe, single-character, and unlikely to collide with integer indices.

### 2.2 Request Headers

| Header | Required | Purpose |
|--------|----------|---------|
| `Range` | No | Byte range for seeking (e.g., `bytes=0-1023`) |
| `If-Modified-Since` | No | Conditional request (unused but accepted) |
| `Accept` | No | Client preference (ignored — resolver determines content-type) |

### 2.3 Response — Success (Redirect Mode)

When the resolver can issue a **direct redirect** to the provider CDN URL:

```http
HTTP/1.1 302 Found
Location: https://cdn.rd.com/file.mkv?token=abc123
Content-Length: 0
Cache-Control: no-store
X-Resolver-State: available
X-Resolver-Resolved-At: 2026-08-23T14:30:00Z
X-Resolver-Expires-At: 2026-08-24T14:30:00Z
X-Resolver-Provider: real-debrid
X-Resolver-Resource-Id: ABC123DEF456
```

**Critical:** `Cache-Control: no-store` prevents intermediaries from caching the ephemeral CDN URL.

### 2.4 Response — Success (Proxy Mode)

When the resolver must **proxy** the bytes (provider CDN doesn't support range, or direct redirect fails):

```http
HTTP/1.1 200 OK
Content-Type: video/x-matroska
Content-Length: 8589934592
Accept-Ranges: bytes
Content-Disposition: attachment; filename="Movie.2024.2160p.mkv"
X-Resolver-State: available
X-Resolver-Mode: proxy
X-Resolver-Resolved-At: 2026-08-23T14:30:00Z
X-Resolver-Expires-At: 2026-08-24T14:30:00Z
X-Resolver-Provider: real-debrid
X-Resolver-Resource-Id: ABC123DEF456

[binary stream]
```

### 2.5 Response — Partial Content (Range Request)

```http
HTTP/1.1 206 Partial Content
Content-Type: video/x-matroska
Content-Range: bytes 0-1023/8589934592
Content-Length: 1024
Accept-Ranges: bytes
X-Resolver-State: available
X-Resolver-Mode: proxy

[binary stream — bytes 0-1023]
```

### 2.6 Response — Failure Modes

| HTTP Status | Meaning | Headers |
|-------------|---------|---------|
| `404 Not Found` | Content identity unknown to resolver | `X-Resolver-Error: unknown_identity` |
| `410 Gone` | Placement permanently failed, no repair possible | `X-Resolver-Error: placement_failed`, `X-Resolver-Failure-Reason: ...` |
| `423 Locked` | Media available but link expired, repair in progress | `X-Resolver-State: repairing`, `Retry-After: 30` |
| `429 Too Many Requests` | Provider rate limit hit | `X-Resolver-Error: rate_limited`, `Retry-After: 60` |
| `502 Bad Gateway` | Provider API error | `X-Resolver-Error: provider_error`, `X-Resolver-Provider: real-debrid` |
| `503 Service Unavailable` | Media temporarily unavailable (acquiring, or all providers exhausted) | `X-Resolver-State: acquiring\|repairing`, `Retry-After: 120` |
| `504 Gateway Timeout` | Provider API timeout | `X-Resolver-Error: provider_timeout` |

**Error Response Body (JSON):**

```json
{
  "error": "expired_link",
  "info_hash": "abc123def456...",
  "file_index": 1,
  "state": "repairing",
  "message": "Link expired, repair in progress",
  "retry_after_seconds": 30,
  "resolved_at": "2026-08-23T14:30:00Z",
  "expires_at": null
}
```

---

## 3. Redirect vs Proxy Fallback Architecture

### 3.1 Decision Flow

```
Client requests /media/{hash}/{file_index}
        │
        ▼
┌──────────────────────────┐
│  Resolve identity        │
│  (hash + file_index →    │
│   provider placement)    │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Check lifecycle state   │
│  acquiring? → 503        │
│  failed?    → 410        │
│  repairing? → 423        │
│  expired?   → refresh    │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Get CDN URL             │
│  (from provider adapter) │
└──────────┬───────────────┘
           │
           ▼
┌──────────────────────────┐
│  Supports Range?         │
│  (provider CDN check)    │
└──────────┬───────────────┘
           │
     ┌─────┴─────┐
     │           │
    Yes          No
     │           │
     ▼           ▼
┌─────────┐ ┌─────────┐
│ 302     │ │ 200     │
│ Redirect│ │ Proxy   │
│ + Range │ │ + Range │
│ passthru│ │         │
└─────────┘ └─────────┘
```

### 3.2 Redirect Mode Conditions

Redirect (302) is the **preferred** mode. Conditions:
1. Provider CDN supports `Range` requests (verified or assumed)
2. Provider CDN returns `Accept-Ranges: bytes` in HEAD response
3. No auth headers required for CDN access (RD CDN URLs are pre-authenticated tokens)

**Fallback to proxy mode if:**
- CDN HEAD request fails (403, 404, timeout)
- CDN doesn't advertise `Accept-Ranges` (some hosts strip it)
- Client request includes `Range` but CDN doesn't support it

### 3.3 Range Passthrough in Redirect Mode

When redirecting, the resolver **does not** proxy the Range header. The client sends Range directly to the CDN:

```
Client → GET /media/{hash}/{1} Range: bytes=1024-2047
Resolver → 302 Location: https://cdn.rd.com/file.mkv?token=abc
Client → GET https://cdn.rd.com/file.mkv?token=abc Range: bytes=1024-2047
CDN → 206 Partial Content Content-Range: bytes 1024-2047/8589934592
```

**Risk:** If CDN ignores Range, client receives full file. Client must detect this (200 vs 206) and handle gracefully.

### 3.4 Proxy Mode Streaming

In proxy mode, the resolver:
1. Opens a stream to the provider CDN
2. Respects the client's `Range` header by seeking within the stream
3. Pipes bytes to the client with proper `Content-Range` and `Accept-Ranges` headers
4. Closes the stream when the client disconnects

**Memory constraint:** The resolver must NOT buffer the entire file in memory. Use streaming I/O with backpressure.

---

## 4. Provider URL Lifecycle Handling

### 4.1 URL Acquisition Flow

```
┌─────────────────────────────────────────────────────────────┐
│                  URL ACQUISITION FLOW                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. Resolver receives request for (hash, file_index)        │
│                                                             │
│  2. Look up placement in resolver state store:              │
│     ├── Not found → 404 (unknown identity)                  │
│     ├── Found, state=acquiring → 503                        │
│     ├── Found, state=failed → 410                           │
│     └── Found, state=available → check URL freshness        │
│                                                             │
│  3. Check URL freshness:                                    │
│     ├── No resolved_url → acquire new URL                   │
│     ├── resolved_url exists, not expired → use it           │
│     └── resolved_url exists, expired → refresh URL          │
│                                                             │
│  4. Acquire/refresh URL via provider adapter:               │
│     ├── Success → update state, use new URL                 │
│     ├── Rate limited → 429, retry with backoff              │
│     ├── Auth error → mark failed, 410                       │
│     └── Provider error → 502, retry with backoff            │
│                                                             │
│  5. Attempt redirect:                                       │
│     ├── HEAD CDN URL → check Accept-Ranges                  │
│     ├── 200 + Accept-Ranges → 302 redirect                  │
│     ├── 200 + no Accept-Ranges → fall back to proxy         │
│     └── 4xx/5xx → fall back to proxy                        │
│                                                             │
│  6. If proxy mode: stream bytes with range support          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 URL Freshness Model

| Field | Meaning | Action |
|-------|---------|--------|
| `resolved_at` | When URL was last acquired | TTL countdown starts here |
| `expires_at` | When URL will expire (if known) | Refresh before this |
| `ttl_seconds` | Provider-specific TTL (RD: ~86400) | Default if `expires_at` unknown |

**Freshness check:**

```
if (now - resolved_at) > (ttl_seconds - buffer_seconds):
    refresh URL synchronously (adds latency)
else:
    use cached URL
```

`buffer_seconds` default: 7200 (2 hours before assumed expiry).

### 4.3 RD Status Value Mapping

Real-Debrid torrent status values mapped to resolver states:

| RD Status | Resolver State | Meaning |
|-----------|---------------|---------|
| `magnet_conversion` | `acquiring` | Converting magnet to torrent |
| `waiting_files_selection` | `acquiring` | Waiting for file selection (adapter must call selectFiles) |
| `queued` | `acquiring` | Queued for download |
| `downloading` | `acquiring` | Actively downloading |
| `downloaded` | `available` | Complete, links ready |
| `error` | `failed` | Torrent error |
| `virus_deleted` | `failed` | RD deleted (virus flag) |
| `dead` | `failed` | No seeders |

**Source:** REALDEBRID-EXECUTION-STRUCTURE.md §2 + community conventions.

---

## 5. State Transitions

### 5.1 Resolver State Machine

```
                   ┌──────────────────┐
                   │    unknown       │
                   │ (not in resolver │
                   │  state store)    │
                   └────────┬─────────┘
                            │ placement observed
                            ▼
                   ┌──────────────────┐
           ┌───────│   acquiring      │
           │       │ (placement in    │
           │       │  progress)       │
           │       └────────┬─────────┘
           │                │ RD status: downloaded
           │                ▼
           │       ┌──────────────────┐
           │       │   available      │◄──────────────────┐
           │       │ (URL resolved,   │                   │
           │       │  ready to serve) │                   │
           │       └────────┬─────────┘                   │
           │                │                             │
           │         URL expired                    repair success
           │                │                             │
           │                ▼                             │
           │       ┌──────────────────┐                   │
           │       │   expired        │───────────────────┘
           │       │ (URL stale,      │
           │       │  needs refresh)  │
           │       └────────┬─────────┘
           │                │ refresh fails
           │                ▼
           │       ┌──────────────────┐
           │       │   repairing      │───────────────────┐
           │       │ (re-placing or   │                   │
           │       │  switching prov) │                   │
           │       └────────┬─────────┘                   │
           │                │                             │
           │         repair fails (max retries)      repair success
           │                │                             │
           │                ▼                             │
           │       ┌──────────────────┐                   │
           └──────►│   failed         │───────────────────┘
                   │ (permanent: no   │
                   │  seeders, auth   │
                   │  error, etc.)    │
                   └──────────────────┘
```

### 5.2 State Transition Events

| Event | Trigger | From → To | Action |
|-------|---------|-----------|--------|
| `placement_observed` | Adapter polls RD, finds completed torrent | `unknown` → `acquiring` | Create resolver state record |
| `status_downloaded` | RD status = `downloaded` | `acquiring` → `available` | Resolve unrestricted link, record URL |
| `url_expired` | `now > expires_at - buffer` | `available` → `expired` | Trigger background refresh |
| `refresh_success` | Provider adapter returns new URL | `expired` → `available` | Update `resolved_at`, `expires_at` |
| `refresh_failure` | Provider adapter fails (rate limit, auth) | `expired` → `repairing` | Schedule retry with backoff |
| `repair_success` | Re-placement or provider switch succeeds | `repairing` → `available` | Update provider, resource_id, URL |
| `repair_exhausted` | Max retries exceeded | `repairing` → `failed` | Log failure, emit event for monitoring |
| `torrent_dead` | RD status = `dead` | `available` → `repairing` | Trigger re-placement |
| `auth_error` | Provider returns 401/403 | `available` → `failed` | Permanent failure, no retry |

### 5.3 Event Schema (for Future Repair)

```yaml
# Emitted on every state transition, consumed by repair orchestrator
lifecycle_event:
  event_id: "uuid"
  event_type: "state_transition"
  timestamp: ISO8601
  
  # Identity (stable)
  info_hash: "40-char-hex"
  file_index: 1 | null
  
  # State transition
  from_state: "acquiring" | "available" | "expired" | "repairing" | "failed"
  to_state: "acquiring" | "available" | "expired" | "repairing" | "failed"
  
  # Trigger
  trigger: "placement_observed" | "status_downloaded" | "url_expired" | 
           "refresh_success" | "refresh_failure" | "repair_success" | 
           "repair_exhausted" | "torrent_dead" | "auth_error"
  
  # Provider context (at time of event)
  provider: "real-debrid" | "torbox" | null
  resource_id: "opaque-string" | null
  
  # URL context (for refresh/expiry events)
  url_resolved_at: ISO8601 | null
  url_expires_at: ISO8601 | null
  url_refresh_attempt: integer
  
  # Failure context
  failure_reason: "no_seeders" | "auth_error" | "rate_limited" | "provider_error" | null
  retry_count: integer
  max_retries: integer
```

---

## 6. Failure Modes

### 6.1 Provider CDN Doesn't Support Range

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| CDN ignores Range header | Client receives full file on seek | Resolver falls back to proxy mode |
| CDN returns 200 instead of 206 | Client can't seek | Detect in HEAD check, switch to proxy |
| CDN supports Range but strips `Accept-Ranges` | Resolver thinks no range support | Log warning, still try redirect first |

### 6.2 URL Expires Mid-Stream

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| CDN URL expires during long playback | Client gets 403/404 mid-stream | Track `resolved_at`, refresh proactively at 80% TTL |
| Client reconnects after expiration | New request triggers URL refresh | Transparent to client |
| Client uses `.strm` with old URL | `.strm` points to resolver, not CDN | Resolver URL is stable — handles refresh internally |

### 6.3 Provider Rate Limiting

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| RD returns 429 on URL refresh | Can't serve media | Return 429 to client with `Retry-After` |
| Multiple concurrent requests for same content | All fail on rate limit | Deduplicate: serve cached URL, queue refresh |
| Background refresh hits rate limit | URLs expire without refresh | Stagger refreshes, prioritize active content |

### 6.4 Content Identity Not Found

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| `(hash, file_index)` never placed | Resolver has no record | 404 with `X-Resolver-Error: unknown_identity` |
| Placement record exists but no provider link | Partial acquisition | 503 with `X-Resolver-State: acquiring` |
| Torrent dead before download complete | No unrestricted link | 410 with `X-Resolver-Failure-Reason: torrent_dead` |

### 6.5 Provider API Unavailable

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| RD API returns 500 | Can't refresh URL | Serve stale URL if not yet expired, else 502 |
| RD API times out | Can't refresh URL | Serve stale URL if available, else 504 |
| RD API auth error (401) | Token expired | Mark placement as failed, return 410 |

### 6.6 Client Disconnects During Proxy

| Scenario | Impact | Mitigation |
|----------|--------|------------|
| Client closes connection mid-stream | Resolver holding CDN connection | Detect `close` event, abort CDN request |
| Client stops reading (buffer full) | Backpressure on CDN stream | Implement proper backpressure (pause/resume) |
| CDN connection drops mid-proxy | Client sees incomplete response | Return error to client, retry next request |

---

## 7. HTTP Range Support Requirements

### 7.1 Range Header Format

The resolver MUST support standard HTTP range requests:

```
Range: bytes=0-           # From byte 0 to end
Range: bytes=0-1023       # First 1024 bytes
Range: bytes=1024-        # From byte 1024 to end
Range: bytes=-1024        # Last 1024 bytes
Range: bytes=0-0,1-1023   # Multiple ranges (rare in practice)
```

### 7.2 Range Validation

| Condition | Response |
|-----------|----------|
| Valid range, within file size | `206 Partial Content` with `Content-Range` |
| Range exceeds file size | `416 Range Not Satisfiable` with `Content-Range: bytes */{total}` |
| Malformed Range header | Ignore (treat as full request) or `400 Bad Request` |

### 7.3 Range in Redirect Mode

The resolver **does not** validate or modify the Range header in redirect mode. The client sends Range directly to the CDN. The CDN handles range validation.

**Risk:** If CDN doesn't support Range, it returns 200 (full file) instead of 206. The client must detect this and handle appropriately.

### 7.4 Range in Proxy Mode

The resolver **must** validate and handle Range requests:

```
Client → GET /media/{hash}/{1} Range: bytes=1024-2047
Resolver → Open CDN stream, seek to byte 1024
Resolver → Pipe 1024 bytes to client
Resolver → 206 Partial Content Content-Range: bytes 1024-2047/8589934592
```

**Implementation note:** The resolver must be able to seek within the CDN stream. This requires either:
- CDN supports Range (pass-through)
- Resolver downloads from start and discards bytes until range start (inefficient, fallback only)

---

## 8. .strm Generation Contract

### 8.1 .strm File Content

A `.strm` file contains a **single line** — the resolver URL:

```
http://hashsucker:8080/media/abc123def456.../1
```

**Not** the CDN URL. The CDN URL is ephemeral; the resolver URL is stable.

### 8.2 .strm File Naming

Follow Plex/Jellyfin library conventions (see MATERIALIZATION-ARCHITECTURE.md §2.2):

```
/Movies/
  Movie Name (2024) [imdbid-tt1234567]/
    Movie Name (2024) [imdbid-tt1234567].strm
```

```
/TV Shows/
  Show Name (2020) [tvdbid-123456]/
    Season 01/
      Show Name - S01E01 - Episode Title.strm
```

### 8.3 .strm Generation API

```
POST /strm/generate
Content-Type: application/json

{
  "info_hash": "abc123def456...",
  "file_index": 1,
  "library_path": "/mnt/plex/movies",
  "relative_path": "Movie Name (2024)/Movie Name (2024).strm"
}
```

Response:

```json
{
  "status": "created",
  "strm_path": "/mnt/plex/movies/Movie Name (2024)/Movie Name (2024).strm",
  "resolver_url": "http://hashsucker:8080/media/abc123def456.../1"
}
```

### 8.4 .strm Stability Guarantee

The `.strm` file content **never changes** after creation. The resolver URL is stable for the lifetime of the placement. If the underlying CDN URL changes, the resolver handles it transparently.

---

## 9. Implementation Scope (Minimal)

### 9.1 Components

| Component | Scope | Effort |
|-----------|-------|--------|
| **HTTP server** | Node.js HTTP server with routing | Low |
| **Resolver endpoint** | `GET /media/{hash}/{file_index}` | Medium |
| **Provider adapter interface** | Abstract `resolve(info_hash, file_index) → {url, expires_at}` | Medium |
| **RD provider adapter** | Implement provider interface for Real-Debrid | Medium |
| **Lifecycle state store** | In-memory or SQLite state for placements | Low |
| **URL freshness tracker** | TTL-based refresh logic | Low |
| **Range support** | Parse, validate, proxy Range requests | Medium |
| **Redirect/proxy switch** | HEAD check + fallback logic | Low |
| **.strm generator** | Write `.strm` files to library path | Low |
| **Lifecycle event emitter** | Event log for future repair orchestrator | Low |

### 9.2 Data Store (Minimal)

```sql
-- Resolver state store (can be in-memory or SQLite)
CREATE TABLE IF NOT EXISTS resolver_placements (
  info_hash TEXT NOT NULL,
  file_index INTEGER,          -- NULL = torrent-level
  file_index_key INTEGER NOT NULL DEFAULT -1,  -- -1 for NULL (HashSucker convention)
  
  -- Provider placement (ephemeral)
  provider TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  
  -- Lifecycle state
  state TEXT NOT NULL DEFAULT 'acquiring',  -- acquiring|available|expired|repairing|failed
  
  -- URL (resolved on demand)
  resolved_url TEXT,
  resolved_at TEXT,            -- ISO8601
  expires_at TEXT,             -- ISO8601 (nullable)
  
  -- Failure tracking
  failure_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  
  -- Metadata (from corpus)
  title TEXT,
  year INTEGER,
  resolution TEXT,
  source_type TEXT,
  codec TEXT,
  audio TEXT,
  bytes INTEGER,
  
  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  PRIMARY KEY (info_hash, file_index_key)
);

-- Lifecycle event log (append-only)
CREATE TABLE IF NOT EXISTS resolver_events (
  event_id TEXT PRIMARY KEY,  -- UUID
  event_type TEXT NOT NULL,   -- state_transition|refresh_attempt|repair_attempt
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  
  from_state TEXT,
  to_state TEXT,
  trigger TEXT,
  
  provider TEXT,
  resource_id TEXT,
  
  url_resolved_at TEXT,
  url_expires_at TEXT,
  url_refresh_attempt INTEGER,
  
  failure_reason TEXT,
  retry_count INTEGER,
  max_retries INTEGER
);
```

### 9.3 What NOT to Build (Now)

| Feature | Why Not |
|---------|---------|
| **WebDAV server** | Phase 2 concern; redirect/proxy resolver is sufficient for .strm and HTTP playback |
| **FUSE filesystem** | Phase 3 concern; only if real need |
| **Local file cache** | Defeats debrid purpose; storage is expensive |
| **Transcoding** | Client handles this |
| **Multi-provider** | Phase 5 concern; single provider is fine for Phase 1 |
| **Background refresh** | Can be added in Phase 4; synchronous refresh is sufficient for Phase 1 |
| **Authentication/authorization** | Single-user assumption; auth is future concern |
| **Rate limiting** | Single-user assumption; future concern |

---

## 10. Tests Required

### 10.1 Unit Tests

| Test | Input | Expected Output |
|------|-------|-----------------|
| Parse valid info_hash | `GET /media/abc123def456.../1` | Identity resolved |
| Parse null file_index | `GET /media/abc123def456.../~` | file_index = null |
| Reject invalid info_hash | `GET /media/INVALID/1` | 400 Bad Request |
| Reject missing file_index | `GET /media/abc123def456.../` | 404 Not Found |
| URL freshness check — fresh | `resolved_at = now - 1h`, `ttl = 24h` | Use cached URL |
| URL freshness check — stale | `resolved_at = now - 23h`, `ttl = 24h`, `buffer = 2h` | Trigger refresh |
| URL freshness check — expired | `resolved_at = now - 25h`, `ttl = 24h` | Trigger refresh |
| Range header parsing — valid | `Range: bytes=0-1023` | 206 Partial Content |
| Range header parsing — beyond EOF | `Range: bytes=99999999999-` | 416 Range Not Satisfiable |
| Range header parsing — malformed | `Range: abc` | Ignore or 400 |
| State transition — valid | `acquiring` → `available` | Event logged |
| State transition — invalid | `failed` → `available` | Reject, no event |
| .strm content | `info_hash=abc, file_index=1` | `http://host/media/abc/1` |

### 10.2 Integration Tests

| Test | Setup | Expected Behavior |
|------|-------|-------------------|
| **Redirect mode** | CDN supports Range | 302 with Location header |
| **Proxy mode fallback** | CDN doesn't support Range | 200 with proxied bytes |
| **Range passthrough** | Redirect mode, client sends Range | Client gets 206 from CDN |
| **Range proxy** | Proxy mode, client sends Range | Resolver seeks and returns 206 |
| **URL refresh on expiry** | URL expired, provider returns new URL | New URL used, state → available |
| **URL refresh failure** | Provider returns 429 | 429 with Retry-After, state → expired |
| **Content not found** | `(hash, file_index)` not in DB | 404 with `X-Resolver-Error` |
| **Acquiring state** | Placement in progress | 503 with `Retry-After` |
| **Failed state** | Placement permanently failed | 410 with failure reason |
| **Repair state** | URL refresh in progress | 423 with `Retry-After` |
| **Concurrent requests** | 10 requests for same content | Deduplicated, single refresh |
| **Client disconnect** | Close connection mid-proxy | CDN stream aborted, no leak |

### 10.3 Provider Adapter Tests

| Test | Input | Expected Output |
|------|-------|-----------------|
| RD: resolve unrestricted link | `resource_id=ABC123`, `file_index=1` | `{url, expires_at}` |
| RD: refresh expired link | `resource_id=ABC123`, `file_index=1` | New `{url, expires_at}` |
| RD: status mapping — downloaded | `status=downloaded` | `state=available` |
| RD: status mapping — downloading | `status=downloading` | `state=acquiring` |
| RD: status mapping — dead | `status=dead` | `state=failed`, `reason=no_seeders` |
| RD: rate limit handling | RD returns 429 | Return `{error: rate_limited, retry_after}` |
| RD: auth error handling | RD returns 401 | Return `{error: auth_failed}` |

### 10.4 End-to-End Tests

| Test | Steps | Expected Outcome |
|------|-------|------------------|
| **Full playback flow** | 1. Place torrent → 2. Poll for completion → 3. Request `/media/{hash}/{1}` → 4. Stream bytes | Successful playback |
| **Seek during playback** | 1. Start playback → 2. Send Range request for middle of file | 206 with correct byte range |
| **URL expiry during playback** | 1. Start playback → 2. URL expires → 3. Client reconnects | Transparent refresh, playback resumes |
| **.strm playback** | 1. Generate .strm → 2. Plex/Kodi opens .strm → 3. Streams from resolver | Successful playback |
| **Provider failure** | 1. RD API down → 2. Request media | 502 with retry-after |

---

## 11. Future Extension Points

| Extension | Trigger | What Changes |
|-----------|---------|--------------|
| **Background refresh** | Proactive URL refresh before expiry | Add scheduler, refresh URLs at 80% TTL |
| **Multi-provider** | TorBox, Premiumize support | Abstract provider interface, add failover logic |
| **WebDAV server** | Need filesystem-like access | Add WebDAV adapter that delegates to resolver |
| **FUSE filesystem** | Need local mount | Add FUSE adapter that delegates to resolver |
| **Repair orchestrator** | Permanent failure detected | Consume `lifecycle_event` log, trigger re-placement |
| **Duplicate detection** | Same content in multiple torrents | Add content_hash identity layer |
| **CDN preflight cache** | Repeated HEAD checks for same CDN | Cache CDN Range support status |
| **Metrics/observability** | Need visibility into resolver health | Add Prometheus metrics, health endpoint |
| **Authentication** | Multi-user deployment | Add auth middleware to resolver endpoint |

---

## 12. Summary

The minimal HTTP materialization resolver is:

1. **A single endpoint:** `GET /media/{info_hash}/{file_index}`
2. **A redirect-or-proxy decision:** 302 if CDN supports Range, else 200 with proxied bytes
3. **A URL lifecycle manager:** Tracks freshness, refreshes before expiry
4. **A state machine:** `acquiring → available → expired → repairing → failed`
5. **An event emitter:** Logs all transitions for future repair orchestration
6. **A .strm source:** Writes stable resolver URLs to library folders

It does NOT include:
- WebDAV (Phase 2)
- FUSE (Phase 3)
- Multi-provider (Phase 5)
- Background refresh (Phase 4)
- Local file cache (never)

The resolver is **stateless with respect to provider URLs** — it resolves them on demand. The only state it maintains is placement identity and lifecycle state, which is stable and portable across providers.

---

## 13. References

- **Architecture:** `MATERIALIZATION-ARCHITECTURE.md` §7 (resolver endpoint), §8 (implementation scope)
- **Provider API:** `REALDEBRID-EXECUTION-STRUCTURE.md` (RD API structures)
- **Identity semantics:** `HANDOFF.md` §1 (`(info_hash, file_index_key)` with `-1` for NULL)
- **HTTP Range:** RFC 7233 — Range Requests
- **HTTP Redirect:** RFC 7231 §6.4.3 — 302 Found

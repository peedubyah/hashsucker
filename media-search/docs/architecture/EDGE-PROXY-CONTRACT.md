# Edge Proxy Contract

**Date:** 2026-08-23  
**Status:** Contract — normative constraints on edge proxy behavior  
**Grounded in:** `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md`, `ARCHITECTURE-BOUNDARIES.md`, `CONTRACTS.md`  
**Constraints:** No resolver changes; no transport changes; no control-plane changes; no schema changes

---

## 1. Purpose

This document defines the **normative boundary** of the edge proxy. It is the single routing layer between the internet and the internal services (media gateway, control plane, UI).

The edge proxy is a **transport/router layer only**. It owns no business logic, no identity resolution, no byte delivery, and no state.

---

## 2. Proxy Ownership

### 2.1 Identity

| ID | Constraint |
|----|------------|
| **EP-OWN-1** | The edge proxy **MUST** be the single inbound network boundary for all HTTP traffic to HashSucker services. |
| **EP-OWN-2** | The edge proxy **MUST** implement exactly three route classes: `/media/*`, `/api/*`, and `/*`. |
| **EP-OWN-3** | The edge proxy **MUST** resolve backend addresses via Docker service names (internal DNS). |

### 2.2 Routing Table

| ID | Constraint |
|----|------------|
| **EP-ROUTE-1** | `GET /media/*` **MUST** be routed to the media gateway backend. |
| **EP-ROUTE-2** | `/api/*` **MUST** be routed to the media-search control-plane backend. |
| **EP-ROUTE-3** | `/*` (all other paths) **MUST** be routed to the media-search UI/static backend. |
| **EP-ROUTE-4** | Routing **MUST** be prefix-based and order-sensitive: `/media/*` first, then `/api/*`, then `/*`. |

### 2.3 Process Identity

| ID | Constraint |
|----|------------|
| **EP-OWN-4** | The edge proxy **MUST** run as a separate container from all backend services. |
| **EP-OWN-5** | The edge proxy **MUST** bind to the externally-reachable port (default `8080`). |
| **EP-OWN-6** | The edge proxy **MUST NOT** bind to loopback only — it is the public entry point. |

---

## 3. Header Handling

### 3.1 Headers Forwarded Unchanged

| ID | Constraint |
|----|------------|
| **EP-HDR-1** | The `Range` header **MUST** be forwarded unchanged to the media gateway. |
| **EP-HDR-2** | The `If-Range` header **MUST** be forwarded unchanged to the media gateway. |
| **EP-HDR-3** | The `If-Modified-Since` header **MUST** be forwarded unchanged to the media gateway. |
| **EP-HDR-4** | The `Accept` header **MUST** be forwarded unchanged. |
| **EP-HDR-5** | The `X-Forwarded-For` header **MUST** be set or appended to by the proxy. |
| **EP-HDR-6** | The `X-Real-IP` header **MUST** be set by the proxy. |

### 3.2 Headers Stripped

| ID | Constraint |
|----|------------|
| **EP-HDR-7** | Internal headers (`X-Resolver-*`) **MUST** be stripped from outbound responses. |
| **EP-HDR-8** | The `X-Internal-*` prefix **MUST** be stripped from outbound responses. |

### 3.3 Headers NOT Added

| ID | Constraint |
|----|------------|
| **EP-HDR-9** | The proxy **MUST NOT** set `Content-Length`. |
| **EP-HDR-10** | The proxy **MUST NOT** set `Content-Type`. |
| **EP-HDR-11** | The proxy **MUST NOT** set `Content-Range`. |
| **EP-HDR-12** | The proxy **MUST NOT** set `Accept-Ranges`. |
| **EP-HDR-13** | The proxy **MUST NOT** set `Cache-Control` on media responses. |

---

## 4. Media Streaming Requirements

### 4.1 Byte Preservation

| ID | Constraint |
|----|------------|
| **EP-STREAM-1** | The proxy **MUST NOT** buffer response bodies for `/media/*` paths. |
| **EP-STREAM-2** | The proxy **MUST** stream bytes from the media gateway to the client without modification. |
| **EP-STREAM-3** | The proxy **MUST** preserve HTTP status codes from the media gateway (200, 206, 400, 404, 410, 416, 423, 502, 503). |
| **EP-STREAM-4** | The proxy **MUST** forward `Content-Length` from the media gateway unchanged. |
| **EP-STREAM-5** | The proxy **MUST** forward `Content-Range` from the media gateway unchanged. |

### 4.2 Connection Lifecycle

| ID | Constraint |
|----|------------|
| **EP-STREAM-6** | The proxy **MUST** close the upstream connection when the client disconnects. |
| **EP-STREAM-7** | The proxy **MUST** close the client connection when the upstream closes. |
| **EP-STREAM-8** | The proxy **MUST NOT** impose a fixed timeout on `/media/*` responses (streams may be long-lived). |

---

## 5. Forbidden Responsibilities

### 5.1 Transport

| ID | Constraint |
|----|------------|
| **EP-FORBID-1** | The proxy **MUST NOT** parse `Range` headers. |
| **EP-FORBID-2** | The proxy **MUST NOT** calculate `Content-Length`. |
| **EP-FORBID-3** | The proxy **MUST NOT** determine `Content-Type`. |
| **EP-FORBID-4** | The proxy **MUST NOT** modify response bodies. |

### 5.2 Identity and Logic

| ID | Constraint |
|----|------------|
| **EP-FORBID-5** | The proxy **MUST NOT** resolve identities (info_hash, file_index). |
| **EP-FORBID-6** | The proxy **MUST NOT** access SQLite or any database. |
| **EP-FORBID-7** | The proxy **MUST NOT** read filesystem mounts. |
| **EP-FORBID-8** | The proxy **MUST NOT** call provider APIs. |
| **EP-FORBID-9** | The proxy **MUST NOT** implement lifecycle logic. |
| **EP-FORBID-10** | The proxy **MUST NOT** implement repair logic. |
| **EP-FORBID-11** | The proxy **MUST NOT** implement resolver behavior. |
| **EP-FORBID-12** | The proxy **MUST NOT** implement transport behavior. |

### 5.3 Security (Future — Not Now)

| ID | Constraint |
|----|------------|
| **EP-FORBID-13** | The proxy **MUST NOT** implement TLS termination in this phase (deferred). |
| **EP-FORBID-14** | The proxy **MUST NOT** implement authentication in this phase (deferred). |
| **EP-FORBID-15** | The proxy **MUST NOT** implement rate limiting in this phase (deferred). |
| **EP-FORBID-16** | The proxy **MUST NOT** implement caching in this phase (deferred). |

---

## 6. Failure Behavior

### 6.1 Backend Unavailable

| ID | Constraint |
|----|------------|
| **EP-FAIL-1** | If the media gateway is unreachable, the proxy **MUST** return `502 Bad Gateway`. |
| **EP-FAIL-2** | If the control plane is unreachable, the proxy **MUST** return `502 Bad Gateway`. |
| **EP-FAIL-3** | If a backend times out, the proxy **MUST** return `504 Gateway Timeout`. |

### 6.2 Proxy Failure

| ID | Constraint |
|----|------------|
| **EP-FAIL-4** | If the proxy fails, all backends **MUST** remain independently accessible via their internal addresses. |
| **EP-FAIL-5** | The proxy **MUST** be independently restartable from all backends. |

### 6.3 Client Disconnect

| ID | Constraint |
|----|------------|
| **EP-FAIL-6** | If the client disconnects mid-stream, the proxy **MUST** stop reading from the upstream within 5 seconds. |

---

## 7. Boundary Summary

### 7.1 Proxy IS

- Single inbound HTTP routing boundary
- Prefix-based router (`/media/*`, `/api/*`, `/*`)
- Header forwarder (Range, If-Range, If-Modified-Since preserved)
- Byte streamer (no buffering on `/media/*`)
- Stateless process

### 7.2 Proxy IS NOT

- TLS terminator (deferred)
- Authenticator (deferred)
- Rate limiter (deferred)
- Cache (deferred)
- Range parser
- Content-Type determiner
- Identity resolver
- Database client
- Filesystem reader
- Provider API caller
- Lifecycle implementer
- Repair orchestrator
- Resolver
- Transport layer

### 7.3 Proxy Reads

| Authorized | Forbidden |
|------------|-----------|
| Caddyfile config | SQLite databases |
| Environment variables | Filesystem mounts |
| Docker DNS | Provider API state |
| | Internal service state |

### 7.4 Proxy Writes

| Allowed | Forbidden |
|---------|-----------|
| Access logs (stdout) | Any database |
| Error logs (stdout) | Any filesystem beyond config |
| | Any backend state |

---

## 8. Compliance Verification

An edge proxy implementation **complies** with this contract if:

1. It routes `/media/*` to the media gateway.
2. It routes `/api/*` to the control plane.
3. It routes `/*` to the UI/static backend.
4. It forwards `Range`, `If-Range`, `If-Modified-Since` unchanged.
5. It does not buffer `/media/*` response bodies.
6. It preserves status codes from backends.
7. It does not access SQLite, filesystem mounts, or provider APIs.
8. It does not implement TLS, auth, rate limiting, or caching.
9. It runs as a separate container.
10. It is stateless across requests.

An implementation that violates any **MUST** constraint is non-compliant.

---

## 9. Relationship to Prior Documents

| Prior Document | Relationship |
|----------------|--------------|
| `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md` | Defines the media gateway behind this proxy. This contract routes to it. |
| `ARCHITECTURE-BOUNDARIES.md` | Upstream boundary map. This contract adds the network edge layer. |
| `CONTRACTS.md` | Upstream contract patterns. This contract follows the same MUST/MUST NOT/MAY pattern. |

---

**End of contract.**

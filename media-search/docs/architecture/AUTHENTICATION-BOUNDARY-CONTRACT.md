# Authentication Boundary Contract

**Date:** 2026-08-23  
**Status:** Contract — normative constraints on authentication behavior  
**Supersedes:** `AUTHENTICATION-BOUNDARY-ANALYSIS.md` (analysis → contract)  
**Grounded in:** `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md`, `EDGE-PROXY-CONTRACT.md`, `ARCHITECTURE-BOUNDARIES.md`, `CONTRACTS.md`  
**Cross-checked against:** `compose.yaml`, `edge/Caddyfile`, `media-search/src/server/app.js`  
**Constraints:** No code; no schema; no implementation; no architecture changes; no new services

---

## 1. Purpose

This document defines the **normative authentication boundary** for HashSucker. It is the single authoritative statement of:

1. Which component owns authentication.
2. What credentials flow across the boundary.
3. How media streaming constrains authentication design.
4. What the edge proxy and trusted zone may and may not do.
5. Which authentication models are frozen for future phases.
6. What is explicitly out of scope.

Each requirement is stated as a MUST / MUST NOT / MAY constraint. Violations break the contract.

---

## 2. Authentication Ownership

### 2.1 Single Enforcement Point

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-1** | The edge proxy **MUST** be the only component that accepts user credentials from inbound HTTP requests. |

### 2.2 Forbidden Implementations

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-2** | The media gateway **MUST NOT** implement authentication. The gateway trusts the edge's routing decision (GW-FORBID-2). |
| **AUTH-EDGE-3** | The control plane **MUST NOT** implement authentication on API endpoints. The edge proxy is the single enforcement point. |

### 2.3 Credential Containment

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-4** | Provider credentials (TorBox API keys, RealDebrid API keys) **MUST NEVER** be exposed to clients. They are used only within the trusted zone. |

### 2.4 Current Deployment State

The current system has no authentication:

- `edge/Caddyfile` — no `basicauth`, no `auth`, no forward-auth directives.
- `compose.yaml` — no auth service, no auth middleware, no auth volumes.
- `media-search/src/server/app.js` — no auth middleware, no session handling, no token validation.
- `EDGE-PROXY-CONTRACT.md` §5.3 — authentication is deferred.

This is the correct state for LAN-only deployments. Authentication **MUST** be addable without violating the constraints in this contract.

---

## 3. Credential Flow

### 3.1 Trust Zone Diagram

```
┌───────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                         │
│                                                               │
│   Plex / Jellyfin / Infuse / Kodi / Direct HTTP clients       │
│                                                               │
└───────────────────────────┬───────────────────────────────────┘
                            │ HTTP requests (with or without credentials)
                            │ Headers: Authorization, Cookie, Range, etc.
                            │
                    ┌───────▼────────┐
                    │   EDGE PROXY   │
                    │   (Caddy)      │
                    │                │
                    │  Authenticates │
                    │  Forwards      │
                    │  Strips        │
                    └───────┬────────┘
                            │ Authenticated requests
                            │ Headers: X-Authenticated-User
                            │ No Authorization header forwarded
                            │
┌───────────────────────────┼───────────────────────────────────┐
│                        TRUSTED ZONE                          │
│                           │                                   │
│              ┌────────────▼────────────┐                     │
│              │     media-search        │                     │
│              │     (control plane +    │                     │
│              │      media gateway)     │                     │
│              │                         │                     │
│              │  Trusts edge decision   │                     │
│              │  No auth check          │                     │
│              └─────────────────────────┘                     │
│                                                               │
│   Internal Docker network                                     │
│   No direct external access                                   │
└───────────────────────────────────────────────────────────────┘
```

### 3.2 Header Flow (Normative)

```
Client                    Edge Proxy                    Trusted Zone
  │                          │                              │
  │ GET /media/abc/0        │                              │
  │ Authorization: Bearer X │                              │
  │ Range: bytes=0-1023     │                              │
  │                          │                              │
  │─────────────────────────▶│                              │
  │                          │ Validate credentials         │
  │                          │ Strip Authorization          │
  │                          │ Set X-Authenticated-User    │
  │                          │ Forward Range unchanged      │
  │                          │─────────────────────────────▶│
  │                          │                              │ Trust X-Authenticated-User
  │                          │                              │ Serve bytes
  │                          │                              │
  │                          │◀─────────────────────────────│
  │                          │ Strip X-Resolver-*           │
  │                          │ Strip X-Internal-*           │
  │◀─────────────────────────│                              │
  │ 206 Partial Content      │                              │
  │ (no Authorization)       │                              │
  │ (no X-Authenticated-User)│                              │
```

### 3.3 Inbound Header Rules

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-5** | After successful authentication, the edge proxy **MUST** strip the `Authorization` header before forwarding requests to the trusted zone. |
| **AUTH-EDGE-6** | After successful authentication, the edge proxy **MUST** set an `X-Authenticated-User` header (or equivalent identity header) before forwarding to the trusted zone. |
| **AUTH-EDGE-7** | The trusted zone **MUST** trust the `X-Authenticated-User` header as proof of authentication. It **MUST NOT** re-validate credentials. |

### 3.4 Headers Forwarded Unchanged

| Header | Rule |
|--------|------|
| `Range` | Forwarded unchanged (EP-HDR-1, AUTH-EDGE-8) |
| `If-Range` | Forwarded unchanged (EP-HDR-2) |
| `If-Modified-Since` | Forwarded unchanged (EP-HDR-3) |
| `Accept` | Forwarded unchanged (EP-HDR-4) |
| `X-Forwarded-For` | Set or appended by edge (EP-HDR-5) |
| `X-Real-IP` | Set by edge (EP-HDR-6) |

### 3.5 Headers Stripped

| Header | Rule |
|--------|------|
| `Authorization` | Evaluated at edge, NOT forwarded to trusted zone (AUTH-EDGE-5) |
| `Cookie` (if session-based) | Evaluated at edge, NOT forwarded after validation |
| `X-Resolver-*` | Stripped from outbound responses (EP-HDR-7) |
| `X-Internal-*` | Stripped from outbound responses (EP-HDR-8) |
| `X-Authenticated-User` | Stripped from responses before reaching client |

### 3.6 Headers NOT Added by Trusted Zone

| Header | Rule |
|--------|------|
| `Set-Cookie` | Not set by media gateway (GW-EDGE-9) |
| Session tokens | Not set by media gateway |
| Authentication headers | Not set by media gateway |

### 3.7 Services That Trust the Edge Decision

| Service | Trusts Edge? | Rationale |
|---------|--------------|-----------|
| media-search (control plane) | YES | No auth middleware. Edge blocks unauthenticated requests. |
| media-search (media gateway) | YES | GW-FORBID-2: trusts edge routing decision. |
| torbox-importer | YES | Internal service. Not directly exposed to external traffic. |

---

## 4. Media Compatibility Requirements

### 4.1 Range Requests

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-8** | Authentication **MUST NOT** break Range requests. The `Range` header **MUST** be forwarded unchanged regardless of auth state. |

**Rationale**: Media clients (Plex, Jellyfin, Infuse, Kodi) use HTTP Range requests for seeking and buffering. Each Range request is a separate HTTP request. Re-authentication per request would fragment playback.

### 4.2 Long-Lived Connections

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-9** | Authentication tokens/credentials **MUST NOT** expire during active media playback. Long-lived connections (video streams) cannot tolerate mid-session re-authentication. |

**Rationale**: Video streams can last hours. If token expiry is shorter than the maximum playback duration, playback will be interrupted.

### 4.3 No Mid-Stream Challenges

| Constraint | Rule |
|------------|------|
| Mid-stream authentication challenges | **Forbidden** — clients (especially Plex) cannot handle authentication prompts during playback. |

### 4.4 Plex Compatibility

Plex clients do not behave like browsers:

| Behavior | Browser | Plex |
|----------|---------|------|
| Redirect to login page | Yes | No — fails playback |
| Send Authorization header | Configurable | Only `X-Plex-Token` |
| Handle 401 | Show login | Fail silently |
| Cookie handling | Native | Limited |
| OAuth flow | Full support | None |

**Constraint**: Authentication models that require browser-like behavior (redirects, OAuth flows, 401 handling) **MUST NOT** be applied to the `/media/*` path used by Plex clients.

### 4.5 Proxy Mode Preservation

HashSucker uses proxy mode (GW-TRANS-1): the media gateway reads bytes from the filesystem and streams them to the client. There are no redirects to CDN URLs (GW-TRANS-2).

**Constraint**: Authentication state **MUST** be maintained for the connection lifetime. The edge proxy **MUST NOT** introduce mid-stream redirects that would require re-authentication on a different domain.

---

## 5. Authentication Models (Frozen)

### 5.1 Current Phase: LAN-Only

**Recommendation**: No authentication.

| Dimension | Assessment |
|-----------|------------|
| **Complexity** | Zero. No credentials, no middleware, no configuration. |
| **Operational burden** | None. No password rotation, no token expiry, no lockout policies. |
| **Plex compatibility** | Perfect. Plex clients send no auth credentials; requests pass through transparently. |
| **Failure modes** | None. No auth service to fail. |
| **Suitability** | **Suitable for current single-host LAN deployment.** All clients are trusted. |

### 5.2 Recommended Against

| Model | Rationale |
|-------|-----------|
| **Basic Auth** | Plex clients do not send Basic Auth credentials. Playback fails unless credentials manually configured in every client (not possible in most Plex clients). |
| **Forward-auth** | Over-engineering for single-host LAN. Requires separate auth service with its own database, configuration, and operational burden. |
| **OAuth/OIDC** | Designed for interactive browser sessions, not long-lived media streaming. Token expiry during playback is unacceptable. |

### 5.3 Future Models (Optional)

| Model | Phase | Scope |
|-------|-------|-------|
| **Plex token validation** | Internet-facing, Plex clients | Possible consumer-specific authorization at edge proxy. Requires custom Plex token validator. No standard Caddy module exists. |
| **Forward-auth** | Optional future edge enhancement | Edge enhancement only, not required. |
| **OAuth/OIDC** | Future browser/admin use only | **NOT** on the media path (`/media/*`). Admin routes only. |

### 5.4 Disable-ability

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-12** | If authentication is added, it **MUST** be possible to disable it for LAN-only deployments without code changes (environment variable). |

---

## 6. Normative Constraints (Complete)

### 6.1 Ownership Constraints

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-1** | The edge proxy **MUST** be the only component that accepts user credentials from inbound HTTP requests. |
| **AUTH-EDGE-2** | The media gateway **MUST NOT** implement authentication. The gateway trusts the edge's routing decision (GW-FORBID-2). |
| **AUTH-EDGE-3** | The control plane **MUST NOT** implement authentication on API endpoints. The edge proxy is the single enforcement point. |

### 6.2 Credential Handling Constraints

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-4** | Provider credentials (TorBox API keys, RealDebrid API keys) **MUST NEVER** be exposed to clients. They are used only within the trusted zone. |
| **AUTH-EDGE-5** | After successful authentication, the edge proxy **MUST** strip the `Authorization` header before forwarding requests to the trusted zone. |
| **AUTH-EDGE-6** | After successful authentication, the edge proxy **MUST** set an `X-Authenticated-User` header (or equivalent identity header) before forwarding to the trusted zone. |
| **AUTH-EDGE-7** | The trusted zone **MUST** trust the `X-Authenticated-User` header as proof of authentication. It **MUST NOT** re-validate credentials. |

### 6.3 Media Streaming Constraints

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-8** | Authentication **MUST NOT** break Range requests. The `Range` header **MUST** be forwarded unchanged regardless of auth state. |
| **AUTH-EDGE-9** | Authentication tokens/credentials **MUST NOT** expire during active media playback. Long-lived connections (video streams) cannot tolerate mid-session re-authentication. |

### 6.4 Audit and Failure Constraints

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-10** | Failed authentication **MUST** result in `401 Unauthorized` with `WWW-Authenticate` header (for browser clients) or silent drop (for Plex clients). |
| **AUTH-EDGE-11** | The edge proxy **MUST** log authentication failures for audit. The trusted zone **MUST NOT** log raw credentials. |

### 6.5 Extensibility Constraints

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-12** | If authentication is added, it **MUST** be possible to disable it for LAN-only deployments without code changes (environment variable). |

---

## 7. Boundary Summary

### 7.1 Auth Layer IS

- The edge proxy is the single authentication boundary.
- Owner of credential validation.
- Setter of identity assertions (`X-Authenticated-User`).
- Stripper of credential headers before forwarding.
- Logger of authentication failures.

### 7.2 Auth Layer IS NOT

- Part of the media gateway (GW-FORBID-2).
- Part of the control plane.
- Part of consumer adapters (Plex, Jellyfin, Infuse, Kodi).
- A decision-maker for provider selection.
- A reader of bindings, lifecycle state, or resolver logic.
- A replacement for Plex permissions.

### 7.3 Trusted Zone IS

- The receiver of authenticated requests (no re-validation).
- The consumer of edge-set identity headers.
- The enforcer of business-level permissions (future, if required).

### 7.4 Trusted Zone IS NOT

- An authenticator.
- A forwarder of `Authorization` headers.
- A reader of raw credentials.

---

## 8. Explicit Non-Goals

The authentication layer does **NOT**:

- **Decide provider selection** — the binding determines the provider (GW-FORBID-14).
- **Inspect bindings** — bindings are owned by the materialization registry and reconciler.
- **Modify lifecycle state** — lifecycle is owned by the control plane and reconciler.
- **Authorize individual files** — the binding authorizes playback; auth only gates network access.
- **Replace Plex permissions** — Plex has its own authorization model. Authentication is orthogonal.
- **Become part of resolver logic** — the resolver (GW-OWN-1) owns byte delivery, not transport security.
- **Terminate TLS** — deferred per EDGE-PROXY-CONTRACT.md §5.3.
- **Rate limit** — deferred per EDGE-PROXY-CONTRACT.md §5.3.
- **Cache responses** — deferred per EDGE-PROXY-CONTRACT.md §5.3.

---

## 9. Relationship to Prior Documents

| Prior Document | Relationship |
|----------------|--------------|
| `AUTHENTICATION-BOUNDARY-ANALYSIS.md` | Superseded by this contract. Analysis → contract. |
| `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md` | Defines the media gateway. This contract adds the authentication boundary that the gateway trusts (GW-FORBID-2, AUTH-EDGE-2). |
| `EDGE-PROXY-CONTRACT.md` | Defines the edge proxy. This contract adds authentication as a deferred-but-owned responsibility (EP-OWN-1). |
| `ARCHITECTURE-BOUNDARIES.md` | Upstream boundary map. This contract adds the authentication seam between untrusted clients and the trusted zone. |
| `CONTRACTS.md` | Upstream contract patterns. This contract follows the same MUST/MUST NOT/MAY pattern. |

---

## 10. Compliance Verification

An authentication implementation **complies** with this contract if:

1. Only the edge proxy accepts user credentials from inbound requests.
2. No other component implements authentication.
3. Provider credentials are never exposed to clients.
4. `Authorization` is stripped after validation.
5. `X-Authenticated-User` is set after validation.
6. The trusted zone trusts edge assertions without re-validation.
7. Range requests pass through regardless of auth state.
8. Tokens do not expire during active playback.
9. Plex clients are not required to handle redirects, OAuth, or 401 responses.
10. Failed auth results in 401 (browser) or silent drop (Plex).
11. Auth failures are logged at the edge; raw credentials are not logged in the trusted zone.
12. Authentication can be disabled via environment variable for LAN deployments.

An implementation that violates any **MUST** constraint is non-compliant.

---

**End of contract.**

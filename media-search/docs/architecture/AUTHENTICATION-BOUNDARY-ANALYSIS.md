# Authentication Boundary Analysis — HashSucker

**Date:** 2026-08-23
**Status:** Analysis — defines the authentication seam before implementation
**Grounded in:** `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md`, `EDGE-PROXY-CONTRACT.md`, `ARCHITECTURE-BOUNDARIES.md`, `CONTRACTS.md`
**Cross-checked against:** `compose.yaml`, `edge/Caddyfile`, `media-search/src/server/app.js`
**Constraints:** No code; no schema; no implementation; no architecture changes; no new services

---

## 1. Purpose

This document answers six questions about authentication in HashSucker:

1. What component owns authentication?
2. What is the trust boundary?
3. Which authentication models are viable?
4. What is the normative contract?
5. How does authentication interact with media streaming?
6. What is the minimum viable path?

Each answer is grounded in existing contracts and current deployment topology. No authentication is implemented.

---

## 2. Current State

### 2.1 No Authentication Exists

The current system has no authentication:

- `edge/Caddyfile` — no `basicauth`, no `auth`, no forward-auth directives
- `compose.yaml` — no auth service, no auth middleware, no auth volumes
- `media-search/src/server/app.js` — no auth middleware, no session handling, no token validation
- `EDGE-PROXY-CONTRACT.md` — auth is deferred per §5.3
- `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md` — `GW-FORBID-2`: gateway MUST NOT implement authentication

This analysis defines the boundary before any authentication is added.

### 20 Deployment Topology (Current)

```
Internet
    |
    v
┌──────────────────┐
│   Edge Proxy     │  Caddy 2 Alpine
│   (edge:8080)    │  No auth, no TLS
└────────┬─────────┘
         │
         │ Docker internal network
         v
┌──────────────────┐
│  media-search    │  Node.js HTTP server
│  (:3000)         │  No auth, no middleware
│                  │
│  /media/*  ──────│──▶ Resolver → bytes
│  /api/*    ──────│──▶ Control plane
│  /*       ──────│──▶ UI/static
└──────────────────┘
         │
         │ filesystem
         v
    Mount roots
    (/downloads, etc.)
```

---

## 3. Question 1: What Component Owns Authentication?

### 3.1 Evaluation of Candidates

| Candidate | Verdict | Rationale |
|-----------|---------|-----------|
| Edge proxy | **OWNS** | Single inbound boundary (EP-OWN-1). All external traffic passes through it. Only component that can enforce auth before routing. |
| media-search control plane | MUST NOT | Owns API business logic, not transport security. Auth here would duplicate edge enforcement and require every new service to implement auth. |
| Media gateway endpoint | MUST NOT | GW-FORBID-2: gateway trusts the edge's routing decision. Byte delivery is the gateway's only responsibility. Adding auth here violates single-responsibility. |
| Consumer adapters | MUST NOT | Plex/Jellyfin/etc. are external clients. They present credentials; they do not own the trust decision. |

### 3.2 Normative Statement

**Authentication is owned by the edge proxy.** No other component may enforce authentication on inbound HTTP requests.

Rationale:

- **Single enforcement point**: The edge proxy is the only component that all external traffic must pass through (EP-OWN-1).
- **Separation of concerns**: Business logic (control plane), byte delivery (gateway), and client presentation (consumer adapters) are orthogonal to transport security.
- **Failure isolation**: If auth fails at the edge, no traffic reaches internal services. If auth were distributed, a misconfiguration in one service could expose others.
- **Media gateway contract**: GW-FORBID-2 explicitly forbids gateway auth. The gateway trusts that the edge has already authenticated.

### 3.3 Forward-Auth vs. Inline Auth

Two implementation patterns exist:

| Pattern | Description | Suitability |
|---------|-------------|-------------|
| **Inline** | Caddy performs auth locally (e.g., `basicauth`) | Simple, no external dependency. Credentials checked at edge. |
| **Forward-auth** | Caddy delegates auth decision to external service (e.g., Authelia) | More complex, adds external dependency. Edge proxies requests to auth service. |

For HashSucker's single-host Docker deployment, inline auth is sufficient. Forward-auth introduces an additional service (Authelia/AuthentiK) with its own database, configuration, and operational burden. This is over-engineering for a single-host LAN deployment.

---

## 4. Question 2: What Is the Trust Boundary?

### 4.1 Trust Zone Diagram

```
┌───────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                         │
│                                                               │
│   Plex / Jellyfin / Infuse / Kodi / Direct HTTP clients       │
│   Any client on the LAN or internet                          │
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
                            │ Headers: X-Authenticated-User (or similar)
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

### 4.2 What Crosses the Boundary

#### 4.2.1 Inbound (Client → Edge → Trusted Zone)

| Item | Handling |
|------|----------|
| `Authorization` header | **Evaluated at edge, NOT forwarded** to trusted zone. Stripped after validation. |
| `Cookie` header | **Evaluated at edge (if session-based), NOT forwarded** after validation. |
| `X-Forwarded-For` | **Set by edge** (EP-HDR-5). Trusted zone receives this. |
| `X-Real-IP` | **Set by edge** (EP-HDR-6). Trusted zone receives this. |
| `X-Authenticated-User` (or similar) | **Set by edge** after successful auth. Forwarded to trusted zone for audit/logging. |
| `Range`, `If-Range`, `If-Modified-Since` | **Forwarded unchanged** (EP-HDR-1, EP-HDR-2, EP-HDR-3). |
| `Accept` | **Forwarded unchanged** (EP-HDR-4). |

#### 4.2.2 Outbound (Trusted Zone → Edge → Client)

| Item | Handling |
|------|----------|
| `X-Resolver-*` | **Stripped by edge** (EP-HDR-7). Never reaches client. |
| `X-Internal-*` | **Stripped by edge** (EP-HDR-8). Never reaches client. |
| `Set-Cookie` | **Not set by media gateway** (GW-EDGE-9). Edge may set its own session cookies. |
| Content metadata | Forwarded unchanged (EP-STREAM-4, EP-STREAM-5). |

### 4.3 What Services Trust the Edge Decision

| Service | Trusts Edge? | Rationale |
|---------|--------------|-----------|
| media-search (control plane) | YES | No auth middleware. Relies on edge to block unauthenticated requests. |
| media-search (media gateway) | YES | GW-FORBID-2: trusts edge routing decision. |
| torbox-importer | YES | Internal service. Not directly exposed to external traffic. |

**Implication**: The trusted zone is only as secure as the edge proxy. If the edge proxy is compromised or misconfigured, all internal services are exposed. This is acceptable for a LAN deployment but must be revisited for any internet-facing deployment.

---

## 5. Question 3: Authentication Models Comparison

### 5.1 Model A — No Auth (LAN-Only Deployment)

| Dimension | Assessment |
|-----------|------------|
| **Complexity** | Zero. No credentials, no middleware, no configuration. |
| **Operational burden** | None. No password rotation, no token expiry, no lockout policies. |
| **Plex compatibility** | Perfect. Plex clients send no auth credentials; requests pass through transparently. |
| **Failure modes** | None. No auth service to fail. |
| **Suitability for HashSucker** | **Suitable for current single-host LAN deployment.** All clients are trusted. |

**Verdict**: Acceptable for LAN-only. Unacceptable for any internet-facing deployment.

**Risk**: If the host is exposed to the internet (port forwarding, VPN, etc.), all media is publicly accessible.

### 5.2 Model B — HTTP Basic Auth at Caddy

| Dimension | Assessment |
|-----------|------------|
| **Complexity** | Low. Caddy `basicauth` directive. Static credentials or htpasswd file. |
| **Operational burden** | Low. Credentials in Caddyfile or mounted htpasswd. No external service. |
| **Plex compatibility** | **Problematic.** Plex clients do not send Basic Auth credentials. Plex playback fails unless the user manually configures credentials in every client (Infuse, Kodi; not possible in most Plex clients). |
| **Failure modes** | Credential file corruption. Password rotation requires Caddy reload. |
| **Suitability for HashSucker** | **Poor.** Plex compatibility is a hard requirement. |

**Verdict**: Recommended against. Plex clients cannot present Basic Auth credentials transparently.

**Mitigation**: Could be applied to `/api/*` and `/*` routes while leaving `/media/*` unauthenticated. This protects the control plane and UI but leaves media streaming open.

### 5.3 Model C — Forward-Auth Middleware (Authelia/AuthentiK)

| Dimension | Assessment |
|-----------|------------|
| **Complexity** | High. Requires separate auth service (Authelia/AuthentiK), its own database, configuration, and reverse proxy rules. |
| **Operational burden** | High. Second service to deploy, monitor, update, and back up. Password reset flows, session management, lockout policies. |
| **Plex compatibility** | **Problematic.** Plex clients do not present credentials in a way that forward-auth services expect (no OAuth flows, no redirect handling). |
| **Failure modes** | Auth service unavailable → all requests fail (or bypass, depending on fail-open/close config). Session expiry during playback. |
| **Suitability for HashSucker** | **Poor.** Over-engineering for single-host LAN. Plex incompatibility. |

**Verdict**: Recommended against for current phase. Revisit if multi-user access control is required and Plex compatibility is solved.

### 5.4 Model D — Plex Token-Based Authorization

| Dimension | Assessment |
|-----------|------------|
| **Complexity** | Medium-High. Requires validating Plex tokens against Plex.tv. Token extraction from request headers. Caddy plex-auth plugin or custom auth service. |
| **Operational burden** | Medium. Depends on Plex.tv availability. Token validation latency. Cache management. |
| **Plex compatibility** | **Native.** Plex clients send `X-Plex-Token` header. No client-side configuration. |
| **Failure modes** | Plex.tv unavailable → auth fails. Token expiry → playback interruptions. |
| **Suitability for HashSucker** | **Good for Plex-only deployments.** Restricts access to authenticated Plex users. |

**Verdict**: Strong candidate for Plex-only deployments. Provides native compatibility and user identity.

**Limitations**:
- Only works for Plex clients. Non-Plex clients (Jellyfin, Infuse via custom protocol, direct HTTP) cannot present Plex tokens.
- Requires Plex.tv connectivity.
- Token validation adds latency per request.

### 5.5 Model E — OAuth/OIDC Provider

| Dimension | Assessment |
|-----------|------------|
| **Complexity** | High. Requires OAuth provider (Keycloak, Authentik, Auth0). Redirect flows, token issuance, token validation. |
| **Operational burden** | High. Provider deployment, client registration, redirect URI configuration, token refresh. |
| **Plex compatibility** | **Incompatible.** Plex clients cannot complete OAuth redirect flows. No browser-based login. |
| **Failure modes** | Provider unavailable → all clients fail. Token expiry → playback interruptions (streaming tokens cannot be refreshed mid-playback). |
| **Suitability for HashSucker** | **Poor.** Designed for browser-based clients, not media players. |

**Verdict**: Recommended against. OAuth is designed for interactive browser sessions, not long-lived media streaming.

### 5.6 Summary Matrix

| Model | Complexity | Ops Burden | Plex Compat | HashSucker Fit |
|-------|------------|------------|-------------|----------------|
| A — No auth | None | None | Perfect | LAN only |
| B — Basic Auth | Low | Low | Poor | Poor |
| C — Forward-auth | High | High | Poor | Poor |
| D — Plex token | Medium | Medium | Native | Plex only |
| E — OAuth/OIDC | High | High | Incompatible | Poor |

### 5.7 Recommendation

**For current phase (single-host LAN, Plex playback):** Model A (no auth). The deployment is LAN-only and all clients are trusted.

**For future internet-facing deployment:** Model D (Plex token) for Plex clients. Provides native Plex compatibility without breaking streaming.

**Do not implement:** Model B (Basic Auth breaks Plex), Model C (over-engineering), Model E (incompatible with streaming).

---

## 6. Question 4: The Future Contract

### 6.1 Normative Constraints

| ID | Constraint |
|----|------------|
| **AUTH-EDGE-1** | The edge proxy **MUST** be the only component that accepts user credentials from inbound HTTP requests. |
| **AUTH-EDGE-2** | The media gateway **MUST NOT** implement authentication. The gateway trusts the edge's routing decision (GW-FORBID-2). |
| **AUTH-EDGE-3** | The control plane **MUST NOT** implement authentication on API endpoints. The edge proxy is the single enforcement point. |
| **AUTH-EDGE-4** | Provider credentials (TorBox API keys, RealDebrid API keys) **MUST NEVER** be exposed to clients. They are used only within the trusted zone. |
| **AUTH-EDGE-5** | After successful authentication, the edge proxy **MUST** strip the `Authorization` header before forwarding requests to the trusted zone. |
| **AUTH-EDGE-6** | After successful authentication, the edge proxy **MUST** set an `X-Authenticated-User` header (or equivalent identity header) before forwarding to the trusted zone. |
| **AUTH-EDGE-7** | The trusted zone **MUST** trust the `X-Authenticated-User` header as proof of authentication. It **MUST NOT** re-validate credentials. |
| **AUTH-EDGE-8** | Authentication **MUST NOT** break Range requests. The `Range` header **MUST** be forwarded unchanged regardless of auth state. |
| **AUTH-EDGE-9** | Authentication tokens/credentials **MUST NOT** expire during active media playback. Long-lived connections (video streams) cannot tolerate mid-session re-authentication. |
| **AUTH-EDGE-10** | Failed authentication **MUST** result in `401 Unauthorized` with `WWW-Authenticate` header (for browser clients) or silent drop (for Plex clients). |
| **AUTH-EDGE-11** | The edge proxy **MUST** log authentication failures for audit. The trusted zone **MUST NOT** log raw credentials. |
| **AUTH-EDGE-12** | If authentication is added, it **MUST** be possible to disable it for LAN-only deployments without code changes (environment variable). |

### 6.2 Header Flow

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

---

## 7. Question 5: Media Streaming Considerations

### 7.1 Range Requests

Media clients (Plex, Jellyfin, Infuse, Kodi) use HTTP Range requests for seeking and buffering:

```
GET /media/abc123/0
Range: bytes=0-1023

206 Partial Content
Content-Range: bytes 0-1023/1073741824
Content-Length: 1024
```

**Authentication constraint**: The edge proxy MUST NOT require re-authentication for each Range request. Once authenticated, all subsequent Range requests for the same session/resource MUST pass through without re-validation.

**Implementation**: Session-based auth (cookie or token) validated once per session, not per request. Or: no auth on `/media/*` route (Model A).

### 7.2 Long-Lived Connections

Video streams can last hours. HTTP connections remain open for the duration.

**Authentication constraint**: Tokens MUST NOT expire during active playback. If token expiry is shorter than the maximum playback duration, playback will be interrupted.

**Implication**: OAuth/OIDC (Model E) is incompatible with long-lived streams. Plex tokens (Model D) are long-lived and do not expire during playback.

### 7.3 Plex Behavior

Plex clients do not behave like browsers:

| Behavior | Browser | Plex |
|----------|---------|------|
| Redirect to login page | Yes | No — fails playback |
| Send Authorization header | Configurable | Only X-Plex-Token |
| Handle 401 | Show login | Fail silently |
| Cookie handling | Native | Limited |
| OAuth flow | Full support | None |

**Critical insight**: Browser-based auth models (OAuth, forward-auth with redirect) do not work with Plex. Plex clients expect either no auth or token-based auth that they send automatically.

### 7.4 Token Expiration During Playback

| Model | Expiration Risk | Playback Impact |
|-------|-----------------|-----------------|
| No auth | None | None |
| Basic Auth | Credentials static | None |
| Forward-auth | Session expires | Playback interrupted |
| Plex token | Token long-lived | None (if token valid at start) |
| OAuth/OIDC | Token expires | Playback interrupted |

**Constraint**: AUTH-EDGE-9 — tokens MUST NOT expire during active playback.

### 7.5 Redirects vs. Proxy Mode

HashSucker uses proxy mode (GW-TRANS-1): the media gateway reads bytes from the filesystem and streams them to the client. There are no redirects to CDN URLs (GW-TRANS-2).

**Implication**: The client connects to the edge proxy for the entire duration. Authentication state is maintained for the connection lifetime. No mid-stream redirects that would require re-authentication on a different domain.

---

## 8. Question 6: Minimum Viable Path

### 8.1 Current Phase (LAN-Only)

**Recommendation**: No authentication.

Rationale:
- Single-host Docker deployment on LAN
- All clients are trusted
- Plex compatibility is perfect
- Zero operational burden
- Complexity is zero

**Constraint**: AUTH-EDGE-12 — authentication MUST be disable-able via environment variable for LAN deployments.

### 8.2 Future Phase (Internet-Facing, Plex Clients)

**Recommendation**: Plex token-based authorization (Model D).

Rationale:
- Native Plex compatibility
- No client-side configuration
- Long-lived tokens (no mid-playback expiry)
- Single enforcement point at edge proxy
- No external auth service required

**Implementation sketch** (not implemented):

```
Caddyfile:
  @plex path /media/*
  forward_auth @plex auth-validator:9091 {
    uri /validate
    copy_headers X-Plex-Token
  }
```

Or inline validation via a Caddy plugin or Lua script.

**Constraint**: This requires a Plex token validator. No such validator exists as a standard Caddy module. Custom development required.

### 8.3 Future Phase (Internet-Facing, Mixed Clients)

**Recommendation**: Defer until required. No current requirement.

If mixed clients (Plex + Jellyfin + direct HTTP) require auth, the only viable path is IP-based allowlisting or VPN-based access control, not application-level auth.

---

## 9. Explicit Non-Goals

The following are explicitly out of scope for this analysis:

- **TLS termination**: Deferred per EDGE-PROXY-CONTRACT.md §5.3. Not an authentication concern.
- **Rate limiting**: Deferred per EDGE-PROXY-CONTRACT.md §5.3. Not an authentication concern.
- **Multi-user access control**: No current requirement. Single-user deployment.
- **Audit logging of media access**: Deferred. Access logging is the edge's responsibility (EP-FORBID-4) but content is deferred.
- **Provider credential rotation**: Operational concern, not authentication boundary.

---

## 10. Decision Record

| Decision | Rationale |
|----------|-----------|
| Edge proxy owns auth | Single enforcement point (EP-OWN-1) |
| Media gateway does NOT own auth | GW-FORBID-2: trusts edge decision |
| Control plane does NOT own auth | Avoids duplication; single enforcement point |
| No auth for LAN deployment | All clients trusted; zero complexity |
| Plex token for future internet-facing | Native Plex compatibility; no client config |
| No OAuth/OIDC | Incompatible with Plex and long-lived streams |
| No Basic Auth | Breaks Plex clients |
| No forward-auth | Over-engineering for single-host LAN |
| Strip Authorization after validation | Trusted zone never sees credentials |
| Set X-Authenticated-User | Trusted zone can audit access |
| Auth MUST NOT break Range requests | Seeking requires Range headers |
| Auth MUST NOT expire during playback | Long-lived connections cannot re-auth |

---

## 11. Open Questions

1. **Plex token validator availability**: Is there a Caddy module or plugin that validates Plex tokens? If not, is custom development justified?

2. **Jellyfin compatibility**: If Jellyfin is added as a client, does it support Plex tokens? If not, what auth model works for both?

3. **Infuse custom protocol**: Infuse can connect via custom HTTP. Does it send Plex tokens? Or does it require Basic Auth?

4. **Multi-user future**: If multiple users require separate access controls, what identity provider integrates with both Plex and non-Plex clients?

5. **VPN alternative**: Is WireGuard/Tailscale a better boundary than application-level auth for internet-facing deployments?

---

## 12. References

- `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md` — GW-FORBID-2, GW-EDGE-1 through GW-EDGE-15
- `EDGE-PROXY-CONTRACT.md` — EP-OWN-1 through EP-OWN-6, EP-HDR-1 through EP-HDR-13, EP-STREAM-1 through EP-STREAM-8
- `ARCHITECTURE-BOUNDARIES.md` — System layer map, consumer adapters
- `CONTRACTS.md` — Identity contract, media identity
- `compose.yaml` — Current deployment topology
- `edge/Caddyfile` — Current routing configuration
- `media-search/src/server/app.js` — Current server routing (lines 541-560: media delivery endpoint)

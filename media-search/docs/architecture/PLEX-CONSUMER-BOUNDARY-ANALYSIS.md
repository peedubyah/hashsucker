# Plex Consumer Boundary Analysis — HashSucker

**Date:** 2026-08-23  
**Status:** Analysis — defines the consumer seam before adapter implementation  
**Grounded in:** `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md`, `AUTHENTICATION-BOUNDARY-CONTRACT.md`, `EDGE-PROXY-CONTRACT.md`, `MATERIALIZATION-ARCHITECTURE-V2.md`, `ARCHITECTURE-BOUNDARIES.md`, `CONTRACTS.md`, `RESOLVER-IMPLEMENTATION-PLAN.md`  
**Cross-checked against:** `media-search/src/server/app.js`, `media-search/src/lib/resolver/resolver.js`, `media-search/src/lib/resolver/source.js`  
**Constraints:** No code; no adapters; no filesystem projection; no Plex configuration; no schema changes

---

## 1. Purpose

This document defines the **consumer boundary** for Plex (and equivalent players: Jellyfin, Infuse, Kodi) in HashSucker. It answers seven questions:

1. What is Plex allowed to know?
2. What must Plex never know?
3. How should Plex consume media?
4. Who owns library metadata, filenames, subtitles, artwork, refresh, playback URLs, and repair?
5. How do multi-file releases map to Plex-visible items?
6. What does Plex see for failure states?
7. What is the future adapter contract?

Each answer is grounded in existing contracts and the current resolver implementation. No adapter is implemented.

---

## 2. Current Architecture Context

### 2.1 Resolver Endpoint

The media gateway exposes exactly one endpoint:

```
GET /media/{info_hash}/{file_index}
```

- `info_hash`: 40-char lowercase hex SHA-1
- `file_index`: non-negative integer or `torrent` (torrent-level identity)

This endpoint is the **only** byte delivery mechanism. It streams bytes from filesystem mounts (zurg, rclone, WebDAV) via the resolver projection.

### 2.2 Resolver Projection

The resolver produces a structured projection:

```
(info_hash, file_index)
    ↓
bindings (WHERE status = 'active')
    ↓
exposures (WHERE state = 'visible')
    ↓
provider_files (size, name)
    ↓
mount root (from env vars)
    ↓
MediaSource (path, size, content_type)
```

The resolver is **read-only**. It never writes to the control plane, never calls providers, never mutates lifecycle.

### 2.3 What Plex Currently Sees

**Nothing.** There is no Plex adapter, no .strm generator, no WebDAV server, no FUSE mount. Plex is not currently integrated.

This analysis defines the seam so that future adapters can be built without contaminating the resolver or control plane.

---

## 3. What Plex Is Allowed to Know

### 3.1 Authorized Knowledge

| Category | What Plex May Know | Source |
|----------|-------------------|--------|
| **Playback URL** | `http://hashsucker:port/media/{info_hash}/{file_index}` | Stable resolver endpoint |
| **Content metadata** | Title, year, resolution, codec, audio, release attributes | Cinemeta / corpus metadata |
| **File size** | `Content-Length` from resolver response | `provider_files.size` |
| **Content type** | `Content-Type` from resolver response | Derived from file extension |
| **Range support** | `Accept-Ranges: bytes` from resolver response | Resolver sets this header |
| **Library identity** | `identity_key` (e.g., `movie:tt1234:default`) | `library_items` table |
| **Canonical path** | Stable path for library organization | `library_paths.canonical_path` |

### 3.2 Authorized Interactions

| Interaction | Mechanism |
|-------------|-----------|
| **Playback** | HTTP GET to resolver URL with Range headers |
| **Seeking** | HTTP Range requests (206 Partial Content) |
| **Metadata refresh** | Plex's own metadata agents (not HashSucker's concern) |
| **Library scan** | Plex scans its configured library directory |

---

## 4. What Plex Must Never Know

### 4.1 Forbidden Knowledge

| Category | What Plex Must NOT Know | Why |
|----------|------------------------|-----|
| **Provider identity** | TorBox, Real-Debrid, etc. | Provider is an implementation detail. Plex should not care where bytes come from. |
| **Provider credentials** | API keys, tokens | Security boundary. Credentials never leave the trusted zone. |
| **Placement state** | `pending`, `ready`, `degraded`, `error` | Placement is upstream of binding. Plex consumes the binding, not the placement. |
| **Binding state** | `active`, `superseded`, `degraded`, `failed` | Binding is a resolver concern. Plex sees only playable bytes or HTTP errors. |
| **Exposure state** | `visible`, `missing`, `degraded` | Exposure is a resolver concern. Plex sees only bytes or errors. |
| **Repair state** | `planned`, `authorized`, `executing`, `succeeded` | Repair is a control-plane concern. Plex should not trigger or observe repair. |
| **Mount paths** | `/downloads/zurg/...`, `/mnt/rclone/...` | Mount paths are deployment-specific. Plex should not depend on them. |
| **Internal headers** | `X-Resolver-*`, `X-Internal-*` | Stripped by edge proxy (EP-HDR-7, EP-HDR-8). |
| **Control plane schema** | Table names, column names, foreign keys | Schema is an implementation detail. |
| **Corpus evidence** | Persistence scores, topology features, confidence | Corpus is upstream of binding. Plex consumes the binding. |

### 4.2 Forbidden Interactions

| Interaction | Why Forbidden |
|-------------|---------------|
| **Direct filesystem access** | Plex should not read mounts directly. This couples Plex to deployment topology. |
| **Provider API calls** | Plex should not call TorBox/Real-Debrid. Provider interaction is HashSucker's responsibility. |
| **Control plane writes** | Plex should not create placements, trigger repair, or modify lifecycle. |
| **Resolver mutation** | Plex should not write to `bindings`, `exposures`, or `provider_files`. |
| **Authentication** | Plex should not implement authentication. Auth is owned by the edge proxy (AUTH-EDGE-1). |

---

## 5. How Plex Should Consume Media

### 5.1 Consumption Models Evaluated

| Model | Mechanism | Plex Compatibility | Recommendation |
|-------|-----------|-------------------|----------------|
| **HTTP media URLs** | Plex plays `http://hashsucker:port/media/{info_hash}/{file_index}` | **Excellent** — Plex supports HTTP URLs natively | **Recommended** |
| **.strm files** | Plex scans `.strm` files containing resolver URLs | **Excellent** — Plex treats `.strm` as playable media | **Recommended** |
| **Filesystem paths** | Plex reads directly from mount paths | **Poor** — requires Plex on same host, couples to deployment topology | Rejected |
| **WebDAV projection** | Plex connects to a WebDAV server | **Good** — Plex supports WebDAV, but adds complexity | Future option |
| **FUSE mount** | Plex reads from a FUSE filesystem | **Poor** — requires Plex on same host, FUSE is fragile | Rejected |

### 5.2 Recommended: HTTP URLs via .strm Files

**Rationale**:

- **Stable**: The resolver URL `GET /media/{info_hash}/{file_index}` is stable forever. It does not change when provider, placement, or exposure changes.
- **Provider-agnostic**: Plex does not know or care which provider holds the bytes.
- **Range-aware**: The resolver supports Range requests (GW-TRANS-7, GW-TRANS-8). Plex can seek and buffer.
- **Edge-compatible**: The edge proxy streams bytes without buffering (EP-STREAM-1, EP-STREAM-2). Plex playback is not interrupted.
- **Authentication-ready**: If auth is added, it is enforced at the edge (AUTH-EDGE-1). Plex sends `X-Plex-Token` or no credentials; the edge validates.

**How it works**:

1. A consumer adapter generates `.strm` files in a Plex-scanned directory.
2. Each `.strm` file contains one line: the resolver URL.
3. Plex scans the directory, reads the `.strm`, and plays the URL.
4. The resolver looks up the binding, finds the exposure, reads bytes from the mount, and streams them to Plex.

### 5.3 Alternative: Direct HTTP URLs

Plex can also play HTTP URLs directly without `.strm` files. This is simpler but less organized — Plex's library metadata (title, year, artwork) must be provided separately.

### 5.4 Why Not Filesystem Paths?

Direct filesystem access requires:

- Plex to run on the same host as HashSucker (or have mount propagation).
- Plex to know mount root paths (deployment-specific).
- Plex to handle mount failures, path changes, and provider failover.

This violates the boundary: Plex would need to know about mounts, placements, and provider state. The resolver exists precisely to hide this complexity.

---

## 6. Ownership Matrix

### 6.1 Library Metadata

| Aspect | Owner | Plex Role |
|--------|-------|-----------|
| **Title, year, summary** | Cinemeta / metadata agents | Consumes via its own metadata agents |
| **Artwork (posters, thumbnails)** | Cinemeta / metadata agents | Consumes via its own metadata agents |
| **Genre, rating, cast** | Cinemeta / metadata agents | Consumes via its own metadata agents |
| **Release attributes** | Corpus evidence layer | Not directly consumed by Plex |

**Key insight**: HashSucker does not own library metadata. Plex has its own metadata agents (e.g., Plex Movie Series Scanner). HashSucker's responsibility is to provide a stable playback URL. Metadata is Plex's concern.

### 6.2 Filenames

| Aspect | Owner | Plex Role |
|--------|-------|-----------|
| **Canonical filename** | `library_paths.canonical_path` (control plane) | Not used by Plex directly |
| **Provider filename** | `provider_files.name` (provider) | Not exposed to Plex |
| **Filesystem filename** | `exposure.relative_path` (mount) | Not exposed to Plex |
| **.strm filename** | Consumer adapter (future) | Plex uses this for library display |

**Key insight**: The consumer adapter owns the `.strm` filename. It may use the canonical path, provider filename, or a generated name. Plex displays whatever filename the `.strm` has.

### 6.3 Subtitles

| Aspect | Owner | Plex Role |
|--------|-------|-----------|
| **External subtitle files** | Not currently implemented | Plex may scan for `.srt`, `.ass`, etc. |
| **Embedded subtitles** | Within the media file | Plex extracts and displays |
| **Subtitle metadata** | Not currently implemented | Not HashSucker's concern |

**Key insight**: Subtitles are either embedded in the media file (Plex handles) or external files (not currently implemented). HashSucker does not own subtitle metadata.

### 6.4 Artwork

| Aspect | Owner | Plex Role |
|--------|-------|-----------|
| **Poster, thumbnail, fanart** | Cinemeta / Plex metadata agents | Plex fetches and caches |
| **Corpus artwork** | Not currently implemented | Not HashSucker's concern |

**Key insight**: Artwork is Plex's responsibility. HashSucker does not provide artwork.

### 6.5 Refresh Lifecycle

| Aspect | Owner | Plex Role |
|--------|-------|-----------|
| **URL refresh** | Not applicable (resolver URL is stable) | Plex does not refresh URLs |
| **Binding refresh** | Control plane / reconciler | Plex does not trigger refresh |
| **Exposure refresh** | Observation layer | Plex does not trigger refresh |
| **Library refresh** | Plex's own scanner | Plex rescans on schedule or trigger |

**Key insight**: The resolver URL is stable forever. Plex does not need to refresh URLs. If the binding changes (provider failover, repair), the resolver URL remains the same — the resolver just serves bytes from a different exposure.

### 6.6 Playback URLs

| Aspect | Owner | Plex Role |
|--------|-------|-----------|
| **Resolver URL** | `GET /media/{info_hash}/{file_index}` | Plex plays this URL |
| **CDN URL** | Retired (GW-TRANS-2) | Not used |
| **Mount path** | Filesystem transport | Not exposed to Plex |

**Key insight**: The resolver URL is the only URL Plex needs. It is stable, provider-agnostic, and edge-compatible.

### 6.7 Repair Behavior

| Aspect | Owner | Plex Role |
|--------|-------|-----------|
| **Repair planning** | Control plane / reconciler | Plex does not trigger repair |
| **Repair execution** | Control plane / repair orchestrator | Plex does not observe repair |
| **Repair result** | Binding status change | Plex sees only playable bytes or errors |

**Key insight**: Repair is a control-plane concern. Plex does not trigger, observe, or understand repair. If a binding is degraded or failed, the resolver returns an error (423, 503, 410). Plex sees the error and may retry later.

---

## 7. Multi-File Release Mapping

### 7.1 Problem Statement

A single torrent may contain multiple files:

```
(info_hash) → file_index=0 (movie.mkv)
            → file_index=1 (sample.mkv)
            → file_index=2 (subtitle.srt)
            → file_index=3 (extras.mkv)
```

Plex expects one playable item per file (or per movie/episode). How does `(info_hash, file_index)` map to a Plex-visible item?

### 7.2 Mapping Rules

| Rule | Constraint |
|------|------------|
| **One file = one Plex item** | Each playable file gets its own `.strm` or URL. |
| **Non-playable files are skipped** | Samples, subtitles, extras are not mapped to Plex items. |
| **File selection is authoritative** | `provider_files.selected = 1` indicates which files are playable. |
| **Corpus mapping is authoritative** | `candidate_file_mappings` maps corpus files to provider files. |

### 7.3 Mapping Flow

```
(info_hash)
    ↓
provider_files (WHERE selected = 1)
    ↓
candidate_file_mappings (WHERE state = 'mapped')
    ↓
For each mapped file:
    .strm file → resolver URL → Plex item
```

### 7.4 Example

| info_hash | file_index | provider_file_id | selected | Plex Item |
|-----------|------------|------------------|----------|-----------|
| `abc123...` | 0 | `pf-001` | 1 | `Movie (2024).strm` → `http://.../media/abc123.../0` |
| `abc123...` | 1 | `pf-002` | 0 | Skipped (sample) |
| `abc123...` | 2 | `pf-003` | 0 | Skipped (subtitle) |
| `abc123...` | 3 | `pf-004` | 0 | Skipped (extras) |

### 7.5 Torrent-Level Identity

When `file_index = null` (torrent-level identity), the resolver returns torrent-level binding. This is used for:

- Torrents with a single file (no need to specify file_index).
- Future: torrent-level metadata aggregation.

For Plex, torrent-level identity is mapped to a single `.strm` if the torrent contains exactly one playable file. If the torrent contains multiple playable files, each file gets its own `.strm`.

---

## 8. Failure Behavior

### 8.1 What Plex Sees

Plex does not see binding states, exposure states, or repair states. Plex sees HTTP status codes.

| Resolver State | HTTP Status | Plex Behavior |
|----------------|-------------|---------------|
| **Binding active, exposure visible** | `200 OK` or `206 Partial Content` | Plays normally |
| **No binding exists** | `404 Not Found` | Item unavailable |
| **Binding failed (permanent)** | `410 Gone` | Item unavailable |
| **Exposure not visible** | `423 Locked` | Item unavailable |
| **Binding degraded** | `503 Service Unavailable` | Item unavailable, retry later |
| **Stale observation** | `503 Service Unavailable` | Item unavailable, retry later |
| **Filesystem read error** | `502 Bad Gateway` | Item unavailable |
| **Invalid identity** | `400 Bad Request` | Item unavailable (should not happen) |

### 8.2 Failure Semantics for Plex

| Constraint | Rule |
|------------|------|
| **No mid-stream failures** | Once playback starts, the resolver streams bytes until completion or client disconnect. No mid-stream HTTP errors. |
| **No authentication challenges** | If auth is added, it is enforced at the edge (AUTH-EDGE-1). Plex does not see 401 on the media path. |
| **No redirects** | The resolver does not redirect to CDN URLs (GW-TRANS-2). Plex connects to the resolver for the entire stream. |
| **Range failures return 416** | If a Range request is invalid, the resolver returns `416 Range Not Satisfiable`. Plex handles this gracefully. |

### 8.3 Plex Error Handling

Plex handles HTTP errors as follows:

| HTTP Status | Plex Behavior |
|-------------|---------------|
| `200`, `206` | Playback succeeds |
| `404`, `410` | Item is unavailable. Plex may mark as "unavailable" in library. |
| `423`, `502`, `503` | Transient error. Plex may retry later. |
| `400` | Should not happen (invalid identity). Plex logs error. |

**Key insight**: Plex does not need to understand HashSucker's internal failure reasons. It only needs to handle HTTP status codes. The resolver maps internal states to HTTP status codes (GW-OWN-11 through GW-OWN-16).

---

## 9. Future Adapter Contract

### 9.1 Consumer Adapter Ownership

The consumer adapter (future) owns:

| Responsibility | Description |
|----------------|-------------|
| **.strm generation** | Create `.strm` files in a Plex-scanned directory |
| **Filename naming** | Determine the display name for each `.strm` |
| **Directory structure** | Organize `.strm` files into Plex-friendly folders |
| **Library identity** | Map `library_items` to `.strm` files |
| **Canonical path** | Use `library_paths.canonical_path` for organization |

The consumer adapter does NOT own:

| Not Owned | Owner |
|-----------|-------|
| **Byte delivery** | Media gateway (resolver) |
| **Binding resolution** | Control plane / reconciler |
| **Provider interaction** | Provider adapters |
| **Lifecycle state** | Control plane |
| **Authentication** | Edge proxy |

### 9.2 .strm Contract

```
StrmFile:
  path: string               # Consumer library path (e.g., "/plex/movies/Movie (2024)/Movie (2024).strm")
  content: string            # Single line: resolver URL
```

**Content format**:

```
http://hashsucker:port/media/{info_hash}/{file_index}
```

**Example**:

```
http://hashsucker:8080/media/abc123def4567890123456789012345678901234/0
```

### 9.3 Directory Structure Contract

The consumer adapter determines the directory structure. A typical Plex structure:

```
/plex/
  movies/
    Movie (2024)/
      Movie (2024).strm
  tv/
    Show Name/
      Season 01/
        Show Name - S01E01.strm
        Show Name - S01E02.strm
```

The adapter uses `library_paths.canonical_path` to determine the structure.

### 9.4 Refresh Contract

| Trigger | Adapter Behavior |
|---------|------------------|
| **New binding created** | Generate new `.strm` file |
| **Binding superseded** | Update `.strm` if path changed (URL is stable, so usually no change) |
| **Binding failed** | Optionally remove `.strm` or leave for retry |
| **Library scan** | Plex rescans and picks up new/changed `.strm` files |

**Key insight**: The resolver URL is stable. The adapter does not need to update `.strm` files when the binding changes. The resolver handles binding changes transparently.

### 9.5 Edge Proxy Compatibility

The consumer adapter must respect the edge proxy contract:

| Constraint | Rule |
|------------|------|
| **No buffering** | The edge proxy does not buffer `/media/*` responses (EP-STREAM-1). `.strm` playback is not interrupted. |
| **Range forwarding** | The edge proxy forwards Range headers unchanged (EP-HDR-1). Plex seeking works. |
| **No auth on media path** | If auth is added, it is enforced at the edge (AUTH-EDGE-1). `.strm` playback is not broken. |

---

## 10. Explicit Non-Goals

The following are explicitly out of scope for this analysis:

- **Plex metadata agents**: HashSucker does not provide Plex metadata agents. Plex uses its own agents.
- **Plex plugin development**: HashSucker does not develop Plex plugins.
- **Direct mount access**: Plex should not read mounts directly.
- **Provider failover visibility**: Plex should not observe provider failover. The resolver handles it.
- **Repair triggering**: Plex should not trigger repair. Repair is a control-plane concern.
- **Authentication implementation**: This analysis does not implement authentication. Auth is owned by the edge proxy.
- **WebDAV/FUSE server**: This analysis does not implement WebDAV or FUSE. These are future options.
- **CDN redirect**: The CDN redirect model is retired (GW-TRANS-2). Not applicable.

---

## 11. Relationship to Prior Documents

| Prior Document | Relationship |
|----------------|--------------|
| `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md` | Defines the resolver. This analysis defines how Plex consumes the resolver's output. |
| `AUTHENTICATION-BOUNDARY-CONTRACT.md` | Defines authentication. This analysis respects the auth boundary (Plex does not implement auth). |
| `EDGE-PROXY-CONTRACT.md` | Defines the edge proxy. This analysis respects the proxy's streaming constraints. |
| `MATERIALIZATION-ARCHITECTURE-V2.md` | Defines the control plane. This analysis defines the consumer seam above the control plane. |
| `ARCHITECTURE-BOUNDARIES.md` | Upstream boundary map. This analysis adds the consumer adapter layer. |
| `CONTRACTS.md` | Upstream contract patterns. This analysis follows the same pattern. |
| `RESOLVER-IMPLEMENTATION-PLAN.md` | Defines the resolver. This analysis defines what sits above the resolver. |

---

## 12. Decision Record

| Decision | Rationale |
|----------|-----------|
| HTTP URLs via .strm files | Stable, provider-agnostic, Range-aware, edge-compatible |
| No direct filesystem access | Couples Plex to deployment topology; violates boundary |
| Plex does not own metadata | Plex has its own metadata agents |
| Plex does not see binding states | Plex sees only HTTP status codes |
| Consumer adapter owns .strm generation | Separates consumer concerns from resolver concerns |
| Resolver URL is stable | No need to update .strm files on binding change |

---

**End of analysis.**

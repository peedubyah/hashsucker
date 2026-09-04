# P4 — VFS Range-Forwarding Cutover

**Branch:** `m3-north-db`
**Date:** 2026-09-04
**Status:** Code cutover complete; Node-side forwarder unit-proven (5/5); end-to-end A–E require the live compose stack.

## 1. Objective & scope

Replace Node-owned byte serving *inside the existing VFS* with forwarding into the
proven Rust data plane. Plex-visible filesystem semantics, the VFS namespace, and
`PROPFIND` are **untouched**. Only the byte-delivery seam is rewired.

Out of scope (frozen, not touched in this tranche): Plex API, cleanup,
discovery redesign, provider-path deletion, final graduation, VFS file deletion,
fallback-ladder rewrite, `PROPFIND`, `materialize.js`.

### Frozen ownership

| Layer | Owns |
|-------|------|
| Node VFS | durable identity, SQLite truth, Release/TorrentFile/ProviderPlacement/MediaBinding, discovery/ranking/persisted candidates, publication/Plex-visible library semantics, VFS namespace/mount shape/PROPFIND, **WHICH** durable TorrentFile is exposed |
| Rust data plane | provider execution, DeliveryCapability lifecycle, TorBox/Real-Debrid byte delivery, Range serving, retries/Retry-After/breaker/limiter, same-TorrentFile provider recovery, fixed-chunk cache/coalescing/byte motion, byte exactness, **HOW** that TorrentFile's bytes move |

**Core invariant:** *VFS decides WHICH durable TorrentFile is exposed. Rust decides HOW that TorrentFile's bytes move.*

## 2. Files changed

| File | Change |
|------|--------|
| `media-search/src/lib/vfs/data-plane-forward.js` | **NEW** — `streamFromDataPlane({ fetchFn, baseUrl, tfId, request, response, contentType })`. Forwards the client GET/Range to `${baseUrl}/files/${tfId}` and proxies the response **verbatim** (status + allowlisted headers + streaming body, no buffering). Throws `DataPlaneError`/`DATA_PLANE_UNREACHABLE` *before any response byte is written* when the data plane is unreachable. |
| `media-search/src/lib/vfs/movie-webdav.js` | Import forwarder; add `dataPlaneBaseUrl` factory param (default `http://hy4-data-plane:3001`); in `streamFile`, after `normalizeRange` and before the legacy `openValidatedProviderRead`, branch on `state.entry.torrentFileId` → forward to Rust. |
| `media-search/src/lib/vfs/tv-webdav.js` | Mirror of movie change. |
| `media-search/src/server/app.js` | Inject `dataPlaneBaseUrl: env.DATA_PLANE_URL ?? 'http://hy4-data-plane:3001'` into both factories. |

No Rust changes in P4 — the data plane's `GET /files/:tfId` contract (built in P3) is reused as-is.

## 3. Old vs new VFS byte path

**Before (Node owned bytes):**
```
Plex GET /vfs/Movies/<path>?Range=bytes=N-M
  → handleMovieWebDav → ensureMetadata
  → streamFile
      → openValidatedProviderRead          (Node resolves provider, calls requestdl)
      → validateRangeResponseBody          (Node buffers + byte-count check)
      → writeHead(206/200) + pipe(provider body)
```
Node performed provider acquisition, Range serving, buffering, and byte-exactness.

**After (Rust owns bytes):**
```
Plex GET /vfs/Movies/<path>?Range=bytes=N-M
  → handleMovieWebDav → ensureMetadata
  → streamFile
      → normalizeRange (pure; rejects malformed ranges, no I/O)
      → if state.entry.torrentFileId:
            streamFromDataPlane → POST/GET http://hy4-data-plane:3001/files/<tfId>
                                   (Range forwarded verbatim)
                                 ← Rust: per-request S-1 → durable tuple
                                   → 206 + Content-Range + streaming body
                                      | 416 + content-range bytes */size
                                      | 502/503 upstream failure
                                 proxy status+headers+body VERBATIM to client
                                 return
      → (else / DATA_PLANE_UNREACHABLE) legacy openValidatedProviderRead path
```
Node no longer touches provider bytes — it forwards the client's request and
streams Rust's response back without buffering.

## 4. Exact identity path (P4 §5)

```
VFS entry  state.entry.torrentFileId  = "tf_<uuid>"   (durable TorrentFile surrogate,
                                                      set by materialize.js for non-legacy rows)
        │
        │ streamFromDataPlane({ tfId: state.entry.torrentFileId, ... })
        ▼
Rust GET /files/<tfId>   (tfId is the S-1 key)
        │
        │ per-request S-1 fetch: {CONTROL_URL}/api/data-plane/files/<tfId>
        ▼
Node S-1 returns  { tf_id_durable, info_hash, canonical_path, size, durable_key, physical_cache_key }
        │
        ▼
Rust builds AppState from the durable tuple and serves exactly that TorrentFile's
bytes. Routing is by the surrogate tfId only; the durable tuple is resolved
authoritatively in Rust (south of the DB boundary).
```
The identity guard is the `state.entry.torrentFileId` truthiness check in
`streamFile` — entries without a durable TorrentFile (`torrentFileId === null`,
legacy VFS rows) never enter the forward path and remain on the legacy byte path.

## 5. Proofs

### 5.1 Node-side forwarder proof (RUN — 5/5 PASS)

`.tmp-tests/p4-forwarder.test.mjs` mocks the data plane and asserts the forwarder
behaves per P4 §2/§4/§5. All cases pass on the managed Node 22 runtime:

| Case | Asserts | Result |
|------|---------|--------|
| A | 206 Range proxied verbatim (status, `content-range`, `content-length`, `accept-ranges`, body bytes) | PASS |
| B | 416 unsatisfiable proxied verbatim (`status 416`, `content-range: bytes */size`) | PASS |
| C | `DATA_PLANE_UNREACHABLE` thrown **before** `writeHead` → legacy fallback is safe | PASS |
| D | 200 full-file proxied verbatim | PASS |
| E | `tfId` routed verbatim into `/files/:tfId` URL (identity guard) | PASS |

Run: `node .tmp-tests/p4-forwarder.test.mjs`

### 5.2 End-to-end proofs A–E (REQUIRE LIVE STACK — procedure documented)

These need the `docker compose` stack up with real provider credentials
(`TorBox`/`RealDebrid`) and a seeded durable TorrentFile. They are **not** runnable
in this environment (stack is down; no seeded real media). Procedure for the live
environment:

- **Prereqs:** `docker compose up -d` (brings `media-search`, `hy4-data-plane`,
  control plane). A movie + a TV episode must be materialized with a non-null
  `torrentFileId` and a live provider capability. Identify the VFS paths via
  `PROPFIND /vfs/Movies` and `/vfs/TV`.

- **Proof A — Movie Range:** `curl -r 0-1048575 http://localhost:<vfs>/vfs/Movies/<path>`
  → expect `206`, `content-range: bytes 0-1048575/<size>`, body length 1048576;
  bytes compare to an independent source (`torrent client`/provider `requestdl`
  of the same `info_hash:canonical_path`).

- **Proof B — TV sibling identity:** Two episodes of the same series share
  `mediaId` but distinct `season`/`episode`. `curl` both VFS paths; confirm each
  forwards to its **own** `tfId` (check `hy4-data-plane` request log for
  `/files/<tfId>`) and returns its own distinct bytes/size.

- **Proof C — Seek / follow-up Range:** Open a range, then a disjoint later range
  (`bytes=50%..`) on the same movie; confirm Rust serves each independently
  (separate 206s, correct `content-range`), proving the VFS forwards arbitrary
  client seeks without Node-side Range state.

- **Proof D — HEAD:** `curl -I /vfs/Movies/<path>` → 200 with `content-length`,
  `accept-ranges: bytes`, **no** provider byte acquisition (Rust is never called;
  Node HEAD stays metadata-only). Confirm via `hy4-data-plane` access log that
  **no** `/files/<tfId>` request occurred.

- **Proof E — Rust restart:** While a movie is mid-playback, `docker restart
  hy4-data-plane`; confirm in-flight reads surface the data plane's own
  `502/503` (fallback shape, never 200) and that a fresh range after restart
  succeeds — proving the VFS treats Rust as a recoverable dependency and re-forwards
  by `tfId`.

## 6. Path-debugging discipline & mishaps

- **Path resolved:** the VFS lives at `media-search/src/lib/vfs/` (confirmed against
  the repo, not the `lib/vfs/` shorthand in the brief). All edits are under
  `media-search/src/lib/vfs/`.
- **No hardcoded IPs:** the data-plane target is the compose service name
  `http://hy4-data-plane:3001` (default) or `env.DATA_PLANE_URL`. No host IPs.
- **Stray `hy4/` dir:** a sibling untracked directory (`hy4/`, full of
  `commit*.msg`, migration scripts, `*bak` DBs) exists at repo root. It is **not**
  part of the HY4 baseline and is **excluded** from this commit. Do not `git add .`
  here — stage only the 4 P4 files explicitly.
- **`tfId` URL encoding:** `encodeURIComponent(tfId)` guards the surrogate id at the
  wire boundary (defensive; surrogate ids are already URL-safe `tf_<uuid>`).

## 7. Legacy south components now safe to remove (NOT deleted — rollback evidence, P4 §6)

Kept reachable for `torrentFileId === null` rows and as last-resort fallback when
the data plane is unreachable. Inventory for a later tranche (delete only after
cutover is declared permanent, and only after a grep confirms no other caller):

| Component | Location | Status post-P4 |
|-----------|----------|----------------|
| legacy `openValidatedProviderRead` block | `streamFile` in movie/tv | live for `tfId===null` + unreachable fallback |
| `validateRangeResponseBody` / `validateRangeResponseHeaders` / `classifyReadFailure` | `range-response-validator.js` | used only by legacy path now |
| `invalidateTorBoxCapability` | movie/tv | legacy-only |
| RD imports `attemptRdResolution`, `getRdPlaybackUrl` | `realdebrid/resolve.js` | still imported by VFS; legacy-only now |
| `resolveTorBoxDeliverySeam`, `torBoxDownloadUrlCache` | factory params | still threaded; legacy-only |
| `providerAccounting` | provider-accounting.js | legacy-only in VFS |

Deletion is explicitly out of scope for P4 (§6).

## 8. Blockers / open items

1. **Live creds + seeded durable TorrentFile** required to execute proofs A–E
   end-to-end. The Node forwarder and the Rust `/files/:tfId` contract (P3) are
   proven; the byte-exact comparison against an independent source is blocked on
   real media.
2. **Stack bring-up** is a separate op with credential/seed dependencies; not
   performed in this turn.
3. **Legacy deletion** deferred to a later tranche per P4 §6.

## 9. Commit

- Commit: P4 VFS range-forwarding cutover (4 files; +1 new module).
- Pushed to `m3-north-db` only; no force push.
- `hy4/` scratch directory intentionally excluded.

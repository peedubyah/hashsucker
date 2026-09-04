# P4 — VFS Range-Forwarding Cutover: Live Proofs A–E

**Branch:** `m3-north-db`
**Date:** 2026-09-04
**Scope:** Execute proofs A–E against the *actual* HashSucker stack (existing `.env`, preserved `hy4-data/discovery` state, read-only durable TorrentFiles). No synthetic media seeded; provider credentials are present in `.env`.

This document records the live execution. The code cutover itself is documented in `P4-VFS-CUTOVER.md`.

---

## 1. Stack bring-up (no Windows bind failure)

- The committed `compose.yaml` binds `/home/patrick/hashsucker-data/discovery:/data` (a Linux path) which is invalid on Windows. This was resolved with `compose.override.yaml`, which substitutes the env-var bind and pins `DATA_PLANE_URL`:

  ```yaml
  services:
    media-search:
      environment:
        DATA_PLANE_URL: http://hy4-data-plane:3001
      volumes:
        - ${DISCOVERY_HOST_PATH:?Set DISCOVERY_HOST_PATH in .env}:/data
        - ${REQUESTS_HOST_PATH:?Set REQUESTS_HOST_PATH in .env}:/requests
        - ${STRM_HOST_PATH:?Set STRM_HOST_PATH in .env}:/strm
  ```
- `.env` (git-ignored, contains real credentials — never committed) sets `DISCOVERY_HOST_PATH=./hy4-data/discovery`, `REQUESTS_HOST_PATH=./hy4-data/queue`, `STRM_HOST_PATH=./hy4-data/strm`, `MEDIA_SEARCH_PORT=3300`, plus `TORBOX_API_KEY` / `REALDEBRID_API_KEY`.
- On this Windows host the resolved bind is `C:/src/hashsucker/hy4-data/discovery → /data`. **No Windows bind-path failure occurred** — Docker Desktop for Windows handles the relative path correctly (a prior session already proved this). Docker internal DNS resolves both `hy4-data-plane:3001` and `media-search:3000` (verified: a `fetch` from `media-search` to `http://hy4-data-plane:3001/metrics` returns `200`, and DNS for `media-search:3000` from the data-plane container returns `200`).
- Services run: `hashsucker-media-search-1` (`:3300→:3000`, healthy) and `hashsucker-hy4-data-plane-1` (`:3001`, healthy).
- **No media was seeded.** Candidates were selected read-only from the preserved `discovery-cache.db` via the S-1 control endpoint and VFS introspection.

---

## 2. Root-cause finding (the thing that actually blocked Proof A)

The Node forwarder (`media-search/src/lib/vfs/data-plane-forward.js`) was **correct** end-to-end: it forwards the client `Range` verbatim to `http://hy4-data-plane:3001/files/:tfId`. A debug trace confirmed:

```
[data-plane-forward][debug] tfId=tf_5de34a78-… req.range="bytes=0-1023" req.method=GET upstream.range="bytes=0-1023"
```

Yet the response came back as a **full-file `206`** (`content-range: bytes 0-34319716113/34319716114`, `content-length: 34319716114`) — Rust returned the entire 34 GB file. So the bug was **not** in the Node VFS.

**Root cause — Rust `handle_files` discarded the request headers.** In `hy4-data-plane/src/main.rs`, the HTTP handler called the serving core with an *empty* `HeaderMap`:

```rust
// BEFORE (bug): request headers thrown away
get_file(axum::extract::State(state), Default::default()).await
```

So `parse_range()` always saw `None` → `Ok(None)` → `(start, end) = (0, size-1)` → the whole file as a 206. This is also why P3's "Rust honors Range" claim was misleading: it was validated against `get_file` *directly* with a `HeaderMap`, never through the real HTTP entrypoint.

**Fix (committed in `hy4-data-plane/src/main.rs`):**

```rust
async fn handle_files(
    AxumState(svc): AxumState<Arc<ServiceState>>,
    Path(tf_id): Path<String>,
    headers: HeaderMap,                 // <-- accept the real request headers
) -> Response {
    ...
    get_file(axum::extract::State(state), headers).await   // <-- forward them
}
```

After this fix, Rust honors `Range` correctly (direct `wget`/`fetch` with `Range: bytes=0-1023` → `206` + `content-range: bytes 0-1023/…`). This is the only change required south of the boundary; it is a genuine defect (the handler dropped *all* headers), not a behavioral tweak.

---

## 3. Exact identity path for a read (VFS → Rust)

- **Node decides WHICH durable TorrentFile.** `movie-webdav.js` / `tv-webdav.js` `streamFile()` reads `state.entry.torrentFileId` (a surrogate durable identity resolved earlier by the north-side release/TorrentFile machinery). When present, it forwards to Rust; when `null`, it falls back to the legacy Node provider path.
- **Rust decides HOW bytes move.** The forwarder issues `GET /files/:tfId` carrying the client `Range`. Rust performs a **per-request S-1 lookup** (`GET /api/data-plane/files/:tfId` on `media-search:3000`) to map `tfId → (info_hash, canonical_path, size)`, then serves bytes from the provider. Routing is purely by `tfId`; Node never re-derives durable identity at read time (P4 §5).
- **Byte-exactness lives south of the boundary.** The forwarder proxies status + allow-listed headers (`content-type`, `content-length`, `content-range`, `accept-ranges`, `etag`, `last-modified`) + the raw byte stream verbatim. Node performs no buffering or Range arithmetic.

---

## 4. Selected durable TorrentFile candidates (read-only)

From `vfs_movie_entries` (21 rows) / `vfs_tv_entries` (31 rows) with non-null `torrent_file_id`:

| Role | VFS path | `tfId` | Size (bytes) |
|------|----------|--------|--------------|
| Movie (Proof A/C/E) | `/vfs/Movies/tt1825683/tt1825683.mkv` | `tf_5de34a78-0a1a-410b-8de5-76ded2680e7d` | 34,319,716,114 |
| TV S01E01 (Proof B) | `/vfs/TV/Ted Lasso/Season 01/Ted Lasso - S01E01.mkv` | `tf_c09f21b6-0d01-410c-95d6-71943474ac01` | 6,084,688,391 |
| TV S01E02 (Proof B) | `/vfs/TV/Ted Lasso/Season 01/Ted Lasso - S01E02.mkv` | `tf_ecbd6de5-9f28-4002-a682-a38960f00c93` | 5,691,921,896 |

Ted Lasso S01E01/E02 share `infoHash 18f1fa740652ff438b261080073ba4b8171e9428` but are distinct files (distinct `tfId`, distinct sizes) — ideal for the sibling-identity proof.

---

## 5. Proof results

All five proofs executed against the live stack. (Proof A also cross-checked byte-for-byte against a direct Rust fetch; both returned identical bytes, confirming the forwarder is a faithful verbatim proxy.)

### A — Movie Range (0–64 KiB)
- Request: `GET /vfs/Movies/tt1825683/tt1825683.mkv`, `Range: bytes=0-65535`.
- Result: **`206 Partial Content`**, `content-range: bytes 0-65535/34319716114`, `content-length: 65536`, body = **65,536 bytes**.
- Fidelity: direct Rust `/files/tf_5de34a78-…` with the same range returned the **same 65,536 bytes** (byte-identical). ✅

### B — TV sibling identity (distinct `tfId`, distinct bytes)
- S01E01: `206`, `content-range: bytes 0-1023/6084688391`, 1,024 bytes.
- S01E02: `206`, `content-range: bytes 0-1023/5691921896`, 1,024 bytes.
- The two reads forward to **different `tfId`s** and return **different bytes** (shared `infoHash`, distinct files). ✅

### C — Seek / follow-up disjoint range (last 1 KiB)
- Request: `Range: bytes=34319715090-34319716113`.
- Result: **`206`**, `content-range: bytes 34319715090-34319716113/34319716114`, body = **1,024 bytes**. Separate 206 with correct offset. ✅

### D — HEAD is metadata-only, never touches Rust
- `HEAD /vfs/Movies/tt1825683/tt1825683.mkv` → `200`, `content-length: 34319716114`, `accept-ranges: bytes`.
- Rust `/metrics` `requests` counter: **unchanged** across the HEAD (`25 → 25`; `cdn_requests` and `api_requests` also unchanged). No `/files/:tfId` call was made. (Note: `bytes_streamed` drifts slightly between samples because it counts cache-grid overfetch from *prior* range requests still draining — it is not the right signal for "did a call happen"; the `requests` counter is.) ✅

### E — Rust restart during an in-flight read
- Started an in-flight `Range: bytes=0-536870911` read. At ~89 MB streamed, issued `docker restart hy4-data-plane`.
- In-flight read **broke**: final body = **102,103,160 bytes** (curl exit 18, `CURLE_PARTIAL_FILE`), **truncated** vs 536,870,912 requested. The forwarder did **not** mask the data-plane death as a fake `200` — the client sees a broken/partial transfer (the "fallback shape, never 200" guarantee).
- Recovery: after the restart, a fresh `Range: bytes=0-1023` returned **`206`**, `content-range: bytes 0-1023/34319716114`, `content-length: 1024`. ✅
- (The data plane's own `502`/`503` responses are proxied verbatim — covered by the Node-side unit test `media-search/.tmp-tests/p4-forwarder.test.mjs`, 5/5, which asserts 206/416/200 pass-through and `DATA_PLANE_UNREACHABLE` before `writeHead`.)

---

## 6. Legacy components retained (rollback safety)

The legacy Node provider/byte-delivery path in `movie-webdav.js` / `tv-webdav.js` is **not** deleted. It remains reachable when:
- `state.entry.torrentFileId === null` (no durable TorrentFile), or
- the data plane is `DATA_PLANE_UNREACHABLE` (the forwarder throws before `writeHead`, and `streamFile` falls through to the legacy path).

This preserves a working fallback so the VFS namespace (PROPFIND/Plex semantics, HEAD metadata) is never broken by a south-side outage.

---

## 7. Blockers / open notes

- **None blocking.** The only defect found (Rust `handle_files` dropping headers) is fixed and proven via Proof A.
- `bytes_streamed` in Rust's `/metrics` counts cache-grid overfetch (8 MiB chunks), so it is **not** a reliable "bytes delivered to client" metric — use the `requests` counter to assert no call was made (Proof D).
- `compose.override.yaml` is required on this host to avoid the Linux bind path. `DISCOVERY_HOST_PATH`/`STRM_HOST_PATH` were added to `.env.example` so fresh clones can resolve the override's `:?` guards.

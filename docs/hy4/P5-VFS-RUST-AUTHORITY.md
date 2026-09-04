# P5 — Authoritative Rust byte path + persisted-candidate fallback

**Branch:** `m3-north-db`
**Date:** 2026-09-04
**Depends on:** P2 (S-1 control), P3 (durable `tfId` / cache-key), P4 (VFS range-forwarding cutover)

## 0. Intent

For any modern durable VFS entry (`state.entry.torrentFileId != null`):

> **VFS → Rust → success  OR  → explicit failure returned to lifecycle/fallback logic**

Rust is the **only** byte-serving authority. A Rust failure must flow into the
**existing persisted-candidate fallback lifecycle** (switch `TorrentFile`, re-forward
to Rust) rather than silently escaping into the legacy Node provider stack or
presenting a truncated `206` as success.

This tranche removes the *silent* legacy fallbacks that P4 left as "rollback
evidence" for `tfId`-present entries, and gives Rust a southbound error contract
narrow enough for Node to classify every failure into exactly one of four classes
(A/B/C/D) and act on exactly one of them.

## 1. The root bug this tranche fixes

`serve.rs::get_file` wrote the `206 PARTIAL_CONTENT` headers **before** any
provider acquisition. When every Node-supplied provider for the TorrentFile was
exhausted, the spawned task simply ended the channel — so the client received a
**truncated/empty `206`**, not a `5xx`. Three helpers (`delivery_error`,
`bad_gateway`, `rate_limited_response`) were dead code because nothing ever
returned a clean `5xx` on exhaustion; the only `DeliveryError` variant
(`AllSameTfFailed`) was produced but discarded into the byte channel.

Consequence: "this TorrentFile cannot be delivered" was **indistinguishable** from
a successful (but short) `206`. Node could not classify class D, so it could not
trigger the persisted-candidate fallback. P5 fixes this south of the boundary
first, then wires Node to it.

## 2. Rust changes (`hy4-data-plane/src/`)

### 2.1 `data_plane_error` (new helper, `serve.rs`)
Structured JSON error `{ "error": { "code", "torrent_file_id" } }` with an optional
`Retry-After`. Replaces the dead plain-text `delivery_error`/`bad_gateway` for the
P5 contract. Why JSON: Node's `data-plane-forward.js` parses `error.code` to pick a
class.

### 2.2 Pre-`206` acquire + classify (`get_file`)
Before committing the `206`, `get_file` calls `state.manager.acquire_for_read(priority)`:

- **`Ok(r)`** → stash `r` as `first_reserved` and hand it to the **first**
  provider-requiring span (no double acquire; preserves the `maxInFlight=1`
  limiter). Pure cache hits (no `Fetch` run) skip acquire entirely.
- **`Err(AllSameTfFailed { retry_after })`** → return `PROVIDER_EXHAUSTED` `502`
  **before** any `206` is sent. This is class **D**, fallback-eligible.

The acquired capability is threaded through `serve_upstream_only` and
`fill_chunk_run` (new `existing_cap: Option<ReservedCapability>` parameter), so the
first byte stream reuses the already-opened reader.

### 2.3 `HY4_FORCE_EXHAUST_TFID` (TEST-ONLY gate)
Forces `PROVIDER_EXHAUSTED` for listed tfIds, returning the *real* classified `502`
exactly as `AllSameTfFailed` would. Bounded + reversible (unset to disable). Never
set in production. Used by Proof B.

### 2.4 `main.rs` S-1 failure → `S1_FETCH_FAILED`
The S-1 fetch failure branch now emits `data_plane_error(BAD_GATEWAY, "S1_FETCH_FAILED", tfId)`
instead of a plain-text `502`. This is class **B** (identity / not-found / control
unreachable) — NOT fallback-eligible.

## 3. Node changes (`media-search/src/`)

### 3.1 `data-plane-forward.js` — classify, don't blindly proxy
`streamFromDataPlane` now **classifies** the Rust response:

- `200`/`206` → proxy verbatim (unchanged P4 behavior).
- anything else → read the JSON body, parse `error.code`, map to a P5 class via
  `classifyDataPlaneError(code, status)`, and **throw** a `DataPlaneError` carrying
  `{ status, code, class }` (rather than proxying the `5xx` verbatim).
- network unreachable → `DATA_PLANE_UNREACHABLE`, class **C** (explicit, no legacy
  escape — re-forwarding to a dead plane is pointless).

Throwing (instead of proxying) is what lets `streamFile` intercept class D and run
the fallback. Because the throw happens **before** `response.writeHead`, the
re-forward can still write headers.

| `error.code` | class | meaning |
|---|---|---|
| `PROVIDER_EXHAUSTED` | **D** | provider exhaustion — fallback-eligible |
| `S1_FETCH_FAILED` | **B** | identity/not-found/control down — no blind fallback |
| `INTERNAL_ERROR` | **C** | transient infra / explicit `5xx` — no legacy escape |
| *(status 416)* | **A** | client Range unsatisfiable — no fallback |
| `DATA_PLANE_UNREACHABLE` | **C** | Rust down — explicit, no legacy escape |

### 3.2 `movie-webdav.js` / `tv-webdav.js` — fallback seam, no silent escape
`streamFile` for a `tfId`-present entry:

1. `try streamFromDataPlane(...)` → on success, return (bytes proxied).
2. `catch error` → `attemptPersistedAlternateFallback({error, state, ...})`.
   - returns `true` (alternate served) → return.
   - returns `false` → `sendError(response, error, {size})` — the **classified Rust
     failure, verbatim**. Explicit terminal, **NO legacy escape**.

`attemptPersistedAlternateFallback` is invoked **only** for class D. It reuses the
**existing** persisted-candidate lifecycle (no rediscover/rerank):

```
findUsableAlternate({mediaId, primaryReleaseKey, expectedScope})
  → must be TorBox CACHED (a durable TorrentFile exists)
resolveTorBoxDeliverySeam({infoHash, fileIndex, releaseKey, filename})
isUrlLive(delivery.url)                         // one bounded byte validation
promoteAlternate({candidate, delivery, controlPlaneStore, evidence:{validatedBytes:true}, mediaRequest, now})
materializeVfsEntry(searchCache, promotion.handoff, controlPlaneStore, now, {allowLegacy:true})
streamFromDataPlane({ tfId: promotion.handoff.torrentFileId, ... })   // re-forward to Rust
```

If **any** step fails (no candidate, not TorBox-cached, URL not live, promote
refused, materialize failed, re-forward fails) it returns `false` and the caller
emits the explicit `5xx`. **Rust owns same-TorrentFile recovery**; this seam only
switches `TorrentFile`.

`alternateFallback` is added to both factories and wired from `app.js`.

### 3.3 Legacy path reachability (the cut)
The legacy Node provider/byte-delivery path (`openValidatedProviderRead`) is now
reachable **ONLY** when `state.entry.torrentFileId === null` (no durable
TorrentFile). The P4 `DATA_PLANE_UNREACHABLE → legacy fallback` branch for
`tfId`-present entries is **deleted**. This satisfies P5 §1 (no silent legacy
fallback for durable entries).

## 4. Identity discipline (exact, never heuristic)

Every fallback carries the **exact durable tuple** — `mediaId`, `releaseKey`,
(season, episode for TV), and the candidate's `infoHash`/`fileIndex`/`filename` —
into `findUsableAlternate` / `resolveTorBoxDeliverySeam` / `promoteAlternate`. We
**never** pass `infoHash`-only or rely on a sibling heuristic: the new
`torrentFileId` comes exclusively from `promotion.handoff.torrentFileId` (resolved
through the control plane's `getTorrentFile`), so identity is always the durable
PK, never inferred.

## 5. Telemetry / accounting ownership

- **Reused, not duplicated:** fallback telemetry uses `buildFallbackTelemetry`
  (`fallbackUsed`, `originalReleaseKey`, `selectedReleaseKey`, `fallbackRank`,
  `reason`) — the same envelope the resolver path uses. Emitted via `console.log`
  on each P5 fallback; the resolver path in `app.js` remains the structured
  telemetry owner.
- **No double-counting:** the modern (`tfId`-present) byte path never enters
  `openValidatedProviderRead`, so the `providerAccounting` delivery/requestdl/
  availability/placement counters — which describe provider-API + byte-motion truth
  that Rust now owns — are **not** incremented on the modern path. `providerAccounting`
  remains legitimately active only for `torrentFileId === null` legacy entries.

## 6. Legacy South deletion inventory

Grep of actual call sites (no legacy escape remains for `tfId`-present):

- **Removed:** `movie-webdav.js` / `tv-webdav.js` `streamFile` `DATA_PLANE_UNREACHABLE
  → openValidatedProviderRead` fallthrough (the silent escape).
- **Retained (compat):** `openValidatedProviderRead` itself — still the byte path
  for `torrentFileId === null` entries.
- **Retained (north of delivery):** `findUsableAlternate`, `promoteAlternate`,
  `materializeVfsEntry`, `resolveTorBoxDeliverySeam`, `isUrlLive` — reused, not
  copied.
- **Dead but untouched:** `serve.rs::delivery_error`/`bad_gateway`/`rate_limited_response`
  remain (harmless; superseded by `data_plane_error`). Not deleted to keep the diff
  focused.
- **No provider-persistence expansion:** RD-only candidates (no durable
  TorrentFile) are **not** served via the VFS Rust path — `findUsableAlternate`
  requires `revalidation.cacheState === CACHED` to proceed. (P5 §10.)

## 7. Proof ladder A–E (execute against the live stack)

Bring up the stack (Docker, `compose.override.yaml`, `DATA_PLANE_URL` pinned). Use
the durable candidates from `P4-PROOFS.md` §4.

- **A — primary success, no legacy escape.** `GET /vfs/Movies/tt1825683/tt1825683.mkv`
  `Range: bytes=0-65535` → `206`, 65 536 bytes. Confirm the legacy path is not
  touched (no `openValidatedProviderRead` call on the `tfId`-present entry).
- **B — forced exhaustion → persisted alternate.** Set `HY4_FORCE_EXHAUST_TFID=tf_5de34a78-…`
  on the data-plane container. Re-request A's range → Rust returns `PROVIDER_EXHAUSTED`
  (502, class D). `streamFile` runs `attemptPersistedAlternateFallback`, selects a
  TorBox-cached alternate, re-forwards to Rust with the **new** `tfId`, and serves
  bytes. Unset the env → revert.
- **C — 416, no fallback.** Request an unsatisfiable range (`bytes=99999999999999-…`)
  → `416`, class A. Confirm `sendError` fires and **no** fallback / legacy path runs.
- **D — Rust unreachable → explicit 5xx, no legacy.** Stop the data-plane container.
  Re-request → `DATA_PLANE_UNREACHABLE` (class C) → `sendError` 502. Confirm the
  client gets an explicit failure and the legacy Node provider path is **not** entered
  for the `tfId`-present entry.
- **E — TV sibling safety.** With `HY4_FORCE_EXHAUST_TFID=tf_c09f21b6-…` (Ted Lasso
  S01E01), re-request S01E02 (`tf_ecbd6de5-…`) → S01E02 still serves normally (its
  own `tfId` not forced), proving exhaustion is **per-TorrentFile**, not
  per-infoHash, and identity is exact.

## 8. Files changed

| File | Change |
|------|--------|
| `hy4-data-plane/src/serve.rs` | `data_plane_error`; pre-`206` acquire + classify; `HY4_FORCE_EXHAUST_TFID` gate; `existing_cap` threaded into `fill_chunk_run` + `serve_upstream_only`. |
| `hy4-data-plane/src/main.rs` | S-1 failure → `S1_FETCH_FAILED`. |
| `media-search/src/lib/vfs/data-plane-forward.js` | Classify non-2xx/`206` responses; `classifyDataPlaneError`; class-aware `DataPlaneError`. |
| `media-search/src/lib/vfs/movie-webdav.js` | `alternateFallback` param; `attemptPersistedAlternateFallback` helper; `streamFile` cutover (no silent escape). |
| `media-search/src/lib/vfs/tv-webdav.js` | same as movie-webdav. |
| `media-search/src/server/app.js` | wire `alternateFallback` into both VFS factories. |
| `docs/hy4/S1-CONTROL-CONTRACT.md` | appended **Byte error contract (P5)**. |
| `docs/hy4/P5-VFS-RUST-AUTHORITY.md` | this document. |

## 9. Next blockers / coherence gates

- **Build + `cargo test`** must run in the pinned builder (`rust:1.96.1-alpine3.22`)
  — **Docker is currently unavailable in this sandbox** (WSL blocked, no Docker
  Desktop binary), so the container build, `cargo test`, and proofs A–E are pending
  an environment with Docker. Commands:
  ```bash
  docker build -t hy4-data-plane:local -f hy4-data-plane/Dockerfile hy4-data-plane
  docker compose up -d --build hy4-data-plane media-search
  # proofs A–E per §7
  ```
- **Coherence gate (all 12):** no silent legacy escape · classifiable failures ·
  alternate selection · Rust byte path · 416 no-fallback · unreachable no-legacy ·
  same-TF recovery Rust-owned · coherent telemetry · explicit accounting · legacy
  inventory · proofs pass · committed + pushed. Pushed only after the build/proofs
  pass in a Docker-capable environment.

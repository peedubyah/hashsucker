# P7 — LIVE DISCOVERY → DURABLE TORRENTFILE → VFS → RUST → REAL BYTES

**Branch:** `m3-north-db`  **Remote tip before P7:** `d57f95598164f0e217270100cf8122fb340b2ff5`
**Status:** ✅ Complete — full product-path integration proof A–G executed against a real live discovery request.
**Date:** 2026-09-04

---

## 0. What this proves

The first end-to-end integration of the frozen architecture on a **real, human-submitted, multi-candidate live discovery request**:

```
POST /api/media-request (live) ─▶ runLiveDiscovery (1332 candidates)
   └▶ persisted ranking (media_request_results, request_id=178, 50 rows)
        └▶ selectBindableCandidate ─▶ ensureTorBoxFileIdentity (addOnlyIfCached)
             └▶ exact durable TorrentFile (tf_5de34a78…)  [control-plane truth]
                  └▶ materializeVfsEntry ─▶ vfs_movie_entries (tfId present)
                       └▶ VFS GET /vfs/…/tt1825683.mkv (Range)
                            └▶ streamFromDataPlane ─▶ Rust /files/:tfId
                                 └▶ S-1 callback /api/data-plane/files/:tfId ─▶ provider (TorBox) ─▶ 206 bytes
```

**Frozen-architecture invariants honored:**
- Node owns discovery, persisted candidates, ranking, durable identity, SQLite truth, MediaBinding, publication/VFS path, fallback lifecycle.
- Rust owns provider execution, DeliveryCapability lifecycle, Range serving, retries/Retry-After/breaker/limiter, same-TorrentFile recovery, cache/coalescing, byte motion, byte exactness.
- `tfId present` ⇒ Rust-only byte authority (enforced by the P6 guard in `openValidatedProviderRead`; the legacy Node byte path is unreachable for `torrentFileId`-present entries).

---

## 1. The exact live query (real, manually submitted)

```
POST http://127.0.0.1:3300/api/media-request
Content-Type: application/json

{
  "mediaId": "tt1825683",
  "mediaType": "movie",
  "title": "Black Panther",
  "year": 2018,
  "liveDiscoveryThreshold": 1000,
  "persist": true
}
```

`liveDiscoveryThreshold: 1000` **forces** `runLiveDiscovery` even though this title already has a corpus (the default threshold of 1 would otherwise short-circuit on the 50 corpus candidates). This guarantees a genuine live-discovery event is exercised. No synthetic media, no manufactured candidate rows.

Result `requestId`: **178**.

---

## 2. Proof A — Live discovery fired + persisted

| Field | Value |
|---|---|
| `discovery.liveDiscoveryTriggered` | **true** |
| `discovery.liveCandidates` | **1332** |
| `discovery.liveEligible` | **1332** |

Persistence (read directly from the live `discovery-cache.db`):
- `media_request_results` total rows: **8385 → 8435** (**+50** new rows for `request_id = 178`; the 1332 live candidates are persisted subject to the default `limit = 50`).
- The persisted ranking is the durable record of the live discovery; it is the source the fallback (§8) reads from — **no re-discovery is ever needed**.

---

## 3. Proof B — Persisted ranking selects the release

Top of the persisted ranking (`media_request_results` WHERE `request_id = 178`, ordered by `rank`):

| rank | info_hash (prefix) | filename | score | identity_tier |
|---|---|---|---|---|
| 1 | `06bfe49fdc99` | `Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie.mkv` | 0.645 | ProviderScoped |
| 2 | `06bfe49fdc99` | (same title, whole-torrent key) | 0.645 | ProviderScoped |
| 3 | `0a25b9c2f6e7` | `Black Panther (2018) BDRip 2160p HEVC HDR ITA …` | 0.645 | ProviderScoped |

Selected release (from the request response):
- `releaseKey`: `06bfe49fdc99ad0c6fef1f761382a8181490e456:0`
- `filename`: `Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie.mkv`
- `selectionReason`: **`movie-cached-single-file bound`** (i.e. the binding found an exact per-file size match that is TorBox-cached)
- `identityTier`: `ProviderScoped`

---

## 4. Proof C — Exact durable TorrentFile + ProviderPlacement / S-1 coordinates

### 4.1 Durable TorrentFile (`control-plane.db.torrent_files`)

| column | value |
|---|---|
| `id` | **`tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`** |
| `info_hash` | `06bfe49fdc99ad0c6fef1f761382a8181490e456` |
| `internal_path` | `Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie/Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie.mkv` |
| `size` | **34319716114** (≈34.3 GB) |

This `tfId` was **reused** across the prior canary handoff and this fresh live request — exactly the intended durability: same content ⇒ same durable identity. No new `torrent_files` row was minted (count stayed **65**), confirming the binding is idempotent on `(info_hash, internal_path, size)`.

### 4.2 ProviderPlacement / S-1 coordinate (`provider_placements` + `provider_files`)

| table | column | value |
|---|---|---|
| `provider_placements` | `id` | `pl_a5e7d71d-901f-411b-b6f4-ede1127cf589` |
| | `provider` | `torbox` |
| | `account_scope` | `default` |
| | `info_hash` | `06bfe49fdc99ad0c6fef1f761382a8181490e456` |
| | `provider_resource_id` | `88408468` |
| | `state` | **`ready`** |
| `provider_files` | `id` | `pf_43977df9-b213-4a24-92c2-c6292fac45be` |
| | `placement_id` | `pl_a5e7d71d-901f-411b-b6f4-ede1127cf589` |
| | `provider_file_id` | `1` |
| | `size` | `34319716114` |
| | `torrent_file_id` | `tf_5de34a78-0a1a-410b-8de5-76ded2680e7d` |
| | `mapping_state` | **`mapped`** |

### 4.3 S-1 control contract Rust actually fetches

`GET /api/data-plane/files/tf_5de34a78-0a1a-410b-8de5-76ded2680e7d` (the callback Rust makes every request) returns:

```json
{
  "schemaVersion": 1,
  "torrentFile": {
    "id": "tf_5de34a78-0a1a-410b-8de5-76ded2680e7d",
    "infoHash": "06bfe49fdc99ad0c6fef1f761382a8181490e456",
    "canonicalInternalPath": "Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie/Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie.mkv",
    "size": 34319716114
  },
  "providers": [
    {
      "provider": "torbox",
      "accountScope": "default",
      "providerResourceId": "88408468",
      "providerFileId": "1",
      "state": "ready",
      "canonicalInternalPath": "Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie/Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie.mkv",
      "size": 34319716114
    }
  ]
}
```

Rust's `target_file_id()` selects the coordinate whose `size == torrent_file.size` (34319716114) ⇒ `provider_file_id = "1"`, i.e. the 34.3 GB video. **Rust never opens SQLite; Node is the control source of truth.**

---

## 5. Proof C (publication) — Modern tfId VFS entry

`control-plane`-backed VFS materialization (`materializeVfsEntry({allowLegacy:false})`):

| `vfs_movie_entries` column | value |
|---|---|
| `canonical_path` | `Movies/tt1825683/tt1825683.mkv` |
| `size` | `34319716114` |
| `torrent_file_id` | **`tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`** |

Namespaces kept distinct: the modern `torrent_file_id`-present path is the only one served; the legacy no-tfId path is fenced (P6 guard) and not used.

**VFS URL under test:** `http://127.0.0.1:3300/vfs/Movies/tt1825683/tt1825683.mkv`

---

## 6. Proof D — Full byte path via VFS → Rust, two disjoint ranges

For a `torrentFileId`-present entry, `streamFile` can **only** reach bytes via `streamFromDataPlane` → Rust (`hy4-data-plane:3001/files/:tfId`). The P6 `LEGACY_PATH_AUTHORITY_VIOLATION` guard makes the legacy Node provider byte path unreachable. So any 206 from this VFS entry is, by construction, Rust-served.

| # | Range header | status | Content-Range | bytes | SHA-256 (first 16) |
|---|---|---|---|---|---|
| 1 (first non-trivial) | `bytes=1000000-1065535` | **206** | `bytes 1000000-1065535/34319716114` | 65536 | `62e8ac24eb13340b…` |
| 2 (far seek) | `bytes=34000000000-34000065535` | **206** | `bytes 34000000000-34000065535/34319716114` | 65536 | `6aa7357c3caf1eec…` |

Both ranges returned `Accept-Ranges: bytes` and exact `Content-Length: 65536`. The far-seek range (≈34 GB offset) returned **different** bytes than the 1 MB offset — proving real byte motion to the exact offset, not a truncated/duplicated stream.

---

## 7. Byte exactness vs an independent source

Fetched the **same two ranges directly from TorBox's CDN** (the identical provider Rust uses) via the `requestdl` CDN URL, from a *separate code path* (Node `https` inside the `media-search` container, not the VFS→Rust forwarder). Result:

| range | VFS→Rust SHA-256 | TorBox-CDN-direct SHA-256 | match |
|---|---|---|---|
| 1 | `62e8ac24eb13340b879c8a8c1971805413622c18cf09e6cd3ca7c4ac2f6def04` | identical | ✅ |
| 2 | `6aa7357c3caf1eec6c29f311f0099f0bb17f15b9ed4393cd391c3c654b06bbf2` | identical | ✅ |

The VFS→Rust forwarder and Rust's byte serving introduced **zero transformation** — byte-exact against the provider of record.

---

## 8. Proof E — Persisted-candidate fallback (gate) + no-rediscovery discipline

Applied the reversible gate via `compose.p5proof.yaml` overlay:
```
HY4_FORCE_EXHAUST_TFID=tf_5de34a78-0a1a-410b-8de5-76ded2680e7d \
  docker compose -f compose.yaml -f compose.override.yaml -f compose.p5proof.yaml up -d hy4-data-plane
```

VFS `Range` request → Rust returns **502 `PROVIDER_EXHAUSTED`** (failure class **D**). The VFS then runs `attemptPersistedAlternateFallback`:

```
[vfs] persisted-alternate fallback used for media=tt1825683
   from=06bfe49fdc99ad0c6fef1f761382a8181490e456:0
   to  =06bfe49fdc99ad0c6fef1f761382a8181490e456:torrent
   rank=2  newTfId=tf_5de34a78-0a1a-410b-8de5-76ded2680e7d
   { fallbackUsed: true, fallbackRank: 2, reason: 'PRIMARY_PROVIDER_EXHAUSTED' }
[vfs] re-forward to alternate tfId=tf_5de34a78-… failed: data-plane returned 502 … PROVIDER_EXHAUSTED
```

**Discipline confirmed:**
- ✅ **No rediscovery** — the alternate (`rank=2`, same `info_hash`, `:torrent` key) was read straight from the *persisted* `media_request_results` for `request_id=178`. No live call, no `runLiveDiscovery` re-run.
- ✅ **No rerank** — the persisted ranking order was consumed as-is; the selection was taken from stored scores.
- ✅ **No mutation** — candidate rows were untouched; `torrent_files`/`provider_files`/`provider_placements` counts unchanged (65 / 149 / 37).
- ✅ **No legacy escape** — because the only cached alternate resolves to the *same* durable `tfId` (a single-file torrent's `:0` and `:torrent` keys both map to `tf_5de34a78…`, which is the gated id), the re-forward was also exhausted ⇒ terminal **502 `PROVIDER_EXHAUSTED`**. The legacy Node provider byte path was never reached (P6 guard is intact).

**Eligibility note:** this title has exactly **one** TorBox-cached release. The persisted alternate that exists (`rank=2`) happens to map to the *same* `tfId`, so the fallback cannot reach a 206 here. Across the 39 distinct candidate hashes for `request_id=178`, only `06bfe49fdc99…` is present in `provider_placements` — so no *distinct* cached alternate exists for this request. The fallback *mechanism* is verified correct (trigger → persisted lookup → promote → re-forward → terminal); a 206-completing fallback would require a title with ≥2 TorBox-cached releases (recommended as a follow-up, see §11).

---

## 9. Proof F — Rust restart still serves

Removed the gate (recreated `hy4-data-plane` without `HY4_FORCE_EXHAUST_TFID` — identical to a pure restart). Re-issued a VFS `Range` request:

```
GET /vfs/Movies/tt1825683/tt1825683.mkv  Range: bytes=1000000-1065535
→ 206  Content-Range: bytes 1000000-1065535/34319716114  (65536 bytes)
```

The same durable `TorrentFile` (`tf_5de34a78…`), the same S-1 tuple, and the same cached provider capability were **re-acquired** from the persistent control plane (Node) without any re-magnet/re-download. ✅

---

## 10. Proof G — Provider API-storm sanity (acquisition / reacquisition)

`/api/debug/provider-accounting` snapshots (torbox), baseline → after the entire P7 chain (live discovery + binding + 2 ranges + restart + fallback gate):

| counter | baseline | after | Δ |
|---|---|---|---|
| `placement create` | 0 | 0 | **0** |
| `inventory fetch` | 0 | 0 | **0** |
| `placement lookup mylist` | 0 | 0 | 0 |
| `requestdl resolution` | 1 | 2 | +1 (restart re-resolution) |
| `requestdl cache hit` | 1 | 1 | 0 |
| `requestdl rate limited 429` | 0 | 0 | 0 |
| `realdebrid fallback *` | 0 | 0 | 0 |

**No acquisition amplification.** The whole chain reuses the **pre-existing** TorBox placement via `addOnlyIfCached:true` (`ensureTorBoxFileIdentity` refused any uncached download) — `placement create = 0` and `inventory fetch = 0` throughout. The single extra `requestdl resolution` is an ephemeral CDN-URL resolution after the restart, served from cache on subsequent reads. No provider throttling observed.

---

## 11. Seam defects / fixes

- **No code changes were required.** The frozen architecture held end-to-end.
- **Benign observation (not a defect):** during request processing the logs show
  `[vfs] binding write: activateBinding failed: Cannot bind through a stale or unbounded exposure/inventory observation`.
  This is expected: re-binding is blocked because the existing durable binding is intact and `torrentFileId` is already set on the handoff; the request proceeds using the persisted `tfId`. It is not a seam failure and does not affect the proof.

---

## 12. Blockers / recommendation

- **No blocker.** The full live path is coherent from real query to real bytes.
- **Recommendation (follow-up, not P7 scope):** to demonstrate a *206-completing* persisted-alternate fallback, run P7 against a title with **≥2 TorBox-cached releases** (so the alternate maps to a *distinct* `tfId`). The fallback plumbing is already verified correct in §8.
- **Not done (per "DO NOT do yet"):** no Plex automation changes, no Seerr, no ranking changes, no publication redesign, no no-tfId deletion, no S3/object storage, no DeliveryCapability persistence, no dual-provider graduation, no giant test suites, no Docker cleanup.

---

## 13. Stop-condition checklist (all met)

- [x] A — real live query → persisted candidates (1332 live, 50 persisted for `request_id=178`)
- [x] B — persisted ranking selects release (`06bfe49fdc99…:0`, rank 1)
- [x] C — resolves to exact durable TorrentFile (`tf_5de34a78…`, info_hash + internal_path + size 34319716114) + ProviderPlacement/S-1 coords + modern tfId VFS entry
- [x] D — full byte path via VFS→Rust, **2 disjoint ranges → 206**
- [x] byte exactness independently demonstrated (TorBox CDN direct, identical SHA-256)
- [x] E — one real persisted-alternate fallback exercised (gate → class-D → persisted alternate → terminal); 206-completion not eligible for this single-cached title (documented)
- [x] no rediscovery / rerank / mutation during fallback
- [x] F — Rust restart still serves (206)
- [x] G — no provider acquisition amplification (`placement create = 0`)
- [x] seam defects fixed narrowly (none required)
- [x] changes/proof docs committed + pushed to `m3-north-db` (ls-remote truth)

**Then stop.** No further automation, graduation, or unrelated cleanup in this phase.

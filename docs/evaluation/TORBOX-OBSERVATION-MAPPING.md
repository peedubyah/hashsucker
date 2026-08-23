# TorBox-to-Stage-4 Observation Mapping

**Date:** 2026-08-23
**Scope:** Determine how TorBox API reality maps into the Stage 4 exact-candidate observation model.
**Method:** Static analysis of existing capability contracts, observation model, and TorBox response shapes. No live API calls.

## Summary

TorBox exposes **two distinct surfaces** with different identity granularities:

| Surface | API endpoint | Identity granularity | Can produce exact candidate observation? |
|---|---|---|---|
| **Cache observation** | `torrents/checkcached` | Torrent-level (`infoHash` only) | **No** — only torrent-scoped observations |
| **Account inventory** | `torrents/mylist` | Placement (`id` + `hash`) + file list | **Indirect** — placement + inventory, but no corpus fileIndex |

**Key finding:** Neither TorBox surface natively exposes a `(infoHash, fileIndex)` / `releaseKey` match. Cache observation is torrent-level only. Account inventory has opaque provider file IDs and never guesses corpus file indexes (`corpusFileIndex: null`).

---

## 1. TorBox evidence mapping

### 1.1 Cache observation — `torrents/checkcached`

**What identifies a cached item?**
- `infoHash` only. The endpoint accepts a list of hashes and returns a map keyed by hash.
- Response shape (from `torbox.js` and fixtures):
  ```json
  {
    "success": true,
    "data": {
      "<infoHash>": { "name": "...", ... }  // present+truthy = cached
    }
  }
  ```
  Absent or falsy value = not cached.

**Identity level:** Torrent-level only. The endpoint does **not** accept or return `fileIndex`. The current adapter (`createTorBoxProvider`) correctly emits `scope: 'torrent'`, `fileIndex: null`.

**Fields available:**
| Field | Present? | Notes |
|---|---|---|
| `infoHash` | Yes | Canonical lowercase hash |
| `fileIndex` | **No** | Not part of the API contract |
| `file identifiers` | **No** | Not returned |
| `release/torrent identifiers` | Partial | `name` string, but no TorBox-native torrent ID in cache response |
| `status/error` | Yes | `success`, `detail`, `error` fields; per-batch failure isolation |
| `timestamps** | No | No server timestamp; client assigns `observedAt` + TTL |

**File inventory (`list_files: true`):** The adapter explicitly passes `list_files: false`. Even when requested, the cache endpoint returns torrent-level file metadata (sizes/names) but **not** corpus-aligned file indexes. It remains a torrent-level signal.

### 1.2 Account inventory — `torrents/mylist`

**What identifies a placed item?**
- TorBox resource `id` (opaque provider ID) + `hash` (infoHash).
- Each resource has a `files[]` array with opaque provider file IDs.

**Identity level:** Placement + provider file inventory. Two layers:
- **Placement**: `(providerResourceId, hash)` — torrent-level identity.
- **Provider file**: opaque `file.id` (e.g., `"900"`) — no mapping to corpus `fileIndex`.

**Fields available per resource:**
| Field | Present? | Notes |
|---|---|---|
| `id` | Yes | Opaque provider resource ID |
| `hash` | Yes | infoHash |
| `name` | Yes | Release/torrent name |
| `download_state` / `state` / `download_status` / `status` | Yes | Readiness derivation |
| `files[]` | Yes | Provider file inventory |

**Fields available per file:**
| Field | Present? | Notes |
|---|---|---|
| `id` | Yes | Opaque provider file ID (string/number) |
| `name` | Yes | Full path (e.g., `"Release/movie.mkv"`) |
| `size` | Yes | Bytes |
| `selected` | Yes | Boolean — provider selection state |

**Critical absence:** `corpusFileIndex` is explicitly **null** in `normalizeFile()`:
```js
corpusFileIndex: null,
```
The adapter never guesses a corpus file index from position or name. This is a deliberate boundary.

---

## 2. Observation compatibility analysis

### 2.1 Cache observation (`checkcached`) → Stage 4

| Criterion | Result |
|---|---|
| Can it produce an exact candidate observation? | **No** — torrent-level only (`fileIndex: null`) |
| Does it require projection? | No — it already emits a valid `scope: 'torrent'` observation |
| Is it insufficient evidence? | For **file-level candidates**, yes. It cannot authorize a `(infoHash, 0)` candidate |
| Authority level | `authoritative` — the provider is the source of truth for cache state |

**Projection behavior through Slice 1A:**
- A `scope: 'torrent'`, `fileIndex: null` observation against a **torrent-level candidate** (`fileIndex: null`) → **projected**.
- A `scope: 'torrent'` observation against a **file-level candidate** (`fileIndex: 0`) → **rejected** (`torrent-scope-file-candidate`). This is correct: a cached torrent does not prove a specific file is available.

### 2.2 Account inventory (placement) → Stage 4

| Criterion | Result |
|---|---|
| Can it produce an exact candidate observation? | **No** — placement observations are `scope: 'torrent'` with `fileIndex: null` |
| Does it require projection? | Placement observations are a separate model (`createPlacementObservation`), not cache observations |
| Authority level | `authoritative` for placement/readiness |

The placement observation (`createPlacementObservation`) is **not** a cache observation — it belongs to the `PLACEMENT_LOOKUP` / `RESOURCE_READINESS` capabilities and is keyed differently. It does not feed the cache-observation projection path directly.

### 2.3 Account inventory (file inventory) → Stage 4

| Criterion | Result |
|---|---|
| Can it produce an exact candidate observation? | **No** — opaque provider file IDs, `corpusFileIndex: null` |
| Is it insufficient evidence? | **Yes** — without a validated mapping from provider file ID (or file path/name) to corpus `fileIndex`, no file-level cache observation can be constructed |
| Authority level | `authoritative` for inventory content, but **not** a cache signal |

The file inventory (`createProviderFileInventory`) tells us *what files exist* in a placement, but it is not itself a cache observation and carries no `(infoHash, fileIndex)` alignment.

---

## 3. Fixtures

Fixtures are defined in `media-search/test/fixtures/torbox-response-fixtures.js` and cover:

1. **Exact file-level match (not supported by API):** Demonstrates that even when a file path/name is known, the absence of `corpusFileIndex` means no exact candidate observation can be built. Documents the gap.
2. **Torrent-level cache result:** `checkcached` returns cached for a hash → valid `scope: 'torrent'` observation.
3. **Torrent-level cache miss:** Returns uncached → valid torrent-level `uncached` observation.
4. **Missing file identity:** Cache response with no file-level data → cannot produce file-level observation.
5. **Unknown/error response:** HTTP 503 batch failure → `state: 'unknown'`, `retryable: true`.
6. **Auth failure:** HTTP 401 → `state: 'error'`, `errorCategory: 'authentication'`.
7. **Stale/unusable shape:** An observation with past `expiresAt` → projection rejects as stale.

---

## 4. Gaps and unsafe assumptions

### 4.1 The fileIndex gap (fundamental)

**TorBox has no API to query cache state for a specific `(infoHash, fileIndex)` pair.** The `checkcached` endpoint is torrent-level. This means:

- A `cached` result for `infoHash` proves the **torrent** is cached, but does not prove any specific file is selectable/downloadable.
- An `uncached` result for `infoHash` proves the **torrent** is not cached (every file is unavailable).

**Unsafe assumption:** Treating a torrent-level `cached` result as authorization for a file-level candidate. This would violate the Slice 1A invariant and risk selecting a candidate whose specific file is not actually available.

**What additional mapping is required:** 
- Either a provider endpoint that reports per-file cache state, **or**
- A validated, tested rule that uses file inventory (from `mylist`) to confirm a specific file exists in a cached placement — but this still requires a provider-file-index → corpus-fileIndex mapping that does not exist.

### 4.2 The opaque provider file ID gap

`corpusFileIndex: null` is a deliberate, correct boundary. Inferring corpus file index from:
- File position in the `files[]` array
- File name/path matching
- Size matching

...is **unsafe** without a validated contract. Name collisions, multi-file releases, and packing variability make heuristic mapping unreliable.

**What cannot be represented:** A decision-ready file-level cache observation from TorBox alone, without either (a) a provider-native per-file cache query, or (b) an explicit, tested file mapping contract.

### 4.3 What CAN be decision-ready

- **Torrent-level candidates** (`fileIndex: null`): A torrent-level `cached` observation can authorize a torrent-level candidate through Slice 1A projection. This is the only TorBox-native path to a `projected` result.
- **Fallback signal:** A torrent-level `uncached` observation can contribute to file-level candidate unavailability **only** when combined with the Stage 4 decision logic (authoritative unavailability fallback), but this requires care — see Slice 1A: projection preserves it as a valid observation, and `decideAcquisition` handles the fallback semantics.

---

## 5. Exit status

- A documented TorBox-to-observation mapping exists.
- Fixtures show what can (torrent-level) and cannot (file-level) become decision-ready evidence.
- The fundamental gap is the absence of a provider-native per-file cache query.
- No live API calls, no acquisition integration, no provider polling, no Stage 3 changes.

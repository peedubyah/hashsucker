# S-1 — Data-plane control contract

The seam between durable north truth (Node) and motion (Rust). Landed in P2.

Rust owns **MOTION, not TRUTH**. It fetches this payload, then selects the
coordinate whose `size` equals the authoritative TorrentFile `size`
(`ControlResponse::target_file_id`). It never opens host SQLite, never
discovers or ranks providers, never substitutes a TorrentFile, and never
mutates identity.

## Endpoint

```
GET /api/data-plane/files/:tfId
```

TorrentFile ids are `tf_<uuid>`.

### 200

```json
{
  "schemaVersion": 1,
  "torrentFile": {
    "id": "tf_...",
    "infoHash": "<40 hex>",
    "canonicalInternalPath": "Movies/Foo/foo.mkv",
    "size": 1234567
  },
  "providers": [
    {
      "provider": "torbox",
      "accountScope": "default",
      "providerResourceId": "res_tb",
      "providerFileId": "111",
      "state": "ready",
      "canonicalInternalPath": "provider/internal/foo.mkv",
      "size": 1234567
    }
  ]
}
```

### 404

```json
{ "schemaVersion": 1,
  "error": { "code": "TORRENT_FILE_NOT_FOUND", "torrentFileId": "tf_..." } }
```

## Rules

**`schemaVersion` is stamped on every response, errors included.** The Rust
side rejects a missing or unsupported version before it looks at any other
field, so an unstamped error body is unreadable to it.

**404 means exactly one thing: "torrent file unknown to Node".** A known
TorrentFile with no usable coordinates returns **200 with an empty
`providers[]`**. Rust then reports *"zero provider coordinates"*, which is
accurate; returning 404 there would make the client lie to the operator.

**Unauthenticated**, matching the rest of `/api/control-plane/*`. These routes
sit on the internal network and the Rust client sends no credentials.

**`CONTROL_URL` must be the `/api` prefix.** The Rust client builds
`{controlUrl}/data-plane/files/{id}`, so:

```
CONTROL_URL=http://media-search:3000/api
```

## Field → source mapping

| Response field | Host source |
| --- | --- |
| `torrentFile.id` | `torrent_files.id` |
| `torrentFile.infoHash` | `torrent_files.info_hash` |
| `torrentFile.canonicalInternalPath` | `torrent_files.internal_path` |
| `torrentFile.size` | `torrent_files.size` |
| `providers[].provider` | `provider_placements.provider` |
| `providers[].accountScope` | `provider_placements.account_scope` |
| `providers[].providerResourceId` | `provider_placements.provider_resource_id` |
| `providers[].providerFileId` | `provider_files.provider_file_id` |
| `providers[].state` | `provider_placements.state` |
| `providers[].canonicalInternalPath` | `provider_files.path` |
| `providers[].size` | `provider_files.size` |

Read via `controlPlaneStore.getTorrentFile()` and
`controlPlaneStore.listDataPlaneCoordinates()`.

## Drop rules

A `provider_files` row is projected only when **all** hold. Each filter is
borrowed from north's own canonical resolution so S-1 cannot disagree with
the rest of the system:

| Filter | Precedent |
| --- | --- |
| `present = 1` | `resolveDeliveryCoordinates` |
| `mapping_state = 'mapped'` | `resolveDeliveryCoordinates` |
| `placements.state != 'removed'` | `findPlacementByInfoHash` |
| `size` is a positive safe integer | Rust requires `u64` |

The size filter is the only one without a north precedent. A NULL size can
never satisfy `target_file_id()`, and emitting `size: null` would fail Rust's
`ControlResponse` parse outright — killing the whole control fetch behind a
type error instead of an accurate "nothing to acquire". The drop happens in
the handler, visibly, not silently in SQL.

## Path namespaces — do not reconcile these

Two different namespaces share the field name `canonicalInternalPath`:

- **`torrentFile.canonicalInternalPath`** ← `torrent_files.internal_path`.
  Durable TorrentFile **identity**. Not a filesystem path in any namespace.
  Already canonicalized at write time by `canonicalizeInternalPath()`; it is
  **not** re-canonicalized on read, because re-canonicalizing would mutate
  durable identity to make a response prettier.
- **`providers[].canonicalInternalPath`** ← `provider_files.path`. The
  **provider internal** path: one provider's address for its own copy.

Neither is a host, container, or VFS path. If a Plex-visible path, VFS
logical path, or Windows/container path ever needs to agree with either one,
that is a diagnosed seam — not a normalization to apply here.

### What the field-name collision does and does not mean

The two namespaces are **independent**, not opposites. Their string values
may legitimately be equal. A test that asserts `assert.notEqual(torrentFile,
providers[0])` is wrong as a general invariant — it would pass any time the
data is, by accident, unequal, and fail any time the data is, by chance,
equal. The real invariants are:

- `torrentFile.canonicalInternalPath` is a one-way projection of
  `torrent_files.internal_path`.
- `providers[].canonicalInternalPath` is a one-way projection of
  `provider_files.path`.
- Neither field is derived from the other.
- Neither field is normalized into a host, container, VFS, or Plex path.
- Equal strings must not be assumed to mean identity.
- Unequal strings must not be assumed to mean distinct.

`docs/hy4/tests/s1-path-provenance.mjs` enforces these.

## Deliberately out of scope in P2

- **Provider ordering / ranking.** `ORDER BY` in the query is for
  deterministic output only. Ordering and selection policy is north's job and
  is a later seam; today every mapped coordinate is handed back.
- **Provider-agnostic by choice.** `resolveDeliveryCoordinates` hardcodes
  `torbox`, but the durable mapping is not TorBox-specific and the Rust plane
  can also serve Real-Debrid. Narrowing S-1 to TorBox would bake a delivery
  policy into the identity contract.
- **Multi-TorrentFile router, VFS wiring, provider-path deletion.** Later
  tranches. Not started.

---

## Byte error contract (P5)

P5 makes Rust the **only** byte-serving authority for any durable VFS entry
(`state.entry.torrentFileId != null`). The contract below is the narrow,
structured surface the Node VFS uses to **classify** a Rust failure instead of
guessing from a plain-text body or a truncated `206`. All error bodies are JSON
of the shape `{ "error": { "code": <CODE>, "torrent_file_id": <tfId> } }`.

A Rust failure maps to exactly one P5 class. The class dictates what Node may do:

| Code | HTTP | Class | Fallback-eligible? | Node behavior |
|------|------|-------|--------------------|---------------|
| `PROVIDER_EXHAUSTED` | 502 | **D** | ✅ YES | Switch to next persisted alternate `TorrentFile` and re-forward to Rust. |
| `S1_FETCH_FAILED` | 502 | **B** | ❌ NO | Identity / not-found / control unreachable. No blind fallback. |
| `INTERNAL_ERROR` | 500/502 | **C** | ❌ NO | Transient infra / explicit 5xx. **No legacy escape.** |
| *(any 416)* | 416 | **A** | ❌ NO | Client Range unsatisfiable. No fallback. |
| `DATA_PLANE_UNREACHABLE` | 502 | **C** | ❌ NO | Rust itself is down. Explicit failure; no legacy escape (re-forwarding would only hit the same dead plane). |

**The critical invariant:** `PROVIDER_EXHAUSTED` is produced **before any `206`
is committed**. Previously `get_file` wrote the `206` headers, then on provider
exhaustion simply ended the byte channel — the client saw a truncated/empty
`206`, indistinguishable from success. Now `acquire_for_read` runs *before* the
`206`, and exhaustion returns a clean typed `502` (see `serve.rs::data_plane_error`).

**Rust owns same-TorrentFile recovery.** `PROVIDER_EXHAUSTED` means "this
TorrentFile cannot be delivered by ANY Node-supplied provider, and no recovery is
in flight." Node's only fallback is to a *different* TorrentFile via the existing
persisted-candidate lifecycle (`findUsableAlternate` → `promoteAlternate` →
`materializeVfsEntry` → re-forward). It must **never** fall through to the legacy
Node provider byte path for a `tfId`-present entry.

**TEST-ONLY fault gate:** setting `HY4_FORCE_EXHAUST_TFID=tf_xxx,yyy` on the data
plane container forces `PROVIDER_EXHAUSTED` for the listed tfIds — a bounded,
reversible way to exercise class D. Never set in production.

Classifiers live in `media-search/src/lib/vfs/data-plane-forward.js`
(`classifyDataPlaneError`).


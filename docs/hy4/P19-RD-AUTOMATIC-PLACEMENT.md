# P19 — Real-Debrid automatic placement lifecycle closure

**Verdict: PROVEN.** A real Real-Debrid observation now becomes a durable
`ProviderPlacement` → `ProviderFile` → existing `TorrentFile` → S-1 coordinate
automatically, through the normal Node/control-plane materialization
lifecycle. The one-off `p13a-realize-rd-placement.js` operator script is no
longer required to publish an RD coordinate.

## The seam that was added

Three files, +80 lines, 0 deletions.

| File | Change |
| --- | --- |
| `media-search/src/lib/control-plane/rd-placement-realizer.js` | **new** — the realization module |
| `media-search/src/lib/vfs/materialize.js` | binds the realizer and offers every materialized TorrentFile to it |
| `media-search/src/providers/realdebrid/client.js` | bounded `listTorrents()` (one page, no pagination) |

The lifecycle seam is in `materialize.js`:

```
materializeVfsEntry(...)
  └─ finalize(entry, reason)
       ├─ tryActivateAuthoritativeBinding(...)   // existing, untouched
       └─ tryRealizeRdPlacement(store, torrentFile)   // P19, non-blocking
            └─ realizer.kickRealization(torrentFile)
                 └─ ensureRealization()  // single-flight per torrentFileId
                      └─ realizeForTorrentFile()
```

`tryRealizeRdPlacement` is strictly additive: it runs *after* the TorBox
binding write, never blocks materialization, and swallows every failure. When
`REALDEBRID_API_KEY` is unset the factory returns `null` and the whole path is
a no-op, so unconfigured deployments behave exactly as before.

### Identity rules (unchanged, enforced in `matchExactFile`)

A provider file is mapped to a `TorrentFile` **only** when both hold:

- `canonicalizeRdPath(root) + '/' + canonicalizeRdPath(file.path)` equals the
  TorrentFile's `internalPath`, **and**
- `Number(file.bytes)` equals the TorrentFile's `size` exactly.

Never by file index, never by filename alone, never by size alone. The RD
torrent's reported `hash` must also match the TorrentFile's `infoHash`
(`fetchVerifiedInfo`), so a TorrentFile can never be bound to a different
torrent.

### Bounded API work

- `knownResourceId()` resolves the RD id **durable-first** from
  `provider_placements`, so a repeat observation costs zero list calls.
- Only when no durable id exists does `discoverResourceId()` issue **one**
  `GET /torrents?limit=N` — no `offset`, no pagination loop, `N` capped at 5000.
- Then **one** `GET /torrents/info/{id}` for authoritative inventory.

Worst case per realization: **2 RD API calls.**

## Proof environment

- Frozen specimen: `tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`
  - infoHash `06bfe49fdc99ad0c6fef1f761382a8181490e456`
  - size `34319716114`
  - canonicalInternalPath
    `Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie/Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie.mkv`
- Proof ran against a **throwaway copy** of the control-plane DB
  (`VACUUM INTO` from the authoritative DB, opened read-only). The
  authoritative P13A RD placement in the live DB was **not** deleted or
  mutated.
- On the throwaway, only the specimen's RD state was removed:
  1 `provider_placements` row, 1 `provider_files` row, 1
  `provider_inventory_snapshots` row. The `TorrentFile` identity row and the
  TorBox placement were preserved (`torrent_files` 65 → 65).
- RD API calls were counted by wrapping `globalThis.fetch` before the
  realizer constructed its client. No code in the path was modified.

## Run 1 — first automatic materialization

Driven through the production seam, **not** the P13A script:

```
materializeVfsEntry(cache, handoff, store, () => NOW, { allowLegacy: false })
```

| | before | after |
| --- | --- | --- |
| `torrent_files` | 65 | **65** (reused, not duplicated) |
| `provider_placements` | 37 | **38** (+1 realdebrid) |
| `provider_files` | 149 | **150** (+1) |
| RD placements for specimen | 0 | **1** |

VFS entry: `Movies/Black Panther (2018)/Black Panther (2018).mkv` →
`tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`.

**Real-Debrid API calls: 2**

1. `GET https://api.real-debrid.com/rest/1.0/torrents?limit=100`
2. `GET https://api.real-debrid.com/rest/1.0/torrents/info/5VFSK7HKPITZW`

Realization settled in **654 ms** in the background (both calls happen after
`materializeVfsEntry` returns — materialization itself is not delayed).

Created `ProviderPlacement`:

| field | value |
| --- | --- |
| id | `pl_cf27dd76-9e98-4205-808d-6b48d4ed20fa` |
| provider | `realdebrid` |
| providerResourceId | `5VFSK7HKPITZW` |
| state | `ready` (RD status `downloaded`) |
| ownership | `external` (we did not place it) |
| provenance | `rd-placement-realizer` |
| observedAt / expiresAt | `1788667450398` / `1788667750398` |

Created `ProviderFile`:

| field | value |
| --- | --- |
| id | `pf_b939433f-13c4-44f1-826e-da1b7ed11c75` |
| providerFileId | `1` |
| size | `34319716114` |
| present / mappingState | `1` / `mapped` |
| **torrentFileId** | **`tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`** (existing row reused) |
| evidence | `matchedBy: exact-path-and-exact-size`, `rdOriginalBytes: 34628717638`, `rdBytes: 34319716114` |

**S-1 result: `["realdebrid", "torbox"]`** — both providers exposed for one
TorrentFile. (Ordering is alphabetical per `store.js:1107`
`ORDER BY pl.provider, pl.account_scope, pf.provider_file_id`; left as-is.)

## Run 2 — idempotent repeat (fresh process)

Same throwaway DB, same automatic materialization, new process.

| | before | after | unchanged |
| --- | --- | --- | --- |
| `torrent_files` | 65 | 65 | yes |
| `provider_placements` | 38 | 38 | yes |
| `provider_files` | 150 | 150 | yes |

- Placement id reused: `pl_cf27dd76-9e98-4205-808d-6b48d4ed20fa`
- Provider file id reused: `pf_b939433f-13c4-44f1-826e-da1b7ed11c75` / `1`
- TorrentFile identity unchanged (infoHash, internalPath, size all identical)
- **Real-Debrid API calls: 0** — the durable coordinate was resolved
  first and `hasFreshCoordinate()` short-circuited the realization
- S-1 still `["realdebrid", "torbox"]`

## Restart durability

A **new** Node process (fresh PID, no in-memory state) was started against the
proof DB with `CONTROL_PLANE_DB=/tmp/p19/control-plane.db`,
`DISCOVERY_DB=/tmp/p19/discovery.db`, `PORT=3999`, then S-1 was read over HTTP:

```
GET /api/data-plane/files/tf_5de34a78-0a1a-410b-8de5-76ded2680e7d
```

```json
{
  "schemaVersion": 1,
  "torrentFile": { "id": "tf_5de34a78-…", "infoHash": "06bfe49f…", "size": 34319716114 },
  "providers": [
    { "provider": "realdebrid", "providerResourceId": "5VFSK7HKPITZW", "providerFileId": "1",
      "state": "ready", "size": 34319716114 },
    { "provider": "torbox", "providerResourceId": "88408468", "providerFileId": "1",
      "state": "ready", "size": 34319716114 }
  ]
}
```

The mapping survives process restart and S-1 still returns `realdebrid`.

## Total Real-Debrid API cost for the whole proof: 2 calls

Run 1 = 2, Run 2 = 0, restart = 0.

## TorBox path unchanged

No TorBox code was touched. The TorBox placement
(`pl_a5e7d71d-901f-411b-b6f4-ede1127cf589`, resource `88408468`) and its
provider file were preserved throughout and still appear in S-1.

## Observation (pre-existing, not introduced by P19)

Both runs log
`[vfs] binding write: activateBinding failed: Binding requires an authoritative exact file mapping`.

This is **not** a P19 defect and does not affect the P19 chain. The binding is
attempted against the *TorBox* coordinate supplied in the handoff, and that
coordinate's inventory is stale: `inventory_observed_at 1788560054669`,
`inventory_expires_at 1788560114669` (expired 2026-09-02), so
`activateBinding` fails closed by design (`store.js:1338`). P19 adds 80
insertions and 0 deletions and touches neither `activateBinding` nor
`store.js`. The RD realization runs after the binding attempt and is
unaffected — S-1 exposes both providers regardless.

## Out of scope (deferred)

- The 13 pre-existing `EBUSY` test failures (Windows SQLite file locking in
  `rmSync` teardown) — unrelated to P19; the P19 diff is 80 insertions / 0
  deletions and the new path is a no-op without `REALDEBRID_API_KEY`.
- The latent CRLF hazard in `scripts/*.sh`, `hy4-data-plane/src/*.rs`,
  `bench/*.mjs`, `docs/*.md` — belongs to the hard-clean/merge pass.
- The 90 untracked `hy4-data-plane/bench/**` artifacts.

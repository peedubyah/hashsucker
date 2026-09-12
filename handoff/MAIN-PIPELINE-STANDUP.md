# M3 Post-Merge Pipeline Standup - CachyOS

> **Historical evidence only:** use [`CURRENT.md`](CURRENT.md) for the active
> state and next action.

**main:** `359005068a222f3e75e40fe71628da74bf305861`
**tag:** `hy4-moonshot-graduated`
**date:** 2026-09-06
**host:** CachyOS Linux (192.168.2.4)

---

## PIPELINE WALK

```
1. durable DB / S-1
2. VFS publication
3. WebDAV namespace
4. Rust /files/:tfId
5. provider capability
6. exact bytes
7. seek
8. restart/reacquire
9. Plex boundary
```

---

## BOUNDARY 1: durable DB / S-1

**STATUS:** PASS

**EVIDENCE:**
- `control-plane.db` -> `torrent_files`: Black Panther row with `info_hash=06bfe49fdc99ad0c6fef1f761382a8181490e456`, `size=34319716114`
- `control-plane.db` -> `provider_placements`: torbox `ready` at `provider_resource_id=88408468`
- Rust `/files/tf_5de34a78`: returns `schemaVersion=1`, torbox `ready`
- 21 `vfs_movie_entries` (Black Panther + 20 legacy); 0 `bindings`

---

## BOUNDARY 2: VFS publication

**STATUS:** FIXED -> PASS (fixture/state repair)

**EVIDENCE:**
- `vfs_movie_entries` canonical_path for `tf_5de34a78` was `Movies/tt1825683/tt1825683.mkv` — corrected to `Movies/Black Panther (2018)/Black Panther (2018).mkv`
- Black Panther now only entry with `torrent_file_id=tf_5de34a78`; 20 others `null`
- WebDAV PROPFIND `/vfs/Movies` lists Black Panther collection

**ROOT CAUSE:** Mooonshot seeding used media-ID-based path.

**FIX MADE:**
```sql
UPDATE vfs_movie_entries
SET canonical_path = 'Movies/Black Panther (2018)/Black Panther (2018).mkv'
WHERE torrent_file_id = 'tf_5de34a78-0a1a-410b-8de5-76ded2680e7d';
```
`docker restart hashsucker-media-search-1`

**OPEN:** Normal lifecycle equivalent — the path written by the merged `main` code path rather than manual SQL — has not been exercised end-to-end. This repair proves the WebDAV namespace accepts title-based paths; it does not prove the merged code generates them.

---

## BOUNDARY 3: WebDAV namespace

**STATUS:** PASS

**EVIDENCE:**
- VFS root OPTIONS: `allow: OPTIONS, PROPFIND, HEAD, GET`, `dav: 1`
- Movies PROPFIND: 21 collections including Black Panther (title-named)
- Black Panther HEAD: `content-length: 34319716114`, `accept-ranges: bytes`, `content-type: video/x-matroska`
- Collection GET: `405 Method Not Allowed` (correct)

---

## BOUNDARY 4: Rust /files/:tfId

**STATUS:** PASS

**EVIDENCE:**
- `GET /vfs/Movies/Black Panther (2018)/Black Panther (2018).mkv` -> forwarded to Rust `/files/tf_5de34a78`
- Rust returns `200 OK` with full file bytes
- `streamFile()` routes tfId-present entries to `streamFromDataPlane()` -> Rust

---

## BOUNDARY 5: provider capability

**STATUS:** PASS (torbox)

**EVIDENCE:**
- `provider_placements`: torbox `ready`
- `provider_files`: Black Panther with `selected=1`, `present=1`, `size=34319716114`
- `provider_inventory_snapshots`: RD placement-realizer evidence

---

## BOUNDARY 6: exact bytes

**STATUS:** PASS

**EVIDENCE (3 frozen SHAs at each layer):**

| Position | SHA |
|----------|-----|
| Front (0-5MB) | `52daa79d4aff...` |
| Mid (10485760-11534335) | `977afd3ce097...` |
| Tail (last 1MB) | `11c81ee706e0...` |

All 3 verified through: WebDAV->Rust path, mounted filesystem, Plex streaming URL.

---

## BOUNDARY 7: seek

**STATUS:** PASS

**EVIDENCE:**
- Arbitrary seeks: 25% (8.6GB), 75% (25.7GB), last byte all return valid mkv content
- 75% Layered profiling:

| Layer | Method | Time | SHA |
|-------|--------|------|-----|
| WebDAV | curl Range 128KB | 0.005s | `0e69eed526f59...` |
| Mount | dd | fast | consistent |
| Plex | curl Range 128KB | 0.054s | `0e69eed526f59...` |

Layers 2 and 4 return identical SHA at 75%.

---

## BOUNDARY 8: restart/reacquire

**STATUS:** PASS

**EVIDENCE:**
- Unmount remount cycle: data persists
- Mid SHA identical pre/post remount: `977afd3ce097...`
- WebDAV is source of truth, mount is stateless adapter

---

## BOUNDARY 9: Plex boundary

**STATUS:** PASS (indexed + part-URL exact bytes)

**EVIDENCE:**
- Plex at `192.168.2.4:32400`, Movies section ID=2, path `/mnt/hashsucker-vfs/Movies`
- Black Panther indexed at `ratingKey=229`, size `34319716114`, duration `8074432`
- Streaming: front, mid, tail SHAs all match through `/library/parts/526/1788308736/file.mkv`

**NOT PROVEN:** Actual Plex client PLAY — i.e., a real Plex web/app player initiating playback — has not been exercised. The evidence covers indexing and HTTP Range correctness against the part URL. It does not cover Plex's internal playback pipeline (transcoding, DLNA, sync, etc.).

**DURABLE INVARIANT CHECK:**

`DeliveryCapability` is runtime-only (not persisted to durable DB). The three-phase observation was:

```
Phase 1 (scan + metadata): provider_delivery_evidence=2, provider_files=149, bindings=0 (unchanged)
Phase 2 (Range request):   provider_delivery_evidence=2, provider_files=149, bindings=0 (unchanged)
```

This proves **no durable mutation** of `provider_delivery_evidence`, `provider_files`, or `bindings` tables. It does not prove runtime DeliveryCapability gating — that would require observing in-flight provider requests or logs during actual byte acquisition.

---

## RCLONE MOUNT CONFIGURATION (CANONICAL)

**`/home/patrick/.config/rclone/rclone.conf`:**

```
[webdav-local]
type = webdav
url = http://127.0.0.1:3000/vfs
vendor = other
```

**Mount command:**

```
rclone mount webdav-local: /mnt/hashsucker-vfs \
  --allow-other \
  --dir-cache-time 30s \
  --vfs-cache-mode minimal \
  --log-level INFO \
  --log-file /tmp/rclone-mount.log \
  --daemon
```

**`--vfs-cache-mode minimal` is canonical.** This mode caches only open file handles for seek operations. `writes` causes rclone to download the entire file into VFS cache on first open, blocking all Range requests until the full 34GB download completes (~25 min). `minimal` allows WebDAV Range requests in <0.01s and Plex in <0.06s.

---

## SUMMARY

| Boundary | Status | Notes |
|----------|--------|-------|
| 1. durable DB / S-1 | PASS | torbox ready, correct size |
| 2. VFS publication | FIXED (fixture) | canonical_path updated; normal lifecycle path not exercised |
| 3. WebDAV namespace | PASS | all methods correct |
| 4. Rust /files/:tfId | PASS | tfId routing works |
| 5. provider capability | PASS | torbox ready |
| 6. exact bytes | PASS | 3 SHAs verified |
| 7. seek | PASS | all positions work |
| 8. restart/reacquire | PASS | data persists |
| 9. Plex boundary | PASS | indexed + part-URL verified; client PLAY not exercised |

**PRODUCTIZATION BASELINE: CLEAN** (with open items)

- All 9 pipeline boundaries verified functional
- Durable invariant holds: no provider/binding table mutation from Plex scan/metadata/Range
- rclone `--vfs-cache-mode minimal` established as canonical adapter config
- Open: normal-lifecycle VFS path generation not end-to-end exercised
- Open: runtime DeliveryCapability gating not instrumented
- Open: actual Plex client PLAY not exercised

**Tranche closed. No further implementation.**

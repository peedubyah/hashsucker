# P18 — Bounded VFS Alternative Exploration

**Verdict: KEEP NODE WEBDAV.**

No prototype was built, because no alternative survived the §4/§5 feasibility
audit. This was a source-level rejection, not a preference.

---

## 1. Baseline frozen

Authoritative Plex-facing path as it exists today:

```
Plex-visible namespace
  -> Node movie/tv WebDAV            (/vfs/Movies/... , /vfs/TV/...)
  -> tfId-bearing VFS entry          (vfs_movie_entries.torrent_file_id)
  -> Rust /files/:tfId               (http://hy4-data-plane:3001)
  -> provider / cache
```

Ownership (unchanged, still frozen):

| | owns |
|---|---|
| **Node** | publication, namespace, PROPFIND/HEAD metadata, canonical path, durable identity |
| **Rust** | modern tfId byte serving, Range, cache, provider execution |

### Live confirmation (one known modern movie, end to end)

```
PROPFIND /vfs/                 -> 207   Movies + TV present
PROPFIND /vfs/Movies/          -> 207   22 entries, 21 collections
PROPFIND <dir>                 -> 207   1 file
PROPFIND <file> Depth 0        -> 207
    getcontentlength  = 11960682744
    getetag           = "09a21427fbd8f22039fe2bed9eb53f8d68215ec3:0-11960682744"
    getcontenttype    = video/x-matroska
    getlastmodified   = Sun, 30 Aug 2026 19:56:50 GMT
    resourcetype      = (file)
HEAD                           -> 200   content-length 11960682744, accept-ranges: bytes
GET bytes=0-1048575            -> 206   1048576 B   sha256[0:12] b80322e4d3bd
GET bytes=11959634168-...      -> 206   1048576 B   sha256[0:12] c766d56684fc   (far seek)
GET bytes=0-1048575 (repeat)   -> 206   sha b80322e4d3bd  stable=true
GET bytes=<size+100>-...       -> 416   content-range: bytes */11960682744
```

Path:
`/vfs/Movies/Batman Knightfall Part 1 Knightfall (2026)/Batman Knightfall Part 1 Knightfall (2026).mkv`

**Restart:** after restarting media-search (the presentation layer), the same
path, same size, same ETAG, and both range SHAs were reproduced exactly.

---

## 2. The actual problem explored

Not "a cooler filesystem", but: *is there a simpler or more robust Plex-facing
presentation layer that preserves all current byte-plane and durable-identity
guarantees?*

Judged only against path stability, directory enumeration, stat/getattr,
open/read/seek, restart behaviour, deployment simplicity, Plex suitability, and
amount of new code/state.

---

## 3. Candidate set (kept tiny)

- **A. Current Node WebDAV** — baseline.
- **B1. Thin native/FUSE-style adapter** — **dismissed immediately, without
  implementation.** A FUSE surface requires either a privileged container
  (`--device /dev/fuse` + `CAP_SYS_ADMIN`) or a Windows host driver
  (WinFsp/Dokan). Both are new *host* dependencies, i.e. strictly worse on
  "deployment simplicity", and P18 §9 forbids touching mounts/host topology.
- **B2. Thin Rust WebDAV surface** — the single most plausible alternative;
  carried through the full feasibility audit.

---

## 4. Feasibility findings (source-level)

### What Node currently synthesizes

`movie-webdav.js:248-254`:

```js
function metadataFromState(state) {
  return {
    size: state.entry.size,
    modifiedAt: state.handoff.selectedAt,
    etag: `"${state.entry.releaseKey}-${state.entry.size}"`,
  };
}
```

So a file's PROPFIND size comes from `vfs_movie_entries`, and its **mtime comes
from `playback_handoffs.selectedAt`** — Node's playback-handoff state, not
publication state. `getCatalog()` (`:274-300`) enumerates via
`searchCache.listVfsMovieEntries()` / `getPlaybackHandoffByReleaseKey()` and
throws `HANDOFF_MISSING` 503 if the handoff row is absent.

### What Rust would have to reproduce

1. Namespace `/vfs/Movies/<Title (Year)>/<Title (Year).mkv`, built from
   `canonical_path` (`control-plane/canonical-path.js:7-28`).
2. PROPFIND multistatus XML: `resourcetype`, `getcontentlength`,
   `getcontenttype`, `getetag`, `getlastmodified`, `creationdate`,
   `displayname`, plus Depth handling and synthetic collection metadata
   (`:1202-1210`).
3. `size` from `vfs_movie_entries` **and** `modifiedAt` from `playback_handoffs`.
4. Handoff validation and its 503 semantics.
5. The same again for TV.

### What Rust does not own — and cannot reach

Rust's route table is exactly two routes (`main.rs:357-360`):
`/files/:tfId` and `/metrics`. `main.rs:23-24` states the rule explicitly:

> * Open host SQLite. The north (media-search) is the only thing that
>   opens the durable DBs. Rust reads only what S-1 projects.

Verified empirically, not just by reading:

```
hy4-data-plane container:  /data -> cache/ only; find / -name "*.db" -> (none)
media-search container:    /data/control-plane.db     (565 KB)
                           /data/discovery-cache.db  (1.79 GB)
```

The data-plane container mounts only the named `hy4-cache` volume. It has **no
access to either durable DB**.

### The decisive negative

A thin Rust WebDAV has exactly three possible designs, and all three fail:

| design | why it fails |
|---|---|
| Rust opens the durable DBs directly | needs a new host bind mount into the data-plane container (new host dependency) **and** puts a second process on Node's SQLite — duplicated publication authority. §4 calls this a major negative. |
| Node exposes a new namespace API; Rust proxies PROPFIND | adds a service hop on every listing/stat, a new API + config surface, and a second source of metadata truth. Strictly *more* moving parts, not fewer. |
| Duplicate the publication index into Rust | explicitly forbidden by §5. |

**Compounding factor:** the presentation layer is *not* read-only.
`getCatalog()` calls `materializeVfsEntry()` for every handoff on **every**
request (`movie-webdav.js:275-277`), which writes `vfs_movie_entries.size` and
records terminal evidence. Moving this to Rust would move **write authority
over Node's publication truth** — the "duplicated authority" failure mode.

---

## 5. No-new-durable-state test → REJECT

Per §5, the alternative must consume existing durable truth, and must not
introduce a second VFS database, duplicated publication index, persisted path
map, persisted DeliveryCapability, or provider-specific mount state.

Every viable design for B2 requires at least one of those, or a new host
dependency. **Therefore B2 is rejected and no prototype was built** (§6 only
requires prototyping if an alternative survives the audit).

---

## 6. Comparison

| criterion | Node WebDAV (baseline) | thin Rust WebDAV |
|---|---|---|
| namespace fidelity | proven: exact path, size, ETAG stable across restart | must be re-derived; `canonical_path` reconstructed in a second language → path-drift risk |
| read semantics | first read / far seek / repeat / 416 all correct | inherits Rust byte plane (already good) — no gain |
| restart | proven identical path, size, ETAG, SHAs after restart | unknown; would add enumeration/metadata cache staleness |
| services | 2 | 2, **plus** either a new Node API or a new DB mount into the Rust container |
| mounts | 1 host bind + 1 named volume | **+1** host bind of the discovery dir into the data-plane container |
| persistent state | 2 DBs, single writer (Node) | same 2 DBs, **two** readers/writers → duplicated authority |
| host dependencies | none (plain HTTP WebDAV) | FUSE needs privileged container/host driver; Rust DAV needs DB bind |
| new code | — | full PROPFIND engine + stat synthesis + materialization + TV, in a language that currently has **zero** WebDAV/FUSE code (no `*.rs` in the repo matches webdav/PROPFIND/fuse) |

### Failure modes

| | Node WebDAV | Rust WebDAV |
|---|---|---|
| stale handle risk | low — `states` Map rebuilt per request | new — any enumeration cache in Rust goes stale |
| metadata cache risk | low | high — Rust's mtime source (`playback_handoffs`) is a table it does not own |
| path drift risk | none (single canonical-path builder) | real — second implementation of the path builder |
| duplicated authority risk | none | **high** — two processes on the same publication truth |

---

## 7. Decision threshold not met

Baseline imperfections found, all minor and none a real defect:

- `movie-webdav.js` / `tv-webdav.js` are near-duplicates (1270 vs 1294 lines,
  ~2/3 byte-identical; rate-limit gating, delivery seam, PROPFIND synthesis,
  Rust forwarding and persisted-alternate fallback duplicated verbatim).
- Collection mtime = global max `selectedAt` (`:1206`) — one new title
  re-stamps every directory. Harmless.
- `content-type` hardcoded `video/x-matroska` for all files.
- In-process rate-limit gates lost on restart (self-healing).

§8: "A small code-style improvement is not enough." None of these is a defect
an alternative would eliminate, so the threshold is not met.

**Result: roughly equivalent at best, materially worse on deployment and
authority. → KEEP NODE WEBDAV.**

---

## 8. Code kept / removed

- **Kept:** nothing changed. No production code was modified.
- **Removed:** no prototype code existed to remove (rejected before
  implementation, per §11 — no half-supported second VFS left in the branch).
- Cleanup: orphaned `/data/cache-p17` from P17 removed from the cache volume.
- Diagnostic probe lives outside the repo (`Documents/WorkBuddy/`), not committed.

---

## 9. Scope guard

No changes to CachyOS, Plex, Windows firewall, Tailscale, SSH tunnels, rclone,
`/mnt`, Docker bind addresses, discovery/ranking, RD placement lifecycle,
provider execution, the TTFB path, or prefetch. No merge of main. No new
branch, no stash, no force push.

---

## 10. Recommendation for P19

Do **not** revisit the presentation layer — P18 found no defect to fix and no
simpler surface. The one worthwhile repo-local cleanup this tranche surfaced
(and which was deliberately out of scope here) is **de-duplicating
`movie-webdav.js` and `tv-webdav.js`**: ~2/3 of ~1280 lines are byte-identical,
including the delivery seam and the persisted-alternate fallback, so a shared
core would remove real duplicated-authority risk without changing the surface.

Other candidates for P19, in preference order:
1. VFS movie/TV de-duplication into a shared presentation core (no behaviour change).
2. Fix the minor `content-type` and collection-mtime synthesis while that code is being unified.
3. RD provider lifecycle work — **not started here**, per instruction.

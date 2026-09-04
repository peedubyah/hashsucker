# Zurg v1.0.0 (closed-source, RE'd) — the production WebDAV analogue

**Subject binary:** `ghcr.io/debridmediamanager/zurg-testing:latest` (linux/amd64)
**Binary SHA-256:** `0f24371c66162583cbd0793e69b66d29f121c615ebb5e17e884f7fdf0ca51908`
**Image index digest:** `sha256:9bde9836ea1e8495f0d7d892e3923ec72c6b6bb224d2e0755c9a84a09d21be17`
**Go module:** `github.com/debridmediamanager/zurg v1.0.0`, built with `go1.26.5`, full DWARF
**Corpus:** 22 markdown files, ~450 KB, at
`C:\Users\patri\Documents\WorkBuddy\research\plex-vfs-forensics\zurg-re\CORPUS\`
**Authoritative entry point:** `17-FINAL-AUDIT.md` (disproves or weakens **nine** first-pass claims)
**Suggested reading order:** `00` → `07` → `08` → `10` → `16` → **`17`** → `14` → `15`

> ### ⚠️ SCOPE LIMITATION — read this before quoting anything below
> **Backend scope: Real-Debrid only.** The string `torbox` occurs **zero** times in the binary
> (`00-PROVENANCE.md` §4). The sponsor nightly that would have carried TorBox is 401/404
> (`01-NIGHTLY-PROBE.md`). Every claim in this document is therefore
> **`PROVEN (RD-ONLY)`** unless marked otherwise. **Do not generalize any statement about provider
> file IDs, links, or delivery semantics to TorBox.**

---

## 0. Why this document exists

Zurg is the only reference in this corpus that is (a) a **WebDAV** server rather than FUSE, and
(b) running in production against **Real-Debrid** — the same two constraints HashSucker has. Every
other reference is either single-provider TorBox (lazarr, warpbox, torrg) or not a filesystem at
all (plex-strm-proxy, stremiarr).

It is also a **negative reference in part**. The corpus's central verdict is:

> **Build-vs-delegate: (A) Keep HashSucker's VFS, adopt Zurg's semantics.**
> **Language change required? No.**

So: do not reimplement Zurg. **Take its semantics; keep our implementation.**

---

## 1. The four identity layers that are never merged

Zurg keeps four identity layers, and critically **never concatenates them into one token**:

| Layer | Type | Produced by | Consumed by | Survives restart? |
|---|---|---|---|---|
| **L1 — provider file ID** | `int` | `TorrentInfo.Files[].ID` | **nothing live** — `GetFileByID` / `extractLinkForFile` are **dead code, zero callers** | YES (JSON in `.zurgtorrent`) |
| **L2 — provider file path** | `string` | `TorrentInfo.Files[].Path` | `filepath.Base` → visible name; RAR volume grouping | YES |
| **L3 — visible filename** | `string` | `GetFilename(f)` = `f.Rename` ‖ `Base(f.Path)` | `SelectedFiles` map key, DAV `href`, Plex | YES (via `Rename` or recomputed) |
| **L4 — delivery link** | `string` | `UnrestrictFile` | HTTP 302 / stream proxy | **NO** — re-derived on demand |

### 1.1 The corpus's own self-correction (read this first)

Earlier revisions of `07-IDENTITY.md` claimed "Zurg's authoritative per-file identity is the
provider-assigned integer file ID." **The corpus retracted that.** Three independent disproofs:

1. **No live reader.** `GetFileByID` (`torrent_types.go:292`) and `extractLinkForFile` have
   **zero callers**. A field no live code reads as a key is not the live identity.
2. **It changes for an unchanged logical file.** `mergeTorrents` (`refresh.go:641–648`) has an
   explicit branch for `existing.ID != toMerge.ID`, logs it, and on the healthy-replacement path
   **overwrites the object wholesale**. A durable identity cannot be silently replaced.
3. **It is legitimately `0`.** The repair fallback synthesizes a fully-published, DAV-visible
   `File` with `ID = 0` (`assign_links.go:96`), `Set`s it into `SelectedFiles` at `:105` and
   persists at `:110`.

The defensible statement:

> **`File.ID` is a persisted provider-native identifier — provider provenance, not live filesystem
> identity.**

The live identity is **L3, the visible filename** — the `SelectedFiles` map key.

### 1.2 What this means for HashSucker's invariants

**This is I1/I2/I3 confirmed by an independent production system.** HashSucker's ontology
(Release = infoHash; TorrentFile = release + canonicalInternalPath + exact positive size) is
*stricter* than Zurg's, and the stricter version is the one that survives.

But note the **gap, which is itself the finding**: Zurg's designers *modelled* the provider ID as
the identity (they wrote ID-keyed helpers), and the shipped code does not route live lookups
through that model. That gap is exactly what makes Zurg **tolerant of collisions** — two files
with one `ID` do not crash it.

> **Not a recommendation to weaken HashSucker's identity gate.** It is evidence that Zurg's gate is
> *stricter* at the delivery seam, and *looser* in the live map, and that the looseness is a
> tolerance mechanism rather than a design goal.

---

## 2. The DAV surface — zero provider calls on every listing path

### 2.1 Every DAV entry point returns fully-rendered bytes

```go
func ServeRootDirectoryForDav(torMgr *torrent.TorrentManager) ([]uint8, error)
func ServeGroupDirectoryForDav(directory string, torMgr *torrent.TorrentManager) ([]uint8, error)
func ServeTorrentFilesForDav(directory string, tor *torrent.Torrent, torMgr *torrent.TorrentManager,
                             shouldHideBrokenTorrents bool) ([]uint8, error)
func HandleSingleFile(directory string, torrentName string, filename string,
                      torMgr *torrent.TorrentManager, req *net/http.Request) ([]uint8, error)
func pkg/dav.File(path string, fileSize int64, added string) string
func pkg/dav.Directory(path string, added string) string
```

> **`PROVEN`:** every DAV entry point returns `([]byte, error)` — a fully-rendered byte slice.
> Nothing in the DAV layer returns a live stream or a lazy handle. **PROPFIND is a pure
> render-from-model operation.**

### 2.2 The complete call-target census for `ServeTorrentFilesForDav`

```
   5  bytes.(*Buffer).*
   4  internal/torrent.(*TorrentManager).*   (GetKey x2, GetFilename x1, ...)
   2  path/filepath.join
   2  pkg/fsm.(*FSMWithExternalMutex).Is
   2  pkg/dav.Directory
   2  internal/rarstream.VolumeKey
   2  internal/dav.addSlash
   1  strings.ToLower
   1  sort.Strings
   1  runtime.rand
   1  concurrent-map/v2.ConcurrentMap[...].Keys
   1  concurrent-map/v2.ConcurrentMap[...].Get
   1  pkg/dav.File
   1  runtime.mapaccess2_faststr
   1  runtime.mapassign_faststr
   1  sync.runtime_SemacquireRWMutexR
   1  runtime.panicBounds          (buffer.go:60 — bounds check only)
```

> **`PROVEN`:** there is **no logging call, no error construction, and no panic path** anywhere in
> `ServeTorrentFilesForDav`. The only `panic`-family reference is `runtime.panicBounds` from an
> inlined `bytes.Buffer` bounds check. **The function cannot propagate a per-file failure.**
>
> **`PROVEN`: zero provider API calls.** No HTTP client, no `UnrestrictFile`, no `DownloadMap`
> access on the listing path.

### 2.3 Four `continue` branches where HashSucker has zero

All four rejection branches jump to the **same** address `0xb00c47`, the loop-increment block:

```
dav.go:79   JMP  0xb00c47      ; SelectedFiles.Get miss
dav.go:82   JMP  0xb00c47      ; state == "deleted_file"
dav.go:85   JMP  0xb00c47      ; state == "broken_file"
dav.go:98   JMP  0xb00c47      ; RAR volume key unresolved
dav.go:101  JMP  0xb00c47      ; duplicate name already emitted
dav.go:105  JMP  0xb00c47      ; directory emitted
```

> **`PROVEN`:** a file that cannot be resolved, is marked `deleted_file`, is marked `broken_file`,
> or whose RAR volume key does not resolve is **silently omitted from the listing**. The loop
> continues. The remaining N-1 files are still emitted into the same `<d:multistatus>` response.

**Contrast — HashSucker (`PROVEN` from workspace source):** `media-search/src/lib/vfs/tv-webdav.js`,
`getCatalog()` iterates `searchCache.listTvPlaybackHandoffs()` and calls
`materializeVfsEntry(...)` **with no try/catch around the loop body**. A single throwing
materialization aborts `getCatalog()`, so no sibling episode is ever listed and no later episode
can bind or hydrate.

**Why Zurg can afford this — the structural reason, not the syntactic one:** a broken file is
*already modelled* (`File.State` is an `FSMWithExternalMutex` with states `ok_file` / `broken_file`
/ `deleted_file`). The broken state is set by
`transitionToBroken(torrent, reason, unrepairableReason)` in `assignLinks`, **long before any
PROPFIND arrives**.

> **The listing path never has to discover a failure; it only has to read a state that was written
> earlier.** That is the architectural difference — not merely the presence of a `continue`.

---

## 3. Size before exposure — a structural property, not a check

### 3.1 `getcontentlength` is `f.Bytes`, read straight off the model

```go
func pkg/dav.File(path string, fileSize int64, added string) string
```

Call site `dav.go:107`:

```
dav.go:107  0xb00fbf  MOVQ 0x18(DX), CX      ; CX = f.Bytes      (File offset 24)
dav.go:107  0xb00fc3  MOVQ 0x38(DX), DI      ; DI = f.Ended.ptr  (File offset 56)
dav.go:107  0xb00fd8  CALL pkg/dav.File(SB)
```

> **`PROVEN`:** `pkg/dav.File(name, f.Bytes, f.Ended)`.
> `fileSize` is **`f.Bytes`**, the `int64` at `torrent.File` offset 24 — populated from the
> provider's `TorrentInfo.Files[].Bytes` during `convertToTorrent` (`refresh.go:404–569`).

### 3.2 Why a zero-byte file cannot be published

```
--- github.com/debridmediamanager/zurg/internal/realdebrid.File (size=40)
    ID        int     @ 0
    Path      string  @ 8
    Bytes     int64   @ 24
    Selected  int     @ 32
```

Size is **not** fetched during listing, and **not** fetched lazily. It arrives **with the
torrent-info refresh, in the same response that carries the file list**.

> **`PROVEN`:** "size before exposure" is not a check Zurg performs — it is a **structural
> consequence** of building the file record from a provider response that already contains the
> size. **There is no ordering bug to fix because there is no second fetch to order.**

**Contrast — HashSucker (`PROVEN` from workspace source):**
- `media-search/src/lib/vfs/materialize.js` creates the row with `size: null`.
- `media-search/src/lib/discovery/cache.js` schema has `size INTEGER` — **nullable**.
- `tv-webdav.js` PROPFIND reads `getDurableMetadata(entry.state)` → `metadataFromState(state)`
  returning `size: state.entry.size`, which may be `null`.
- `hydrateVfsTvEntry` / `ensureMetadata` exist as the mitigation, but **the virtual path is already
  visible before they run** — so Plex sees a zero-byte file and skips it.

> **This is I3 ("exact positive size") stated as a structural guarantee rather than a validation
> rule.** HashSucker's nullable `size` column is a schema-level violation of the invariant.

### 3.3 `getlastmodified` is `f.Ended`, the provider completion time

`pkg/dav.File`'s third argument is `f.Ended` (`torrent.File` offset 56). The DAV
`getlastmodified` therefore reflects the **provider's completion timestamp**, not mount time.

> **`STRONG INFERENCE`:** deliberate — it gives Plex a **stable, restart-invariant mtime**, so a
> Zurg restart does not change any file's timestamp and does not invalidate Plex's scanner cache.

Compare lazarr (§`05` §2.2), where every file reports **1970-01-01** because timestamps are simply
never set. Zurg's answer is the right one, and it costs nothing: the provider already told you
when the file finished.

---

## 4. M26 — The delivery-URL cache, and the real anti-burst mechanism

### 4.1 `DownloadMap`

```go
DownloadMap   ConcurrentMap[string, *realdebrid.Download]   @ 96
```

Keyed by **string** (the provider link), valued by `*realdebrid.Download`:

```
--- github.com/debridmediamanager/zurg/internal/realdebrid.Download (size=112)
    Filename    string
    Filesize    int64
    Link        string
    Download    string
    Streamable  ...
    Generated   ...
```

Reference census:

| refs | file | role |
|---|---|---|
| 12 | `internal/universal/downloader.go` | **primary** — the delivery path |
| 6 | `internal/handlers/debug.go` | introspection |
| 5 | `internal/torrent/manager.go` | `mountNewDownloads`, `StartDownloadsJob` |
| 2 | `internal/dav/dav.go` | DAV listing reads size/streamability |
| 2 | `internal/dav/infuse.go` | Infuse listing |
| 2 | `internal/handlers/downloader.go` | HTTP download handler |

> **`PROVEN`:** the unrestricted (direct) download URL is **cached in a concurrent map keyed by the
> provider link**, not recomputed per request. A second read of the same file within the cache
> lifetime does **not** re-call the unrestrict endpoint.
>
> **`UNKNOWN`:** the eviction/TTL policy. Not determined.

**Note the key.** It is the *link*, not the durable TorrentFile identity. That is correct for a
delivery cache (the link is what expires), but it means the cache cannot outlive a link rotation.
Compare warpbox M7 (§`02` §3): positive cache keyed on the **durable row id**, negative cache keyed
on the **provider tuple**. Zurg only has half of that split.

### 4.2 The coalescing hypothesis is PARTIALLY FALSE

The prior hypothesis was that Zurg survives Plex read bursts by **request coalescing**. The
evidence says: **coalescing exists but is narrowly scoped, and it is not the anti-burst mechanism.**

```
$ grep -iE "singleflight" calls.tsv            # 13,347-edge call graph
internal/universal.(*Downloader).loadInnerFiles     ->  singleflight
```

> **`PROVEN`:** `singleflight` appears **exactly once** in the entire call graph, for **archive
> inner-file listing** (RAR/zip member enumeration). Not for media delivery, not for PROPFIND, not
> for unrestrict calls.

`panjf2000/ants/v2` has 10 references, all in `rdclient.(*IPRepository).runLatencyTest` /
`runServerListLatencyTest` — **network probing only**. Media delivery is not pooled, and does not
need to be, because it is cache-served.

### 4.3 What actually stops the burst: rate limiting at the provider boundary

```go
func rdclient.NewRateLimiter(rateLimitPerMinute int) *RateLimiter
func (r *RateLimiter) Wait()

func config.(*ZurgConfigV1).GetAPIRateLimitPerMinute() int
func config.(*ZurgConfigV1).GetTorrentsRateLimitPerMinute() int

func realdebrid.NewRealDebrid(
        apiClient        *rdclient.HTTPClient,
        unrestrictClient *rdclient.HTTPClient,
        downloadClient   *rdclient.HTTPClient,
        torrentsRateLimiter *rdclient.RateLimiter, ...)
```

> **`PROVEN`:** **three separate HTTP clients** (API, unrestrict, download) plus a **dedicated rate
> limiter for torrent operations**, with **two independently configurable limits**
> (`APIRateLimitPerMinute`, `TorrentsRateLimitPerMinute`).

**This is the structural answer to Failure E.** Zurg does not try to deduplicate Plex's reads; it
**throttles the fan-out at the provider boundary**:

| Plex action | Zurg code path | Provider calls |
|---|---|---|
| PROPFIND directory | `ServeTorrentFilesForDav` | **0** — model render |
| PROPFIND file / HEAD | → `pkg/dav.File(name, f.Bytes, f.Ended)` | **0** — `f.Bytes` pre-populated |
| First Range read | `HandleSingleFile` → `UnrestrictFile` | **1**, then cached in `DownloadMap` |
| Subsequent Range reads | `DownloadMap` hit | **0** |
| Intro/credit analysis (Range reads) | same as above | **0** after first |
| Library update signal | `RemountTrigger` / `AnalyzeTrigger` / `PlexMatchTrigger` | coalesced (`STRONG INFERENCE`) |
| Provider call on cache miss | `rdclient.HTTPClient` → `RateLimiter.Wait()` | throttled |

> **The load-bearing insight is not coalescing — it is that metadata is never fetched at read
> time.** Zurg's `f.Bytes` arrives with the provider's file listing, so "stat" has nothing to
> fetch. HashSucker's `size: null` + `ensureMetadata` model means **every Plex stat is a potential
> provider round trip.**

### 4.4 The three `chan struct{}` triggers are coalescing primitives

```go
    RemountTrigger        chan struct{}       @ 128
    AnalyzeTrigger        chan struct{}       @ 136
    PlexMatchTrigger      chan struct{}       @ 144
```

A `chan struct{}` consumed by a single supervisor goroutine, with a non-blocking send on the
producer side, is the idiomatic Go **"at most one pending wakeup"** pattern: N concurrent events
collapse into one pending signal.

> **`STRONG INFERENCE`, not `PROVEN`** — requires disassembling the send sites to confirm the sends
> are non-blocking (`select` with `default`). **Cheap, and worth copying regardless.**

Also: `hookQueue chan []string @ 296` + `hookDebounce time.Duration @ 320` +
`hookLimiter chan struct{} @ 312` → `OnLibraryUpdate` external scripts are queued, debounced and
concurrency-limited, so a library-update storm cannot fork a process storm.

---

## 5. X-ANTI — the ten things Zurg does that HashSucker must not copy

From `INDEX.md` finding #20 (all graded `PROVEN`):

**X1 — Synthesize + publish a file from delivery data alone.** `assignLinks` (`assign_links.go:92-110`)
creates a `File` from a download record with `ID = 0`, **born in state `ok_file`**. Because
`ok_file` is a healthy terminal state, fresh inventory can never correct it. The synthesized file
is **sticky and self-perpetuating**. *This is the single most important anti-pattern in the corpus.*

**X2 — Size + name as identity.** Size is a weak discriminator that is also user-visible.

**X3 — Key anything on basename.** The `SelectedFiles` map key **is** the basename. Two provider
files whose `Base(Path)` collide **provably collapse into one map entry**. Zurg does not attempt
to disambiguate at the map layer; it relies on user-driven `Rename` to break collisions.

**X4 — Provider URL as primary key.** (`DownloadMap` is keyed on the link — acceptable for a
delivery cache, fatal as durable identity.)

**X5 — Monotonic strike counter with no decay.**

**X6 — Throttle negative-cached identically to a content failure.**

**X7 — Eager validation at import.**

**X8 — Eager full-library sync at boot** with no readiness gate.

**X9 — Unbounded blocking queue.**

**X10 — `strings.Contains(err.Error())` as an error taxonomy.**

### The two `File` creation paths — why X1 matters so much

| | Path A — inventory | Path B — repair-synthesis |
|---|---|---|
| Trigger | `convertToTorrent` from a provider response | `assignLinks` fallback from a download record |
| `ID` | real provider ID | **`0`** |
| `Bytes` | from `TorrentInfo.Files[].Bytes` | from the download record |
| Born state | derived from provider status | **`ok_file`** |
| Correctable by fresh inventory? | yes | **no — sticky** |

> X1 is dangerous for a structural reason, not a procedural one: **the repair path publishes a file
> in a state that healthy inventory is not allowed to overwrite.** Any HashSucker repair/synthesis
> path must be born in a *provisional* state that positive provider evidence can always correct.

---

## 6. The immutable triple vs. the mutable envelope

From the corpus's type reconstruction:

```
--- github.com/debridmediamanager/zurg/internal/torrent.File (size=160)
    File          realdebrid.File                        @ 0   (embedded: ID, Path, Bytes, Selected)
    Link          string                                 @ 40
    Ended         string                                 @ 56
    State         *pkg/fsm.FSMWithExternalMutex          @ 72
    Rename        string                                 @ 80
    MediaInfo     *go-ffprobe/v2.ProbeData               @ 96
    ForceShow     bool                                   @ 104
    LastMediaInfoErr time.Time                           @ 112
    Mu            sync.RWMutex                           @ 136
```

**Immutable triple** (the durable facts, from the provider response):
`@0 ID · @8 Path · @24 Bytes · @32 Selected`

**Mutable envelope** (re-derived, expires, or is presentation):
`@40 Link · @56 Ended · @72 State · @80 Rename · @96 MediaInfo`

> **This maps 1:1 onto the moonshot's own ontology split:**
> HashSucker `TorrentFile` ↔ the immutable triple.
> HashSucker `ProviderPlacement` + `ProviderFile` + delivery capability ↔ the mutable envelope.
>
> **The invariant to hold: the envelope may be rebuilt freely; the triple must not be mutated by a
> delivery failure.** Zurg enforces this by struct embedding (the triple is literally embedded at
> offset 0); HashSucker enforces it by table separation.

### The FSM state vocabulary

| Token | Occurrences | Layer |
|---|---|---|
| `broken_file` | 10 | per-file |
| `ok_file` | 10 | per-file |
| `deleted_file` | 2 | per-file |
| `ok_torrent` | 7 | per-torrent |
| `repairing` | 7 | torrent-level |
| `downloading` | 6 | torrent-level |
| `downloaded` | 5 | torrent-level |
| `queued` | 6 | torrent-level |
| `dead` | 44 | terminal |

```
torrent.File.State     *pkg/fsm.FSMWithExternalMutex   @ 72    (File size 160)
torrent.Torrent.State  *pkg/fsm.FSMWithTime            @ 272   (Torrent size 352)
```

> **`PROVEN`:** every individual file has its own state machine, **independent of the torrent that
> contains it**. A file can be `broken_file` while its siblings are `ok_file`. **This is the
> mechanism that makes per-file failure isolation possible** — and it is a per-file FSM, not a
> per-release one.

---

## 7. Naming: two disjoint call chains, never mixed

| | Release / directory name | Internal file name |
|---|---|---|
| Function | `GetKey` → `GetKey_Original` (`key.go:32` / `:9`) | `GetFilename` (`manager.go:230`) |
| Source fields | `Torrent.Name @0`, `Torrent.OriginalName @16` | `File.Path @8` (base of), `File.Rename @80` |
| Config gates | `IgnoreRenames`, `RetainRDTorrentName`, `RetainFolderNameExtension` | `IgnoreRenames` |
| Consumed by | DAV directory `href`, `.zurgtorrent` filename | `SelectedFiles` key, DAV file `href` |

```go
// /app/internal/torrent/manager.go:230 — reconstructed from disassembly
func (t *TorrentManager) GetFilename(file *File) string {
    if config.IgnoreRenames || file.Rename == "" {   // line 231
        return filepath.Base(file.Path)              // line 234
    }
    return file.Rename                               // line 232
}
```

> **`PROVEN`:** there is **no function in the binary** that takes a release name and searches for a
> file by it. The live seam is `GetFileByVisibleName` → `f.Link`. **The string that Plex sees is
> the string used to fetch bytes.** One name, one producer, one consumer.

**Two rejected hypotheses, both `PROVEN` as rejections:**

- *"`info_hash:file_index` is Zurg's identity model."* → **REJECTED.** No `Sprintf`, no
  concatenation, and no map key in the binary combines a hash with an index.
- *"episode number == file index."* → **REJECTED.** No episode-number concept exists in the binary.
  Episode ordering is delegated entirely to the Plex matcher, which consumes `File.MediaInfo`, not
  array positions.

> **The invariant to take: Zurg never derives an episode-scale identity from a torrent-scale
> index.** That is I4 ("never make provider file indexes durable identity") confirmed independently.

---

## 8. What Zurg does NOT give us

| Question | Status |
|---|---|
| TorBox file identity and delivery behaviour | `UNKNOWN` / `SOURCE NOT AVAILABLE` |
| `DownloadMap` eviction / TTL | `UNKNOWN` |
| Whether trigger sends are non-blocking (proves coalescing) | `STRONG INFERENCE`, not `PROVEN` |
| Whether `RateLimiter` is token-bucket or interval-based | `UNKNOWN` |
| Whether `HandleSingleFile` has a per-path mutex | `UNKNOWN` |
| Whether `GetKey` (unsanitised) and `GetTorrentFilename` (sanitised) can diverge | `UNKNOWN` |
| How `Rename` is re-applied on restart | `PARTIAL` |
| The `ContinueRepair` / `authBlocked` semantics of `assignLinks` | `UNKNOWN` |
| `runtime.rand` at `dav.go:75` | `UNKNOWN`, explicitly **not load-bearing** |

The honest summary: Zurg proves the **read path** (listing, stat, size, mtime, delivery caching,
burst suppression) and leaves the **repair path** and everything TorBox-shaped unresolved.

---

## 9. Verdict

### Adopt (semantics, not code)

- **M27 — size before exposure, as a structural property.** A `TorrentFile` with no size must be
  impossible to publish. Kill the nullable `size` column. → E1
- **M28 — `getlastmodified` = provider completion time.** Restart-invariant mtime, free because the
  provider already told us. → E1
- **M22 — per-file state machine independent of the release.** `broken_file` while siblings are
  `ok_file`. → E3
- **M26 — delivery-URL cache keyed on the provider link** + **M29 — throttling at the provider
  boundary with separate clients and separate limits**, rather than trying to deduplicate client
  reads. → E4
- **The four-layer identity split with the immutable-triple/mutable-envelope boundary.** Direct
  confirmation of I1–I3. → all experiments
- **Four `continue` branches in the listing loop**, backed by a *pre-modelled* broken state, so the
  listing path never has to discover a failure. → E1
- **Three separate HTTP clients + two independently-configured rate limiters**, throttling at the
  provider boundary rather than trying to deduplicate client reads. → E4
- **M29 — `chan struct{}` "at most one pending wakeup" triggers** for remount / analyze /
  plex-match, plus the debounced + concurrency-limited hook queue. → E4
- **Debounced + concurrency-limited hook queue.** → E4

### Reject

- **X1 — repair-synthesis born `ok_file`.** Any synthesized file must be born provisional.
- **X3 — basename as the live map key.** Provably collapses on collision.
- **Retry-synthesis as a way of "healing"** without positive provider evidence.
- **Coalescing as the primary anti-burst mechanism.** It is not what Zurg uses; the cache +
  rate limiter are.

### The corpus's own bottom line, quoted

> **Build-vs-delegate: (A) Keep HashSucker's VFS, adopt Zurg's semantics.**
> **Language change required? No.**

### Why Zurg is not a model for the catalog-population problem

Zurg does not have a virtual catalog in the moonshot sense. It has a **materialized model built
from a full provider inventory refresh** — the same eager pattern as warpbox's periodic sync
(§`02` §1), and the same reason both of them get zero provider calls on the read path. It is not
lazy. **It is eagerly complete, and therefore never has to ask.**

> **This is the strongest available evidence for corpus contradiction §6(a):** every system in this
> corpus that achieves "zero provider calls on enumeration" does so by **having already fetched
> everything**, not by being lazy. The moonshot's claim that laziness can produce the same result
> is unproven, and Zurg does not prove it.

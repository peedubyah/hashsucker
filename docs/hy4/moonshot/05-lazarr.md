# `rushp4000/lazarr` — FUSE virtual↔materialized lifecycle, probe cache, suppression ladder

**Repo:** `rushp4000/lazarr`
**Shape:** 30 non-test `.go` files, 8,337 lines. Go 1.26.5.
**Deps:** `hanwen/go-fuse/v2 v2.10.1`, `modernc.org/sqlite` (CGO-free), `golang.org/x/sync/singleflight`.
**Provider:** TorBox **only**. No abstraction layer, no second provider.

**Headline:** lazarr is the strongest single precedent for the moonshot, and it is also the
clearest statement of its hardest constraint. Its VFS/materialize split is genuinely
provider-neutral and should be ported almost wholesale. Its *grab* path — the thing that
populates the virtual catalog with names and sizes — depends absolutely on a TorBox endpoint
that Real-Debrid deleted in 2024.

---

## 0. Architecture map

```
cmd/lazarr/main.go          wiring, lifecycle, signals, tickers, settings save/restart
internal/
  qbit/       qBittorrent WebUI emulation (arr-facing) + GRAB pipeline + wait-download poller
  catalog/    SQLite: release (infohash PK) | file (hash,file_id PK) | dl_link (hash,file_id PK)
  symlink/    import tree: <download_dir>/<category>/<name>/<rel> -> <fuse_mount>/<hash>/<rel>
  vfs/        read-only FUSE: /<hash>/<rel_path>   (Lookup/Getattr/Readdir = catalog-only)
  materialize/ the engine: slots, LRU, singleflight, range proxy, probe cache, prefetch,
               reapers, ToS audit, repair scan
  torbox/     the ONLY provider client (HTTP, auth, decode, error taxonomy)
  webui/      dashboard + editable settings
  logging/    slog tee -> ring buffer, runtime level
  metrics/    Prometheus + /health
```

**Request flow, media-server stat → bytes:**

```
Plex stat(2)  /mnt/lazarr/<hash>/<rel>
   -> FUSE GETATTR   -> vfs/fileNode.Getattr        [fs.go:433]  catalog size, ZERO provider calls
Plex read(fd, off, n)
   -> FUSE OPEN      -> vfs/fileNode.Open           [fs.go:444]  FOPEN_DIRECT_IO, no materialize
   -> FUSE READ      -> vfs/fileNode.Read           [fs.go:462]
        -> materialize.Engine.ReadAt                [engine.go:368]
             (0) probe cache lookup (disk)          [engine.go:380-404]  <-- may return WITHOUT materializing
             (1) ensureMaterialized                 [engine.go:529]      singleflight per hash
                   -> admit() slot semaphore        [engine.go:753]      cap = 3 (Essential)
                   -> tb.CreateTorrent(magnet, add_only_if_cached=true)  [engine.go:653]
                   -> store.SetState(materialized, torboxID)             [engine.go:693]
                   -> register() in-memory entry    [engine.go:708]
             (2) pf.read (readahead) OR fillHeader/fillFooter OR proxyRead
                   -> freshLink()  tb.RequestDL     [proxy.go:378]       presigned CDN URL
                   -> prox.getRange()  HTTP Range GET [proxy.go:423]     SSRF-pinned
             (3) store.TouchAccess(hash, now)       [engine.go:416]      drives idle reaper
```

> **The critical structural fact:** `Lookup` / `Getattr` / `Readdir` / `Open` **never** touch the
> provider. Only `Read` does. That *is* lazarr's intent boundary — and it is the kernel's
> `read(2)` syscall, not a heuristic.

---

## 1. The virtual↔materialized lifecycle

### 1.1 Two orthogonal axes

Durable release state (`internal/catalog/catalog.go:9-17`):

```go
const (
	StateVirtual      State = "virtual"      // symlinked, NOT on TorBox
	StateMaterialized State = "materialized" // added to TorBox, streamable
	StateError        State = "error"        // checkcached/torrentinfo failed, or dead-cache
	StateDownloading  State = "downloading"  // TorBox is fetching the uncached torrent
)
```

And a **separate, independent** availability flag (`catalog.go:24-28`):

```go
const (
	CacheStatusUnknown CacheStatus = ""        // not yet checked
	CacheStatusCached  CacheStatus = "cached"  // confirmed available
	CacheStatusEvicted CacheStatus = "evicted" // no longer on TorBox CDN
)
```

`StateError` is documented as terminal until an arr re-grab resets the row (`engine.go:629-633`).

### 1.2 The transition table

| From | To | Trigger | Code |
|---|---|---|---|
| (none) | `virtual` | arr grab, checkcached hit | `qbit/server.go:283`, `:337` |
| (none) | `error` | checkcached error/miss (cached-only) | `qbit/server.go:294`, `:328`, `:331` |
| (none) | `downloading` | `on_cache_miss=wait` | `qbit/waitpool.go:86` |
| `virtual` | `materialized` | **first `ReadAt`** | `engine.go:693` |
| `materialized` (stale row) | `materialized` (adopt) | catalog says materialized, no in-mem entry | `engine.go:641-646` |
| `materialized` | `virtual` | idle reaper / max-hold / LRU / shutdown / arr delete | `engine.go:858` |
| `downloading` | `virtual` | TorBox finished fetching → account copy deleted | `qbit/waitpool.go:195-197` |
| `downloading` | `error` | over budget / vanished | `qbit/waitpool.go:224` |
| any | `error` | `ErrNotFound` (purged) at materialize or stream time | `engine.go:683`, `markPurged:976` |
| `virtual` | `error` | not-cached & `!AllowUncached` | `engine.go:686` |

In-memory second axis (`engine.go:141-146`) — exists only while a slot is held:

```go
type entry struct {
	hash     string
	torboxID int64
	refs     int   // active readers; >0 => pinned
	lastUsed int64 // unix nanos of last admit/read; drives in-memory LRU
}
```

### 1.3 Exactly one thing triggers materialization: `ReadAt`

`engine.go:368`, reached only from `vfs/fileNode.Read` (`fs.go:463`). `ensureMaterialized`
(`engine.go:529-589`) has a no-semaphore fast path for an already-tracked hash, and a singleflight
slow path:

```go
	// Slow path: dedupe the materialize across concurrent first-readers for this hash.
	// Exactly one goroutine runs materializeLocked; the rest share its result.
	v, err, _ := m.sf.Do(hash, func() (any, error) {
		// Re-check under lock: a previous singleflight winner may have just finished.
		m.mu.Lock()
		if ent, ok := m.track[hash]; ok {
			m.mu.Unlock()
			return ent, nil
		}
		// Mark in-flight so a concurrent releaseUntracked / boot-reconcile (B2) defers to us
		// instead of deleting the TorBox item we are about to create or adopt. ...
		m.inflight[hash] = struct{}{}
		m.mu.Unlock()
		defer func() { /* delete(m.inflight, hash) */ }()
		return m.materialize(ctx, hash)
	})
```
— `engine.go:544-564`

The `inflight` marker is not decoration. It exists *because* the `{hash → torbox_id}` binding is
mutable, and a reaper running concurrently with a first-read could delete a placement that is
being created. See §4.1.

### 1.4 Four independent de-materialization reapers

1. **Idle** — `reapIdle`, `reaper.go:42-55`. `IdleCandidates` = `state='materialized' AND last_access < now-idle_ttl`. Default `DefaultIdleTTL = 7 * 24h`.
2. **Max-hold** — `reapOverMaxHold`, `reaper.go:59-72`. Measured from `materialized_at`, **not** `added_on` — `catalog.go:46-49` documents this as a fix for add/delete churn. Default `30 * 24h`.
3. **LRU under slot pressure** — `admit` → `pickLRUIdle` (`engine.go:766`, `:789-803`).
4. **Shutdown force-release** — `Close` (`engine.go:321-363`).

All four converge on the same teardown (`engine.go:833-872`). Note the lock discipline — network
and persistence happen **outside** the lock:

```go
	// Remove from tracking under the lock so a concurrent admit/read re-materializes
	// cleanly instead of racing on a half-torn-down entry.
	delete(m.track, hash)
	id := ent.torboxID
	metrics.SetMaterializedCount(len(m.track))
	m.mu.Unlock()

	// Network + persistence happen OUTSIDE the lock.
	var err error
	if id != 0 {
		if derr := m.tb.ControlDelete(id); derr != nil { ... }
	}
	if serr := m.store.SetState(hash, catalog.StateVirtual, 0); serr != nil { ... }
```

`release` refuses to tear down a pinned entry unless `force` (`engine.go:840-843`).

### 1.5 What happens to FUSE entries when the provider resource disappears

**Nothing. There is zero FUSE cache invalidation in the entire codebase.**

```
$ grep -rn "Notify\|Invalidate\|Forget\|NodeForgetter" --include=*.go internal/
   → only webui/api.go:211 handleForgetRelease (an unrelated HTTP route)
```

This is deliberate and mostly correct:

- **Idle release / LRU eviction:** the `fileNode` keeps its catalog-derived size and mode. A later
  read re-materializes transparently. **The FUSE tree is more durable than the provider resource**
  — exactly HashSucker's desired invariant.
- **Purge:** `markPurged` (`engine.go:967-994`) deletes the in-memory entry, sets `StateError`,
  frees the slot — but the `fileNode` **still exists in the tree with its full size**. A subsequent
  read fast-fails → `EIO`. The path never disappears; it just starts erroring.

> **Port this.** "The VFS entry outlives the provider placement; a re-read re-materializes" is the
> durable-virtual-catalog invariant stated as code.

---

## 2. FUSE semantics

### 2.1 `Getattr` for a virtual file

```go
func (n *fileNode) Getattr(_ context.Context, _ fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = syscall.S_IFREG | 0o444
	out.Size = uint64(n.size) //nolint:gosec — catalog size, trusted internal value
	out.Nlink = 1
	return fs.OK
}
```
— `vfs/fs.go:433-438`

The size comes from `catalog.File.Size`, captured **once** at `dirNode` construction
(`fs.go:306-312`): *"The file list is captured at construction from the store so Getattr/Read
never re-query SQLite."*

### 2.2 X-ANTI: every timestamp is zero

`grep -rn "Mtime\|Atime\|Ctime" internal/` → **nothing.** Every file and directory reports
**mtime = atime = ctime = 0 (1970-01-01)**. Also unset: `Blocks`, `Blksize`, uid/gid.
`Statfs` is **not implemented at all** — go-fuse's default returns a zeroed filler.

This is synthetic-by-omission. Plex uses mtime for "recently added" ordering and change
detection, so a library where everything is dated 1970 is a real operational wart. Compare Zurg
(§`06` §C): `getlastmodified` = the provider's completion timestamp, chosen deliberately so a
restart never changes a file's timestamp.

### 2.3 `Open` — `FOPEN_DIRECT_IO`

```go
func (n *fileNode) Open(_ context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	const writeMask = syscall.O_WRONLY | syscall.O_RDWR
	if flags&writeMask != 0 { return nil, 0, syscall.EROFS }
	return nil, fuse.FOPEN_DIRECT_IO, fs.OK
}
```
— `vfs/fs.go:444-451`

`fs.go:441-443`: *"We use FOPEN_DIRECT_IO to disable kernel-side page-cache for the file so every
Read is forwarded to us (important: the materializer updates last_access on every read, driving
the idle reaper)."*

**Consequence:** the kernel does no readahead either, so lazarr had to build its own (§5.3).
Every 1 MiB window would otherwise be one serial CDN round-trip (~5-8 MB/s, too slow for 4K).

### 2.4 All read errors collapse to `EIO`

`fs.go:466`. `ErrPurged`, `ErrRateLimited`, `ErrSlotsExhausted`, `ErrUncachedDisabled`,
`ctx.Canceled` are **indistinguishable** to the caller — despite a rich internal taxonomy
(`engine.go:36-47`). This is X-ANTI: the errno boundary throws away exactly the information a
caller needs to decide whether to retry.

### 2.5 X-ANTI: `rootNode.Readdir` is a stub

```go
	// The catalog.Store has no ListAll, so we use MaterializedIDs for the full
	// set of *active* releases ...  For now we return an empty Readdir so
	// `ls /mount` works silently; direct access via `/<hash>/` still works via
	// Lookup.  When a ListAll/ListCategories method is added to Store we will
	// populate this.  See TODO in catalog.Store.
	return fs.NewListDirStream(nil), fs.OK
```
— `vfs/fs.go:282-294`

`ls /mnt/lazarr` shows nothing. It works for lazarr only because arr/Plex reach files through a
**symlink tree** that is resolved by `Lookup`, never by enumerating the root.

> **A WebDAV port cannot copy this.** `PROPFIND` on the root must enumerate. This is the single
> most important "do not copy" in the repo.

### 2.6 Attribute caching

| Cache | TTL | Invalidated by |
|---|---|---|
| Kernel attr cache | `AttrTimeout = 1s` (`fs.go:87`) | time only |
| Kernel entry cache | `EntryTimeout = 1s` (`fs.go:86`) | time only |
| Kernel page cache | **disabled** (`FOPEN_DIRECT_IO`) | n/a |
| `dirNode.files` snapshot | **lifetime of the inode** | **nothing** |
| Inode numbers | FNV-1a of `hash + "\x00f" + fileID` | nothing |

`AttrTimeout: 1s` is a global blunt instrument tuned for "Plex scans don't hammer us", not for
correctness. With no `Notify` anywhere, correctness depends entirely on 1s being short enough
that nobody notices.

### 2.7 X-ANTI: `size = 1` fabrication

```go
	case catalog.StateError:
		...
		if r.TotalSize == 0 {
			size = 1
			amtLeft = 1
		}
```
— `qbit/server.go:415-424`

A **fabricated size of 1 byte** reported to Sonarr/Radarr for a release whose real size is
unknown. It is an arr-UI workaround — a 0-byte torrent renders badly. Containment is real: it is
**not** written to the catalog and never reaches FUSE, because `StateError` releases get no
symlinks. **But it is a precedent** — a synthetic value invented to satisfy a client's renderer,
with no marker distinguishing it from a real 1-byte file.

---

## 3. M2 — The probe cache: the moonshot hiding inside an "optimization"

### 3.1 Checked BEFORE materialization

This is the ordering that makes the whole thing work:

```go
	// 0. Probe cache FIRST — BEFORE materializing. Header and footer regions are immutable
	// (torrent content, keyed by infohash), so a cached metadata window can be served while
	// the release stays VIRTUAL: a Plex/ffprobe scan of an already-released item costs zero
	// TorBox adds and zero CDN traffic. (Pre-v1.1.4 this lookup sat after the materialize
	// call, so every scan of a released item burned an add against the createtorrent budget.)
```
— `engine.go:374-378`

> **The single most transferable finding in the entire moonshot corpus.** lazarr's probe cache can
> serve a file that **does not exist on the provider at all**. Zero `CreateTorrent`, zero
> `RequestDL`, zero CDN. It is framed as an optimization; it is actually the mechanism that makes
> virtual files readable.

### 3.2 Region sizing

```go
const (
	defaultProbeRegionBytes = int64(4 << 20)   // 4 MiB header region per file
	defaultProbeCacheBytes  = int64(512 << 20) // 512 MiB total on-disk budget (bounded)

	probeFooterMin   = int64(1 << 20) // 1 MiB
	probeFooterMax   = int64(8 << 20) // 8 MiB
	probeFooterRatio = int64(500)     // region = size/500 = 0.2% of the file
)
```
— `probecache.go:13-23`

`footerRegionFor(size)` clamps `size/500` into `[1 MiB, 8 MiB]`. Note this is **per-file, size
proportional** — unlike torrg's global `PROBE_TAIL_MB = 2` (§`01` §2). HashSucker should take
lazarr's shape: `min(head_max, size * ratio)`.

### 3.3 The all-or-nothing hit contract — M18, independently derived

```go
// readAt serves a header-region read from disk if present. A hit is all-or-nothing:
// it returns (len(p), true) ONLY when the cached prefix fully covers [off, off+len(p)).
// A partial cached prefix is a MISS (returns false) so the caller does a full live read
// instead — a short count here would be forwarded to FUSE under FOPEN_DIRECT_IO and read
// by ffprobe/Plex as a premature EOF, truncating the very header scan the cache serves.
```
— `probecache.go:109-113`

`fillHeader` has the same fall-through (`engine.go:491-495`). **This is torrg's X-anti-poisoning
rule (§`01` §4) arrived at independently.** Two unrelated codebases, same conclusion: a partial
probe-cache hit must be a miss, not a short read.

### 3.4 The three containment rules — copy verbatim

1. **Content-addressed keys.** `(infohash, fileID)` (`probecache.go:96-107`, with path-traversal
   sanitization). Torrent content is immutable by construction, so a cache hit is *provably*
   correct — no freshness check, no validation, no TTL.
2. **Best-effort, never on the correctness path.** Opened best-effort, degrades to disabled
   (`engine.go:189-196`). Every fill failure returns `ok=false` and falls through
   (`engine.go:487-489`, `:515-517`). `engine.go:471-472`: *"this is an optimization layer, never
   a correctness gate."*
3. **Write-once, never refresh.** `maybeStore` returns early if the key exists
   (`probecache.go:148-152`) — *"already cached -> never re-add (avoids churn)."*

### 3.5 Zero fabricated bytes — verified

```
$ grep -rn "synthetic\|placeholder\|fake\|zero-fill" --include=*.go internal/ | grep -v _test
   → probecache.go:267    (a "no-op placeholder" close() method)
     vfs/fs.go:299,334    ("synthetic intermediate directory" — an INODE, not bytes)
     torbox/client.go:255 (a "synthetic detail" fallback for an error string)
```

**No zero-filled reads. No placeholder content. No fabricated byte ranges.** Every byte reaching
FUSE came from the provider CDN via `getRange` → `io.ReadFull` (`proxy.go:512`), or from the
on-disk probe cache which was itself populated from that exact path.

### 3.6 What lazarr does NOT guard — HashSucker must add it

- **No integrity check anywhere.** If a provider ever served corrupt bytes for a hash, the
  corruption would be cached permanently and served forever. No piece-level or region-level
  checksum exists.
- **`probeCache.close()` is a documented no-op** (`probecache.go:267-268`). Files persist across
  restarts with **no version tag**. A format change would silently serve garbage.
- **Not invalidated on re-materialize** — deliberate and correct (infohash-addressed), but it
  means permanent corruption is possible in principle.

> HashSucker must add a **schema/version tag on the on-disk cache** and an explicit
> `synthetic: true` marker on any metadata it invents. lazarr has neither.

---

## 4. M5 — The suppression ladder: four brakes, all correctly scoped

### 4.1 Layer 1 — per-hash singleflight

`sf singleflight.Group` (`engine.go:107`), key = `hash`. The refs discipline is subtle and
commented (`engine.go:570-571`):

```go
	// Pin AFTER materialize. Because singleflight shares one *entry across all waiters, we
	// must increment refs once per ReadAt (here), not inside the shared func.
```

Plus the `deferToInflight` guard (`engine.go:884-933`) which exists because
`{hash → torbox_id}` is mutable:

```go
func (m *materializer) deferToInflight(hash string) bool {
	m.mu.Lock()
	_, tracked := m.track[hash]
	_, inflight := m.inflight[hash]
	m.mu.Unlock()
	if tracked {
		_ = m.release(hash, false)
		return true
	}
	return inflight
}
```

### 4.2 Layer 2 — terminal-state fast-fail

```go
	if rel.State == catalog.StateError {
		return nil, fmt.Errorf("materialize: %s previously errored (not cached/purged): %w",
			short(hash), ErrPurged)
	}
```
— `engine.go:634-637`

### 4.3 Layer 3 — global rate-limit backoff

After any `ErrRateLimited`, **every** materialize for **every** hash fast-fails with no provider
call for `RateLimitBackoff = 10 * time.Minute` (`constants.go:57`, armed at `engine.go:663`).

The design comment (`constants.go:50-56`) documents the exact failure being stopped: a stuck item
read every ~60s by an arr import loop → **~120 `createtorrent` calls/hour against a 60/hour
budget.** This is E4's target scenario, observed in production.

### 4.4 Layer 4 — per-hash deferral

`deferred[hash]` (`engine.go:599-608`, armed at `:672-675`) — `ErrAlreadyQueued` parks the hash
for `QueuedDeferral = 10 * time.Minute`.

### 4.5 The complete breaker table

| Breaker | Scope | Duration | Constant |
|---|---|---|---|
| `rateLimitedUntil` | account-wide, all createtorrent | 10 min | `constants.go:57` |
| `deferred[hash]` | per-hash createtorrent | 10 min | `constants.go:49` |
| `throttledUntil` | prefetch speculation only | 30 s | `proxy.go:123` |
| `admit` slot semaphore | concurrent materialized items | 3 slots | `constants.go:12` |
| `prefetcher.sem` | concurrent background fetches | 3 | `prefetch.go:56` |

The throttle breaker is a CAS loop with **monotonic extension** (`proxy.go:126-134`):

```go
func (m *materializer) noteThrottle() {
	until := m.now().Add(throttlePause).UnixNano()
	for {
		cur := m.throttledUntil.Load()
		if cur >= until || m.throttledUntil.CompareAndSwap(cur, until) {
			return
		}
	}
}
```

And the consumer (`prefetch.go:206-213`): *"while a 429 window is open, schedule NOTHING
speculative. Foreground reads keep going."*

> **Note the layer separation.** A throttle suppresses *speculation* but never *foreground reads*.
> That is the right default: speculation is optional, a real read is not.

### 4.6 Lock discipline and liveness

Struct comment (`engine.go:109-110`): *"mu guards the in-memory materialized-set bookkeeping
(track + lru). It is never held across network I/O (slot admission, GET, CreateTorrent)."*
Verified. `admit` (`engine.go:753-785`) is liveness-safe via `idleSignal` — a blocked admit
re-attempts LRU eviction when a pinned release goes idle instead of waiting forever:

```go
	select {
	case m.slots <- struct{}{}:
		metrics.SetSlotsInUse(len(m.slots))
		return nil
	case <-m.idleSignal:
		// A release went idle; loop to attempt eviction.
	case <-ctx.Done():
		return fmt.Errorf("materialize: admit %s: %w", short(incoming), ctx.Err())
	}
```

---

## 5. Byte-range reads

### 5.1 Range reads are exact-window, never widened — a documented reversal

```go
// NOTE: each getRange fetches EXACTLY its requested window — there is no readahead
// widening. An earlier design asked the CDN for window+readahead bytes, but with no
// prefetch buffer those extra bytes were drained and discarded: pure wasted TorBox
// bandwidth (which counts against the rolling-bandwidth ToS budget) for zero benefit.
```
— `proxy.go:413-417`

### 5.2 Three read paths, picked by offset

```go
	if m.pf != nil && !(m.probe != nil && m.probe.covers(off, int64(len(p)))) {
		n, err := m.pf.read(ctx, m, ent, fileID, p, off)
```
— `engine.go:440-441`

1. **Header region** `[0, 4 MiB)` → `fillHeader` (whole region in one GET, cached)
2. **Footer region** `[size-region, size)` → `fillFooter`
3. **Everything else** → `prefetcher.read` if enabled, else `proxyRead`

### 5.3 Readahead

Defaults `ReadaheadWindows: 4`, `ReadaheadChunkMiB: 2` (`config.go:173-174`) → 8 MiB per active
stream; `capacity = 32` chunks = 64 MiB global bound; `conc = 3`.

**Sequential detection is pure offset arithmetic, no timing** (`prefetch.go:124`):

```go
	sequential := ok && off >= st.lastEnd-4*p.chunkSize && off <= st.lastEnd+p.chunkSize
```

EOF frontier capped by catalog size so no wasted probe past end-of-file (`prefetch.go:127-131`).
`prefetchAsync` **re-pins the entry** for the fetch duration (`prefetch.go:204`, `:237-241`) — a
concurrent release can't yank the provider item mid-prefetch.

**Bug worth noting:** `ok` is the *pre-loop* presence flag, so on the very first read `ok==false`
and no readahead is scheduled. Deliberate or not, it costs one window of pipeline warmup.

### 5.4 HTTP 416 = clean EOF, not an error

```go
		// 416 Range Not Satisfiable = the requested range starts at/past the entity's end.
		// That is EOF, not an error (riven lesson): it happens when the catalog's file size
		// drifts slightly past the CDN entity's true size, and surfacing EIO here would
		// kill the final seconds of a playback. 0 bytes + nil error = clean EOF upstream.
		if resp.StatusCode == http.StatusRequestedRangeNotSatisfiable {
			return 0, nil, nil
		}
```
— `proxy.go:481-487`

And HTTP 200 at `off > 0` is a **hard error** (`proxy.go:467-475`) — refuse to silently corrupt a
seek by returning the file start.

### 5.5 The 429 patient ladder — blocking a FUSE read for 8 s is the happy path

```go
var throttleBackoffs = []time.Duration{
	300 * time.Millisecond, 900 * time.Millisecond, 2 * time.Second, 5 * time.Second,
}
const maxRetryAfter = 10 * time.Second
const throttlePause = 30 * time.Second
```
— `proxy.go:113-123`

Rationale (`proxy.go:110-112`): *"a FUSE read that blocks a few seconds just looks like buffering;
a read ERROR kills the stream."*

> **Conventional wisdom says fail fast. lazarr inverts it, and it is right for streaming.** Compare
> warpbox (§`02` §3), where all failure kinds share one flat 30 s negative TTL.

### 5.6 Stall guard

| Constant | Value | Location |
|---|---|---|
| `proxyDialTimeout` / `TLS` / `RespHeaderWait` / `Total` | 10s / 10s / 30s / 5min | `proxy.go:56-59` |
| `stallFloor` / `stallBytesPerSec` | 20 s / 128 KiB/s | `proxy.go:69-70` |
| `MaxIdleConns` / `IdleConnTimeout` | 16 / 90 s | `proxy.go:225-226` |

```go
func stallTimeout(n int) time.Duration {
	return stallFloor + time.Duration(int64(n)/stallBytesPerSec)*time.Second
}
```

A tripped stall deadline classifies as `errCDNUnreachable`, which routes into the link-refresh
path. Critically, `ctx` stays the parent so caller cancellation passes through untouched.

---

## 6. Does it decide "real playback" vs "probing"? **NO.**

```
$ grep -rn "intent\|playback\|probing" --include=*.go internal/  (non-test)
   → only comments and log strings. Zero decision code.
```

No byte-size threshold, no request-pattern classifier, no repeat-rate counter, no session
tracking, no PID/user-agent inspection, no open-duration heuristic.

### What it does instead: positional suppression

```go
func (c *probeCache) covers(off, length int64) bool {
	return off >= 0 && length >= 0 && off+length <= c.region
}
func (c *probeCache) coversFooter(size, off, length int64) bool {
	r := footerRegionFor(size)
	return r > 0 && off >= size-r && length >= 0 && off+length <= size
}
```
— `probecache.go:89-91`, `:187-190`

### The actual intent boundary

`vfs/fs.go:444` — **`Open` does not materialize; only `Read` does.** Combined with
`Getattr`/`Lookup`/`Readdir` being catalog-only:

> **A provider add happens on the first `read(2)` that returns actual bytes — and never on stat,
> lookup, list, or open.**

That is a syscall-level boundary, arguably *more* reliable than any heuristic. But it is coarse:
**a single 4 KiB `read()` at offset 0 triggers a full `CreateTorrent`.** ffprobe opening a file to
sniff the container costs exactly as much as a Plex client starting playback.

### The hypothesis-test result

| Scenario | Provider adds? |
|---|---|
| Plex `stat` storm over the library | **0** (catalog only) |
| Plex `Readdir` / library scan | **0** |
| arr import (`readlink`, `stat`, `rename`) | **0** |
| ffprobe header scan, **first time ever** | **1** (`CreateTorrent` + `RequestDL`) |
| ffprobe header scan, **after first** | **0** (probe cache) |
| ffprobe footer scan (MKV cues / MP4 moov), first time | **1** (or 0 if already materialized) |
| Real playback | 1 (if not already hot) |

> **Key insight:** lazarr gets its suppression from **content-addressed caching of immutable byte
> regions**, not from intent detection. Because the key is the infohash (+ fileID) and torrent
> content is immutable, a cached header is *provably* the right bytes forever. **That is a much
> stronger guarantee than any "did the user really press play?" heuristic could give.**
>
> **The absence of intent detection is HashSucker's opportunity, not a gap to copy.** HashSucker's
> WebDAV layer sees `GET`/`Range` semantics and request patterns that FUSE does not expose. The
> *first* scan, which lazarr cannot avoid, is avoidable here — that is E2.

---

## 7. Eviction handling — the weakest part, and HashSucker's biggest opening

### 7.1 The daily repair scan marks, never repairs

`RepairScan` (`repair.go:21-97`) batches every catalog hash through `checkcached` in groups of
`CheckCachedBatchMax = 100`. Driven by `DefaultRepairScanEvery = 24 * time.Hour`.

```go
			if !available {
				// Look up name/category for the caller's display.
				r, _, getErr := m.store.GetRelease(h)
				slog.Warn("repair: content evicted from TorBox CDN — arr will need to re-grab",
					"hash", h, "name", r.Name, "category", r.Category)
			}
```
— `repair.go:84-86`

The scan is **purely read-only**. The quiet part is in the log message: *"arr will need to
re-grab."* The only remediation is a manual "Forget" in the Web UI (`webui/provider.go:440-447`)
which deletes the row + symlinks so the arr's next health-check re-searches.

### 7.2 X-ANTI: `CacheStatus` is computed daily and then never read

`grep` shows `CacheStatusEvicted` appears only in `catalog.go`, `sqlite.go`, `repair.go`, and
`webui`. **`materialize()` does not consult it.** An evicted item still tries `CreateTorrent` on
the next read, discovers `ErrNotFound`, and *then* errors.

> **Closing this loop is free wins for HashSucker:** wire `cache_status == evicted` → skip the
> doomed add. lazarr does the work and throws the answer away.

### 7.3 X-ANTI: `detailNotFound` is English substring matching on a third-party body

```go
func detailNotFound(detail string) bool {
	d := strings.ToLower(detail)
	return strings.Contains(d, "not found") ||
		strings.Contains(d, "not cached") ||
		strings.Contains(d, "does not exist") ||
		strings.Contains(d, "no longer")
}
```
— `torbox/client.go:481-487`

TorBox changing "not cached" to "isn't cached" **silently converts a permanent error into an
infinite retry loop.** This is the single most brittle thing in the codebase. (`isNotCached` at
`engine.go:1021-1027` has the same shape.)

### 7.4 Identity across eviction + reacquisition

- `release.hash` (infohash) is the PRIMARY KEY (`sqlite.go:85`). Never rotated.
- `torbox_id` is **reset to 0 on every release**. A re-materialization gets a **new** TorBox id.
- `file_id` comes from `checkcached` and is **not** guaranteed stable across re-acquisition —
  the code assumes it is.
- FUSE inode = FNV-1a(`hash + "\x00f" + fileID`) — stable only if `fileID` is stable.

> **Matches invariant I1/I2 exactly**: Release (infohash) is durable; placement (torbox_id) is
> disposable; the one leak is `file_id` being treated as durable when it is not.

---

## 8. Startup — lazy, with four eager exceptions

### 8.1 Boot sequence (`cmd/lazarr/main.go`)

1. Logger + ring buffer — `:60-64`
2. `config.Load` + `validate` — `:66` (fails fast)
3. `catalog.OpenSQLite` — `:93` (idempotent migrations)
4. `torbox.New` + **one** `UserMe()` — `:101-112`. **Best-effort, non-fatal**: *"so lazarr still
   boots if TorBox is briefly unreachable."* Resolves the slot count.
5. `symlink.New` — `:114`
6. `materialize.New` — `:120`. **No network I/O beyond the optional UserMe.**
7. `qbit.New` + `StartWaitPoller` — `:133, :147`
8. HTTP listen — `:151`
9. `vfs.New` + `fsys.Mount()` — `:157-165`. **Fatal on failure** (`os.Exit(1)`).
10. `eng.SetMountHealthy(fsys.Healthy)` then `eng.Start(ctx)` — `:172-173`
11. Audit ticker (5 min) `:229`, Repair ticker (24 h) `:247`

**Boot does no materialization and no catalog-wide provider work.** This is the correct answer to
warpbox's X8 (§`02` §9).

### 8.2 X-ANTI: boot-reconcile-by-delete-everything

`reconcile` (`engine.go:289-316`) — at boot `track` is empty, so **every** materialized row with a
nonzero `TorBoxID` is deleted from the provider account:

```go
		if tracked { continue } // a live read already owns it
		m.log.Warn("materialize: boot reconcile releasing untracked leftover (B2)",
			"hash", short(rel.Hash), "torbox_id", rel.TorBoxID)
		if rerr := m.Release(rel.Hash); rerr != nil {
```

**This is a design decision, not an accident.** The in-memory `track` is the only authority on
what's actually held, so a restart is treated as definitive loss of the placement.

> **HashSucker's durable `ProviderPlacements` table is strictly better here.** It can survive a
> restart and re-adopt placements instead of nuking them. But it inherits a harder problem lazarr
> sidesteps: **it must decide whether a persisted placement is still live** after arbitrary
> downtime. lazarr just assumes no.

Also fragile: `reconcile` issues one `ControlDelete` per leftover, synchronously, in a loop, and
`MaterializedReleases()` is **unbounded** (`sqlite.go:446-457`, no LIMIT). A large crashed
catalog → a burst of provider deletes at boot.

### 8.3 Shutdown

`main.go:264-291`: HTTP shutdowns (10 s ctx) → `fsys.Unmount()` → `eng.Close()`.

```go
		// B3: give in-flight readers a brief window to drop their refs, then force-release
		// EVERYTHING still tracked regardless of refs. By now main has unmounted (possibly
		// lazy-detached), so no reader can be meaningfully served — an EIO to a zombie read
		// beats leaving a TorBox item on the account (a ToS leak that B2 would make permanent
		// after the next restart).
		m.waitRefsDrain(m.drainTimeout)
```
— `DefaultCloseDrain = 5 * time.Second` (`constants.go:41`)

---

## 9. Surprising findings

**1. The probe cache serves bytes for a file that does not exist on the provider.** (§3.1.)

**2. The ToS audit can never see another tool's leaks — by design.**
`audit.go:14-18`: *"The account is SHARED with decypharr (which hoards ~440 items)... the audit is
scoped to Lazarr-added torrent_ids only: it never inspects, and never alarms on, ids Lazarr never
added."* The compliance proof is scoped to self. Also `m.seen` is **in-memory only** — after a
restart the audit scope shrinks.

**3. `auditDriftGrace = 600 s` exists because the provider API lies.**
`audit.go:22-27`: *"TorBox's mylist lags a fresh createtorrent by up to ~a minute even with
bypass_cache=true (observed live 2026-06-10: add at 05:06:10, mylist still missing it at the
05:07:12 audit, present minutes later)."* A concrete named constant encoding an **observed**
provider race. This is what evidence-class discipline looks like when it is done honestly.

**4. Blocking a FUSE read for 8 seconds is the deliberate happy path.** (§5.5.)

**5. `prefetchAsync` re-pins via `ensureMaterialized` while holding a prefetch concurrency token.**
`prefetch.go:234-240`. With `conc = 3` and `slots = 3`, three stalled background prefetches can
each consume a prefetch token while waiting for a materialize slot. `ctx` is
`context.Background()` so it is uninterruptible. A mild deadlock-flavoured risk under combined
slot + CDN pressure.

**6. `MaxWaitDownloads` default is 1 and `CacheWaitBudget` default is 15 min** — the
`on_cache_miss=wait` path is deliberately tiny. Niche, not load-bearing.

**7. `ensureMaterialized` recurses on lost race.** `engine.go:579-584`. Unbounded depth under
sustained pressure.

**8. `createMagnet` synthesizes a bare magnet when the grab was a `.torrent` file.**
```go
func createMagnet(rel *catalog.Release) string {
	if strings.HasPrefix(strings.TrimSpace(rel.Magnet), "magnet:") { return rel.Magnet }
	return "magnet:?xt=urn:btih:" + rel.Hash
}
```
— `engine.go:1011-1016`. Fine for the cached path; worse peer discovery for uncached adds. A
metadata improvisation with a documented, bounded downside.

**9. The `release` table has no `provider` column and `torbox_id` is a bare `INTEGER`.**
`sqlite.go:92`. `ARCHITECTURE.md:83-84` itself names this as prerequisite #3 for multi-provider.

---

## 10. Constant reference

| Constant | Value | File:line |
|---|---|---|
| `EssentialActiveSlots` | 3 | `constants.go:12` |
| `CheckCachedBatchMax` | 100 | `constants.go:13` |
| `CreateTorrentPerHour` | 60 (observed limit) | `constants.go:14` |
| `CreateTorrentBudget` | 55 | `constants.go:15` |
| `DefaultIdleTTL` | 7 × 24h | `constants.go:35` |
| `DefaultMaxHold` | 30 × 24h | `constants.go:36` |
| `DefaultReaperEvery` | 30 s | `constants.go:37` |
| `DefaultCloseDrain` | 5 s | `constants.go:41` |
| `LinkRefreshStatuses` | `{400, 403, 410}` | `constants.go:42` |
| `DefaultRepairScanEvery` | 24 h | `constants.go:43` |
| `QueuedDeferral` | 10 min | `constants.go:49` |
| `RateLimitBackoff` | 10 min | `constants.go:57` |
| `auditDriftGrace` | 600 s | `audit.go:27` |
| `ReadaheadWindows` / `ReadaheadChunkMiB` | 4 / 2 | `config.go:173-174` |
| `defaultProbeRegionBytes` | 4 MiB | `probecache.go:14` |
| `defaultProbeCacheBytes` | 512 MiB | `probecache.go:15` |
| `probeFooterMin/Max/Ratio` | 1 MiB / 8 MiB / 500 | `probecache.go:20-22` |
| `throttleBackoffs` | 300ms, 900ms, 2s, 5s | `proxy.go:113-115` |
| `maxRetryAfter` / `throttlePause` | 10 s / 30 s | `proxy.go:119`, `:123` |
| `stallFloor` / `stallBytesPerSec` | 20 s / 128 KiB | `proxy.go:69-70` |
| prefetch `conc` / `capacity` | 3 / `windows × 8` | `prefetch.go:56`, `:66` |
| sequential window | `lastEnd-4×chunk` … `lastEnd+chunk` | `prefetch.go:124` |
| `AttrTimeout` / `EntryTimeout` | 1 s | `fs.go:86-87` |
| `MaxWrite` | 1 MiB | `fs.go:82` |
| `unmountRetries` / `unmountBackoff` | 5 / 200 ms | `fs.go:136-137` |

---

## 11. Verdict

### Port directly (high value)

- **Catalog-only `Getattr`/`Lookup`/`Readdir`; materialize on `Read` only.** The
  VFS↔Materializer split (`vfs/vfs.go:7-13`) is genuinely provider-neutral. → E1
- **M2 — the probe cache, checked BEFORE materialization.** Content-addressed on the durable
  identity triple, write-once, best-effort, never-on-correctness-path, all-or-nothing hit
  contract. → E1
- **M5 — the four-layer suppression ladder**, with the content-addressed probe cache as the
  zero-cost layer. → E4
- **The error taxonomy**: permanent (`ErrPurged`) vs. recoverable (`ErrLinkExpired` /
  `errCDNUnreachable` / `errCDNThrottled`). → E3
- **Patient bounded backoff over fast failure for stream reads**; 416 → clean EOF;
  200-at-offset>0 → hard error. → E3
- **Admission control with refcount pinning** — never evict an actively-read placement. → E3/E4
- **The `inflight` + `deferToInflight` pattern** — solves reaper-races-first-read, which
  HashSucker will hit. → E4

### Do NOT copy

- **`rootNode.Readdir` stub** (`fs.go:282-294`) — fatal for WebDAV.
- **`size = 1` fabrication** (`server.go:420-423`).
- **Zero timestamps everywhere** (`fs.go:433-438`) — use the provider completion time, like Zurg.
- **English-substring error classification** (`torbox/client.go:481-487`, `engine.go:1021-1027`).
- **`AttrTimeout: 1s` as the only invalidation mechanism**, with zero `Notify` calls.
- **Boot-reconcile-by-delete-everything** (`engine.go:289-316`).
- **All read errors → `EIO`** (`fs.go:466`).
- **The absent `Statfs`.**

### Where HashSucker can exceed lazarr

1. **Intent detection.** lazarr has none. HashSucker's WebDAV layer sees request patterns FUSE
   cannot expose, so the *first* scan — which lazarr pays for — is avoidable. → E2
2. **Durable placements.** lazarr's `track` is in-memory, so it must assume total loss on restart.
   HashSucker can re-adopt — at the cost of having to verify liveness.
3. **Multi-provider failover.** Eviction in lazarr is terminal (`StateError`). In HashSucker it is
   a *placement* problem, not a *release* problem. → E3
4. **Wire availability into the read path.** lazarr computes `CacheStatus` daily and ignores it
   during materialize. Closing that loop prevents doomed adds outright.
5. **Cache integrity.** Add the version tag and region checksum lazarr lacks.

### The one structural warning

> lazarr's grab path — the thing that populates the virtual catalog with names and sizes — depends
> absolutely on TorBox's free, non-mutating `checkcached`. `ARCHITECTURE.md:73-76` states plainly:
> *"RD has no free checkcached since 2024 (instant-availability endpoint removed!) — the grab
> path's 'size without adding' primitive must be rethought per provider."*

For at least one of HashSucker's two providers, the "learn file names + sizes without mutating the
account" primitive **does not currently exist** (Q6). The VFS half of this architecture is proven
by lazarr. The catalog-population half is not, for Real-Debrid.

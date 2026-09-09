# Plex ↔ VFS I/O forensics — the measured behaviour the moonshot runs against

**Prior in-house study, dated 2026-08-30.**
**Source:** `C:\Users\patri\Documents\WorkBuddy\research\plex-vfs-forensics\PLEX-VFS-FORENSICS.md` (396 lines, read in full)
**Companion:** `zurg-re\CORPUS\` (22 files, ~450 KB) — see `06-zurg-re.md`
**Mode of the original:** research only. No HashSucker, Plex, rclone, mount, service, or provider
configuration was read, changed, or touched.
**Method:** public web sources + public rclone source (`master`, cloned 2026-08-30) + public issue
trackers (rclone, zurg, riven) + rclone/Plex Discourse archives.

**Evidence grades used below:** **[Doc]** vendor documentation · **[Src]** source code ·
**[Maint]** maintainer statement · **[Meas]** measurement/trace · **[Comm]** repeatable community
observation · **[Inf]** inference

> ### Why this file exists in the moonshot survey
> Every other document in this survey describes *what some codebase does*. This one describes
> **what Plex and rclone will actually do to whatever we build**. It is the closest thing we have
> to a load specification for E1 and E2 — and it contains the single most uncomfortable fact in
> the whole corpus (§4): **a VFS that looks real makes Plex read more, not less.**

---

## 1. Executive diagnosis — five bottlenecks, ranked

For the specific architecture `Plex → FUSE/WinFsp → rclone → WebDAV → HashSucker resolver →
provider URL → Real-Debrid/TorBox`.

### A1. Plex's scheduled maintenance = whole-file reads, per item, repeatedly
**Cost: extreme. Confidence: High.**

Plex has a scheduled task whose documented purpose is *"an extensive bitrate analysis on each file
in your library"* **[Doc — Plex "Scheduled Tasks"]**. "Upgrade media analysis during maintenance"
re-analyzes files whenever Plex bumps its analysis version; the CLI equivalent is documented as
`--analyze-deeply — Fully read and perform deep media analysis` **[Doc — Plex Media Scanner CLI]**.

On local disk this is invisible. On our path it means **every item in the library is streamed
end-to-end through the resolver to the provider**, during every maintenance window, and again on
every PMS upgrade that bumps the analysis version.

Field confirmation: *"Perform extensive media analysis during maintenance - off: … does a full
download of files"* **[Comm — rclone forum 31492]**; and a user with **all** analysis and thumbnail
features disabled still saw **4.1 TB/month** of mount reads that spiked only when new content was
added **[Comm — rclone forum 13635]**.

### A2. Directory enumeration / stat storms, amplified by a short `--dir-cache-time`
**Cost: high. This is the most likely cause of "library interaction" sluggishness. Confidence: High.**

rclone's WebDAV backend implements **no change-notification interface**
**[Src — `backend/webdav/webdav.go`: no `ChangeNotify`]**. Therefore `--poll-interval` is a **no-op**
on a WebDAV remote **[Doc]**, and the only refresh mechanisms are (a) `--dir-cache-time` expiry,
(b) `SIGHUP`, (c) `rclone rc vfs/forget` / `vfs/refresh`.

Every expiry means rclone re-issues a `PROPFIND` per directory and re-stats every entry. Plex
re-walks library directories on: every scan, every "Refresh local metadata every three days" task
**[Doc]**, every manual/partial refresh of a parent folder, and every inotify-less polling cycle.

Zurg ships `--dir-cache-time 10s` **[Src — zurg `docker-compose.yml`]** — necessary for fast
visibility of newly-added debrid torrents, but a scan of a 10k-item virtual library can re-PROPFIND
the entire tree **every 10 seconds while it runs**. For HashSucker, each PROPFIND entry is
candidate/resolver work.

> **This is the direct, measured justification for E1.** "Make PROPFIND free" is not an elegance
> goal; it is the difference between a 10-second PROPFIND storm and a 10-second no-op.

### A3. `open → seek → read a few KB → close` defeats all read-ahead
**Cost: high — this is playback-start and seek latency. Confidence: High.**

Confirmed at source level:

- Every `readAt` at an offset different from the current one is a seek
  **[Src — `vfs/read.go`: `doSeek := off != fh.offset`]**.
- A seek forces the chunked reader to reopen: `cr.offset = -1`
  **[Src — `fs/chunkedreader/sequential.go`, `RangeSeek`]**.
- On reopen, rclone only reuses the backend connection if the current reader implements
  `fs.RangeSeeker`. **WebDAV does not** **[Src — `backend/webdav/webdav.go`, no `RangeSeek`]**. So
  rclone performs a **brand new `o.Open()` with a fresh `Range:` header**
  **[Src — `sequential.go`, `openRange()`]** — a brand new HTTP request, new redirect traversal,
  new resolver hit.
- Worse: `RangeSeek` **resets the chunk size back to `--vfs-read-chunk-size`**, discarding the
  doubling ramp **[Src — `sequential.go`: `cr.chunkSize = cr.initialChunkSize`]**.

Stated by an rclone maintainer and a top community contributor:

> *"the media player seeking around the file reading small bits of data to find out about the video
> file (eg read the bit rate, load the thumbnail etc) - this is quite time consuming as each seek
> takes a second or two"* — **ncw [Maint, rclone forum 12290]**
>
> *"Open/seek/close/open/seek/close is a very inefficient cloud storage use case which mitigated a
> bit with cache mode full."* — **Animosity022 [Maint, rclone forum 27653]**
>
> *"If you open a file, only read a few bytes and close it, it won't continue to read ahead, because
> you closed the file."* — **Animosity022 [Maint, rclone forum 27653]**

Measured shape during Direct Play — hundreds of opens per minute on one file, each reading ~5 MiB
then closing **[Meas — rclone forum 6524]**:

```
19:23:54 DEBUG : ...S01E03.mp4: Open: flags=O_RDONLY   (×100+/minute)
19:25:30 DEBUG : ...S01E03.mp4: ChunkedReader.Read at 2471489536 length 1048576 chunkOffset 2452619264 chunkSize 134217728
19:25:30 DEBUG : ...S01E03.mp4: Flush: fh=0x0
19:25:30 DEBUG : ...S01E03.mp4: Release: fh=0x0
```

### A4. The rclone chunk-size defaults are exactly wrong for a probing reader
**Cost: high. Confidence: Medium-High.**

Defaults: `--vfs-read-chunk-size 128Mi`, `--vfs-read-chunk-size-limit off` (unlimited doubling),
`--vfs-read-chunk-streams 0`, `--buffer-size 16Mi`, `--vfs-read-ahead 0`
**[Src — `vfs/vfscommon/options.go`, `fs/config.go`]**.

> **A 4 KiB probe at a fresh offset issues a 128 MiB range request.** If Plex then seeks again
> 200 ms later, that 128 MiB transfer is abandoned and a new one starts. This is the single biggest
> source of read amplification on the probe path — and **it is a default, not a misconfiguration by
> anyone.**

Conversely the unlimited doubling means a long sequential playback ramps chunk size to
multi-hundred-MiB, pinning provider connections and making any seek catastrophically expensive.

### A5. Repeated resolution because nothing coalesces across file handles
**Cost: medium-high, and it is the seam we can most cheaply fix. Confidence: Medium.**

rclone creates an independent chunked reader per file handle, and in `--vfs-cache-mode full` can
spawn **multiple concurrent downloaders for different ranges of the same file**
**[Src — `vfscache/downloaders/downloaders.go`, `_ensureDownloader`]**. Plex legitimately has
several simultaneous consumers of one item (media server HTTP read, scanner/analyzer, thumbnailer).
Each open and each seek is a separate HTTP GET; if HashSucker resolves per-request, that is N
resolver calls and N provider URL fetches for one logical file.

Riven independently shipped settings for exactly this: `url_cache_ttl_minutes` (**provider URL
cache**), `max_concurrent_requests_per_file`, `enable_request_serialization`, `readahead_buffer_mb`
**[Src — riven PR #1150]**, motivated by *"Fixed 4MB buffer size causes frequent HTTP requests for
4K content"*.

---

## 2. The Plex I/O lifecycle

```
1. CHANGE DETECTION
   Plex waits for an OS notification (inotify / FSEvents / ReadDirectoryChangesW).
   On FUSE/WinFsp + rclone: unreliable or absent  [Doc — Plex Library]
   -> fallback is periodic scan (15min..daily) or an explicit API call.
        |
        v
2. DIRECTORY WALK                       readdir + stat/getattr on EVERY entry
   Plex compares (path, size, mtime) against media_parts in its SQLite DB.
   Cheap locally; on the VFS each stat is a cached-or-PROPFIND lookup.
        |
        v
3. PROBE / ANALYZE  (new or changed items only)
   open(O_RDONLY)
     -> read container header              (small, head of file)
     -> seek to % offsets for thumb/fanart (--thumbOffset/--artOffset)  [Doc]
     -> seek to tail for container index / duration refinement
     -> possibly decode a few frames
   close
   Measured equivalents on rclone mounts: ffprobe ~5 MB/file, mediainfo
   ~40 MB/file; Plex believed closer to mediainfo.  [Meas — rclone issue 1518]
        |
        v
4. OPTIONAL ANALYSIS JOBS (each is a separate pass, often a separate open)
   - video preview thumbnails (BIF) ..... full decode of the file
   - chapter thumbnails ................. seek+decode per chapter
   - intro markers ...................... audio fingerprint over the file
   - credits markers .................... end-of-file analysis + file hash
   - loudness / sonic analysis .......... full audio read (music)
   - extensive (bitrate) analysis ....... full file read
   - deep analysis (--analyze-deeply) ... documented "fully read"
        |
        v
5. PLAYBACK OPEN (Direct Play)
   Plex's HTTP media server opens the source per client range request,
   not per session.  Client behaviour determines open/seek/close frequency.
   Observed: hundreds of open/close per minute.  [Meas — rclone forum 6524]
        |
        v
6. RANGE READS / SEEK
   steady state: sequential 1 MiB reads inside a 128 MiB chunk
   user seek:    abandoned chunk -> new chunkedreader -> new ranged GET
   audio/subtitle switch: new probe pass -> new seeks
```

---

## 3. Ranked expensive Plex behaviours

| # | Plex feature / operation | Filesystem behaviour | Remote cost | Conf. |
|---|---|---|---|---|
| 1 | **Extensive media analysis during maintenance** | Full sequential read of every file | **Whole library per maintenance window** | High |
| 2 | **Video preview thumbnails (BIF)** | Full decode; "akin to transcoding the file" | Whole file per item; 10–50 MB index | High |
| 3 | **Upgrade media analysis during maintenance** | Re-runs analysis on stale-version items | Whole affected library after any PMS analysis bump | High |
| 4 | **Library scan / directory walk** | `readdir` + `stat` on every entry; per-directory PROPFIND on cache expiry | One PROPFIND per directory per expiry; dominated by `--dir-cache-time` | High |
| 5 | **Refresh local metadata every three days** | Walks directories for sidecar subtitles/artwork | Same as #4, forced, library-wide, every 3 days | High |
| 6 | **Credits / intro markers** (default: "scheduled task **and when media is added**") | End-of-file analysis + full audio fingerprint; a file **hash** is computed | Full-audio read + a hash pass; runs at add time by default | Med-High |
| 7 | **Probe-time scattered seeks** | `open → seek → read KB → close`, repeated | One new ranged GET per seek; each chunk-sized | High |
| 8 | **Direct Play open/close storm** | 100s of `open/read ~5MiB/close` per minute on one file | Per-open chunk priming; cheap only if VFS cache is hot | High |
| 9 | **Chapter thumbnails** | seek + decode at each chapter | N seeks per item (N = chapter count) | Medium |
| 10 | **Loudness / sonic analysis** (music) | Full audio read | Whole file — music libraries only | High |
| 11 | **Empty trash automatically after every scan** | Metadata deletion, not I/O — but a transient mount drop makes Plex delete metadata for "missing" files | No direct I/O; **severe correctness risk** | High |
| 12 | **Transcode workers** | Separate `Plex Transcoder` process opens the source again, seeks independently | Duplicate concurrent handles on one file | Medium ([Inf], unproven) |
| 13 | **`--analyze-deeply`** | Documented "Fully read and perform deep media analysis" | Whole file, on demand | High |

### Read-amplification numbers that exist

| Measurement | Value | Source |
|---|---|---|
| `avprobe` metadata probe through rclone mount | ≈ **5 MB/file** | [Meas] rclone issue 1518 |
| `mediainfo` metadata probe through rclone mount | ≈ **40 MB/file** | [Meas] rclone issue 1518 |
| Plex probe (estimated, not directly measured) | "closer to mediainfo than avprobe" | [Meas/Inf] rclone issue 1518 |
| Mount downloads with **all** analysis + thumbnails **off** | **4.1 TB/month** vs <500 GB actual playback | [Comm] rclone forum 13635 |
| Direct Play read granularity | 1 MiB reads inside a 128 MiB chunk | [Meas] rclone forum 6524 |
| Open rate during Direct Play | hundreds/minute on one file | [Meas] rclone forum 6524 |
| Playback start dead time attributed to seek-probing | **20–25 s** before any network activity | [Meas] rclone forum 12290 |

> ### ⚠️ Do not size a cache from the 5 MB / 40 MB figures
> The original study flags this explicitly (§I.1): the one quantitative probe figure is **from
> 2017, from a different Plex version**. It is an order-of-magnitude hint, not a measurement of
> our stack.

---

## 4. §CONTRADICTION — making the VFS look real makes Plex read MORE, not less

This is the most uncomfortable finding in the corpus and it bears directly on the moonshot's
central hypothesis.

The `.strm` accident: with `.strm` files, Plex's scanner, Analyze, intro/credits detection and BIP
generation all open a **40-byte file** and read 40 bytes. They run just as often; they just cost
nothing.

> **With a VFS exposing a real-size virtual file, those same jobs read real bytes — and rows
> 1, 2, 3, 6 and 9 of §3 are whole-file or full-audio-read operations.** A library that Plex
> previously waved at 40 bytes at a time would now be read end-to-end, per item, on a schedule.

**The 4.1 TB/month measurement is the floor, not the ceiling** — that user had *all* analysis and
thumbnail features disabled.

**This reframes E1 and E2 sharply:**

- E1 (providerless probes) is not merely nice-to-have. Without it, a VFS with real sizes converts
  Plex's scheduled maintenance into a provider-bandwidth event.
- E2 (the playback trapdoor) is not merely about avoiding materialization. It is about **ensuring
  the routine-probe path stays cheap even when Plex asks for real bytes**.
- **A head/tail cache (§7 G6) is not sufficient** — extensive analysis, BIF and loudness analysis
  are *whole-file* reads. No head/tail window absorbs them.

> ### The honest conclusion
> A trustworthy VFS and a cheap VFS are in tension, and the tension is with **Plex's scheduled
> jobs**, not with playback. The moonshot must either (a) suppress those jobs out-of-band
> (§8 F1/F2 — the partial-refresh pattern every debrid stack converges on), or (b) accept that
> "looks real" has a bandwidth price and budget for it explicitly.

**Cross-reference:** this is the same conclusion `04-plex-strm-proxy.md` §9 reaches from the
opposite direction — that proxy does **not** see Plex's scanner, Analyze, intro/credits or BIP
traffic at all, because those run in-process reading files off disk. Two independent routes, one
finding.

---

## 5. Direct Play is NOT the cheap case

| | Direct Play | Direct Stream (remux) | Transcode |
|---|---|---|---|
| Who reads the file | Plex Media Server's HTTP media handler | `Plex Transcoder` (ffmpeg) | `Plex Transcoder` (ffmpeg) |
| Open pattern | **One open per client HTTP request, not per session** | Single long-lived handle + seek | Single long-lived handle + seek |
| Startup | Header probe + client-driven first range | Probe + remux init | Probe + full codec init, often a second probe |
| Seek behaviour | Client issues a new range request → Plex may re-open | ffmpeg seeks in place | ffmpeg seeks in place |
| Extra handles | Plex server + (concurrently) scanner/analyzer/thumbnailer | + transcoder | + transcoder (+ EasyAudioEncoder for audio) |

> *"I have seen this with some Plex clients on TVs, like Samsung. they don't keep the connection
> open but instead only read some bytes, close the connection and open it again for the next
> bunch."* — **Seuffert [Comm, rclone forum 6524]**

Animosity022 could not reproduce it on other clients (ATV, PMP) — so **the open/close storm is
client-dependent, not universal**.

**Consequence:** with `--vfs-cache-mode full` these re-opens are local and nearly free. Without it,
each one is a fresh chunk-sized ranged GET through the resolver. **This is the strongest single
argument for the VFS cache being on in a Direct-Play-first design.**

**Not proven:** whether `Plex Transcoder` reopens the source separately from the media server's
handle (#12), and whether transcode changes the probe pattern materially.

> **Relevant to E2:** if the open/close storm is client-dependent, then any intent classifier that
> keys on "one long-lived handle" will misclassify. Conversely a classifier that keys on
> "sustained sequential offset advance over N seconds, aggregated across handles" is robust to it.

---

## 6. rclone tuning — the verdicts that matter

| Flag | Default | What it actually does | Verdict for this stack |
|---|---|---|---|
| `--vfs-cache-mode` | `off` | `full`: read-only opens go through `openRW` → on-disk cache item **[Src `vfs/file.go` Open]** | **`full` is the single highest-value setting.** Turns Plex's open/seek/close storm into local disk hits. Trade-off: it turns probes into real downloads — pair it with a chunk/head limit. |
| `--vfs-read-chunk-size` | `128Mi` | Size of the ranged GET on **every** open/seek. Also the size a seek **resets back to** **[Src `sequential.go` RangeSeek]** | **Lower it.** 128 MiB per 4 KiB probe is the core amplification. Start `8M`–`32M`. Budget: chunk ≥ a few seconds of worst bitrate (80 Mbps ≈ 10 MB/s → 32M ≈ 3 s). |
| `--vfs-read-chunk-size-limit` | `off` (unlimited) | Caps the doubling ramp | **Set a cap.** `256M`–`1G`. Ignored when `--vfs-read-chunk-streams > 0` **[Doc]**. |
| `--vfs-read-chunk-streams` | `0` | `>0` → fixed-size **parallel** chunks (no doubling, limit ignored) | **Risky here.** Multiplies concurrent provider connections per file — exactly §A5. Only `2`–`4` with a small chunk size, and only with resolver coalescing. |
| `--buffer-size` | `16Mi` | In `full` mode used only as the "window" for deciding whether to start another downloader **[Src `downloaders.go`]** | In `full` mode it does **not** behave like read-ahead. Don't raise it expecting faster playback. Memory cost = `buffer-size × open files`. |
| `--vfs-read-ahead` | `0` | Extra bytes added to every cache download range, on disk, **only in `full` mode** **[Src `downloaders.go`: `r.Size += ReadAhead`]** | **This is the real read-ahead in `full`.** `64M`–`256M` makes the *next* seek local. Pure amplification if the probe never re-reads. Tune against seek latency, not throughput. |
| `--vfs-read-wait` | `20ms` | Used **only** by `ReadFileHandle`, i.e. **only when NOT using an on-disk cache file** **[Doc; Src `vfs/read.go` waitSequential]** | **Inert under `--vfs-cache-mode full`.** Circulated zurg/rclone lines pairing `--vfs-read-wait 5s` with `--vfs-cache-mode full` are no-ops in that combination. |
| `--dir-cache-time` | `5m` | Directory listing trust. **With WebDAV this is the only refresh mechanism.** | **The main trade-off knob.** If HashSucker can push change notifications out-of-band (`rclone rc vfs/forget dir=…`), raise it to hours. Otherwise 5–60 min and drive updates explicitly. |
| `--poll-interval` | `1m` | Backend change polling | **No-op for WebDAV.** Remove it to avoid believing it works. |
| `--attr-timeout` | `1s` | Kernel attribute cache | Raising (10s–1m) removes a large volume of `Getattr` during scans. **Safe only if file sizes never change behind rclone's back** — on a dynamic VFS rclone warns this can cause apparent truncation. |
| `--no-checksum` / `--no-modtime` | `false` | Skips hash/modtime handling | `--no-checksum` is a no-op for `vendor=other` WebDAV today, but cheap insurance if the vendor is ever changed. `--no-modtime` saves a `PROPFIND` per stat on some backends. |
| `--vfs-cache-max-age` / `-max-size` | `1h` / off | Cache eviction | With `full`, keep `max-age` long enough to survive browse → play → seek (hours). |
| `--links` | off | Symlink support | **Required on Windows** if the tree contains symlinks: `ERROR : symlinks not supported without the --links flag: /` **[Src zurg WINDOWS.md]** |
| `--webdav-pacer-min-sleep` | `10ms` | Minimum sleep between WebDAV API calls | zurg ships `pacer_min_sleep = 0` **[Src zurg rclone.conf]**. On a localhost WebDAV with a fast resolver this removes an artificial 10 ms floor on every request. |

### Does the advice differ by backend?

| Backend | Key difference |
|---|---|
| Ordinary cloud (S3/GCS/B2) | High latency, tolerant of many parallel range requests → `--vfs-read-chunk-streams` is a real win **[Doc]**. |
| **WebDAV (our case)** | **No ChangeNotify, no RangeSeeker.** Every seek = new HTTP request. Polling flags inert. Latency is usually low (localhost) so **the cost is request count, not bandwidth**. |
| **Debrid-backed / dynamically resolved URL** | Every new ranged GET may mean a **new provider URL resolution + new redirect**. **The cost of a seek is not bytes, it is resolution + connection setup.** This **inverts the usual advice**: you want *fewer, larger, longer-lived* requests and aggressive URL caching, not more parallelism. |
| Local disk | None of this matters. |

> That last row is the one that matters for the moonshot. Standard cloud-tuning folklore
> (parallelism, small chunks, aggressive read-ahead) is **exactly wrong** for a debrid-backed
> WebDAV, because our marginal cost per request includes provider API work.

---

## 7. The six resolver/VFS seams (G1–G6), ordered by expected payoff

**G1. Per-request URL resolution. Highest payoff.**
Because WebDAV has no `RangeSeeker`, **every rclone seek is a brand-new HTTP GET**. If the resolver
runs per request, one Plex probe (open + 3 seeks + close) = **4 resolver calls + 4 provider URL
fetches + 4 redirect traversals for ~50 KB of actual data.**
*Seam:* memoize `stable resolver path → provider delivery URL` with a TTL (Riven's
`url_cache_ttl_minutes` is the same idea). Also memoize resolved size and `Last-Modified`, since
rclone re-stats constantly.
*Measure first:* count distinct resolver invocations per single Plex probe.

**G2. Concurrent duplicate range requests for one file.**
`--vfs-cache-mode full` can open several downloaders for different ranges of one file, and Plex
holds several handles. Each is an independent provider connection.
*Seam:* per-file request coalescing / dedup, and a cap on concurrent upstream streams per logical
item (Riven's `max_concurrent_requests_per_file` + `enable_request_serialization`).

**G3. Directory enumeration cost.**
Every `--dir-cache-time` expiry turns into a PROPFIND per directory.
*Seam:* make `PROPFIND` on an unchanged directory **free** — serve it from HashSucker's own state
with no provider round-trip, and expose an out-of-band invalidation so the rclone dir cache can be
long-lived.

**G4. Redirect traversal and auth on every range request.**
rclone's WebDAV `Object.Open` sets `AuthRedirect` from config and re-follows the provider redirect
on every new GET **[Src — `backend/webdav/webdav.go`]**.
*Seam:* resolve to the final URL once (G1) and serve it directly; keep HTTP keep-alive on the
provider side so a new range does not mean a new TCP+TLS handshake.

**G5. Range handling correctness — a hard requirement, not an optimization.**
rclone calls `fs.FixRangeOption` then `rest.CheckContentRange`; if a server ignores `Range` and
returns `200` with the full body, rclone raises `fs.ErrorRangeIgnored` and **returns an error
without retrying** **[Src — `backend/webdav/webdav.go` `Object.Open`]**.
*Seam:* HashSucker's WebDAV **must** honour `Range` with a real `206` + correct `Content-Range`,
and must accept `Range: bytes=N-` (open-ended, to EOF) — exactly what rclone emits when
`--vfs-read-chunk-size` is exceeded or on the final chunk **[Src — `sequential.go` `openRange`]**.

> **G5 is a correctness gate for the whole moonshot.** A probe-cache implementation that returns
> `200` with a full body instead of a proper `206` does not degrade — it **errors out without
> retry**. This is the concrete form of the "synthetic bytes must never be mistaken for
> authoritative content" constraint.

**G6. Small caching layers worth evaluating later (measure before building).**
- A tiny **head cache** (first ~2–8 MiB per item) absorbs most container-header probes.
- A **tail cache** (last ~2–8 MiB) absorbs container-index / duration / credits-detection reads.
- Both are cheap because Plex's probe offsets are highly repeatable across scanner, analyzer and
  playback startup. **Do not build these before the H1/H2 experiments confirm the offset
  distribution.**

> **Independent corroboration of torrg's probe window (§`01` §2) and lazarr's
> `defaultProbeRegionBytes` (§`05` §3.2).** Three unrelated sources converge on head 2–16 MiB /
> tail 2–8 MiB. That convergence is the strongest empirical support E1 has.

---

## 8. Ecosystem lessons — the eight patterns every debrid stack converges on

**What zurg actually ships** **[Src — official `docker-compose.yml`]**:

```
mount zurg: /data --allow-other --allow-non-empty --dir-cache-time 10s --vfs-cache-mode full
```
```ini
[zurg]
type = webdav
url = http://zurg:9999/dav/
vendor = other
pacer_min_sleep = 0
```
Config: `check_for_changes_every_secs: 10`, and on every library change:
```yaml
on_library_update: sh plex_update.sh "$@"
```
`plex_update.sh` fires the **partial-refresh URL** per section **[Src]**:
```
GET /library/sections/{id}/refresh?path={urlencoded absolute path}
```

**Read of that config:** zurg trades a very short dir-cache for fast visibility, compensates with
`--vfs-cache-mode full`, and — critically — **never asks Plex to scan the whole library**. It has
an out-of-band change signal (its own 10 s RD poll) and converts it into a targeted Plex refresh.

### The eight patterns

1. **Never full-scan.** Every debrid stack converges on this: detect the change yourself, then
   issue the narrowest possible Plex refresh. `plex_autoscan` exists entirely for this — *"Plex
   will then only scan the parent folder … versus scanning the entire library folder"* — plus
   request batching/merging so a season drop is one scan **[Src — l3uddz/plex_autoscan README]**.
2. **Force a VFS directory refresh out of band.** `plex_autoscan` sends `rclone rc` cache-expire /
   `vfs/refresh` for the file's parent folder when the existence check fails, and retries up a
   level **[Src]**. **This is how you get a long `--dir-cache-time` *and* fast visibility — the two
   goals stop being in conflict.**
3. **Protect against transient mount drops.** `PLEX_EMPTY_TRASH_MAX_FILES` aborts the empty-trash
   call if too many files "went missing" — *"particularly useful when externally mounted media
   temporarily dismounts and a ton of files go 'missing' in Plex"* **[Src]**.
4. **Retry the file-existence check before scanning.** `SERVER_MAX_FILE_CHECKS` /
   `SERVER_FILE_CHECK_DELAY` **[Src]** — acknowledgement that a virtual FS is eventually consistent.
5. **Cache the provider URL.** Riven PR #1150 adds `url_cache_ttl_minutes`, *"Provider URL cache
   duration"* **[Src]**. The resolver seam, independently discovered.
6. **Serialize / bound concurrency per file.** Riven adds `enable_request_serialization` and
   `max_concurrent_requests_per_file (1–10)` **[Src]**.
7. **Solve the stuck scanner.** zurg's headline claim: *"If you've ever experienced Plex scanner
   being stuck on a file and thereby freezing Plex completely, it should not happen anymore because
   zurg does a comprehensive check if a torrent is dead or not"* **[Doc — zurg README]**.
   **The lesson: a VFS that blocks, or returns an error slowly, freezes Plex's scanner. Fail fast
   on unresolvable items.**
8. **Windows needs `--links`** when the tree contains symlinks **[Src — zurg WINDOWS.md]**.

> **Pattern 7 is the sharpest operational constraint on E3.** An unresolvable item must fail fast
> and terminally, not block. lazarr reaches the same conclusion independently (`StateError`
> fast-fail, §`05` §4.2).

### Folklore in circulation, with the correction

From a community mount line in zurg issue #133:
```
--dir-cache-time 50h --poll-interval 30s --vfs-cache-mode full
--vfs-read-wait 5s --vfs-read-chunk-size 4M --vfs-read-chunk-size-limit 1024M
--no-checksum --no-modtime --vfs-read-ahead 10g --cache-info-age 100h
```
- `--poll-interval 30s` → **no-op on WebDAV**.
- `--vfs-read-wait 5s` + `--vfs-cache-mode full` → **no-op**.
- `--cache-info-age` → obsolete; replaced by `--dir-cache-time`.
- **The parts that are real:** `--vfs-cache-mode full`, small `--vfs-read-chunk-size` with a bounded
  limit, large `--vfs-read-ahead`, `--no-checksum --no-modtime`.

---

## 9. The eight lowest-risk experiments (H0–H8)

All bounded, reversible, observation-only unless marked. **None require modifying HashSucker, Plex,
or the running rclone mount** except where flagged "requires a restart".

**H0 — Precondition: know your current state (read-only, 2 min).** Record, do not change:
`rclone version`, the exact mount command line, the rclone remote config (secrets redacted), the
mounted path, and whether `--rc` is enabled. If `--rc` **is** enabled, most of H1 is free with no
restart: `rclone rc vfs/stats`, `core/stats`, `vfs/list`.

**H1 — What is Plex actually asking the filesystem for?** Windows: Sysinternals **Process Monitor**
(portable, no install). Filter `Process Name` ∈ {`Plex Media Scanner.exe`, `Plex Media Server.exe`,
`Plex Transcoder.exe`, `rclone.exe`}, `Path` begins with the mount path, File System activity only.
Linux: `fatrace -c -t` or `strace -f -e trace=openat,read,lseek,close,getdents64,newfstatat -p <pms-pid>`.
Actions: (a) browse one folder, (b) play one file 60 s, (c) seek 3×, (d) switch audio once, (e) stop.
**Extract:** `open` counts per file; `getdents` counts; **the distribution of read offsets and
lengths.**
*Why:* the only way to get §2 step 3/4 offsets for *our* files. Everything else is inference from
other people's systems.

**H2 — What is crossing the wire between rclone and HashSucker?** Capture loopback HTTP (Windows:
RawCap or Wireshark; Linux: `tcpdump -i lo -w cap.pcap port 9999`). Reproduce H1's five actions.
**Count:** total requests; `PROPFIND` vs `GET` vs `HEAD`; per-GET `Range:` start offset and length;
status (`206` vs `200` vs `3xx`); aborted requests.
*Why:* converts filesystem behaviour into the exact request stream HashSucker receives. Directly
proves/disproves §1 A2, A3 and §7 G5. A rclone `--log-level DEBUG` log captures the same
information but requires a mount restart.

**H3 — Read-amplification arithmetic (pure analysis of H2).** Per action:
`bytes requested by Plex (H1) ÷ bytes fetched over HTTP (H2)`. Expect ≈1 for steady playback and
10×–1000× for probing. **Specifically:** for a 4 KiB probe at offset X, how many bytes did rclone
request? If ~128 MiB, §1 A4 is confirmed.

**H4 — Isolate Plex's maintenance window.** Capture across one full maintenance window, or
manually `Analyze` **one** item from the Plex Web UI during a capture. *Why:* proves §1 A1/A2
directly. If one `Analyze` on a 30 GB item produces ~30 GB of range requests, the extensive-analysis
hypothesis is settled.

**H5 — Test the partial-scan path end to end.** Create/rename one item in one leaf directory
(throwaway name, not real media). Capture H1/H2 while manually issuing
`GET http://<pms>:32400/library/sections/<id>/refresh?path=<url-encoded absolute dir path>`.
**Confirm:** (a) returns 200 immediately; (b) Plex's filesystem activity touches **only** that
directory; (c) how many PROPFINDs one refresh costs. *Why:* the "one new VFS item must not touch the
whole library" test. Requires PMS ≥ 1.20.0.3125 **[Doc]**.

**H6 — Prove the resolver is being hammered (HashSucker side, read-only).** Turn up request logging
and, for a single item, count resolver invocations, provider URL resolutions, redirect hops, and
distinct upstream connections across: one scan, one playback start, three seeks. *Why:* gives the
G1/G2/G4 numbers directly. If resolver calls ≈ ranged-GET count from H2, there is zero coalescing
and G1 is the highest-ROI change.

**H7 — Isolate the client variable.** Repeat H1 with **two different Plex clients** on the same
file. *Why:* §5's open/close storm was client-dependent in the one trace that exists.

**H8 — A/B the VFS cache, on a throwaway mount only.** **Do not touch the production mount.** Start
a second mount of the same remote to a different empty mount point with
`--vfs-cache-mode full --vfs-read-chunk-size 16M --vfs-read-chunk-size-limit 256M --vfs-read-ahead 128M --dir-cache-time 30m`,
its own `--cache-dir`, and `--rc`. Play the same single file through it and compare. Unmount when done.

> **H1, H2 and H6 are the three that the moonshot must actually run**, and they are the source of
> the "before" column in every benchmark in the final deliverable. **None of them require live
> Plex on rightmon** — see §11.

---

## 10. What the Zurg RE corpus has since proven (and corrected)

The Plex/rclone study predates the Zurg binary RE by ~1 day and explicitly flags its own limit:

> **§I.8 (original):** *"zurg's internal WebDAV implementation is closed source (binaries only in
> the public repo). I read its config, compose file, and Plex-update scripts, but not its
> request-handling code. Claims about how zurg serves ranges are inference."*

The `zurg-re` corpus has since closed part of that gap with DWARF + disassembly. Updates to carry
forward:

| Original claim (2026-08-30) | Status after RE (2026-08-31 / 09-01) |
|---|---|
| "zurg serves PROPFIND from a model" [Inf] | **`PROVEN`** — complete call-target census for `ServeTorrentFilesForDav` contains no HTTP client, no `UnrestrictFile`, no `DownloadMap` access (`08-DAV.md` §2.3) |
| "size is pre-populated" [Inf] | **`PROVEN`** — `pkg/dav.File(name, f.Bytes, f.Ended)`; `f.Bytes` is offset 24, populated from `TorrentInfo.Files[].Bytes` in `convertToTorrent` (`08-DAV.md` §3.1) |
| "getlastmodified reflects provider completion" [Inf] | **`PROVEN`** — third argument is `f.Ended` (`08-DAV.md` §3.3) |
| "a VFS that blocks freezes Plex's scanner" [Doc] | **Corroborated structurally** — the DAV layer has **zero error paths**; broken files are pre-modelled as `broken_file` / `deleted_file` and skipped with `continue`, so the listing path can never block on a per-file failure (`08-DAV.md` §2.3) |
| "zurg coalesces requests" [Inf — hypothesis] | **`PROVEN: PARTIALLY FALSE`** — `singleflight` appears **exactly once** in 13,347 call edges, for archive inner-file listing only. The real anti-burst mechanism is rate limiting + the `DownloadMap` URL cache (`09-CACHE-CONCURRENCY.md` §1, §4) |

> **The most important correction for our purposes:** the "request coalescing" hypothesis that
> motivated G2 is **not** what the production system does. Zurg throttles at the provider boundary
> and caches the delivery URL, but does **not** deduplicate client reads. G2 remains valid as an
> optimization, but it is **not** validated by precedent.

### Also unresolved in both corpora

1. No syscall trace of Plex on *our* stack exists in public sources.
2. Exact read offsets Plex uses are unknown (`--thumbOffset` / `--artOffset` confirm percentage
   offsets, not values or container-specific behaviour).
3. Whether Plex reads the file tail on every scan or only on analysis — not established.
4. Whether intro/credits detection reads the entire audio stream — inferred, not measured.
5. Whether `Plex Transcoder` opens the source separately (#12) — unproven.
6. `--vfs-read-chunk-streams` against a debrid provider — untested; the recommendation against it
   is precautionary.
7. Whether rclone's `waitSequential` (~8 MiB gap heuristic) ever helps Plex — unclear.
8. Whether Plex's "Scan my library automatically" can ever work over rclone on Windows — unverified.
9. All rclone source statements are against `master` as of **2026-08-30**; defaults have changed
   before (notably `--vfs-read-chunk-size`). Verify with `rclone help flags | grep vfs`.
10. **Zurg's TorBox behaviour remains `SOURCE NOT AVAILABLE`** — every provider claim above is
    Real-Debrid specific.

---

## 11. Verdict — how this file constrains the moonshot

### The load specification for E1

A routine Plex library interaction on a 10k-item library, with `--dir-cache-time 10s`, costs
**one PROPFIND per directory every 10 seconds** during any scan, plus a `stat` per entry. Target:
**zero provider calls, zero materializations, stable exact size, stable durable identity.**

### The load specification for E2

A realistic playback produces: one header probe, then **hundreds of `open → read ~5 MiB → close`
per minute** (client-dependent), with occasional user seeks that each abandon an in-flight chunk.
A probe produces: `open → seek → read KB → close`, repeated at highly-repeatable offsets.
**Both are sequences of ranged GETs over the same HTTP surface.** The discriminator cannot be
request size, and (per §5) may not even be handle duration.

### Three hard constraints the experiments must respect

1. **G5 is a gate, not an optimization.** A `200` where a `206` is required causes rclone to error
   **without retrying**. Any synthetic-probe layer must produce byte-exact `206` + `Content-Range`,
   and must handle open-ended `Range: bytes=N-`.
2. **Fail fast on unresolvable items** (pattern 7). A slow error freezes Plex's scanner. This
   favours lazarr's terminal `StateError` fast-fail over any patient-retry-at-the-listing-layer
   design.
3. **The cost model is inverted** relative to normal cloud tuning. Marginal cost per request
   includes provider API work, so **fewer / larger / longer-lived requests beat parallelism.**
   `--vfs-read-chunk-streams` is a trap here.

### What we still cannot claim

**Nothing in this file is a measurement of HashSucker.** Every number is from another stack, and
the two most-quoted ones (5 MB/probe, 40 MB/probe) are from 2017. The H1/H2/H6 experiments are how
we convert all of it into our own before-numbers — and they are runnable in the Windows lab
without touching Plex on rightmon.

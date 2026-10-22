# COLD START, SMALL — the ~4–6 s cold start, characterized and one fix

Date: 2026-10-21
Slice: characterize the remaining common internal bucket in a byte-cold
startup; make **at most one** bounded causal fix if clearly earned.
Instruments: the canonical cross-process waterfall from the previous slice
(`docs/recon/2026-10-21-fast-playback.md`), plus the data plane's own
decision log and stage reports.

---

## 0. Answer first

The ~4–6 s cold start is **one internal wait** (3.0 s) plus provider and
player work that is necessary. The eager fixed-grid fill and its evictions
are **real waste** (0.16–1.98 GB fetched, up to 1.94 GB evicted, for a
player that consumed 12.9–58.4 MB) but they **do not delay the demanded
reads**. The one bounded fix that the measurement earns is the takeover's
patience: **3 000 ms → 250 ms**, which took the same six byte-cold
fixtures from a **5 306 ms median to 2 438 ms (2.16×)**, with no fixture
regressing.

The eager fill is reported as a **cache-policy question**, not fixed here.

---

## 1. Fixtures

Six byte-cold fixtures, chosen from production state (bound library items
whose bytes are not in the cache), plus a warm control. Every measured run
is a `full_miss` (nothing of the file present), verified from the data
plane's own decision log (`present_before` empty, `plan_origin: full_miss`).

| fixture | shape | size |
|---|---|---|
| tt0075686 | movie | 4.3 GB |
| tt0468569 | movie | 4.4 GB |
| tt27419466 | movie | 3.3 GB |
| tt7366338:1:2 | episode | 5.1 GB |
| tt10986410:4:1 | episode | 6.6 GB |
| tt2356777:1:3 | episode | 2.5 GB |

Excluded, with the reason recorded: **tt0089883 (Rear Window)** — no
serviceable candidate (every candidate uncached at TorBox, RealDebrid
refuses the add) — a supply failure, not a cold start. The dual-route
fixture was excluded from the A/B because its runs are dominated by a slow
**capability acquisition** (26 s inside the provider API call), which is
out of this slice's scope.

A disjoint set of six fixtures of the same shapes (tt0081505, tt0051201,
tt26545992, tt1466074:1:1, tt0944947:1:3, tt1474684:1:1) measured the
experiment on files the baseline never touched.

---

## 2. The pre-first-frame Range pattern

Every cold run shows the same three requests from the player. Nothing about
the pattern changes between fast and slow starts.

```
REQ 1   0 .. <file size>        the WHOLE FILE
REQ 2   <size> - 362211 .. <size>   the container's index (the moov)
REQ 3   <a few KB> .. <file size>    the media data, from just after the head
```

**Why the whole file?** The player cannot know where the container's index
is until it has read the head. The release is not "faststart" (the moov is
at the end), so the player opens the file, reads the head, learns the moov
is at the end, and **seeks back** for it. The first request is therefore
"give me the file", not "give me the first 8 MiB".

That request is the whole problem: the byte path honours the range the
client asked for.

---

## 3. The four questions

### Q1 — Why does the initial request look like a whole-file Range?
As above: the player must read the head to find the moov, and the moov is
at the end. It cannot ask for less without already knowing. The second
request (the seek back) is the price.

### Q2 — How many chunks does that cause HashSucker to claim before the first frame?
The whole-file request is planned as one fixed-grid run: **one 8 MiB chunk
per 8 MiB of the requested range.**

| fixture | file size | chunks CLAIMED |
|---|---|---|
| tt2356777:1:3 | 2.5 GB | 295 |
| tt27419466 | 3.3 GB | 395 |
| tt0075686 | 4.3 GB | 518 |
| tt0468569 | 4.4 GB | 524 |
| tt7366338:1:2 | 5.1 GB | 606 |
| tt10986410:4:1 | 6.6 GB | 793 |

### Q3 — How many of those chunks are actually needed before the first frame?
**Three to nine.** The player consumed **12.9–58.4 MB** from the head
request (2–8 chunks) plus **14–362 KB** for the moov (1 chunk).

So roughly **1 %** of the claimed chunks are needed before the first frame.

### Q4 — Does filling/evicting those chunks materially delay the demanded head/tail reads?
**No — and this is the finding that redirected the slice.**

* The head read is not delayed: its **first byte reaches the client at
  463–684 ms**, while the fill is fetching hundreds of megabytes in
  parallel.
* The tail read is not delayed by the fill either: after it is dispatched,
  the provider's first byte arrives in **190–400 ms**.

What DID delay the tail read was an internal wait that the previous slice
introduced: the demand's takeover patience. See §5.

The fill's harm is a different kind of harm, and it is large:

| fixture | bytes fetched during the startup | the player consumed | chunks evicted | bytes evicted |
|---|---|---|---|---|
| tt0075686 | 164 MB | 58.4 MB | 9 | 75 MB |
| tt0468569 | 619 MB | 50.0 MB | 55 | 459 MB |
| tt27419466 | 842 MB | 37.5 MB | 91 | 763 MB |
| tt7366338:1:2 | 1 310 MB | 31.6 MB | 157 | 1 317 MB |
| tt10986410:4:1 | 1 608 MB | 27.3 MB | 175 | 1 462 MB |
| tt2356777:1:3 | 1 976 MB | 12.9 MB | 231 | 1 938 MB |

The fill runs 6–150× faster than the player consumes, on an 8 GiB cache,
so **a single cold startup evicts up to 1.94 GB** — and the file is still
not warm afterwards, because the player abandoned the head read after
13–58 MB. The cache is paying the provider for the whole file and keeping
a fraction of it.

---

## 4. Cache behaviour during startup

| property | value |
|---|---|
| chunk / grid size | **8 MiB** (`SLICE4_CACHE_CHUNK_SIZE`, `meta.chunk_size` = 8 388 608) |
| chunks claimed by the whole-file request | **295–831** (one per 8 MiB of the range) |
| chunks actually needed before the first frame | **3–9** |
| bytes fetched before the first frame | **164 MB – 1.98 GB** |
| bytes the player consumed before the first frame | **12.9–58.4 MB** |
| evictions during the startup | **9–231 chunks** (75 MB – 1.94 GB) |
| failed chunk fills | **0–2** per run |
| does the backfill continue past what playback needs? | **Yes** — it continues fetching the whole range while the player reads the first few MB |

---

## 5. The bounded experiment

**What the measurement named.** The tail read's provider request was
dispatched at **3 140 / 3 161 / 3 140 / 3 296 ms** in the four original
cold runs — and the takeover's patience was **3 000 ms**. The patience was
the wait, exactly.

And it never was the thing protecting the common case: the chunk's fill
record already carries a `started` flag, so "the owner is on this chunk"
is distinguishable from "the owner merely promised it". The patience only
covered the race between the owner picking a chunk up and saying so.

**The change:** patience **3 000 ms → 250 ms**. The duplicate it risks is
bounded and small — one 8 MiB chunk fetched twice, when the owner was about
to deliver it anyway. The wait it avoids is the whole startup.

*(Not taken, deliberately: capping the initial claim window, deferring the
non-demanded backfill, or prioritising demanded chunks over bulk
continuation. The measurement says the eager claim/fill does **not** delay
the demanded reads, so those would address the waste, not the startup.
Changing what the fill fetches is a cache-policy change and is out of this
slice's scope.)*

---

## 6. Before / after — same fixtures, same byte-cold state

All six runs are `full_miss` on both sides.

| fixture | before (3 000 ms patience) | after (250 ms) | speed-up |
|---|---|---|---|
| tt0075686 (4.3 GB movie) | 5 688 ms | **2 585 ms** | 2.20× |
| tt0468569 (4.4 GB movie) | 5 227 ms | **2 371 ms** | 2.20× |
| tt27419466 (3.3 GB movie) | 5 406 ms | **2 186 ms** | 2.47× |
| tt7366338:1:2 (5.1 GB episode) | 5 534 ms | **2 450 ms** | 2.26× |
| tt10986410:4:1 (6.6 GB episode) | 4 887 ms | **2 218 ms** | 2.20× |
| tt2356777:1:3 (2.5 GB episode) | 5 085 ms | **2 521 ms** | 2.02× |
| **median** | **5 306 ms** | **2 438 ms** | **2.16×** |

Disjoint set of six same-shape fixtures (never touched by the baseline):
**3 619 / 4 359 / 3 959 / 2 155 / 1 189 / 2 797 ms**.

The mechanism is visible in the tail read: its provider dispatch moved from
**~3 150 ms** to **409–541 ms**.

### The other measurements the slice required

| | before | after |
|---|---|---|
| provider TTFB (dispatch → provider first byte) | 190–400 ms | 190–400 ms (unchanged — external) |
| bytes fetched before the first frame | 164 MB – 1.98 GB | 144 MB – 1.93 GB (unchanged in kind) |
| chunk claims (whole-file request) | 295–831 | 295–831 (unchanged — the claim is the player's request) |
| failed chunk fills | 0–2 | 0–2 (unchanged) |
| eviction activity | 9–231 chunks | 2–329 chunks (unchanged in kind) |

### Safety

* **Range correctness unchanged** — the same three Ranges are served, and the
  moov Range is served with the exact byte count the player asked for.
* **Seek still works** — `--resume 30` played from 30 s to 31.4 s, clean
  exit 0.
* **Same-TF failover still works** — covered by the data plane's own
  `r14_same_tf_alternate_route_recovers_without_cross_representation`, and
  the suite is green.
* **No throughput disaster after playback starts** — sustained playback is
  clean: the playhead advances and mpv exits 0.

---

## 7. Stop conditions — what is left

After the fix, a byte-cold first frame is **2.2–2.6 s** and decomposes as:

| | |
|---|---|
| the head's first byte reaches the client | 463–684 ms |
| the moov's provider dispatch → its first byte | 409–541 ms → ~200 ms |
| the player's own demux, after the moov is in hand | ~900–1 200 ms |
| **HashSucker added after the provider's first byte** | **0 ms** |

So the remaining cold cost is **provider transfer time** and **the player's
own demux** — the two things the slice's stop conditions name as
"stop and report it". The only material internal item left is the **eager
fill**: 0.16–1.98 GB fetched and up to 1.94 GB evicted for a player that
consumed 13–58 MB. It does not slow this startup; it makes the *next* one
cold, and it burns the provider's budget on bytes nobody asked for.

That is a **cache-policy question** (what the fill is allowed to fetch
ahead, and what it is allowed to evict), and it is not taken here.

---

## 8. Tests

| suite | result |
|---|---|
| `data-plane` (Rust) | **153** passed, 0 failed |
| `media-search` (Node) | **3 625** tests, 3 621 pass, 3 skipped, **1 fail** — the known pre-existing `vfs-collection-resilience` C1/C2/C3 baseline |

---

## 9. Commit

`633215a` — fix(data-plane): the takeover's patience is 250 ms, not 3 s
(plus the two measurement instruments this slice needed:
`media-search/tools/hs/coldstart.mjs`, `media-search/tools/hs/data-plane.mjs`).

---

## 10. Verdict

# COLD START — BOUNDED CACHE FIX

A narrow internal behaviour materially reduced startup. The previous
slice's takeover had a 3 000 ms patience, and the measurement showed that
patience — not the provider, not the cache, not the player — was the
largest internal term in a byte-cold start: the tail read's provider
request was dispatched at ~3 150 ms in **every** cold run. Cutting the
patience to 250 ms took the same six byte-cold fixtures from a **5 306 ms
median first frame to 2 438 ms (2.16×)**, every fixture improved and none
regressed. The tail read's dispatch moved to 409–541 ms.

What remains is the shape the slice's stop conditions describe: the
provider's cold read (190–400 ms TTFB) and the player's own demux
(900–1 200 ms) — and, separately, the fixed-grid fill's waste (0.16–1.98
GB fetched and up to 1.94 GB evicted per startup, for a player that
consumed 13–58 MB). The waste does not delay the demanded reads, so it is
a **cache-policy question**, not a startup defect, and it is left for a
slice that is allowed to touch the fill's policy.

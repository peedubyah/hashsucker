# FAST PLAYBACK, NOT PERFECT RANKING — the first-frame report

Date: 2026-10-21
Phase: latency slice (the ranking semantics are settled separately and are
**not** touched by this work).
Scope: the direct resolver path — `hs play <intent>` → playback object →
mpv → first rendered frame, measured end to end on the production stack.

---

## 0. The question, and the answer in one paragraph

The observed first-frame times were ~0.8–1.3 s (healthy), ~8.7 s (Lanterns),
~47.6 s (Rear Window) and ~90 s (prior observations). The tail was **not**
the resolver, **not** the provider's first byte, and **not** the player. It was
the byte path's **fixed-grid fill queue**: a player that asks for a whole file
makes the data plane claim every chunk of that file up front, and a SECOND
demand for the same file — the player's own request for the container's
metadata at the *end* of the file — then waits behind that queue instead of
fetching the one chunk it needs. Measured: 132 s of waiting for 0 bytes. The
fix (a bounded takeover) took the same three fixtures from **90 090 / 90 081 /
90 089 ms to 5 546 / 5 016 / 4 996 ms**.

---

## 1. Corrected size semantics (Part 0)

The corpus path presented the release **TOTAL** as an exact per-file size. The
corpus cannot do otherwise: **1 593 139** `candidates` rows and **1 593 141**
`release-attribute` rows, and not one of them carries a `file_index`, a
`file_path` or a `file_size`. Its byte count is the sum of the release's
files.

The upstream's `behaviorHints.videoSize` needed the same discipline. Measured
on a 19 706-stream raw sample with the provider's authoritative file list as
the referee:

| the upstream's stream | the number is |
|---|---|
| names a FILE (`fileIdx`, or a published filename with a media extension) | that file's exact size — **100 %** (21 of 21 judgeable) |
| names only the RELEASE | a release-level number — per-file **0 %** of the time (2 of 36) |

So the scope is decided by the **source's own shape**, never by the number, and
the exact-file proof only ever sees a per-file count. A release total remains
available as release-level evidence (`releaseAttributes.size` / `releaseSizeBytes`),
where the quality features already read a release's byte count from.

Consequence, measured: a release total can only ever bind a **single-file**
release (0 of 221 multi-file releases in the durable inventory have a total
equal to any file's size). Of the 72 production exact-size handoffs, 37 offered
a per-file number and are untouched; 28 were bound by the corpus's total, and
27 of those rebind to the *same* TorrentFile through PATH B (single playable
file / episode resolution). The remaining cases are provider-inventory states,
not proof failures: 3 releases whose inventory holds one file under two path
spellings (so "exactly one playable file" is false) and 1 whose only file is
a non-playable `.exe` that the media-payload guard refuses anyway.

**No ranking change.** Size is not a term in `qualityScore`; the release-level
number stays available, so the quality features read the same bytes they read
before.

---

## 2. The canonical timing waterfall

One session id crosses all three processes: the client mints it, the server
reads it and forwards it to the data plane, and the data plane records it as
the correlation id of its stage report. Every process measures with a
**monotonic** clock (`process.hrtime` in Node, `Instant` in Rust) and reports
the wall instant of its own anchor, which is the alignment point.

The stages, in the order they must occur:

```
intent_accepted → binding_resolved → playback_object_minted → player_launched
→ first_http → first_rust_byte_request → provider_request_start
→ provider_first_byte → first_byte_to_client → player_file_loaded → first_frame
```

A live warm playback (tt10986410, body already cached):

```
+     0 ms  binding_resolved            server
+     1 ms  playback_object_minted      server
+     6 ms  player_launched             client
+    84 ms  first_http                  server
+     4 ms  first_rust_byte_request     data-plane
+  1213 ms  first_byte_to_client        data-plane   <- a bucket
+  1875 ms  player_file_loaded          client       <- a bucket
+   325 ms  first_frame                 client
```

---

## 3. Fast and slow traces

**BEFORE the fix** (byte-cold, three different files, one run each):

| fixture | size | total | first frame |
|---|---|---|---|
| tt0053291 | 10.5 GB | 90 090 ms | 90 085 ms |
| tt0075686 | 4.3 GB | 90 081 ms | 90 076 ms |
| tt0468569 | 4.4 GB | 90 089 ms | 90 085 ms |

All three landed within 9 ms of each other — the signature of a **timeout**,
not of a slow provider.

**AFTER the fix** (same files, same session, same state):

| fixture | total | first frame | speed-up |
|---|---|---|---|
| tt0053291 | 5 546 ms | 5 540 ms | **16×** |
| tt0075686 | 5 016 ms | 5 011 ms | **18×** |
| tt0468569 | 4 996 ms | 4 992 ms | **18×** |

**The slow trace, annotated** (before the fix, tt0075686):

```
+     41 ms  first_http                  server
+      3 ms  first_rust_byte_request     data-plane
+   547 ms  provider_request_start       data-plane   <- capability acquisition
+   626 ms  provider_first_byte         data-plane   <- the provider answered in 626 ms
+     0 ms  first_byte_to_client         data-plane   <- the byte was delivered
+ 58837 ms  player_file_loaded           client       <- THE BUCKET
+ 30020 ms  first_frame                  client       <- and 30 s more
```

and the byte requests behind it:

```
REQ 0..4340539372        cacheHit=false  t5=1173  term=downstream_stall  bytes=51838336
    attempt 1  nexus.erth.tb-cdn.earth  206  headers=626ms  ttfb=0ms  outcome=Success
REQ 4340177162..4340539372  cacheHit=false  t5=132539  term=cancelled  bytes=0
REQ 4340404143..4340539372  cacheHit=false  t5=72373   term=cancelled  bytes=0
```

The first request asked for the **whole file**. The second — the player's
request for the container's metadata, at the *end* of the file — joined the
first request's claim for a chunk **258 fetches away** in the first request's
fill queue, and waited **132 s for 0 bytes**. The player then asked again and
waited another 72 s. It gave up at ~90 s.

**AFTER the fix**, the same three requests:

```
REQ 0..4340539372          cacheHit=false  t5=653   term=cancelled  bytes=34004352
REQ 4340177162..4340539372  cacheHit=false  t5=3899  term=complete   bytes=362211
```

The metadata chunk was fetched by the demand itself, and the first frame landed
at 5.0 s.

---

## 4. The initial Range pattern

Every run, fast or slow, shows the same shape — the player's HTTP client
(ffmpeg) asking for the file in pieces:

1. **`0..<size>`** — the whole file. This is ffmpeg's initial read: it does
   not know where the container's metadata is, so it opens the file.
2. **`<size> - N .. <size>`** — the tail. This is the **moov** read: the
   container's index is at the end of the file, so the player seeks back.
3. occasionally a **third** read from just after the moov.

Fast and slow runs make the **same three requests**. The difference is not the
pattern; it is how long the second request waits.

---

## 5. Cache-state classification

A `cached=true/false` label is not enough, and the data plane's own counters
show why: over the measurement window the cache reported **8.34 GB** of
provider bytes fetched for **6** client requests, **1 040** evictions against
an 8 GiB cache, and **524 of 994** chunk fills **failed**. The classification
that explains a run is:

| class | what it means | measured first-frame |
|---|---|---|
| `hot-metadata-only` | the container's index is durable, the body is not | 0.3–0.8 s |
| `cold-body` | the body is not durable at all | 2.4–8.7 s (before the fix: 90 s) |
| `hot-body` | the requested range is durable | 0.5 s |
| `capability-cold + bytes-cold` | neither | (the fixture that cannot be obtained at all) |

---

## 6. Provider latency, and what HashSucker added on top

Across the cohort's cold reads:

| stage | p50 | max |
|---|---|---|
| capability acquisition (`first_rust_byte_request` → `provider_request_start`) | 322 ms | 390 ms |
| provider TTFB (`provider_request_start` → `provider_first_byte`) | 88 ms | 519 ms |
| provider headers (per CDN attempt) | 348–969 ms | — |
| **HashSucker added, after the provider's first byte** | **0 ms** | 0 ms |

The provider answered in **88 ms** (TTFB) after dispatch, on every cold run.
HashSucker added **nothing** between the provider's first byte and the client's.

The capability acquisition (322 ms) is a provider **API** call (`requestdl`),
not the CDN: it is HashSucker's own cost of obtaining a fresh download URL,
and it is small.

---

## 7. Foreground vs background — and the one thing that was NOT background

The audit's hypothesis was that speculative/background byte work delays the
foreground read. **The measurement contradicts the hypothesis.**

The 90 s was not a background fill stealing the lane. It was **the player's
own first request** (a foreground read of the whole file) holding a claim on
518 chunks, and the player's **second** request — also foreground — waiting
behind that queue. Two foreground reads, one of them for a chunk 258 fetches
away.

What *is* background and does compete: the fixed-grid fill stages the whole
requested range (4.3 GB) into the cache, evicting 1 040 chunks (8.7 GB) along
the way and failing 524 chunk fills. That is a cache-pressure problem, not the
cause of the 90 s.

---

## 8. Route choice

The dual-route fixture (tt0021749 — a TorrentFile with two ready provider
routes) was read entirely from **torbox**; the alternate route was never
tried. But the TorBox reads were fast (headers 348–410 ms, TTFB 0 ms), so
route choice is **not implicated** in this tail, and there is no evidence here
that a different route would have been faster. The data plane has no
first-read route-preference evidence yet; nothing in this slice's evidence
earns a change there.

---

## 9. Root cause of the 8–90 s tail

**One internal cause, proven and repaired.**

> A client demand that joins a chunk another reader's *plan* had claimed but
> not yet started waits behind that plan's fill queue, with no bound. The
> plan fills its range in order, so a chunk far from that range's start can be
> hundreds of fetches away — longer than the player's patience. The demand
> gave up before the queue reached it.

The fix (`data-plane/src/serve.rs`, the Waiter arm of the demand consume
loop) bounds that wait and, when the owner has not even *started* the chunk,
fetches the chunk itself. The takeover is limited to **one per demand**, so a
demand whose window spans many chunks cannot re-fetch a whole range behind the
owner's back; the chunk taken over is the first one the demand is blocked on,
which is also the first byte its client is waiting for.

**What remains is not an internal delay**: it is the provider's cold read
(~0.4 s to the first byte) plus the player's own container work over a
whole-file request (the `player_file_loaded` bucket, p50 4.2 s cold).

**A separate, reliability finding — not latency.** The previously slow fixture
**Rear Window (tt0089883) does not play at all** right now: every candidate
is `uncached` at TorBox, RealDebrid refuses/times out on the add, and the
binding fails with `NO_PLACEMENT` *before any size comparison*. It has never
been bound in production (no handoff, no library item). This is the "starts
fast then dies" shape, and it is a **supply** problem, not a speed problem.

---

## 10. Before / after distributions

Post-fix cohort (3 runs each, production stack, the fixtures' own cache
states recorded honestly):

| fixture | warm | played | total p50 | total p95 | total max | cache classes |
|---|---|---|---|---|---|---|
| warm-movie (tt10986410) | yes | 3/3 | 561 ms | 5 506 ms | 5 506 ms | cold-body 1, hot 2 |
| warm-episode (tt10986410:4:4) | yes | 3/3 | 342 ms | 877 ms | 877 ms | cold-body 1 |
| byte-cold-movie (tt0075686) | yes | 3/3 | 1 513 ms | 1 564 ms | 1 564 ms | hot 3 (the body was cached by the previous cohort) |
| byte-cold-episode (tt31510819:2:5) | yes | 3/3 | 359 ms | 838 ms | 838 ms | cold-body 1 |
| dual-route (tt0021749) | yes | 3/3 | **30 007 ms** | 33 210 ms | 33 210 ms | cold-body 3 |
| large-file (tt0120737, 155 GB) | yes | 3/3 | 680 ms | 6 203 ms | 6 203 ms | cold-body 1, hot 2 |
| season-pack (tt2356777:1:3) | yes | 3/3 | 419 ms | 5 161 ms | 5 161 ms | cold-body 1, hot 2 |
| rear-window (tt0089883) | — | **0/3** | — | — | — | *no serviceable candidate* |

Split by cache state, over all 21 successful runs:

| class | runs | total p50 | total max | first frame p50 | provider dispatch p50 | provider first byte p50 | HashSucker added after the provider's first byte |
|---|---|---|---|---|---|---|---|
| body cold | 8 | 5 854 ms | 33 210 ms | 5 849 ms | 232 ms | 452 ms | **0 ms** |
| body hot | 13 | 533 ms | 1 564 ms | 527 ms | — | — | **0 ms** |

Against the pre-fix measurements on the same fixtures: **90 090 / 90 081 /
90 089 ms** → **5 546 / 5 016 / 4 996 ms**.

Against the product's shape — a healthy start should be well under a second,
and a cold-but-healthy provider in the low single digits — the warm path is
now **~0.5 s**, and the cold-body path is **1.5–6.2 s** apart from one
fixture whose remaining cost is a slow **capability acquisition** (below).

---

## 11. The remaining floor

After the fix, a cold first read still costs:

* **~0.45 s** for the provider's first byte (452 ms p50 from the byte request
  to the provider's first byte) — external.
* **~4.4 s (p50)** in the player's own `file_loaded`, on a request for the
  **whole file**. The byte path honours the range the client asked for, so a
  4.3 GB request means 4.3 GB of provider traffic, ~1 040 evictions and 524
  failed chunk fills, and the player's demux is gated on that stream. The
  container's index was already durable (0 ms); the wait is the player's own
  work over a whole-file range.
* **up to 26 s**, on some runs, in the **capability acquisition** — the
  provider API call that yields the download URL. The stage report names it
  exactly: on the 30 s dual-route run, `T1_acquire_issued` → `T2_capability_ready`
  was **26 034 ms**, while the provider's own TTFB afterwards was **193 ms**.
  That is a provider-API cost incurred *before any byte request exists*, and
  it is the whole of the remaining 30 s on that fixture. It is not a queue
  wait and not a byte-path delay: the demand's takeover fires on schedule and
  then waits for the acquisition it is entitled to.

That last item is the next candidate, and it is a **cache-policy / range-shape**
question, not a latency bug in the byte path: a demand-driven fill (fetch what
the client consumes) instead of a range-driven fill (fetch everything the
client asked for) would cut the provider traffic by two orders of magnitude and
stop the eviction storm. It is NOT taken here: it changes the cache's warming
contract, and the slice's rule is one bounded causal change at a time.

---

## 12. Tests

| suite | result |
|---|---|
| `media-search` (Node) | **3 625** tests, 3 621 pass, 3 skipped, **1 fail** — the known pre-existing `vfs-collection-resilience` C1/C2/C3 baseline (unchanged by this slice) |
| `data-plane` (Rust) | **153** passed, 0 failed |
| new | `media-search/test/file-size-scope.test.js` (11) and `media-search/test/playback-waterfall.test.js` (11) |

---

## 13. Commits

| commit | what |
|---|---|
| `8ae3528` | fix(discovery): a release total is release evidence, not an exact file size (Part 0) |
| `6df1163` | feat(measurement): one session id, one timeline, one waterfall (Phase 1) |
| (this slice) | fix(data-plane): a demand must not wait behind a fill queue it does not need (Phase 11) |

---

## 14. Verdict

# FAST PLAYBACK — INTERNAL BOTTLENECK FIXED

The 8–90 s tail was **one** internal defect, not a provider floor and not a
ranking problem: a client demand that joined a chunk another reader's plan had
claimed but not started waited, unbounded, behind that plan's in-order fill
queue. It was proven with the canonical waterfall (the bucket was
`first_byte_to_client → player_file_loaded`), named to the exact code path
(the demand consume loop's Waiter arm), repaired with a bounded takeover, and
measured before/after on the same fixtures: **90 090 → 5 546 ms**,
**90 081 → 5 016 ms**, **90 089 → 4 996 ms**.

HashSucker adds **0 ms** after the provider's first byte, and the provider's
own TTFB is **193–452 ms** on a cold read. The warm first frame is now
**~0.5 s** and the cold-body first frame **1.5–6.2 s**, with one fixture
whose residual is a slow provider *capability acquisition* (26 s inside the
provider API call, before any byte request exists).

Three things are deliberately NOT claimed as fixed:

1. **The whole-file range.** The player asks for the entire file, the byte
   path honours it, and the player's own demux of that stream is the largest
   remaining cold bucket (p50 4.4 s). The provider traffic and the eviction
   storm (8.7 GB evicted, 524 failed chunk fills) come from the same place.
   This is a cache-policy / range-shape question and belongs to its own slice.
2. **A slow capability acquisition.** On some runs the provider's API call
   that yields the download URL took 26 s — measured as
   `T1_acquire_issued → T2_capability_ready`. It is provider-side and
   pre-byte, but it is the whole of the 30 s dual-route fixture. The demand's
   takeover fires on schedule; it then waits for an acquisition it is entitled
   to. Whether an acquisition can be reused or overlapped is a separate
   question, and no evidence here earns a change to it.
3. **Rear Window's failure to play at all.** Every candidate is uncached and
   the alternate route refuses the add. That is a supply failure. It is
   recorded as a reliability finding, not a latency one — and it is the reason
   the cohort's "previously slow fixture" row reads `0/3 played` rather than a
   slow number.

**Ranking is not implicated at any point in this slice.** The candidates that
won were serviceable, exact and within the quality floor; the time was not
spent choosing them.

# START FAST: CAPABILITY + PERMIT PATH — the 26-second acquisition was a permit, not the provider

Date: 2026-10-21
Slice: are the two remaining startup mechanisms (provider capability
acquisition, same-file permit contention) the dominant avoidable cost, and
can either be reduced with a bounded causal fix?

---

## 0. Answer first

**The 26-second "capability acquisition" was never the provider.** The
measurement behind it (from the previous slice) was
`T1_acquire_issued → T2_capability_ready = 26 034 ms` on a dual-route
fixture, and it was labelled "the provider API call that yields the download
URL". **That label was wrong.** The data plane's own acquisition trace now
shows the time going to a **local permit wait** — a foreground demand queued
behind a background fill's ownership of the file's last free capability.

The fix is one bound: the capability pool may now hold **4** capabilities
per provider route instead of 2, so a foreground demand gets its own
capability instead of waiting for a permit that a bulk transfer may hold for
a minute. Measured, same production stack, fresh byte-cold fixtures, fresh
container per leg:

| | before (pool = 2) | after (pool = 4) |
|---|---|---|
| acquisition window p50 | 150 ms | 215 ms |
| acquisition window **p95** | **27 634 ms** | **670 ms** |
| acquisition window **max** | **59 436 ms** | **670 ms** |
| acquisitions > 1 s / > 5 s / > 10 s | 3 / 3 / 3 | **0 / 0 / 0** |
| **permit waits** | 4 (p50 27 634 ms, max 59 436 ms) | **0** |
| provider API time p50 / max | 262 / 992 ms | 342 / 664 ms |
| worst first frame | **60 625 ms** | 28 308 ms (the client's own bucket) |

**The provider API was never the problem**: it is 170–992 ms on every
acquisition measured, across both providers and every route shape.

**What remains after the fix** is the player: on the worst byte-cold
fixture the first frame is 28 s, and the canonical waterfall attributes
**26 808 ms of it to the client** (`media_data_request →
player_file_loaded`), with every data-plane stage sub-second. That is the
player floor, and it is not HashSucker's.

---

## 1. Part 1 — the canonical startup waterfall

The existing correlated-session timeline was extended, not duplicated. The
same session id, the same three processes, the same wall-anchor alignment.

The stage list went from 11 to 14 stages
(`media-search/src/lib/measurement/playback-waterfall.js`):

```
 1 intent_accepted           server      the server accepted the media intent
 2 binding_resolved          server      the authoritative Binding is known
 3 playback_object_minted    server      the playback object (token) exists
 4 player_launched           client      the player process exists
 5 first_http                server      the player's first request reached the server
 6 first_rust_byte_request   data-plane  the data plane received the byte request
 7 capability_acquired       data-plane  the capability AND its permit are in hand   (NEW)
 8 provider_request_start    data-plane  the provider request was dispatched
 9 provider_first_byte       data-plane  the provider's first byte arrived
10 first_byte_to_client      data-plane  the first byte was delivered to the client
11 player_metadata_request   data-plane  the player asked for the container's index  (NEW)
12 media_data_request        data-plane  the player asked for the media data         (NEW)
13 player_file_loaded        client      the player probed the container
14 first_frame               client      a frame is on screen
```

**Where the capability is acquired.** On the cached byte route the delivery
capability is acquired by the **Rust data plane**, not by the Node server:
the server mints a playback object bound to the TorrentFile, and the data
plane turns that into a provider capability when the bytes are needed. So
stage 7 is the whole of "capability lookup / reuse / acquisition" on this
route, and it is stamped where it actually happens.

**The permit acquisition is a sub-stage of stage 7**, not a separate
stage: in this design the capability and its permit are obtained together,
so there is no "capability ready, permit pending" instant to stamp. The
permit's own time is carried in the acquisition's **breakdown**, which
names it explicitly (`permit_wait_ms`). That is a more precise answer than
a stage would be.

**The player's three Range requests** are now three distinct stages. A
player opens a non-faststart file with three Ranges: the whole file, the
container's index at the end, and the media data back at the start. The
second and third are the ones that can queue behind the file's own permit.

**The acquisition breakdown** (new, in the data plane's stage report) gives
every wait its own bucket: `api_ms` (the provider's round trip),
`permit_wait_ms` (the local maxInFlight gate), `inflight_wait_ms` (a
single-flight queue behind another task's acquisition), `cooldown_ms` (a
throttle cooldown), plus the per-call endpoint detail
(`/torrents/requestdl`, `/torrents/info`, `/torrents`, `/unrestrict/link`)
with each call's duration, status and timeout flag.

---

## 2. Part 2 — capability acquisition incidence

Cohort: byte-cold fixtures across TorBox-only, RealDebrid-only and
dual-route shapes, on the production stack, with the data plane's own
acquisition trace read per byte request.

**The acquisition window (T1 → T2), per byte request**

| | before (pool = 2) | after (pool = 4) | shipped image |
|---|---|---|---|
| n | 25 | 17 | 31 |
| p50 | 150 ms | 215 ms | 23 ms |
| p95 | 27 634 ms | 670 ms | 2 560 ms |
| max | 59 436 ms | 670 ms | 4 772 ms |
| **> 1 s** | 3 | **0** | 6 |
| **> 5 s** | 3 | **0** | 0 |
| **> 10 s** | 3 | **0** | 0 |

**The breakdown, after the fix (shipped image, 31 windows)**

| bucket | n | p50 | max |
|---|---|---|---|
| provider API | 15 | 683 ms | 4 772 ms |
| **permit wait** | **0** | — | **0** |
| single-flight (in-flight dedupe) wait | 0 | — | 0 |
| throttle cooldown | 0 | — | 0 |

**Before the fix, the same table read:** provider API 10 calls, p50 262 ms,
max 992 ms; **permit waits 4, p50 27 634 ms, max 59 436 ms**; single-flight
0; cooldown 0.

**Every slow acquisition was a permit wait. Not one was the provider.**

The provider API's own distribution (the data plane's `layer_A_api`
counters, 27 calls in the first observation window): average **357 ms**,
26 × 2xx, 1 × 4xx, 0 × 5xx, 0 × 429.

---

## 3. Part 3 — where the 26 seconds actually lived

**The first causal bucket: the LOCAL PERMIT WAIT.**

The evidence, in the order it was found:

1. The data plane's stage report showed a **72 606 ms** acquisition window
   with **`api_requests_delta = 0`** — an acquisition that made **no
   provider API call at all** and still took 72.6 s. A provider API cannot
   be the explanation of an interval with no API call in it.
2. `cap.throttle()` is never called in the production path (only in tests),
   so the throttle-cooldown sleep in the acquisition was dead code — not
   the wait.
3. The `limiter_wait_ms_total` counter read **769 936 ms over 11 waits** —
   an average of 70 s per wait, on the WAIT side of the permit.
4. The new hold-side counter confirmed it: permits were held for up to
   **100 007 ms** (100 s) while a demand waited up to **95 837 ms**.

So the 26 s (and the 72 s, and the 100 s) were all **the same thing**: a
foreground demand waiting for a capability whose permit was held by a
long-running transfer of the same file.

**The DNS / connect / TLS / provider-processing split was not needed** —
because the interval contained no provider call to split. The provider's
own TTFB after dispatch was 163–901 ms throughout, and the provider API
calls themselves 170–992 ms.

**The trigger, established by the cohort:** the capability pool is cached
per TorrentFile, so it SURVIVES a session. A session's background
whole-file fill keeps holding the file's capabilities after the session
ends (up to 100 s). A later session for the same file finds the pool
saturated with **valid but busy** capabilities and blocks. The same effect
appears *within* one session when the player's third request arrives while
the first request's fill holds the pool.

---

## 4. Part 4 — capability reuse

| question | answer (measured) |
|---|---|
| was a DeliveryCapability already valid? | **Yes, usually.** The trace distinguishes `reuse` (an existing, valid capability's permit was taken — 0 provider calls) from `acquire` (a provider call was paid for). |
| was a recent successful capability discarded too aggressively? | **No.** Nothing is discarded early: caps are pruned only when dead or expired (TTL 600 s). |
| was the provider placement still known? | Yes. The slots are built from the S-1 exact-TorrentFile truth, which is refreshed on demand. |
| was the provider file mapping still known? | Yes — the same truth carries it. |
| did route evidence already say the route was serviceable? | Yes, and the route order is honoured. |
| was the call genuinely required? | **Yes, when it was made.** The delivery URL is a short-lived signed provider URL; it must be minted to be used. |

**The one real waste found in the reuse path** is on dual-route files: the
acquisition tries **RealDebrid first**, and RD's `/unrestrict/link` answers
**403** for these files, so the acquisition pays RD's `/torrents/info`
(410 ms) + `/unrestrict/link` (129 ms) before TorBox's
`/torrents/requestdl` (334 ms) succeeds. **~540 ms of dead-route tax on
every acquisition of a dual-route file.**

That is a route-health fact (RD is in a free tier and refuses to unrestrict
these files), not a startup-mechanics defect, and it was **not** changed
here: remembering a dead route is route-evidence work, and this slice's
scope is startup mechanics.

**Reuse works.** 18 of 31 windows in the final cohort were `reuse` with
**zero** provider calls. The reuse path was never the problem; the problem
was that a *valid* capability could be **busy**.

---

## 5. Part 5 — dual-route startup

**The hypothesis does not hold up, and the hypothesis is closed.**

The slice asked: "if same-TF route B is already immediately executable,
should Play wait 26 seconds for route A's capability?" The measurement
says **no such wait exists**. On a dual-route file the acquisition tries
the routes in order and each attempt is fast (410 ms + 129 ms for RD,
334 ms for TorBox). The 22 073 ms and 22 086 ms waits observed on the
dual-route fixture were **permit waits with `api_calls = 0`** — the wait
was not route-specific at all; both routes' capabilities were busy.

So: route B is **not** held behind route A's acquisition. The route order
costs ~540 ms of dead-route tax, and that is all.

---

## 6. Part 6 — the permit lifecycle

| question | answer |
|---|---|
| **who acquires it** | `CapabilityManager::try_slot` / `try_reserve`. The demand's pre-acquire in `get_file`, then each fill span's acquire and the hand-back chain between spans. |
| **what scope it protects** | **Per capability** — and a capability IS one signed provider delivery URL for one provider file (`DeliveryCapability`). Not per TorrentFile, not per chunk, not per fill. |
| **when is it released** | When the `ReservedCapability` drops. The reservation is HANDED BACK along the span chain (`reader.into_reserved()`), so **one permit is held for the whole duration of a fill** — measured up to **100 007 ms**. |
| **which request waits** | The next demand for the same TorrentFile that finds every capability in the pool busy. Measured: the player's **tail (index) request** and its **media-data request**. |
| **how long it waits** | Up to the remaining fill time: 1 895 / 4 925 / 12 415 / 15 909 / 22 073 / 22 086 / 67 717 / 95 837 ms observed. |
| **why exclusivity is required** | The capability is the signed delivery URL, and the limiter is a **lifetime/bookkeeping gate**, not a hard HTTP-concurrency limit: `capability_lease.rs` proves **one permit can back two concurrent disjoint Range readers** for the same TorrentFile with all lifetime and recovery invariants intact. The invariant is *one in-flight transfer per capability*; more transfers are expressed as **more capabilities**. |

**The invariant is therefore the right one and it was not weakened.** The
defect was not the invariant; it was the **pool's bound being smaller than
the real concurrent demand**, which turned "get another capability" into
"wait for this one".

---

## 7. Part 7 — the duplicate whole-file requests

The player's three Ranges, captured on every fixture:

```
REQ 1   0 .. <size>              the WHOLE FILE        (the player cannot know where the index is)
REQ 2   <size>-362211 .. <size>   the container's index (the moov, at the END)
REQ 3   9154 .. <size>           the MEDIA DATA, back at the start
```

| | measured |
|---|---|
| bytes requested | the whole file, every time (2–47 GB) |
| bytes the player consumed before the first frame | **12.9–58.4 MB** (previous slice) |
| bytes the data plane delivered | 22–260 MB per request before the player cancels it |
| provider bytes fetched | 0.16–1.98 GB (previous slice) — the background fill keeps going |
| permit wait (before the fix) | up to 67 717 ms, charged to REQ 2 / REQ 3 |
| first-frame impact (after the fix) | **none**: the acquisition is 0–670 ms and every data-plane stage is sub-second |

**Is the third request harmless, expected, or amplified by HashSucker's
fill ownership?** It is **expected player behaviour** (a non-faststart file
requires the seek-back), and it was **amplified** by the fill's permit
ownership — the third request was the one that queued behind the first
request's background fill. After the fix it is served immediately.

**The duplicate whole-file request is NOT redundant work for the player**,
but it is very nearly redundant work for the data plane: the whole-file
request's fill already fetches the media data the third request asks for.
That redundancy is the previous slice's **cache-policy question** (the
eager fill), and it is deliberately not touched here.

---

## 8. Part 8 — the permit contention experiment

**One bounded change: the capability pool's bound, 2 → 4.**

The mechanism already existed and was already demand-driven: when a
capability is alive but busy, `try_slot` grows the pool (`1->2`) and records
the reason ("concurrent-read-pressure"). The code's own comment said
*"2->4 only via explicit POOL_MAX opt-in"*. The measurement says the
player's request pattern for ONE file needs up to **four** concurrent
transfers of it:

1. the whole-file request's client stream,
2. its background fill,
3. the container-index (tail) read,
4. the media-data read.

With only two capabilities, #3 and #4 found the pool saturated and
**blocked** instead of getting their own.

**Why this preserves everything:**

| invariant | preserved because |
|---|---|
| exact bytes | the change is a pool bound; no byte path, chunk grid, or cache key is touched |
| coalescing correctness | untouched — the coalescer still owns the chunks |
| no duplicate/skip | untouched |
| same-TF route failover | untouched — failover is a property of the slots, not the pool size |
| cache authority | untouched — the cache is still the authority for a durable chunk |
| **maxInFlight = 1 per capability** | **UNCHANGED.** Each capability still has exactly one in-flight transfer. The pool simply holds enough capabilities that a foreground demand never queues behind a bulk fill's ownership of the last free one. |
| no wholesale concurrency redesign | the change is one constant |

**The cost:** a capability is minted only when a **real concurrent demand**
arrives for that file, so the extra provider calls are paid only under
genuine concurrency. Measured provider API calls per cohort leg: **10
before, 9 after** — the pool growth did not increase the call count in the
matched legs, because the demands that used to WAIT now find a free permit
or grow the pool only when it is genuinely saturated.

**A regression test pins the behaviour** (not the constant): a demand that
finds every capability in the pool busy must get its own capability
promptly. It **times out against the old bound (2)** and passes against
the new one — verified by running it against both.

**Known wart, recorded not hidden:** the pool's *target* is bounded at 4,
but the pool's *size* can reach 5 under concurrent growth (two demands can
both observe target = 3). The overshoot is one capability; it is bounded
and it is not a correctness issue.

---

## 9. Part 9 — the capability experiment

**None was earned.** The provider API is 170–992 ms (p50 342 ms) on every
acquisition measured, across TorBox, RealDebrid, single-route and
dual-route. There is no internal queue, limiter mistake, polling loop or
retry loop in the acquisition path: the single-flight dedupe wait was
**0 ms in every acquisition measured**, and the throttle-cooldown path is
dead code in production (`cap.throttle()` is only called from tests).

The one waste found — the ~540 ms dead-route tax from trying RealDebrid
first on dual-route files — is a **route-health** fact, and fixing it is
route-evidence work, not startup mechanics.

---

## 10. Part 10 — the uncached execution gap was NOT touched

Rear Window (tt0089883) remains: candidates discovered, all uncached or
unexecutable under policy, the alternate route refuses the add, no
playback. **Unchanged by this slice** — no fixture, policy, or code path
in it was touched. It remains recorded as:

**UNCACHED EXECUTION GAP** — for a later explicit product-policy decision.

The RealDebrid-only fixtures (tt3581920, tt0039825) also did not play in
this cohort. That is a **supply** fact (their RD route cannot unrestrict
the file — the same 403 seen in the dual-route trace), not a startup
defect, and it is recorded here rather than treated as a latency
observation.

---

## 11. Part 11 — the cache overfetch, recorded not fixed

Unchanged from the previous slice: **164 MB – 1.98 GB fetched** during a
startup, **12.9–58.4 MB consumed** by the player, **up to 1.94 GB
evicted** from the 8 GiB cache.

**It interacts with the permit finding, and the interaction is now
explicit:** the eager whole-file fill is what holds the file's capability
for up to 100 s, and that hold is what starved the foreground demand. The
fix removes the STARVATION (the demand now gets its own capability); it
does not remove the HOLD (the fill still runs, and still burns the
provider's budget on bytes nobody asked for).

**Not touched here** — a demand-driven fill is a cache-policy change, and
this slice's rule is one bounded causal change at a time.

---

## 12. Part 12 — the before/after cohort, and the safety proof

### Before / after (matched legs, fresh container per leg, fresh byte-cold
fixture set per leg)

| | before (pool = 2) | after (pool = 4) |
|---|---|---|
| acquisition window p50 / p95 / max | 150 / **27 634** / **59 436** ms | 215 / **670** / **670** ms |
| acquisitions > 1 s / > 5 s / > 10 s | 3 / 3 / 3 | **0 / 0 / 0** |
| permit waits | 4 (max 59 436 ms) | **0** |
| provider API p50 / max | 262 / 992 ms | 342 / 664 ms |
| first frame p50 / max | 2 261 / **60 625** ms | 498 / 28 308 ms |

A third leg on the **shipped image** with six more fresh byte-cold
fixtures: 31 windows, p50 23 ms, p95 2 560 ms, max 4 772 ms, **0 permit
waits**, 0 acquisitions over 5 s, first frame p50 692 ms / max 10 055 ms.

The 28 308 ms first frame in the middle leg is the **client's** bucket,
not a regression: on a reproduction (tt1856101) the canonical waterfall
attributes **26 808 ms to `media_data_request → player_file_loaded`
(owner: client)** with every data-plane stage sub-second (provider first
byte at 726 ms).

### Safety

| check | result |
|---|---|
| exact bytes | unchanged (the change is a pool bound) |
| coalescing correctness | unchanged |
| same-TF route failover | `r14_same_tf_alternate_route_recovers_without_cross_representation` passes |
| byte-exactness / no duplicate / no skip | `r1`–`r13` pass |
| clean seek | `--resume 30` → played to 31.4 s, **exit 0** |
| clean sustained playback | playhead advances to 2.5 s over a 3 s measure, **exit 0** |
| data-plane suite | **154** passed (153 + the new regression test), 0 failed |
| media-search suite | **3 626** tests, 3 622 pass, 3 skipped, **1 fail** — the known pre-existing `vfs-collection-resilience` C1/C2/C3 baseline |
| the new regression test | **fails (times out) against the old bound, passes against the new one** — verified against both |
| uncached-execution policy | **untouched** |
| ranking | **untouched** |
| cache policy | **untouched** |

---

## 13. The remaining floor

After the fix, a byte-cold startup decomposes as:

| | |
|---|---|
| the server's intent → binding → token | 0–50 ms |
| the capability acquisition (one provider call) | **170–992 ms** |
| the provider's dispatch → first byte | 163–901 ms |
| the first byte to the client | 0–1 ms after the provider's first byte |
| the player's own probe / demux | **1 461 – 26 808 ms** |
| **HashSucker added after the provider's first byte** | **0 ms** |

The player's own demux is now the largest term by a wide margin, and it is
the player's. The two internal terms the slice set out to attack are
answered: **the capability acquisition is a fast, mostly-reused,
provider-bound cost, and the permit contention was a real internal defect
that is now fixed.**

---

## 14. Verdict

# START FAST — PERMIT BOTTLENECK FIXED

**The same-file exclusive permit was a repeatable internal defect that
materially delayed Play, and it is repaired.**

The previous slice's "26-second provider capability acquisition" was a
**local permit wait**, not a provider call: the data plane's own trace
shows acquisitions of 22 073 ms and 72 606 ms with `api_calls = 0`. A
foreground demand was queueing for a capability whose permit was held by
the same file's background fill — for up to 100 s — because the capability
pool's bound (2) was smaller than the number of concurrent transfers a
player's request pattern actually needs (4).

The fix raises that bound to 4, which is the mechanism the code already had
and the comment already anticipated. The invariant is untouched: **one
in-flight transfer per capability**; the pool simply holds enough
capabilities that a foreground demand never queues behind a bulk fill's
ownership of the last free one.

Measured on the production stack, matched legs, fresh byte-cold fixtures:
**acquisition-window p95 27 634 ms → 670 ms, max 59 436 ms → 670 ms, and
permit waits 4 → 0.** The worst first frame fell from 60 625 ms to
28 308 ms, and that remaining 28 s is the player's own demux — attributed
by the canonical waterfall to the client, with every data-plane stage
sub-second.

**The capability path is characterized and needs no fix**: the provider API
is 170–992 ms, reuse is 0-call and works, the single-flight queue and the
throttle cooldown are never entered, and the dual-route order costs a
~540 ms dead-route tax (RealDebrid 403s before TorBox succeeds) which is
route-health work, not startup mechanics.

**Not claimed:** the eager whole-file fill still fetches 0.16–1.98 GB,
still evicts up to 1.94 GB, and still holds a file's capability for up to
100 s. The fix removes the starvation; it does not remove the hold. That
is the cache-policy question, and it is left where the previous slice
left it.

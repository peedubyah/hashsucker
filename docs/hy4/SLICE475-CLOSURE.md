# Slice 4.75 — Fixed-Grid Chunk Cache Conversion

Status: **COMPLETE — proofs A–H PASS, plus L/L2/M.**

Scope: replace arbitrary durable extents with **fixed-grid complete-chunk
truth**. No S3/MinIO/tiering, no prefetch, no read-ahead, no provider-order
change, no TTFB optimization, no Slice 5 work.

Specimen: `0439d86e8da335cde1b25575ed0534bf7359bc38`, 4,038,279,055 bytes.
Runtime storage: container overlayfs.

---

## 1. Cache format and configuration

| Item | Value |
|---|---|
| Cache format version | **2** (`CACHE_FORMAT_VERSION`) |
| Persistent store | **new** `chunks.sqlite` (Slice 4's `extents.sqlite` left inert, not migrated) |
| Configured chunk size | **8,388,608 B (8 MiB)**, from `SLICE4_CHUNK_SIZE`, persisted in `meta` |
| Durable identity | `cache_key = <info_hash>__<short_hash(canonical_path)>__<size>` |
| On-disk layout | `cache/<cache_key>/<chunkIndex>.chunk` |
| Staging | `cache/<cache_key>/.stage-<chunkIndex>-<tag>.tmp` (never durable) |
| Default budget | 512 MiB (`SLICE4_CACHE_MAX_BYTES`) |

Chunk size is **persisted and versioned, not baked into the ontology.** On open,
if either `format_version` or `chunk_size` differs from what is stored, the store
is reset and re-stamped. Slice 4 contents are deliberately discarded rather than
migrated (brief §8: "This is still Frankenstein. Do not build a complicated
migration from arbitrary extents.").

The grid is a pure function of `(chunk_size, file_size)`:

```
chunk_start(i) = i * chunk_size
chunk_len(i)   = min(chunk_size, file_size - chunk_start(i))
```

so durable truth is independent of request shape. Past EOF, `chunk_len == 0`.

**Durable state is PRESENT or ABSENT only.** A row exists in `chunks` if and
only if the complete expected chunk is durably on disk. There is no durable
partial state and no durable FILLING; FILLING is runtime-only (the in-flight
map), so a crash can never leave a half-written chunk advertised.

---

## 2. Files changed

| File | Lines | Change |
|---|---|---|
| `rust-data-plane/src/cache.rs` | 1565 | **rewritten** — fixed-grid model |
| `rust-data-plane/src/main.rs` | 1481 | reworked — span-driven fetch, per-chunk single-flight |
| `rust-data-plane/src/metrics.rs` | 628 | extended — chunk + overfetch counters, limiter split |
| `rust-data-plane/src/manager.rs` | 550 | **+23** — one additive limiter instrumentation site |
| `rust-data-plane/src/transport.rs` | — | **UNTOUCHED** (verified: empty diff) |

Total: **2062 insertions, 1195 deletions** across 4 files.

`transport.rs` needed no change. Its `on_chunk` callback fires only for chunks
the `ResilientRangeReader` has *committed* to delivering — i.e. after internal
recovery, with an authoritative offset — so retried bytes are never
double-staged.

**Build:** release, clean. 4.65 s incremental, **0 errors**, 22 warnings (all
pre-existing dead-code; none in the changed regions).
**Unit tests: 23 passed, 0 failed** (17 cache + 6 `window_slice`).

---

## 3. Proof results

All run after implementation was complete (brief §11: *"Do not test every edit.
Implement first, then build once, diagnose failures, then run the bounded proof
set."*).

| Proof | Requirement | Status |
|---|---|---|
| **A** | exact arbitrary Range assembly | **PASS** |
| **B** | chunk single-flight: 10 readers → 1 owner, 9 joins, 1 fill | **PASS** |
| **C** | overlap — report ACTUAL upstream Range intervals | **PASS** |
| **D** | adjacent missing chunks collapse into one provider fetch | **PASS** |
| **E** | restart: PRESENT survives with ZERO provider/API/CDN work | **PASS** |
| **F** | crash mid-fill: no incomplete chunk ever appears PRESENT | **PASS** |
| **G** | eviction chunk-granular, never touches FILLING | **PASS** |
| **H** | provider recovery: no duplicate durable publication | **PASS** |
| **L** | cold-latency cost of whole-chunk fetching (paired A/B) | **PASS** |
| **L2** | isolate that cost to its cause (lead-in) | **PASS** |
| **M** | limiter + provider accounting on the chunk path | **PASS** |

### A — exact arbitrary Range assembly

The decisive check is not "cold bytes equal warm bytes" (a systematic
misassembly would be identical both times) but a **wide read vs. the
concatenation of irregular narrow reads tiling the same range.** Any
off-by-one at a chunk boundary breaks the equality. Both orders exercised.

| Region | Range | Bytes | Tiles | SHA-256 (wide) | SHA-256 (concat) |
|---|---|---|---|---|---|
| R1 wide→narrow | `[314572800, 339750968]` | 25,178,169 | 6 | `31482b79…` | `31482b79…` **identical** |
| R2 narrow→wide | `[356515840, 373303054]` | 16,787,215 | 6 | `5df8a6bf…` | `5df8a6bf…` **identical** |

Tile sizes deliberately unaligned: `[1 MiB+123, 4096, 2 MiB+7, 777777, 3 MiB+65535, remainder]`.
Framing exact (`bytes 314572800-339750968/4038279055`). **416 preserved**
(`[10737418240, 10737419263]` → 416).

### B — chunk single-flight

10 concurrent readers, window inside **one** chunk (index 40):

```
chunk_claims       1
chunk_join_waits   9      <- exactly 9 waiters joined the single owner
chunk_fills        1
chunk_fills_failed 0
```

`bytes_upstream_issued` **8,388,608** (one chunk) vs **10,485,760** if
uncoalesced. All 10 readers byte-identical (`cb874325…`). Wall 1815 ms.

### C — overlap avoidance, actual upstream intervals

| Reader | Request | Chunks | Actual fetch span | Span bytes |
|---|---|---|---|---|
| X | `[360710144, 385875967]` | 43, 44, 45 | `[360710144, 385875967]` | 25,165,824 |
| Y | `[369098752, 394264575]` | 46 | `[385875968, 394264575]` | 8,388,608 |

Reader Y's span **starts after X's ends** — the 2-chunk overlap was never
re-fetched. Issued **33,554,432** vs naive **50,331,648**.
`overlap_bytes_avoided` **16,777,216** = exactly the 2-chunk overlap.
Overlap region SHA-256 identical from both readers (`27047ed5…`).

### D — adjacency collapse and bounded overfetch

- Small request `[401604608, 402653183]` (1 MiB) → fetch span
  `[394264576, 402653183]` = **8,388,608 B** (whole chunk), overfetch
  **7,340,032 B** — matching prediction exactly.
- Wide request `[469762048, 494927871]` (24 MiB) → chunks **56, 57, 58** served
  as **ONE** provider Range. `collapse_ratio` **2.0**.

### E — restart durability

| | Before | After |
|---|---|---|
| format_version | 2 | 2 |
| chunks_present | 3 | 3 |
| current_bytes | 25,165,824 | 25,165,824 |

**After restart: provider API 0, CDN 0, capability acquisitions 0, bytes
upstream 0.** `full_hits` 1, `bytes_local` 25,165,824. Byte-identical
(`3dab7c65…`). Budget correctly recomputed from disk, not from metadata.

### F — crash mid-fill

Killed with **1 chunk durably published and 4 in flight**. On disk at kill:

```
  8388608  58.chunk              <- complete, published
   249856  .stage-59-1.tmp       <- partial, still staging
```

After restart: `chunks_present` 1 → 1, `current_bytes` 8,388,608 → 8,388,608,
**no chunk gained or lost**, `publish_noop` 0, `chunks_inflight` 0.
`current_bytes == chunks_present × chunk_size` exactly — a promoted half-chunk
would have made it a non-multiple. Reread 206 / 33,554,432 B, byte-exact, second
read identical (`5562af13…`).

### G — eviction

`max_bytes` 4,194,304 (deliberately below one chunk, so the sweep must run).

- `evictions` **1**, `bytes_evicted` **8,388,608** = **exactly one chunk**
- `evict_skipped_filling` **2** — the FILLING guard was **observed to fire**,
  not merely present in the source
- `publish_noop` 0, `chunks_inflight` 0 at rest
- peak 8,388,608, at rest 8,388,608, transient overshoot 4,194,304
  (Slice 4.5's honest rule: guaranteed at rest, overshoot allowed during fills)

### H — provider recovery (both fault classes)

| Fault | `mid_body_resumes` | `attempts` | `internal_recoveries_ok` | `publish_noop` | Bytes |
|---|---|---|---|---|---|
| mid-body drop | **1** | 1 | 2 | 0 | 16,777,216 exact |
| CDN 429 once | **0** | 1 | 2 | 0 | 16,777,216 exact |

Both arms: `chunk_fills` 2, `chunk_fills_failed` 0, budget
16,777,216 = 2 × 8,388,608 exactly, byte-exact SHA `030cb8f5…` **identical
across both faults**, retry duplication 0. Every fetch still passed through the
Slice 3 limiter/breaker/capability path; `mid_body_resumes: 1` confirms the
injected fault actually fired.

### M — limiter and provider accounting

| Metric | Value |
|---|---|
| `limiter_waits` | **0** (throttle cooldowns only — see below) |
| `limiter_permit_waits` | **3** (4 concurrent lanes → N−1, exactly as `maxInFlight=1` predicts) |
| `limiter_wait_ms_total` | **11,084 ms** |
| peak `chunks_inflight` | 8 |
| serialization ratio | **4.44×** |
| provider API requests | **1** |
| CDN requests | **8** |
| capability acquisitions / reuses | **1 / 7** |
| chunk claims / joins / fills / failures | 16 / 0 / 16 / 0 |
| `durable_sync_us` | 160,387 (durability barrier observed) |
| `publish_noop` | 0 |

16 chunks → **8 CDN requests** (2 chunks collapsed per span) from **1**
capability acquisition + 7 reuses: no per-chunk API amplification.

---

## 4. `limiter_waits` — semantic mismatch found and resolved

Slice 4.5 wired `limiter_waits` to the one place it could find a limiter wait
being served: the 429/5xx **throttle cooldown** in `transport.rs`. It was a real
fix for a genuinely dead counter, but the wiring left the name misleading:

> the counter named "limiter waits" never counted the far more common meaning —
> queueing for a capability's `maxInFlight=1` **permit**.

Under the deterministic fault gates the cooldown is forced to zero, so fault
arms report `limiter_waits: 0` **by construction**. A bare zero read as "no
contention", which is the opposite of the truth — and it is exactly the
dead-metric/vacuous-assertion failure mode this project has now hit four times.

**Proof M measured the mismatch:** 8 chunk spans claimed concurrently,
serializing **4.44×** behind the one-permit gate, with `limiter_waits`
reading **0** throughout.

**Resolution** (additive, no behavior change):

- New counter `limiter_permit_waits`, recorded at the blocking
  `acquire_owned()` in `manager.rs`, where permit contention actually happens.
- Its elapsed time is charged to `limiter_wait_ms_total`, which was always
  documented as "time waiting behind the shared limiter/breaker" but had only
  ever received cooldown time.
- `limiter_waits` keeps its Slice 4.5 meaning so the 4.5 report stays valid.
- Both are surfaced on `/metrics` with their definitions attached.

Result: `limiter_permit_waits` = **3** for 4 concurrent lanes — exactly N−1,
which is what `maxInFlight=1` predicts. The counter is not merely non-zero; it
is *correct*.

---

## 5. Cold-latency regression from whole-chunk fetching

Brief §14: *"Be explicit about any cold-latency regression caused by
whole-chunk fetching."* There is one, and it is the lead-in.

**Mechanism.** A fetch span starts at `chunk_start`, not at the client's first
requested byte. A window that begins partway into a chunk therefore cannot be
forwarded a single byte until the provider has delivered everything from
`chunk_start` up to that byte. Bytes are *not* gated on the chunk completing —
streaming still begins as soon as the window is reached — but they *are* gated
on the lead-in.

**Proof L — paired A/B** (same binary, same workload; `SLICE4_CACHE=0` is the
identical no-cache path Slice 4.5 used). 3 cold reps of a deliberately
unaligned 1 MiB read per arm:

| Stage | Cache ON | Cache OFF | Δ |
|---|---|---|---|
| `total_open_ttfb_ms` | 761 | 440 | **+321** |
| `provider_ttfb_ms` | 329 | 358 | −29 |
| `acquisition_api_ms` | 108 | 82 | +26 |
| `downstream_handoff_ms` | **323** | **0** | **+323** |
| wall (client) | 864 | 696 | +168 |

The waterfall accounts exactly: cached 108 + 329 + 323 = 760 vs total 761;
uncached 82 + 358 + 0 = 440 vs total 440. **The entire TTFB delta is the
handoff.** Rep 1 of each arm carries capability acquisition (325 / 247 ms),
which is why three reps were taken rather than one.

**Proof L2 — the model isolated.** Composite TTFB is noisy on a real CDN
(`provider_ttfb` ranged 198–560 ms), so L2 measures the mechanism directly,
paired on one process:

| | lead-in | `downstream_handoff_ms` |
|---|---|---|
| chunk-aligned read | 0 B | **0 ms** (all 3 reps) |
| read starting 3 MiB into a chunk | 3,145,728 B | **272 ms** (238 / 288 / 290) |

Zero overlap between arms, implied throughput 11.03 MiB/s. The lead-in model is
**confirmed**, not fitted — and L2 was written so it could fail: if aligned
reads had shown the same handoff as unaligned ones, the cost would have had to
be attributed elsewhere.

**Characterisation.** The regression is:

- **bounded** by `chunk_size − 1` bytes of lead-in (worst case),
- **zero** for a chunk-aligned read,
- roughly `lead_in_bytes / provider_throughput` — ~272 ms per 3 MiB at the
  throughput observed here.

It does **not** affect warm reads: once the chunk is PRESENT the read is a local
pread (proof E: 0 upstream bytes, `full_hits` 1).

**Not done, by instruction.** The obvious mitigation — issue the provider Range
from the client's first byte and fetch the lead-in as a second range — is a TTFB
optimization. The stop condition forbids it here. *Recommendation only, not
implemented:* if cold-open latency for unaligned reads later matters, that
split-range fetch, or a smaller chunk size, are the two levers. This slice
deliberately does neither.

---

## 6. Overfetch (§12)

From proof D:

| Figure | Value |
|---|---|
| `bytes_requested` | 26,214,400 |
| `bytes_fetched_upstream` | 33,554,432 |
| `overfetch_bytes` | **7,340,032** |
| `overfetch_ratio` | **0.28** |

Retry/recovery traffic is kept **distinct** from intentional chunk overfetch:
`bytes_fetched_upstream − bytes_upstream_issued` is the retry/recovery figure
and was **0** in every proof (D and both H arms). Per-rep in L: 8,388,608 B
fetched for a 1 MiB request → 7,340,032 B overfetch, matching prediction.

Chunk size was **not** tuned (§12: "do not optimize chunk size").

---

## 7. Regressions vs Slice 4.5

| | Status |
|---|---|
| External HTTP Range contract (206/416, exact framing) | **preserved** (A) |
| Provider behavior, Slice 3.5 recovery, Retry-After, breaker | **preserved** (H); `transport.rs` untouched |
| Slice 4.5 instrumentation | **all live** — see §8 |
| Eviction budget rule | **preserved** (G) |
| **Cold-open latency, unaligned read** | **REGRESSED — lead-in, §5** |
| **Upstream bytes per cold read** | **REGRESSED — fixed-grid overfetch, §6** |

Both regressions are inherent to replacing arbitrary extents with a fixed grid
(brief §1) and are the trade §12 exists to measure. Neither is a correctness
regression.

---

## 8. Instrumentation liveness

All Slice 4.5 stages were confirmed **live on the chunk path**, not decorative:
`acquisition_api_ms`, `provider_connect_ms`, `provider_ttfb_ms`,
`downstream_handoff_ms`, `total_open_ttfb_ms`, `durable_sync_us`,
`current_bytes`, `limiter_waits`, provider/API/CDN accounting.

Two things worth recording:

- `stages_last` is written by the spawned task marginally *after* the client
  sees the response end, so an immediately-sampled report returns the previous
  request's waterfall (or null on a fresh proxy). Proofs L/L2 poll for the
  report whose `request` matches the range just issued. Sampling without that
  match produces a plausible-looking wrong number.
- All 32 surfaced cache metrics were audited for writes. None are dead. The
  audit's flagged "DEAD" hits were false positives — config values
  (`format_version`, `chunk_size`, `max_bytes`), live-computed ratios, and
  live-derived counts.

---

## 9. Defects found and fixed during this slice

1. **Buffer overrun panic** — `range end out of bounds: 31232 <= 16384`. The
   window clamp computed an *end offset* where a *length* was required
   (`z = oe - cs + 1`), overrunning whenever a fetch buffer straddled the
   client-window start — i.e. any non-chunk-aligned first byte. Extracted as
   `window_slice()` with 6 unit tests. **Mutation-verified**: reintroducing the
   bug fails 3 of the 6 tests while the 3 aligned/None cases still pass,
   mirroring exactly why it survived the chunk-aligned smoke test.
2. **`limiter_waits` semantic mismatch** — §4.
3. **No-op `drop()`** — dropping a `&mut` reference closes nothing; removed.
4. **Bind-before-announce** — the proxy printed "listening" before `bind`, so a
   startup that failed on `AddrInUse` still looked successful.
5. **Orphaned test proxies** — a driver that dies mid-proof leaves its child
   holding the port, and the next run's readiness probe gets answered by the
   *orphan*, reporting green results measured against the wrong process. This
   happened for real. Fixed with an EXIT/INT/TERM trap in the drivers plus
   `cleanup-proxies.sh`, which resolves `/proc/<pid>/exe` rather than using
   `pkill -f` (which matches its own command line and kills the script).
6. **Three vacuous proofs in my own harness**, each caught and fixed: proof F
   killed the process before a byte was written; proof G's budget stopped the
   sweep before it reached the FILLING guard; proof E's region ended mid-chunk
   so it could never complete. Proof C's expectation was also wrong — it sized
   regions from raw MiB offsets (340 MiB is chunk 42.5), so a "three chunk"
   request touched four. The implementation was right; the proof had invented an
   expectation the grid never implied.

---

## 10. Stop condition

Slice 4.75 is complete and committed as **a separate checkpoint** from Slice
4.5. Earlier commits preserved: `f3e9418` (slice4), `3dab1a5` (slice4 closure),
`066b802` (slice4.5), `b651521` (slice4.5 wording) in `frankenstein`;
`081a8f9`, `33d7045`, `78f3fc3` in `playback-bench`.

**No Slice 5 work. No S3. No TTFB optimization.**

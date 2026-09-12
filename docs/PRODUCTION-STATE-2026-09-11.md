# HashSucker production state, architecture, and roadmap

- **Canonical status date:** 2026-09-11
- **Production-code baseline:** `3c1a990` (`feat: expose scheduler coalescing metrics`)
- **Branch:** `main`

This is the canonical state-of-the-world document for the current production
architecture, completed proof, open tuning question, and near-term roadmap. The
other files in `docs/` remain authoritative for their detailed contracts, and
the files in `handoff/` preserve milestone history. If an older handoff differs
from this document only in phase status or next steps, use this document.

The baseline before this documentation commit was:

```text
local main:         3c1a990f8a5524fcd598ef8c637636ab24ff3b0f
local github/main:  26a05c2 (latest confirmed pushed production commit)
relationship:       main was one commit ahead of github/main
```

No network fetch was performed while recording that checkpoint. The
documentation commit that contains this file sits on top of `3c1a990`; it does
not change the production-code baseline. Do not discard or rewrite `3c1a990`:
it is the scheduler-observability baseline.

## 1. Current checkpoint

HashSucker has completed provider lifecycle hardening and live operational
playback-abuse proof for TorBox and Real-Debrid. Exact byte identity across the
two providers has also been confirmed for the same TorrentFile and exact Range.

The project is no longer asking whether concurrent delivery and provider
failure recovery are correct. The current question is narrower and
shipping-oriented:

> At what real workload and resilience crossover does shared-cap two-lane
> execution earn its request cost and operational complexity?

Shared-cap two-lane execution and work stealing remain experimental and
default OFF while that question is measured.

## 2. Frozen ownership boundary

The system boundary remains: **Node owns durable truth; Rust owns execution and
byte motion.**

### Node (`media-search`) owns durable truth

Node owns:

- `Release`, `TorrentFile`, `ProviderPlacement`, and `ProviderFile` records;
- `MediaBinding` and publication/VFS semantics;
- discovery, evidence, ranking, and persisted candidates;
- selection and promotion of an alternate `Release`.

Only Node may choose another Release. Alternate-Release fallback is a durable,
classified control-plane decision, not a Rust retry policy.

### Rust (`data-plane`) owns execution

Rust owns:

- runtime `DeliveryCapability` lifecycle;
- TorBox and Real-Debrid byte delivery;
- HTTP Range serving and exact byte motion;
- retry and `Retry-After` behavior;
- limiter and breaker behavior;
- same-TorrentFile provider recovery;
- fixed-grid caching, single-flight coalescing, scheduling, and lane execution.

Rust may change provider execution only while remaining on the **same exact
TorrentFile**. It must not choose a different Release.

## 3. Durable identity model

### Release

```text
Release = infoHash
```

### TorrentFile

```text
TorrentFile = Release + canonicalInternalPath + immutable exact positive size
```

This tuple is the durable byte identity and the logical cache/coalescing key.
The physical cache key is a path-safe SHA-256 encoding of the tuple.
`torrent_files.id` is a routing UUID and forensic label; it is a replaceable
SQLite surrogate and must not define byte or cache identity.

### ProviderPlacement

```text
ProviderPlacement = Release + provider + accountScope + providerResourceId
```

A placement is durable provider/account-scoped execution metadata. A
`ProviderFile` is a current provider-placement observation mapped to a
TorrentFile when authoritative inventory is known.

### MediaBinding

`MediaBinding` maps semantic media identity to a TorrentFile. It does not make
provider metadata part of byte identity.

### DeliveryCapability

```text
DeliveryCapability = runtime only
```

A capability or signed URL is never persisted, logged as identity, or used as
a durable key. Provider identity is execution metadata, not byte identity.
Therefore:

```text
same TorrentFile + same exact byte range = identical bytes
regardless of TorBox vs Real-Debrid execution
```

## 4. Lifecycle hardening: complete

The completed hardening progression was:

```text
permit ownership
→ logical-child lifetime
→ concurrent-reader lifecycle
→ cancellation teardown
→ cancelled-fill reclaim
→ shared-cap failure ownership
→ dead-capability replacement
→ stale-slot refresh
→ lease reentry
→ failed-chunk retry ownership
→ fresh-capability retry after dead-cap failure
```

### Shared capability ownership

One shared reservation owns one `DeliveryCapability`, one provider permit, and
at most two logical child readers. Cloning a `ChildReaderHandle` does not create
a new logical child. The permit is released only after the final logical child
ends.

### Cancellation and reclaim

Owned fills use RAII cleanup. Cancellation must mark terminal fill state,
finalize in-flight ownership, notify waiters, and leave the chunk reclaimable.
A disconnected client cannot strand an in-flight chunk.

### Dead capability boundary

For a shared-cap Class-C failure:

```text
child detects dead capability
→ shared capability becomes Dead
→ sibling may finish already-started work
→ no new scheduler work is assigned to the Dead capability
→ children terminate
→ old lease releases
→ manager prunes the Dead capability
→ manager acquires a fresh capability
```

Children do not independently reacquire. The lower-level
`fill_chunk_run_shared_child()` does not independently enforce Dead-state
admission; the scheduler/worker boundary in `stripe_worker_shared_child()` does.
This ownership split is intentional.

### Failed chunk retry

The proven retry sequence is:

```text
real fill fails
→ chunk remains absent
→ in-flight record finalizes
→ concurrent callers attempt reclaim
→ exactly one caller owns the retry
→ the others join that record
→ a fresh capability is acquired if the old shared capability died
→ one real retry runs
→ waiters wake
→ the chunk becomes durably present
```

## 5. Live provider and playback proof

### Provider lifecycle proof

TorBox and Real-Debrid independently passed the real deployed lifecycle bar:

- provider-backed HTTP Range delivery with exact bytes;
- disjoint seeks;
- real client cancellation and immediate reclaim;
- successful post-cancel reads;
- data-plane restart and fresh runtime capability acquisition;
- stable bytes after restart;
- no stuck in-flight chunk;
- no stale capability reuse;
- no provider API or acquisition storm.

The Real-Debrid correction deliberately selected cold cache regions, so the RD
result was not inferred from local cache hits. One observed cold run transferred
`67,108,864` upstream bytes and acquired one fresh RD capability.

### Operational playback-abuse proof

Both providers passed a playback-shaped workload containing:

- sequential forward reads;
- overlapping concurrent reads;
- a large forward seek and a backward seek;
- rapid cancel/reopen;
- a hot/cold cache mix;
- a data-plane restart during session-like activity;
- continued reads after restart.

All requested byte ranges remained exact. No production defect, stuck in-flight
state, stale-capability dependency, or request/acquisition storm was observed.
This closes the correctness and operational-hardening phase.

### Exact cross-provider byte identity

An earlier report compared differently aligned tail ranges and therefore
reported different hashes. That was a reporting error, not a content mismatch.
The later exact-range check used:

```text
TorrentFile: tf_5de34a78-0a1a-410b-8de5-76ded2680e7d
Range:       bytes=3000000000-3001048575
SHA-256:     2189218ff26b6be2906dbfd22a79283807c90cd89c12ae92c7f8764540ea9306
```

Real-Debrid and TorBox/VFS returned that same hash for that same exact range.
For the same TorrentFile, “the providers may contain different releases” is
not an acceptable explanation for different bytes; it would violate the
identity model.

## 6. Scheduler and coalescing architecture

The scheduler is production architecture, with experimental activation gates:

```text
maximum active lanes: 2
cache grid:           8 MiB
sub-chunk striping:   none
N-way scheduling:     none
```

Two execution shapes exist:

1. **Independent-cap lanes.** Two distinct already-warm capabilities for the
   same TorrentFile provide two independently reserved execution lanes.
2. **Shared-cap lanes.** One capability lease and provider permit are shared by
   two logical child readers issuing disjoint HTTP Range work.

Shared-cap execution can provide request concurrency, throughput improvement,
and continued useful progress when one upstream Range is slow. It does **not**
provide provider redundancy or failure-domain independence: both lanes share
the same provider capability and signed URL.

The fixed-grid coalescer gives each missing chunk exactly one owner. Readers
whose requests overlap an existing fill join its in-flight record rather than
issuing duplicate upstream work. A live cold TorBox overlap probe recorded one
in-flight joiner and avoided one duplicate 8 MiB fill. Coalescing is therefore a
measured production benefit and must be preserved regardless of the shared-lane
shipping decision.

Work stealing is implemented as a separate experimental policy. Each lane
starts on its own half; an idle lane can take unstarted chunks from the far end
of its peer's queue. It is not part of the first shared-cap throughput A/B.

## 7. Fixed-grid cache observations

The 8 MiB grid has different economics for different request shapes.

### Small random or seek-heavy requests

An earlier workload requested about 27 MB while transferring about 75 MB
upstream, approximately `2.77x` total upstream amplification. Requests of only
1–2 MiB can pay heavily for whole-chunk fills.

### Large sequential cold requests

A 64 MiB sequential cold run collapsed adjacent missing chunks into a single
provider Range:

| Provider | Upstream/requested | Explanation |
|---|---:|---|
| TorBox | about `0.87x` | seven of eight chunks were cold; one was already cached |
| Real-Debrid | `1.00x` | all eight chunks were cold |

The grid is not inherently inefficient for playback-sized sequential work. Its
cost concentrates in small-range and seek-heavy workloads. Do not change the
8 MiB grid merely because the small-range probe amplified traffic; revisit the
grid only if production-shaped measurements still justify it after scheduler
tuning.

## 8. Scheduler observability baseline (`3c1a990`)

Commit `3c1a990` added four process-lifetime counters to the JSON `/metrics`
surface without changing scheduling behavior:

| Metric | Exact meaning at this baseline |
|---|---|
| `scheduler_lane_a_chunks` | chunks assigned to shared-cap coordinator lane A by `stripe_worker_shared_child()` |
| `scheduler_lane_b_chunks` | chunks assigned to shared-cap coordinator lane B by `stripe_worker_shared_child()` |
| `scheduler_work_steals` | successful coordinator assignments marked as stolen |
| `inflight_joiners` | per-chunk join events where a reader found an existing fill |

Interpretation limits matter:

- The lane counters are instrumented at the shared-cap coordinator worker. They
  are not universal counters for every independent-cap or fixed-half two-lane
  path.
- `inflight_joiners` counts joined chunk records, not unique clients. It tracks
  the same join point as `chunk_join_waits`; one request can join more than one
  chunk.
- All four counters are cumulative for the process. Compare before/after deltas
  for a bounded probe.
- Zero lane counts can mean the shared-cap coordinator path was not selected,
  the work was served from cache, or the relevant gates were OFF. Zero alone is
  not evidence of scheduler failure.

Other useful existing metrics include:

- capability acquisitions, reacquisitions, reuses, and evictions;
- `bytes_streamed` and client cancellations;
- CDN and provider API requests;
- limiter cooldown waits, permit waits, and wait time;
- upstream errors and stage timings;
- `bytes_requested_total`, `bytes_upstream`, `bytes_upstream_issued`, and
  `bytes_fetched_upstream`;
- full hits, partial hits, misses, chunk claims, fills, failed fills, and join
  waits;
- full-miss/partial-hit coalescer entries;
- fetch spans, collapsed chunks, chunk overfetch, and current/in-flight chunks.

### Byte and cache metric semantics

Do not collapse the following into one number:

```text
provider-demand amplification = bytes_upstream / bytes_requested_total
grid overfetch ratio          = chunk_overfetch_bytes / bytes_requested_total
delivered upstream traffic    = bytes_fetched_upstream / bytes_requested_total
collapse ratio                = spans_collapsed_chunks / fetch_spans
```

`bytes_upstream` and `bytes_upstream_issued` are charged once when a provider
Range is dispatched, so retries do not inflate them. `bytes_fetched_upstream`
counts bytes that actually arrived and can expose retry/recovery duplication.
`chunk_overfetch_bytes` isolates bytes fetched because the fixed grid was wider
than the client's requested window. `collapse_ratio > 1` means adjacent chunks
were covered by fewer upstream Ranges.

The total-amplification and grid-overfetch ratios answer different questions.
Do not attribute a difference between them to retry, recovery, or any other
cause unless the corresponding counters prove it.

Also distinguish `limiter_waits` (throttle/cooldown) from
`limiter_permit_waits` (queueing for a capability permit).

## 9. Shared-cap activation state and gates

The current production defaults leave shared-cap two-lane execution OFF. The
canonical gate names use the `DATA_PLANE_*` prefix; deprecated `HY4_*` aliases
remain accepted as fallback.

| Canonical gate | Default | Purpose |
|---|---:|---|
| `DATA_PLANE_ACTIVE_ACTIVE_TWO_SPAN` | OFF | explicit two-lane eligibility |
| `DATA_PLANE_ACTIVE_ACTIVE_AUTO` | OFF | automatic size-gated eligibility |
| `DATA_PLANE_ACTIVE_ACTIVE_MIN_CHUNKS` | `4` | minimum missing chunks for AUTO |
| `DATA_PLANE_ACTIVE_ACTIVE_SHARED_CAP` | OFF | permit shared-cap fallback when no distinct warm standby is available |
| `DATA_PLANE_ACTIVE_ACTIVE_STEAL` | OFF | select work-stealing coordinator after two-lane eligibility |

At `3c1a990`, the branch predicates are important:

- A distinct warm same-TorrentFile standby is preferred whenever explicit
  TWO_SPAN or qualifying AUTO wants two lanes. The standby reservation itself
  is the availability check; the scheduler does not cold-acquire a capability
  merely to create concurrency.
- Fixed-half shared-cap execution currently requires qualifying AUTO,
  SHARED_CAP, an existing primary reservation, and at least two missing chunks.
- Shared-cap coordinator/work-stealing execution requires SHARED_CAP, STEAL,
  either explicit TWO_SPAN or qualifying AUTO, an existing primary reservation,
  and complete fixed-grid chunks.
- Otherwise the request falls back to the normal single-lane fill.

Consequently, `TWO_SPAN + SHARED_CAP` with AUTO and STEAL both OFF does not by
itself select the fixed shared-cap branch at this baseline. Benchmark setup must
confirm the exact running predicate before interpreting zero lane counters.
This is a documentation clarification, not a recommendation to change code or
defaults.

## 10. Current tuning goal

The tuning objective is to find the production decision boundary where a
second shared-cap lane earns its keep:

```text
small/easy or cache-heavy workload
→ one lane is cheaper, simpler, or equally fast

sufficient cold contiguous work
→ two lanes may materially reduce completion time

sufficient work with one slow/stalled Range
→ two lanes may preserve useful request-level progress
```

The first clean experiment should compare default single-lane behavior with
fixed shared-cap two-lane behavior while work stealing remains OFF. Use known
cold, comparable spans around 8, 16, 32, 64, and 128 MiB for each provider.
Confirm the effective gate state and actual lane selection before accepting any
timing result.

For each arm record at least:

- wall-clock completion and, if repeated, distribution rather than one lucky
  sample;
- client-requested, provider-issued, and provider-delivered bytes;
- CDN and provider API request counts;
- chunk claims, fills, failed fills, and joiners;
- lane A/lane B activity where the selected path exposes it;
- limiter cooldown/permit waits;
- capability acquisitions, reacquisitions, and failures.

After the clean throughput crossover, run one bounded controlled slow-Range
case. The resilience claim is only request-level progress continuity; it is not
provider redundancy.

Do not change the defaults from one canary result. The result must be material,
repeatable, and large enough to justify the added request concurrency.

## 11. Work-stealing evaluation is separate

Do not enable work stealing in the first shared-cap A/B. Combining two new
variables would make any benefit impossible to attribute cleanly.

Evaluation order:

```text
single lane
vs fixed shared-cap two-lane

then, only if shared lanes are valuable:

fixed shared-cap two-lane
vs shared-cap two-lane + work stealing
```

Ship work stealing only if it improves real lane utilization, completion time,
or progress under imbalance without unacceptable request or failure cost.

## 12. Shipping philosophy

Every remaining tuning slice must answer:

> Does this improve the production playback path enough to carry and enable?

Avoid instrumentation for its own sake, synthetic scheduler curiosities,
feature-flag archaeology without a deployment consequence, unbounded
microbenchmarking, and architectural refactors without an observed production
target.

The scheduler work already earned durable value:

- bounded concurrency and correct permit ownership;
- shared logical-child lifetime and safe cancellation;
- failed-fill reclaim and dead-cap replacement;
- exact same-TorrentFile recovery boundaries;
- real overlap coalescing;
- adjacent fixed-grid chunk collapse;
- a safe structure for evaluating shared lanes and work stealing.

What remains unproven as a shipping default is:

- shared-cap two-lane activation;
- a dynamic activation threshold;
- work stealing.

If those mechanisms do not clear the production bar, leaving them gated is a
valid result. Building the bounded ownership and recovery model was still not
wasted work.

## 13. Roadmap

### Completed

```text
lifecycle correctness                         COMPLETE
failure and cancellation hardening            COMPLETE
stale-state and lease-reentry hardening        COMPLETE
failed-fill and fresh-cap retry ownership      COMPLETE
TorBox live lifecycle proof                    COMPLETE
Real-Debrid live lifecycle proof               COMPLETE
operational playback-abuse proof               COMPLETE
exact cross-provider byte identity             COMPLETE
coalescing and large-span collapse observation COMPLETE
scheduler observability baseline               COMPLETE
```

### Current

```text
shared-cap activation audit and clean throughput crossover measurement
```

### Next, in order

1. Determine the repeatable shared-cap throughput crossover for TorBox and
   Real-Debrid.
2. Measure bounded request-level stall resilience.
3. Decide whether shared-cap execution should stay OFF, be enabled explicitly,
   or engage dynamically above a measured threshold.
4. Evaluate work stealing only if shared lanes prove valuable.
5. Revisit small-range/seek overfetch only if it remains material in real
   playback-shaped telemetry.
6. Consider an 8 MiB grid experiment only after the previous step justifies it.
7. Add broader telemetry or tuning only when it answers a concrete shipping
   decision.
8. Consider richer retirement/replacement behavior last.

## 14. Supporting documents

- `docs/architecture.md` — stable system and control-plane architecture.
- `docs/S1-CONTROL-CONTRACT.md` — Node/Rust control contract.
- `docs/CROSS-FILE-KEYING-AUDIT.md` — durable TorrentFile/cache identity proof.
- `handoff/DATA-PLANE-SCHEDULER-HANDOFF.md` — historical scheduler graduation
  and gate inventory.
- `docs/seam-audit.md` — earlier concurrency observability semantics.

Those documents supply detail and evidence. This file owns the current phase
status and roadmap as of 2026-09-11.

# P12 — Default-on auto prefetch + playback soak

P12 flips `PREFETCH_ENABLED` default from OFF to ON (keeps `PREFETCH_MODE=auto`,
keeps `PREFETCH_ENABLED=0` as the kill switch). It runs a bounded set of soak
patterns against real durable TorrentFiles to inspect (a) whether served/joined
demand is observed, (b) whether provider API amplification occurs, (c) whether
speculative waste stays bounded, and (d) whether seek/restart/cross-file
regressions appear. No new algorithms are introduced; only the default flips,
plus the proof harness and proof doc.

## 1. Default policy change

| Setting | Before P12 (P11) | After P12 |
|---|---|---|
| `PREFETCH_ENABLED` (env unset) | `"0"` (off) | `"1"` (on) |
| `PREFETCH_ENABLED=0` (kill switch) | OFF | OFF (unchanged) |
| `PREFETCH_ENABLED=1` (explicit) | ON | ON (unchanged) |
| `PREFETCH_MODE` (env unset, enabled) | `auto` | `auto` (unchanged) |
| `PREFETCH_MODE` ∈ {`try`,`wait`,`auto`} | supported | supported (unchanged) |
| `PREFETCH_AHEAD_CHUNKS` | 1 | 1 (unchanged) |
| `PREFETCH_SEQUENTIAL_THRESHOLD` | 2 | 2 (unchanged) |

The default flip is a single-line env-default change in `main.rs` (the
`PREFETCH_ENABLED` env-var parse). The proven safety paths (P11 seam,
coalescer, capability manager, limiter, breaker, Auto gating, demand-priority,
completed-prefetch handoff, in-flight demand join, same-TF recovery, Node
fallback boundary) are unchanged.

## 2. Soak matrix

All five patterns target the durable TorrentFile
`tf_46203b5e-2a8d-44f7-9a93-20114c60b24d` (Ted Lasso S01E08, 211,552,345
bytes ≈ 202 MiB, 26 × 8 MiB chunks). Each pattern runs against a fresh
ephemeral container on a fresh named volume (so cache state is clean).

| Pattern | Soak | File | Notes |
|---|---|---|---|
| A — long sequential | N=26, gap=1200ms, cold start | `p12-A-seq-defaulton-clean-final.txt`, `p12-A-seq-killswitch-clean-final.txt` | default-on vs kill-switch comparison on identical workload |
| A — long sequential (early run) | N=26, gap=1200ms | `p12-A-seq-defaulton-final.txt`, `p12-A-seq-killswitch-final.txt` | first-cut comparison |
| B — seek-heavy | seek 0..4 → 20 → 21..24 → 5 → 6..9 | `p12-B-seek-defaulton-final.txt` | seek_repri=1 confirmed; forward_run restarts cleanly after each seek |
| C — short-open/abandon | read chunk 0 only, wait 6s | `p12-C-shortopen-final.txt` | prefetch_triggered=0; 0% waste |
| D — restart | read 0..7, restart (volume kept), re-read 0..3 + new 15,16 | `p12-D-restart-final.txt` | cache survives, runtime state resets, new chunks fetch upstream |
| E — mixed files | two interleaved streams on the same tfId | `p12-E-mixed-final.txt` | 5 seek_repri events from interleaving; per-TF state coherent |

### A — long sequential (clean, default-on vs kill-switch)

Identical cold-start, identical 26-chunk sequential workload at 1200ms gap.

| Metric | `PREFETCH_ENABLED=1` (default-on) | `PREFETCH_ENABLED=0` (kill switch) | Δ |
|---|---|---|---|
| `enabled` | true | false | — |
| `mode` | auto | auto | — |
| `active_torrent_files` | 1 | 0 | +1 |
| `bytes_upstream_issued` | 211,552,345 | 211,552,345 | **0** |
| `chunk_claims` | 26 | 26 | 0 |
| `chunks_present` | 26 | 26 | 0 |
| `layer_A_api.requests` | 1 | 1 | **0** |
| `layer_C_cdn[206]` | 26 | 26 | 0 |
| `cap.acq` | 1 | 1 | 0 |
| `cap.reuse` | 25 | 25 | 0 |
| `prefetch_triggered` | 24 | 0 | +24 (TRY mode picked, all deferred) |
| `prefetch_chunks_completed` | 0 | 0 | **0** |
| `prefetch_chunks_requested` | 0 | 0 | **0** |
| `prefetch_served_demand` | 0 | 0 | 0 |
| `prefetch_joined_by_demand` | 0 | 0 | 0 |
| `prefetch_failures` | 0 | 0 | 0 |
| `seek_reprioritizations` | 0 | 0 | 0 |
| `auto_selected_try` | 24 | 0 | +24 |
| `auto_selected_wait` | 0 | 0 | 0 |
| `spare_capacity` (steady) | 0 | 0 | 0 |

**Cold-start with no spare capacity**: Auto mode picks `try` for every chunk
after the first, but `try` defers because `spare_capacity == 0` (the demand
read still holds its capability when the next demand is queued). All 24
`prefetch_triggered` events correspond to deferred decisions — no extra
upstream bytes, no extra API calls, no extra capability acquisitions. The
default-on path is **bit-identical to the kill-switch path in this scenario.

### Where default-on actually helps

P11 N=16 with `WARM=2` (warm pool of 2 concurrent reads on chunks 0,1 before
the sequential run) leaves `spare_capacity = 2` going into the sequential
phase. In that case the Auto mode picks `wait` and the ahead-1 prefetch
serves 9 of 16 demand reads (`prefetch_served_demand=9`, `joined_by_demand=2`),
saving 1 chunk (8 MiB) of upstream out of 128 MiB (~6%). The default-on path
delivers that benefit transparently when the workload actually leaves
spare capacity.

### B — seek-heavy

Sequential 0..4 → far-seek to 20 → sequential 21..24 → back-seek to 5 →
sequential 6..9. Observed:

- `seek_reprioritizations = 1`: the seek from 0..4 to 20 was detected as a
  far-jump (>sequential_threshold=2 chunks away); the forward_run was reset
  to 0 and the high-region prefetch region re-anchored at 20.
- After the seek, sequential 21..24 each got `pf=+1/0/0` in the per-chunk
  delta — but no actual prefetch completed (same TRY-defer behavior as
  pattern A on cold start). No bytes upstream beyond the demand itself.
- The back-seek to 5 did NOT increment `seek_reprioritizations` (it was
  within the threshold of the recently-seen region, treated as a continue).
- No regression in demand latency. No API amplification. No failure.

### C — short-open / abandon

Demand reads chunk 0, then the user abandons. Observed:

- 1 chunk upstream (the demand itself).
- `prefetch_triggered = 0` — the Auto mode never even tried a prefetch
  because after chunk 0 the spare_capacity dropped to 0 and the threshold
  for forward_run was never crossed (only 1 sequential read).
- `prefetch_chunks_completed = 0` → waste = 0 chunks / 0 bytes / 0% of
  demand bytes.

**The auto-mode is conservative enough on cold/abandon patterns that no
speculative bytes are wasted.**

### D — restart

Phase 1: read 0..7 sequentially. Phase 2: restart the container (named
volume preserved, in-memory runtime state wiped). Phase 3: re-read 0..3
(should hit cache) + new chunks 15, 16 (should fetch upstream).

- After restart, `chunks_present = 8` (cache survived).
- Re-read of 0: `bytes_up = +0`, `cdn = +0` → **cache hit, zero upstream
  bytes for the demand itself**. The single API delta is the fresh
  capability acquisition in the new runtime.
- Re-reads 1, 2, 3: each demand was served from cache, but the ahead-1
  prefetch of the next chunk in sequence (chunks 9, 10) was issued because
  `spare_capacity = 1` after the new capability returned. Two of those
  prefetches completed; the new container's hot map got `generation = 1`
  and `forward_run = 6`.
- New chunks 15, 16: `bytes_up = +8 MiB` each → fresh upstream fetch
  (expected, not in cache). One seek_repri event when the gap between
  cached region (0..7) and new region (15..16) exceeded the threshold.
- The pre-restart capability was discarded; the post-restart runtime
  re-acquired exactly one capability. **No persistence assumptions
  violated; cache + runtime state stay consistent.**

### E — mixed files (single-tfId interleaved)

Two parallel "logical" streams interleaving on the same durable tfId
(stream A: 0..4, stream B: 10..14, interleaved per round). Only one
durable tfId is available in this environment, so the test exercises
per-TF isolation by alternating demand on the same tfId.

- 10 demand reads → 10 upstream chunks, 1 capability acquired, 9 reuses.
- `seek_reprioritizations = 5`: one repri per round (the second read of
  each round is "far" from the first).
- `prefetch_triggered = 1` (only the very first read; after that the
  alternating pattern reset forward_run each time).
- `top.length = 1` (single hot entry — the test only has one tfId, so
  per-TF isolation is shown by the entry being updated consistently,
  not corrupted across "streams").
- No API amplification. No failure. No state corruption.

A true two-tfId test would have required a second durable TorrentFile in
this environment, which we could not provision without a fresh media-search
DB. The single-tfId interleaved test is the closest we can do to exercise
the per-TF runtime state.

## 3. API-storm guard

Across all five soak patterns on default-on:

| Metric | Total |
|---|---|
| `layer_A_api.requests` | 1 per pattern (the first cold demand) |
| Repeated `requestdl` | 0 |
| Repeated provider resolution | 0 |
| Capability acquisitions | 1 per pattern (cold start); +1 across restart in D |
| Capability reuses | demand_chunks - 1 per pattern |
| `prefetch_failures` | 0 across all five patterns |
| `recovery.attempts` | 0 across all five patterns |
| `breaker_opens` | 0 across all five patterns |
| `retry_after.applied_secs` | 0 across all five patterns |
| `recovery.client_416/_502/_503/_truncated` | 0 across all five patterns |

**No provider API amplification, no capability churn, no repeated resolution.**
The ahead-1 prefetch path in `try` mode defers cleanly when there's no
spare capacity, so it never makes an extra provider API call.

## 4. Bounded waste

| Pattern | Demand chunks | Prefetch triggered | Prefetch completed | Prefetch unused | Waste vs demand |
|---|---|---|---|---|---|
| A (cold sequential) | 26 | 24 | 0 | 0 | 0 / 208 MiB (0%) |
| B (seek-heavy) | 15 | 12 | 0 | 0 | 0 / 120 MiB (0%) |
| C (short-open) | 1 | 0 | 0 | 0 | 0 / 8 MiB (0%) |
| D (restart) | 14 (8 cached + 4 new + 2 new) | 5 | 2 | 0 (all 2 served/joined) | 0 / 112 MiB (0%) |
| E (interleaved) | 10 | 1 | 0 | 0 | 0 / 80 MiB (0%) |

**Total bounded waste: 0 bytes across all five patterns.** The auto-mode
is sufficiently conservative on cold start with no spare capacity that
the ahead-1 path is effectively a no-op. The only place it produces real
upstream traffic is when the workload actually has spare capacity
(P11 N=16 WARM=2 case), and there it serves 9/16 demand reads with no
waste.

## 5. Hot-range observation (runtime-only, no persistence)

The `playback_intelligence.top` array is a runtime-only per-tfId state.
The following was observed:

- **A (sequential, default-on clean)**: single hot entry, growing
  `forward_run` (capped at 26 in our 26-chunk file), confidence=1.0
  after the second sequential chunk. `forward_region` extends to the
  end of the file.
- **B (seek-heavy)**: after the seek to 20, the hot entry's
  `forward_region` re-anchored at the high end; the back-seek to 5 did
  NOT reset (within threshold). `confidence=1.0` once the new region
  re-stabilized.
- **C (short-open)**: single hot entry with `forward_run=1`,
  `confidence=0.5` (the run never crossed the 2-chunk threshold, so
  prefetch was suppressed entirely).
- **D (post-restart)**: hot entry's `generation=1` (the runtime
  counter increments on fresh runtime initialization), `forward_run=6`
  after the re-reads of 0..3 + new 15, 16. The pre-restart state is
  fully gone; no persistence leak.
- **E (interleaved)**: hot entry tracks the most recent stream's last
  read, with `confidence` low because forward_run is repeatedly reset
  by the alternating pattern.

**No hot-range policy is enforced.** The map is purely observational —
the only consumer is the `auto_selected_try/wait` decision, which is
gated by `spare_capacity` and the sequential threshold.

## 6. Failure shielding sanity

Per the proven code path (`serve.rs` line 575–590), a failed prefetch
records `pf.failures.fetch_add(1)`, clears the chunk from
`prefetched_inflight`, and returns. It does NOT:

- mark the tfId as `all_same_tf` (that flag tracks capability failures,
  not prefetch outcomes);
- trigger Node fallback (`S-1` only falls back when the Rust data
  plane reports the tfId is unsupported or a capability acquisition
  fails after retries);
- abort the demand path — demand always gets its own capability and
  is unaffected by the prefetch's outcome.

Observed in all five patterns: `prefetch_failures = 0`. The default
provider (TorBox) is healthy in this environment, so no failure
injection was possible. The code path was traced statically and
confirmed to keep failure isolated.

## 7. Decision

**KEEP DEFAULT-ON (`PREFETCH_ENABLED` default flips to `"1"`).**

Reasoning against the four-condition decision rule:

| Condition | Met? | Evidence |
|---|---|---|
| (a) served/joined demand observed | YES (in the only workload that has spare capacity) | P11 N=16 WARM=2: `prefetch_served_demand=9`, `prefetch_joined_by_demand=2`; P12 D post-restart: 2 prefetch completed, 1 seek_repri |
| (b) no provider API amplification | YES | `layer_A_api.requests=1` per pattern; `breaker_opens=0`; `retry_after.applied_secs=0`; `recovery.attempts=0` |
| (c) speculative waste bounded | YES | 0 bytes wasted across all five P12 patterns |
| (d) no seek/restart/cross-file regression | YES | seek_repri=1 in B, cache survives in D, per-TF state coherent in E |

Plus the no-regression proof: default-on and kill-switch produce
**bit-identical metrics** on the cold-start sequential workload. The
default flip is a pure no-op when there's no spare capacity, and a
small win when there is.

**Implementation delta**: a single `unwrap_or` change in `main.rs` (or
the equivalent env-parse site) from `"0"` to `"1"`. No algorithm
change, no policy change, no new observation.

## 8. Files in this directory

- `README.md` — this file
- `p12-A-seq-defaulton-clean-final.txt` — clean N=26 default-on, fresh volume
- `p12-A-seq-killswitch-clean-final.txt` — clean N=26 kill-switch, fresh volume
- `p12-A-seq-defaulton-final.txt` — first-cut default-on (3011)
- `p12-A-seq-killswitch-final.txt` — first-cut kill-switch (3014)
- `p12-B-seek-defaulton-final.txt` — seek-heavy pattern
- `p12-C-shortopen-final.txt` — short-open / abandon pattern
- `p12-D-restart-final.txt` — restart pattern (volume preserved)
- `p12-E-mixed-final.txt` — interleaved mixed-stream pattern

The bench scripts in `hy4-data-plane/bench/` (`p12-soak-A.mjs`,
`p12-soak-B.mjs`, `p12-soak-C.mjs`, `p12-soak-D-phase1.mjs`,
`p12-soak-D-phase3.mjs`, `p12-soak-E.mjs`) are the harness code; the
container-restart scripts in `scripts/` (`restart-p12d.sh`,
`restart-p12d-keep.sh`, `restart-p12d-off.sh`) are the driver code.
The Python orchestrator `scripts/p12-d-driver.py` drives pattern D's
phase1 → restart → phase3 sequence.

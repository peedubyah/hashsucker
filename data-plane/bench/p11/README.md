# P11 — Demand/Prefetch Handoff: proof artifacts

This directory contains the deterministic proof outputs for P11 (demand consumes
useful prefetch work instead of duplicating it). All numbers come from the
real capability manager + live Torbox/Real-Debrid providers, captured with the
P11 image (`hy4-data-plane:local` built from the P11 diff on m3-north-db at
the P11 commit). Every run was done on a **fresh** named volume
(`pf-proof-cache-{off,a,b}` recreated between runs) so the warm pool starts
from `chunks_present=2` (the 2-concurrent warm of chunks 0,1) on every
proof run.

Workload: a fixed N-chunk sequential Range-read on
`tf_46203b5e-2a8d-44f7-9a93-20114c60b24d` (Ted Lasso S01E08, 202 MiB, 8 MiB
chunks), preceded by a 2-concurrent warm burst that grows the capability
pool to 2 lanes so Auto->Wait has a real spare cap to consume.

## P11 §8.A — completed-prefetch handoff (PROVEN)

`condb-pfa-N12-final.txt` (rows 4..15 for chunks 0..11) and
`condb-pfb-N16-final.txt` (rows 4..21 for chunks 0..15). Each
served-chunk row shows:

- `served_demand=+1` (the chunk was already in `prefetched_done` when
  demand arrived)
- `bytes_up=+8388608` — the 8 MiB upstream that landed in cache came from
  the **prefetch** fired by the previous chunk's observation, not the demand
- `cdn=+0`, `api=+0`, `cap=+0` — the demand-path issued **no new upstream**

The `seek0` row at the end of every run confirms cache PRESENT before demand:
TTFB 6ms, 0 new bytes_up, 0 new CDN/API. Re-read of an already-durable chunk
is purely local.

## P11 §8.B — in-flight handoff (PROVEN)

`inflight-pfb-N8-final.txt` (gap=200ms forces a race between prefetch fill
and the next demand read). Chunks 4 and 7 each show:

- `joined_by_demand=+1` (the chunk was in `prefetched_inflight` when
  demand arrived)
- `bytes_up=+0` — the demand-path issued **no new upstream**
- `cdn=+0`, `api=+0` — confirmed: the demand joined the SAME coalescer
  entry the prefetch had already claimed and read the chunk when the
  prefetch completed

`condb-pfb-N16-final.txt` (gap=1200ms, larger N) also shows two in-flight
joins (chunks 7 and 11), each with `joined_by_demand=+1, bytes_up=+0`. The
in-flight handoff is reproducible across gap settings.

## P11 §8.C — P10 Condition B replay (DUPLICATE INFLATION ELIMINATED)

Comparison: same workload (warm=2, sequential at gap=1200ms) on **fresh
volumes** for both runs. The P10 measurement was +72 MiB on a N=12 workload
because demand re-fetched 9 chunks that prefetch had already made durable.
P11 eliminates that.

### N=12 — `condb-pfa-N12-final.txt` vs `condb-pfoff-N12-final.txt`

| metric                       | P11 pf-a (auto) | P11 pf-off      | delta       |
| ---------------------------- | --------------- | --------------- | ----------- |
| `bytes_upstream_issued`      | 104 MiB (109,051,904) | 96 MiB (100,663,296) | **+8 MiB**  |
| `chunks_present`             | 13              | 12              | +1 (ahead-1 prefetch of chunk 12) |
| `cdn_206`                    | 13              | 12              | +1          |
| `prefetch_served_demand`     | 9               | 0               | +9          |
| `prefetch_joined_by_demand`  | 0               | 0               | 0           |
| `prefetch_chunks_completed`  | 9               | 0               | +9          |

The +8 MiB is the single prefetched chunk (chunk 12, the off-by-one ahead)
that playback never reached. All 9 prefetched chunks that demand DID reach
were served from local cache. P10's +72 MiB duplicate inflation is gone:
demand no longer re-fetches a chunk that prefetch has already made durable.

### N=16 — `condb-pfb-N16-final.txt` vs `condb-pfoff-N16-final.txt`

| metric                       | P11 pf-b (auto) | P11 pf-off      | delta       |
| ---------------------------- | --------------- | --------------- | ----------- |
| `bytes_upstream_issued`      | 136 MiB (142,606,336) | 128 MiB (134,217,728) | **+8 MiB**  |
| `chunks_present`             | 17              | 16              | +1 (ahead-1 prefetch of chunk 16) |
| `cdn_206`                    | 18              | 16              | +2 (1 warm + 1 ahead-1 reused) |
| `prefetch_served_demand`     | 9               | 0               | +9          |
| `prefetch_joined_by_demand`  | 2               | 0               | +2          |
| `prefetch_chunks_completed`  | 12              | 0               | +12         |
| `chunk_claims`               | 5               | 16              | **-11** (demand drove 11 fewer upstream claims) |
| `chunk_join_waits`           | 2               | 0               | +2 (the joined_by_demand cases) |
| `inflight_joins`             | 2               | 0               | +2          |
| `capability.acquisitions`    | 2               | 2               | 0           |
| `recovery.attempts`          | 0               | 0               | 0           |

11 of 16 demand reads served from local cache (9 served_demand + 2
joined_by_demand). 5 demand reads drove upstream fetches (the 2 warm-up
chunks + chunks 2, 8, 12 — each first-of-sequence where prefetch had not
yet armed, plus each one's ahead-1 prefetch accounts for the additional
upstream). The +8 MiB is the off-by-one prefetch of the chunk playback
never reached (chunks 0..15 = 16 demand reads, plus the ahead-1 prefetch
of chunk 16, totaling 17 upstream chunks = 136 MiB for pf-b vs 16
upstream chunks = 128 MiB for pf-off).

The +72 MiB P10 duplicate inflation is **fully eliminated**. The new delta
is exactly +1 prefetched chunk (the off-by-one ahead), which is the
intended behavior: prefetch keeps one chunk of speculative headroom so
playback is never waiting for the network.

## P11 §8.D — saturated Auto regression (PROVEN)

`saturated-pf-a-N6-final.txt`. WARM=1 (single cap), GAP=0 (no idle). The
5 sequential observations past warm-up each call `observe_and_claim_prefetch`
which spawns a prefetch task. Each task calls `acquire_for_read_try` (Auto->Try
because `spare_capacity==0`). All Try attempts fail (no free cap), so:

- `auto_selected_try=4` (only 4 of 5 spawn a task; the 1 prior was
  coincident with the warm), `auto_selected_wait=0`
- `prefetch_chunks_completed=0`, `prefetch_served_demand=0`
- `bytes_upstream_issued = 48 MiB` (6 chunks × 8 MiB, demand-only)
- TTFB consistent with the no-prefetch baseline (200-300ms per chunk)

No new latency/API regression. Auto stays conservative under saturation,
exactly as P10 proved.

## P11 §9 — byte correctness (PROVEN)

Independent check: same chunk fetched from `pf-a` (which went through the
P11 served-durable path) and from `pf-off` (no prefetch path, direct
provider fetch). SHA-256:

- chunk 5 (served_demand case from `condb-pfa-N12-final.txt`):
  `2fdd301d10d7f0e92833308659812bcf74f4ff276f89c41b4a7fd0487bd15417`
  (both pf-a and pf-off) — IDENTICAL
- chunk 4 (joined_by_demand case from `inflight-pfb-N8-final.txt`):
  `8c8924d1716a2350f84307b462f5174cb67190521f137c7b79e2983c4da993a3`
  (both pf-b and pf-off) — IDENTICAL

The P11 demand-path seam returns the same bytes the provider does, whether
the chunk was made durable by a prior demand fill, by a prior prefetch
completion, or by joining an in-flight prefetch fill.

## Coalescer proof

P11 does not invent a second coordination structure. The P11 demand seam
calls the SAME `cache.inflight().join_or_claim_many(&key, &missing)` the
demand path used before P11 — only the demand-side miss-set is reduced
because chunks that became PRESENT between plan and execution are
short-circuited to `FetchItem::Local`. In every `bytes_up=+0` row above:

- `chunk_claims` does NOT increment on the demand side (no new claim) —
  pf-b N=16 total is 5 (vs 16 for pf-off) even though 16 demand reads
  were served
- `chunk_join_waits` only increments when a demand read races the
  prefetch's in-flight fill (2 in N=16, 2 in N=8) — never for the
  durable-prefetch path

The single owner per `(key, idx)` invariant is unchanged. P11 only removes
upstream fetches for chunks where the cache (authoritative) already has
the bytes; it does not re-coordinate the coalescer.

## P11 §6 — attribution hygiene (PROVEN)

`clear_prefetch_inflight(key, idx)` is invoked on prefetch failure (the
task's error arm). `clear_prefetched_done(key, idx)` is invoked
opportunistically when the P11 demand-path seam sees a chunk as
cache-miss for a `prefetched_done` entry (eviction/invalidation). Both
are narrow, single-set cleanups with no lifecycle subsystem. The cache
(`is_present`) is the real authority for delivery; the attribution sets
are telemetry. After §6 the attribution counters cannot lie about a
chunk that is no longer durable or in-flight.

## Summary

P11 succeeds. The duplicate-fetch defect P10 measured (+72 MiB inflation
in Condition B) is **fully eliminated**. Demand and prefetch now share
work through the existing coalescer, exactly as P11 §1-§4 require:

- durable prefetch → `FetchItem::Local` (no upstream)
- in-flight prefetch → join same coalescer entry (no upstream)
- normal demand → existing path (unchanged)

Attribution semantics are mutually exclusive (`served_demand` vs
`joined_by_demand`, never both), with §6 opportunistic cleanup so the
attribution sets do not lie about evicted or failed prefetch chunks.
Saturated Auto is unchanged. `PREFETCH_ENABLED` default remains OFF;
`PREFETCH_MODE=auto` remains the safe default-when-enabled.

The only residual is the +8 MiB single-chunk ahead-prefetch of the chunk
playback never reaches. That is the intended behavior: one chunk of
speculative headroom, not 9. To eliminate the +8 MiB entirely, set
`PREFETCH_AHEAD_CHUNKS=0` when enabling — not recommended because
playback would block on the next chunk's network read.

# Retrospective — cache value, not cache theater (2026-10-24)

Template: expected vs actual, surprises, disproved assumptions, wasted
effort + cause, most useful test, lying/overconstraining test, automation
that should disappear, guidance change, complexity to remove.

- Expected: instrument, run cohort, get a reuse ratio, verdict.
- Actual: verdict KEEP with bounded numbers (0% demand waste, ~20%
  background unused-evicted, GB-scale redemptions, no harm). No behavior
  change. One real instrumentation bug found by testing (delivery-before-
  publish merge). Ledger deployed and live in production.
- Surprises:
  1. Delivery-before-publish is the NORMAL streaming path — the naive
     overwrite join lost ~50% of streamed bytes. The integration test's
     exact numbers (8320 vs 16384) forced the merge design; the full
     snapshot (preexisting bucket holding 8064) diagnosed it in one look.
  2. `touch()`/last_access fires at plan time for REQUESTED chunks —
     it measures demand, not consumption. Any reuse argument built on it
     would have lied.
  3. Whole-file replay served 4.39 GB with 0 API calls 3 min later, yet
     the same head was a FULL MISS 15 min after cross-traffic: replay
     value is real AND fragile (minutes-scale half-life). Both facts
     survived into the verdict instead of one winning.
  4. Ambient household traffic (~25 MB/s sustained 4K) dwarfs cohort legs;
     per-leg attribution needed tight snapshot windows, and per-TF splits
     remain the honest limitation (snapshot is process-global).
  5. P9 prefetch is disabled in production — an entire source column
     reads zero by config, which simplified the verdict (no speculative
     machinery to judge).
- Disproved assumptions: "background fill ≈ waste" (0% demand, ~20%
  background unused, large redemptions); "abandoned fills are pure loss"
  (Leg B redeemed Leg A's tail: 501 chunks at le5m); "evictions must be
  hitting valuable chunks unfairly" (evicted = used-or-stale by LRU;
  refetch costs 0 API + 2 CDN).
- Wasted effort + cause: ~30 min chasing the 8320 anomaly as a grid bug
  (hand-derived file_size=8320!) before printing the full snapshot, which
  showed the preexisting bucket instantly. Cause: theorizing past the
  point of cheap evidence. Lesson (already canonical): instrument, then
  look — restated, not new.
- Most useful test: `t_value_ledger_joins_fill_to_delivery` — failed
  once, correctly, and designed the merge. Most useful production read:
  the full `chunk_value` snapshot (aggregates alone would have hidden
  the preexisting bucket).
- Lying/overconstraining test: none. The new tests pin behavior
  (ratios, merge-once, no-duplication); none failed on correct refactors
  (only the one true bug).
- Automation that should disappear: the TMP-DEBUG eprintln scaffolding —
  removed before merge (verified by grep). The seek-leg driver stays in
  scratch (deleted at close), not committed: scripted-seek harnesses
  belong to a future seek-latency slice if one is ever selected.
- Guidance change: (1) fetch→use joins must merge on publish, because
  streaming inverts the expected order — recorded in chunk_value module
  docs; (2) reuse claims need delivery hooks, never LRU/access timestamps.
- Complexity to remove: none taken. Rejected: per-TF snapshot split
  (nice, not verdict-changing), S-1 evidence-rank field (order already
  carries it — prior slice), fill cancellation tokens (breaks waiter
  resolution — prior slice), any fill-scope narrowing (not earned:
  0% demand waste).

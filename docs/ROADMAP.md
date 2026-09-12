# HashSucker shipping roadmap

This roadmap contains only remaining work that can plausibly improve playback,
correctness, reliability, provider behavior, or product graduation. Durable
architecture belongs in [`architecture.md`](architecture.md); the verified
checkpoint belongs in
[`PRODUCTION-STATE-2026-09-11.md`](PRODUCTION-STATE-2026-09-11.md); the next
agent's immediate instructions belong in [`../handoff/CURRENT.md`](../handoff/CURRENT.md).

## Phase A — Scheduler shipping decision

**Production problem:** Cold provider-backed playback can experience request
serialization or stalls, but a second shared-cap lane also increases Range
request concurrency and operational complexity.

**Why it matters:** The scheduler should be enabled only where it produces a
repeatable playback or resilience improvement large enough to justify its
provider cost. Correct implementation alone is not a reason to enable it.

**Required evidence:** Consume the active LongCat single-lane versus fixed
shared-cap A/B. Require known cold cache state, verified effective gates and
execution branch, bounded metric deltas, provider-attributed results where
applicable, repeated completion/TTFB measurements, upstream request/byte cost,
and limiter/breaker behavior. The first decision must keep work stealing OFF.

**Smallest likely implementation:** Choose exactly one evidence-supported
outcome:

### A1 — Clear production win

- Derive the smallest safe activation policy from the measured crossover.
- Validate the policy against TorBox and Real-Debrid where both are eligible.
- Change only the gate/default or bounded activation predicate necessary to
  express that policy, with focused tests and a production canary.
- Do not add a new scheduler architecture.

### A2 — Situational win

- Retain guarded or dynamic activation only for the provider, workload shape,
  or minimum cold span supported by evidence.
- Keep unsupported cases single-lane and do not generalize the threshold.
- Add only the smallest policy/test surface needed to encode the proven case.

### A3 — No meaningful win

- Keep shared-cap two-lane execution default OFF.
- Stop spending time on throughput tuning for it.
- Preserve the bounded scheduler, lifecycle correctness, and coalescing work for
  future evidence or provider changes.

**Exit condition:** One outcome is recorded with reproducible evidence, the
shipping/default decision is explicit, and any enabled policy has passed both
focused tests and a bounded production canary. A no-win decision exits the
phase without production-code change.

**Deliberately deferred:** Work stealing, slow-lane retirement/replacement,
chunk-grid changes, and broad telemetry. Work stealing becomes eligible only if
the two-lane result creates a concrete utilization or imbalance problem that
fixed splitting cannot solve.

## Phase B — Remaining production bottlenecks

**Production problem:** After the scheduler decision, the next material playback
cost is unknown. Plausible classes include seek/small-range amplification,
provider or CDN latency, recovery latency, publication/VFS friction, and
operational API pressure.

**Why it matters:** Optimizing the wrong layer adds maintenance and provider
load without improving playback.

**Required evidence:** Use real playback-shaped traces after Phase A. Identify a
repeatable user-visible or reliability symptom, locate it to one boundary with
existing metrics/logs, quantify frequency and impact, and rule out cache-state
or provider variance before ranking it as the next task.

**Smallest likely implementation:** Fix or tune only the owning boundary of the
highest-evidence bottleneck. Prefer a configuration/policy correction or narrow
recovery-path change over a new subsystem. If no material bottleneck appears,
make no implementation change.

**Exit condition:** Either one measured production bottleneck is corrected and
re-canary-tested, or evidence shows no remaining issue worth carrying into the
graduation gate.

**Deliberately deferred:** Choosing a candidate class in advance, speculative
cache redesign, provider-specific heuristics without provider evidence, and
instrumentation that does not answer a shipping decision.

## Phase C — Graduation proof

**Production problem:** HashSucker needs one explicit provider-by-provider exit
bar so isolated successes are not mistaken for full product graduation.

**Why it matters:** Both supported providers must preserve the same durable
identity and recovery contract under real playback behavior.

**Required evidence:** TorBox and Real-Debrid must independently satisfy:

| Graduation requirement | Current evidence |
|---|---|
| Resolve an eligible provider coordinate for the selected TorrentFile | Proven live for both providers |
| Expose/mount the selected file through the VFS boundary | Proven live in the current VFS/data-plane path |
| Deliver the exact requested bytes | Proven live for both; exact cross-provider Range hash also confirmed |
| Survive sequential reads, overlap, forward/backward seeks, and cancel/reopen | Proven live in playback-abuse canaries for both |
| Restart and reacquire a fresh runtime capability | Proven live for both |
| Repair or reject stale provider state without violating ownership | Structurally/deterministically proven; normal restart and stale-cap avoidance are live, but deliberately forced real-provider dead-link concurrency was not part of the live canaries |
| Preserve Release/TorrentFile identity across provider execution | Proven by source invariants, tests, and exact cross-provider bytes |
| Avoid API storms and handle throttling through bounded limiter/breaker behavior | No storm observed in live canaries; limiter/breaker and Retry-After behavior are implemented and tested |

**Smallest likely implementation:** First consolidate the existing evidence into
one graduation matrix. Run only a missing bounded canary if the matrix exposes a
real provider-specific gap. Fix production code only for a reproduced defect;
do not reopen completed lifecycle work merely to repeat it.

**Exit condition:** Every row is accepted for each provider with linked,
repeatable evidence, or a specifically named gap remains with an owner and
bounded proof plan. Experimental shared-cap scheduling may graduate separately;
it does not block the correct default-OFF data plane.

**Deliberately deferred:** Portability claims beyond the deployed accounts and
clients, synthetic fault permutations already covered by deterministic tests,
and optional scheduler mechanisms that Phase A did not justify.

## Phase D — Only after graduation

**Production problem:** None by default. This phase exists only for a concrete
problem observed after graduation.

**Why it matters:** Optional complexity should enter the product only when it
removes a measured playback or operational cost.

**Required evidence:** A production trace must identify the affected boundary,
frequency, user impact, and why current bounded behavior is insufficient.

**Smallest likely implementation:** Depending on that evidence only, consider
richer provider retirement/replacement, more sophisticated scheduling,
chunk-grid experiments, or deeper telemetry. Implement the narrowest option
that directly tests or removes the observed problem.

**Exit condition:** The promoted problem is measurably improved without
weakening identity, provider, cache/coalescing, permit, or recovery invariants.

**Deliberately deferred:** Every item in this phase remains non-blocking unless a
concrete production defect or measured regression promotes it.

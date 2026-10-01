# HashSucker shipping roadmap

This roadmap contains only remaining work that can plausibly improve playback,
correctness, reliability, provider behavior, or product graduation. Durable
architecture belongs in [`architecture.md`](architecture.md); the verified
checkpoint belongs in
[`PRODUCTION-STATE-2026-09-11.md`](PRODUCTION-STATE-2026-09-11.md); the next
agent's immediate instructions belong in [`../handoff/CURRENT.md`](../handoff/CURRENT.md).
Sequencing authority is [`../PLANS.md`](../PLANS.md): phases below are
backlog until moved there with a gate, never active execution truth.

Status legend: `CLOSED` (exited with recorded outcome), `BACKLOG`
(gated, not active), `CANDIDATE` (needs graduation + explicit activation),
`RESEARCH` (questions first, implementation only on evidence).

## Phase A — Scheduler shipping decision — CLOSED

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

**Outcome (2026-09-12): A3 — no meaningful win.** The LongCat single-lane
versus fixed shared-cap A/B (work stealing OFF) showed no production use-case
justifying shared-cap two-lane execution: the mechanism is functional, ordinary
sequential cold playback did not naturally activate it, and concurrent-reader
pressure already parallelizes through normal capability-pool growth.
Shared-cap two-lane stays default OFF with no production-code change. Phase A
exits here.

**Deliberately deferred:** Work stealing, slow-lane retirement/replacement,
chunk-grid changes, and broad telemetry. Work stealing becomes eligible only if
the two-lane result creates a concrete utilization or imbalance problem that
fixed splitting cannot solve.

## Phase B — Remaining production bottlenecks — BACKLOG

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

## Phase C — Graduation proof — BACKLOG (Codex owns the call)

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

## Phase D — Only after graduation — BACKLOG (conditional)

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

---

# Post-core ladder — CANDIDATE (Codex owns activation)

None of the phases below are active. Core graduation is declared; activation
remains Codex's sequencing call in `PLANS.md`. Long-horizon items stay here
as sections, not phase files, until coherent enough to be actionable.

Value filter over everything below: *which candidate capability measurably
saves the household time or interaction — fewer selections, fewer retries,
less waiting, fewer repairs, less re-curation?* Any phase that cannot pass
this becomes research or dies.

Right-to-exist test applied to every phase: *why would someone use this
instead of Plex + Arr + rdt-client or Stremio today, and if the phase
disappeared, would HashSucker lose a meaningful advantage?* Weak answers
were deleted or demoted to research (see RESEARCH items).

## P1 — Representation Intelligence — CANDIDATE (first post-core candidate)

**Why:** Ranking today re-derives quality from release names on every
request and relearns nothing from real playback. A household that has
successfully played an object knows something no filename parse can
provide — and currently throws it away.
**Acceptance semantics (refined):** an acceptance record means
(exact representation + observed context + reason/evidence). A Plex
success is not a global goodness verdict: context includes
consumer/client class where outcomes diverge, and route-dependent facts
(e.g. "this provider served it fast") are stored as route knowledge,
not representation knowledge. Confidence ages out only on contradictory
evidence, never on a timer.
**Product outcome:** Re-requests prefer previously accepted exact
representations with stated reasons; known-bad representations (transcode
traps, stallers, incompatible encodes) are avoided without rediscovery.
Time-to-playable drops on repeats; ranking work drops on everything.
**Entry conditions:** Core graduation; playback-outcome telemetry exists
(request → TorrentFile → client decision → stall/failure facts).
**Exit conditions:** (1) accepted representation history persisted from
real successful playback; (2) known-bad reasons persisted;
(3) re-request selection demonstrably uses prior knowledge;
(4) measured reduction in rediscovery/ranking work or time-to-playable.
**Non-goals:** Taste/recommendation ML; cross-household reputation;
rewriting the ranker; any UI beyond what a human decision requires.
**Kill criteria:** If re-request outcomes do not measurably change, or
the knowledge never fires (household replays too little), stop after
persistence slices — do not build selection on unused data.
**Risks:** Overfitting to stale compatibility (clients change);
TRaSH-format drift if community knowledge is consumed.
**Carried debt:** Compatibility aging policy may remain heuristic.
**Slices:** see `docs/phases/candidate-representation-intelligence.md`.
**Why not Stremio instead:** Stremio re-resolves every play from zero and
remembers nothing; this phase is precisely the memory Stremio lacks.

## P2 — Self-Healing Playable Object — CANDIDATE (reframed as completion)

**Why:** Failover, reacquisition, stable Bindings, and provider-outside-
identity already exist as core capabilities. What does not exist is the
standing posture: an intent with *zero* healthy routes at failure time is
reacquired (not merely failed over), with route-health knowledge and
stale-placement detection maintained continuously rather than discovered
per incident.
**New observable capability after P2 that does not exist today:**
automatic recovery of an intent that had no usable route when the failure
occurred — same TorrentFile, Binding unchanged, typed evidence — without
a request-time trigger. If that sentence cannot be demonstrated, P2
merges back into core hardening follow-ups and disappears as a phase.
**Product outcome:** An intent stays playable across route loss without
representation drift, including the zero-healthy-route case.
**Entry conditions:** Core graduation (met). P1 acceptance memory is
useful compounding (knows which representation is worth saving) but not
a hard dependency — the Binding already states that.
**Exit conditions:** Demonstrated recovery of single-route intents after
real route loss (filter/purge/throttle), including at least one
zero-healthy-route reacquisition, with Binding unchanged and
typed evidence per recovery.
**Non-goals:** Generic route abstraction frameworks; multi-route
striping; racing providers per playback without latency evidence.
**Kill criteria:** If real route-loss events are rare enough that
on-demand failover covers them, or healing costs exceed its measured
saves — stop; on-demand recovery is already the product.
**Risks:** Healing loops burning provider quota; masking provider death
that should be surfaced; correlated filtering defeating all routes.
**Carried debt:** Cross-provider byte-equivalence edge cases may stay
explicitly bounded rather than fully solved.

## P3 — Preservation Policy — CANDIDATE

**Why:** Local storage today is acquisition exhaust (downloads, staging),
not a deliberate route. Nothing preserves an exact object *because it is
worth preserving* — and nothing decides that automatically either.
**Product outcome:** Exact objects worth keeping stay playable regardless
of providers, with minimal explicit policy: sensible automatic retention
driven by demand, fragility, and recreation cost, plus a keep/remove
expression for the cases automation cannot resolve. No REMOTE/CACHE/KEEP/
AUTO button grid is presumed — buttons appear only if the automatic
behavior demonstrably needs overrides.
**Entry conditions:** Core graduation (met). P2 route-health knowledge is
useful input (what fragility costs) but not a hard dependency.
**Exit conditions:** Demonstrated preservation behavior end to end,
including at least one reconstitution after storage loss, with the
explicit-policy surface no larger than keep/remove (or documented proof
that more was necessary).
**Non-goals:** Becoming archival storage; mirroring the library locally
by default; any storage-management UI beyond keep/remove.
**Kill criteria:** If households never express keep-intent, or local
retention never measurably beats remote reacquisition on latency or
durability — stop; REMOTE-only plus cache is the product.
**Risks:** Disk-full failure modes; silent unbounded growth; retention
policy nobody understands (must pass the keep/unkeep comprehension test).
**Carried debt:** Eviction/priority tuning stays heuristic.

## P4 — Consumer Reconstruction — CANDIDATE

**Why:** Plex/Jellyfin libraries are currently curated state that dies
with the consumer. A server migration or database loss means re-curation
even though HashSucker knows every representation choice already made.
**Product outcome:** Consumer projections disposable and rebuildable from
HashSucker truth: replace the server, re-project the library, lose no
representation decisions.
**Entry conditions:** Core graduation (met). P1 acceptance memory tells
what to re-project; P2 healing keeps projections alive through route
churn — both useful compounding, neither a hard gate on the first
rebuild demonstration.
**Exit conditions:** Demonstrated rebuild of a consumer library from
HashSucker truth after wiping consumer state, with representation
choices preserved and verified playable.
**Note on terminology:** Codex's selected slice "consumer-neutral
republication" maps to this phase's first slice (reconstruct projection
from truth without discovery or provider selection). The phrase stays an
engineering term owned by that lane; strategy here does not canonize it
further until the slice lands.
**Status (2026-10):** that slice is Codex-active (republish route in
worktree, fail-closed delegation to the exact-reuse predicate). This
phase remains CANDIDATE until the slice lands and the rebuild
demonstration (exit condition) is evidenced.
**Non-goals:** Media-server replacement; owning watch state here (see
P5); Plex contract violations (filesystem expectations quarantined in
the adapter).
**Kill criteria:** If consumer databases prove durable enough in practice
that rebuilds never fire, or Plex contracts block faithful reconstruction
— stop; projections remain best-effort.
**Risks:** Plex proprietary behavior drift; Jellyfin API differences
splitting the projection layer in two.
**Carried debt:** Partial consumer-state coverage explicitly listed per
consumer.

## P5 — Consumer-Neutral Media Continuity — RESEARCH (per-class kill rule)

Not implementable yet: which consumer state HashSucker must own for
no-re-curation replacement is unanswered. Evaluate each class
separately — watched, resume, favorites, collections, representation
preference, preservation intent — against one test: *if this state
disappears with the consumer, does the household meaningfully have to
re-curate its media life?* A "no" kills that class's ownership candidacy
permanently. No bundled continuity database. Research first;
implementation only where a question earns it. See
`docs/research/open-questions.md`. Do not assume all state belongs here.

## Prediction as mechanism, not a phase (P6 deleted)

P6 is removed from the ladder: predictive fulfillment is a
measurement-gated capability available to multiple phases (discovery,
enrichment, preservation, route readiness, representation selection),
not a linear phase and not a product. Standing rule: taste, profiling,
and prediction-like inference are allowed as implementation tools when
they measurably reduce interaction, waiting, failed selection, or
preparation latency — never as product identity. No taste engine, no
recommendation UX, no social graphs, no "AI phase." Kill criterion for
any predictive spend: no measured win on real traces within bounded
experiments.

## Continuity compounding (audited dependencies, not narrative)

- identity → memory: **useful compounding, not hard** — selection works
  today without memory; memory improves it if the win measures out.
- identity → route-independence: **already coexists** — failover and
  provider-outside-identity predate any memory work.
- memory → route-independence: **hypothesis** — acceptance knowledge may
  tell healing what is worth saving, unproven.
- route-independence → preservation: **useful, not hard** — fragility
  costs inform what to preserve; preservation can start from demand alone.
- preservation → reconstruction: **false dependency** — rebuild needs
  bindings plus acceptance, not local bytes.
- memory → reconstruction: **useful, not hard** — acceptance says what
  to re-project; a bindings-only rebuild is still meaningful without it.
- reconstruction → continuity state: **hypothesis** — owning projections
  may force owning adjacent state, or may not.
- anything → household media continuity: **hypothesis** until a
  replacement-without-recuration is demonstrated end to end.

## Acquisition-era vocabulary ledger (cleanup opportunities, not renames)

Review roadmap/code vocabulary for download-automation inheritance.
Product-real today: *download request* (user-asked staged bytes),
*importer handoff* (filesystem-queue contract with Arr tools),
*retry job* (bounded, typed). Compatibility-only: *STRM publisher*
(legacy players), *legacy compat paths* (`/stream/*`,
`/media/:infoHash/:fileIndex`). Misleading/inherited, reframe when
touched: *acquisition state* (implies downloading is the product —
prefer *route readiness*), *queue semantics* where no human queue exists,
*download history* as product surface (telemetry, not UX). No code
renames until product semantics demand them.

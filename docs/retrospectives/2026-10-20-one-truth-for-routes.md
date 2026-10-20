# Retrospective: one truth for routes

## Expected vs actual

Expected to fix one predicate: the ensurer asked "is this provider
already present?" without asking the evidence, so a dead route counted as
redundancy. Found that the predicate was only the visible symptom. Route
availability had FIVE different definitions across the codebase, and the
one that mattered most — the route set the byte path is offered — was not
one of them.

The slice also found a defect that had nothing to do with routes: the
class-D path threw `evidenceSummary is not defined` on every failure, so
the product answered a 500 where a typed 502 was owed. The production
proof found it; the test suite had been blind to it for a full slice.

## Surprises

1. **The dead route was not the only thing wrong with the ensurer.** Even
   after it targeted the right provider, it would re-ask the provider for
   a SECOND placement — and the provider adapter THROWS when two account
   resources match one hash. A re-created release (the exact situation a
   repair exists for) is a conflict to the singular lookup and a
   replacement to the account listing.
2. **The provider's account listing is 5.48 MB and takes 0.42–5.75 s.**
   The 5 s request budget therefore fails intermittently — and the
   failure looked like "the provider is unreachable". The repair path was
   the only place that read the account, and it was the place that could
   not afford the read.
3. **The evidence-driven repair was hot-looping in production**: the work
   item stays due while the route stays dead, so the 60 s pass repeated
   the account read every minute. The previous slice's own measurement
   ("an idle pass 2 provider calls → 0") was true only while nothing was
   broken.
4. **A dead route can be alive.** The terminal verdict is the provider's
   answer at a point in time; a fresh inventory observation of the same
   resource contradicts it. The re-observation is also the cheapest
   proof that the resource is really gone — cheaper than any account
   listing. The repair sequence (re-observe → look for a replacement →
   negative) was not designed before the proof; the proof designed it.
5. **The typed class-D failure was broken.** The evidence summary and the
   discovery outcome were `let`-declared inside the class-D block and read
   outside it. With no representation policy configured the optional call
   short-circuits and the arguments are never evaluated — so the only
   test that configured a policy asserted the side effects (the recorded
   evidence, the untouched Binding) and never the response.

## Disproved assumptions

- "The ensurer's presence predicate is the bug." No: it was one of five
  predicates, and the least harmful one. The byte path's route set
  (offering a proven-dead route) and the recovery's candidate set (the
  same question asked with different SQL) were the consequential ones.
- "One placement per provider per hash is a reasonable model." No: it
  makes a replaced resource invisible, and the provider's own API treats
  two resources for one hash as a conflict. The model was wrong at the
  provider's level, not only in the store.
- "A negative answer from the target provider is a complete negative." No:
  it proves ONE account. The representation policy's completeness gate
  was resting on that.
- "An ambiguous account listing means the release is not there." No: it
  means we cannot tell WHICH torrent is it. That is the opposite of a
  negative, and it was being treated as one — the most dangerous kind of
  wrong, because it authorizes replacing an authoritative representation.
- "The evidence-driven recovery is cheap because it is local until work is
  due." True for an idle pass, false for a stuck one: a work item that
  stays due re-asks the provider every minute.

## Wasted effort / cause

- Wrote the shared classification module, then discovered that the store
  could not express "every placement for a hash" and added
  `listPlacementsByInfoHash` late. The singular lookup was the defect
  that made the replacement invisible; it was visible in the first ten
  minutes of reading `findPlacementByInfoHash`.
- Changed the ensurer's provider flow twice: first to skip the dead
  route, then to RE-OBSERVE it. The first version was wrong in an
  instructive way: skipping the dead route hides a live resource, and
  "skip what the evidence says" is the same mistake the old predicate
  made. The order (re-observe → replace → negative) is the only order
  that cannot report a repair that did not happen.
- Deployed a build with the 5 s account budget before measuring the
  account read. The production timeout was the measurement I should have
  taken first (three curl calls).

## Most useful test

`the class-D failure surfaces the TYPED failure, not an internal error`
(test/route-resurrection.test.js). It is the smallest test that would
have caught a defect that had been live for a whole slice, and it is the
kind of assertion the neighbouring tests were missing: they asserted the
side effects and never the response.

## Lying / overconstraining test

- The ensurer tests asserted the provider-level `reason` strings
  (`'not-cached'`, `'discover-only'`) of a single-provider answer. They
  passed while the answer meant something different at the aggregate
  level. They now pin the aggregate fact (which accounts were consulted,
  and whether the negative is complete) and keep the provider reason as
  detail.
- The route-recovery matrix asserted the exact shape of the
  `findEvidenceRepairDueTorrentFiles` result. That shape is an
  implementation detail of the work item; the fact (which TorrentFiles
  have a repair due) is the contract.

## Automation that should disappear

The provider-account read in the repair path. It exists because the
provider exposes no per-hash index, but it is the single most expensive
call in the system (5.48 MB, up to 5.75 s) and it is repeated for every
work item that stays due. It should be replaced by a provider-side hash
index or a durable per-hash cache of the account listing, keyed by the
account snapshot's own observation time.

## Guidance change

- The recovery is an EVIDENCE-DRIVEN BOUNDED POLL. It is not
  "event-driven": nothing wakes the process when a route dies, and the
  latency is the poll interval. The 2026-10-19 slice was described that
  way in the build log, in `PLANS.md`, in `handoff/CURRENT.md` and in its
  own retrospective; the wording is corrected.
- "A route is dead" is a claim about ONE capability tuple with a
  horizon, not a fact about a provider or a release. It expires, and a
  newer observation supersedes it.
- A negative discovery is complete only when every candidate account was
  searched. An inconclusive answer is not a negative, and an ambiguous
  answer is not a negative.

## Complexity to remove

- The `usablePlacementCount` predicate in the route reconciler is now a
  second definition of "has a route" next to the shared classification.
  It survives only for the six-hour discovery sweep (TorrentFiles with
  NO recorded route at all) and should be expressed in the classification
  terms when that sweep is next touched.
- The `findPlacementByInfoHash` singular lookup still has callers that
  want "the" placement. Each such caller silently inherits the
  replaced-resource blindness.

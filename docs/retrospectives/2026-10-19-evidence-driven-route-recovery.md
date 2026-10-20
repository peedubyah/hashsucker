# Retrospective: the dead speak (evidence-driven bounded-poll route recovery)

> Terminology correction (2026-10-20): this slice was described as
> "event-driven route recovery". It is not event-driven. Nothing wakes the
> process when a route dies; the recovery is a local read of the durable
> evidence every 60 s, so the latency is the poll interval. The word
> "event-driven" in this document was wrong and is corrected below.

## Expected vs actual

Expected to add a watcher and a queue. Found that the durable evidence
was already the right work item — the reconciler simply never read it,
and instead re-asked the providers the same question every six hours.

## Surprises

1. **The evidence was already there, already keyed correctly, already
   distinguishing "wait" from "gone".** `provider_delivery_evidence` was
   written by the legacy provider path and ignored by the authoritative
   one. The gap was a missing READ, not missing persistence.
2. **The reconciler's provider calls were not many — but they were
   enormous.** Two calls per pass, but one of them was a 5 MB account
   download, and both asked a question the evidence had already answered.
3. **The evidence-driven pass can be LOCAL.** The candidate set is an
   indexed read, so the pass could run every minute instead of every six
   hours at zero provider cost. The timer was the thing standing between
   a failure and its repair, not the provider.
4. **"Every known route is dead" is not "no route exists".** I had assumed
   the representation fallback's evidence gate was sufficient. It is not:
   the durable index is not a completeness proof. The policy now demands a
   completed, negative same-TorrentFile discovery.
5. **The ensurer asks "which provider is missing?" using the durable
   inventory, not the evidence.** A route marked terminal still counts as
   present, so the repair looks for a second route before re-observing the
   dead one. The repair still happens in a minute; its TARGET is
   suboptimal.

## Disproved assumptions

- "Recovery needs a new scheduler." False: the existing periodic worker
  was doing the right job on the wrong input at the wrong cadence. The
  same code, fed by the evidence, at a minute cadence, is the
  evidence-driven bounded poll.
- "A terminal fact must be re-verified to be trusted." False: the
  evidence IS the provider's answer, with a timestamp and a TTL. Asking
  again is how the system kept paying for the same question.
- "The account list is the cheapest way to learn the account's state."
  False for a bounded question: one hash needs one hash.
- "The retirement needed the provider probe to be safe." False: the
  evidence proves the route dead AND the sibling alive — stronger than an
  account snapshot, and free.

## Wasted effort / cause

- Started by writing the evidence-driven machinery before reading the
  reconciler end to end. The first useful fact — the candidate set was a
  re-derivation of a table we already wrote — was visible in the first
  twenty lines of the file.
- Rewrote the reconciler tests before deciding what the new contract was,
  and had to rewrite them twice. The characterization first, the new
  behavior second, in one pass, would have been faster.
- The store's clock was not exposed, so the freshness comparison used
  `Date.now()` against rows written with an injected clock — the first
  test failure was a clock mismatch, not a logic bug.

## Most useful test

`a pass makes NO provider call when the durable evidence says nothing is
due` — it is the direct, falsifiable statement of the whole change: the
pass that used to ask the providers about the whole library now asks
nobody about anything.

## Lying / overconstraining test

The old T9–T16 and W1–W4 tests asserted the provider-probing behavior
directly. They were not lying — they described the old contract exactly —
but the contract they described was the thing being replaced, so they
were rewritten to the evidence-first contract, with the negative controls
("a route nobody observed is not a failure", "a throttled route is not
death") kept and strengthened.

## Automation that should disappear

None added. The periodic sweep was narrowed, not deleted: it still owns the
one question the evidence cannot answer (a release that may have appeared
in an account for a TorrentFile with no recorded route).

## Complexity to remove

- The second-placement ensurer's "which provider is missing?" predicate
  reads the durable inventory, not the evidence, so a proven-dead route
  still counts as present.
- Recovery is triggered by a poll of the durable evidence (a local read
  every minute), not by a push: the latency is the poll interval.
- The evidence's key is the Node-side capability tuple while the
  observation is provider-side: every write maps one to the other.

# Retrospective: durable route failure authority

## Expected vs actual

Expected to add a durable table and a watcher. Found the durable model
already existed and was simply never written by the authoritative path —
and found the real information loss one layer down, in the data plane,
which knew exactly which route died and why and threw it away.

## Surprises

1. **The table was already there.** `provider_delivery_evidence` is keyed
   on the capability tuple with usable/temporary/terminal states, and the
   store already refuses to confuse "provider said wait" with "this
   mapping is dead". The gap was a missing WRITE, not a missing schema.
2. **The information died in Rust, not in Node.** `acquire_for_read`
   walks the slots and knows the exact provider/scope/resource/file that
   failed — and the class-D error carried only a code. Nothing in the
   north could have recorded the route death, because the route identity
   was never sent.
3. **"Dead" and "did not answer" were the same error.** The capability
   error had no way to say which. 404/410, a protocol-invalid resolution,
   a wrong-size file and a throttle were all `NoCapability` or a string.
   The durable evidence model could not be fed correctly until the source
   classified the failure.
4. **The byte path's representation switch had no owner.** It was a raw
   side effect inside a READ: a failed byte request changed the handoff,
   the Binding and the VFS row. The architecture doc sanctions the
   switch in one sentence and forbids reacting to playback outcomes in
   another; nobody had reconciled the two.
5. **The inert reconciler was the same leak in slow motion.** It planned
   'mark-degraded' on the Binding for three ROUTE facts. It never ran
   (shadow mode), so nobody noticed that the model still treated a route
   problem as a representation problem.

## Disproved assumptions

- "Durable route failure needs a new table." False: the table, the key,
  the states and the TTLs were all already there.
- "The data plane cannot tell a dead route from a slow one." False: it
   can, at the point where the HTTP status is known — the classification
   simply was not expressed.
- "Delivery-degraded until the policy acts is the safe answer." False on
   evidence: no policy owner reacts to "the current representation is
   undeliverable" today, so that option leaves items dead indefinitely.
   The policy-owner answer needs the policy to exist first; the honest
   intermediate is a policy DECISION inside the existing fallback.
- "The route reconciler is the recovery owner." It is a SWEEP, not an
   owner: it re-probes the provider on a 6-hour cadence, and it did not
   know which routes had died.

## Wasted effort / cause

- Started by looking for a table to add. Reading the schema and the
  evidence store first would have found the missing write in minutes.
- Tried to make the "no live route" check read the evidence store
  (`listForCoordinate`) inside the policy; the coordinate keying made
  that fragile. Deciding on the EVIDENCE SUMMARY the recorder just
  produced (recorded/terminal/temporary) is simpler and just as
  evidence-based.
- A `cargo test --release` run of the whole data-plane suite exceeded
  30 minutes; the per-test hang turned out to be PRE-EXISTING (verified
  by stashing the change), so the useful signal was the --lib suite plus
  the two integration files that do finish.

## Most useful test

`a throttled or timed-out route is NEVER recorded as death` — the single
assertion that keeps a rate limit from becoming a permanent verdict on a
route. The whole feature is only safe because of it.

## Lying / overconstraining test

Three reconciler tests asserted 'mark-degraded' for route facts. They were
not lying about the intent ("fails closed", "not guessed by basename") —
they were pinning the accidental coupling. They now assert the route-level
action AND that 'mark-degraded' is absent.

## Automation that should disappear

None added.

## Guidance change

A delivery failure must be recorded where it is observed, in the
vocabulary of the durable model, and the decision it may imply must be
owned explicitly. "The byte path reselected" was not a policy; it was a
fall-through.

## Complexity to remove

- The durable evidence key is Node-side (placement id), the observation is
  provider-side (resource id): every write maps one to the other. The
  mapping is exact but it is a mapping.
- The route reconciler still re-probes the provider instead of reading the
  evidence it now writes.
- Nothing yet watches the durable evidence, so a dead route with no
  further request is still noticed only by the 6-hourly sweep.

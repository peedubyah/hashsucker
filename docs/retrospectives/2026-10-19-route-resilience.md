# Retrospective: what is dead may never die (route resilience)

## Expected vs actual

Expected to find the representation authority tangled with route evidence
and to have to untangle it. Found the opposite: the model was already
almost right, and the ONE leak was narrow and easy to miss — the class-D
byte-failure path, where a dead ROUTE answered by choosing a different
REPRESENTATION.

## Surprises

1. **The byte path already had the right model.** Rust builds one slot per
   (provider, scope, resource) and fails over between the routes of the
   SAME TorrentFile, emitting the class-D 502 before any 206 is committed.
   The representation never moved. The leak was one layer up, in Node.
2. **Production already proves the invariant.** 174 active Bindings, 174
   expired route observations, 0 degraded Bindings. Route evidence expires
   on a 5-minute TTL and the representation does not care.
3. **The leak had never fired.** 0 handoffs carry an alternate selection
   reason. The coupling was reachable but not exercised — the kind of
   defect that a "the product works" observation would have missed.
4. **The route set belongs to the TorrentFile, not the Binding.** 218
   TorrentFiles carry routes on both providers; 13 active Bindings have a
   second route for their own TorrentFile. The Binding's (placement,
   provider file) is the route it AUTHORIZED, not the only route there is.
5. **The reconciler planner would have degraded a Binding for route
   facts** (inventory exhausted, provider file missing, exposure not
   visible) — and it is inert (shadow mode only). A latent version of
   exactly the coupling this slice was about.
6. **The operator surfaces disagreed with each other.** The request
   response said 'blocked'; the operator list said 'unserviceable'/'unknown'
   for the same fact, and the reuse path said nothing at all.

## Disproved assumptions

- "A dead route must destroy or replace the representation." False as a
  statement about the ordinary case: the design intends the opposite, the
  byte path implements it, and production demonstrates it (0 degraded
  Bindings with 174 expired observations). But the total-exhaustion
  fallback still replaces the representation, so the honest invariant is
  narrower: ordinary route failure preserves the Binding; total
  same-TorrentFile route exhaustion may still reselect the representation.
  My first draft of the headline claimed the stronger theorem; the caveat
  in my own "what remains" section contradicted it. Narrow the claim, do
  not round it up.
- "The alternate fallback is the recovery mechanism." It is not a recovery
  mechanism at all — it is a representation change triggered by a delivery
  failure, which is a different thing wearing recovery's name.
- "The authority model needs a new state machine." It does not: the
  existing columns express authority, route inventory, route evidence and
  serviceability separately. What was missing was a consistent REPORTING
  of the distinction, not a new model.
- "The provider hash index needs a new table." It does not:
  `provider_placements` IS the index, one hash legitimately mapping to
  several resources.

## Wasted effort / cause

- Looking for a "delivery state" abstraction before reading what the
  durable columns already say. The gap was in the reporting, and I found
  it only after the state-machine phase.
- Considering an end-to-end fault-injection stack (the data plane's
  `DATA_PLANE_FORCE_EXHAUST_TFID` gate) for the class-D path. The gate is
  real and sanctioned, but the task forbids restarting production Rust to
  inject faults, and the focused test drives the real VFS handler with the
  data plane mocked at its HTTP boundary — the same code path, one seam
  lower. The gate stays available for a future reversible proof.

## Most useful test

`the representation-changing fallback is not reached when the same
TorrentFile got a new route` — it pins the ORDERING (route repair before
representation change) rather than the outcome, which is the part that can
silently regress.

## Lying / overconstraining test

None found in this slice. The two selection-serviceability assertions on
'blocked' were mine to update (the vocabulary changed) and they were
asserting the right thing in the wrong words.

## Automation that should disappear

None added.

## Guidance change

A representation change and a route change must be separate operations
with separate triggers. The test for it is not "the item still plays" but
"the Binding still names the same TorrentFile".

## Complexity to remove

- The class-D fallback still mixes a delivery failure with a
  representation decision. It is now preceded by route resurrection, but
  the mixing itself is still there as a last resort.
- The durable route-failure evidence is written by the legacy provider
  path, not by the authoritative Rust path, so a restart forgets which
  route died until the reconciler re-probes it.
- The reconciler planner's route-facts-as-representation-facts degradation
  rules are still written that way; they are inert today.

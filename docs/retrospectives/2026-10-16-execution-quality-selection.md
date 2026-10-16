# Retrospective: execution-quality selection (prefer a serviceable representation)

Slice: serviceability-aware representation selection. Commits `8d1b40b`,
`d7fd6b9`.

## Expected vs actual

Expected: the Batman case would reveal a lower-ranked RD-cached alternative
that the selector ignored, and a bounded serviceability gate would pick it.
Actual: **The Batman had no RD-cached alternative at all** (RD account scan
matched zero Batman hashes; only one TorBox placement existed). The selector was
already doing the best it could; the blocker was purely external. The real
finding came from the positive case: a fresh request whose top cached candidate
was unserviceable (Harakiri) — the gate moved to a serviceable RD candidate —
but the RD bind then failed, exposing that **RD placements were durably
unbindable** (their inventory was never marked authoritative/complete).

## Surprises

- "RD fallback exists" was a durable illusion: RD could serve bytes via same-TF
  failover, but no RD placement could ever pass `activateBinding`. The gate
  surfaced this immediately.
- The first positive request (Barbie) had two TorBox candidates rejected before
  an RD candidate was accepted — the gate worked, but the durable binding then
  failed for the RD reason above.

## Disproved assumptions

- "A lower-ranked cached alternative usually exists." Not with this RD account
  (15 torrents); most media has a single TorBox-cached representation.
- "The RD ensure produces a bindable placement." False until `d7fd6b9`.

## Wasted effort + cause

- Chased a suspected wrong-show match (Harakiri selected for `tt0056058`).
  Cause: I mis-assumed `tt0056058` was The Human Condition III; it is Harakiri.
  Verified the IMDb id before concluding — no wrong match existed.

## Most useful test

`selection-serviceability.test.js` "top-ranked blocked, second serviceable ->
second wins" plus "alternate search is bounded". The most useful *proof* was
the natural Harakiri request: gate logs show a TorBox candidate rejected and an
RD candidate accepted, then real bytes.

## Lying / overconstraining test

None added. The selection tests use a mock probe, so they pin the traversal
contract, not the probe implementation; the probe has its own byte-health tests.

## Guidance change

- "Consumer-visible is not serviceable" now extends to selection: the first
  cached bind is not automatically the answer. Routed to `docs/BUILD-LOG.md`
  and `PLANS.md`.
- Durable binding requires an authoritative+complete+expiring inventory; a
  provider ensure that omits these silently blocks that provider.

## Complexity to remove

- None removed; the gate is opt-in (no seam ⇒ pre-change behavior) so TorBox-only
  deployments are unchanged.

## Open (recorded, not fixed)

- The gate adds up to ~5 s when probing is needed (RD cold fill dominates).
- `maxServiceabilityAlternates=4`: a serviceable alternative ranked beyond the
  bound after a rejection is not reached.
- The Barbie corpus-pipeline path returned `durable-publication-incomplete`
  even though it materialized a binding; that reporting path is separate from
  this slice and not investigated further.

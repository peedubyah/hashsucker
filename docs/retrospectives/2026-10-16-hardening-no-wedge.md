# Retrospective: hardening — no single failure can wedge request → playback

Slice: hardening after the Lowdown responsiveness slice. Commits `0bdfcfd`,
`0f7292e`, `f3e3f2f`, `ae41376`.

## Expected vs actual

Expected: the responsiveness fixes (fast-fail + scheduler floor) were the main
gap; hardening would mostly add a serviceability label. Actual: the fresh
natural-request proof (The Batman) exposed two independent real defects in
alternate-route adoption that the previous "after" evidence (a manual refresh
of an already-published season) had hidden — a mid-body truncation never
failed over, and the Rust RD acquisition could not map a torrent link to a
selected file for any multi-file torrent.

## Surprises

- Consumer-visible was being reported as "Ready to watch" with zero
  byte-serviceability check. The operator now tells the truth from observed
  reads alone.
- My first attempt at route-health (a Node-level TorrentFile short-circuit)
  was itself a regression: it blocked a healthy RD alternate. The fix was to
  remove it and let the data plane (which owns the route set) do route
  selection.
- The prior slice's "after" Plex result was not a clean proof. A natural
  request is what actually surfaces defects.

## Disproved assumptions

- "The data plane fails over to an alternate route on any route failure."
  False for a body truncation (only send errors failed over).
- "RD MODE A works." False for multi-file torrents whose selected file is not
  at `links[0]`; the links/files alignment assumption was wrong.
- "A known-bad route should be suppressed at the TorrentFile level." Wrong
  abstraction — suppression is per route.

## Wasted effort + cause

- Built and deployed the Node TF-level short-circuit, then removed it after the
  Joker dual-route case proved it blocked the alternate. Cause: designing
  suppression before measuring the route model end to end.
- Several rebuilds chasing the Joker failover; the root cause (RD link mapping)
  was found by reading the RD API response, not by reasoning about the code.

## Most useful test

`r2f_midbody_truncation_fails_over_to_alternate` (Rust) and the byte-health
failure-mode matrix (Node). Both are mutation-obvious and pin the exact
regressions. The fresh request (`tt1877830`) was the most useful *proof*.

## Lying / overconstraining test

None added. The existing `serving-attribution` fixture used a non-writable fake
response, which made the new body-truncation detection fire spuriously; the
fixture was corrected to a real `Writable` (a fixture that lies, not a
product bug).

## Automation that should disappear

Nothing. No new daemon, scheduler, or platform. The byte-health registry is
in-memory and bounded.

## Guidance change

- "Consumer-visible is not serviceable" now has a concrete, tested meaning
  (`byte-health` + operator field). Routed to `docs/BUILD-LOG.md` and
  `PLANS.md`.
- Fresh-request production proof must be a natural request, never a manual
  refresh of already-published state.

## Complexity to remove

- Removed the Node TorrentFile short-circuit (dead abstraction).
- Kept only a concise `[failover] no alternate lane` log; removed the
  per-slot debug.

## Open (recorded, not fixed)

- Route-level (per-provider) backoff in Rust: the data plane still re-attempts
  a broken route ~3×/read (bounded, ~0.1–0.5 s). Not a wedge.
- `acquire_failover_lane` cold-acquires only when the alternate slot has
  capacity; a busy alternate means "no alternate right now".

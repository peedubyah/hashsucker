# Retrospective: request → playable responsiveness on a broken provider route

Slice: end-to-end request → playable responsiveness (The Lowdown S01/S02).
Commits `d9f647e`, `3e1855b`, `2141315`.

## Expected vs actual

Expected: the request→playable blocker would be somewhere in discovery /
ranking / selection / VFS publication, or Plex matching (hence the
`.plexmatch` hint idea). Actual: **publication was already fast** (first
episode published 7 s after the request, all 8 in 48 s; Plex indexed E1 3 s
after the targeted refresh). The real blocker was downstream: a
**connection-level provider byte-read failure with no bounded failure**, which
propagated into Plex ingest and the scheduler.

## Surprises

- A `send()` error (CDN connection reset) paid the HTTP **load** backoff
  (30 s × 3 ≈ 90 s). The cooldown is meant for 429/5xx provider-load signals;
  a connection-establishment failure carries none. Timeout already had a
  zero-cooldown path; connection failure did not.
- One unbounded VFS read does not just fail playback — it wedges the PMS
  scanner in D-state, so the *whole season* stays unindexed, and it wedges the
  anticipation scheduler's byte probe, so a single slow P0 row starved every
  other due row for ~6 h.
- The external TorBox CDN reset (documented 10-12) was the exact blocker for a
  real requested item, not a background curiosity.

## Disproved assumptions

- "The wall-clock cap only stops *new* work, so a slow action is safe." False:
  the cap was checked after the first action, so one 60 s action ended the tick.
- "Consumer visibility is bounded by publication." False for a broken byte
  route: PMS reads bytes during matching, so ingest is bounded by the read.
- "A stale future-intent row is harmless." It was the starvation source.

## Wasted effort + cause

- Considered a `.plexmatch` identity hint and a metadata-decoration bound;
  neither was the bottleneck (ingest was blocked by the byte read, not by
  ambiguous matching). Measurement before implementation avoided the detour.
- Spent time on timezone confusion in `rclone`/`docker logs` timestamps before
  noticing the `-0500` local time in the mount log. Cost: minutes.

## Most useful test

`data-plane/tests/same_tf_route_recovery.rs::r7_connection_failure_fails_fast`:
repoints both routes at a closed port and asserts an honest failure in < 5 s.
It pins the exact regression (was ~90 s) and is mutation-obvious.

## Lying / overconstraining test

None added. The existing `ordinary drain executes up to four actionable rows`
test used a constant clock, so it never exercised the wall-clock cap — a gap,
not a lie. The new anti-starvation test closes it with an advancing clock.

## Automation that should disappear

Nothing. No new daemon, no new scheduler, no new platform.

## Guidance change

- `AGENTS.md` already says "existing abstractions are not sacred". Reinforced:
  a state that does not require a human decision should not require a human
  interface — here, a *failure* that is knowable in 36 ms must not take 90 s.
- Routed to `docs/BUILD-LOG.md` (evidence) and `PLANS.md` (active slice).

## Complexity to remove

- The 30 s cooldown on a `send()` error was complexity that earned nothing;
  removed by unifying the two headerless transport sub-cases.
- The scheduler's second wall-clock check duplicated the first; both now share
  the `MIN_ACTIONS_PER_TICK` floor.

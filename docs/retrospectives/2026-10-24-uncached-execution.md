# Retrospective — uncached execution right-to-exist (2026-10-24)

Template: expected vs actual, surprises, disproved assumptions, wasted
effort + cause, most useful test, lying/overconstraining test, automation
that should disappear, guidance change, complexity to remove.

- Expected: measure the gap, probe both providers, compare competitors,
  return a verdict. Possibly build nothing.
- Actual: verdict PREPARE, DON'T WAIT with TorBox-only scope. Built
  nothing product-side (docs-only slice). Two live probes run with
  verified cleanup (one deletion needed a casing fix + stale-read
  patience).
- Surprises:
  1. ~60% of the apparent "uncached" demand was not execution gap at
     all: unaired episodes (MobLand E7–10), wrong-typed requests (series
     played as movie), title-mismatch identity failures. The U0–U6
     taxonomy paid for itself before any experiment ran.
  2. RD addMagnet refused a benign 106 MB hash in 5.7 s with 403 — the
     RD path is REFUSED, not slow. Killed multi-provider and sync-RD
     branches in one call.
  3. TorBox accepted, downloaded (≤5.6 min upper bound), and deleted —
     but delete is lowercase-sensitive (`Delete` 400s) and mylist stays
     stale 35 min+ while re-delete 500s. Hygiene verification needs
     state+age reasoning, not re-delete.
  4. The 96 transient RW add-failures now read as rate-limit noise atop
     a hard wall — retry storms against a refusing provider are pure
     waste (and rude). Backoff-before-retry matters for any prepare loop.
  5. Torrentio's model ([Download] + manual retry) is the proven UX the
     verdict improves on (notify instead of retry) — the competitor that
     looked threatening actually validated the shape.
  6. mylist's 600 s read granularity silently coarse-grained the TorBox
     timing probe (change-only logging + stale reads). Upper bounds
     labeled, not point estimates.
- Disproved assumptions: "multi-provider covers gaps" (RD dead here);
  "acquisition is unbuilt" (bounded RD form exists; TorBox is a flag +
  poll away); "swarm is the fallback" (unnecessary + privacy-blocked);
  "fallback covers failures" (0% on confirmed set); "gap is rare"
  (~5% confirmed + weekly new-episode recurrence is action-shaped).
- Wasted effort + cause: ~20 min hand-deriving grid math in the PRIOR
  slice — not this one. This slice: none significant. The one exposition
  risk (overlong per-title forensics) was kept in scratch analysis, not
  committed; the build log carries the verdict-shaped residue only.
- Most useful test: no product test was earnable (docs-only slice by
  design). Most useful evidence: the two live probes (accept/refuse in
  ~6 s each) + the 375-entry RW skip census (every torboxState
  uncached) + the Torrentio community threads (competitor UX without
  benchmark theater).
- Lying/overconstraining test: n/a (no test changes). The pre-existing
  `vfs-collection-resilience` C1/C2/C3 baseline failure stands untouched.
- Automation that should disappear: none. The scratch probe scripts were
  deleted at close (procedure + results live in the build log).
- Guidance change: (1) classify demand failure with U0–U6 BEFORE
  measuring "the gap" — most of it wasn't execution; (2) verify provider
  hygiene by state+age, not by re-delete; (3) `add_only_if_cached=false`
  + `controltorrent/delete` (lowercase) + mylist-status polling is the
  complete TorBox acquisition surface — recorded in the build log for
  the future prepare slice.
- Complexity to remove: none taken. Rejected: sync acquisition path,
  S-1 evidence-rank field (prior slice; order suffices), swarm client,
  provider scoring, source picker, cache-policy changes.

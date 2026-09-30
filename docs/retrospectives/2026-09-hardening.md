# Retrospective: Sept 2026 core hardening (bootstrap)

Expected: incremental reliability fixes. Actual: repeated discovery that
internal confidence overstated reality; only production-path proofs moved
the exit condition.

- Surprises: health-test green ≠ playable; real Plex playback exposed
  missing proof twice (failover semantics, route failure). UI automation
  dead-ended until CDP control was found — screenshots diagnose, never
  accept.
- Disproved assumptions: "corpus/source coverage implies fulfillment";
  "a passing suite implies a working path"; "manual repair validates
  recovery" (it validates a path, not autonomy).
- Wasted effort + cause: broad synthetic test expansion and repeated
  corpus/bootstrap proofs when cheaper production-path proofs sufficed;
  overconstraining test assertions that failed on correct refactors.
- Most useful tests: live same-TorrentFile byte proofs; Plex route
  failure proofs. Lying tests: health assertions without byte/range
  evidence; refactor-brittle assertions.
- Automation to disappear: manual repair steps in any recovery loop;
  re-running expensive proofs a cheaper proof already settled.
- Guidance changes (propagated to `AGENTS.md`): evidence-over-claims,
  harness-never-repairs-product-state, screenshots-diagnostic-only,
  tests-pin-behavior, telemetry-outlives-attribution, manual≠autonomous,
  corpus-health≠fulfillment, no-auto-advance, completion ritual.
- Complexity to remove: narrowed enrichment to unresolved demand;
  second implementations refused; speculative acquisition parked.
  Next candidate: whatever the canary gate indicts.

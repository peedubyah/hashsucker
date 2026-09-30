# Retrospective: stale-inventory binding retry throttle

Expected: repeated catalog materialization would retry failed binding writes
without cost. Actual: a stale/unbounded inventory observation caused repeated
activation attempts and noisy failure logs during restart/replay.

- Useful evidence: production logs identified the exact repeated failure,
  `Cannot bind through a stale or unbounded provider inventory observation`.
- Smallest change: throttle only that known transient failure by exact
  library/TorrentFile/provider-file route; leave other failures visible and
  preserve the VFS row as playback authority.
- Verification: deterministic replay/window-expiry test plus focused VFS and
  fulfillment tests passed.
- Remaining uncertainty: no long-run production restart measurement was
  collected because the canary CDP environment was not ready; no autonomous
  recovery claim follows.
- Guidance: retry throttles must be failure-specific and bounded; a generic
  suppression would hide durable identity or binding defects.

# Reliability — What Is Proven

Not everything is green. Canonical evidence: `docs/BUILD-LOG.md`
(2026-09-26 through 2026-09-30 entries).

## Proven with byte-level evidence

- Cross-provider same-object failover (TorBox ↔ Real-Debrid), ranges hashed.
- Plex-part failover and route-failure behavior.
- Real-consumer canary: playback, identity, seeks, near-EOF, teardown.
- Sentinel rotation 3/3 with 94 ms session-to-first-read on a fresh run.
- Consumer reconciliation beyond 500 items; write-amplification audited.

## Explicitly not proven

- Scheduled long-term canary cadence.
- Active lifecycle recovery (Rust/Node proofs in progress, unrecorded).
- PMS outage behavior and post-restart continuity (PARTIAL / STOPPED —
  idle replay observed, active continuity not proven).

## Standing rules that follow

- A test asserting health is not health; production-path proof wins.
- Screenshots diagnose; bytes, ranges, and hashes accept.
- Manual repair proves a repair path, not autonomous recovery.
- Corpus/source health is never fulfillment evidence.

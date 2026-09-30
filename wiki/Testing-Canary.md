# Testing / Production Canary

How playback is actually proven. Canonical mechanics:
`src/PRODUCTION-PLAYBACK-TESTING.md` — this page summarizes, never replaces.

## The canary

A real Plex HTPC client on an isolated display/audio sink plays fixtures
end to end: session attribution, identity checks, progression, forward /
backward / near-EOF seeks, exact-TorrentFile byte evidence, clean teardown.
Fixture rotation (`e01`, `e05`, `mobland`) runs on demand; invalid fixtures
fail loudly without touching production state.

## What it is not

- Not a lifecycle or chaos harness. Service restart, fault injection,
  provider invalidation, and product-state repair are external, explicitly
  approved operations — never part of the canary.
- Repetition counts cover playback observations only.

## Current standing

- Capability achieved; fit for on-demand regression use at modest cadence.
- Not proven: continuous scheduled operation, lifecycle recovery, PMS
  outage continuity (idle replay observed; active continuity not proven).

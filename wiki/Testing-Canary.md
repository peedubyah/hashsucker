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

## Concrete fixtures (real evidence, not illustrations)

- **Lanterns S01E01** — ratingKey `497`, Part `1042`,
  `tf_426aa723-…`; baseline MKV direct-play + seek fixture.
- **Lanterns S01E05** — ratingKey `514`, Part `1061`, MP4-only;
  repaired representation transition (no stale `.exe` part may
  participate), `tf_1355e37f-…`.
- **MobLand S02E02** — ratingKey `512`, Part `1057`, recent Dolby-Vision
  representation, `tf_8d9d4437-…`; playback/seek/byte-identity proven,
  color rendering explicitly out of scope. Marked latency-abnormal in
  rotation (83.9s wall) with identity/session/bytes passing — latency
  anomaly without evidence demotion.
- **E01 republication** — VFS row genuinely deleted, recreated via
  `POST /api/library/republish` (`reuseMode=republish`), canary
  playback passed after reconstruction; missing truth 409s fail-closed.

No secrets here: TF IDs and ratingKeys are forensic labels, provider
tokens never appear in fixtures, logs, or transcripts.

## Source references

- `src/PRODUCTION-PLAYBACK-TESTING.md` (fixture table, PASS criteria,
  failure classes), `media-search/src/scripts/dev-canary.js`
- `docs/BUILD-LOG.md` (rotation proofs, republication proof)

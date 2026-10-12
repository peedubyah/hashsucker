# Testing / Production Canary

How playback is actually proven. Canonical mechanics:
`src/PRODUCTION-PLAYBACK-TESTING.md` — this page summarizes, never replaces.

## The canary

A real Plex HTPC client on an isolated display/audio sink plays fixtures
end to end: session attribution, identity checks, progression, forward /
backward / near-EOF seeks, exact-TorrentFile byte evidence, clean teardown.

Control surface is **hybrid**: the client's own in-process libmpv JSON socket
is the player truth source for position/duration/pause and for every seek,
while the Plex *application* layer is driven for exactly two operations —
app-level start and app-level stop. CDP is loopback-only and exists only
because the canary launcher enables QtWebEngine remote debugging.

Invalid fixtures fail loudly without touching production state.

## Why app-level start and stop are still required

Verified against Plex HTPC `1.71.1.346`:

- Loading a PMS part URL directly on the mpv socket decodes bytes but creates
  **no** PMS playback session. Decoder activity is not a session.
- `mpv stop` unloads the file (libmpv goes idle) but never notifies the
  application, and the **PMS session survives**, frozen. Clean teardown needs
  the app.

So the mpv socket is authoritative for *observation and seek*, not for the
session lifecycle.

## What it is not

- Not a lifecycle or chaos harness. Service restart, fault injection,
  provider invalidation, and product-state repair are external, explicitly
  approved operations — never part of the canary.
- Repetition counts cover playback observations only.
- Not CDP-free: two app-level evaluates per fixture are deliberate. All seek
  execution, position/duration/pause observation, EOF positioning and playback
  polling are native mpv IPC.

## Current standing

- Capability achieved; fit for on-demand regression use at modest cadence.
- Latency numbers are observation latencies and byte-path TTFBs, reported
  separately and honestly. Not proven: continuous scheduled operation,
  lifecycle recovery, PMS outage continuity.

## Concrete fixtures (real evidence, not illustrations)

- **Lanterns S01E01** — ratingKey `497`, Part `1042`,
  `tf_426aa723-…`; baseline MKV direct-play + seek fixture.
- **Lanterns S01E05** — ratingKey `514`, Part `1061`, MP4-only;
  repaired representation transition (no stale `.exe` part may
  participate), `tf_1355e37f-…`.
- **MobLand S02E02** — ratingKey `512`, Part `1057`, Dolby-Vision
  representation, `tf_8d9d4437-…`; playback/seek/byte-identity proven,
  color rendering explicitly out of scope.
- **MobLand S02E04** — ratingKey `534`, Part `1085`, `tf_ca408d82-…`.

No secrets here: TF IDs and ratingKeys are forensic labels, provider
tokens never appear in fixtures, logs, or transcripts. Canary output is
redacted for `X-Plex-Token` because resolved media URLs carry it.

## Source references

- `src/PRODUCTION-PLAYBACK-TESTING.md` (fixture table, PASS criteria,
  failure classes, hybrid canary internals),
  `media-search/src/scripts/dev-canary.js`
- `media-search/src/lib/plex-htpc/mpv-ipc.js`, `.../plex-app.js`
- `docs/BUILD-LOG.md` (rotation proofs)

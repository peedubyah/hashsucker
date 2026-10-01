# Production playback testing

## Why this exists

Metadata visibility is not playback proof. A Plex rating key or `MediaPart`, a direct `/vfs` `206`, `playbackInfo`, or a control-command `2xx` can all succeed without a real Plex client consuming bytes. Production acceptance therefore requires Plex-client-mediated playback, independent PMS observations, and HashSucker read attribution.

## Canary architecture

- Official Plex HTPC for Linux `1.71.1.346-f62ce923` (`/usr/bin/Plex`).
- Private Xvfb display `:86` (`1920x1080`, TCP disabled).
- Private PipeWire/Pulse null sink `hashsucker_canary`.
- Dedicated authenticated profile: `/home/patrick/.local/share/hashsucker-playback-canary/plex`.
- User services: `hashsucker-plex-xvfb.service`, `hashsucker-plex-audio.service`, and `hashsucker-plex-canary.service`.
- Launcher: `/home/patrick/.local/bin/hashsucker-plex-canary`.
- The canary alone uses `AllowInsecureConnections=sameNetwork` and `PreferInsecureConnections=sameNetwork`. PMS control is private-LAN/local only; no public relay or proxy is permitted.
- It is not fullscreen on `:0`, does not take active-desktop focus, and emits audio only to the null sink.

## Test layers

1. Deterministic/core tests: identity, binding, resolver, VFS, and data-plane behavior.
2. Production smoke: authenticated health, metadata, binding/VFS consistency, and bounded byte probes.
3. Production playback: a real Plex HTPC client is launched and controlled; PMS session state and HashSucker telemetry are authoritative.
4. Fresh-request production acceptance: occasional clean fixture fulfillment and playback from a fresh request.

## Commands

The production Plex HTPC canary controller runs in the **host namespace**.
This is the only supported execution boundary: Plex HTPC, Xvfb, audio, and
CDP are host user services, and CDP remains deliberately loopback-only at
`127.0.0.1:9222`. Do not run the canary through `docker compose exec`; the
media-search container must not own browser control or receive a host-gateway
CDP workaround.

Canonical invocation, from the repository:

```sh
cd /home/patrick/src/hashsucker/media-search
npm run test:production-canary
```

The runner starts missing isolated Xvfb/audio/HTPC services, verifies the CDP
page and Plex internal navigation service, stops any prior canary-owned
playback, waits for PMS session teardown, and captures a fresh per-TorrentFile
stage-ring correlation baseline before each fixture. It never restarts PMS,
media-search, Rust, providers, or publication state. Accidental container
execution fails fast with `CANARY_INFRA_FAILURE` and the canonical command.

From `media-search/`:

```sh
npm run test:production-smoke
npm run test:production-playback
npm run test:production-acceptance -- --fixture lanterns-s01e01
npm run test:production-canary
npm run test:dev-canary
npm run test:dev-canary -- --fast
npm run test:dev-canary -- --fixture=e05
```

The harness receives `PLEX_URL` and `PLEX_TOKEN` from the existing runtime environment. Never put either in source, fixtures, logs, or shell transcripts. Fixture overrides include `PRODUCTION_TEST_PLEX_RATING_KEY`, `PRODUCTION_TEST_TORRENT_FILE_ID`, `PRODUCTION_TEST_SEASON`, and `PRODUCTION_TEST_EPISODE`.

Canary lifecycle:

```sh
systemctl --user start hashsucker-plex-xvfb.service hashsucker-plex-audio.service
systemctl --user start hashsucker-plex-canary.service
systemctl --user status hashsucker-plex-canary.service
systemctl --user restart hashsucker-plex-canary.service
```

The playback suite must launch/control the canary unattended, issue play, forward-seek, backward-seek, and stop, collect PMS plus data-plane evidence, and exit nonzero unless every required assertion passes.

The canary never restarts Plex Media Server, media-search, Rust, or any other
production service. Lifecycle experiments use a separate bounded orchestrator;
the canary only triggers playback and observes PMS/data-plane evidence.

The canary's normal-path forbidden actions are service restart, infrastructure
fault injection, provider invalidation, publication recreation, database or
product-state mutation/repair, and failover orchestration. A lifecycle
experiment may use the canary before or after an explicitly approved mutation,
but the external lifecycle harness owns that mutation.

Repetition semantics are explicit: **N canary passes means N playback
observations.** It never means N service restarts or other destructive
mutations unless the approved lifecycle experiment separately says so.

`npm run test:production-canary` is the unattended sentinel command. It runs
one deterministic rotation of E01, E05, and MobLand, keeps normal success to a
compact JSON summary, and exits nonzero on any fixture failure. Set
`HASHSUCKER_CANARY_RUNS=N` to repeat playback observations per fixture; use
`node src/scripts/dev-canary.js --fixture=e01 --quiet` for one fixture. The
rotation is intentionally small and known-good, not random library traversal.
Detailed output is emitted for failures, identity mismatches, and materially
abnormal latency; slow-start snapshots remain bounded and token-free.

`test:dev-canary` (`src/scripts/dev-canary.js`) preflights the three host user
services, drives the loopback CDP endpoint and isolated HTPC display, starts
fixtures through the native navigation path, polls `/status/sessions`, reads
only fresh per-TorrentFile `stages_by_tf` records after each fixture baseline,
seeks forward/backward, stops through the native controller, and requires
session termination. It never calls Companion `playMedia` and never accepts
retained telemetry from a prior fixture as causal evidence. `--fast` runs E01;
default runs E01, E05, and MobLand. It emits JSON evidence and returns nonzero
on any failed assertion. Running it inside the media-search container fails
fast because the host-loopback CDP boundary is intentional.

The driver classifies `CANARY_CONTROL_FAILURE`, `PLEX_SESSION_FAILURE`, and
`IDENTITY_DRIFT_FAILURE` separately. It uses the fixed Xvfb TV-library grid
instead of Continue Watching order, resolves the HTPC window dynamically,
verifies the profile screen before selecting it, records all observed sessions
on failure, and captures one failure screenshot plus the UI action trace. A
wrong Plex item is never accepted as the expected fixture.

## Authoritative playback PASS criteria

A fixture is PASS only when the same run proves:

- real PMS playback session for the expected Plex client;
- expected rating key and `MediaPart` ID/path;
- PMS/client access to the HashSucker-backed media path;
- exact active `LibraryItem` → `Binding` → `TorrentFile` correlation, including size and read/range activity;
- playback position advances;
- forward seek changes position and causes corresponding distant reads;
- backward seek changes position and causes corresponding reads;
- clean stop and session termination.

Metadata existence, a rating key, a `MediaPart`, a direct VFS `206`, `playbackInfo`, or a control `2xx` alone never counts as playback proof.

## Current fixtures

- **Lanterns S01E01** (`ratingKey 497`, `MediaPart 1042`): baseline MKV/direct-play and seek fixture.
- **Lanterns S01E05** (`ratingKey 514`): repaired representation transition; current MP4 must be the only selectable representation and no stale `.exe` part may participate.
- **MobLand S02E02**: recent fulfilled Dolby-Vision representation; prove playback/seek and byte identity, not color-rendering behavior.
- Add a known-healthy movie or dual-provider fixture only when one already exists in the authoritative control plane.

## Security and ownership

Plex tokens are runtime secrets: never commit, print, or persist new copies. The local/private PMS HTTP path is an explicit canary-only exception and must never be exposed through a public relay or proxy. HashSucker's durable identity remains Release/TorrentFile/Binding. Plex is an observed consumer, not media-identity authority.

## Current limitations / evidence status

The bundled Qt runtime has a TLS-backend defect; the canary is temporarily bounded to same-network insecure PMS connections. The Companion diagnostic still has transient-source timeline failures, but the ordinary UI fixture matrix is green: E01 is ratingKey `497`/Part `1042` with `tf_426aa723-3dfc-427a-8cc2-3871f231ff6c`; E05 is ratingKey `514`/Part `1061`, MP4-only with no stale `.exe`, and `tf_1355e37f-143d-4703-8a53-23827089afbe`; MobLand E02 is ratingKey `512`/Part `1057` with `tf_8d9d4437-03e9-440b-8b80-db36f9dd22af`. All three showed real sessions, progression, forward/backward seeks, exact-TorrentFile read activity, and clean stop/session termination.

Failures are classified as `PREFLIGHT`, `UI_TRIGGER`, `SESSION_ATTRIBUTION`, `PART_MISMATCH`, `VFS_CORRELATION`, `NO_PROGRESS`, `SEEK_FORWARD`, `SEEK_BACKWARD`, `BYTE_CORRELATION`, or `CLEAN_STOP`. None is downgraded to a metadata, `206`, `playbackInfo`, or control-command pass.

### Session-attribution investigation (2026-09-30)

The current automation is not ordinary local library navigation. It calls the
PMS Companion endpoint `/player/playback/playMedia` with the rating key and play
queue. HTPC accepts the command and opens the expected Part, but its log shows
`Testing connections to Transient-Server-<streamer machine id>` and the source
is `server://transient-<streamer machine id>/.../library/metadata/497`.
Timeline calls (`buffering`, `playing`, progress, and `stopped`) fail against
that transient source, so `/status/sessions` remains empty even while MPV is
playing. This is a confirmed control-flow distinction, not a reason to weaken
the acceptance criterion.

The corrected production path is now the HTPC UI. The minimum deterministic
sequence on the isolated display is: wake HTPC; open the TV library sidebar;
choose `Library`; select the `Lanterns` show card; select Season 1; select the
S01E01 card; activate its Play button. This produces the registered
`server://<streamer machine id>/...` source and must be used by production
playback. Companion `playMedia` remains a lower-level diagnostic only.

This UI path was exercised successfully: PMS exposed ratingKey `497`, Part
`1042`, the expected VFS path, client machine identifier, and `state=playing`;
the position advanced; keyboard seek controls changed the PMS position; and
the `X` stop action removed the PMS session. No synthetic timeline events were
used.

The stable HTPC client identifier is `1iu21f4816xfz8urti7gfc9r`; the expected
PMS is streamer (`1c622b259a95aebb46228e9661409b7656539c53`). The transient path
bypasses normal registered-server association even though it uses the same
client identifier.

### Native HTPC control seam (2026-09-30)

HTPC exposes a localhost-only Chrome DevTools Protocol listener on
`127.0.0.1:9222`. This is the unattended control seam for the canary; it does
not require screen coordinates, focus choreography, screenshots, or fullscreen
desktop interaction. The loaded web client’s webpack module `43782` contains
the normal metadata-play function, but it requires an internal view-model and
is not a stable public API. The usable bounded seam is the already-authenticated
navigation service:

```js
navigation.navigate("VisualMediaPlaybackScreen", {
  metadataSourceUri:
    "server://<streamer-id>/com.plexapp.plugins.library/library/metadata/497",
  itemKey: "/library/metadata/497",
  type: "episode",
  subtype: "episode",
  grandparentKey: "/library/metadata/495",
  parentKey: "/library/metadata/496",
  fromPlayButton: true,
  startPaused: false
})
```

This route was proven with Lanterns S01E01: it created a normal PMS-owned
session (`ratingKey=497`, `MediaPart=1042`, `decision=directplay`) for the
stable HTPC client, with the expected HashSucker VFS path. The active screen’s
native playback controller then provided `seek(positionMs)` and `stop()`;
forward and backward seeks changed PMS `viewOffset` to 600000 ms and 120000 ms,
and the data-plane recorded reads for the exact bound TorrentFile
`tf_426aa723-3dfc-427a-8cc2-3871f231ff6c`. `stop()` removed the PMS session.

The CDP listener is bound to loopback and is part of the isolated canary
profile only. Do not expose it, print Plex tokens, or treat arbitrary web-client
webpack internals as a durable product API. Companion `playMedia` remains a
diagnostic lower-level byte-consumption test and must not start production
acceptance runs. The coordinate-based `test:dev-canary` robot remains a fallback
diagnostic, not the preferred start primitive.

The current `test:dev-canary -- --fast` path is CDP-only for start, seek, and
stop. It bootstraps the loaded HTPC webpack registry through CDP, invokes the
registered-server navigation route, waits for the native playback controller
to become loaded/playing (navigation resolves before that point), then checks
PMS and data-plane evidence. It performs no screenshot capture or coordinate
automation during a normal run. Set `HASHSUCKER_CANARY_RUNS=10` for the E01
reliability gate; omit `--fixture` for the three-fixture matrix (three runs by
default), or use `--fixture=e05` / `--fixture=mobland` for one fixture.

The first CDP-only E01 gate completed 10/10. The subsequent full matrix
completed 3/3 each for E01, E05, and MobLand E02. Every run observed the
expected client/ratingKey/Part/path, progression, substantial forward and
backward seeks, exact-TorrentFile read telemetry, and clean PMS session
termination. These are development acceptance results, not a claim that
restart, failover, cold-cache, near-EOF, or fresh-request scenarios are already
proven.

### Playback assertions and latency (2026-09-30)

The canary now also seeks each fixture to an EOF-adjacent position
(`duration - 180 s`), requires PMS to reach that timeline region, and records
named timestamps for controller readiness, PMS session, first exact-TorrentFile
read, progression, forward/backward/EOF seek results, and session teardown. It
does not synthesize timeline or byte evidence.

Seek correctness and backend byte provenance are separate assertions. A seek
PASS requires the native controller and PMS to reach the requested absolute
target, playback to continue, and the same ratingKey/MediaPart/VFS path and
TorrentFile to remain authoritative. A new HashSucker/Rust event is not
required when the seek is satisfied from Plex or an upper cache/buffer; the
result is reported as `SEEK_PASS_BUFFERED`. When backend I/O is required, the
correlated stage report is separately reported as `BYTE_PATH_READ` or
`BYTE_PATH_CACHE`. The harness never infers `cache_hit` when no Rust request
occurred.

Initial samples show normal successful runs are dominated by media startup and
first-read-to-progress rather than CDP command dispatch. Typical E01 samples
were ~11–16 s from command to progressing playback; seek-to-read was ~1–7 s;
stop-to-session-gone was <1 s. One E05 run took ~89 s, with ~71 s between PMS
session appearance and first HashSucker read. That is an observed cold-path
tail, not yet attributed to a specific provider or cache cause.

Near-EOF passed for E01, E05, and MobLand in the successful samples. Additional
strengthened runs exposed one E05 session-start failure requiring follow-up.
The apparent MobLand/E05 backward-seek failures were traced below to
cache-served seeks being observed too late by the harness. No thresholds were
relaxed and no product state was repaired.

The direct seek diagnostic established that HTPC `seek(positionMs)` is an
absolute asynchronous millisecond seek. On E01, E05, and MobLand, targets
600s → 120s → 900s → 300s produced matching controller and PMS positions after
the player settled. The earlier apparent 267s/501s backward failures were
caused by the harness waiting for a *new* data-plane stage before checking PMS:
those regions were already cached, so playback kept advancing while the
harness waited. The strengthened harness now polls PMS and telemetry
concurrently and records a cache-served seek when existing 64-MiB-aligned
range evidence covers the requested byte/time region; it does not widen
timeline tolerances.

The E05 long-tail remains a known tail: historical session-to-first-read was
about 70.5 s and its owner is `UNATTRIBUTED`. The bounded post-instrumentation
E05 campaign completed 5/5 normal sessions; two runs had long first-read delays
(47.6 s and 79.0 s) but passed. At the owner boundary, PMS had a live session
while no HashSucker VFS read was observed, so those new samples classify as
`PLEX/CLIENT SIDE`; the deeper cause remains un-attributed.
The historical status is therefore `UNATTRIBUTED / NOT REPRODUCED` for the
original sample, with automatic detailed capture armed if a future run crosses
the diagnostic threshold. It is tracked debt, not called fixed, and it does not
block lifecycle work by itself.

The later MobLand diagnostic reached the requested 300 s PMS position exactly,
and the session continued with the same identity. A seek may therefore be
`SEEK_PASS_BUFFERED` when no Rust request occurs. In the current authoritative
MobLand run, both forward (900 s) and backward (300 s) seeks also had exact
same-TorrentFile cache ranges, so they are reported as `BYTE_PATH_CACHE` in
addition to the semantic seek PASS. Backend byte-path provenance remains
separate from the controller/PMS assertion.

The data-plane now retains a bounded `stages_by_tf` ring (256 completed stage
reports per TorrentFile) in addition to the global 64-entry ring. Each report
retains its correlation ID, exact request range, `tf_id`, `cache_hit`, provider,
capability, CDN attempts, and T0–T5 waterfall. This is deliberately scoped
observability, not a general tracing system; unrelated TorrentFiles can no
longer evict the active canary fixture’s evidence before teardown.

After activation, MobLand now has an authoritative correlated cache-served
forward and backward seek sample. The exact ranges are retained with the same
`tf_id`; E05 cache-served seeks likewise produce correlated cache-hit ranges.

The canary now uses the data-plane stage ring’s correlation ID, exact request
range, `tf_id`, and `cache_hit` fields. These fields establish byte-path
provenance when a backend request exists; they are not a prerequisite for a
correct buffered seek. A prior similar range is not reused as evidence for a
new backend request. The per-TorrentFile retention is bounded (256 completed
reports) and scoped to the active fixture.

### Rust/data-plane lifecycle (2026-09-30)

Idle-between-plays Rust restart passed 5/5 on E01. Each trial restarted only
`data-plane`, waited for the container health check, then replayed the same
Plex item. RatingKey 497, Part 1042, the canonical VFS path, and
`tf_426aa723-3dfc-427a-8cc2-3871f231ff6c` were unchanged. Forward and backward
seeks, progression, near-EOF delivery, and clean session teardown passed. A
post-restart non-cache stage reacquired capability `torbox-0-0` through TorBox
(acquisition ~345 ms), demonstrating that runtime capability/provider state is
reconstructible without changing durable identity.

Active-playback restart passed 3/3 on E01. The PMS session remained present,
the same ratingKey/Part remained selected, the native controller stayed loaded
and playing, and a substantial post-restart seek to 900 s reached the target;
all sessions stopped cleanly. This establishes `POST_RESTART_RECOVERY`. It does
not claim uninterrupted `ACTIVE_STREAM_CONTINUITY`, because the probe does not
promise that an in-flight read survives process death; that distinction remains
explicit.

One idle restart replay also passed for E05 and one for MobLand E02, preserving
their existing Parts, VFS paths, and TorrentFiles. No Binding, TorrentFile,
representation, or VFS drift occurred, and no product-state repair was used.
The initial active-restart probe had a control-script JSON negotiation bug and
was discarded; the corrected probe produced the 3/3 result above.

### Node/media-search lifecycle (2026-09-30)

Idle-between-plays media-search restart passed 5/5 on E01. Each restart waited
for the container health check, then replayed through the CDP canary. The
durable snapshot before and after was identical:

- LibraryItem `li_e6af7605a44108916869ba81`
- Binding `bd_5e150cc9-5620-40e5-8672-ddb91a7e4ce6`, version 1
- TorrentFile `tf_426aa723-3dfc-427a-8cc2-3871f231ff6c`, size 8,660,679,535
- ProviderPlacement `pl_691373b3-9464-4e00-9865-9ac0ccc193a1`
- canonical VFS path `TV/tt26545992/Season 01/tt26545992 - S01E01.mkv`
- Plex ratingKey 497 / Part 1042

Playback progression, forward seek, backward seek, near-EOF, and clean stop
passed in all five trials. One E05 and one MobLand idle-restart replay also
passed with unchanged identity.

Active-playback media-search restart passed 3/3 on E01. The PMS session and
same Part remained present, and a post-restart seek to 900 s reached the target
with the controller loaded and playing. This proves `POST_RESTART_CONTROL/
RECOVERY`. Uninterrupted `ACTIVE_STREAM_CONTINUITY` is not claimed: the probe
does not assert that an in-flight Node-owned operation survives process death.

Healthy restart side effects were not quiet. Across the bounded restart window,
startup emitted approximately 444 binding activation attempts and 444 failures
(`stale or unbounded provider inventory observation`) plus approximately 296
VFS bind log lines. The known E01 binding itself remained unchanged and no
manual repair occurred. No clear external provider/discovery API storm was
observed in the logs, but the local reconciliation churn is a follow-up issue;
this phase records it without optimizing it.

### Current lifecycle boundary

Rust owns active byte delivery and recovered independently. Node restart did
not change durable identity, Plex publication, or later seek/path resolution.
Node is required for readiness, control-plane lookup, and reconciliation, but
the active Plex session remained usable across the tested restart window.

## Future hardening targets

- real playback start/seek reliability and session observability;
- same-X provider failover through Plex;
- playback after Node restart;
- playback after Rust/data-plane restart;
- Plex forward and reverse library audits;
- playback start/seek latency measurements.

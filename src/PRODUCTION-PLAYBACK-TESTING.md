# Production playback testing

## Why this exists

Metadata visibility is not playback proof. A Plex rating key or `MediaPart`, a direct `/vfs` `206`, `playbackInfo`, or a control-command `2xx` can all succeed without a real Plex client consuming bytes. Production acceptance therefore requires Plex-client-mediated playback, independent PMS observations, and HashSucker read attribution.

## Canary architecture

Two control surfaces, in order of preference:

1. **libmpv native IPC socket** — the player's own truth. Position, duration,
   pause state and seek execution all come from the client's in-process libmpv
   (see "Hybrid native/app canary" below). No browser automation, no injection,
   no binary patch.
2. **Plex application layer (one CDP evaluate each for start and stop)** —
   required because only the application can create and tear down a real PMS
   session. Everything between them is native mpv IPC.

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

`test:production-canary` (`src/scripts/dev-canary.js`) runs the hybrid
native/app canary described below. It preflights the three host user services,
makes the libmpv IPC socket deterministic, starts each fixture through the
Plex application layer, then observes and controls playback through the mpv
socket, polls `/status/sessions`, reads only fresh per-TorrentFile
`stages_by_tf` records taken after each fixture baseline, seeks
forward/backward/near-EOF, stops through the application layer, and requires
session termination. Default runs E01, E05, E08 and MobLand; `--fast` runs E01;
`--fixture=<key>` runs one. Running it inside the media-search container fails
fast because the host-loopback boundary is intentional.

Failure classification is per-stage, not generic: `APP_START_FAILED`,
`PMS_SESSION_NOT_CREATED`, `MPV_IPC_UNAVAILABLE`, `MPV_IPC_NOT_PLEX`,
`MPV_IDENTITY_MISMATCH`, `PLEX_IDENTITY_MISMATCH`, `NO_POST_SESSION_READ`,
`NO_PROGRESSION`, `SEEK_FORWARD` / `SEEK_BACKWARD` / `SEEK_NEAR_EOF`,
`APP_STOP_FAILED`, `PMS_TEARDOWN_FAILED`, `PMS_SESSION_CREATE_REJECTED`,
`EVIDENCE_UNAVAILABLE`,
`STALE_SESSION`. A wrong Plex item is never accepted as the expected fixture.
All canary output is redacted for `X-Plex-Token`; resolved media URLs carry the
token, so evidence must never reach a transcript unredacted.

### Hybrid native/app canary

Reverse-engineered facts for Plex HTPC `1.71.1.346-f62ce923`:

- The UI is a webpack application loaded over `file://` from
  `/opt/plex-htpc/resources/web-client/`; it talks to the native side over
  **QtWebChannel** (`player.queue`, `player.play`, `player.seekTo`, `player.stop`,
  `player.teardown`, …).
- Playback is served by **libmpv 0.38.0 running in-process** inside
  `/opt/plex-htpc/bin/Plex`. There is no mpv child process and no mpv socket by
  default.
- The client reads `<PLEX_USERDATA_DIR>/mpv.conf` at engine init. Adding

  ```
  input-ipc-server=/tmp/hs-mpv-ipc.sock
  ```

  to the canary's own Plex user-data `mpv.conf` exposes libmpv's native JSON
  control socket. This is a Plex-specific user-data config, never machine-wide
  `~/.config/mpv`, and requires no binary patch, no injection and no CDP.

The resulting control path:

```
app-level start (1 CDP evaluate: modal.closeAll + navigation.navigate)
   ↓
PMS session exists / ratingKey + Part + media path + client identity verified
   ↓
libmpv IPC: path (identity), duration, pause, time-pos, seek
   ↓
PMS viewOffset progression + fresh exact-TorrentFile byte reads per seek
   ↓
app-level stop (1 CDP evaluate: playbackSessionManager stop)
   ↓
PMS session teardown + libmpv idle confirmed
```

**What mpv IPC proves.** That the real client's own decoder is playing the
expected Part (`path` contains the Part id), at the requested position, with the
requested pause state, and that a seek actually moved that decoder. It is
player truth, not UI truth.

**What PMS session checks prove.** That the *application* created a session for
the expected ratingKey and Part, attributed to the expected client, on the
expected Plex media path, and that `viewOffset` followed the player — i.e. the
session is genuinely driven by this playback and not merely left over.

**Why raw `loadfile` is insufficient for start.** Verified against this build:
loading a PMS part URL directly on the mpv socket decodes bytes but creates no
PMS playback session. Decoder activity is not a session, and the acceptance bar
requires a real client session.

**Why raw `mpv stop` is insufficient for teardown.** Verified against this
build: `stop` on the mpv socket unloads the file (libmpv goes idle) but the
application layer is never notified — zero new lines in the client log — and the
PMS session survives, frozen. Teardown must go through the application.

**Seek byte-evidence semantics.** The delivery path reads in 64 MiB chunks and
reads ahead of the exact requested position (observed up to ~370 MiB, ≈36 s of
media, past a target), so requiring an exact byte window produces false
negatives for seeks that land near already-buffered data. Seek evidence
therefore requires a read that is genuinely distant from the start of the file
(a plain offset-0 probe never satisfies it) and whose implied media position is
within 180 s of the target; the record is additionally marked `strictWindow`
when it falls inside one 64 MiB window of the exact expected offset.

**Latency semantics.** The data-plane records relative timings only
(`T0_received_ms` is always 0). `observedSessionToFirstRead` is therefore the
canary's *observation* latency — how long after the canary saw the PMS session it
saw the byte read — not a browser-visible latency. The byte path's own timing is
reported separately as `bytePath.firstReadTtfbMs` (and per-seek
`seekTtfbMs`), which is the honest first-byte-to-client number. Nothing here is
a synthetic latency claim.

**Remaining CDP dependency — exactly two evaluates per fixture.** Cleanup stop
before start, start, and final stop. Bridge setup costs two further evaluates
(webpack registry bootstrap + DI container verification). CDP is only enabled
because the canary launcher sets `QTWEBENGINE_REMOTE_DEBUGGING=9222`; it is
loopback-only. Seek execution, position/duration/pause observation, EOF
positioning and all playback polling are native mpv IPC and use no CDP.

**Deferred play-queue advance.** Observed: after the canary's app-level stop
clears the session, the client can advance the play queue seconds later and
start the next episode, leaving a stale PMS session once the run has already
reported PASS. A near-EOF seek makes this more likely because it drives
playback to the end. The stop is now a **drain** — it retries until sessions
stay at zero for a settle window, and teardown is only reported clean when no
session reappears after confirmation.

**Confined cosplay of the historical E04 issue.** The old start primitive did
not close transient UI state; the internal Plex path (used by Companion
`playMedia`) calls `modal.closeAll()` before navigating. The new start mirrors
that. This is a robustness improvement, **not** a claimed root cause for the
historical E04 failure — that was not reproduced here. E04 now passes session
creation with full identity verification.

### Known failure modes: intermittent PMS-side session creation

Two distinct client-visible failures have been observed at start, both
classified `PMS_SESSION_NOT_CREATED`, both recorded with the client's own
reported error, and neither attributable to canary machinery:

1. **Metadata HTTP timeout.** The client's 30 s HTTP timeout against
   `/library/metadata/<rk>`: `statusCode: 0`,
   `statusText: "timeout of 30000ms exceeded"`, playback screen at
   `state: stopped, loaded: false`. Observed once among ~15 runs; the same
   fixture then passed six of six.
2. **Play queue session creation 500.** `FailedToCreateSession`,
   `"An error occurred loading items into the play queue."`,
   `statusCode: 500` on `/playQueues`. Observed once in the final validation
   matrix; the same fixture then passed four of four.

Both are PMS-side HTTP failures surfaced through the client. Neither should be
treated as flaky automation, and neither was reproduced enough to characterise
as a latency tail versus a genuine PMS defect. Keep them in the evidence: the
canary's job is to notice them, not to absorb them.

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

## Core graduation status

The core reliability phase is closed. The accepted bar is real request/publication
truth, Plex-client playback, exact TorrentFile attribution, provider/runtime
recovery, and on-demand canary regression detection. PMS lifecycle remains
partial and isolated latency tails remain debt; neither currently blocks normal
unattended request/playback/recovery. New reliability work requires a fresh
observed defect, not a theoretical gap.

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

### Native HTPC control seam (superseded 2026-10-12)

> The section below is retained as historical evidence for how the canary
> previously drove the client. It is no longer the control path: playback
> observation and seeks now come from the libmpv IPC socket, and only app-level
> start/stop still use CDP. See "Hybrid native/app canary" above.

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
PMS and data-plane evidence. The same canary may be run after an exact
`/api/library/republish` operation to prove the reconstructed publication is
consumer-playable; it does not broaden the canary's ownership or repair scope. It performs no screenshot capture or coordinate
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

## PMS-side session-creation failures (diagnosed 2026-10-12)

Two intermittent start failures were investigated using the hybrid canary as
the trigger/observer. Findings, with the exact failing transaction:

### The `/playQueues` 500 (`FailedToCreateSession`) — root cause proven

PMS request log, all from Plex HTPC on loopback:

```
16:40:59.563  GET  /library/metadata/501?includeUserState=1   [Req#198bb]
16:40:59.824  POST /playQueues?own=1&excludeElements=...&uri=server://<pms>/com.plexapp.plugins.library/library/metadata/509&type=video&continuous=1&includeRelated=0&repeat=0&key=/library/metadata/534   [Req#198c3]
16:41:02.753  [Req#198c3] PlayQueue: Start index: 0 End index: 3 Count: 4
16:41:09.590  ERROR [Req#198bb] Waited over 10 seconds for a busy database; giving up.
16:41:09.590  ERROR [Req#198bb] Saving activity history aborted with DB exception
16:41:12.765  ERROR [Req#198c3] Waited over 10 seconds for a busy database; giving up.
16:41:12.765  ERROR Got exception from request handler: std::exception
16:41:12.765  Completed: 500 POST /playQueues
```

`FailedToCreateSession` is **not a play-queue defect**. It is PMS's SQLite
busy-database wait expiring: the request waits up to 10 s, PMS gives up, and
returns 500. The lock holder is the **library scanner**.

**What held the lock, and why it runs at all.** Two proven amplifiers:

1. **The rclone FUSE VFS mount reports directory change times that are always
   current.** PMS logs `WARN … Directory change time at: "/mnt/hashsucker-vfs/…"
   is in the future: <now>` and `Last refresh (T) appears to be older than
   directory change time (<now>)`, so PMS's freshness check can never be
   satisfied. It perpetually decides "need to refresh local media agent" and
   schedules scanner work.
2. **HashSucker's own Plex section refresh** — `GET
   /library/sections/3/refresh?path=/mnt/hashsucker-vfs/TV/<show>/Season NN`
   — which directly launches a scanner. During the failure window there were 14
   such calls in two minutes (4 distinct paths, several for the same path
   seconds apart, consistent with the coalescer's debounce semantics rather than
   a defect).

During the window the scanner was actively inserting items (`Added new metadata
item … with ID 549/550`, `Scanner activity on section 3: 6 added …`), holding the
SQLite write lock for tens of seconds.

**Failure boundary:** play queue creation stalls on a busy library database
(scanner-held write lock), not in queue/metadata/media/session logic. The
narrowest proven subsystem is **PMS library-scanner DB contention**, entered via
PMS's own freshness check on a FUSE mount whose directory mtimes never age.

### The ~30 s `statusCode 0` metadata timeout — separate, unproven cause

The client reports a 30 s HTTP timeout against
`/library/metadata/<rk>?checkFiles=1` with `statusCode: 0` and no server-side
error. In the captured PMS windows the same request completed normally (200 in
~160 ms), and no matching PMS-side error was found. A shared cause is *plausible*
(scanner contention stalling the request past the client's timeout) but is **not
proven**, so it is deliberately **not merged** with the 500 class. The canary
classifies them separately: `PMS_SESSION_CREATE_REJECTED` (HTTP 500 +
`FailedToCreateSession`, evidence-backed) versus `PMS_SESSION_NOT_CREATED` /
client timeout (unclassified cause). `pmsSessionCreateRejection` only fires on
the 500 signature, and regression tests pin that it does not fire for
`statusCode 0`.

### Session-queue interaction — refuted as a cause

The canary already drains stale sessions and handles deferred queue advance. In
the captured failure there was no stale session or lingering playQueue
contributing: the failure is PMS-side database contention, correlated with
scanner activity, not with prior session/queue state.

### Mitigation assessment

**No canary workaround is implemented or recommended.** The failure is
HashSucker-infrastructure-driven (rclone FUSE directory mtimes + refresh
cadence), so any client-side guard — e.g. waiting for scan completion — would
mask a condition real users can also hit. The honest options are HashSucker-side:
fix or accept the mount's directory mtime behaviour, or reduce refresh
frequency. The canary's only change is diagnostic: it now names the PMS
rejection separately instead of collapsing it into a generic start failure.

## Cached-only fulfillment boundary, and why `no-bindable-candidate` is not a market miss (2026-10-13)

### The question

Does `prepare:no-handoff:no-bindable-candidate` mean "the market has nothing", or
"the provider has nothing cached yet"? For `tt0159187` E02–E13 the answer is now
measured, and the two are not the same thing.

### What the provider layer actually does

Pre-readiness probing is **cached-only by explicit design**, stated three times in
three independent modules:

- `resolver/torbox-file-identity.js` B.2: *"The addOnlyIfCached flag ensures we
  NEVER initiate an uncached download."* All four `createPlacement` call sites
  pass `addOnlyIfCached: true`. The TorBox API accepts `addOnlyIfCached=false`;
  nothing calls it that way.
- `providers/realdebrid/ensure.js` header: *"EVERY probe resource this ensure
  creates that does not prove immediately-usable cached state is deleted in a
  finally-grade path."*
- `control-plane/second-placement.js`: *"discover-only: TorBox cached-gate, RD
  account discovery, never an uncached addMagnet."*

Observed live for `tt0159187` E02 (`skippedCandidates`, deployed):

```
rank=1 tb=uncached reason=TorBox placement failed      (addOnlyIfCached refused)
rank=1 tb=uncached reason=INVALID_COORDINATES          (no TorrentFile to resolve S/E from)
rank=1 tb=uncached reason=rd-not-cached:rd-not-downloaded:queued
rank=1 tb=uncached reason=no-bindable-path
```

The third line is the important one: **Real-Debrid accepted the magnet and
reported `queued`.** Acquisition is not impossible — it happened. The ensure then
reached `if (status !== 'downloaded') { cleanupQuietly(rdId) }` and deleted the
resource, because "not yet downloaded" is treated identically to "not cached".

For E05/E13 the ranked candidates are season packs, and RD refuses them outright
(`rd-add-failed:hard`). So that cluster is a genuine market miss for a different
reason: no episode-specific release is cached anywhere, and the packs are refused.

### The state-machine gap

`provider_placements.state` in production holds only `ready` (286) and `removed`
(1). There is no `queued` or `downloading`. `download_requests`
(requested → resolving → materializing → staged) models *byte staging from an
already-resolved TorrentFile*, not provider acquisition. So the state HashSucker
would need — "obligation waiting on provider-preparing" — does not exist.

### Conclusion: this is a proven product boundary, not a defect

Every request-time ensure path is read-only with respect to *durable acquisition*:
it may add a probing resource and must delete it unless the bytes are already
cached. Building an acquisition state machine would be a new fulfillment stage
(obligation → waiting/provider-preparing → poll inventory → bind), which the task
explicitly says not to invent unless provider capabilities and current
architecture support it. They do not: there is no placement state for it, no
obligation state for it, and no polling consumer for it.

**Therefore `no-bindable-candidate` conflates two states** — "market miss" and
"not cached yet" — and the honest fix is to make that visible rather than to
start acquiring uncached releases.

### What changed

`skippedCandidates` is now surfaced on the prepare response (additive, read-only,
no selection change), so every ranked candidate's reject reason is visible
instead of being synthesized into one opaque `selection.reason`. This is what
made the `queued` observation possible at all.

## Cached-only fulfillment boundary, and why `no-bindable-candidate` is not a market miss (2026-10-13)

### The question

Does `prepare:no-handoff:no-bindable-candidate` mean "the market has nothing", or
"the provider has nothing cached yet"? For `tt0159187` E02-E13 the answer is now
measured, and the two are not the same thing.

### What the provider layer actually does

Pre-readiness probing is **cached-only by explicit design**, stated three times in
three independent modules:

- `resolver/torbox-file-identity.js` B.2 — "The addOnlyIfCached flag ensures we
  NEVER initiate an uncached download." All four `createPlacement` call sites pass
  `addOnlyIfCached: true`. The TorBox API accepts `addOnlyIfCached=false`; nothing
  calls it that way.
- `providers/realdebrid/ensure.js` header — "EVERY probe resource this ensure
  creates that does not prove immediately-usable cached state is deleted in a
  finally-grade path."
- `control-plane/second-placement.js` — "discover-only: TorBox cached-gate, RD
  account discovery, never an uncached addMagnet."

Observed live for `tt0159187` E02 via the new `skippedCandidates` field:

```
rank=1 tb=uncached reason=TorBox placement failed
rank=1 tb=uncached reason=INVALID_COORDINATES
rank=1 tb=uncached reason=rd-not-cached:rd-not-downloaded:queued
rank=1 tb=uncached reason=no-bindable-path
```

The third line is the important one: **Real-Debrid accepted the magnet and
reported `queued`.** Acquisition is not impossible - it happened. The ensure then
reached `if (status !== 'downloaded') { cleanupQuietly(rdId) }` and deleted the
resource, because "not yet downloaded" is treated identically to "not cached".

For E05/E13 the ranked candidates are season packs, and RD refuses them outright
(`rd-add-failed:hard`). So that cluster is a genuine market miss for a different
reason: no episode-specific release is cached anywhere, and the packs are refused.

### The state-machine gap

`provider_placements.state` in production holds only `ready` (286) and `removed`
(1). There is no `queued` or `downloading`. `download_requests`
(requested / resolving / materializing / staged) models *byte staging from an
already-resolved TorrentFile*, not provider acquisition. The state HashSucker
would need - "obligation waiting on provider-preparing" - does not exist.

### Conclusion: proven product boundary, not a defect

Every request-time ensure path is read-only with respect to durable acquisition:
it may add a probing resource and must delete it unless the bytes are already
cached. Building an acquisition state machine would be a new fulfillment stage
(obligation -> waiting/provider-preparing -> poll inventory -> bind), and neither
the provider capabilities nor the current architecture support it: there is no
placement state for it, no obligation state for it, and no polling consumer.

**Therefore `no-bindable-candidate` conflates two states** - "market miss" and
"not cached yet" - and the honest fix is to make that visible rather than to start
acquiring uncached releases.

### What changed

`skippedCandidates` is now surfaced on the prepare response (additive, read-only,
no selection change), so every ranked candidate's reject reason is visible
instead of being synthesised into one opaque `selection.reason`.

## Cold retry for exhausted season-owned aired obligations (2026-10-13)

### Old semantics

`classifyIntentPriority` returned `actionable: false` for any row with
`state === failed && attempts >= MAX_ATTEMPTS` — permanently. Combined with
`due()` (which does not filter on attempts) the row stayed in the due list but
was always filtered out of `orderedDue`, so it was never processed again. An
attempts-exhausted re-arm path existed in `processIntent` but was **unreachable
dead code**, reachable only by calling `processIntent` directly.

Consequence: an aired requested-season obligation whose market became
satisfiable later could only be revived by a brand-new Seerr request
(`revive()` is called only from `deferSeerrRequest`). Slow Horses S06E04 was
exactly this case.

### New semantics

`isColdRetryEligible(intent, nowMs)` — all four gates required:

1. `state === failed` — only exhausted rows
2. `attempts >= MAX_ATTEMPTS` — genuinely exhausted, not a hot row
3. `season_owners` non-empty — a continuing requested-season obligation, not a
   one-shot request
4. retryable market defer reason (`released-no-candidate` or
   `candidate-not-fulfillable`), and `next_check_at <= nowMs`

Anything else keeps the old permanent-exhaustion semantics: a one-shot row with
no season owner, or a `hard-failure`/`future-not-released`/null reason, never
becomes cold-actionable.

The exhausted re-arm now lands **due NOW** rather than `now() + PARKED_MS`. The
re-arm is not the 7-day wait — the next tick performs exactly ONE preparation
attempt, and a repeat market miss re-parks for the full cold interval. `retry()`
increments `attempts`, so a cold cycle never restores a fresh hot budget.

Cadence is the existing `PARKED_MS` (7 days). One interval only: both a market
miss and a transient provider failure get the same conservative cadence, and
there is no evidence to justify a second reason-specific interval.

Cold state is fully durable (attempts / season_owners / next_check_at), so a
media-search restart neither resets the cold timer nor hot-loops exhausted rows.

### Production evidence (deployed, natural scheduler ticks only)

Slow Horses S06E04 (positive target), no manual edits and no new Seerr request:

```
failed, attempts=6, parked 10-09
  → classify: id=94 state=failed class=P2 attempts=6 actionable=true cold=true
  → due-row:  from=failed to=anticipated rearmed=true coldRetry=true        (attempts 6→7)
  → due-row:  from=anticipated to=prepared  ms=9306                         (attempts 7→8)
  → due-row:  from=prepared to=playable ms=13362; prewarm warmed=17/17 bytes=142606336
  → durable: handoff reason='tv-episode bound S6E4' provider=torbox/cached
             TorrentFile tf_6445b01c, size 9474354491, bindings=1
             vfs_tv_entry canonical_path=TV/tt5875444/Season 06/…; library_item desired=present
```

`tt0159187` (negative control): the rows that attempted re-parked at exactly
168.0h (7 days) with the structured reason
`prepare:no-handoff:no-bindable-candidate`, confirming the earlier label fix —
the market still has only S01E01 cached for that show. No rapid Bloodhound or
provider work; the cadence is one attempt per 7-day cycle.

Scheduler cost: a 13-row cold cycle is 2 ticks of re-arms (8 + 5) at 16–27 ms
each, then the preparation attempts (9–16 s each, provider-bound), bounded by
`MAX_ACTIONS_PER_TICK = 8` and `MAX_TICK_WORK_MS = 30s`. P0/P1 work interleaves
with cold P2 work in the same ticks — no starvation of ordinary drain.

## Requested-season preparation failures (2026-10-13)

Two aired clusters were blocked. Both carried the same opaque label, but the
mechanisms are **different**.

### What `prepare-http-200` actually meant

`/api/media-prepare` answers **HTTP 200 for application-level outcomes**. The
scheduler's error branch was:

```js
if (r.status !== 200 || r.json?.prepared !== true || !r.json?.handoff?.torrentFileId) {
  return { ok: false, terminal: r.status === 400, error: r.json?.error || `prepare-http-${r.status}` };
}
```

So `prepare-http-200` covered **three different conditions**, all indistinguishable in `last_error`:

| Condition | Real meaning |
|---|---|
| no handoff built | `selection.selected` was null → `selection.reason` (e.g. `no-bindable-candidate`) |
| handoff without `torrentFileId` | prepared, but no authoritative TorrentFile bound |
| non-200 | genuine transport failure |

Fixed in `f32e3a6` (`src/lib/requests/prepare-failure.js`): the body's own reason
is now reported (`prepare:no-handoff:<selection.reason>` /
`prepare:no-torrentfile:<selection.reason>`), an explicit server error is
verbatim, and an unrecognised shape still degrades to `prepare-http-200` so a
future body change cannot look like success. Applied to both the anticipation
scheduler and upgrade-watch, which had the same duplicated logic. Terminality is
unchanged (200 retryable, 400 terminal).

### Breakdown by row

**`tt0159187` (John DeLorean) S1E2–S1E13 — provider-blocked. 12 rows.**
Every one reports `selection.reason = no-bindable-candidate`. The market has
exactly **one cached release for this show: S01E01** — which is why E1 is
`playable` and E2–E13 are not. Measured per episode: E2 has 9 candidates (2
cached, both S01E01; both E02 releases uncached); E5 and E13 have 50
candidates (2 cached, both S01E01; zero matching their episode). Bloodhound was
invoked for E5/E13 and returned 53 candidates each — no bindable representation,
because the provider has nothing cached for those episodes. The 7-day attempts
park is the correct response to a repeated market miss.

**`tt5875444` (Slow Horses) S06E04 — park-blocked, not market-blocked. 1 row.**
A current prepare run finds **48 of 50 candidates cached** and binds
(`tv-episode bound S6E4`, valid `torrentFileId`). So the representation is
obtainable today. The row cannot retry because `attempts = 6 = MAX_ATTEMPTS`,
so `classifyIntentPriority` marks it `actionable: false` and it is filtered out
of every tick. `revive()` (which resets `attempts = 0`) is only reached from a
new Seerr request for the same item, and none has arrived since the file was
cached. It will converge on the next such request.

### Why neither cluster converges unattended

`attempts` is never reset by season reconciliation (`ensureSeasonEpisode` updates
owners/expected/next_check but not attempts), so a parked row stays parked until
an external `revive`. That is the boundary, and it is a policy boundary rather
than a defect: for a genuinely uncached item, retrying is exactly what burns the
budget. It does mean an aired obligation that becomes satisfiable while parked
waits for a new request.

### Diagnostic side effect (disclosed)

A read-only probe (`persist: false`) skips the request row and the handoff, but
**not** the TorBox binding seam, so a diagnostic run created the durable
TorrentFile `tf_6445b01c-…` for Slow Horses S06E04. No Binding, handoff, or
publication was created, and no intent row was touched. Anyone repeating this
diagnosis should expect the same side effect.

### Bloodhound status: still PARTIAL

Observed: Bloodhound is invoked and supplies candidates (`live-results count=53`
for tt0159187 E5/E13). Not observed: persisted path insufficient → Bloodhound
supplies the exact authoritative representation → Binding/VFS/publication. For
tt0159187 it supplied candidates but nothing bindable resulted; for Slow Horses
S06E04 it was not invoked at all — the binding came through the normal pipeline.
Status is not upgraded.

## Deterministic library ingest (2026-10-13)

`media-search/src/lib/requests/plex-ingest.js` formalises the ingest seam so it
can be used as a product primitive:

```
validateRefreshPath → vfsDirectoryExists → waitForScanQuiet
  → requestSectionRefresh → observeScan (start+end) → waitForResultingItem
```

**Invalid-path protection (destructive mode closed).** PMS accepts *any* path
with HTTP 200 — including one that does not exist — then logs `Failed to create
parent iterator` and **`Marking media not available`**, silently taking real
media out of service. `validateRefreshPath` therefore rejects locally: relative
canonical path only, no traversal, inside the configured section root,
`Season NN` target for series, and confirmed present through HashSucker's own
VFS (`PROPFIND` 207). Proven live: a nonexistent path, a traversal attempt, an
absolute path and a non-season directory were all blocked; PMS logged **zero**
refresh requests and **zero** "not available" events.

**Single-flight is per SECTION, not per path.** The activity object carries
only `librarySectionID`, and the scan runs in-process (the only scanner child is
the later `--analyze --item <ids>` process, which never receives a path). A
second path's scan is therefore indistinguishable from ours, so the module
refuses with `INGEST_SCAN_BUSY` rather than guessing. Measured: three concurrent
ingests in one section → 1 succeeded, 2 correctly refused. Two sequential
ingests in one section → ~3.9 s total (~1–2 s each).

**Resulting-item readiness.** Measured ordering for a genuine new ingest: the
scan phase creates the item and its Part (`file` populated), then a separate
`--analyze` subprocess commits `size`/`duration`/streams/hash. The readiness
predicate is therefore **ratingKey + Part id + exact `MediaPart.file` + exact
`Part.size`** — machine-verifiable, and because `size` is committed by analysis
it doubles as an analysis-completion floor. Duration is not required for direct
play, where PMS resolves the source from the Part.

**Remaining ambiguity (honest).** Path correlation is *inferential* — sound only
while the quiescence + single-flight invariant holds, and unprovable from any
API. Separately, whether `Part.size` is populated by the scan's filesystem stat
or only by the analyzer could not be observed directly (no new publication could
be created without product mutation, and the sanctioned republish returned
`noop`), so the predicate conservatively requires `size`.

### Opportunistic deterministic confirm (integrated 2026-10-13)

The ingest seam is now integrated **additively** on the publication path.
`notifyPlex()` is not replaced: refresh coalescing, the confirmation fallback,
retry cadence and publication semantics are unchanged.

Rule: when the relevant Plex section is idle, the deterministic transaction runs
first (validate → VFS existence → quiescence → targeted refresh → observe scan
→ verify resulting item). Anything else — busy, scan start/end timeout, item not
visible, unreachable VFS — falls through to exactly today's behaviour with no
failure, no retry and no added latency. `INGEST_SCAN_BUSY` is explicitly not an
error. An invalid local path is a hard defect and is never sent to PMS.

Ordering matters and was corrected by a production drive: the confirm must run
BEFORE `notifyPlex()`, because that call queues its own refresh of the same
path and would leave the section busy, so a confirm placed after it would always
refuse and never verify. On `verified`, the second refresh is skipped as
redundant scanner work.

Episodes only — that is the geometry the seam proves. Per-section single-flight
is shared process-wide, so concurrent publications in one section refuse rather
than produce un-attributable observations. The awaited (request-path) call is
bounded to 20 s; the fire-and-forget site to 60 s.

Metrics: `plex_ingest_attempts/verified/busy/unconfirmed/invalid` counters plus
a `plex_ingest` snapshot (section, season path, scan uuid, timings, resulting
ratingKey/Part, `fileMatch`/`sizeMatch`).

**Measured in production** (Path-B republication drives; the library was fully
converged, so these were driven rather than naturally occurring):

| Attempt | Outcome | Notes |
|---|---|---|
| single, idle section | verified | scanUUID 62b314db, scan 1624ms, scan→item 23ms, rk 531 / Part 1082, fileMatch+sizeMatch true |
| single, section already scanning | busy | publication still fulfilled via the unchanged path |
| 4 concurrent, one section | 2 verified + 2 busy | all 4 fulfilled, 7 s wall, no backlog |

PMS-side cost across ~10 driven publications: 34 refreshes dispatched, **4
distinct directories walked, 0 items added, 0 "media not available" events, 0 DB
busy waits, 0 `/playQueues` 500s.** STRM projections went 145 → 150 (four
intended-restored rows), which is the publication work itself, not churn.

**Remaining blocker for full replacement** is unchanged and is path correlation:
activity attribution stays inferential, so per-section single-flight is
mandatory. Full wiring would trade an honest no-op for either a serialization
cost or an ambiguous either-way decision.

**Not yet wired.** `notifyPlex()` itself remains fire-and-forget for the case
where the seam does not verify.

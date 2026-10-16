# Build log — observed evidence only

Format per entry: date / phase-slice / status / observed changes /
verification / production evidence / unproven / artifacts / next gate.
No planned work as completed. No vague "healthy." No speculative causes.

## 2026-10-12 — VFS collection mtime scanned PMS continuously — FIXED + DEPLOYED

- Changed: `media-search/src/lib/vfs/tv-webdav.js` now derives TV collection
  mtime from the newest durable handoff `selectedAt` across the TV tree instead
  of `Date.now()`. Deployed as `3466af5` (media-search rebuilt + recreated).
- Root cause (mechanism, not correlation): the TV PROPFIND handler returned
  `modifiedAt: now()` for every `entry.type === 'collection'` while returning
  durable `state.handoff.selectedAt` for files. rclone faithfully mirrored that
  synthesized time over WebDAV, so `/mnt/hashsucker-vfs/TV/.../Season NN/` showed
  a mtime equal to the current second. PMS observed this directly:
  `WARN Directory change time at "<path>" is in the future: <now>` and
  `Last refresh (T) is older than directory change time (<now>)`, so its freshness
  check could never pass. movie-webdav already did this correctly; TV was the
  outlier. Confirmed at the source by PROPFIND: collection `getlastmodified`
  advanced 23:31:21 → 23:31:31 while files kept real times.
- Before/after (identical forced traffic: 40 WebDAV PROPFINDs + 24 PMS metadata
  lookups on a stable, unchanged directory, 5–6 min windows):
  before  2× "in the future", 4× "need to refresh", 8× "Updating Metadata";
  after   0 / 0 / 0. A further unforced 8-minute window also measured 0 across
  everything, with 0 busy-database waits and 0 `/playQueues` 500s.
- Explicit-refresh breakdown (corrected to Request lines only, so the earlier
  Request/Completed double-count is removed): the historically observed
  14-in-2-minutes was 7 real dispatches over 17 s across 2 paths
  (4× tt7137906/Season 01, 3× tt7366338/Season 01, inter-arrival 0.8–7.9 s).
  Today the whole log holds 2 dispatches for 1 path. Coalescing exists and is
  wired (`openSeasonFanOutScope` for the Seerr path, keyed debounce in
  `refresh-coalescer.js`, live `plex_refresh` metrics); the 7-call burst is
  consistent with the debounce semantics rather than a defect, so no change was
  made there.
- Dominant cause: **filesystem metadata instability**, not explicit refresh.
  Zero targeted refreshes were issued during the baseline window, yet 4
  autonomous "need to refresh" events and 8 scanner activities still occurred.
  Explicit refreshes compound it but are an order of magnitude less frequent.
- Not changed: rclone mount flags (`--dir-cache-time 60s --attr-timeout 60s`),
  because the instability was synthesized by HashSucker's WebDAV layer, not by
  rclone. Remounting would have risked active playback for no benefit.
- Verification: full VFS/WebDAV/refresh suite 81/81 pass. Post-fix production
  playback canary (E04) PASS with clean teardown, 0 leaked sessions. VFS listing
  and PMS convergence intact (both episodes listed, Media id 1085 present,
  section 3 size 17).

## 2026-10-12 — PMS session-creation failures diagnosed — LANDED

- Changed: the canary now classifies a PMS-side session-creation rejection
  separately (`PMS_SESSION_CREATE_REJECTED`) instead of collapsing it into a
  generic start failure. Diagnostic only: it changes no control behaviour and
  performs no retry or workaround.
- Root cause PROVEN for the `/playQueues` 500 `FailedToCreateSession` from the
  PMS request log: `Waited over 10 seconds for a busy database; giving up` →
  500. The lock holder is the library scanner, which runs because the rclone
  FUSE VFS reports directory change times that are always current
  (`Directory change time … is in the future`, `Last refresh … older than
  directory change time`), so PMS's freshness check never passes; HashSucker's
  own `/library/sections/3/refresh?path=` calls amplify this (14 calls in two
  minutes during the failure window, scanner actively inserting item IDs
  549/550).
- Deliberately NOT merged: the ~30 s `statusCode 0` metadata timeout. No
  matching PMS-side error was found and the same request completed normally in
  captured windows; a shared cause is plausible but unproven, so it stays a
  separate class. A regression test pins that `pmsSessionCreateRejection` does
  not fire for `statusCode 0`.
- Refuted: stale sessions/lingering playQueues as a cause. The canary already
  drains both; the failure is scanner DB contention, not prior queue state.
- Verification: `test/plex-htpc-canary-seam.test.js` 13/13. Natural
  reproduction only — 54 hybrid-canary starts in this session, 0 failures
  (the proven instance came from PMS's own log history); E04 and MobLand S02E02
  re-verified green with 0 leaked sessions.
- Not fixed: the root cause is HashSucker-side (FUSE mount mtimes, refresh
  cadence). No canary workaround, because a client-side guard would mask a
  condition real users can also hit.

## 2026-10-12 — hybrid native/app Plex HTPC playback canary — LANDED

- Changed: replaced the CDP-only playback control/observation path with a
  hybrid. New `media-search/src/lib/plex-htpc/mpv-ipc.js` (libmpv native JSON
  IPC client) and `.../plex-app.js` (minimal Plex application bridge); rewrote
  `media-search/src/scripts/dev-canary.js` (`abaffbb`).
- RE groundwork (Plex HTPC `1.71.1.346-f62ce923`, in-process libmpv 0.38.0):
  the client reads `<PLEX_USERDATA_DIR>/mpv.conf`, so `input-ipc-server`
  exposes libmpv JSON IPC with no binary patch, no injection, no CDP. The
  app's real player contract is QtWebChannel `player.*`; the canary reaches it
  through the client's JS DI container.
- Verification: new focused suite `test/plex-htpc-canary-seam.test.js`
  (10/10) covering seek-read evidence semantics, run isolation, token
  redaction, failure classification and mpv.conf idempotence.
- Production evidence: E01, E05, MobLand E02, MobLand E04 all PASS with
  identity verification (ratingKey, Part, media path, client id), progression,
  forward/backward/near-EOF seeks proven against player position, PMS
  `viewOffset` and a fresh exact-TorrentFile byte read, and app-level stop
  with confirmed PMS teardown. Control per fixture: 3 CDP evaluates, 9
  data-plane polls, 1 mpv socket.
- What the rewrite proved about the seams: mpv IPC alone is NOT sufficient —
  `loadfile` decodes bytes with no PMS session, and mpv `stop` leaves the PMS
  session alive with no application notification. Start and teardown must be
  app-level; seek/observe is honestly native.
- Unproven / still brittle:
  - two intermittent `PMS_SESSION_NOT_CREATED` failures observed at start, both
    PMS-side HTTP errors surfaced through the client: one 30 s metadata timeout
    (`statusCode: 0`), one `/playQueues` 500 (`FailedToCreateSession`). Neither
    reproduced in subsequent runs; neither characterised as latency tail versus
    defect. Documented as known failure modes rather than absorbed.
  - near-EOF seek can auto-advance into the next episode; mitigated by
    stopping every live controller, not just video.
  - PMS timeline reporting is ~10 s periodic, so seek→PMS-confirmation costs
    ~10.5 s per seek. Inherent to the client, not the canary.
  - the remaining bridge couples to the client build via one webpack module id
    (verified, with a precise failure if the build changes).
- Fixed during the slice (observed, not theorised): a session leak where the
  client advanced the play queue after the canary's stop, leaving a stale PMS
  session post-PASS. Stop is now a drain with a settle window; verified zero
  sessions immediately and after 12 s across three consecutive runs and the
  full matrix.
- Repo note: this slice's stash test collided with concurrent commits in the
  same working tree. Three conflicted files were restored to their committed
  state; the stashed work is intact in `stash@{0}`. Nothing owned by this slice
  was lost, and no concurrent work was overwritten.
- Next gate: decide whether removing the final two app-level CDP evaluates is
  worth an interposer, only if they still cost real reliability.

## 2026-09-26 — failover semantics + byte proof — LANDED

- Changed: same-object route-recovery semantics, live same-TorrentFile
  TorBox/RD byte proof (`891b8e4`, `92f3868`, `49a7452`).
- Verification: focused tests + live provider byte proof (observed).
- Production evidence: live TorBox/RD same-object failover (`49a7452`).
- Unproven: full exit-condition canary end to end.
- Next gate: Plex-part failover proof.

## 2026-09-27 — reconciliation cost — LANDED

- Changed: consumer reconciliation paging beyond 500; observation
  write-amplification audit (`ff54f62`, `12f05da`).
- Verification: focused tests + audit measurements (observed).
- Unproven: exit-condition canary.
- Next gate: enrichment triage evidence.

## 2026-09-27/28 — demand-weighted enrichment — LANDED

- Changed: enrichment triage audit, marginal-gain measurement, idle
  enrichment narrowed to unresolved demand
  (`4fbaf55`, `822d786`, `0029857`, `8c535a0`, `df8a0a3`).
- Verification: audits + measurements (observed).
- Unproven: exit-condition canary.
- Next gate: Plex playback route-failure proof.

## 2026-09-28 — Plex same-object failover — LANDED

- Changed: Plex part same-object failover proof + route-failure proof
  (`eaadb63`, `de918f1`).
- Verification: observed proofs (see commits).
- Unproven: exit-condition canary.
- Next gate: fulfillment-truth hardening.

## 2026-09-29 — fulfillment truth hardening — LANDED

- Changed: fulfillment truth + recent-release recovery (`552450b`).
- Verification: focused tests (observed).
- Unproven: exit-condition canary end to end (request → publication →
  real Plex playback → recovery, byte-verified, no manual repair).
- Next gate: ACTIVE — close the canary.

## 2026-09-30 — PMS lifecycle slice — PARTIAL / STOPPED

- Changed: no product code or live state was repaired. The playback canary
  remains a playback controller/observer; PMS disruption is not part of its
  responsibilities.
- Verification: PMS-only idle restart trials were exercised through the
  isolated CDP canary. One wrapper readiness bug classified `not-ready` as
  ready and produced a real Plex `503 FailedToCreateSession`; it was recorded,
  then the probe was corrected to require an exact readiness result.
- Production evidence: five subsequent PMS restart/replay attempts reached
  normal E01 sessions and passed ratingKey 497 / Part 1042, progression,
  forward seek, backward seek, near-EOF, exact TorrentFile reads, and clean
  stop. Durable identity snapshots before/after were unchanged: LibraryItem
  `li_e6af7605a44108916869ba81`, Binding
  `bd_5e150cc9-5620-40e5-8672-ddb91a7e4ce6`, TorrentFile
  `tf_426aa723-3dfc-427a-8cc2-3871f231ff6c`, ProviderPlacement
  `pl_691373b3-9464-4e00-9865-9ac0ccc193a1`, and the canonical VFS path.
- Startup observations: one valid run had a 73.6 s session-to-first-read
  capture. Later runs were affected by retained telemetry from earlier
  playback, so fresh first-read latency is not claimed for every attempt. A
  separate PMS restart command timed out while the service remained active;
  that attempt is not counted as a valid restart proof.
- Unproven: active PMS outage behavior and post-restart recovery; no active PMS
  restart was run after the operator stop instruction. Cross-fixture PMS
  restart checks were not run.
- Next gate: resume PMS lifecycle only with an unattended restart harness whose
  readiness and per-run telemetry baselines are exact; do not advance to client
  lifecycle from this partial result.

## 2026-09-30 — canary scope correction — RECORDED

- The Plex HTPC canary is a real consumer-path playback acceptance probe, not
  a lifecycle or chaos harness.
- Its repetition count applies to playback observations only. Service restart,
  fault injection, provider invalidation, publication recreation, failover,
  and product-state repair remain external, explicitly approved operations.
- PMS lifecycle evidence above remains partial: idle replay evidence was
  observed, active continuity/recovery was not proven, and no further PMS
  mutation is authorized by the canary slice.

## 2026-09-30 — unattended playback sentinel — OBSERVED

- Changed: added `npm run test:production-canary`, deterministic fixture
  rotation (`e01`, `e05`, `mobland`), quiet success summaries, bounded failure
  classifications/snapshots, and stage-correlation baselines that survive
  retained per-TorrentFile telemetry.
- Verification: invalid fixture probe returned
  `CANARY_HARNESS_FAILURE: INVALID_FIXTURE` without touching production state.
  After enabling the isolated canary's loopback CDP environment, the bounded
  rotation completed 3/3 playback passes. A follow-up E01 quiet run passed with
  a fresh 94 ms session-to-first-read measurement.
- Production evidence: each passing fixture completed real PMS session
  attribution, identity checks, progression, forward/backward/near-EOF seek
  handling, exact-TorrentFile evidence where backend I/O occurred, and clean
  teardown. The rotation emitted no normal per-stage chatter; abnormal latency
  remains visible in compact records and slow snapshots.
- Unproven: scheduled long-term cadence, active lifecycle recovery, and
  historical slow-tail root causes. No service fault or product-state mutation
  was induced.
- Next gate: canary is ready to operate as a modest-cadence regression
  sentinel; do not expand into chaos/lifecycle testing from this slice.

## 2026-09-30 — stale-inventory binding retry throttle — PARTIAL / BLOCKED

- Changed: `materializeVfsEntry()` now suppresses repeated authoritative
  binding activation attempts for the same library item, TorrentFile, and
  provider-file route for 30 seconds after the specific stale/unbounded
  inventory failure. Other binding failures remain immediately observable;
  successful activation clears the throttle. Added deterministic regression
  coverage for immediate replay and retry-window expiry.
- Verification: syntax check and 16 focused VFS/binding/convergence tests
  passed, including fulfillment binding idempotence and orphan VFS authority.
- Production evidence: media-search rebuilt and restarted successfully;
  data-plane, edge, and importer remained running. The immediate post-start
  log window contained zero binding activation/failure lines. Production
  smoke completed its bounded checks and emitted live byte telemetry, but its
  full verdict was not captured in the compact output.
- Canary readiness investigation: the host CDP endpoint was present on
  `127.0.0.1:9222`, and restarting only the isolated HTPC was allowed. The
  existing container invocation could not reach that loopback listener;
  host-side invocation reached the application but did not produce a clean
  three-fixture acceptance run. A temporary host-gateway experiment was
  reverted; no persistent harness/config change was kept.
- Consumer-path evidence: the exact rotation reached the native playback
  screen but failed before a real PMS session/read for all three fixtures with
  `VFS_OR_BYTE_PATH_FAILURE` and `no exact/distant reads`. A direct bounded
  MobLand VFS probe returned `206`; retained data-plane stage records show
  exact reads for all three TorrentFiles, so this run does not establish a
  product regression and does not satisfy consumer acceptance. A separate
  host attempt passed E01 and E05 before MobLand failed, but it was not the
  required clean rotation and is not promoted to a slice pass.
- Harness correction: current PMS metadata identifies MobLand S02E02 as
  ratingKey `512`, Part `1057`, with parent `510` and grandparent `509`; the
  existing fixture's `510`/`511` hierarchy was not changed because the
  resulting playback failure was not proven to be caused by that mismatch.
- Verdict: `IMPLEMENTATION_TEST_GATE = PASS`; `CONSUMER_PATH_REGRESSION =
  BLOCKED_FOR_ACCEPTANCE`; `ORIGINAL_LONG_RUN_CHURN_REPRODUCTION = UNPROVEN`;
  overall slice = `BLOCKED_FOR_ACCEPTANCE`.
- Unproven: long-run restart churn reduction under the original stale-inventory
  workload; clean real playback acceptance after this deployment; autonomous
  recovery; PMS lifecycle behavior.
- Next gate: restore a supported, clean isolated HTPC/CDP invocation path and
  rerun the exact three-fixture rotation; do not expand this slice into PMS
  lifecycle work.

## 2026-10-01 — host-only canary execution boundary and retry-throttle acceptance — CLOSED

- Changed: the production HTPC canary controller now runs only in the host
  namespace. It prepares the isolated Xvfb, audio, and HTPC services, verifies
  loopback CDP/internal navigation readiness, rejects container execution with
  an actionable `CANARY_INFRA_FAILURE`, and reads only fresh per-TorrentFile
  stage-ring records after each fixture baseline. The telemetry subprocess
  buffer was increased to retain the complete metrics response; no product
  service or HashSucker state was restarted or repaired.
- E01 proof: clean host-side run passed with expected PMS session, ratingKey
  `497`, Part `1042`, canonical path, exact TorrentFile, progression, forward
  seek, backward seek, near-EOF, clean stop, and fresh attribution. Reported
  latency was 18.751 s and session-to-first-read was 142 ms.
- Rotation proof: host-side deterministic E01/E05/MobLand rotation passed.
  E01: 18.158 s / 166 ms; E05: 28.358 s / 187 ms; MobLand: 83.927 s /
  177 ms. MobLand was marked abnormal for latency only; its identity, session,
  byte evidence, seek behavior, and teardown passed. Buffered/cache-served
  seeks were accepted without manufacturing backend reads.
- Container boundary proof: invocation through `docker compose exec
  media-search` remains unsupported and cannot control host-loopback CDP. The
  runner is host-only by design.
- Verdict: `IMPLEMENTATION_TEST_GATE = PASS`; `CONSUMER_PATH_REGRESSION =
  PASS`; `ORIGINAL_LONG_RUN_CHURN_REPRODUCTION = UNPROVEN`; overall slice =
  `CLOSED`.
- Narrow production claim: immediate replay/restart churn is bounded by the
  stale/unbounded retry suppression; long-run behavior under the original
  workload remains observational debt.

## 2026-10-01 — full technical wiki projection — PUBLISHED

- Changed: no product code. Built `wiki/` technical documentation from
  read-only inventory of Node request/discovery/ranking/provider/VFS
  paths, Rust data-plane execution, DB schemas, timers, and operator
  surfaces; published the same content to the GitHub wiki remote.
- Verification: four independent read-only subsystem inventories;
  targeted re-reads of entry points, timers, and runbook commands;
  uncertain contracts explicitly marked UNKNOWN, disagreements called
  out, no schemas invented.
- Production evidence: none applicable (documentation only).
- Unproven: wiki accuracy against future code drift; projection stays
  current only by regeneration from canonical repo docs.
- Next gate: none — wiki maintenance is on-demand regeneration, never scheduled.

## 2026-10-01 — core graduation and consumer-neutral republication slice — ACTIVE

- Graduation decision: **READY**. The core product bar is met well enough to
  stop making reliability/hardening the primary engineering lane. Observed
  request/publication/playback evidence, exact TorrentFile identity, provider
  route reacquisition, Rust/Node restart evidence, and the host-only canary
  show no current normal-path defect requiring manual repair.
- Carried debt: PMS lifecycle remains partial; the original long-run stale
  inventory workload was not reproduced after the narrow throttle; isolated
  latency tails remain observational debt. These are not current graduation
  blockers because they are either bounded, non-recurring, or outside normal
  canary ownership, and no manual intervention was required in the accepted
  request/playback/recovery proofs.
- Selected next product slice: consumer-neutral republication from retained
  exact durable truth. Product value: replacing or rebuilding a consumer
  projection should not require rediscovery, provider selection, or
  re-curation when HashSucker already owns an accepted exact TorrentFile.
- Current implementation seam: existing `searchByMedia()` reuse can republish
  exact retained truth, but it is exposed only through a general request path.
  The new narrow `/api/library/republish` route is fail-closed and delegates to
  that exact reuse predicate; focused route coverage passes for missing truth.
- Slice status: implementation started; production consumer replacement is not
  yet claimed. No provider or consumer state was mutated for this selection.

## 2026-10-01 — exact durable-truth republication — CLOSED

- Publication-loss setup: E01's VFS publication row was removed directly from
  the discovery DB using the bounded test operation. Only
  `vfs_tv_entries(media_id=tt26545992, season=1, episode=1)` was removed.
  LibraryItem, active Binding, playback handoff, TorrentFile, ProviderPlacement,
  ProviderFile, exposure, and serving coordinates were retained. No product
  repair path or rediscovery was used to create the loss condition.
- Durable truth retained: LibraryItem
  `li_e6af7605a44108916869ba81`; active Binding
  `bd_5e150cc9-5620-40e5-8672-ddb91a7e4ce6`; TorrentFile
  `tf_426aa723-3dfc-427a-8cc2-3871f231ff6c`; infoHash
  `5bf127a164dd1b06dff1d69e5508b43ef1233398`; ProviderPlacement
  `pl_691373b3-9464-4e00-9865-9ac0ccc193a1`; exact size `8660679535`.
- Republish: after deploying the committed route, `POST
  /api/library/republish` for E01 returned HTTP 200 with
  `reuseMode=republish`, `republished=true`, `selection.reason=
  reused-healthy-publication`, and `fulfilled=true`. The recreated VFS row
  used the same TorrentFile, infoHash, size, and canonical path. Binding ID,
  version, placement, provider file, and exposure remained unchanged.
- External work avoided: response reported zero discovery/ranking/availability
  work; no alternate Release or provider coordinate was selected. Durable row
  counts remained stable after reconstruction (`playback_handoffs=122`,
  `candidates=1593028`, `library_items=132`, `bindings=105`).
- Consumer result: Plex visibility returned ratingKey `497`, Part `1042`,
  path `/mnt/hashsucker-vfs/TV/tt26545992/Season 01/tt26545992 - S01E01.mkv`,
  size `8660679535`.
- Playback: existing host-only E01 canary passed after reconstruction with
  expected identity, progression, forward/backward/near-EOF seeks, exact
  TorrentFile evidence, and clean teardown. Total latency `19.527 s`; session-
  to-first-read `257 ms`. No manual product-state repair occurred.
- Negative path: republishing `tt_missing_republish` returned HTTP 409 with
  `exact durable publication is not reusable; explicit media request required`.
  No publication was fabricated and no rediscovery/reselection was invoked.
- Product value: **KEEP**, narrowly classified as an earned exact durable-truth
  continuity primitive. This proves consumer projection reconstruction for the
  existing Plex-backed publication path; it does not prove arbitrary consumer
  replacement or a general consumer-neutral framework.

## 2026-10-01 — N1 accepted representation memory — ACTIVE / GO

- Baseline instrumentation: request results now expose bounded `requestWork`
  fields for reuse, discovery, ranking, candidate counts, selected infoHash,
  selected TorrentFile, source, and latency. Existing evidence-query rows also
  record `healthy_exact_reuse` versus `ranked_request` dispositions where the
  path reaches those boundaries. No ranking or selection behavior changed.
- Baseline history: 483 recent `media_requests` were sampled across 176 media
  identities. There were 307 repeated request decisions and 190 adjacent
  same-infoHash outcomes; 37 adjacent outcomes retained the same known exact
  selected size. Source mix was 126 anticipation, 7 upgrade-watch, 190 Seerr,
  77 API, and remaining historical/test/audit sources. The denominator is
  imperfect because older rows lack uniform source metadata and selected
  TorrentFile IDs; the result is sufficient to show repeated decisions beyond
  healthy reuse, but not sufficient to claim household-only frequency.
- Decision gate: **GO**, narrowly. Repeated same-release decisions exist in
  ordinary Seerr/API traffic, while exact reuse does not cover every recorded
  repeat. The fact is initially observational; no ranking behavior is changed.
- Minimal fact: added control-plane `accepted_torrent_files`, keyed by exact
  `library_item_id + torrent_file_id`, storing source, reason, observed time,
  and bounded evidence. It is exact-object scoped and contains no provider,
  route, compatibility, confidence, or TTL state.
- Write trigger: the existing PMS active-session polling path now maps the
  session's exact Part path, requires positive `viewOffset/duration` progress,
  resolves the LibraryItem's active Binding, and records that Binding's exact
  TorrentFile. Publication visibility alone no longer writes the fact.
- Read path: control-plane store exposes deterministic exact-item reads and
  ordered accepted-fact listing. No selection/ranking consumer exists yet.
- Verification: 4 focused tests passed, including exact identity,
  idempotent update, deterministic read, request-work instrumentation, and
  existing republication fail-closed coverage.
- Production write: an earlier deployment wrote fact id `1` from publication
  confirmation; that path was then removed as semantically too weak. The
  committed N1 correction no longer permits publication-only writes. A fresh
  post-correction accepted-fact write still requires an observed PMS session
  with positive progress and exact Part-path correlation; it is pending the
  next normal playback-observation polling tick.
- Production playback: the prior deployed N1 E01 canary passed (`PASS`,
  48.434 s, session-to-first-read 138 ms). The fresh observer-fix E01 canary
  passed (`PASS`, 21.034 s, session-to-first-read 349 ms) and an active PMS
  observation captured ratingKey `497`, Part `1042`, viewOffset `300000`,
  duration `3388640`, and the exact expected VFS Part path. The bounded poller
  is now 10 seconds (startup delay 5 seconds), but the service log/row check
  did not capture a post-correction durable update before teardown; no fresh
  accepted-row claim is made from this run.
- Observation mechanism: bounded hybrid-style polling reuses the existing
  read-only `/status/sessions` seam, runs only when published active bindings
  exist, and requires positive progress plus exact publication/Binding/TorrentFile
  correlation. It adds no webhook or event subsystem and no 1-second loop.

## 2026-10-13 — requested-season preparation failures diagnosed — LANDED

- Changed: `prepare-http-200` no longer hides application-level failures.
  `src/lib/requests/prepare-failure.js` (`describePrepareFailure`) reports the
  body's own reason; applied to the anticipation scheduler and upgrade-watch,
  which had duplicated logic. Commit `f32e3a6`.
- Root cause of the OPAQUITY (shared by both clusters, 13 rows): the scheduler's
  error branch treated three distinct conditions as one — no handoff
  (`selection.selected == null`), handoff without `torrentFileId`, and non-200
  transport. HTTP 200 is returned for the first two, which are market outcomes.
- Root cause of the FAILURES differs per cluster:
  - `tt0159187` S1E2–S1E13 (12 rows): `no-bindable-candidate`. The provider has
    exactly one cached release for this show — S01E01 (hence E1 is playable).
    Measured: E2 has 9 candidates (2 cached, both S01E01); E5/E13 have 50
    candidates (2 cached, both S01E01, zero matching their episode). Bloodhound
    ran for E5/E13 (53 candidates) and could not make it bindable. Provider
    boundary, not a HashSucker defect.
  - `tt5875444` S06E04 (1 row): `candidate-not-fulfillable`, `attempts = 6 =
    MAX_ATTEMPTS` → not actionable, never retried. A current prepare finds 48/50
    candidates cached and binds successfully, so this is blocked by the attempts
    park, not the market.
- Neither converges unattended because `attempts` is not reset by season
    reconciliation; `revive()` (attempts=0) is only reached from a new Seerr
    request for the same item.
- Bloodhound: remains PARTIAL. Observed it runs and supplies candidates; not
  observed the full persisted-insufficient → authoritative-representation →
  Binding/VFS/publication chain.
- No rows repaired, no DB edits, no provider failover, no service restarts.
  Disclosed side effect: a `persist:false` diagnostic still runs the TorBox
  binding seam and created durable TorrentFile `tf_6445b01c` for Slow Horses
  S06E04 (no Binding/handoff/publication).
- Verification: 7 new label tests; full suite 3197 pass / 12 fail — byte-identical
  failure set before and after, verified by diff.

## 2026-10-13 — cold retry for exhausted season-owned aired obligations — LANDED

- Changed: `isColdRetryEligible()` in `src/lib/anticipation/scheduler.js`
  (`ecf7419`); exhausted re-arm now due immediately instead of parked out.
- Old: `attempts >= MAX_ATTEMPTS` was permanently non-actionable, and the
  existing re-arm path was unreachable dead code. Result: an aired requested-
  season obligation whose market became satisfiable could only be revived by a
  new Seerr request.
- New: four gates (failed, exhausted, continuing season owner, retryable market
  defer reason + cold park elapsed). One-shot rows and non-retryable reasons
  keep the old permanent semantics.
- Cadence: existing PARKED_MS (7 days), one interval only.
- Production evidence: Slow Horses S06E04 went failed(attempts=6, parked) →
  cold re-arm (attempts 6→7) → prepared (9.3s) → playable (13.4s), prewarm
  17/17 ranges, handoff `tv-episode bound S6E4` provider torbox/cached,
  TorrentFile tf_6445b01c + one Binding, VFS entry + library path active.
  No manual attempts reset, no new Seerr request, no service restart.
- Negative control: tt0159187 E05/E06/E07 re-parked at exactly 168.0h (7 days)
  with `prepare:no-handoff:no-bindable-candidate`.
- Scheduler cost: 13-row cold cycle = 2 re-arm ticks (16–27 ms) + bounded
  attempts (9–16 s each); P0/P1 work interleaves, no starvation.
- Verification: 12 new tests (test/cold-retry-season-owned.test.js) incl.
  restart durability and future-obligation non-interference; updated one
  existing test that had pinned the old unreachable semantics. Full suite
  3211 pass / 10 fail — identical pre-existing set.

## 2026-10-13 — cached-only fulfillment boundary proven; no-bindable reason surfaced — LANDED

- Changed: `/api/media-prepare` now returns `skippedCandidates` (rank, infoHash,
  torboxState, per-candidate reject reason) on the two no-handoff return sites.
  Additive and read-only; no selection or binding change.
- Root finding: `no-bindable-candidate` is NOT purely a market miss. For
  tt0159187 E02, Real-Debrid accepted the magnet and reported `queued`
  (`rd-not-dached:rd-not-downloaded:queued`), and the ensure then DELETED the
  resource because "not yet downloaded" is treated as "not cached".
- Design boundary proven, three independent modules:
  - torbox-file-identity.js B.2 "addOnlyIfCached ... we NEVER initiate an
    uncached download" (all 4 call sites pass true)
  - realdebrid/ensure.js "EVERY probe resource ... that does not prove
    immediately-usable cached state is deleted"
  - second-placement.js "never an uncached addMagnet"
- State-machine gap: provider_placements.state vocabulary is only ready/removed
  (286/1 live); no queued/downloading. download_requests models byte staging from
  an already-resolved TorrentFile, not provider acquisition.
- tt0159187 E05/E13 differ: ranked candidates are season packs, RD refuses them
  (`rd-add-failed:hard`) — those are genuine market misses.
- Deliberately NOT implemented: an acquisition state machine. It would be a new
  fulfillment stage with no placement/obligation state and no polling consumer to
  support it.
- Bloodhound status: unchanged, still PARTIAL. It supplies candidates (53 for
  E05/E13) but no authoritative representation; the blocker is the cached-only
  boundary, not Bloodhound candidate supply.
- Verification: full suite 3211 pass / 10 fail — identical pre-existing set.

## 2026-10-13 — refactor: consolidated contracts, truthful failure reasons — LANDED

- Commit `b0f771f`. Four changes, no policy change:
  - `src/lib/plex/vfs-path.js` is now the single authority for the
    VFS->Plex mount path and the authoritative-part comparison. The
    anticipation scheduler's synthesised `.mp4` fallback was removed: 0/6
    authoritative paths end in .mp4 at the guessed location, and the branch
    was unreachable (every prepared/publicated_preparing/playable series row
    carries a canonical path; the one exception is a movie with no S/E).
  - `src/lib/requests/prepare-outcome.js` owns one prepare/publish result
    contract shared by the anticipation scheduler and upgrade-watch, which each
    had their own copy.
  - selection.js PATH B no longer reports `INVALID_COORDINATES` when the TorBox
    placement ensure fails (the resolver was being handed `undefined`); the
    placement failure is now the terminal candidate reason. Live before/after
    for tt0159187 E02 confirms one spurious reason removed.
  - `resolveTvTorrentFile` classifies an empty list as EPISODE_NOT_FOUND, not an
    input error.
- Also removed: `resetPlexRefreshAccount` (zero callers, grep-proven); a
  repeated identical vfs_tv_entries read inside the Plex confirmation retry
  loop.
- The nominal 30 s per-tick work cap is documented as between-actions rather
  than an absolute deadline (one ~17 s provider prepare can exceed it).
- Measurements: Tier-A idempotent request 27.0 ms before, 25.4-27.5 ms after
  (unchanged); future_intents.due() 0.04 ms (no index/projection work
  justified). Full suite 3219 pass / 10 fail, identical pre-existing set.
- Production validation: scheduler cold-retry, priority classes, and P0
  confirmation all behaving as before; scheduler drain, cold-retry classification (cold=true), and 23 ms P0 retries all observed unchanged.

## 2026-10-14 — architecture cleanup: decomposed the request pipeline — LANDED

- Commits `00e2821`, `4a5c0e0`, `b05642b`, `afbd6ea`, `cf385de`, `4df9c1b`.
- `src/lib/requests/publication.js` is the single owner of the handoff →
  published-item tail (VFS materialization → converged .strm → Jellyfin →
  hydration → Plex dispatch). Both call sites (request path, prepared replay)
  share it; only consumer dispatch differs, and only deliberately.
- `src/api/media-request-stages.js` owns every pipeline stage plus the response
  shapes; `searchByMedia()` reads as the nine-stage product sequence over the
  live/corpus pipelines. media-request.js: 2337 → 951 lines.
- Seerr ingress (`src/api/seerr-ingress.js`), transport primitives
  (`src/server/http.js`), media byte delivery (`src/server/media-delivery.js`),
  route helpers (`src/server/route-helpers.js`), request-scoped provider seams
  (`src/lib/requests/provider-ensure.js`), and Plex section geometry
  (`src/lib/plex/section-config.js`) each moved to their owner. app.js:
  4682 → 3375 lines.
- `src/server/index.js` is now the composition root (107 lines);
  `src/server/workers.js` owns every background ticker.
- Regressions found and fixed during runtime validation:
  - the fresh-publication episode ingest confirm referenced an out-of-scope
    `isEpisode` inside a fire-and-forget chain, so it never ran (swallowed by
    its own .catch()). Episode geometry is now computed once and passed
    explicitly.
  - the orphaned-VFS cleanup after a failed binding activation referenced a
    `searchCache` parameter it never received — every invocation threw a
    swallowed ReferenceError, leaving unbound episode rows consumer-visible.
    Both have regression tests.
- Quieted a per-function `activateBinding attempt` log line (~154/6 min in
  production); failure diagnostics unchanged.
- Measurements: Tier-A idempotent episode request 27.0 ms before, 26.3–31.5 ms
  after (reuse=noop, fulfilled=True, Plex-confirmed); Tier-A movie noop 5–6 ms.
  Full suite 3241 tests / 3226 pass / 10 fail — identical pre-existing set.

## 2026-10-14 — product-gap closure: scheduler wake semantics and Bloodhound completion — LANDED

- Commits `e4a5b0e`. Resolves the entire known-failing test set (was 10
  failures) and closes four real product gaps the failing tests exposed:
  1. **Future intents wait cheaply.** An anticipated `future-not-released`
     row outside its prepare window now has its poll parked at the window
     open instead of being re-classified and re-listed in the due snapshot
     on every interval until it can act.
  2. **The prepare window is reachable.** Priority classification treated any
     `future-not-released` row as non-actionable until its air date, so
     `prepareDays` could never start preparation early. Inside the window the
     row ranks with released work of the same class.
  3. **Release wake is reachable.** A failed `future-not-released` row whose
     `expected_at` has passed is actionable (P2, `releasedWake`), so the
     scheduler clears the pre-release classification and grants exactly one
     further attempt. The store already surfaced such rows as due; the
     classifier parked them, so the wake logic was dead code.
  4. **Bloodhound completes for corpus-sourced requests.** The corpus
     pipeline had no live re-entry after exact binding failed, so a request
     whose persisted rows were identity-valid but unbindable never consulted
     the live market. It now performs the same bounded, one-fanout re-entry
     as the live pipeline (gated on unreleased media and on not having
     already consulted live in this attempt) and reports what each route
     answered. Production evidence: `tt0159187` S1E2 now logs
     `bloodhound trigger ... reason=no-bindable-candidate` and answers with
     the typed provider reasons `TorBox placement failed`,
     `rd-not-cached:rd-not-downloaded:queued`, `no-bindable-path` — a
     provider-pending miss is now visually distinct from a market miss.
- searchByMedia honors the release gate: requests carrying an authoritative
  release/air date never run live discovery or Bloodhound while unreleased;
  an explicit `liveOnly` request is an operator override and still works.
- Two test seams are now real (and were silently ignored before, so the
  acceptance and Bloodhound suites proved nothing): `request.liveDiscoveryFn`
  and `request.confirmPlexFn`. Both default to the production implementation.
- Stale tests rewritten around the current contract and driven through the
  real entry path (tickOnce / the request API), including the prepared
  republish contract: reuse performs no binding work; the bounded route
  refresh that re-proves freshness for the authoritative Binding guard is
  counted separately.
- New coverage: `test/plex-scanner-pressure.test.js` (collection mtime is
  durable and stable across repeated PROPFINDs — the scanner-churn root
  cause), `test/cache-only-boundary.test.js` (uncached creates no acquisition
  state; provider-pending vs market-miss reasons; RD queued not bindable).
- Final counts: **3257 tests / 3252 pass / 0 fail / 5 skipped / 0 todo.**
  The five skips are explicit and reasoned (external fixtures unavailable,
  two documented "unbuilt" behaviors, one live-credential test, one opt-in
  benchmark) — no hidden known-failing baseline remains.

## 2026-10-15 — playback drove uncached RD acquisition AND masked rotted routes — FIXED (recovery slice: 0 repairs needed)

- Changed: `media-search/src/lib/providers/realdebrid/resolve.js`
  (`attemptRdResolution`) now gates every resolution behind a cache-only
  probe: a read-only exact-hash `listTorrents` lookup. Not-cached returns
  `skipped/rd-not-cached` (counter `realdebrid_not_cached_skipped`), an
  unanswerable probe fails closed with `RD_CACHE_PROBE_FAILED`, and a
  confirmed route is reused with `addMagnet` never called and no
  `deleteTorrent` of the reused id.
- Root cause (mechanism): the resolver called `addMagnet()`
  unconditionally, then `deleteTorrent()` in `finally`. Two defects from one
  behaviour: (a) playback silently started RD downloads for titles TorBox no
  longer had cached — the cache-only boundary had no enforcement point in the
  resolver; (b) the resolver "succeeded" via that download, so a stale
  durable ProviderPlacement was never the failure that surfaced it, and the
  control plane kept reporting routes that no longer exist.
- Recovery slice: `media-search/src/lib/control-plane/route-reconciler.js`
  (new) plus `route-providers.js` (new) — one construction of the TorBox/RD
  cache-only surfaces shared by the request handler and the background
  reconciler. The reconciler only ever asks the existing second-placement
  ensurer with `discoverOnly: true`; it never acquires, never changes
  Release/TorrentFile identity, and never demotes a placement because one
  probe failed. Wired as a bounded worker
  (`ROUTE_RECONCILE_ENABLED` default 1, every 6 h, batch 25, first pass
  after 10 min).
- Staleness criterion is live, not assumed: `findStaleRouteTorrentFiles` is
  the durable-only criterion (shares `presentProviders()`'s blind spot), and
  `findRottedRouteTorrentFiles` verifies each recorded route with
  cache-only reads (one batched TorBox `checkcached`, one RD `torrents`
  list). An unanswerable probe defers the TorrentFile rather than declaring
  rot.
- Production evidence (live control plane, 2026-10-15):
  - 123 active-bound TorrentFiles; 123 have a recorded route; 0 do not.
  - all 123 recorded TorBox routes resolve in the live mylist and
    `checkcached` reports every hash still cached → live-verified usable 123,
    rotted 0.
  - 3 TorrentFiles also carry a Real-Debrid route; 1 of those (hash
    `09e83cef…`, rid `M4Q7D3JF7PUDI`) is absent from the RD account, and
    that same TorrentFile already has a live TorBox route (rid `96107317`),
    so no title is unserviceable.
  - One bounded pass through the deployed worker path:
    `{scanned: 0, repaired: 0, unavailable: 0, failed: 0}`.
- This corrects the earlier working hypothesis for this slice, which
  reported ~100 rotted TorBox placements and ~98 TorrentFiles with no
  cached route anywhere. Measured against live provider state the true
  numbers are 0 rotted and 0 unserviceable: the earlier classification did
  not verify route ids/hashes against live provider truth, so it counted
  healthy inventory as stale. The cache-only resolver gate is therefore the
  user-visible fix from this slice; the reconciler is the standing guard for
  the rot case, not a repair that had work to do today.
- Verification: Node suite 3309 tests / 3306 pass / 0 fail / 3 documented
  skips. The three previously-failing `test/rd-filename-filter.test.js`
  integration tests asserted the removed behaviour (`addMagnet` on every
  resolution) and now assert the cache-only contract; the code-35
  infringing observation is still persisted, but reached by reading a cached
  route instead of creating a download. `test/route-reconciler.test.js`
  (13 tests) covers: usable route never probed, no-route is a candidate,
  removed placement not usable, alternate-cached repair for the same
  TorrentFile with Binding unchanged, no fake placement on a miss,
  representation mismatch is not a repair, probe error never demotes,
  bounded passes, live verification (incl. provider-side rot and
  unanswerable probes), and RD-rotted/TorBox-live recovery.
- Rust suite unchanged from `c760d40` (153 + 14 + 7 green, docker
  toolchain).
- Unproven: no title was actually repaired in production, because no
  recorded route was rotted. The reconciler's repair path is proven by test
  (T4, T12) and by one live pass that found no work, not by a live repair.
- Artifacts: `media-search/scripts/live-route-reconcile.mjs` reproduces the
  classification and runs one bounded pass.

## 2026-10-16 — same-TorrentFile alternate-route recovery proven; worker bug fixed; live CDN blocked

**Recovery path (measured, not assumed).** `/bytes/:tfId` (Jellyfin) and the
VFS path both forward to Rust `/files/:tfId`, which re-reads S-1 control truth
per request but caches the per-TorrentFile route inventory for the process
lifetime. So:

- route selection across same-TorrentFile placements is Rust's own
  (`CapabilityManager::acquire_for_read` slot order + the reactive
  one-way lane switch in `ResilientRangeReader::try_failover`);
- Node never sees a failed route, so there is nothing to fight: request-time
  recovery cannot duplicate a provider probe and the 6 h reconciliation worker
  is cache-only control reads plus discover-only lookups;
- a placement Rust did not know about is adopted only through the prewarm
  endpoint's `refresh_slots` (or a restart) — there is no TTL and no push
  signal from Node;
- request-scoped `x-hashsucker-serving-provider` is a snapshot of the
  capability the demand initially selected and is deliberately not rewritten
  by a failover, so which route DELIVERED the bytes is proven by origin
  counters, not by that header;
- Node's class-D path switches to a DIFFERENT durable TorrentFile (Plex VFS
  only); `/bytes/:tfId` has no such fallback and surfaces the classified
  failure instead. Same-TorrentFile recovery is Rust's, by design.

Changed:
- `data-plane/tests/same_tf_route_recovery.rs` (new, 10 tests): real serve-layer
  HTTP over two exact routes with injectable provider faults — 404 (dead cap +
  failover), 5xx (throttle + breaker, never dead), 429 (zero provider-control
  calls), real headerless timeout, malformed 206/truncated payload, total
  exhaustion (502 or a visibly truncated stream, always a correct prefix,
  nothing published), coalesced recovery (one pull on the surviving route for
  three concurrent readers, no duplicate full-file provider work),
  refresh-adoption of a placement discovered after startup (zero API calls,
  same TorrentFile), and restart (durable chunks survive, route set rebuilt).
- `media-search/src/lib/control-plane/route-reconciler.js`: live verification is
  now shared by the rotted-route finder and a new bounded retirement pass,
  `retireVerifiedDeadRedundantRoutes`. Retirement fires only for durable
  provider-truth (the exact hash is confirmed absent) AND only when the same
  TorrentFile has another live route. An unanswerable probe is UNKNOWN and
  never retires. Idempotent.
- `media-search/src/server/workers.js`: the reconciliation pass is now a
  single-flight runner owned by one function and exposed on the workers handle
  (`runRouteReconcilePass`, `routeReconcileInFlight`), so the periodic tick and
  any manual pass share one in-flight pass. **Bug fixed: the previous wiring
  called a pass function that referenced worker-local variables from module
  scope, so every tick threw `ReferenceError` and was swallowed by the timer's
  catch — the worker logged `armed` and never ran a pass.**
- `media-search/src/lib/control-plane/route-providers.js`: `checkCached` is now
  injectable (test seam only; production still uses the real provider call).

Verification: Node 3317 tests / 3314 pass / 0 fail / 3 skips; Rust 153 + 14 +
10 + 7 all green. Live proof on this deployment after deploying the fix:
`route reconcile scanned=0 repaired=0 unavailable=0 failed=0 retired=1`, and the
retired placement is the redundant RD route (`M4Q7D3JF7PUDI`, hash
`09e83cef…`) whose TorBox sibling (`96107317`) is live — the TorrentFile now has
exactly one usable route and is still servable.

Blocked, not proven (environment): the live Jellyfin byte-route measurement
cannot complete because the TorBox CDN host resets TLS from this deployment
(`nexus.erth.tb-cdn.earth:443` → connection reset by peer; a fresh requestdl
URL returns quickly and `checkcached` still reports the hash cached). The
data-plane therefore answers `206` with the correct `content-length` and then
truncates the body (`recovery.client_truncated` +1, `chunk_fills_failed` +1),
which is the harness's documented exhaustion shape, not a new defect. A
data-plane restart clears a stale in-memory capability pool (acquisition
17.5 s → 252 ms) but the CDN read still fails, so the block is network-side.

Pre-existing, unrelated to this slice: `/vfs/Movies` PROPFIND returns 503
`HANDOFF_MISSING` for `tt1630029` because its VFS row names release key
`01981d99…:0` while its only playback handoff is `07309290…:torrent`
(rows date to 2026-09-11), and one divergent row fails the whole collection
listing.

## 2026-10-16 — VFS handoff-supersede divergence repaired; TorBox CDN SNI boundary isolated

**VFS divergence — root cause.** `playback_handoffs` has a UNIQUE index on
`(media_type, media_id, season, episode)`, and its upsert's `WHERE` clause
deliberately fires when both rows are authoritative but their
`torrent_file_id` differs. A new request that selects a DIFFERENT authoritative
TorrentFile therefore **overwrites the published release's handoff in place**.
The Binding and the VFS row keep naming the old release, whose handoff no
longer exists, and the read path resolved runtime identity from
`getPlaybackHandoffByReleaseKey(mediaId, releaseKey)` → `HANDOFF_MISSING`.

**Blast radius (measured, `scripts/scan-vfs-divergence.mjs`):** 26 movie rows
+ 3 TV rows where the published release's handoff was superseded; 29 handoffs
whose release differs from the active Binding; 1 row with `:0` vs `:torrent`
notation drift (same hash, same TorrentFile); 5 rows with no active Binding
(they keep working through their handoff). One divergent row failed the whole
`/vfs/Movies` listing, so the visible blast radius was the entire Movies
collection. Nothing is a migration/orphan-cleanup artifact: it is the
handoff slot being single-row-per-media while publication is durable
per-release.

**Fix — Binding authority wins** (`src/lib/vfs/binding-authority.js`, new).
When the handoff for the published release is gone, the runtime identity is
rebuilt from the active Binding and its TorrentFile (control plane = durable
truth). Nothing is selected, no discovery runs, the Binding is never changed to
satisfy the VFS, and no handoff row is written. A handoff that belongs to a
different release is not this entry's handoff (the TV path's historical check,
now applied to both surfaces). Isolated + reported, never served, when neither
a handoff nor an authoritative Binding backs a row.

**Live proof:** `/vfs/Movies` and `/vfs/TV` PROPFIND → **207** (67 rows / 66
movie titles; 22 TV responses). `tt1630029` — the title that failed — resolves
through its authoritative Binding (`via=recovered`) and is listed. 28 entries
were recovered from Binding authority in the measured window; **0 isolated**.

**TorBox CDN boundary — isolated by SNI, not by network or client.** From the
same container: TCP connect to `nexus.erth.tb-cdn.earth:443` succeeds, then the
handshake is reset immediately after the ClientHello (`write:errno=104`, "read
0 bytes"). The decisive test: the SAME IP with SNI `api.torbox.app` completes
the handshake and returns `CN=torbox.app`; with the TorBox CDN SNI it resets.
Other HTTPS hosts from the same containers succeed. `checkcached`/`requestdl`
(and RD's whole surface) are healthy. curl, wget, openssl and the Rust client
fail identically → treated as network/provider-edge. No retries added.

**Live cached bytes from a healthy route (Real-Debrid).** RD's CDN is reachable
from this deployment (206/100 bytes, 0.6 s).
- Jellyfin: `GET /stream/movie/tt1825683` with `STREAM_BYTE_ROUTE=cached` →
  307 `location: /bytes/tf_5de34a78…` with `x-hashsucker-byte-route: data-plane`,
  `x-availability-source: authoritative-binding`, **`x-provider-check-occurred:
  false`**; following it returns 206 with bytes byte-identical to the provider
  CDN.
- Plex: `/vfs/Movies/Black Panther (2018)/….mkv` range read → 206, 100 bytes,
  byte-identical to the provider CDN.
- Same-file concurrency: 3 concurrent readers of one fresh chunk → all
  206/100000, identical bytes, and exactly **ONE 8 MB upstream pull**
  (`chunk_fills +1`, `bytes_upstream +8388608`), zero truncations, zero
  failovers.

Verification: Node 3326 tests / 3323 pass / 0 fail / 3 skips
(`test/vfs-binding-authority.test.js` B1–B6, `test/vfs-collection-resilience.test.js`
C1–C5). Rust unchanged (184 green).

Pre-existing and unchanged by this slice: the legacy `/stream` resolver path
(provider mode) 404s with `FILE_NOT_FOUND` for `:torrent`-style handoffs and
502s `TORBOX_REQUESTDL_FAILED` where the CDN can't be validated; neither path
was touched here (`torbox-delivery.js` is untouched by every commit in this
slice).

## 2026-10-16 — request → playable responsiveness on a broken provider route — FIXED + DEPLOYED

Slice: end-to-end request → playable responsiveness (The Lowdown S01/S02 as
the live acceptance case). Commits `d9f647e` (data-plane), `3e1855b`
(scheduler), `2141315` (observability).

### Before timeline — The Lowdown (`tt31289994`), production evidence

16 episode obligations (S01 E1–E8 + S02 E1–E8). Aired/eligible = **10**
(S01 E1–E8 + S02 E1–E2); S02 E3–E8 are `future-not-released`
(expected_at 2026-10-21 … 2026-11-25, after the 2026-10-16 request).

S01 (all 8 aired), timestamps UTC:

| ep | request (intent) | published (library_paths) | Plex ratingKey added |
|---|---|---|---|
| E1 | 06:24:03 | 06:24:10.050 | 06:24:54 (rk 571) |
| E2 | 06:24:10 | 06:24:18.979 | — |
| E3 | 06:24:19 | 06:24:24.369 | — |
| E4 | 06:24:24 | 06:24:29.732 | — |
| E5 | 06:24:29 | 06:24:35.527 | — |
| E6 | 06:24:35 | 06:24:41.029 | — |
| E7 | 06:24:41 | 06:24:46.404 | — |
| E8 | 06:24:46 | 06:24:51.810 | — |

`[Plex] partial-refresh dispatch section=3 path=…/Season 01` at **06:24:51.862**;
PMS created show 569 + season 570 + episode 571 at **06:24:54**.

S02: S02E1 requested 06:27:39 → published 06:27:58; S02E2 requested 06:27:58 →
published 06:28:11. S02E3–E8 never published (no aired episode-scoped candidate).

**The failure:** request → published was fast (E1 in 7 s, all 8 in 48 s), and
Plex indexed E1 in 3 s. Then PMS never indexed E2–E8 and never became playable.
For **5+ hours** PMS held exactly one episode (`allLeaves size=1`) and one
activity `library.update.item.metadata / "Updating Metadata" / "The Lowdown S01
E01" / progress 49`, with `Plex Media Scanner --match/--analyze --item 571`
stuck in **D (uninterruptible I/O)** state. Root cause chain (mechanism, not
correlation):

1. Every Lowdown TorrentFile is **TorBox-only** (10/10 placements; 0 RD).
2. TorBox's CDN is unreachable from this deployment — `requestdl` returns 200
   with host `nexus.erth.tb-cdn.earth`, then the CDN resets immediately after
   ClientHello (`ECONNRESET`, ~36 ms, 5/5 probes; Node `fetch` cause
   `ECONNRESET`). External, SNI-specific, unchanged from the 10-12 entry.
3. The Rust reader treated a **connection-level `send()` error** as a generic
   transient and paid `RECOVERY_BACKOFF_DEFAULT` (30 s) × 3 ≈ **90 s** before
   surfacing any failure (measured: data-plane range read 73.6 s, then 90.4 s;
   Node client aborted at 25 s with no response). The VFS then hung on the
   forward (`streamFromDataPlane` has no timeout).
4. rclone (`webdav-local:` mount, `--low-level-retries` default) retried the
   resulting 5xx; FFMPEG/PMS retried the read. The first file read never
   returned in bounded time, so **the scanner blocked on E1 and never reached
   E2–E8** — the whole season stayed invisible. Nothing was playable.
5. The same ~90 s broken-route read also wedged the anticipation scheduler: a
   single speculative P0 row (`future_intents` 98 = MobLand S02E05,
   `published_preparing`, `byte-probe-pending`) re-ran the full request path
   for **~60–125 s every tick**. With `MAX_TICK_WORK_MS = 30 s` checked after
   the first action, `stopReason=wall-clock-cap` ended the tick after **one**
   action, so a due requested-season row behind it stayed unprocessed for ~6 h
   (Lowdown `plex-absence-reconcile` intents 138–145 were due from 06:24:53 but
   only ran at **12:33:20**).

### Changes

- `data-plane/src/transport.rs` (`d9f647e`): a `send()` error is a
  transport-level failure with no provider HTTP status, so it carries no
  provider-load signal. Both headerless sub-cases (timeout, connection failure)
  now use the same **zero-cooldown bounded** same-cap budget with same-TF
  failover first, instead of the 30 s × 3 load backoff. HTTP 429/5xx keep the
  load backoff. Renamed `apply_transient_headerless_timeout` →
  `apply_transient_headerless(path)`.
- `media-search/src/lib/anticipation/scheduler.js` (`3e1855b`): both wall-clock
  checks now honour a `MIN_ACTIONS_PER_TICK = 4` floor (still hard-bounded by
  `MAX_ACTIONS_PER_TICK = 8`), so one slow row cannot starve the due set.
- `media-search/src/api/seerr-ingress.js` (`3e1855b`): an accepted TV fan-out
  now nudges the EXISTING anticipation scheduler (`schedulingNudge`) instead of
  waiting for the generic 15-minute interval.
- `media-search/src/api/seerr-ingress.js` (`2141315`): one concise
  `episode-trace` line per fan-out child (`media | sNeM | source | stage |
  stage_ms | candidates | defer_reason | result`).

### After — production evidence

- **Byte path fails fast.** WebDAV reads of Lowdown: S01E01 502 / **0.29 s**,
  S01E03 502 / 0.58 s, S01E05 0.15 s, S01E08 0.14 s, S02E01 0.59 s, S02E02
  0.14 s (was: no response ≥ 25 s, data-plane 73–90 s). Data-plane direct read
  180 ms–1.5 s. No multi-minute silence; the failure is an explicit 502.
- **Plex ingest unblocked.** The stuck D-state scanner processes exited once
  reads failed fast. A targeted refresh of the same path HashSucker dispatches
  (`/library/sections/3/refresh?path=…/Season 01`) then indexed **all 8 S01
  episodes** (E2 at +70 s, E8 by ~10 min; Plex's own per-item metadata-agent
  pacing, not HashSucker). S02 refresh indexed S02E1 + S02E2. Plex now holds
  **10/10 aired episodes**, each with ratingKey + Part + exact `MediaPart.file`
  + exact size matching the Binding (earliest usable boundary satisfied).
- **Scheduler anti-starvation, production-proven.** The 15:50:28 drain tick on
  the deployed build ran `scheduler drain actions=4 stopReason=wall-clock-cap
  durationMs=141648` — intent 98 (MobLand S02E05) then Lowdown S01E01/E02/E03
  (future-intent 138/139/140) in the SAME tick. Before the fix the same tick
  shape ran `actions=1` and stopped after the first ~60 s row. Intent 98's own
  action time also fell ~62 s → ~30 s (the byte-probe read no longer pays the
  transport backoff). Also pinned by test
  (`test/anticipation.test.js` "one slow action cannot starve the rest of the
  due set": 1 → 4 actions); `seerr-tv-handler` asserts exactly one nudge per
  accepted fan-out. Rust: `cargo test` 153 + 14 + 11 + 7 green, including new
  `r7_connection_failure_fails_fast` (closed-port route surfaces an honest
  failure in < 5 s; was ~90 s). Node: 46 anticipation + 100 seerr + 147
  scheduler/ingress tests green.

### Product metrics (The Lowdown, cache-only policy)

- request → first aired episode playable: **never** (byte route is the external
  TorBox CDN blocker; 0 playable).
- request → 50% / all satisfiable playable: **0** — identical root cause.
- request → first aired episode **visible** (ratingKey + Part + exact path +
  size): E1 **51 s** (06:24:03 → 06:24:54).
- request → all 10 aired **visible**: blocked indefinitely before the fix
  (1/10 for 5+ h); after the fix all 10 index as fast as PMS paces the scan
  (S01 8/8 in ~10 min from a targeted refresh).

### Exact remaining external blocker

`nexus.erth.tb-cdn.earth` TLS reset after ClientHello from this deployment
(same IP + SNI `api.torbox.app` succeeds). Every Lowdown TorrentFile is
TorBox-only and no Lowdown release is RD-cached, so under the cache-only policy
there is no alternate route. `STREAM_BYTE_ROUTE` is irrelevant here (the
failure is below both byte routes). This is network/provider-edge, not HashSucker
code; HashSucker now reports it in < 1 s instead of hanging.

### Unproven / assumptions changed

- Not proven: a clean request→visible measurement for a *fresh* season arriving
  after the fix (the after measurement used a targeted refresh of an item whose
  original scan was already dead). The scheduler MIN_ACTIONS fix is pinned by
  test but its production effect on a live backlog was not separately replayed.
- Assumption corrected: "a slow action is fine because the cap only stops NEW
  work" was false in practice — the cap stopped the tick after the *first*
  action, so one slow row starved all cheaper due work for hours.
- Assumption corrected: the request→playable blocker was NOT ranking/discovery/
  VFS; publication was already fast. The blocker was a downstream byte read with
  no bounded failure, which propagated into PMS ingest and the scheduler.

## 2026-10-16 — hardening: no single failure can wedge request → playback — FIXED + DEPLOYED

Slice: hardening after the Lowdown responsiveness slice. Commits `0bdfcfd`,
`0f7292e`, `f3e3f2f`, `ae41376`. The prior slice's "after" Plex result used a
manual targeted refresh; this slice replaces it with a clean natural-request
proof and closes the wedge surfaces around it.

### 1. Serviceability semantics (audit + fix)

Which states imply byte serviceability:

| state | means | serviceable? |
|---|---|---|
| `prepared` | handoff + TorrentFile durable | no |
| `published` / `vfsPublished` | VFS/library row written | no |
| `fulfilled` (media-request response) | Binding + Plex visible + `mediaPart.file` | **no** |
| Plex ratingKey + Part | consumer indexed | no |
| `playable` (future-intent state) | anticipation byte probe succeeded | yes, at probe time only |
| operator `ready` / "Ready to watch" | handoff exists | **was no — now gated on runtime serviceability** |

Gap fixed: `byte-health.js` — a bounded, process-local, runtime-only registry
per exact TorrentFile (`serviceable` / `unserviceable` / `unknown`), driven only
by OBSERVED reads (no new provider probe), with an escalating bounded backoff
and half-open recovery. It never touches durable placement/binding/TF truth. The
VFS forward records the outcome of every read; the operator media-requests
projection exposes `serviceable` + `serviceability` and never shows "Ready to
watch" for a runtime-unserviceable binding. Observed live: Lowdown S01E03
`stage=ready svc=unserviceable | Not serviceable — provider-body-truncated
(torbox); retry in 20s`.

### 2. A provider failure must not wedge Plex ingest (blast radius)

Deterministic proof (`test/byte-health.test.js`): connection reset, 429, 5xx,
416, and a hung data plane each surface a BOUNDED typed result (the forwarder
also bounds the header wait at 30 s → 504). No read path can block a consumer
scanner. Empirically, all 10 aired Lowdown episodes (every route TorBox-broken)
indexed once reads failed fast, and a fresh request (below) indexed its movie
sibling-free — one broken route does not hold the others.

### 3. Scheduler fairness beyond MIN_ACTIONS=4 (adversarial)

`MIN_ACTIONS_PER_TICK=4` survived only after adding a cooperative per-action
wall-clock budget (`actionBudgetMs`, default 60 s) that aborts the action's
in-flight HTTP call, so a hung action cannot multiply across the tick. New test
"per-action budget bounds a hung action so the tick cannot wedge": four actions
whose HTTP call never resolves complete the tick in 41 ms (was: four hung
actions would wedge the single-flight worker for minutes). Also fixed: a nudge
arriving while a tick is in flight is no longer DROPPED — the worker re-arms at
5 s on completion (`workers.js` nudge-pending), so fresh human demand cannot
wait a full interval behind a slow tick.

### 4. External-call timeout audit

Every request/season/publication-path call has a bound: Seerr identity/season
8 s; Stremio addon `ADDON_FETCH_TIMEOUT_MS`; Torznab 5 s; TorBox/RD control
5–30 s; Plex/Jellyfin 5–10 s; Plex ingest `waitForScanQuiet` 120 s. The one
unbounded call was the VFS→data-plane forward (relied on Rust); it now has a
30 s header timeout with a typed 504. Provider acquisition inside Rust is
bounded (25 s/client). Retry ownership stays single-layer per surface.

### 5. Known-bad route suppression without corrupting durable truth

Two attempts, both measured and both REVERTED — evidence over intent:

1. Node-level TorrentFile short-circuit. Reverted: it blocked a healthy
   alternate (see §6); route health is per (provider, placement, file).
2. Data-plane per-route `Unreachable` window (`1d4d431`): mark a route that
   could not be reached unreachable for 20 s and skip it. Reverted (`46d686e`):
   production measurement showed it made repeated reads WORSE — 8 reads of one
   broken TorrentFile at 2 s spacing took 0.6–6.1 s (variable) with the window,
   vs a consistent 0.29–1.29 s after the revert. The skip changes pool
   accounting enough to trigger avoidable work; the benefit (less hammering) was
   not worth the regression.

What remains (kept): the Node `byte-health` registry TRACKS and REPORTS
runtime route health per exact TorrentFile (serviceability signal, no durable
truth touched, bounded backoff, half-open recovery), and the data plane fails a
broken route fast (~0.3 s, bounded) without API amplification. "Suppressed"
is therefore truthful reporting + fast bounded failure, not route skipping.

### 6. Healthy alternate exact routes adopted (two real defects found + fixed)

Fresh-request evidence exposed two defects on a dual TorBox+RD item:

- `f3e3f2f` (transport): a route that commits 206 then CUTS the body never
  failed over — only send errors did. Both the early-EOF and mid-body-error
  paths now prefer a same-TF alternate before resuming. Test
  `r2f_midbody_truncation_fails_over_to_alternate` (loser commits 206 then
  errors; alternate delivers exact bytes).
- `ae41376` (provider): `acquire_rd_mode_a` indexed `links[file_idx]`, but RD
  returns links at the TORRENT level, one per SELECTED file (not 1:1 with
  `files[]`). Any multi-file torrent whose selected file was not at index 0
  returned NoCapability, so the RD alternate could never be acquired. Now
  mirrors the Node resolver: single link unambiguous, else position + first-link
  fallback. Verified live: a dual-route item served 1 MiB + a distant seek via
  RD after the fix (before: 503).

### 7. Fresh natural request proof (no manual refresh)

`POST /api/media-request { mediaId: tt1877830 (The Batman 2022), movie }` at
**17:33:31**:

- published (VFS materialized): **17:33:39.97** (9.0 s; discovery + availability
  + publication)
- Binding bound via handoff: 17:33:40.37
- targeted Plex ingest dispatched: **17:33:41.12** (`partial-refresh section=2
  path=/mnt/hashsucker-vfs/Movies/The Batman`), `Notified via partial-refresh`
- byte probe → `byte-health ... unserviceable provider=torbox
  reason=provider-body-truncated`
- Plex visible (ratingKey 585) + Part committed: file
  `/mnt/hashsucker-vfs/Movies/The Batman/The Batman.mkv`, size `75751010583`
  (exact Binding size) — no manual refresh
- serviceable: **no** — TorBox-only route, CDN broken; reported precisely.

The natural path reached the earliest usable boundary and a precise blocker in
~10 s + Plex's own pacing. It did NOT reach playback: the selected release is
TorBox-cached only (`coverage ... -> unavailable providers=torbox`), i.e. the
external CDN blocker, not a HashSucker defect.

### 8. Actual playback proof with real bytes (healthy route)

Real library item Black Panther (`tf_5de34a78…`, TorBox broken + RD healthy):
VFS read 206 + 1 MiB; distant seek (17159858057) 206 + 1 MiB; SHA-256
`52daa79d…` and `9dc9c719…` — byte-identical to the established baseline. Same
through the **Plex Part** endpoint (`/library/parts/527/1788676009/file.mkv`):
206 + identical hashes on both ranges. `byte-health ... unknown->serviceable
reason=bytes-observed`. Representation unchanged (same TorrentFile).

### 9. Recovery

`byte-health` half-open recovery is unit-pinned (backoff expiry → next read
allowed → success clears) and observed live: a failed read marked unserviceable
(`retry_in_ms=20000`), a later successful read on the same exact TorrentFile
transitioned `unserviceable->serviceable reason=bytes-observed`. No Binding /
TorrentFile / republish change.

### Remaining external limitations / what can still wedge

- `nexus.erth.tb-cdn.earth` TLS reset (SNI-specific) remains. Any item whose
  selected release is TorBox-cached-only is unserviceable and now reported fast.
- A fresh request resolves to the best cached release; the resolver prefers
  TorBox-cached, so a fresh request is only playable if its selected release is
  also RD-cached (or TorBox CDN recovers). Not a HashSucker defect.
- Still open: `acquire_failover_lane` only cold-acquires the alternate when the
  slot has capacity; a genuinely busy alternate still means "no alternate right
  now" (bounded, not a wedge). Repeated reads of a broken route re-attempt it
  ~3× each (bounded, ~0.3 s total); a route-level skip was tried and reverted
  (§5) after it regressed latency.

### Verification

Rust `cargo test` 153 + 14 + 12 + 7 green. Node full suite 3337/3334/0/3 (plus
new byte-health + per-action-budget tests; one timing-sensitive reuse test
(`wallMs < 5000`) flaked once at 8016 ms under full-suite load and passed on
re-run — a load-tight bound, not a product defect). Production: Lowdown reads
502 in <0.7 s (was 90 s+); fresh request usable boundary in ~10 s; Black
Panther real bytes byte-identical through VFS and Plex Part.

## 2026-10-16 — execution-quality selection: prefer a serviceable cached representation — FIXED + DEPLOYED

Slice: serviceability-aware representation selection (commits `8d1b40b`,
`d7fd6b9`). Follows the hardening slice. Problem: HashSucker could select and
publish a representation that was already knowably unserviceable from this
deployment (The Batman: published in 9 s, Plex-indexed, byte probe immediately
said the TorBox route was dead).

### 1. The Batman candidate reconstruction (negative case)

Request `1091` (`tt1877830`, 2026-10-16 17:33). Top ranked candidates and their
route evidence at selection time:

| rank | infoHash | file | size | score | cached providers | RD evidence | rejection |
|---|---|---|---|---|---|---|---|
| 1 | 1835f8aa951c… | fik -1 | 74685231105 | 0.705 | none recorded | none | TorBox PATH A failed; RD not cached |
| 2 | 7e693dc16085… | fik -1 | 76086158025 | 0.704 | none | none | same |
| 3 | 08e6aedf0d58… | fik 0 | 75751010583 | 0.702 | torbox ready (120289342) | none | **bound (TorBox) → probe unserviceable → CDN reset** |

`provider_observations` held zero rows for any Batman candidate; the RD account
scan (15 torrents) matched **zero** Batman hashes; only `08e6aedf0d58` had a
ProviderPlacement (torbox). **Answer: no RD-serviceable alternative existed at
request time or now.** The external blocker is exact: the sole cached
representation is TorBox-only and `nexus.erth.tb-cdn.earth` resets.

### 2. Provider preference mechanism (audited)

`selectBindableCandidate` tries, per candidate, TorBox PATH A (exact-size) /
PATH B (cached inventory) BEFORE RD PATH C; the availability ordering uses
`availability.torbox.state`. So TorBox is the historical primary provider and
RD is a fallback — historical policy + first-provider ordering, not a
performance measurement and not configurable. It is not inverted here; instead
selection now consults runtime byte serviceability.

### 3. Selection contract (A/B/C/D, bounded)

Candidates are classified by the probe: **A serviceable** (recent byte-health
says serviceable, or a bounded byte read succeeds), **B probably serviceable**
(cached route, no negative evidence → same as A from the probe's view),
**C currently blocked** (recent runtime failure), **D not cached** (outside
policy). Selection strongly prefers A/B over C where representations are
otherwise acceptable. C is never permanently blacklisted — runtime health is
transient and half-open.

### 4. Implementation

- `selectBindableCandidate` gains an optional `serviceabilityProbeFn`. A bound
  candidate is accepted only when its exact TorrentFile is (or proves it is)
  byte-serviceable. An unserviceable bind is skipped and the traversal
  continues; the best-ranked unserviceable bind is retained as a fallback so a
  request with no serviceable candidate still publishes (visible) with an
  explicit `serviceability:{state:'blocked',reason,provider}`. Bounded to
  `maxServiceabilityAlternates` (default 4) further candidates. No probe seam
  ⇒ exact pre-change behavior.
- `serviceability.js`: cheap-first — recent runtime byte-health (no provider
  work), else ONE bounded byte read through the real serve path (no provider
  sweep, no durable truth touched).
- Wired through `/api/media-request` and the Seerr ingress (movie + TV fan-out).
  Response carries `serviceability`.
- Existing Binding is untouched: this runs only in fresh selection. Same-TF
  alternate-route recovery for a bound item is unchanged.

### 5. Real defect fixed: RD placements were durably unbindable

`d7fd6b9`. The RD ensure recorded its provider-file inventory without
`authoritative`/`complete`/`expiresAt`, so `activateBinding` rejected EVERY
RD-bound placement ("Binding requires an authoritative complete inventory
snapshot"). RD could serve bytes via same-TF failover but could never be the
durable representation. The RD torrent-info file list is the provider's own
COMPLETE inventory and every file is materialized, so it is now recorded
authoritative+complete with a 60 s observation TTL (TorBox parity).

### 6. Production proofs

**Negative (The Batman, external blocker retained).** A re-request selects the
same TorBox-only representation; the gate probes it, finds it unserviceable,
and (no alternative) keeps it as the fallback. Byte reads return 502 in
<0.8 s. Exact blocker: TorBox CDN SNI reset, no RD-cached release.

**Positive (Harakiri `tt0056058`, natural fresh request, no manual
intervention).** 18:39:00 request accepted → the gate probed a TorBox candidate
`tf_f2218197` (unserviceable, `byte-probe-failed`) at 18:39:11, rejected it,
probed the RD candidate `tf_2e5ac783` (serviceable, `bytes-observed`) at
18:39:14, and selected it → `published:true`,
`serviceability:{state:'serviceable',source:'probe'}` → Binding (RD) → Plex
visible (`ratingKey 615`, Harakiri 1962) → VFS reads 206 + 1 MiB at offset 0
and 206 + 1 MiB at a 6 GB seek. Total 14.0 s.

Also `Barbie tt1517268`: the gate moved past two unserviceable TorBox
candidates to a serviceable RD candidate that binds and serves 206 bytes.

### 7. Probe/API budget + latency

Per fresh request: 1 probe when the first bind is serviceable; otherwise 1
probe per bound candidate, bounded by `maxServiceabilityAlternates` (≤ 4
extra). No provider API calls are added by the gate itself (the traversal's
ensure calls are unchanged); the probe is one byte read through the existing
serve path. Observed: The Batman (no gate, baseline) ~9 s; Harakiri (gate, 2
probes) 14.0 s; Barbie (gate, 3 probes) 10–18 s. The added cost is bounded by
the probe count and dominated by the RD cold cache fill.

### 8. Failure semantics + recovery

All-blocked ⇒ the request still publishes the best-ranked bind but reports
`serviceability:{state:'blocked',reason,provider}` — materially distinct from
`no cached representation exists` (which is a selection `no-bindable-candidate`
with no handoff). Recovery is automatic: the probe/health is half-open, so a
later request (or the anticipation byte probe) clears the block when the route
recovers or an RD placement appears.

### Verification

Node full suite 3344/3341/0/3. New `selection-serviceability.test.js`: top
blocked/second serviceable wins; top serviceable ⇒ one probe, no alternate
provider work; all-blocked bounded fallback; alternate-search bounded; no-seam
unchanged; provider preference cannot override serviceability; transient health
recovers. `rd-ensure` suite green after the authoritative/complete change.

### Remaining route-selection weaknesses

- The gate adds up to ~5 s when probing is needed (RD cold fill dominates).
- `maxServiceabilityAlternates=4` is a first bound; a serviceable alternative
  ranked beyond the top-N after a rejection is not reached.
- Selection still cannot distinguish B from A without a read; the first bind is
  always probed when no recent health exists.

## 2026-10-16 — TorBox CDN reset attribution + blocked-item handling — DIAGNOSED + HARDENED

Slice: TorBox delivery + blocked-item handling (commits `1ca03e1`; incident
bundle `artifacts/incident/torbox-cdn-sni-reset.md`). Follows the
execution-quality selection slice.

### 1-2. TorBox delivery-URL characterization + reset attribution — DECISIVE

Bounded sample of 12 current cached TorrentFiles (distinct resources
95797857…120334360, files 0/1): **every** `requestdl` (JSON and
`redirect=true` 307) returned the SAME host `nexus.erth.tb-cdn.earth`
(Cloudflare: `172.66.155.241`, `104.20.42.216`; IPv6 has no route here). TLS
resets after ClientHello in ~35 ms, deterministic.

The reset is **SNI-exact and destination-independent** — the decisive test:

- on `172.66.155.241`: `nexus.erth.tb-cdn.earth` → ECONNRESET; but
  `api.torbox.app`, `erth.tb-cdn.earth`, `tb-cdn.earth`, `cloudflare.com`,
  `random.example.com` → all OK;
- against 8.8.8.8, 1.1.1.1, and Google: the SAME SNI resets while
  `random.example.com` / `totally-unrelated.test` / `foo.bar.invalid` succeed.

A reset keyed on ONE exact SNI regardless of the destination server can only be
a **middlebox on the operator's WAN path** (AT&T Arris gateway `192.168.1.254`
or AT&T DPI), NOT TorBox, NOT Cloudflare's edge, NOT the destination. Identical
from host and container; no local filter service, no proxy, no SNI-capable nft
rule; IPv4/IPv6 does not explain it.

**Correction to prior attribution:** earlier slices recorded this as a
"TorBox/CDN edge" fault. It is a local/ISP SNI filter. This is why TorBox byte
delivery fails for the whole deployment.

### 3-4. Supported alternatives + regeneration — NONE

`requestdl` is the only delivery surface (no API-host byte proxy;
`/torrents/download`, `/torrents/file` → 404). URL regeneration is
deterministic: the host is always `nexus.erth.tb-cdn.earth`. No recovery by
regeneration. No unsafe workaround attempted (no TLS-verification bypass, no
SNI spoofing, no signed-URL rewrite, no DNS pinning, no third-party proxy).

### 6. Narrow fix (operator action; not applied)

Allowlist/unblock the exact hostname in the gateway's content filter, or route
that hostname through a trusted alternate egress the operator already controls
(e.g. a Tailscale exit node). Tailscale is up with several peers, but none
advertises an exit node and no peer SSH access is available from this
deployment, so this was not applied. Impact if unfixed: **132/136 active
bindings (97%) are TorBox-only and currently unserviceable**; only 3 are
dual-route and 1 RD-only.

### 8. Blocked-publication policy — DECISION: keep Policy A (publish), with truth

Evaluated against the product objective ("requested media should appear as
playable media quickly"):

- Evidence: the blocker is a **network filter**, not a provider/permanent
  fault, and it is fixable; the item recovers **in place** (no re-ingest)
  when the route recovers. 132/136 items are blocked, so Policy B (withhold)
  would make the library appear almost empty and make a real request
  indistinguishable from a failed one — worse for "appear quickly".
- Retained: publish the best-ranked bind even when blocked, carrying
  `serviceability:{state:'blocked',reason,provider}`; the operator UI shows
  "Not serviceable — <reason>". Plex cannot express unavailability, so the
  truthful state lives in HashSucker's own surface.
- Revisit: if the blocker is permanent/provider-side, Policy B (prepare but
  withhold consumer publication, with the follow-up wake) is preferable.

### 9. Autonomous blocked-item recovery — gap found + fixed

`released-request-follow-up` future_intents ARE created for blocked released
requests (verified: `tt1877830`/`tt1517268`/`tt6056058` → intents 154/155/156),
and the scheduler's byte probe feeds byte-health. **Gap:** those intents never
ran — 9 blocked `published_preparing` episodes (P0, hourly retry, always
blocked) filled every tick's wall-clock budget, so the P4 follow-ups stayed at
`attempts=0` for hours. Fixed (`1ca03e1`): the drain interleaves actionable
rows across priority classes (round-robin by class rank), so every present
class gets a turn while preserving priority order within a class. A second
starvation source was also fixed (`ece13e9`): an erroring action previously
RETURNED from the tick, so one persistently-erroring P1 publish ended the tick
before later classes; it now re-parks its own row and continues.

Production proof (autonomous, no human request): before the fix intents
154/155/156 (`released-request-follow-up` for the blocked movies) stayed at
`attempts=0` for hours. On the first drain after the fix (20:23:24) the tick
processed P0 `id=98` → P1 `id=152` (errored, tick continued) → P2 `id=153` →
**P4 `id=154` (The Batman) `anticipated → prepared`**. On the next drain
(20:55:34) the same intent progressed `prepared → published_preparing`
(`consumer-publication-unconfirmed`) after 2555 ms — i.e. the follow-up
autonomously re-ran the full prepare → publish (serviceability gate) → byte
probe path. When the route recovers the probe succeeds and the item becomes
playable/confirmed with no human request. No hot loop: the follow-up cadence
and the byte-probe half-open window bound re-checks. (Intents 155/156 run on
subsequent drains, one class turn each.)

### 10. Serviceability health lifetime — audited + hardened

- Negative health: bounded backoff, half-open (existing, tested).
- **New:** a POSITIVE observation decays to `unknown` after 10 min, so a stale
  "serviceable" cannot report "Ready to watch" forever after delivery breaks;
  the next read/probe re-verifies.
- Process-local/runtime-only (correct): a restart clears runtime assumptions
  safely; durable truth is untouched. Test: "a stale positive decays to
  unknown".

### 11. Selection bound of four — keep (evidence limited but consistent)

Observed fresh requests: Harakiri (TorBox candidate rejected at probe #1, RD
candidate accepted at probe #2), Barbie (two TorBox rejected, then RD), The
Batman (one rejected, no alternative). In every observed case the first
serviceable candidate was within 1–2 candidates of the first reject, well
inside `maxServiceabilityAlternates=4`. Sample is small (3 gate-observed
requests); keep 4 until a larger distribution shows otherwise.

### 12. Serviceability probe cost

The probe is `probeByteReady` (`range: bytes=0-65535`) through the real serve
path. The data-plane's fixed grid is **8 MiB**, so a cache miss requests one
8 MiB chunk (measured: `chunk_size=8388608`; a probe request moved
`bytes_upstream_issued` by ~8.4 MiB, `bytes_requested_total` by ~65 KiB). On a
healthy route this fills the chunk — i.e. the probe is also cache-warming, not
pure overhead. On a dead route the transfer truncates (206 + 0 bytes). A
smaller probe would need a separate byte path (not created — no fake delivery
path). Failed probes short-circuit on recent negative health (0 bytes).

### Verification

Node full suite 3346/3343/0/3. Rust unchanged. Incident bundle committed.

### Remaining external blocker

The WAN SNI filter for `nexus.erth.tb-cdn.earth` (operator/ISP). Until it is
removed or bypassed via a trusted alternate egress, TorBox-backed fresh
requests cannot be playable here; HashSucker reports the exact blocker and
keeps the item recoverable.

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

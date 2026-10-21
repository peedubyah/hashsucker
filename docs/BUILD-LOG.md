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

## 2026-10-16 — TorBox CDN SNI reset localized and RESOLVED — RESTORED

Follows the TorBox reachability slice. Packet-level localization then operator
fix. Commits: incident/validation artifacts only (no product code change).

### Localization (before the fix)

`tcpdump` on `ens18` captured the failing flow: TCP handshake completed, the
client sent the ClientHello (1565 bytes), and ~3 ms later a **RST** arrived
with the destination's source IP and the destination's ISN+1 as seq, **ttl 64**,
duplicated. The server's SYN-ACK was **ttl 51** (Cloudflare) and, against
8.8.8.8, **ttl 122** (Google) — the RST ttl was 64 in every case, so the RST did
not travel the destination's path: it was injected/spoofed, keyed on the exact
SNI, destination-independent.

Decisive discriminator test (temporary /32 route, removed immediately): the
host is multi-homed — `ens18` → Arris gateway `192.168.1.254` (default), and
`ens19` → **pfSense `192.168.2.1`** (a different uplink, first hop
`107.136.214.174` vs the Arris's `108.200.184.1`; both converge at AT&T hop
`99.176.77.40`). Via the **pfSense** path the failing SNI completed the
handshake (`subject=CN=tb-cdn.earth`) and a real `requestdl` URL returned
**206 + 65536 bytes**; via the **Arris** path it reset. So the reset was on the
Arris/AT&T path; pfSense and local software were exonerated.

### Resolution

The operator reports **AT&T was blocking `nexus.erth.tb-cdn.earth`** and lifted
it. Re-validation on the default egress: failing SNI handshake OK with **0 RSTs**
in capture; real `requestdl` Range 206 + 65536 bytes; Rust data-plane byte read
206 + 65536 bytes. Previously-blocked TorBox-only items serve again (The Batman
VFS 206, Lowdown S01E05 VFS 206).

### Fresh TorBox-backed acceptance (no manual refresh)

`tt4154796` (Avengers Endgame) at 21:14:31 → 16.3 s → `published:true`,
`serviceability:{state:'serviceable',source:'probe'}`, handoff `provider=torbox`,
byte-health `unknown->serviceable provider=torbox` → VFS read 206 + 1 MiB at
offset 0 and 206 + 1 MiB at a **9 GB seek** → Plex visible (`ratingKey 625`,
exact Part `/mnt/hashsucker-vfs/Movies/Avengers Endgame/Avengers Endgame.mkv`,
size `18519691273`) → **Plex Part range read 206 in 0.29 s**. TorBox-backed
fresh requests are genuinely playable again.

### Verification / artifacts

`artifacts/incident/torbox-cdn-sni-reset.md` (attribution + resolution),
`artifacts/incident/validate-torbox-egress.sh` (repeatable before/after matrix;
no secrets; adds/removes at most two temporary /32 routes). No HashSucker code
changed: the investigation exposed no product regression, and the fix was
network-side as attributed.

## 2026-10-16 — cached byte routing default cutover — NOT FLIPPED (concurrency blocker)

Slice: flip `STREAM_BYTE_ROUTE` to `cached` and validate. Outcome: the flip was
made (`fcd7967`), validated, and REVERTED (`8f1b9e1`) because a reproducible
concurrency defect failed the acceptance gate. A separate regression was fixed
(`b889f70`).

### 1. Default boundary (traced before the flip)

`STREAM_BYTE_ROUTE` controls ONLY the Jellyfin `/stream` resolver:
- `cached` → `resolveAuthoritativeByteRoute` (active Binding) → 307 to
  `/bytes/:tfId` → `serveAuthoritativeBytes` → `streamFromDataPlane` (Rust). No
  Binding → explicit 409 `NO_AUTHORITATIVE_BINDING` (no silent legacy fallback).
- `provider` → the historical TorBox/RD CDN redirect ladders.
Unaffected surfaces: the Plex VFS path (`streamFromDataPlane`, already
Rust-authoritative for tfId-present entries), `/bytes/:tfId` (always Rust), and
`/media/:infoHash/:fileIndex` (legacy; not gated).

### 2-3. Flip + no silent fallback

`fcd7967` set the default to `cached` in `compose.yaml` and `app.js`, keeping
`STREAM_BYTE_ROUTE=provider` as the explicit operator escape hatch. The
`cached` path already fails loudly (409) when no Binding exists and never
retargets a provider URL on failure.

### 4. Acceptance matrix (post-flip) — the flip itself worked

Verified via `/stream` → `/bytes/:tfId` (307 with
`x-hashsucker-byte-route: data-plane`, `x-provider-check-occurred: false`) →
206, then forward/distant seeks and repeat (cache hit) reads:

| item | route | init | fwd | distant | repeat |
|---|---|---|---|---|---|
| Avengers Endgame (TorBox) | torbox | 206/5.5 ms | 206/1.85 s | 206/2.81 s | 206/5.0 ms |
| The Batman (TorBox) | torbox | 206/5.3 ms | 206/0.93 s | 206/1.18 s | 206/4.9 ms |
| Lowdown S01E05 (TorBox) | torbox | 206/5.5 ms | 206/1.03 s | 206/0.97 s | 206/4.5 ms |
| Harakiri (RD-only) | realdebrid | 206/3.9 ms | 206/1.87 s | 206/1.41 s | 206/4.4 ms |
| Black Panther (dual-route) | same TF | 206/4.6 ms | 206/1.92 s | 206/1.36 s | 206/4.7 ms |

Repeat reads hit the cache (~5 ms); forward/distant reads fill the new chunk.

### 5. Concurrency — BLOCKER (the reason for the revert)

Cold multi-chunk spans read concurrently intermittently truncate: a joiner of an
in-flight fill gets a 206 whose body is cut (Node surfaces 502, byte-health
`provider-body-truncated`). Coalescing itself is correct — metrics show ONE
chunk fill and ONE provider connection for N concurrent readers (no duplicate
pulls; `bytes_upstream_issued` grows by exactly the fill span). But delivery to
joiners is unreliable:

- 3 concurrent, cold 10 MB spans: 8/8 runs had a failure.
- 2 concurrent, cold 10 MB spans: 3/6, then 2/6 (intermittent).

The prior slice's mid-body failover (`f3e3f2f`) made it worse and was reverted
(`b889f70`); the residual is a deeper fill/join race (the joiner waits on the
fill's record and reads the chunk from the cache — the fill occasionally marks
the joined chunk failed / the body is cut). This is in the Rust path the Plex
VFS already used, so it is not introduced by the flip; the flip would extend it
to Jellyfin.

### 6-10. Not run to completion

Because criterion 6 fails, the Jellyfin/Plex/fresh-request/amplification/soak
acceptance was not completed against a flipped default.

### Verdict

**NOT FLIPPED.** `STREAM_BYTE_ROUTE` default is back to `provider` (`8f1b9e1`).
The next earned slice is the fill/join concurrency race (cold multi-chunk
concurrent readers); once fixed, the flip is a one-line change with a proven
escape hatch (`STREAM_BYTE_ROUTE=provider`).

### Regression fixed this slice

`b889f70` reverts the mid-body same-TF failover added in `f3e3f2f`: it broke
concurrent fills (2 concurrent cold spans 3/6 failed with it, 0/6 without) and
its motivation (the AT&T-injected TorBox mid-body truncation) is resolved; the
pre-existing mid-body resume still handles genuine truncation. Rust suite green
(153/14/11/7).

## 2026-10-18 — identity trust: wrong-content selection through weak identity / historical association — HARDENED + DEPLOYED

Slice: break every self-reinforcing association loop so historical
association can support but never substitute current identity evidence,
and let legitimate alternate-language/stylized titles match through
explicit alias evidence instead of weakened fuzzy matching. Deployed as
rebuilt `media-search:latest` (container healthy, full suite 3389 tests:
3386 pass, 0 fail, 3 skipped).

### 1. Trust-flow map (what creates association, what it can become)

Reads (all serve ranking/selection, none bind by themselves):
- `queryCandidatesByMedia` (media-request.js) — retrieval set for corpus
  pipeline. Poison widens the candidate set but cannot pass the gate.
- `getMediaAssociations` → `identityConfidenceForMedia` (ranking score,
  0.15 weight) and `classifyIdentityTier` Verified branch (tier-major
  traversal + `ProviderConfirmed`/`Probable` ordering).
- `computeHistoricalAvailabilityPrior` (providerAvailability, capped 0.4,
  fresh-evidence precedence) — availability only, never identity.

Writes (all request-outcome backfill before this slice):
- `backfillRequestMediaAssociations` — wrote EVERY eligible ranked row
  with tier confidence, matchMethod `request-ranked`. THE poison factory:
  7787/7787 rows are this provenance, including same-year-different-film
  clusters written in the null-title era.
- `identity-enrichment-worker` (manual script only, 5397 pending, ZERO
  writes ever) + `idle-enrichment` persistRelease (LIVE, scheduler-driven)
  + `ingestCandidate` (DMM passes no mediaIds — dead path).

Loop status before: BROKEN OPEN at every joint — weak gate admitted the
row, backfill persisted it at tier confidence, next request tiered it
Verified, selection preferred it. After: every write path requires the
hardened gate; every read path re-runs it; Verified demotes on any
current contradiction.

### 2. New trust contract (code + tests)

- Current independent identity evidence authorizes; association never
  overrides title / movie-year / TV-coordinate contradiction, never
  turns missing evidence into acceptance (Verified vetoes return
  Rejected with `title-contradiction` / `coordinate-contradiction`).
- Backfill persists only Verified/ProviderConfirmed/Probable tiers,
  caps request-ranked confidence at 0.6, records gate tier in evidence.
- Eligibility is a hard pre-filter; `selectBindableCandidate` ignores
  ineligible rows before any provider work (0 provider calls for the 6
  Mogul-Diddy rows in production).

### 3. Title matcher hardening (ranking.js)

- Token-boundary comparison killed char-containment: `Mogul` vs
  `Moguls`/`Myth and Mogul`/`The Making of a Mogul`/`Mogul Money` and
  `Up` vs `Upscale` all reject; single-token wanted requires exact
  meaningful-set equality modulo benign extras.
- Benign extras (closed-class, documented): 4-digit years, S/E shapes,
  `chapter|part N` fold, pack words, edition words (+`final` with the
  Girls/Final-Girls residual noted), resolution heights, bit depths,
  audio codec words (+digit companion rule), leading release-grammar
  strip (wanted-aware, so `Web Therapy` keeps its `Web`).
- Structural isolation instead of stoplists: `seriesTitleBeforeEpisodeToken`
  (+ bare SNN, + Sezon/Saison/Temporada/Stagione) for TV;
  `movieTitleBeforeYearToken` for movies; `cleanReleasePortion` (domain
  wrappers, leading tags, `{imdb}`/`[...]`/`(...)` groups, fracture
  handling). Proved fail-closed by construction (cleaning only removes
  tokens; acceptance still requires wanted ⊆ remainder).
- Bilingual `Foreign - English` accepts only when BOTH halves are known
  (alias + canonical), plus the space-joined affix rule under the same
  both-known constraint. Rifftrax-shape prefixes reject.
- Stylization (Se7en↔Seven) is alias-only; the leet-fold was built,
  measured wrong (`Se7en`→`seten`), and deleted rather than shipped.
- Altered-content full-filename scan rejects fanedits/recuts/honest
  trailers/commentary/redubs even when the pre-year portion is clean
  (`...1977.READNFO.ALTERNATIVE.CUT...` can no longer pass as ANH).
- PATH A TV verification: exact-size binding parses the bound file's own
  path; proven S/E contradiction falls through to PATH B instead of
  binding the wrong episode (unparseable preserves today's behavior).
- Filename-derived season fills parser-null SNN (`Show.S01.MULTi`),
  feeding isolation + the S/E gate; multi-season stays ambiguous.
- Source IDs: Prowlarr `imdbId` rides as corroboration (agree → stronger
  ProviderConfirmed; disagree → capped at ProviderScoped, never Confirmed);
  file-evidence contradiction still rejects. Stremio rows carry no IDs
  (discarded during normalization — strengthening opportunity, not a hole).

### 4. Alias evidence (known-aliases.js, 30 entries)

Curated exact spellings observed in this corpus (or operator-verified):
Se7en; German/Italian/Polish Empire VII; Il Padrino; GBU Italian; Shawshank
Italian; Butch Spanish; 2001 Italian; OUATIA Italian; GWTW Italian; Dr
Strangelove short; Dune Part One; Sunset Blvd; Psicosis/Psyco; Vertigo
FR+IT; 400 Blows FR+IT; Witness FR+IT; GoodFellas IT+PL; SPR FR+IT; BTTF
Italian; SLIH/Cantando/Ventana/NBNW Spanish; 8½ English + bare "8"; Total
Recall Italian (both versions — year gate separates); Gladiator Italian;
Le iene; Human Condition III (both halves). No entry may override year/S-E;
no transliteration without an observed release.

### 5. Association audit (scratch DB copies, hardened gate)

- 7742 rows after quarantine (was 7787): 4812 eligible / 108 contradict
  (56 title / 40 year / 8 altered) / 2822 no-wanted-title (pending intents
  and bare-ID rows — unauditable, fail-open by design, still gate-checked
  at request time).
- Contradict classes: 35× Dune-2021-under-"Dune (2020)" (catalog-year
  duplicate media, content correct — flagged for library review, NOT
  quarantined); 8 altered-content (fanedits/commentary — inert, 1 bound
  instance repaired, content-verdict below); packs/collections (can't bind
  via cardinality — inert); bilingual hybrids without full-alias coverage,
  site/group-tagged no-year rows, hash-named garbage (quarantined),
  fraction-token residual "8 1 2" (documented).
- Multi-media hashes (33): Dune pairs = duplicate catalog IDs sharing
  one-film content (year gate separates); Star Wars/Hitchcock/Wilder/
  Chaplin = franchise/collection packs (valid); Ted Lasso = show+episode
  granularity (valid); Total Recall pair = version-separated by year
  (valid, verified per-file); Civil War/BP/Endgame triple-links on
  single-film files = poison (quarantined); E01-linked-for-E02 = inert
  under episode_mismatch (left, documented).
- Quarantined 44 pairs (backup `backups/discovery-cache.pre-quarantine-*`;
  all `request-outcome`/`request-ranked`, confidence ≤0.9): 1963 bulk
  poison under tt0056801 (26: Bond×3, Birds, Atragon, Sword×2, Leopard,
  Contempt, High and Low, Yesterday, Charade×2, Mad World×2, Hud,
  Donovans, Winter Light, Fire Within, Great Escape×2, Lilies, Servant,
  Jason, Haunting, Cleopatra), no-identity garbage (hash-named,
  bare "imdb"×2, "Magnet", 3× m2ts, Gone Baby Gone, 500-Movies TV
  episode), brace-proven cross-links (Spider-Man/Civil War/BP/Endgame ×4),
  Rogue Cut fanedit link. Verified absent post-quarantine.
- Coverage: all 76 wanted-titled media have ≥1 eligible row (zero
  starvation). Known-good corpus verified row-level: Batman, Harakiri,
  Black Panther, Endgame, Sinners, Total Recall, Empire VII, Seven,
  Dune Part Two, MobLand, Slow Horses, Lowdown, Ted Lasso, Ted Lasso,
  Severance, Lanterns — each eligible + (where bound) active-valid.
- Known-bad corpus: Diddy/Mogul, Bond/Fellini, superstrings, year
  conflicts, poisoned association, source-ID-vs-file, association-only
  Verified — all deterministically rejected (tests + production negative
  control below).

### 6. Active Binding re-audit (140 → 141 rows)

129 valid + 11 alias-valid (Empire Italian VII, Se7en Remux, Il Padrino UHD,
NBNW, Shawshank, GWTW, SPR, Godfather, Total Recall 2012) + 0 suspicious.
Two flags resolved in-slice:
- tt0076759 ANH bound to "The Rogue Cut" fanedit (altered-content,
  title gate now rejects it): unpub­lished via POST /api/library/unpublish
  (1 binding superseded, VFS + strm removed) → re-request bound canonical
  ANH 1977 UHD (`movie-cached-single-file bound`), republished, VFS
  present, 2× 1 MiB ranges 206. Altered rows (`Rogue Cut`, `ALTERNATIVE
  CUT` v2) now reject with `altered_content` in production.
- tt12451788 "Dune (2020)" binding serves Dune 2021 bytes (year gate
  mismatch, title agrees): content correct, media row suspect — left
  serving, flagged for catalog review (verify/merge into tt1160419 at the
  library layer; out of identity slice).

### 7. Production proofs (deployed build)

- Fresh movie: ANH repair above (candidate set 38, 32 eligible / 6
  ineligible incl. 2× `altered_content`, Verified association + S/E,
  binding → publication → byte-identical bounded ranges).
- Fresh TV: tt10986410:1:2 forceDiscovery — 50 candidates, 25/25 split
  (6 episode_mismatch + 19 season_mismatch), bound S1E2 single-episode
  file (Verified + season-episode-match), VFS materialized, 2× 1 MiB
  ranges 206.
- Negative control tt0159187 S01E01 (live discovery on): 6 corpus rows,
  all Ineligible (`title_mismatch` + `title-contradiction`, Verified veto
  firing in production), 0 live candidates, no selection, unfulfilled,
  `retryOwned: true`, obligation pending — poison cannot rescue Diddy.
- Retry autonomy: rejection is non-terminal (request persisted, retry
  owned by scheduler, no re-request needed); future discovery can supply
  a valid candidate.

### 8. What remains / residuals (documented, not hidden)

- tt12451788 catalog-year duplicate (content right, row year wrong).
- No-year + site/group-tagged residue rows fail closed (media still bind
  via anchored rows; coverage proves zero starvation).
- Bilingual hybrids without dash or full-alias coverage (Dune Parte Due
  hybrid, space-joined Ritorno row) fail closed.
- Fraction-token "8 1 2" vs "81⁄2" VFS spelling (production Cinemeta
  "8½" + aliases cover the real rows).
- Single-token edge: wanted "Girls" + unknown year would accept
  "The Final Girls" via `final` (no such catalog case; year gate
  mitigates when known).
- Narrow conjunction: Cinemeta outage + movie + unknown year on both
  sides + poisoned association could bind on association alone (TV S/E
  still gates; outage means nothing is known — documented, not widened).
- Enrichment worker (manual script) hardened to the same token contract
  but dormant (5397 pending, zero writes ever); idle-enrichment (live)
  now ends with the hardened gate as well.

### Verdict

**IDENTITY TRUST CLEAN** — with the residuals above explicitly listed.
Historical association can no longer launder a bad candidate into
trusted identity on any write or read path under healthy metadata; every
known-good binding validates; the one known-bad active binding was
repaired through normal semantics; the negative control holds in
production with retry intact.

## 2026-10-18 — Dune catalog duplicate disposition (library/catalog identity, not ranker)

Proven facts:
- Cinemeta metadata for tt12451788 = "Dune", year 2020, runtime 4 min,
  genre Animation/Short, director Gábor Ulrich, TMDB 697620 — a 2020
  ANIMATED SHORT film, not Villeneuve's 2021 feature.
- Cinemeta metadata for tt1160419 = "Dune", year 2021, runtime ~155 min,
  TMDB 438631, Villeneuve — the canonical feature.
- OMDb confirms the same split (tt12451788: Year 2020, Type movie, 4 min;
  tt1160419: Year 2021, feature).
- HashSucker's active Binding for tt12451788 serves Dune 2021 bytes —
  the library item's year (2020) is stale catalog metadata, but the
  content is the 2021 film, so no wrong-content event exists.
- The two IDs are NOT duplicates: they are two distinct IMDb titles
  (a short and a feature). The operator's library item tt12451788 was
  created with the wrong IMDb ID for the feature film, which is why
  Cinemeta resolves it to the short.

Disposition: NOT a ranker bug and not a merge. The library item carries
a wrong mediaId (tt12451788 where tt1160419 was intended), so the
correct repair is a new library item / binding under tt1160419 with
republish; the tt12451788 item is an animated-short mislabel and should
be unpublish/supersede through normal library semantics (POST
/api/library/unpublish + request under tt1160419). No mutation performed
in this slice: ownership of the tt12451788 row is ambiguous (it may be
intentional short-film content elsewhere in the corpus), and the
year gate already prevents tt12451788 from binding Dune-2021 releases
under the hardened identity contract (40 year_mismatch rows, all
quarantined as inert). Flagged explicitly; stopped per instruction.

## 2026-10-19 — post-discovery binding tail: the account-wide TorBox inventory download — CLOSED

Slice: explain and reduce the ~5.9 s post-availability → Binding tail on
the cold request path (worst fixture tt0071562), without weakening any
identity, serviceability, or Binding rule.

### WHAT CHANGED

`1cc5445 perf(torbox): read one torrent for file inventory, not the whole account`

The TorBox file-inventory capability read the WHOLE account inventory
(`GET /torrents/mylist`) to learn ONE torrent's file list. It now reads
only the requested torrent (`GET /torrents/mylist?id=<torrentId>`), unless
the request already memoized the account snapshot — then it reuses those
bytes and still makes exactly one provider call per request scope.

Supporting (measurement only, no behavior change): `f671483` adds a
gated request-path trace (`HASHSUCKER_PERF_TRACE=1`, off by default) and
`compose.yaml` exposes the flag to the container. `7497770` adds the
negative control that pins why the create-first verify keeps the
account-wide read.

### WHAT WAS PROVEN

**1. The slow path, substage by substage (live production path, tt0071562,
cold request, stale provider inventory):**

| offset | substage | ms |
|---|---|---|
| 0 | request.start (live pipeline, 39 corpus candidates) | |
| 0→298 | corpus/title resolution | 298 |
| 298→541 | **availability** (4 parallel `checkcached` batches: 288/347/464/521) | 532 |
| 541→568 | request persist | 26 |
| 568→6374 | **selection → ensureTorBoxFileIdentity → TorBox `mylist`** | **5806** |
| | ↳ of which the account-inventory HTTP fetch | **5559** (421 torrents, 5.2 MB) |
| | ↳ inventory persist (local) | 3 |
| 6374 | serviceability (byte-health evidence, no provider work) | 0 |
| 6375→6581 | VFS materialize (Cinemeta 198) + **Binding commit** (`activateBinding` 1 ms) | 205 |
| 6621 | route done | 6622 |

No bucket ≥100 ms was left unexplained. The same shape on tt0076759:
8696 ms total, `mylist` 5700 ms. The same request with a FRESH inventory
snapshot: 337 ms total, zero provider calls — proving the cost is the
account download, not the fact being established.

**2. Slow vs normal path diff.** The discriminator is not the fixture, it
is the provider-inventory freshness plus the binding path taken:
- PATH B (movie, no exact size — e.g. tt0071562): the local shortcut
  requires a FRESH snapshot → a stale snapshot always forces the remote
  inventory read.
- PATH A (exact size — e.g. tt0102926): the local shortcut can also be
  satisfied by positive byte-health → no remote read at all.
Call graph identical otherwise; only the account download differs.

**3. Eventual-winner sufficiency.** For the tt0071562 request the winner
(4da29c17…, `tf_6d24755b`) was identity-sufficient at the availability
boundary (541 ms): the exact route was already durable
(`pl_3e7bd6fc`/provider_file 3, size 85975263992) and serviceability was
already known (`serviceable`, byte-health). The Binding became legal at
6580 ms — **6039 ms after it was already sufficient**, all of it inside
one account-wide download.

**4. Intervention (not inference).** `mylist?id=<torrentId>` was probed
against the live account and proven equivalent:
- cached torrent (11 files): the targeted entry is byte-identical to the
  same torrent inside the account list (9552 bytes each, all normalized
  fields equal);
- non-cached torrent: byte-identical too (1050 bytes each, `files: null`);
- absent torrent: HTTP 404 `ITEM_NOT_FOUND` — the same absence the
  account list proves by omission.
Latency: 118–338 ms targeted vs 501–5458 ms account-wide (5.2 MB).

**5. 10-fixture E2E, state-matched (same durable placement set on both
builds; old image = `f671483`, new image = `1cc5445`; live pipeline,
liveOnly):**

| metric (ms) | before | after |
|---|---|---|
| request→Binding min/p50/p95/max | 2433 / 4728 / 6386 / 6386 | **584 / 962 / 1168 / 1168** |
| request→Part min/p50/p95/max | 2473 / 4768 / 6429 / 6429 | **623 / 1002 / 1206 / 1206** |
| request→206 min/p50/p95/max | 2523 / 4817 / 6478 / 6478 | **658 / 1052 / 1532 / 1532** |

Every fixture switched from an account-wide `mylist` (1074–5640 ms) to a
targeted `mylist-torrent` (149–330 ms). No fixture exceeds 1.2 s; the
previous >500 ms outliers are gone. Raw results:
`artifacts/perf-binding-tail/`.

### CORRECTNESS

- Same release AND same TorrentFile for all 10 fixtures before/after
  (`same-release` / `same-tf` on every row).
- Per fixture: binding.info_hash == torrent_files.info_hash,
  provider_files.size == torrent_files.size, provider_files.torrent_file_id
  == binding.torrent_file_id → 10/10 OK.
- Plex Part present for 10/10 with the exact binding size; `Range`
  probe returned 206/65536 B for 10/10.
- .strm present for 10/10 at the canonical presentation paths; no
  duplicate/stray .strm left behind.
- Provider file ids stay opaque; `corpusFileIndex` stays null; absence
  still fails closed (`not-found`); a malformed file list still fails
  closed (`invalid-response`); the account snapshot is still reused when
  the request already has one (one provider call per request scope).
- Focused provider/selection/binding suite: 237/237.
- Full suite: 3400 tests, 3395 pass, 2 fail, 3 skipped (exit 1). Both
  failures are the PRE-EXISTING baseline ones, reproduced before any
  change of this slice: `media-request.test.js:1212` (reuse-episode
  `< 5000 ms` assertion, load-sensitive; passes in isolation) and
  `vfs-collection-resilience.test.js:131` (C1/C2/C3, deterministic).

### WHAT REMAINS UNPROVEN

- The FIRST-acquisition path (a release TorBox has cached but HashSucker
  has not placed yet) still reads the account-wide list: the create-first
  verify must prove the created placement is unambiguous, and the
  provider's only hash index is the account list. Proven floor for that
  path (the targeted read cannot observe a second account resource with
  the same hash — negative control in `7497770`), and it is a once-per-
  release cost, not a steady-state binding cost. Measured 2/10 fixtures
  hit it in the first A/B pass (createtorrent 464/601 ms + account
  `mylist` 6083/3724 ms).
- Whether the 5-minute inventory TTL should be longer or event-driven
  was NOT changed here; the read is now cheap enough that the TTL is no
  longer the binding-latency driver.

### WHAT WAS LEARNED

- The tail was never "the provider is slow": it was "we downloaded the
  provider's whole account to read one torrent". Payload size, not
  provider latency, was the cost.
- A latency tail must be attributed per OPERATION, not per STAGE. The
  post-availability bucket looked like one thing and contained one
  5.5 s download that the stage boundaries hid.
- Freshness gates are per-STATE, not per-fixture: the same fixture is
  337 ms with a fresh inventory and 6.6 s with a stale one. Any
  "this fixture is slow" claim must be checked against the TTL state.

### DEFECTS FOUND (recorded, not fixed in this slice)

- `media-search/src/lib/metadata/cinemeta.js` `getJson()` has NO timeout
  and no AbortSignal. The Cinemeta title lookup sits on the publication
  path (VFS presentation identity + .strm title). Observed live: a
  `fetch failed` after 534 ms made tt0071562's .strm land on a
  filename-derived path instead of the canonical title path, and it is
  the cause of the load-sensitive `media-request.test.js:1212` failure
  (the reuse path's wall time is that one unbounded call). Unbounded
  external latency on the request path is a real defect; fixing it is the
  next slice, not a footnote here.

### PRODUCTION STATE DELTA (disclosed)

Measurement churn, all reverted or explained:
- tt0076759 was re-selected once to a different ANH 1977 encode by a
  corpus-path probe; the final live run restored the original binding
  (`7999eb3a…` / `tf_f6525590…` / `pl_82b867bf…` / provider_file 0).
- tt0102926 acquired an RD placement for the same release and was bound
  to it by a corpus-path probe; restored to the original TorBox route
  (`tf_3410bb3d…` / `pl_31f3f13e…` / provider_file 0).
- No Release, TorrentFile, ProviderPlacement, ProviderFile, Binding,
  VFS row, .strm, or Plex Part was left inconsistent (checked 10/10).
- `HASHSUCKER_PERF_TRACE` was enabled only for the measurement window
  and is OFF in the running container again.

### NEXT SMALLEST EARNED SLICE

Bound the Cinemeta lookup (timeout + fail-closed) so an external
metadata outage cannot move a presentation path or hold a request open;
that also removes the load-sensitive failure in
`media-request.test.js:1212`.

## 2026-10-19 — Critical-path independence & autonomous recovery audit — CLOSED

Slice: enumerate every external dependency that can still make a normal
request, publication or playback unnecessarily slow, stuck or permanently
broken; classify each by semantic necessity; make the justified ones
bounded, background-owned or autonomously recoverable.

Evidence: the gated request-path trace (`f671483`, `HASHSUCKER_PERF_TRACE=1`)
plus production-path measurement on the live appliance. Full matrix:
`docs/critical-path-dependencies.md`.

### PHASE 1 — PRODUCTION DEPENDENCY GRAPH (from code)

Request path `POST /api/media-request` → discovery → identity → ranking →
provider evidence → Binding → VFS publication → WebDAV → Plex ingest →
MediaPart → bytes:

| # | dependency | caller | purpose | critical? | timeout | abort | retry | limiter | fallback | durable substitute | failure owner |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Cinemeta `/meta/*` | `resolveWantedIdentity`, `resolvePresentationIdentity`, `resolveMediaTitle` | clean title/year; optional title cross-check | D (enrichment) + B (title cross-check) | **NONE (fixed)** | **NONE (fixed)** | none | none | release attributes / request canonical identity / release filename | corpus `release_attributes`, handoff canonical identity | none (fixed: bounded + remembered) |
| 2 | Cinemeta `/catalog/*/search` | `cinemeta-identity-resolver` | candidate→media identity | D | **NONE (fixed)** | **NONE (fixed)** | none | none | resolver short-circuit | corpus associations | fixed |
| 3 | Torrentio / Comet (Stremio) | `searchStremio` | live candidate discovery | A/B | 5 s | yes | none | none | Torznab + corpus + Prowlarr | corpus (2.1 M candidates) | live bridge (per-source disposition) |
| 4 | Torznab | `searchTorznab` | live candidate discovery | B | 5 s | yes | none | none | corpus | corpus | live bridge |
| 5 | Prowlarr | `searchProwlarr` | escalation discovery | B | 8 s | yes | none | none | — (skipped when the fast layer is viable) | corpus | live bridge (escalation only) |
| 6 | TorBox `checkcached` | availability checker | cached/uncached per hash | B | 2 s | yes | none | 30 req/min (in-process) | cached observation (5 min TTL) | `provider_observations` | availability checker |
| 7 | TorBox `mylist` (account) | `lookupPlacement`, create-verify | hash→resource index | A (create path only) | 15 s | yes | 1 (coordinator) | none | none | durable placement rows | create-first path (proven floor) |
| 8 | TorBox `mylist?id=` | `getFileInventory` | one torrent's file list | A (binding) | 15 s | yes | 1 | none | none | durable provider_files + inventory snapshot | request path |
| 9 | TorBox `createtorrent` | create-first placement | cached-only placement create | A (create path) | 5 s | yes | none | none | passive lookup | — | request path |
| 10 | Real-Debrid `torrents` (account) | RD ensure, RD realizer, coverage ensurer | hash→resource index | B/D | 10 s | yes | 1 (rate-limit) | 500 ms min interval + global cooldown | durable RD placement | `provider_placements` | **realizer had no memory (fixed)** |
| 11 | Real-Debrid `torrents/info/*` | RD realizer | authoritative file list | B | 10 s | yes | 1 | as above | — | durable provider_files | realizer |
| 12 | PMS `/library/sections/*/refresh` | `notifyPlex` | targeted Plex scan | E | 5 s | yes | none | coalescer (60 s window) | Plex's own scan | VFS row + .strm | plex-notifier (fire-and-forget) |
| 13 | PMS `/activities`, `/library/metadata` | `plex-ingest` | ingest confirmation | D | 10 s/req | yes | poll 250 ms | flight (1 per section) | .strm + VFS | VFS row | publication path (bounded 20 s/60 s) |
| 14 | PMS `confirmPlexEpisode` | reuse + publication confirm | "is it visible to Plex" | D | 60 s | yes | none | none | publish state | VFS row | request path (60 s budget) |
| 15 | Jellyfin `/Library/*` | `notifyJellyfin` | consumer refresh | E | 5 s | yes | none | none | Jellyfin's own scan | .strm | fire-and-forget (currently 401: bad key) |
| 16 | data-plane `/files/:tfId` | `streamFromDataPlane`, byte probe | bytes | A (playback) | 30 s (headers) | yes | Rust-owned | Rust-owned | alternate TF (class D) | — | Rust |
| 17 | edge (Caddy) → media-search | all | ingress | A | — | — | — | — | — | — | Caddy |
| 18 | Cinemeta/Plex/TorBox DNS+TLS | all | transport | A | per call | per call | per provider | per provider | — | — | undici |

Other paths traced: healthy re-request (12–39 ms, zero external calls);
requested-season/background fulfillment (anticipation tick 60 s, season
reconcile → intent rows only); provider reconciliation (route reconciler,
6 h, single-flight); publication replay (reuse → republish); playback
recovery (Rust class-D → persisted alternate TorrentFile).

### PHASE 2–3 — WHAT WAS ACTUALLY UNBOUNDED OR MISPLACED

Classified by what the product invariant needs (A authority-critical,
B critical only without local evidence, C reconciliation, D enrichment,
E telemetry):

- **Cinemeta `getJson()` had no timeout and no AbortSignal** → an optional
  public service could hold a request, a publication or a playback open
  indefinitely, and its failure moved the PMS-visible canonical path
  (D/B, and a correctness hazard rather than enrichment).
- **The RD placement realizer had no memory of an absent resource** → the
  provider's only hash index was re-downloaded once per release per
  catalog sweep, forever (C/D — enrichment pretending to be reconciliation).
- **The Binding was re-authorized on every catalog sweep** → the store's
  route-observation guard turned an expired 5-minute inventory observation
  into a permanent error for an already-authorized Binding (C — read
  traffic doing authorization work).
- **The publication path fetches the same Cinemeta metadata twice**
  (VFS presentation identity + `.strm` title) — duplicated proof, cheap
  but real.

Everything else on the foreground path was already bounded: Stremio 5 s,
Torznab 5 s, Prowlarr 8 s, TorBox 2/5/15 s, RD 10 s + 500 ms limiter,
Plex 5/10 s, data-plane 30 s.

### PHASE 4 — BUDGETS (measured, not invented)

Cinemeta healthy p50 80 ms, max 205 ms; the slow-but-valid outlier was
1.72 s. Budget: **3 s, abortable** (`CINEMETA_TIMEOUT_MS`). Failure
memory: 30 s per (transport, path).

### PHASE 5 — RECOVERY OWNERSHIP

| state | notices | retries | durable record | wake-up | hot-loop guard | human? |
|---|---|---|---|---|---|---|
| Cinemeta unavailable | caller (catch) | next request | none needed | next request | 30 s per-lookup memory | no |
| Cinemeta degraded path | publication | never (path is stable) | VFS row + `.strm` | — | — | no |
| Discovery source unavailable | live bridge | next request | per-source disposition | next request | none needed | no |
| No serviceable provider route | selection | alternates (bounded 4) | `serviceability` in response | next request | bounded | no |
| Stale ProviderPlacement | route reconciler | 6 h | placement row | reconciler tick | single-flight | no |
| Stale ProviderFile | request path | next request | provider_files | next request | — | no |
| Negative byte-health | selection probe | half-open | in-process registry | next probe | 20 s→5 min backoff | no |
| Publication ok, consumer invisible | Plex notify | coalescer | VFS row + `.strm` | Plex scan | 60 s coalescer | no |
| PMS unavailable | notify/confirm | next request | none needed | next request | bounded 5/10/60 s | no |
| Active Binding route fails | Rust | same-TF failover | byte-health | byte read | per-route | no |
| Alternate route exists | Rust + VFS | class D | persisted alternate | byte read | — | no |
| No alternate route | VFS | terminal 5xx | — | new request | — | no |
| RD account enumeration | realizer | — | — | — | **fixed (memory+snapshot+single-flight)** | no |
| Binding re-authorization | catalog sweep | — | — | — | **fixed (identity-scoped skip)** | no |

### PHASE 6–7 — DUPLICATED PROOF / IMPLICIT STATE

- Duplicated: Cinemeta metadata (2 calls per publication) — cheap, now
  bounded; provider route validation (selection probe + catalog sweep +
  reconciler) — genuinely different semantics (serve-time vs repair-time).
- Implicit state that has already caused harm: the provider inventory
  observation's TTL is used as an AUTHORIZATION gate, so a normal
  5-minute expiry reads as a permanent failure on the read path (fixed by
  not re-authorizing an unchanged Binding); and the Binding's route
  (placement+provider file) is a CHOICE among the provider files that map
  to one provider-neutral TorrentFile, which is re-pointed by provider
  churn — intended, but it means "the handoff's route" and "the Binding's
  route" are two different facts that the projection does not reconcile.

### PHASE 9 — FIXES IMPLEMENTED (one commit each)

1. `b18fc4a fix(metadata): bound and de-duplicate the optional Cinemeta lookup`
2. `c707e12 fix(rd): remember an absent RD resource instead of re-downloading the account`
3. `500c3b5 perf(rd): share one RD account snapshot across a catalog pass`
4. `33e6e09 perf(rd): single-flight the RD account download across concurrent kicks`
5. `1d7c94b fix(binding): do not re-authorize an already-authorized Binding`

### MEASURED EFFECT (production, same procedure before/after)

| metric | before | after |
|---|---|---|
| RD account-list calls, 4 forced catalog passes (127 s) | 147 | **1** |
| RD rate-limit waits, same window | 175 | **17** |
| `activateBinding failed` warnings | 330 / 30 min | **16 / 5 min** (residual = route churn) |
| Cinemeta stall on the publication path | unbounded (would block forever) | **3 001 ms, aborted, publication completed** (measured live on tt0056058) |

A live Cinemeta stall was caught during the measurement: the catalog hung
for one call, the request aborted at the 3 s budget, the publication
completed (`published: true`, Binding activated) instead of hanging.

E2E cohort (10 movies, live pipeline, real Plex Part + Range):
- stale provider inventory: request→Binding 1353/1686/2298/…/6138 ms
  (dominated by live discovery 0.9–5.0 s; the binding stage itself is
  150–261 ms, of which the targeted inventory read is 143–250 ms);
- fresh provider inventory: request→Binding 192/217/228/…/658 ms;
- healthy re-request: 12–39 ms with ZERO external calls;
- episode re-request (Plex confirm): 49–305 ms, Plex visible.
- Part and 206 follow the Binding by 20–50 ms and 45–100 ms.

### FULL SUITE

3413 tests, 3409 pass, 1 fail, 3 skipped (exit 1). The single failure is
the PRE-EXISTING baseline failure (`vfs-collection-resilience.test.js`
C1/C2/C3), reproduced before any change of this slice. The
load-sensitive `media-request.test.js:1212` reuse test passed this run.

### REMAINING EXTERNAL DEPENDENCIES (justified exceptions)

- Cinemeta: optional enrichment, now bounded at 3 s and remembered.
- TorBox account `mylist` on the FIRST-ACQUISITION path: the provider's
  only hash index; the ">1 resource matches this hash" conflict rule
  cannot be proven by a targeted read (negative control in `7497770`).
- Discovery sources: the corpus is the durable substitute, but a cold
  corpus cannot answer a new release; bounded at 5 s each.
- PMS/Jellyfin: projections, never canonical truth; bounded 5–10 s.
- RD account list: the provider's only hash index; now bounded by
  memory + snapshot + single-flight.

### NEXT SMALLEST EARNED SLICE

Make the `.strm` title and the VFS canonical path derive from ONE
presentation identity. Today they use two different resolvers with
different year handling (the VFS path drops a string year, the `.strm`
path keeps it), so a published item can present two different paths to
Plex and Jellyfin, and a catalog outage can move one of them.

## 2026-10-19 — WHAT IS DEAD MAY NEVER DIE: route resilience — CLOSED

Slice: prove whether HashSucker can keep representation authority
independent of route/serviceability evidence, and make it so where the
evidence justifies it.

### THE QUESTION, ANSWERED FROM CODE

Can an active Binding remain authoritative until a REPRESENTATION-level
reason invalidates it, with provider-route loss affecting only
deliverability?

**Mostly yes — with one leak, now closed.**

Proven from the code and from production state:

- The Binding names the authoritative representation (one TorrentFile). The
  route set is a property of the TorrentFile, not of the Binding:
  `listDataPlaneCoordinates(torrentFileId)` returns every present+mapped
  provider file for that TorrentFile, across providers.
- The byte path already fails over between routes of the SAME TorrentFile:
  the Rust manager builds one slot per (provider, scope, resource) and
  `acquire_for_read` walks the slots, skipping open breakers and failing
  over on a rate limit or an error. Only when EVERY slot fails does it
  return `AllSameTfFailed` → `PROVIDER_EXHAUSTED` (class D) — emitted
  BEFORE any 206 is committed.
- A route failure therefore never had to touch the representation. In
  production: 218 TorrentFiles carry routes on both providers and 13 of
  the 174 active Bindings have a second route for the same TorrentFile.
- The durable route evidence expires on its own TTL and the Binding
  survives it: production today has 174 active Bindings whose route
  observation has expired, and 0 Bindings in a degraded state.
- The leak: on class D the VFS answered by picking a DIFFERENT persisted
  candidate and re-pointing the Binding at a different TorrentFile — a
  route failure re-deciding representation authority, with the consumer
  projection moving with it. It had never fired in production (0 handoffs
  carry an alternate selection reason) but the coupling was real.
- THE ACCURATE INVARIANT, stated without overclaiming: an ORDINARY route
  failure and route resurrection preserve the Binding; TOTAL same-TorrentFile
  route exhaustion may still fall through to the persisted-candidate
  fallback and therefore to representation reselection. "Route failure
  never changes the Binding" is NOT true of the system as it stands — that
  sentence is the next slice's job, not this one's achievement.

### PHASE 1 — THE AUTHORITY GRAPH (from code)

| path | trigger | facts examined | durable state changed | representation fact | route fact | owner |
|---|---|---|---|---|---|---|
| `store.activateBinding` | publication / materialization / reconcile plan | library path, placement hash+state+readiness, inventory snapshot (authoritative+complete+FRESH), exact file mapping, exposure (visible+read_only+FRESH) | binding row (version) | Release, TorrentFile, releaseKey | placement, provider file, exposure, inventory freshness | publication path |
| `materializeVfsEntry` → `tryActivateAuthoritativeBinding` | every VFS materialization (incl. the READ-path catalog sweep) | the above | binding row | — | — | publication path (now skips an unchanged active Binding) |
| `executeReconciliation` 'bind'/'rebind' | a reconcile plan | — | binding row | — | — | **INERT** (no runtime caller; shadow mode only) |
| `executeReconciliation` 'mark-degraded' | a reconcile plan | route facts (inventory exhausted, provider file missing, exposure not visible) | binding status → degraded | — | **route facts used as representation facts** | INERT |
| `unpublishLibraryItem` | operator unpublish | — | desired_state=absent, binding superseded | operator intent | — | operator |
| `alternateFallback.promoteAlternate` → `materializeVfsEntry` | class-D byte exhaustion | the alternate candidate's bytes | NEW binding version on a different TorrentFile | **changed by a route failure** | — | VFS byte path (the leak; now preceded by route resurrection) |
| `upgrade-watch` | hourly sensing | the market | a new handoff + binding | **changed by policy** (better bytes) | — | upgrade-watch |
| `route-reconciler` | 6 h | provider probes | route rows (placements/files) | unchanged | route repair | route reconciler |
| `resolveVfsStateForEntry` | every VFS read | handoff + active binding | — | — | — | VFS read path (an entry with neither is not served) |

Explicitly located couplings, and their status now:
- inventory freshness gates Binding AUTHORITY — it gates AUTHORIZATION (a new
  binding), which is correct; it no longer re-derives an existing one.
- ProviderPlacement presence gates Binding authority — same: required for a
  new authorization, irrelevant to an existing one.
- serviceability / byte-health change Binding state — they do NOT. They are
  runtime delivery facts; the reconciler planner would use route facts to
  degrade a Binding, but that planner is inert.
- publication/VFS reads re-authorize media identity — the catalog sweep
  did; removed in the previous slice, and the identity-scoped skip now
  makes an unchanged active Binding a no-op.

### PHASE 2 — REPRESENTATION-LEVEL INVALIDATION (the smallest supported set)

Supported by current product behavior:
1. explicit operator unpublish (the user removed it);
2. an explicit representation upgrade policy choosing materially better
   bytes (the upgrade-watch);
3. a TorrentFile whose identity is itself proven invalid (an exact
   mapping/identity contradiction);
4. a change of the authoritative route for the SAME TorrentFile (the
   Binding records the route it authorized — a provider-file churn re-points
   it, which is route repair, not representation change).

NOT representation-level: provider expiry, stale inventory, 404, provider
outage, negative byte-health, a placement disappearing, a rate limit.

### PHASE 3 — DELIVERY STATE (no new enum)

The distinction is already expressible in durable truth, without a new
state machine:
- representation authority → `bindings` (status/version) + the lifecycle
  milestones 'bound'/'cataloged' (orthogonal by design);
- route inventory → `provider_placements` (state/ownership) and
  `provider_files` (present/mapping);
- route evidence freshness → `provider_inventory_snapshots`,
  `provider_readiness_observations`, `provider_delivery_evidence`
  (usable/temporary/terminal, keyed on the capability tuple);
- current serviceability → the in-process byte-health registry
  (serviceable/unserviceable/unknown);
- delivery capability → Rust, runtime only.

The gap was not the model but the REPORTING: two surfaces used two
vocabularies for the same fact, and the reuse path reported no delivery
state at all. Fixed (`64b2914`).

### PHASE 4 — THE HASH → RESOURCE INDEX (no new table)

`provider_placements` already IS the index: (provider, account_scope,
provider_resource_id) → info_hash, plus `provider_files` mapping a
provider file to a TorrentFile. 413 indexed entries in production, and one
hash legitimately maps to several resources (up to 3 observed). The
lookups that need a resource id the index does not have (a new provider
resource for a known release) still need the provider's account list —
that is a DISCOVERY read, not an identity read, and it is now bounded,
cached and single-flighted (`c707e12`, `500c3b5`, `33e6e09`).

### PHASE 5–7 — ROUTE RESURRECTION, PLAYBACK RECOVERY, PUBLICATION STABILITY

The recovery order on a class-D byte failure is now:
1. another route to the SAME TorrentFile, through the EXISTING cache-only
   second-placement machinery (the same mechanism the 6-hourly route
   reconciler uses — one recovery mechanism, two triggers);
2. only if no route can be found, the existing persisted-candidate
   fallback remains as the delivery-driven last resort.

A new ProviderFile mapped to the same TorrentFile is route repair, not
media reselection. The attempt is bounded per TorrentFile (5 min cooldown)
so a client retry storm cannot storm the provider.

Playback recovery, stated precisely (not as one claim):
- NEXT REQUEST recovers — yes: the dead slot's breaker opens and the next
  request takes another route.
- SEEK recovers — yes: a seek is a new Range request.
- THE SAME HTTP RANGE REQUEST recovers — yes, when the failure happens at
  acquire/validation time (the class-D contract emits the 502 before any
  206 is committed, and the slot walk happens inside the acquire). NO when
  the route fails mid-body: the 206 is already committed, the body is
  truncated, and the client must re-request.
- AN UNINTERRUPTED DECODER SESSION SURVIVES — no. A mid-body truncation
  ends the response; only the player's re-request restores playback.

Publication stability: the consumer projection does not move when bytes
move. Measured in production: a live request re-selected a different
encode of Joker (2019) (a different TorrentFile, 23.4 GB → 53 GB) and
the VFS path and the Plex item were UNCHANGED (ratingKey 937, the same
`Movies/Joker (2019)/Joker (2019).mkv` path), and the Part served
206/65536 B.

### PHASE 8 — FAILURE MATRIX (`d44be2f`, 9 cases)

TorBox route dies with an RD route present; RD route dies with a TorBox
route present; the resource id vanishes but another resource with the same
hash remains; a stale inventory observation; a provider file no longer
present; a size-mismatched route; 404/410/429/network timeout; no provider
available; a different TorrentFile. In every case the representation is
unchanged and delivery either survives on another route or fails closed. A
route whose size does not match the authoritative TorrentFile is never
offered for it; a different TorrentFile never satisfies the authoritative
one. A route in the 'error' state is still offered to the data plane WITH
its state — execution decides, Node does not hide routes.

### PHASE 9 — RESTART DURABILITY (`5e0e675` + production)

Durable truth is the control-plane database; the runtime byte-health
registry is process-local and can never revoke an authority. Pinned: the
active Binding, its TorrentFile, its route set and the durable route
failure evidence are identical after a store reopen; the hash → resource
index reconstructs exactly; a route proven dead is still known dead after
the restart while an unknown route is never promoted to dead; a degraded
representation still has an owner.

Production: 341 binding rows, byte-identical (id, item, release,
TorrentFile, placement, provider file, version, status) across a
media-search container restart.

### PHASE 10 — RECOVERY OWNERSHIP

| degraded state | detects | records | retries | wakes | loop guard | survives restart |
|---|---|---|---|---|---|---|
| a route is dead | the byte path (Rust breaker) + the VFS class-D handler | byte-health (runtime) + `provider_delivery_evidence` (durable, on the legacy path) | the route reconciler (6 h) + the on-demand route resurrection (5 min cooldown) | a byte read / the class-D handler | per-TF cooldown; the Rust breaker (3 failures / 30 s) | the durable evidence + the placement rows |
| the TF has no route at all | the class-D handler | — | the route reconciler + the resurrection | the next byte read | the same | the placement rows |
| the representation is undeliverable and no route exists | the class-D handler | the typed 502 to the client | the upgrade-watch (hourly) may pick a better representation | the hourly tick | the upgrade budget | the handoff + binding history |
| the consumer is invisible | the Plex notify | the `.strm` + the VFS row | the Plex coalescer (60 s) | the next publication | the coalescer | yes |

### COMMITS

| commit | change |
|---|---|
| `be6e663` | feat(vfs): resurrect a route before re-deciding the representation |
| `d44be2f` | test(binding): pin the route-failure matrix against representation authority |
| `5e0e675` | test(binding): pin restart durability of the authority/recovery model |
| `64b2914` | fix(operator): one vocabulary for delivery state, reported beside authority |

### PERFORMANCE IMPACT

The change is on a failure path, so the normal path is unchanged: the
10-fixture cohort (real Plex Part + Range) after the change:
request→Binding 376–9234 ms (min 376, p50 ~1848, max 9234 — the spread
is live-discovery latency, not the binding path), request→Part +37–49 ms,
request→206 +51–86 ms. The binding stage itself stayed 150–260 ms with the
targeted inventory read at 143–250 ms. Provider account reads were not
reintroduced: the resurrection asks the same cache-only, single-flighted
mechanism the reconciler already uses.

### PRODUCTION EVIDENCE

- The 10-fixture cohort: all published, all served 206/65536 B, the same
  release and the same TorrentFile as before the change on every fixture.
- A dual-route item (the same TorrentFile on TorBox and Real-Debrid):
  the request bound, the serviceability probe answered 'serviceable', and
  the Part served 206.
- The reuse path now reports the delivery state next to the authority:
  `{"state":"unknown", ...}` on a freshly restarted process (honest: nobody
  has read from it), and 'unserviceable' with the route reason after a
  failed read.

### WHAT REMAINS

- The delivery-driven representation switch (the persisted-candidate
  fallback) still exists as the last resort when NO route can be found for
  the authoritative TorrentFile. It is the product's "keep it playable"
  policy; it has never fired in production. Turning it off entirely would
  leave an item undeliverable until the upgrade policy acts, so it is
  recorded here rather than removed.
- The durable route-failure record (`provider_delivery_evidence`) is
  written by the legacy Node provider path, not by the authoritative
  Rust path. The authoritative path's failure evidence is runtime-only
  (Rust's breaker + the byte-health registry), so a restart forgets which
  route died until the reconciler re-probes it.

## 2026-10-19 — Durable route failure authority — CLOSED

Slice: when the authoritative byte path proves a provider route dead, that
fact must survive a restart and drive recovery from the failure event
instead of being forgotten until the 6-hourly sweep; and representation
authority must never be ACCIDENTALLY derived from route evidence.

### WHAT THE EVIDENCE SHOWED

- The durable model already existed. `provider_delivery_evidence` is keyed
  on the capability tuple (provider, account scope, placement, provider
  file) with states usable/temporary/terminal, and the
  terminal-delivery-evidence store already distinguishes "provider said
  wait" from "this mapping is dead". **No new table was needed or
  created.**
- The AUTHORITATIVE path never wrote it. Only the legacy Node provider
  path did. So a route that died on the authoritative path was forgotten
  on restart, and recovery waited for the 6-hourly reconciler.
- The data plane KNEW and THREW AWAY the information. `acquire_for_read`
  walks the slots and knows exactly which (provider, scope, resource id,
  file id) failed and why, but the class-D error carried only a code.
- The failure taxonomy was already mostly right but not expressible: the
  capability error had no way to say "this route is DEAD" as opposed to
  "this route did not answer right now".
- The byte path switched the REPRESENTATION as a raw read side effect, and
  the inert reconciler planner planned 'mark-degraded' on the Binding for
  route facts (unmappable route, vanished provider file, unusable
  exposure).

### WHAT CHANGED

| commit | change |
|---|---|
| `c3be499` | data-plane: the capability error carries its durability class (terminal vs temporary), and the class-D error carries the failed routes: provider, account scope, provider resource id, provider file id, kind, detail |
| `044568b` | media-search: the VFS records the failed routes in the EXISTING evidence store, clears the negative evidence when a route delivers again, and replaces the raw representation switch with an explicit, evidence-backed, budgeted policy decision; the reconciler no longer plans 'mark-degraded' for route facts |

Dead vs not-dead is now decided at the source, where the HTTP status is
known: 404/410, a protocol-invalid resolution (the requestdl did not
resolve to a CDN, a missing data URL), an unsupported provider, a missing
credential, a torrent the account does not hold, and a provider file
whose size or identity does not match the authoritative TorrentFile are
TERMINAL. Throttling (429), 5xx, network failures, timeouts, malformed
payloads and a slot with no usable capability are TEMPORARY — and a
throttled route is never recorded as death.

### THE FINAL FALLBACK, DETERMINED FROM THE PRODUCT SEMANTICS

The question: no known route for the authoritative TorrentFile → a
persisted candidate with a different TorrentFile. Three options were on
the table; the current semantics were traced first:

- the architecture doc sanctions the switch in one place ("Node may select
  a persisted alternate only after classified provider exhaustion") and
  forbids reacting to playback outcomes in another;
- the candidate is not arbitrary: it must be an already-ranked, already
  eligible persisted candidate whose bytes are validated before the
  switch, so the alternative is a representation the household's own
  request already approved;
- it has never fired in production (0 handoffs carry an alternate
  selection reason) and every bound item in production currently has a
  live route;
- "delivery-degraded until policy acts" was REJECTED on evidence: no
  policy owner reacts to "the current representation is undeliverable"
  today (the upgrade-watch triggers on quality, not on deadness), so that
  option would leave items dead indefinitely;
- "immediately, as today" was REJECTED because a transient exhaustion (a
  throttle, a timeout) would re-decide the representation.

**Determination: the switch stays, but it is no longer a decision the
read makes.** It is a policy decision: it requires DURABLE evidence that
EVERY failed route is terminal AND that the evidence for each was
recorded, and it is BUDGETED (at most one switch per media intent per
window, 6 h by default) so a flapping route cannot churn the
representation. A transient exhaustion now leaves the representation
authoritative and the delivery degraded, and the request fails closed
with the typed provider failure.

### MEASURED / VERIFIED

- Full suite: 3439 tests, 3435 pass, 1 fail, 3 skipped (exit 1). The one
  failure is the pre-existing baseline `vfs-collection-resilience`
  C1/C2/C3.
- data-plane: `cargo build --release` clean, `cargo test --release --lib`
  153 passed, `serve_layer_coalescing` 9 passed. The integration test
  `same_tf_route_recovery::r2e_malformed_provider_payload_fails_over`
  hangs on the BASELINE as well (verified by stashing the change) and is
  pre-existing, not caused here.
- Focused VFS/binding/reconcile/route suites: 127/127.
- Restart durability: a provably dead route's evidence survives a store
  reopen AND a media-search restart; a throttled route never becomes
  death; a route that delivers again clears the negative evidence.
- Production after the deploy: 4 sampled items serve 206/65536 B with
  their exact binding sizes; the reuse path is unchanged (19 ms); the
  authority survived the restart (174 active bindings before and after).

### WHAT REMAINS

- The recovery trigger is the failing request plus the 6-hourly
  reconciler. A dead route with no further request is noticed by the
  reconciler, not by a durable watcher: the evidence is durable, but
  nothing yet polls it.
- The durable evidence is written by the authoritative path now, but the
  route reconciler still re-probes the provider instead of reading the
  evidence it wrote.
- The `provider_delivery_evidence` key is the Node-side capability tuple
  (placement id + provider file id), so the north must map the provider
  resource id to the placement id on every write. The mapping is exact
  (the durable index), but it is a mapping.

## 2026-10-19 — THE DEAD SPEAK: evidence-driven bounded-poll route recovery — CLOSED

> Terminology correction (2026-10-20): this slice was described as
> "event-driven route recovery". It is not event-driven. Nothing wakes the
> process when a route dies; the recovery is a local read of the durable
> evidence every 60 s, so the latency is the poll interval.

Slice: the durable route-failure evidence existed but the reconciler
still re-derived route failure by probing the providers on a six-hour timer.
Make the evidence the input, react to evidence transitions, and ask the
provider only what the evidence cannot answer.

### PHASE 1 — THE RECONCILER, TRACED

| | before |
|---|---|
| trigger | `armRouteReconcileTimer`, every `ROUTE_RECONCILE_INTERVAL_MIN` (default 360 = 6 h) |
| candidate selection | `findRottedRouteTorrentFiles` → `verifyRecordedRoutes`: EVERY active-bound TorrentFile × its present+mapped provider files × non-removed placements (unbounded SQL), then compared with the provider's account view |
| provider calls | 1 × `checkCached(all bound hashes)` + 1 × `listTorrents({limit: 5000})` (a 5 MB account download) — EVERY pass, whether or not anything was wrong |
| DB reads/writes | the routes/bindings/evidence tables (read); `markPlacementRemoved` (write) |
| state predicates | "usable" = present + mapped + placement ≠ removed; "live" = the hash is in the provider's account; "rotted" = no live route and no unknown |
| interaction with Binding | read only (the active bindings are the candidate set) |
| interaction with `provider_delivery_evidence` | **NONE** — the table existed and was never consulted |

Provider-call classification:

| call | what new fact can it produce that local state cannot? | class |
|---|---|---|
| `checkCached(all hashes)` | "does the TorBox account still hold these bytes?" — already answered per route by the terminal evidence | **redundant re-proof** |
| `listTorrents({limit: 5000})` | "does the RD account still hold these bytes?" — same | **redundant re-proof** |
| per-TorrentFile ensurer (discover-only) | "is there ANOTHER resource for this exact TorrentFile?" | **required discovery** |
| per-TorrentFile ensurer (TorBox cached-only create) | "is the release still cached on the provider that lost it?" | **required discovery** |

### PHASE 2 — EVIDENCE TRANSITIONS

| transition | meaning | work required |
|---|---|---|
| unknown → usable | the route delivered bytes | none; the negative evidence is superseded |
| usable → temporary | the provider said wait (throttle/timeout) | none: the next read retries the route; NEVER a representation change |
| usable → terminal | the provider answered "gone" | **route repair** (find another route for the SAME TorrentFile) |
| temporary → usable | the route recovered | none |
| terminal → usable | the route recovered (a later delivery) | none; the negative record is cleared |
| terminal → resource replaced | the provider re-added the release under a new resource id | none: the new route is simply unobserved |
| (no evidence) | nobody observed this route | none |

Only `→ terminal` is work. Repeated identical reports are one row and one
work item (idempotent by the primary key).

### PHASE 3–4 — THE EVENT-DRIVEN MODEL

- The candidate set is now READ FROM THE EVIDENCE: an actively bound
  TorrentFile whose every recorded route is proven dead has a repair DUE.
  The evidence IS the work item — no new table, no queue, no generic
  scheduler.
- The pass is LOCAL until work is due, so it now runs every MINUTE
  (`ROUTE_RECOVERY_INTERVAL_SEC`, default 60) instead of every six
  hours. An idle pass costs one indexed query and makes NO provider call.
- The provider is asked only what the evidence cannot answer: "is there
  another resource for this exact TorrentFile?" — the existing
  discover-only second-placement ensurer (cache-only; it never acquires).
- Retirement of a dead redundant placement is evidence-based too
  (terminal on the route, usable on a sibling) and makes NO provider call.
- The legacy account-wide verification (the redundant re-proof) is
  removed.

### PHASE 5 — ROUTE-SET COMPLETENESS

"Every KNOWN route is dead" is not "no same-TorrentFile route exists": the
durable index is not a proof of completeness. The representation policy
therefore requires a COMPLETED, NEGATIVE same-TorrentFile discovery
(the account was searched and does not hold the release) before it may
replace the authoritative representation. Without that proof the request
fails closed with the typed provider failure and the representation stays
authoritative. A different TorrentFile never answers the same-TorrentFile
question (pinned by a negative control).

### PHASE 6 — RESTART

The evidence is durable, so a process that died between the evidence
write and the repair leaves the work item behind: the next pass (≤60 s
after the restart) picks it up. Pinned by a focused test (a store reopen
between the write and the recovery) and proven in production: a durable
terminal record written at T was picked up by the recovery pass within
80 s ("route recovery scanned=1 repaired=0 unavailable=1"), and the
injected record was removed afterwards with the item still serving
(206/65536 B).

### PHASE 7 — THE PERIODIC SWEEP, NARROWED

What still needs a slow, periodic pass:

| work | owner | cadence |
|---|---|---|
| failure-driven recovery | the evidence-driven pass | 60 s, local until due |
| discovery of a newly appeared resource for a TorrentFile with NO recorded route | the periodic sweep | 6 h (nothing is broken; the item is simply not available yet) |
| stale inventory maintenance | the request path (the inventory observation TTL is refreshed when a route is used) | on use |
| hygiene / audit (retiring a proven-dead redundant route) | the evidence-driven pass (no provider call) | 60 s |

### PHASE 8 — METRICS (production, same appliance)

| metric | before | after |
|---|---|---|
| provider calls by an idle reconcile pass | 2 (`checkCached` over every bound hash + a 5 MB RD account list) | **0** (the pass is local until work is due) |
| RD rate-limit waits in a 60-minute window | 10 | **0** |
| failure → repair attempt | up to 6 h (the sweep) or the next read | **≤ 60 s**, and immediately on the failing read |
| restart → recovery resumes | only after the next sweep (≤6 h) | **≤ 60 s** |
| account-list downloads | one per sweep, always | only when a repair is actually due |

### PHASE 9 — CORRECTNESS MATRIX (16 focused cases)

terminal route + healthy alternate · terminal route + undiscovered
same-hash alternate · temporary throttle · repeated identical terminal
report · temporary → usable · terminal route replaced by a new resource
id · both providers terminal · a different TorrentFile · a stale placement ·
a restart between the evidence write and the recovery · an idle pass makes
no provider call · a route that is not in the durable index records
nothing · a delivered route clears the negative evidence · the budget
stops a flapping route from churning the representation.

### COMMITS

| commit | change |
|---|---|
| `de25fff` | feat(recovery): the durable evidence drives route recovery, not a timer |

### FULL SUITE

3452 tests, 3448 pass, 1 fail, 3 skipped (exit 1). The one failure is the
pre-existing baseline `vfs-collection-resilience` C1/C2/C3. Focused
route/recovery/VFS suites: 159/159.

### WHAT REMAINS

- The second-placement ensurer's "is this provider already present?"
  question does not consult the evidence, so a route marked terminal is
  still counted as present when choosing WHICH provider to look at. The
  repair therefore looks for a second route before re-observing the dead
  one. The repair still happens within a minute; only its target is
  suboptimal.
- The periodic sweep still runs every six hours for the one job the
  evidence cannot answer: a TorrentFile with no recorded route at all
  whose release may have appeared in an account since we last looked.
- The recovery is triggered by a poll of the durable evidence (a local
  read every minute), not by a push. The latency is therefore the poll
  interval, not the failure.

## 2026-10-20 — ONE TRUTH FOR ROUTES — CLOSED

Slice: the route facts were spread over three tables and three predicates,
and each consumer picked a different one. A route that was proven dead
counted as redundancy in one decision and as a live route in another. Make
one classification of a route, make every route decision consume it, and
prove on the appliance that a dead route is repaired on the SAME
TorrentFile with the identity unchanged.

### PHASE 1 — THE PREDICATES, ENUMERATED

| predicate | where | what it believed |
|---|---|---|
| "the provider is present" | `second-placement.js` `presentProviders` | a `provider_placements` row exists for the hash → **a terminally dead route counted as redundancy** |
| "there is a route" | `route-reconciler.js` `usablePlacementCount` | present + mapped + placement ≠ removed → **a dead route counted as a live route** |
| "the routes to offer" | `store.js` `listDataPlaneCoordinates` (the S-1) | present + mapped + placement ≠ removed → **the byte path was offered proven-dead routes** |
| "which placement is it" | `store.js` `findPlacementByInfoHash` | ONE placement per provider → **a replaced resource id was invisible** |
| "is the release missing" | `second-placement.js` | the ONE target provider answered no → **a negative that proved one account, not all** |

Five predicates, three meanings of "route". The provider adapter's
`lookupPlacement` was the sixth: it THROWS when two resources match one
hash — which is exactly what a re-created release looks like.

### PHASE 2 — ONE CLASSIFICATION

`media-search/src/lib/control-plane/route-classification.js` is now the
only definition of a route's state. A route is an exact capability tuple
(provider, account scope, placement, provider resource, provider file) and
its state is derived from the three durable facts that answer three
different questions:

| question | fact | table |
|---|---|---|
| which route identities do we know? | the placement | `provider_placements` |
| which provider-side file maps to this TorrentFile? | the provider file | `provider_files` |
| what was observed about that route's ability to deliver? | the delivery evidence | `provider_delivery_evidence` |

| route state | meaning | source |
|---|---|---|
| `serviceable` | it delivered bytes (or the provider still lists it) | a fresh `usable` evidence row |
| `retryable` | nobody observed it, or the provider said "wait" | no evidence row, or a fresh `temporary` row |
| `dead` | the provider answered "gone" | a fresh `terminal` evidence row |

A provider's view is the BEST of its routes. "The provider needs a route"
is: no route at all, or every route dead. **Unknown is not dead**, and a
throttle is not a death.

### PHASE 3 — EVERY DECISION CONSUMES IT

| decision | before | after |
|---|---|---|
| which provider needs a route (the ensurer) | "which provider has no second placement" | "which provider has no route, or only dead ones" — the provider that LOST its route is the target |
| the repair work item (the recovery pass) | the evidence, read by its own SQL | the shared classification |
| the routes offered to the byte path (the S-1) | every present+mapped route | every present+mapped route that is not proven dead |
| the representation fallback's completeness gate | "the provider was consulted" | "EVERY candidate account was searched, and each answered no" |

The dead route's placement row is KEPT: it is history, and a different
resource id for the same release is a NEW route, not a revival.

### PHASE 4 — RE-OBSERVATION SUPERSEDES A VERDICT

A fresh provider inventory that still lists a file supersedes that route's
terminal verdict (`superseded-by-fresh-provider-inventory`): the newer
observation wins, and the older record is superseded rather than erased.
The repair therefore RE-OBSERVES the dead route first (the cheapest proof
of whether the resource is really gone) before looking for a replacement.

### PHASE 5 — THE REPAIR, ON THE FACILITY

Observed in production before the change: the repair pass asked the
provider for a SECOND placement, so a dead route was never repaired and
the healthy provider was disturbed instead; the account listing (5.48 MB)
exceeded its 5 s budget and timed out, and the pass retried every 60 s.

| | before | after |
|---|---|---|
| the target of a repair | the provider that lacked a second placement | the provider whose route died |
| a dead route | reused as if it were a repair | re-observed; a live resource supersedes the verdict, a gone one is skipped |
| the account read | 5 s budget, timed out (0.42–5.75 s observed) | 20 s budget, and only where the provider's hash index is needed |
| a route that stays dead | re-asked every 60 s | re-checked on a 5-minute cooldown |
| a negative | one account answered no | every candidate account answered no, or the negative is not complete |
| an ambiguous account listing | counted as "not cached" | NOT a negative at all (the release may be there) |

### PHASE 6 — A REAL DEFECT FOUND BY THE PROOF

The production proof surfaced a 500 `INTERNAL_ERROR` on the class-D path:
`evidenceSummary is not defined`. The evidence summary and the discovery
outcome were declared INSIDE the class-D block, but the policy decision
that reads them lives OUTSIDE it — so every class-D failure with a
representation policy configured died with a 500 where the caller must
see the typed provider failure. The suite never saw it: the only test
that configured a policy asserted the side effects, not the response.

### PRODUCTION EVIDENCE (the appliance, 2026-10-20)

`media-search` rebuilt and recreated from the local build; container
healthy; the control-plane database is the live one.

**Case A — a dead route with a live sibling (City Lights, tt0021749).**
A terminal delivery verdict was injected for the TorBox route (the
simulated provider answer "gone" — the resource itself is still cached in
the account).

| observation | result |
|---|---|
| the S-1 route set | the TorBox route is not offered; the Real-Debrid route is |
| the read | 206, `Content-Range: bytes 0-65535/1452039706` (the exact binding size) |
| the bytes | sha256 `ae83cd8c…` — byte-identical to the pre-injection baseline |
| the dead redundant route | retired on EVIDENCE alone, no provider call, within the 60 s pass |
| the identity | Binding `bd_7726d088…` active, the same TorrentFile, the same VFS path, the same Plex ratingKey 423 |

**Case B — a dead route with no sibling (81⁄2, tt0056801).**

| observation | result |
|---|---|
| the read after the verdict | HTTP 502 with a typed body (`S1_FETCH_FAILED`) — the read fails closed, it never serves another representation |
| the repair pass | `route recovery scanned=1 repaired=1 unavailable=0 failed=0`, `route-reconcile repaired … provider=torbox source=re-observed apiCalls=1` — ONE provider call, the targeted re-observation |
| the verdict | superseded: the evidence became `usable` / `superseded-by-fresh-provider-inventory` |
| the read after the repair | 206, `Content-Range: bytes 0-65535/49792746` (the exact binding size) |
| the bytes | sha256 `96a6cb6c…` — byte-identical to the pre-injection baseline |
| the identity | Binding `bd_206135da…` active, the same TorrentFile, the same placement, the same provider file, the same VFS path |

The injected evidence was removed afterwards and the production state
restored (the placement state back to `ready`).

### MEASUREMENTS (production, same appliance)

| metric | value |
|---|---|
| an idle recovery pass | no work due → no provider call (the pass is local until work is due) |
| a repair that re-observes a live route | 1 provider call (the targeted read) |
| the account listing | 5.48 MB, 0.42–5.75 s over 3 samples → a 5 s budget is too tight; the repair read now has 20 s |
| a route that stays dead | re-checked every 5 min, not every 60 s |

### FULL SUITE

3465 tests, 3461 pass, 1 fail, 3 skipped (exit 1). The one failure is the
pre-existing baseline `vfs-collection-resilience` C1/C2/C3. The focused
route/recovery/VFS suites: 112/112.

### COMMITS

| commit | change |
|---|---|
| `88c5260` | feat(routes): one classification of routes, from inventory and evidence |
| `0b85b59` | feat(ensurer): repair the route that died, and prove the negative |
| `16865c6` | fix(routes): repair the route that died, on evidence, without a hot loop |
| `12c5ed9` | fix(vfs): the class-D failure must surface the typed failure, not a 500 |

### WHAT REMAINS UNPROVEN

- The Real-Debrid account-wide completeness proof was exercised by the
  PREVIOUS slice, not by this one: the production repair here was a
  TorBox re-observation. The RD path's new "a dead id is not a
  replacement" and "an ambiguous listing is not a negative" rules are
  proven by tests only.
- The "a replacement resource id becomes a new route" repair is proven by
  tests only: the production account holds one resource per hash, so no
  replacement case could be produced without inventing provider state.
- The representation switch on a COMPLETE negative was never exercised in
  production: the route recovered before the negative could authorize it.
- The class-D route list (which route died) is no longer reported when
  the dead route is already excluded from the S-1: the read sees "no
  coordinates" (a typed 502) instead of "route X died". The evidence
  that drives the repair is already durable, but the caller's error
  detail is coarser than it was.

### TERMINOLOGY CORRECTION

The 2026-10-19 slice is described in several places as "event-driven route
recovery". It is not: the recovery is an EVIDENCE-DRIVEN BOUNDED POLL — a
local read of the durable evidence every 60 s. Nothing wakes the process
when a route dies; the latency is the poll interval. The wording is
corrected in this entry, in `PLANS.md`, in `handoff/CURRENT.md`, in
`docs/playback-delivery.md` and in the retrospective that used the wrong
word.

### NEXT SMALLEST EARNED SLICE

The route view is one truth now; the remaining route question is what the
CALLER is told when a route is gone. The class-D body carries the failed
routes, but a route excluded from the S-1 is invisible to it. Reporting
"this route is dead, that is why there is nothing to offer" would keep the
typed detail while excluding the dead route from the byte path.

## 2026-10-20 — ONE NAME TO RULE THEM ALL: the presentation identity — CLOSED

Slice: the consumer-visible name of a media intent was derived twice, with
two source precedences, and recomputed on every publication. Make one
durable presentation identity per media intent, and make every surface
consume it.

### PHASE 1 — THE AUTHORITY GRAPH (every constructor, and who it answered to)

| constructor | file | title source | year source | durable? | moves on restart? | moves on a metadata refresh? |
|---|---|---|---|---|---|---|
| VFS canonical path (movie) | `vfs/materialize.js` | request canonical → Cinemeta → filename | request canonical only (Cinemeta's year rejected as non-integer) | yes (`vfs_movie_entries.canonical_path`) | no | no |
| VFS canonical path (episode) | `vfs/materialize.js` | request canonical → **media id** | none | yes (`vfs_tv_entries.canonical_path`) | no | no |
| `.strm` path (movie + series) | `requests/strm-publisher.js` | **Cinemeta → release title → filename → media id** (the request's canonical title IGNORED) | Cinemeta's raw year (`2016–2019`, `2024-02-27` reached directory names) | **no** — recomputed per publish | **yes** | **yes** |
| control-plane canonical path | `control-plane/store.js` | the library item's title | the library item's year | yes (`library_paths`) | no | no |
| permanent promotion tree | `promotion/paths.js` | `library_items.title` | `library_items.year` | yes (the promotion row) | no | no |
| download staging tree | `download/paths.js` | request canonical → request title → media id | request year | yes (the download row) | no | no |
| Plex/Jellyfin part file | `plex/vfs-path.js`, `plex/section-config.js` | derived from the VFS path | — | projection | — | — |

Five trees, three collection names (`Movies`, `TV`, `TV Shows`, `movies`,
`tv`), two sanitizers with different rules (`sanitizePathSegment` replaces
illegal characters with a space, `sanitizeSegment` removes them), and a
`.strm` path that existed nowhere durable.

### PHASE 2 — THE DRIFT, MEASURED (production, before any change)

| observation | count |
|---|---|
| `.strm` artifacts on disk | 184 |
| `.strm` artifacts whose NAME disagrees with the VFS path of the same media | **148 of 168 comparable** |
| dominant class | the `.strm` carries `(Year)`, the VFS path does not (the catalog's year reached one resolver and not the other) |
| catalog year ranges in directory names | 14 (`The Office (2005–2013)`, `Ted Lasso (2020–)`) |
| release-grammar names published as consumer names | 3 (`Deadwood (2004) S01E01 Deadwood (1080p BluRay x265 Silence)`, `companion 2025 dual-audio spanishlat-eng …`) |
| artifacts with NO season/episode (`Season 00` / `S00E00`) | 2 (they resolve to whichever handoff is latest — the wrong episode) |
| `.strm` artifacts for a media id that also has a TV artifact | 3 (the movie catalog answered a SERIES id) |
| control-plane `library_paths` disagreeing with the VFS row | 9 of 111 movies (two collision-suffix identity keys) |
| `library_items.title` that had been overwritten with the bare media id | **every row** (a republication without a title clobbered it) |

The last row is the operator-facing face of the same defect: the control
plane's display title was `tt0056801` for a published movie.

### PHASE 3 — THE DURABLE FACT

The presentation identity lives on the control-plane library item (no new
table): the display title, the year, the canonical VFS path and the
`.strm` path, with the commit time.

```
library_items.presentation_title        TEXT
library_items.presentation_year         INTEGER
library_items.presentation_path         TEXT   -- the canonical VFS path
library_items.presentation_strm_path    TEXT   -- the .strm path, relative to the strm root
library_items.presentation_committed_at INTEGER
```

The PATHS are written once and never rewritten. The description (title,
year) may be corrected explicitly — it is what the operator surface shows,
not what the consumer's path is derived from.

### PHASE 4 — THE PRECEDENCE (one function, `resolvePresentationName`)

```
title   1. the request's canonical title   (explicit intent — the authority)
        2. the catalog title               (canonical catalog metadata)
        3. the filename inference          (release grammar — last resort)
        4. the media id                    (a stable, honest floor)
year    1. the request's canonical year
        2. the catalog year, NORMALIZED    (only where the catalog supplied the title)
        3. the year parsed from the filename
```

The year follows the TITLE's authority: an enrichment fills a gap the
request left, it never adds a fact to a title the request already named.
That also keeps the catalog OUT of the path when the request was explicit,
which is what makes a committed identity reconstructible with ZERO metadata
calls. A range ("2016–2019") or a date ("2024-02-27") contributes its year
and nothing else.

Release attributes are NOT a presentation source: a release title is
release grammar and it belongs to a release, not to a media intent — a
representation reselection would rename the item through it.

### PHASE 5 — THE COMMIT POINT

The publication. That is the moment the consumer-visible artifacts exist,
and it is the only moment at which both paths are known. The materializer
derives the canonical path; the publisher writes (or adopts) the `.strm`;
the identity is committed with both.

### PHASE 6 — THE PATH BUILDERS (one derivation, two projections)

`Movies/<Title> (<Year>)/<Title> (<Year>).<ext>` and
`TV Shows/<Title> (<Year>)/Season NN/<Title> (<Year>) - SNNENN.strm` are
the SAME name in two layouts. The `.strm` tree is the consumer's library
layout; the VFS tree is the byte source. Inside them, the identity is
identical — so the two cannot drift apart by construction.

### PHASE 7 — THE BEHAVIOUR THAT FOLLOWS

| | before | after |
|---|---|---|
| a republication | the `.strm` path was recomputed (Cinemeta) — a metadata answer could write a SECOND artifact | the committed path is written; one artifact |
| an artifact published under an older naming rule | renamed to the canonical name (a consumer-visible path change) | ADOPTED where it is (the content identifies it); the identity records that path |
| a representation reselection | the path could move with the TorrentFile's extension | the committed path wins, extension included |
| a route repair | the path was re-derived | the committed path wins |
| a metadata answer that arrives late | could rename the item | the identity is committed; the answer is not consulted |
| the control-plane canonical path | migrated to a new title when a republicublish carried a different request name | never rewritten |
| `library_items.title` | overwritten with the bare media id | a placeholder never clobbers a real title |
| the TV catalog lookup | a TV handoff ('tv') asked the MOVIE catalog — and got a different film | the catalog type follows the media kind |
| an empty route set | — | the typed class-D failure (fixed in the previous slice) |

### PHASE 8 — WHAT THE PROOF FOUND

1. **A TV handoff resolved the MOVIE catalog.** `mediaType === 'series' ? 'series' : 'movie'` sent every 'tv' handoff to the movie catalog, which answers a series id with a DIFFERENT film. That is why the production tree holds "Black Gunn (1972)" (a movie) beside "The Last of Us" (the series) for the same media id, and a release-grammar name beside a clean one. Fixed: the catalog type follows the media kind.
2. **Two publications of one episode raced on one temp file.** The `.strm` writer used a fixed temp name, so the loser's rename failed with ENOENT — a duplicate-publication failure. Fixed: the temp name is unique per writer.
3. **The control-plane canonical path migrated** when an unpublish/republish cycle carried a different request name — a published path moved because a request was worded differently. Fixed: the committed identity owns the path.
4. **The descriptive title was clobbered** by any republication without a title. Fixed: a placeholder never overwrites a real title.

### PHASE 9 — THE EXISTING LIBRARY (audit, adoption, no rename)

The audit compares what is committed against what the consumer trees
actually contain. The adoption commits the identities that are missing and
ADOPTS the paths that are already published: the artifact the consumer
already has keeps its path, and a republication writes to the same place
instead of recomputing a name.

| | production, after the adoption |
|---|---|
| artifacts on disk | 184 |
| committed identities | **179** (180 after the scheduler published a new item during the slice) |
| identities whose `.strm` path matches the artifact on disk | **168 aligned, 0 drifted** (169/0 after the new item) |
| identities with no VFS row (published without a byte path — the virtual library) | 11 |
| artifacts with no media intent to belong to | 4 (an orphan episode, a junk `S00E00` pair, a mis-catalogued movie artifact, a release-grammar artifact) |
| files renamed | **0** |
| artifacts deleted | **0** |

### PRODUCTION EVIDENCE (the appliance, 2026-10-20)

`media-search` rebuilt and recreated from the local build; container
healthy; the control-plane database is the live one and was migrated in
place (five nullable columns added).

| cohort | observation | result |
|---|---|---|
| movie re-request (City Lights, `tt0021749`) | the reuse path | **13 ms**, HTTP 200 — no metadata call (the identity is committed) |
| | the artifacts for that media id | 1 before, **1 after** — no duplicate |
| | the committed identity | unchanged (same commit time, same paths) |
| | the read | 206, 65536 B, sha256 `ae83cd8c…` (the pre-slice baseline) |
| TV republication (Ted Lasso S01E02, `tt10986410`) | the operator republication path | 386 ms, HTTP 200 |
| | the artifacts for that episode | 1 before, **1 after** |
| | the committed identity | unchanged |
| Plex projection (City Lights) | the library item | title `City Lights`, year 1931, **ratingKey 423** — the same rating key as before the slice |
| | the artifact | `Movies/City Lights (1931)/City Lights (1931).strm` — the identity's committed path |

### THE FULL SUITE

3483 tests, 3479 pass, 1 fail, 3 skipped (exit 1). The one failure is the
pre-existing baseline `vfs-collection-resilience` C1/C2/C3. The focused
presentation/VFS/publication suites: 34/34.

### COMMITS

| commit | change |
|---|---|
| `eec42af` | feat(presentation): one durable presentation identity per media intent |
| `af23a96` | feat(presentation): every surface consumes the committed identity |
| `40ea543` | feat(presentation): the operator surface reports the identity, and the audit adopts it |
| `770bf8a` | fix(presentation): the catalog type follows the media kind, and the writer does not race |
| `e2bfcf9` | fix(presentation): one resolution, two paths, and a deterministic catalog seam |

### WHAT REMAINS UNPROVEN

- The legacy divergence between the two trees is PRESERVED for the items
  published before this slice: their `.strm` name and their VFS path
  still disagree (the `.strm` carries the year, the VFS path does not).
  Making them agree means renaming one of the two trees — a whole-library
  re-mirror of the rclone copy and a Plex item churn per renamed file.
  That is not justified by a cosmetic difference, so the divergence stays
  and is REPORTED by the audit instead.
- Four artifacts have no media intent (an orphan episode, the junk
  `S00E00` pair, a mis-catalogued movie artifact, a release-grammar
  artifact). They were left in place: removing a consumer-visible file is
  a product decision, not a repair.
- The rename/migration policy does not exist. No product requirement for a
  rename was found, so none was invented: a committed identity cannot be
  moved by any code path in the system today.
- The Jellyfin projection could not be proven end to end: the appliance's
  Jellyfin API key is rejected (HTTP 401), which is an environment
  condition, not a presentation one. The Jellyfin path is a pure
  translation of the same `.strm` path.

### NEXT SMALLEST EARNED SLICE

The presentation identity is closed for the two trees HashSucker owns. The
next consumer-visible naming surface is the ONE that is not derived from
the identity yet: the Plex library's own metadata for these items (the
title/year Plex parses out of the file name, the poster, the summary).
That is descriptive enrichment, and it must be proven to leave the
committed identity alone.

## 2026-10-20 — CONSUMER PROJECTION FROM FIRST PRINCIPLES — CLOSED

Slice: Plex and Jellyfin are projections of HashSucker's durable truth.
Nothing said what that projection WAS: the refresh notifier derived a scan
path, the ingest derived an expected Part file, the request path asked
"does Plex hold SOME Part", and the operator surface reported a single
`published` state. Prove the boundary, then make the missing projection
reconstructible from our own state.

### PHASE 1 — THE PROJECTION CONTRACT (what each surface actually does)

| surface | durable input | consumer call | consumer answer used | durable write | retry owner |
|---|---|---|---|---|---|
| VFS materialization | handoff + committed identity | none | — | `vfs_*_entries` | the request path |
| VFS size hydration | the VFS row | none (our own WebDAV) | — | `vfs_*_entries.size` | the request path, once |
| Plex refresh | the canonical path | `GET /library/sections/{id}/refresh?path=` | **HTTP status only** (a 200 proves nothing) | none | **nobody** |
| Plex ingest confirm | the canonical path + the size | `refresh?path=`, `GET /activities`, item fetch | the Part file, the Part size, the Part id | none | the request path (bounded) |
| Jellyfin notify | the committed `.strm` path | `POST /Library/Media/Updated` | **HTTP status only** | none | **nobody** |
| consumer reconcile | the library items | the consumer's library list | the item ids | `consumer_observations` | a 15-minute worker |
| playback observation | nothing | `GET /status/sessions` | the progress, the Part file | `accepted_torrent_files`, `library_items.retire_at` | a 2-second worker |

No Plex ratingKey, item id or Part id is written into `torrent_files`,
`bindings`, `library_paths`, `vfs_*_entries` or `library_items.media_id`:
the identity is the IMDb id throughout.

### PHASE 2 — THE DESIRED PROJECTION (one derivation)

`control-plane/desired-projection.js` derives, from the library item, the
committed presentation identity, the VFS row, the binding and the
authoritative TorrentFile:

- the scan path PMS must process (the parent directory of our artifact);
- the expected Part.file (our durable path under the section root);
- the expected Part.size (the authoritative exact size);
- the expected consumer path for Jellyfin (the committed `.strm` path);
- the provider id (the IMDb id) and the item type.

Pure: same inputs, same answer, no clock, no network. It replaces three
independent derivations that agreed only because the deployment happened
to be configured that way (the section root and the hard-coded
`/mnt/hashsucker-vfs`).

### PHASE 3 — THE TRUTH LEAKS FOUND, AND WHAT WAS DONE

| leak | where | verdict | action |
|---|---|---|---|
| a Plex **title** was accepted as an identity fallback | `consumers/plex.js` | authority leak (it compared the title against an IMDb id — dead code, and wrong in principle) | removed; identity is the guid or the Part file |
| Plex's **Part ordering** could pick the "authoritative" Part when no expected path was supplied | `consumers/plex.js`, `api/media-request.js` | authority leak (a consumer-chosen Part certified OUR publication) | the expected Part file is now always supplied; without it the confirm cannot return `verified` |
| `String(null)` for a missing Part id | `requests/publication.js` | defect (it defeated the consumer's own readiness check) | the id is `null`, not `"null"` |
| a truncated Jellyfin list was recorded as **absence** | `consumers/jellyfin.js` | stale-cache problem | a list at its cap is UNKNOWN, never absence |
| a single consumer absence created durable republication work | `consumers/reconcile.js` | retry/reconciliation concern | the absence must persist (15 min) before it schedules work |
| Plex session progress rewrote `library_items.retire_at` | `library/retirement.js` | **legitimate** — only the consumer knows what was watched; it touches no identity, path or representation | left, documented |
| Plex absence could retire a publication | `consumers/eligibility.js` | policy-gated already (default off) | left; the truncated-list fix removes the false absence that fed it |
| the accepted-playback row stores Plex ids | `consumers/accepted-playback.js` | a live candidate for a future leak | left; the row has no production reader and the identity comes from the active Binding |

### PHASE 4 — THE PROJECTION STATES

`aligned | missing | stale-path | stale-size | conflicted | unknown`,
derived by comparison — not a new enum in the database, and no new table.
The important distinction: **consumer-missing is not media-invalid**. An
unobserved consumer is `unknown`, never `missing`; a `conflicted` consumer
(several items for one intent) is an operator decision, not a repair.

### PHASE 5 — THE RECONCILIATION AND THE REPAIR

`control-plane/projection-audit.js` compares the desired projection with
what the consumer holds; `requests/projection-repair.js` repairs it. The
repair's entire vocabulary is: ask the consumer to look at the EXACT
directory that holds our artifact, then observe again. No media
reselection, no provider acquisition, no presentation rename, no Binding
mutation, and never a whole-section scan.

### PRODUCTION EVIDENCE (the appliance, 2026-10-20)

`media-search` rebuilt and recreated; container healthy.

| observation | value |
|---|---|
| intents audited | 190 |
| aligned | **171** (170 before the repair below, 171 after it) |
| no byte path (the VFS row is gone; the identity keeps the `.strm` path) | 13 |
| **missing** (the consumer holds nothing for our intent) | 5 (6 before the repair below) |
| stale size | 1 |
| conflicted | 0 (the one earlier conflict was a guid artefact — a DIFFERENT film with the same title) |

**The reconstruction proof** (a missing projection restored from our truth
alone):

| step | observation |
|---|---|
| the durable truth | LibraryItem `episode:tt31510819:default:2:1`, presentation identity committed (`TV/MobLand/Season 02/MobLand - S02E01.mkv`), TorrentFile `tf_5f619fba…`, size 9573001343 |
| the desired projection | Part `/mnt/hashsucker-vfs/TV/MobLand/Season 02/MobLand - S02E01.mkv`, size 9573001343, scan path `…/TV/MobLand/Season 02` |
| the consumer before | no item for that path |
| the repair | `POST /api/operator/projection/repair` → one targeted refresh of that directory (1.2 s), no discovery, no ranking, no provider work |
| the consumer after | the item exists (ratingKey 1743) with Part.file = our path |
| the byte path | 206, `Content-Range: bytes 0-65535/9573001343` |
| our durable truth | unchanged (the identity, the binding and the VFS row are exactly as before the repair) |

A second case (`Casablanca`) showed why the Part file, not the guid, is
the matcher: the Plex item for our file carries `imdb://tt0303279` (the
file's embedded tag names another film), so a guid-only match reports a
PRESENT projection as missing. Matching by the durable path classifies it
correctly.

### THE OUTAGE AND RESTART PROOF

The publication intent is durable and independent of the consumer: the
library item, the active binding, the committed presentation identity and
the `.strm` artifact all exist before any consumer is told anything, and a
Jellyfin or Plex outage changes none of them. A container restart left 179
identities, 106 consumer directories and the byte path byte-identical
(sha256 `ae83cd8c…` on City Lights). When the consumer returns, the
projection converges through the audit + repair path — no rediscovery, no
re-ranking, no re-binding.

### THE FULL SUITE

3501 tests, 3497 pass, 1 fail, 3 skipped (exit 1). The one failure is the
pre-existing baseline `vfs-collection-resilience` C1/C2/C3. The focused
projection/consumer suites: 31/31.

### COMMITS

| commit | change |
|---|---|
| `f7ff87e` | feat(projection): state what SHOULD exist in the consumer, and repair only that |

### WHAT REMAINS UNPROVEN

- **Jellyfin's live projection is blocked by the environment**: the
  appliance's Jellyfin API key is rejected (HTTP 401), so every Jellyfin
  call fails and the reconciler records UNKNOWN (fail closed). The
  Jellyfin code path is characterised and unit-tested; the live proof is
  blocked by the credential, not by the code.
- The **stale-size** class has two different causes and only one repair:
  a stale Plex Part (a refresh re-analyses it) and a VFS row that still
  points at an older TorrentFile than the active binding (the VFS row must
  be re-materialized — a VFS-layer action, not a projection repair). The
  audit reports the VFS row's own size so the operator can tell them
  apart; the re-materialization is not implemented here.
- The **13 no-byte-path** items have a committed `.strm` and no VFS row:
  they are playable through Jellyfin but are not projected into Plex, and
  re-materializing them would be a media-side action (out of scope here).

### NEXT SMALLEST EARNED SLICE

The consumer projection is now stateable and repairable for what is
MISSING. What is STALE still splits between "the consumer is behind" and
"our own VFS row is behind the binding" — the durable truth has two
copies of the byte identity, and only one of them is the authority. Making
the VFS row a projection of the binding (rather than a second copy of the
byte identity) would collapse the class.

## 2026-10-20 — ONE BYTE IDENTITY: the Binding/VFS authority — CLOSED

Slice: the durable truth held TWO copies of the byte identity — the
active Binding's TorrentFile (the authority) and the VFS row's
TorrentFile (what the byte path serves). They were written by different
code in different databases, and nothing reconciled them.

### PHASE 1 — EVERY DIVERGENCE PATH

| path | what it writes | can the row's TorrentFile diverge? |
|---|---|---|
| `vfs/materialize.js` — create (movie/TV) | the row with the HANDOFF's TorrentFile | yes: the row is written before the Binding settles |
| `vfs/materialize.js` — rejection/legacy supersede | the row's physical identity replaced (the path kept) | yes: same window |
| `vfs/materialize.js` — orphan convergence | the row's TorrentFile = the handoff's (only when there is NO active Binding) | no (there is no authority to contradict) |
| `vfs/materialize.js` — idempotent replay | nothing (only the generation) | it PRESERVED a drift |
| `control-plane/reconciler.js` — bind/rebind | a NEW Binding version | yes — and it changed the REPRESENTATION on a route-level decision |
| `lifecycle/upgrade-watch.js` — adoptNew | a new Binding + a new handoff | the materializer then moved the row; the Binding activation could fail |
| `resolver/alternate-fallback.js` — promoteAlternate | a new Binding (the representation decision) | through the materializer |
| `library/unpublish.js` | the row deleted | no |
| `discovery/cache.js` — the row helpers | the row's TorrentFile + size | — |

The decisive window: **the VFS row is written first, the Binding is
activated afterwards, in a different database.** When the activation
failed — the measured cause being "Cannot bind through a stale or
unbounded provider inventory observation" — the row had already moved to
a new TorrentFile and the two disagreed.

### PHASE 2 — THE PRODUCTION DRIFT (audited, nothing mutated)

`node src/scripts/byte-authority-audit.mjs` over the live control plane
and discovery cache:

| state | count | meaning |
|---|---|---|
| aligned | 175 | the row names exactly the Binding's TorrentFile, size and release |
| **drifted** | **0** | the row names a TorrentFile the Binding does not name |
| no-row | 13 | a published intent with no VFS row (the `.strm` exists; the byte path has no entry) |
| no-binding | 2 | legacy library items (`episode:tt7137906:default`, the pre-coordinate identity key) with no Binding |
| legacy | 0 | a row with no TorrentFile id |

The drift class is CLOSED at the moment of the audit — because the routine
reconciler had already rebinding the intent on 2026-10-20 08:37 (a
ROUTE-level decision that changed the REPRESENTATION — a leak in its own
right, recorded below).

### PHASE 3 — THE FIRST DIVERGENT TRANSITION (the production specimen)

`episode:tt31510819:default:2:1` (MobLand S02E01):

| when | what | binding | VFS row |
|---|---|---|---|
| 2026-10-02 | published | v1 → `1fda0fb9…` (the UIndex REPACK, 9 385 232 547 B) | the same TorrentFile |
| **2026-10-18** | a representation change moved the VFS row | **v1 (unchanged)** | **the row moved to `b231c01e…` (the dAv release, 9 573 001 343 B)** |
| 2026-10-20 08:37 | a ROUTE-level reconciler rebind | v2 → the row's release | the same |

So for **two days** the byte path served the dAv release's bytes while
the authority named the REPACK, and Plex's Part reported the row's size.
The activation had failed on 2026-10-18 (the stale-inventory case); the
retry state was process-local and died with the container, and nothing
else ever reconciled the two.

### PHASE 4 — THE WRITE-AUTHORITY RULE

> **A VFS row's byte identity (`torrent_file_id`, `info_hash`, `size`) is
> a PROJECTION of the active Binding's TorrentFile.**

| candidate authority | verdict |
|---|---|
| the active Binding | **the authority** — it is the representation decision |
| a handoff | execution material only; it may carry a candidate, never the byte identity of a published intent |
| the existing VFS row | a projection, never an authority: a stale row is repaired FROM the Binding |
| the release key | an index, not an identity (the same release can have several TorrentFiles) |
| a ProviderPlacement / ProviderFile | a ROUTE, never media identity |
| a consumer Part | an observation, never an authority |
| the filename / path | a presentation artifact, never a byte identity |

### PHASE 5 — ATOMICITY

The two facts live in two SQLite databases (the control plane and the
discovery cache), so no transaction can cover them. The mechanism chosen
is therefore the smallest one that guarantees eventual convergence:

1. **the Binding settles first** — the materializer activates the Binding
   and the row is then PROJECTED onto it, so the row cannot keep naming
   a TorrentFile the authority does not name;
2. **the orphan cleanup stays** — a row whose Binding never settled is
   removed (the existing contract, unchanged);
3. **a deterministic reconciliation** converges any surviving drift: at
   startup (30 s) and every 5 minutes, reading the control plane and the
   discovery cache and writing the VFS row. It performs **no discovery,
   no ranking, no provider call, no metadata lookup and no consumer
   call** — measured at milliseconds.

### PHASE 6 — BINDING REPLACEMENT

Binding TF A → B: the Binding version changes first, the VFS row is
projected onto it in the same publication, the presentation path does not
move, and the generation advances only when the projected bytes actually
changed. A crash between the two leaves the row BEHIND the authority —
never ahead — and the reconciliation converges it at startup.

### PHASE 7 — ROUTE REPAIR (the negative control)

The same TorrentFile, a changed route: the Binding is unchanged, the VFS
row's TorrentFile is unchanged, the presentation path is unchanged. Only
the route state moves. A route recovery can no longer project a different
representation — and the routine reconciler's rebind (which changed the
RELEASE on a route-level decision, the specimen above) is now bounded by
the same invariant: the row follows the Binding.

### PHASE 8 — HANDOFF AUTHORITY

A handoff may carry execution material (a candidate, a route, a
presentation identity) and, for a cold publication with no Binding yet, it
establishes the row AND the Binding from the same TorrentFile. For an
intent that already has an active Binding, the handoff is projected onto
the Binding before the row is written, so a stale handoff cannot name the
row's bytes.

### PHASE 9 — HYDRATION AND RESTART

The VFS is reconstructible from the control plane alone: the active
Binding + its TorrentFile name the row's bytes, and the committed
presentation identity names its path. The reconciliation performs no
provider call and no consumer call, and a restart converges the row
without a reselection.

### PHASE 10 — BYTE SERVING TRUTH

A modern VFS entry carries a TorrentFile id, and Rust is invoked with
exactly that id (`/files/:tfId`), so the bytes served are the projected
bytes by construction. The projection keeps the exact size and release of
the Binding's TorrentFile, so a wrong path, a wrong size or a different
TorrentFile is a mismatch the audit reports rather than something the
byte path can serve silently.

### PHASE 11 — THE STALE-SIZE CLASS, RECLASSIFIED

| class | count | meaning | repair |
|---|---|---|---|
| A. the consumer is stale, our truth agrees | 1 | Plex's Part size is from an older analysis of an unchanged file | advance the generation (the file's mtime) + a targeted refresh |
| B. **our VFS row is stale, the Binding is newer** | **0** | the row names an older TorrentFile than the authority | the projection (this slice) |
| C. the Binding itself is wrong | 0 | — | an operator decision |

The specimen was class B until the routine reconciler moved the Binding
to the row's release; it is class A today. The projection makes class B
impossible going forward.

### PRODUCTION EVIDENCE (the appliance, 2026-10-20)

| cohort | Binding | VFS row | presentation | Plex | bytes |
|---|---|---|---|---|---|
| City Lights (movie) | v1 `bd_7726d088…`, TF `tf_c0656148…`, 1 452 039 706 B | the SAME TF, the same size | `Movies/City Lights/City Lights.mp4` | ratingKey 423, Part.file = the committed path, Part.size = 1 452 039 706 B | 206, `bytes 0-65535/1452039706` |
| Ted Lasso S04E01 (episode) | v1 `bd_d2ceab69…`, TF `tf_1d637ab4…`, 6 645 443 137 B | the SAME TF, the same size | `TV/Ted Lasso/Season 04/Ted Lasso - S04E01.mkv` | ratingKey 527, Part.file = the committed path, Part.size = 6 645 443 137 B | 206 |
| publication replay (Ted Lasso S04E01) | unchanged (v1) | unchanged | unchanged (same commit time) | — | — |
| byte-authority audit | 175 aligned, 0 drifted, 13 no-row, 2 no-binding | | | | |

### THE FULL SUITE

3510 tests, 3506 pass, 1 fail, 3 skipped (exit 1). The one failure is the
pre-existing baseline `vfs-collection-resilience` C1/C2/C3. The focused
byte-authority/VFS/publication suites: 47/47.

### COMMITS

| commit | change |
|---|---|
| `f75e51b` | feat(bytes): one byte identity — the VFS projects the active Binding |
| `e611137` | fix(bytes): the projection follows the Binding, and a stale consumer view gets the signal |

### WHAT REMAINS UNPROVEN

- The **routine reconciler's rebind** can change the RELEASE (not just the
  route) of an active intent — the specimen's Binding v2 was created that
  way. It is now bounded by the invariant (the row follows the Binding),
  but a route-level decision should not be able to choose a
  representation at all. Not fixed here.
- The **13 no-row intents** have a committed `.strm` and no VFS row: they
  are playable through Jellyfin but are not projected into Plex, and
  materializing them is a media-side action.
- The **2 no-binding intents** are legacy library items (the
  pre-coordinate identity key) with no Binding; they are historical, and
  the reconciliation leaves them alone by design (there is no authority
  to project).

### NEXT SMALLEST EARNED SLICE

The byte identity is one fact now. The next copy is the ROUTE: a route
change (a rebind) still moves the representation, because the routine
reconciler treats the provider's current file as the intent's
representation. Making a route change update the ROUTE and never the
REPRESENTATION would close the last place where a route can rename bytes.

## 2026-10-20 — THE ROUTE SHALL NOT CHOOSE THE RELEASE — CLOSED

Slice: the byte authority was closed, but one representation-authority
leak remained — a ROUTE-level mechanism could choose the representation.
Separate the two policy domains completely.

### PHASE 1 — EVERY BINDING-CHANGING CALLER, CLASSIFIED

| caller | trigger | old TF → new TF | class |
|---|---|---|---|
| `vfs/materialize.js` — the activation | a publication (the handoff's TorrentFile) | A → B when the handoff names B | **representation-owned** (it executes the owner's decision) |
| `vfs/materialize.js` — the rejection/legacy supersede | the old TorrentFile was proven invalid | A → B | **representation-owned** (`rejection-supersede`) |
| `control-plane/reconciler.js` — `rebind` | a preferred placement became usable | **A → B** (the desired's release!) | **route-owned — THE LEAK** |
| `control-plane/reconciler.js` — `bind` | no active Binding | — → A | representation-owned (the first selection) |
| `lifecycle/upgrade-watch.js` — `adoptNew` | a quality probe found a better candidate | A → B | **representation-owned** (`quality-upgrade`) |
| `resolver/alternate-fallback.js` — `promoteAlternate` | the authoritative routes are exhausted and the representation policy allowed it | A → B | **representation-owned** (`delivery-exhaustion-fallback`) |
| `request` path — the selection | a request for the media | A → B | **representation-owned** (`request-reselection`) |
| `request` path — the reuse path | the same request again | A → A | none |
| `vfs/materialize.js` — the idempotent replay | a replay | A → A (the route may move) | route-owned, correctly |
| `route-recovery` / the second-placement ensurer | a dead route | **never** a TorrentFile change | route-owned, correctly |
| `consumers/reconcile.js` | a consumer absence | never | none |
| `library/unpublish.js` | an operator unpublish | the Binding is superseded | none |

### PHASE 2 — THE LEAK, REPRODUCED

`control-plane/reconciler.js` planned its rebind from the **desired**
release, not from the active Binding's:

```js
actions.push({
  action: currentBinding && !isRecovery ? 'rebind' : 'bind',
  releaseKey: desired.releaseKey,      // ← the desired release, not the binding's
  infoHash: desired.infoHash,
  fileIndex: desired.fileIndex,
  ...
});
```

So a route-level mechanism — a preferred placement becoming usable, a
provider's current file, a rediscovery — could activate a Binding for a
DIFFERENT TorrentFile. The route reconciler's own plan is now
exact-TorrentFile scoped: it rebinds inside the active Binding's release,
and a desired release that differs is reported as
`representation-change-required` with `owner: 'representation-policy'`.

**The premise checked against the evidence**: the routine reconciler has
never changed a Binding in production. Every one of the 96 historical
representation changes came from the MATERIALIZER (the publication path):
85 `vfs-movie-idempotent`, 8 `vfs-tv-idempotent`, 2
`vfs-rejection-supersede`, 1 `vfs-movie-materialize`. Zero came from the
reconciler (`preferred-usable-placement-changed` never appears in the
history). The routine reconciler is executed by nothing in production
today — the operator endpoint only produces a shadow plan — so the leak was
latent, not active. It is closed structurally rather than by observation.

### PHASE 3/4 — THE LEGAL REASONS, AND WHO OWNS THEM

| reason | owner | trigger | automatic? |
|---|---|---|---|
| `initial-selection` | the request selection | the first Binding for an intent | yes |
| `request-reselection` | the request selection | a request chose a different representation | yes (the user's request) |
| `quality-upgrade` | the upgrade policy | the quality probe found a better candidate | yes |
| `rejection-supersede` | the publication policy | the bound TorrentFile was proven invalid | yes |
| `delivery-exhaustion-fallback` | the representation policy | the authoritative routes are exhausted AND the discovery completed negatively AND the candidate is identity-qualified AND the budget permits | yes |
| `manual-override` | the operator | an explicit request | no |

Anything else may not replace the representation. The reasons are a
closed set; a caller outside the set is refused.

### PHASE 5 — THE BOUNDARY

The store's `activateBinding` is the one place a Binding is written, so
the rule is enforced there:

```
A Binding may name a different TorrentFile than the one it replaces only
with an explicit representation reason, and only one of the legal reasons
exists.
```

The reason is recorded on the binding (`bindings.representation_reason`),
so "why did this Binding change?" has an answer — the question the
history could not answer (every historical change says `vfs-movie-
idempotent`, which describes the mechanism, not the decision).

The reconciler never carries a reason, so it cannot cross the boundary
even by accident; the handoff carries the reason its owner supplied
(`playback_handoffs.representation_reason`), and the materializer
passes it through.

### PHASE 6 — THE ROUTE POLICY CONTRACT

Route policy may answer, inside ONE exact TorrentFile: which known route
should be attempted, which provider route is dead, whether another
RESOURCE exists for the same TorrentFile, whether same-TorrentFile
discovery is complete, whether no known route is currently usable.

It may not answer "what other TorrentFile should represent this media?" —
the same release under a wrong file is not a representation (the exact
path and size remain required; the hash is not enough), and the
representation policy owns the answer.

### PHASE 7 — THE PERSISTED-CANDIDATE FALLBACK

Still the only automatic path that may choose a different TorrentFile
because delivery is exhausted, and it is explicitly representation-policy
owned: the policy's completeness gate (every failed route terminal, the
same-TorrentFile discovery completed negatively, the candidate
identity-qualified, the budget permitting) decides, and the fallback
carries `delivery-exhaustion-fallback` as its reason. The route
reconciler cannot invoke it implicitly: it has no reason to give.

### PHASE 8 — THE UPGRADE WATCH

The upgrade policy remains a representation owner and stays functional: it
probes the market for a better candidate (`probeMarket`, read-only) and
only then prepares and publishes one (`prepareNew`), and the prepare
carries `quality-upgrade`. Provider availability only ENABLES an upgrade
that the quality policy already wanted; it never causes one by itself —
the probe is about desirability, the route state is not an input to it.

### PHASE 9 — THE FAILED-ACTIVATION RETRY

The retry map is process-local, so a restart loses it. It is not the
authority boundary (the durable reconciliation now converges the VFS
projection, and the boundary refuses a representation change that has no
reason), so it was left as it is: it is a route-level retry of a
route-level write, and the durable state that matters (the Binding, the
evidence, the projection) is durable. No generic durable job system was
introduced.

### PHASE 10 — THE REQUESTED-SEASON PATH

Background fulfilment goes through the request path, which is a
representation owner: a NEW episode has no active Binding, so the first
selection needs no reason; an EXISTING episode that is re-prepared goes
through the same precedence as a user request, and the upgrade watch's
prepare declares `quality-upgrade`. Neither the route reconciler nor the
consumer reconcile can reach the activation with a different TorrentFile.

### PHASE 11/12 — THE ROUTE RECONCILER'S INPUTS

The reconciler still reads the desired release (the plan needs to know
what is wanted when there is NO binding ✓), but once a binding exists its
scope IS the binding's release and TorrentFile ✓ — the plan's rebind
carries the binding's `torrentFileId` ✓ and no representation reason ✓.
It never needs the universe of alternate representations ✓.

### PHASE 13 — THE ENFORCEMENT

- The store refuses a representation change without a legal reason ✓.
- The reconciler's plan is exact-TorrentFile scoped ✓ and reports a
  differing desired release as a representation decision ✓.
- The reconciler's execution carries no reason ✓ → the store refuses it ✓.
- The legal owners declare their reason ✓ → the handoff carries it ✓ → the
  binding records it ✓.
- Tests assert that a route change creates NO Binding version ✓ (the store
  updates the execution coordinates in place ✓) and that the reconciler
  never produces a representation change ✓.

### PHASE 14 — THE AUDIT TRAIL

`bindings.representation_reason` records WHY a binding names a different
TorrentFile; `playback_handoffs.representation_reason` carries the
owner's decision to the publication. The operator surfaces report both
(`GET /api/control-plane/items/:id` → the binding history ✓).

### PHASE 15 — THE HISTORICAL AUDIT (evidence, not repair)

| history | count |
|---|---|
| binding versions | 96 representation changes, 73 route changes, 176 first bindings |
| representation changes by mechanism | 85 `vfs-movie-idempotent`, 8 `vfs-tv-idempotent`, 2 `vfs-rejection-supersede`, 1 `vfs-movie-materialize` — all from the PUBLICATION path |
| representation changes by the ROUTE reconciler | **0** |
| changes with a recorded representation reason | 0 (the column did not exist — the reason is now recorded) |

The historical versions are evidence and are NOT rewritten.

### PHASE 16 — THE CURRENT PRODUCTION AUDIT

190 intents: **175 aligned** (the VFS names exactly the Binding's
TorrentFile), 13 without a VFS row, 2 legacy items without a Binding,
**0 drifted**. No pending route work can replace a Binding: the route
reconciler has no representation reason, and the routine reconciler's
rebind is exact-TorrentFile scoped.

### PHASE 20 — THE FAILURE MATRIX (8 cases, all green)

| case | outcome |
|---|---|
| the active TF loses its TB route, the RD survives | the TB provider needs another ROUTE; the intent stays deliverable; the representation unchanged |
| every route temporarily unavailable | not a death; no repair due; the representation unchanged |
| every route terminal, the discovery incomplete | the repair is due and targets the SAME TorrentFile; the representation unchanged |
| every route terminal, the discovery complete and negative | the last route of an intent is never retired; the representation is the policy's decision |
| a stale provider inventory | a route fact; the route is unobserved, not dead |
| the same release under a wrong file | the identity is unchanged — the exact path and size are required, the hash is not enough |
| a route failure racing a representation switch | one active Binding; the route failure cannot move it |
| a restart with a pending repair | the representation, the VFS projection and the repair obligation all survive |

### PHASE 19 — CONSUMER STABILITY

Route-only work moves no bytes and no names: the presentation path, the
Binding's TorrentFile, the VFS projection, the Plex ratingKey and the
Part.file are all unchanged (the route state is the only thing that
moves). A legal representation switch moves the Binding's TorrentFile, the
VFS projection and the Part.size — and the presentation identity stays
where it was (the previous slice's invariant ✓).

### PHASE 22 — THE PRODUCTION COHORT

| cohort | Binding | VFS row | presentation | Plex | bytes |
|---|---|---|---|---|---|
| City Lights (movie, RD route) | v1 `tf_c0656148…` 1 452 039 706 B | the same TF, the same size | `Movies/City Lights/City Lights.mp4` (committed, unchanged) | ratingKey 423 | 206, `bytes 0-65535/1452039706`, sha256 `ae83cd8c…` |
| 81⁄2 (movie) | v4 `tf_80926a72…` 49 792 746 B | the same TF | `Movies/81⁄2/81⁄2.mkv` | — | 206 |
| Ted Lasso S04E01 (episode) | v1 `tf_1d637ab4…` 6 645 443 137 B | the same TF | `TV/Ted Lasso/Season 04/Ted Lasso - S04E01.mkv` | ratingKey 527 | 206 |
| MobLand S02E01 (the specimen) | v2 `tf_5f619fba…` 9 573 001 343 B | the same TF | `TV/MobLand/Season 02/MobLand - S02E01.mkv` | ratingKey 1743 | 206 |

**The route-repair negative control, on the appliance.** A terminal
delivery verdict was injected for City Lights' Real-Debrid route (the
fault the previous slice's proof used). The route reconciler retired the
dead route. Through all of it:

| | before | after |
|---|---|---|
| the Binding | v1, `tf_c0656148…` | **v1, `tf_c0656148…`** |
| the VFS row | `tf_c0656148…`, 1 452 039 706 B | **the same** |
| the presentation identity | `Movies/City Lights/City Lights.mp4` (commit 1792479548426) | **the same** |
| the bytes | 206, sha256 `ae83cd8c…` | **206, the same sha256** |

The injected fault was removed afterwards and the placement restored, so
the production state is as it was.

### THE FULL SUITE

3527 tests, 3523 pass, 1 fail, 3 skipped (exit 1). The one failure is the
pre-existing baseline `vfs-collection-resilience` C1/C2/C3. The focused
representation/authority/VFS suites: 87/87.

### COMMITS

| commit | change |
|---|---|
| `e6d1543` | feat(representation): the route reconciler may not choose the release |
| `bbaa21a` | fix(representation): the request path's selection is a legal representation reason |

### WHAT REMAINS UNPROVEN

- The **routine reconciler is executed by nothing in production** — only a
  shadow plan exists (the operator endpoint). Its rebind is now
  exact-TorrentFile scoped ✓, but the executor itself is dead code ✓; it
  was not removed here (removing it is a separate decision).
- The **failed-activation retry is still process-local** ✓ (a restart
  loses it ✓); the durable reconciliation covers the projection ✓ but
  not the retry itself ✓.
- The **historical representation changes carry no reason** ✓ (the column
  did not exist ✓); the trail starts now ✓.

### NEXT SMALLEST EARNED SLICE

The route policy is now separated from the representation policy, and the
separation is enforced where the Binding is written. The next question is
the same one for the ROUTE side: the second-placement ensurer still
discovers "another resource for the same release" through the provider's
hash index, and the identity it accepts there is a release-level match
rather than the exact TorrentFile. Making the route's identity the exact
file (path + size) everywhere would close the last place where a release
can be mistaken for a representation.

## 2026-10-20 — EXACT FILE EVERYWHERE: provider route identity — CLOSED

Slice: the representation authority was closed, but one identity leak
remained BELOW it — provider route discovery could begin from a
Release-level match (the infoHash) and treat "same release" as proof of
"same exact file".

### PHASE 1/2 — THE ROUTE CONSTRUCTORS, AND WHAT EACH PROVES

| constructor | how the resource is selected | how the FILE is selected | what it compares | can it fail open |
|---|---|---|---|---|
| `control-plane/store.js` — the inventory ingestion | the provider resource (a placement) | **the provider's own path + exact size → the TorrentFile** | release + canonical path + exact size | no: a size conflict or a duplicate path becomes a durable `conflict` and gets NO TorrentFile |
| `control-plane/second-placement.js` — the TorBox path | the account resource for the hash | the provider file already mapped to OUR TorrentFile | the exact mapping | no |
| `control-plane/second-placement.js` — the Real-Debrid path | the account torrent | `matchRdFile`: the **root + the file path** and the **exact bytes** | exact path + exact size | no |
| `resolver/torbox-file-identity.js` | the account resource | the provider file whose **exact size** is the discovery's per-file size | exact size (the path is not comparable: the corpus names the PACK) | ambiguous → `AMBIGUOUS_FILE_SIZE` |
| `providers/realdebrid/resolve.js` — the classification | the account torrent | **the release-level pick** (a single playable video file, a basename match, a size-only match) | release-level | **YES — this was the leak** |
| `providers/realdebrid/ensure.js` — the route authorization | the account torrent | the classification's pick | the exact size of the selected file | **YES — the pick's size was never checked** |
| `control-plane/reconciler.js` — the rebind | the desired release | — | — | closed by the previous slice (the reconciler may not choose a representation) |
| `providers/realdebrid/resolve.js` — the DISCOVERY classification | the account torrent | the release-level pick | release-level | legitimate HERE: a release-level fact may discover a provider resource |

### PHASE 2 — THE TWO PROVIDER CONTRACTS (they do NOT share semantics)

| | TorBox | Real-Debrid |
|---|---|---|
| the file's identity in the listing | `file.name` — the **whole** torrent-relative path, root folder included | `file.path` — **relative to the torrent root**; the root is `original_filename` |
| the exact byte count | `file.size` | `file.bytes` |
| the file id | the provider's native id (stable across refreshes) | the provider's native id (stable) |
| what the corpus knows about the file | the per-file size (`behaviorHints.videoSize`) and, for single-file releases, the release filename | the same |
| the comparable fact | the exact size (the path is the pack's name for a multi-file release) | the exact size; the path only for a single-file release |

### PHASE 3/5 — THE CONTRACT AND THE NORMALIZATION

`providers/exact-file-identity.js` is the single comparison:

- the provider's path is normalized (a leading `/` and a leading `./` are
  framing artifacts; a backslash or a traversal is refused);
- the comparison is CASE-SENSITIVE (a TorrentFile's path came from the
  provider's own listing, so the two are the same string) — with one
  documented exception: the discovery's release filename against a
  provider's file name, where the casing is the corpus's own;
- the exact size must be equal and positive;
- Real-Debrid's two framings (`Root/file` and `file`) are both accepted,
  because they are the same logical file — and a file in a subdirectory
  keeps its subdirectory in both, so it can never be confused with a
  root-level file of the same name.

### PHASE 7 — THE SECOND-PLACEMENT ENSURER

It was already exact-TorrentFile scoped: the TorBox path asks the
provider for the file inventory and then looks for the provider file
**already mapped to our TorrentFile**; the Real-Debrid path matches the
root + the file path and the exact bytes. A resource that does not expose
our exact file yields no route — proven by the tests (a resource with the
same hash and a different file is not a route).

### PHASE 6 — A REPLACEMENT RESOURCE FOR THE SAME HASH

The route recovery looks the release up in the account, takes the
replacement resource, reads ITS file list, and requires our exact file
there. The same hash is not enough; the exact path and size are required,
and the route fails closed when the replacement does not expose it. The
Binding is untouched by either outcome.

### PHASE 4 — FILE INDEX SEMANTICS

The provider's file index is EXECUTION metadata, not identity: the
identity is the canonical path + the exact size. A reordered provider
listing therefore cannot remap a TorrentFile (the store matches on
`(info_hash, internal_path)` and refuses a size conflict), and Rust is
handed the provider's NATIVE file id (`provider_file_id`), which is stable
across a refresh — the capability is bound to that id (`serve.rs`: the
requested file id must equal the capability's ✓), so a reorder cannot
silently serve another file.

### PHASE 9/11/12 — THE DURABLE MAPPING CONTRACT (production audit)

`node src/scripts/provider-file-audit.mjs` over the live control plane:

| class | count |
|---|---|
| **exact** (the provider's path and size are the TorrentFile's) | **4120** |
| unmapped (no TorrentFile — extras, artwork, .nfo) | 50 |
| path mismatch | **0** |
| size mismatch | **0** |
| release mismatch | **0** |
| missing TorrentFile | **0** |

So the durable mapping class was already exact in production; the leak was
in the DISCOVERY's pick, which is where the fix went. No row needed a
repair, and none was rewritten.

### PHASE 9/10 — BYTE PROBES AND BYTE HEALTH

A successful range read proves that a route can deliver bytes. It does not
prove identity: byte health is recorded against the TorrentFile, and the
route it is recorded for is the one the durable mapping names — an
ambiguous provider file never becomes a route in the first place, so there
is nothing for a probe to promote.

### PHASE 14 — THE REPAIR

Nothing to repair: the durable mappings are exact ✓ and the discovery's
pick is now gated by the exact size ✓. No mass rewrite ✓, no Binding
change ✓, no consumer metadata used ✓.

### PHASE 18 — THE PROVIDER ASYMMETRY

The failure matrices are separate: TorBox matches a provider file by the
exact size (its listing carries the whole path, but the corpus names the
pack), Real-Debrid matches the root + the relative path and the exact
bytes, and its classification is release-level (the discovery) while its
authorization is exact (the route). The shared policy sits ABOVE the
provider-specific extraction ✓: `exact-file-identity.js` ✓.

### PHASE 22 — PERFORMANCE

The exact comparison is LOCAL ✓: the provider file list is read once (the
inventory ✓) and the identity is matched in memory ✓. No account scan is
introduced: the second-placement still consults the account only when the
local evidence says the route is gone ✓, and the durable mapping answers
the healthy case with zero provider calls ✓.

### PRODUCTION EVIDENCE (the appliance, 2026-10-20)

| cohort | Binding | TorrentFile (hash / path / size) | provider route | provider file path + size | 206 |
|---|---|---|---|---|---|
| City Lights (movie, RD) | v1 | `abe45dc4…` / `City.Lights.1931.1080p.BluRay.x265-RARBG/City.Lights.1931.1080p.BluRay.x265-RARBG.mp4` / 1 452 039 706 | RD `63CIU4AAYI65I` file `1` | identical path, identical size | ✓ |
| 81⁄2 (movie, TorBox) | v4 | `df04acabf…` / `Eight.and.a.Half…/Extras/Trailer.mkv` / 49 792 746 | TB `122493372` file `7` | identical path, identical size | ✓ |
| Ted Lasso S04E01…S04E10 (episodes, TorBox) | v1 | each episode's own path and size | TB `114154867`, `117009857`, … | identical path, identical size | ✓ |
| MobLand S02E01…S02E05 (episodes, TorBox) | v1–v2 | each episode's own path and size | TB `108779975`, `107658029`, … | identical path, identical size | ✓ |

Every serving route is bound to a provider file whose path and exact size
are the authoritative TorrentFile's ✓✓ — 4120 of 4120 durable mappings ✓.

### THE FULL SUITE

3538 tests, 3534 pass, 1 fail, 3 skipped (exit 1). The one failure is the
pre-existing baseline `vfs-collection-resilience` C1/C2/C3. The focused
exact-file/RD/second-placement suites: 68/68.

### COMMITS

| commit | change |
|---|---|
| `cb05670` | feat(routes): a provider route must prove it is the exact TorrentFile |
| `7899eb8` | fix(routes): the Real-Debrid file pick must not contradict the discovery's size |

### WHAT REMAINS UNPROVEN

- The TorBox file-identity helper still selects by the exact SIZE alone.
  Its result is an exact TorrentFile (the provider's own path + size ✓),
  so the identity it binds is exact ✓, but the SELECTION is a per-file
  size fact rather than a path fact — because the corpus names the pack,
  not the file. The exact path is comparable only for a single-file
  release; making the corpus carry per-file paths would close it.
- The 50 unmapped provider files are extras and artwork (and demoted
  historical rows); they carry no route ✓ — nothing to repair ✓.
- The Real-Debrid classification remains release-level by design ✓ (it is
  the discovery's job ✓); only the route authorization is exact ✓.

### NEXT SMALLEST EARNED SLICE

Give the corpus the per-file PATH it lacks. Today a multi-file release's
filename is the pack's name, so the only per-file fact the discovery can
state is the byte count — and a byte count is a weaker identity than a
path. Carrying the corpus's per-file path would let the provider match on
path AND size everywhere, and would make the release-level classification
dispensable.

## 2026-10-20 — THE CORPUS KNOWS THE FILE: exact discovery identity — CLOSED

Slice: the downstream identity boundary was closed (a provider route may
carry a TorrentFile only when the provider's path AND exact size are the
TorrentFile's). One weaker boundary remained UPSTREAM: the discovery
corpus often knows the release and the candidate file's byte count, but
not the candidate file's canonical torrent-relative path — which forced
some early selection logic to use the byte count as its strongest
per-file discriminator.

### PHASE 1/2/3 — THE AUDIT (from the real corpus and the real parsers)

| corpus fact | measured |
|---|---|
| `release_attributes` rows | **1 593 141** |
| rows that carry a FILE-level index | **0** (every row is `file_index_key = -1`, i.e. release-level) |
| rows whose `filename` is the RELEASE's name (`.torrent`) | 40 |
| rows whose `filename` looks like a media file | 1 063 041 (the regex source's parse of the RELEASE's name) |
| rows whose `filename` contains a directory | 103 — and every one is a SCRAPE artifact (`xxxadulttorrent.org_[…]/…`), not a torrent-relative path |
| `candidates` rows (the discovery cache) | **0** file-level rows — the cache is release-level too |
| per-file facts the chain actually carries | the stremio stream's exact byte count (`behaviorHints.videoSize`), in memory as `exactFileSize` |
| per-file CANONICAL PATHS anywhere upstream | **none** |

The corpus is a release-level FILENAME PARSER: it parses the release's name
into resolution, codec, S/E and group. It has never had a per-file path,
and the parsers discard nothing — the path was never there.

**So the premise "the corpus knows the file" is only half true: the corpus
knows the file's BYTE COUNT (from the stream), not its path.** The only
place a per-file canonical path exists is the provider's own inventory —
which is the control plane, and which the previous slice already made
authoritative.

### PHASE 5 — THE SCHEMA DECISION

The corpus's per-file record (`release_attributes`) gains two nullable
columns — `file_path` and `file_size` — so a source that CAN supply a
per-file identity can, and so a pathless row is visibly pathless instead of
silently release-level. No parallel identity table ✓, no rewrite of the
existing rows ✓, no fabricated path ✓ (a release's name is not a file's
path). The migration is additive, nullable, idempotent and applied on every
open (the corpus is safe to use before it finishes ingesting ✓).

### PHASE 9 — THE CANDIDATE EVIDENCE MODEL

`lib/discovery/candidate-identity.js` gives every candidate an explicit
identity STRENGTH, and the strength travels with the candidate:

| strength | the candidate states | what it may do |
|---|---|---|
| `exact-file` | hash + canonical path + exact size | name a TorrentFile; authorize a route |
| `size-corroborated` | hash + exact size, no path | DISCOVER a provider resource and select within it; may not authorize a route on its own |
| `release-only` | the release | discover a release; nothing per-file |

A weaker candidate never masquerades as an exact one ✓.

### PHASE 12 — THE SIZE-ONLY AMBIGUITY (quantified)

`node src/scripts/size-ambiguity-audit.mjs` over the live provider
inventories:

| | count |
|---|---|
| mapped provider files | 4099 |
| the file's byte count is UNIQUE within its resource | 3675 (89.7 %) |
| the file's byte count is SHARED with another file of the same resource | **424 (10.3 %)** — 30 resources, the largest with 153 files of one size |

So a byte count is not a file identifier for a tenth of the mapped files ✓ —
which is exactly why the exact path matters, and why a size-only match
inside a resource fails closed when the size is shared ✓.

### PHASE 13 — TORBOX

The file-identity helper now takes the candidate's `internalPath` ✓:
when the candidate states a path, the provider file must be THAT file
(path + exact size ✓) and the result is labelled `exact-file` ✓; when it
does not, the size match stands and a shared size fails closed ✓.

### PHASE 14 — REAL-DEBRID

Unchanged from the previous slice, and deliberately asymmetric ✓: Real-Debrid
lists files relative to the torrent root, so the corpus's release name is
not comparable to the provider's path; the comparable per-file fact is the
byte count, and the authorization requires it ✓. The release-level
classification stays the discovery's job ✓; only the route authorization is
exact ✓.

### PHASE 15/18 — THE HANDOFF AND THE CACHE

The exact identity survives the handoff through the TorrentFile id ✓
(the handoff's `torrent_file_id` resolves to the path + size ✓), and the
candidate's strength and path ride the ranking input ✓. Old cached
candidates without a path deserialize as `size-corroborated` ✓ — weaker
evidence, labelled ✓, never a silent default to exact ✓.

### PHASE 25 — THE TESTS

`test/corpus-file-identity.test.js`: the identity strength is explicit ✓; a
per-file path survives ingest → read → restart ✓; a pathless row stays a
valid release-level row ✓; the same basename in two directories stays two
files ✓; an exact path selects that provider file and not another of the
same size ✓; a shared size without a path fails closed ✓.

### THE FULL SUITE

3544 tests, 3540 pass, 1 fail, 3 skipped (exit 1). The one failure is the
pre-existing baseline `vfs-collection-resilience` C1/C2/C3. The focused
corpus/exact-file/provider suites: 74/74.

### COMMITS

| commit | change |
|---|---|
| `a05410a` | feat(corpus): the corpus's per-file identity, the candidate's evidence strength, and the TorBox exact path |

### WHAT REMAINS UNPROVEN

- The corpus's per-file path coverage is **0** today ✓ — the plumbing is
  proven (the schema, the ingest, the candidate, the handoff, the
  selection ✓) but no current source supplies a path ✓. A source that
  supplies one (or the provider's inventory ✓) flows through unchanged ✓.
- The TorBox helper's size-only selection remains for pathless candidates ✓
  (the corpus's own coverage ✓); it fails closed on a shared size ✓.
- The 424 size-ambiguous provider files are mostly extras and artwork ✓
  (the big "IMDB合集" packs ✓); the ones that matter for playback are
  already bound by exact path ✓.

### NEXT SMALLEST EARNED SLICE

Give the discovery a per-file path from a source that HAS one. The
provider's inventory has it ✓; the corpus does not ✓. A torrent-metadata
sidecar (the .torrent's own file list) for the releases the corpus already
holds would give the corpus the per-file path at a fraction of the cost of
a provider scan — and would make the size-only selection disappear.

## 2026-10-20 — SEAL AND LOOK OUTWARD: the push, and the ecosystem reconnaissance — CLOSED

Slice: two separable jobs, closed together. (1) The sealed state was
committed but unpushable: GitHub's 100 MB pre-receive limit rejected six
generated `experiments/temporal-correspondence/corpus/*.mkv` blobs that
travelled in the local-only commit `3a42710`, which added them before
`experiments/temporal-correspondence/.gitignore` existed. (2) The online
ecosystem reconnaissance the product direction needed.

### WHAT CHANGED

- `git rebase --onto github/main 3a42710`: the local-only artifact commit is
  dropped, the ~88 local commits replay onto `github/main`, the push is now
  a plain fast-forward (`2258d21`, `ffed151`). No force, no published
  history rewritten (the local commits were unpublished).
- The four `docs/recon/` notes that travelled in the dropped commit
  (`2026-10-atomic-missing-primitives`, `-authority-pivot`, `-missing-truths`,
  `-product-recon`) were restored from `backup/pre-seal-2026-10-20` and
  committed as `ffed151`. The generated `corpus/concat_*.txt` artifacts were
  not restored (they are gitignored outputs).
- `docs/recon/2026-10-ecosystem-recon.md` — the reconnaissance report
  (debrid media systems, VFS layers, players, Plex + the 2026-10-16
  plex2shell RCE disclosure, Jellyfin, the Stremio addon model,
  discovery/indexers, torrent metadata/DHT, source equivalence, playback
  failover, media-server alternatives, user pain, competitive comparison).
- `PLANS.md` — the open-debt table's speculative row (the corpus sidecar) is
  now answerable at the source level; a reconnaissance section states the
  three results and the open commercial question.
- `handoff/CURRENT.md` — the push state is corrected (in sync with
  `github/main`), the recon tooling and its one missing key are recorded, and
  the dropped-stash recovery is written down so the next session does not
  repeat it.

### WHAT WAS PROVEN

- The tree after the rebase equals the sealed tree except for the three
  gitignored generated artifacts (`git diff backup/pre-seal-2026-10-20 HEAD`
  → 3 generated files only).
- The sealed markers survived the replay: `projectVfsRowToAuthority` (2),
  `canonicalProviderPath` (3), `release_attributes.file_path` (8).
- The focused suites after the rebase: the identity set 46/46, the
  VFS/publication/route set 50/50. The full suite was not re-run: the tree
  is byte-identical to the tree that produced 3544/3540/1/3.
- `github/main` = `ffed151` = local `main` (no divergence, no force push).
- The reconnaissance's central fact is source-backed, not asserted:
  bitmagnet's GraphQL `TorrentFile` fragment exposes `infoHash, index, path,
  size, fileType`, and torrust's hash2torrent returns the metainfo for an
  infohash over BEP 9.

### WHAT REMAINS UNPROVEN

- The recon's *readings* (that route repair and durable identity are
  unclaimed, that the free addons absorb the pain) are inferences from the
  observed projects and forums, not measurements of demand.
- The side-car sources were verified by reading their contracts and schemas,
  not by running them. Neither was deployed here.
- The Jellyfin live projection is still environmental-blocked (HTTP 401).
- The baseline failure (`vfs-collection-resilience` C1/C2/C3) is unchanged.

### WHAT WAS LEARNED

- **A dropped stash is still recoverable while its object survives.** A
  `git stash -u` was dropped with the pre-existing untracked user files inside
  it; `git fsck --unreachable` found the stash's untracked-files commit
  (`b4d12bd`) and all seven files were restored untracked. The rule that
  earned this: when unstaging work with `-u`, keep the stash's SHA until the
  work is committed elsewhere.
- **The ecosystem's answer to a dying route is to hide it.** Real-Debrid's
  May-2026 filter-gate removed cached torrents with no announcement and no
  per-file reason; ElfHosted's fix filtered `infringing_file` streams out of
  the result list. Nothing repairs a dead route, and no provider says why
  one died. HashSucker's sealed model is aimed at that hole, and it is
  unclaimed.
- **The exact-file-metadata question is closed at the source level.** The
  verdict is EXISTING SOURCE IS GOOD ENOUGH for the corpus and a
  SELF-HOSTABLE SIDE-CAR IS PRACTICAL for arbitrary infohashes — not "no
  practical source". The side-car's coverage is its crawler's coverage, so
  it complements the provider's inventory rather than replacing it.
- **A consumer is a liability as well as a projection.** Plex disclosed an
  unauthenticated RCE chain on 2026-10-16 (CVE-2026-96652/54/55/56, fixed
  1.43.3.10861). One concrete consequence for this repo: PMS attaches the
  owner's admin token to outbound requests whose URL starts with
  `http://127.0.0.1`, so a `.strm` pointing at a loopback URL is fetched with
  elevated privilege.

### WHAT ASSUMPTIONS CHANGED

- "No practical public source maps an infohash to the exact file tree" →
  false; two self-hostable sources do, and the parked corpus debt is
  unblocked at the source level.
- "The identity work may be unclaimed because it is hard" → the evidence
  points the other way: it is unclaimed because the incumbent addons are
  free and absorb the pain. The open question is commercial.

### WHAT SHOULD BE UPDATED

- `docs/recon/2026-10-ecosystem-recon.md` (new), `PLANS.md`,
  `handoff/CURRENT.md` — done in this slice.

### WHAT SHOULD BE DELETED OR SIMPLIFIED

- `PLANS.md`'s speculative row ("the SOURCE does not") is now answered by the
  recon; the row stays until the sidecar is actually used, but its wording
  was corrected in this slice.
- `handoff/CURRENT.md`'s "main is ahead of github/main" claim — corrected.
- Nothing was deleted from the code. The four restored recon notes are the
  opposite of a deletion: they had been dropped with the artifacts.

### NEXT SMALLEST EARNED SLICE

Not selected — a human disposes. The candidate the recon leaves standing is
the smallest one it already named: give the corpus a per-file path from a
source that has one (a bitmagnet sidecar or a hash2torrent fetch), which
would let the size-only selection disappear. Its precondition is now a
source, not an invention.

## 2026-10-20 — RECON ROUND TWO: THE PIVOT WE MISSED — CLOSED

Slice: reconnaissance only, run adversarially. Round one had concluded "no
fundamental shift"; that conclusion was treated as a hypothesis to break,
with searches run by user behavior instead of by project category, and every
HashSucker assumption searched for its contradiction. No code, no seam
selection, no moonshot selection.

### WHAT CHANGED

- `docs/recon/2026-10-recon-round-two-the-pivot.md` — the round-two report.
- `docs/recon/2026-10-ecosystem-recon.md` — demotion note: two of its
  readings are superseded (the duplicate-version pain is largely historical;
  the "no fundamental shift" reading was drawn from a taxonomy of projects,
  not from behavior).
- `PLANS.md`, `handoff/CURRENT.md` — the verdict, what it demotes, what it
  promotes, the counterevidence, and the three falsifiers.

### WHAT WAS PROVEN

Everything below is source-backed with a URL and a date, and was read in the
source (project docs, changelogs, pricing pages, forum search APIs, the
public GitHub API, Hacker News' Algolia API), never inferred from a summary.

- **The pivot (surface + identity ownership).** The 2026 entrants are
  clients and hubs, not libraries: Hound (476★, a tracker repurposed into a
  hybrid server), Debrify (620★, one hub over cloud/WebDAV/IPTV/Stremio
  with cross-source resume), VortX (238★, native Apple TV/Android, tvOS via
  sideloading, resolves raw magnets), SkyStream (637★, extension-driven,
  no sources by default), MovieBox-TUI (2552★ in three months), Slate
  (2026-04, a watchlist with no server and AI intent search), K7 (333★,
  federated, family-scale), Fathom (116★, mpv-native client that owns the
  workflow). Hound's author states the behavioral thesis explicitly:
  "it still can't beat finding something, pressing play, and watching
  immediately, in seconds"; "someone requests a full show, watches the
  first episode, and loses interest in 10 minutes"; the family "still
  preferred Netflix anyway" after the whole suite was deployed.
- **The provider layer became a SKU.** ElfHosted's Debridge (2026-06-12):
  "one key, every provider, one mega-cache" — the multi-provider doctrine
  HashSucker encodes is now purchasable.
- **The file tree became a commodity input.** The tree is a `.torrent`
  file; indexers serve it; side-cars serve it (bitmagnet's GraphQL,
  torrust's hash2torrent); `brotherguns/torbox-cache-checker` takes a
  `.torrent` and asks a provider whether it is cached.
- **The intent layer consolidated and the *arr decayed.** Overseerr and
  Jellyseerr merged into Seerr (2026-02-17); Readarr is retired; Sonarr v3
  is end-of-life.
- **The consumer got worse and cheaper at once.** Plex's free tier is now
  ad-supported, Plex Pass is $2.99/mo, and the 2026-10-16 unauthenticated
  RCE is being exploited (Ars Technica, 2026-10-20). Infuse Pro: $1.99/mo,
  $16.99/yr, $99.99 lifetime. ElfHosted: $9/mo per app, bundles cheaper,
  storage explicitly bring-your-own.
- **Freshness, not organization, is the live pain.** RD's filename filter
  (May 2026, tightening through June) hits brand-new WEB-DL/WEBRip releases
  hardest; TorBox's DDoS weekends took the API offline for users with a
  single provider.

### WHAT REMAINS UNPROVEN

- Demand. Every entrant above is a project, not a business; Hound is 476★
  and in beta.
- Whether "repair" is a product at all: the ecosystem answered the RD
  filter-gate by hiding broken streams, and users accepted that.
- The presentation identity's pain case is weaker than round one claimed
  (the duplicate-version threads are 2015–2022).
- Nothing here was implemented or measured; no product state was touched.

### WHAT WAS LEARNED

- **A category can die without its users noticing, because the money moves
  first.** Nobody pays for a media library, a scanner, an identity layer, an
  exact-file identity, or autonomous repair. They pay for the player, the
  wiring, the provider union and the instant stream.
- **Round one's method was the weakness.** Taxonomizing projects by category
  hides a shift that is visible only in behavior and in what people pay for.
  The same corpus, re-read adversarially, produced a different conclusion.
- **A pivot can raise the value of the architecture and still invalidate the
  product.** The sealed chain is what a client-first hub needs and nobody
  has; the published Plex/Jellyfin library entry is the surface the market
  is leaving.
- **The strongest counterevidence to a pivot is a business that keeps
  selling the old shape.** ElfHosted's bundles (player + *arr + debrid,
  storage not included in the price) are the reason the surface pivot is
  "possible" rather than "certain".

### WHAT ASSUMPTIONS CHANGED

- "No fundamental shift" → **PIVOT FOUND** (surface + identity ownership),
  architecture unaffected.
- "A persistent media library is what the product protects" → the durable
  artifact is per-title state and a queryable identity; the library is a
  view.
- "The provider abstraction is our architecture" → it is purchasable.
- "The corpus is ours to ingest" → the file tree is an input to query, not a
  corpus to own.
- "The presentation identity's pain is the duplicate-version complaint" →
  that complaint is largely historical; the live pains are freshness,
  availability and metadata correctness.

### WHAT SHOULD BE UPDATED

- `docs/recon/2026-10-recon-round-two-the-pivot.md` (new),
  `docs/recon/2026-10-ecosystem-recon.md` (demotion note),
  `PLANS.md`, `handoff/CURRENT.md` — done in this slice.

### WHAT SHOULD BE DELETED OR SIMPLIFIED

- Nothing was deleted from the code. This slice changed no source file.
- One claim was demoted rather than deleted: the duplicate-version evidence
  in round one is marked historical in place.

### NEXT SMALLEST EARNED SLICE

Not selected — a human disposes. The three falsifiers recorded in
`PLANS.md` are the honest next step, and each is answered by a product test
on the resolver surface (intent → playable source, callable by any client),
not by more architecture.

## 2026-10-20 — PSYCHEDELIC MOONSHOT RECON: what if HashSucker owned the experience? — CLOSED

Slice: recon + product architecture only. No code, no client, no BitTorrent
integration, no roadmap change. Four parallel external research streams
(player substrates; torrent engines; VPN isolation + cold-start latency;
representation equivalence + semantic front door) plus a grounding read of
the sealed local model. The question: if HashSucker owned both source
resolution and the playback client, what parts of the traditional
media-server model become unnecessary?

### WHAT CHANGED

- `docs/recon/2026-10-psychedelic-moonshot-recon.md` — the report.
- `PLANS.md`, `handoff/CURRENT.md` — the recommendation and the four facts a
  next session needs.

### WHAT WAS PROVEN

- **The resolver surface already exists.** `/stream/:type/:id` is derived from
  content identity and is "stable forever"; the `.strm` file is one line
  containing it. The gap is not the surface but its *transport*: `/stream`
  answers `307` to the provider, so the client leaves HashSucker's boundary
  and the route can no longer be changed under it, while the proxying paths
  (`/vfs`, `/media`) can fail over transparently. **Proxying instead of
  redirecting is the single highest-value small change this recon found.**
- **The client does not need a server-side time→byte index.** Measured on mpv
  0.41 against an instrumented Range server: a seek to 12 s on MKV requested
  `bytes=1106860-` — the client derived the offset from the container's own
  index (2 requests for faststart MP4, 4 for moov-at-end MP4, 3 for MKV).
  The existing Range contract is already correct.
- **mpv is the only substrate with an invisible in-flight route swap.**
  `mpv_stream_cb_add_ro` (own the byte layer) was built and measured: the
  backing HTTP origin was swapped mid-playback with zero `START_FILE`/
  `END_FILE` events and monotonic `time-pos`. mpv also auto-resumes after a
  mid-body truncation, which is more forgiving than our documented contract
  assumes. AVFoundation, ExoPlayer, libVLC and GStreamer all lose position
  or require glue on a source swap; Dolby Vision is native only on Apple.
- **Direct BitTorrent is feasible but not worth building now.** rqbit's HTTP
  Range endpoint is a drop-in `runtime_url` for the existing
  `DeliveryCapability`; librqbit exposes exactly the file-tree facts
  HashSucker needs (`{name, components, length}`). Against that: swarm
  metadata has a 2–3 minute tail (rqbit #441) and an unbounded one; a swarm
  stall looks like a slow CDN, so the current breaker would kill a healthy
  route; `disable-upload` does not suppress tracker announces; and the
  "advertise bytes we already hold" feature (rqbit #705) is unmerged.
- **VPN isolation has a clean answer.** A network namespace owned by a VPN
  process whose firewall is unconditional (gluetun's model), a health
  endpoint as the honest tunnel signal (`/v1/vpn/status` reflects the
  reconnect loop, not the tunnel), a fail-closed capability gate
  (tunnel up ∧ egress IP matches ∧ leak probe passes), and the VPN state as
  a route property that never enters the identity tuple. The failure mode to
  design around: a dead WireGuard tunnel silently drops packets, so a
  connection *hangs* rather than resetting — route failure must be driven off
  the health endpoint, not off the socket error.
- **Cross-representation continuity stays research.** The prior
  temporal-correspondence experiment is stronger than it looked: 0 false
  positives on the scored negatives, one real positive (Matrix, corr
  1.000/0.968/0.985), one ambiguous pair, four negatives rejected at 0/10
  coverage. Its ingredients are now mature and permissively licensed
  (Chromaprint MIT 2.0 ms/s; vPDQ/TMK BSD; ISCC Video-Code Apache-2.0;
  ffmpeg `ssim`/`libvmaf`; ffsubsync), but the confidence model is
  uncalibrated, the cost is off the play path, and metadata is a reject-only
  gate.
- **Press-play latency is a corpus decision.** HashSucker's own measurement:
  request→206 p50 1052 ms / p95 1532 ms on cached TorBox. The path is
  strictly sequential only at metadata→exact-file→availability→materialise;
  everything else can race. The uncached-debrid and direct-swarm cases cannot
  be made to feel immediate because the bytes do not exist yet.
- **Nobody in the client-first ecosystem owns route authority.** Debrify
  re-resolves expired links in Dart; VortX carries the playhead across a
  source swap; MovieBox-TUI proves a client can be a CLI that hands mpv a URL
  and headers; Slate proves a watchlist is a complete product. Nobody owns
  "which exact file is this, and what happens when that route dies".

### WHAT REMAINS UNPROVEN

- Whether a resolver-first shape can *show* its value. Exact identity, stable
  representation and autonomous repair are invisible in a generic player.
- ExoPlayer's and AVFoundation's runtime behaviour (source-level evidence
  only — no Android or Apple hardware here).
- The cold-start latency of a direct swarm: no credible public benchmark
  exists; the only figure (6–10 s) is blog-grade.
- The corpus's MP4-faststart-vs-MKV ratio, which decides whether the
  moov-at-end extra round-trip matters at all.
- Whether gluetun's WireGuard path rejects or drops on tunnel loss (both
  exist in source; the call site was not traced) — so "fail fast vs hang" is
  not established and our own socket timeouts must not assume it.
- The semantic front door's licence position: TMDB's terms forbid use in
  connection with an AI-based application without written permission.

### WHAT WAS LEARNED

- **A pivot can move the product edge without touching the architecture.**
  The durable chain, the exact identity model, the Binding, the route
  separation, the delivery evidence, the representation policy and the
  autonomous recovery all survive every plausible shape.
- **The interesting object is the route, not the file.** A stable URL that
  survives route changes is the real primitive; the VFS is one transport for
  it, and a redirect is the one transport that destroys it.
- **A proxy versus a redirect is the difference between transparent failover
  and none.** This was invisible until the client was imagined.
- **Deferring a backend is free when the seam is right.** `DeliveryCapability`
  is already provider-agnostic, so the swarm decision can be deferred without
  re-architecting anything — which is exactly the property the recon needed
  to make "defer" a safe recommendation rather than a dodge.
- **The industry resolves "same content, different version" by IDs and
  policy, never by proof** (SMPTE IMF deltas; NAGRAVISION's IMDb-ID plus a
  policy score). That is the gap HashSucker is in — and it is a gap nobody
  is paying to close.

### WHAT ASSUMPTIONS CHANGED

- "The client needs the server to expose a seek index" → false; the client
  derives it from the container.
- "A route swap interrupts the player" → false for mpv with an owned byte
  layer; true for every mainstream substrate's public API.
- "A swarm route could be a first-class route" → it must be a fallback with
  its own health semantics; the availability semantics invert.
- "Our mid-body truncation contract matches the player's" → the player is
  more forgiving than the contract assumes.
- "The presentation identity's pain is duplicate versions" → largely
  historical (round two); the live pains are freshness, availability and
  metadata correctness.

### WHAT SHOULD BE UPDATED

- `docs/recon/2026-10-psychedelic-moonshot-recon.md` (new), `PLANS.md`,
  `handoff/CURRENT.md` — done in this slice.

### WHAT SHOULD BE DELETED OR SIMPLIFIED

- Nothing was deleted from the code; this slice changed no source file.
- The conceptual cut is recorded: Plex/Jellyfin publication, the `.strm`
  tree and the WebDAV VFS become a compatibility layer; the provider
  abstraction and corpus ingestion are re-shaped; the requested-season
  scheduler and Cinemeta become client-side or proposal-only.

### NEXT SMALLEST EARNED SLICE

Not selected — a human disposes. The candidates the recon leaves standing,
in order of information per cost: (1) a `hashsucker://` mpv custom protocol
plus a one-command CLI against the proxying path, proving the resolver
contract from a real player and making same-TorrentFile failover invisible;
(2) a resolver API in the Stremio-addon shape; (3) speculative resolution on
item focus; (4) a direct-swarm capability, whose only required outcome is
the measured cold-start number.

## 2026-10-20 — OWN THE PLAYBACK URL: the playback object — CLOSED

Slice: **PIVOT SLICE 1**. `/stream` must stop handing control away with a
`307` to a provider-backed URL; instead one HashSucker-owned URL, bound to one
authoritative TorrentFile, proxies the bytes through the existing
authoritative byte path. The product claim to prove: *the client opens one
HashSucker URL bound to one authoritative TorrentFile; route changes
underneath that TorrentFile are invisible to the client.*

### WHAT CHANGED

- `media-search/src/lib/resolver/playback-object.js` — the playback object: a
  signed, opaque, expirable token over `{version, torrentFileId, expiresAt}`.
  Stateless: no new persistence table, and the signing secret is
  configuration, so a restart does not invalidate an outstanding URL.
- `media-search/src/server/playback-route.js` — `GET|HEAD /play/:token`.
  Resolves the token to a TorrentFile id and then calls the **same**
  `serveAuthoritativeBytes` the `/bytes/:tfId` route uses. No second byte
  implementation.
- `media-search/src/server/app.js` — `STREAM_BYTE_ROUTE=playback` makes
  `/stream` mint a playback object and answer `307 → /play/<token>`. Under
  that policy the resolver **never** falls back to a provider redirect: with
  no authoritative Binding it answers `409 NO_AUTHORITATIVE_BINDING` before
  touching a provider API.
- `media-search/src/scripts/playback-latency.mjs` — the measurement harness
  (resolve hop, first byte, optional mpv first frame, provider-leak guard).
- `compose.yaml` — `PLAYBACK_TOKEN_SECRET` / `PLAYBACK_TOKEN_TTL_SECONDS`
  passthrough. The production `STREAM_BYTE_ROUTE` is unchanged (`cached`).
- Docs: `docs/playback-delivery.md` (§1a the resolver-first surface, the
  contract, the error model; §7 pointing a player at a playback object),
  `docs/architecture.md` §2 (the playback object as a derived runtime
  identity grain), retrospective
  `docs/retrospectives/2026-10-20-own-the-playback-url.md`.

### WHAT WAS PROVEN

Production appliance (`hashsucker-media-search-1` on the rebuilt image):

- **A movie** — `City.Lights.1931.1080p.BluRay.x265-RARBG.mp4`,
  infoHash `abe45dc4…`, exact size 1452039706, dual route (TorBox
  `provider_file_id=2` and Real-Debrid `provider_file_id=1`, both `ready`,
  both `mapped`, both agreeing on the exact size). `GET /play/<token>` with
  `Range: bytes=0-1023` → `206`, `content-range: bytes 0-1023/1452039706`,
  `accept-ranges: bytes`, `cache-control: no-store`. The bytes are
  **byte-identical** to the same range through `/bytes/:tfId` (`cmp` clean).
- **An episode** — `tf_2c3a7f11…` (4K HEVC, 5429742371 bytes) → `206`,
  `content-range: bytes 0-5429742370/5429742371`.
- **mpv as the external client** (Phase 8, all of it): startup ✓, duration
  detected 5207.203 s ✓, **first frame 666 ms** ✓, seek forward to 3600 s ✓
  (playback-time 3601.06) ✓, seek backward to 60 s ✓ (61.35) ✓, near EOF
  (5187.2 → 5188.68) ✓, clean stop ✓ (mpv exit 0) ✓. **No provider URL
  appeared anywhere in the client's request chain** ✓ — the only URL mpv
  opened was the HashSucker playback object ✓.
- **Overhead** (Phase 7), same TorrentFile, same ranges, 5 runs each: byte
  route median **3.3 ms**, playback object median **3.6 ms**; a mid-file seek
  2.6 ms vs 3.0 ms; a healthy re-request 2.9 ms vs 3.1 ms. All statuses 206.
  The delta is one HMAC verification — negligible against playback.
- **Same-TorrentFile failover**: the data plane's own deterministic suite
  passes (`cargo test --test same_tf_route_recovery` → **11/11**), including
  `r1_primary_lost_alternate_recovers_same_torrent_file` and r2a–r2e, whose
  assertion is that *the client still gets the full bytes* when a lane dies.
  The proxy in front of it is proven transparent: every attempt asks the data
  plane for the same TorrentFile at the same upstream path (test P9), and the
  response never carries a provider URL, a provider name or a location header
  (test P11).
- **Security** (Phase 6): the response headers are exactly `content-type`,
  `content-length`, `content-range`, `accept-ranges`, `cache-control` — the
  serving-attribution headers are consumed operator-side and never reach the
  client; a tampered token is `403`; an expired token is `410`; an invalid
  token never reaches the byte path; the token is stateless, so it is not
  replayable against a rotated secret and not invalidated by a restart.
- **Tests**: 15 new (`test/playback-object.test.js`) — the authoritative TF
  resolves, the URL is provider-independent, Range/seek correctness, client
  disconnect tears the upstream down, same-TF route change leaves URL and TF
  unchanged, a different TF cannot silently satisfy the URL, no provider
  leakage, the resolver mints a playback object and never a provider
  redirect, the no-Binding case fails loudly, and the provider policy is
  untouched.
- **Full suite**: 3559 tests, 3555 pass, 1 fail, 3 skipped (exit 1). The one
  failure is the pre-existing baseline `vfs-collection-resilience` C1/C2/C3.

### WHAT REMAINS UNPROVEN

- **The forced end-to-end production failover was not performed.** Forcing a
  provider failure in production is out of bounds, and the production data
  plane's own failover counter is `0` — no failover has occurred there, so
  there is no observed production instance to cite. The claim is therefore
  stated as the composition of two proven facts (the data plane fails over
  inside one request; the proxy never retargets) plus a production proof that
  the playback object serves a **dual-route** TorrentFile — not as a single
  observed production failover.
- The playback policy is **not enabled in production**. `STREAM_BYTE_ROUTE`
  stays `cached`, so the `.strm` / Plex / Jellyfin path is unchanged. The
  resolver-first path is proven by unit/integration tests and by the playback
  object route itself, which is live.
- Cross-representation continuity is out of scope by the slice's own terms.
- The `PLAYBACK_TOKEN_SECRET` rotation procedure is undefined; a rotated
  secret invalidates outstanding URLs (a client re-resolves via `/stream`).

### WHAT WAS LEARNED

- **The seam was already paid for.** `/bytes/:tfId` and the Rust same-TF
  failover existed; the slice was binding, not building. The capability
  abstraction made "own the URL" a ~200-line change.
- **A derived runtime identity needs no table.** A stateless signed token over
  a durable id is restart-safe and tamper-evident; the earlier worry ("where
  do we persist the session?") was the wrong question.
- **The client computes seeks.** mpv derived the byte offset from the
  container's own index; the server needed no seek API.
- **The proxy hop was already there.** The overhead of owning the URL is
  ~0.3 ms (one HMAC), because the HashSucker byte path already proxied.
- **Fail early, not late.** The no-Binding guard had to move *before* the
  provider ladders for the new policy; the cached policy's guard is late by
  design, and copying its placement would have touched a provider API before
  failing.

### WHAT ASSUMPTIONS CHANGED

- "Owning the playback URL requires new persistence" → false ✓.
- "A stable URL must expose something verifiable" → false ✓; the contract is
  the *absence* of provider detail ✓.
- "The proxy adds a hop that matters" → no ✓ (~0.3 ms ✓).
- "`/stream` normally leaks a provider URL" → mostly false ✓: the compose
  default is `cached` ✓; the leak is the no-Binding / Real-Debrid branch ✓ ✓.

### WHAT SHOULD BE UPDATED

- `docs/playback-delivery.md` ✓, `docs/architecture.md` §2 ✓,
  `docs/retrospectives/2026-10-20-own-the-playback-url.md` ✓ (new),
  `PLANS.md` ✓, `handoff/CURRENT.md` ✓ — done in this slice.

### WHAT SHOULD BE DELETED OR SIMPLIFIED

- Nothing was deleted. One simplification is *recorded for later*: `/bytes/:tfId`
  and `/play/:token` are two public doors onto one byte path; once the
  resolver-first surface is proven in production, `/bytes/:tfId` should
  become an alias or be retired rather than kept as a second door ✓.

### NEXT SMALLEST EARNED SLICE

Not selected — a human disposes. The candidates this slice leaves standing:
(1) enable `STREAM_BYTE_ROUTE=playback` on the appliance and re-run the
`.strm` / Plex compatibility proof (the surface is additive and the blast
radius is one redirect header); (2) give the playback object a session
contract (position, subtitle/audio preference, continuity) so a client can
resume a session across a token expiry; (3) a provider-leak guard over the
whole resolver response set (not just the playback object) ✓ — the harness
already knows how ✓.

## 2026-10-20 — PLAYBACK ROUTE COMPATIBILITY: the new byte route does not break the old product — CLOSED

Slice: **PIVOT SLICE 2**. Enable `STREAM_BYTE_ROUTE=playback` on the appliance and prove the
existing consumer path (`.strm` → Plex/Jellyfin → HashSucker → authoritative TorrentFile → Rust
bytes) still works unchanged through the HashSucker-owned playback boundary. A compatibility
slice, not a feature slice: no client, no session state, no direct torrent, no representation
policy change.

### WHAT CHANGED

- **Configuration only.** `STREAM_BYTE_ROUTE=playback` in the appliance's `.env` (host
  configuration, not tracked), and the `media-search` container recreated to pick it up. The
  source did not change for this slice; one regression test was added.
- `media-search/test/playback-object.test.js` — `P16 — switching the byte route mutates no
  durable state`: under both policies the resolver reads the Binding and writes nothing to the
  control plane.
- `docs/playback-delivery.md` — the production state of the route and the rollback property.

### WHAT WAS PROVEN

**The cohort (four fixtures: two dual-route movies, one single-route movie, one TV episode),
before and after the flip, same fixtures, same measurements:**

| invariant | before | after |
|---|---|---|
| `.strm` count / content | 1 / 1 / 4 / 1 | **identical** |
| Plex `ratingKey` | 423 / 514 / 377 / 489 | **identical** |
| Plex `Part.file` | `/mnt/hashsucker-vfs/…` | **identical** |
| Plex `Part.size` | 1452039706 / 6499499430 / 8453206325 / 4340539373 | **identical** |
| Binding → TorrentFile | `tf_c0656148…` / `tf_1355e37f…` / `tf_149c41e9…` / `tf_287b5593…` | **identical** |
| VFS canonical path + VFS TorrentFile | — | **identical** |
| presentation identity + `presentation_committed_at` | — | **identical** |
| provider routes (provider, state, mapping) | 2 / 1 / 2 / 1 | **identical** |
| first `206` + `Content-Range` | 206, exact | **identical** |
| seek forward / backward / near EOF | 206 / 206 / 206 | **identical** |
| clean stop | aborted cleanly | **identical** |
| provider URL or credential in any hop | none | **none** |
| **resolver byte route** | `data-plane` → `/bytes/:tfId` | **`playback-object` → `/play/<token>`** |

The only fields that changed are the two the slice was supposed to change.

**The real consumer path (Plex HTPC canary, a genuine PMS session):** passes on the playback
route — the session is created, the identity matches, playback progresses, the forward, backward
and near-EOF seeks all resolve, and the stop tears the session down (`stopToPmsGone` 108 ms,
`stopToIdle` 164 ms, `pass: true`). The baseline canary run on the `cached` route also passed
(`stopToPmsGone` 27 ms, `stopToIdle` 37 ms). One baseline run failed with the **documented,
pre-existing** `PMS_SESSION_NOT_CREATED` condition (PMS's SQLite busy-database wait expiring
because the library scanner holds the write lock — `src/PRODUCTION-PLAYBACK-TESTING.md`, diagnosed
2026-10-12); the retry passed. That failure is not caused by this slice: it was observed with the
`cached` route still live.

**The observed request chain** (from the edge's access log — the consumer's own view):

```
GET /stream/movie/tt0075686                    → 307, Location: /play/<token>
                                                   X-Hashsucker-Byte-Route: playback-object
                                                   X-Availability-Source: authoritative-binding
                                                   X-Provider-Check-Occurred: false
GET /play/<token>  Range: bytes=0-1023           → 206, Content-Range: bytes 0-1023/4340539373
GET /play/<token>  Range: bytes=2170269686-…     → 206   (the forward seek)
GET /play/<token>  Range: bytes=0-1023           → 206   (the backward seek)
GET /play/<token>  Range: bytes=4340537325-…     → 206   (the near-EOF read)
GET /play/<token>  Range: bytes=0-1048575        → 206   (the read-ahead)
```

One stable URL for every request; no provider host appears in any hop; the resolver touched no
provider API (`X-Provider-Check-Occurred: false`). HashSucker's own consumer observer recorded the
session against the exact TorrentFile (`accepted=yes`, `plex-session-progress`).

**Same-TorrentFile dual-route proof (observational, as required):** City Lights
(`tf_c0656148…`) and Rear Window (`tf_149c41e9…`) each carry two `ready`/`mapped` routes (TorBox
and Real-Debrid) that agree on the exact size, and each is served through one playback object.
No destructive provider failure was manufactured; the transition itself remains covered by the
data plane's deterministic suite (`cargo test --test same_tf_route_recovery` → 11/11, including
"the client still gets the full bytes").

**Overhead (warm, 9 runs each, same fixture):**

| | `cached` | `playback` | delta |
|---|---|---|---|
| resolver hop (median) | 3.89 ms | 5.15 ms | +1.26 ms |
| first 206 (median) | 47.2 ms | 47.85 ms | +0.65 ms |
| seek (median) | 49.05 ms | 47.61 ms | −1.44 ms |
| healthy re-request (median) | 50.26 ms | 48.97 ms | −1.29 ms |

Near-noise: the run-to-run ranges overlap in both modes (the first byte ranged 12–72 ms in each).
The canary agrees — first-read TTFB 11 ms before, 13 ms after; session→first read 117 ms before,
103 ms after.

**Rollback is configuration-only (Phase 8):** flipping `playback → cached → playback` changes the
resolver's answer and **nothing else** — the identity-bearing fingerprints of `library_items`,
`bindings`, `library_paths`, `torrent_files`, `provider_placements`, `provider_files` and
`exposures` are byte-identical across the flips. (The full-row hashes of `library_items` and
`exposures` do drift, but only in observation timestamps: `updated_at`/`last_played_at` from the
consumer playback observer and `observed_at`/`expires_at` from the exposure observer. Neither is
identity, and neither is touched by the flag.)

### WHAT REMAINS UNPROVEN

- **Jellyfin's live playback is environmentally blocked.** `GET /System/Info` on the appliance's
  Jellyfin returns **HTTP 401** — the configured `JELLYFIN_API_KEY` is rejected. The Jellyfin
  *path* is characterized (it consumes the same `.strm` → `/stream` → playback-object → bytes
  chain, and the chain is proven through Plex and through mpv), but no live Jellyfin session was
  observed. This is the same pre-existing environmental debt recorded in `PLANS.md`; the
  credential must be replaced before Jellyfin can be proven.
- **No movie was played through a real Plex session.** The canary's application bridge hard-codes
  `type: 'episode'`, so the Plex-session proof is an episode (Lanterns S01E05, ratingKey 514).
  The movies are characterized through the same `.strm` → resolver → bytes chain with their full
  Plex identity recorded (ratingKey, `Part.file`, `Part.size` unchanged) and their seeks and
  near-EOF reads passing.
- The forced end-to-end production failover was not performed (provoking provider failures for
  confidence is out of bounds); the production data plane's failover counter remains `0`.
- The playback-object route was not exercised by a **Jellyfin** client, and the token's expiry
  behaviour under a long session was not re-measured here (the TTL is 24 h).

### WHAT WAS LEARNED

- **The consumer does not care about the byte route.** Plex followed the `307` to a signed,
  opaque, per-item URL without a hiccup: the same session, the same identity, the same bytes,
  the same seeks. The playback object is invisible from the consumer's side — which is the point.
- **The route is genuinely configuration.** Two container recreates and two flips produced zero
  durable identity difference. The rollback path is free.
- **The measurement that first looked like a regression was cold-start.** The first after-run
  showed +50 ms on the first byte; that was the data plane's cache after a container recreate,
  not the route. A warm 9-run median on both sides shows the real delta is inside the noise.
- **The edge already proxies the new path.** The `.strm` points at the edge
  (`http://localhost:8080/stream/…`), and the edge passes `/play/<token>` through unchanged
  (verified byte-identical against the container's direct path) — the resolver-first surface
  needed no edge change.
- **The pre-existing PMS session-creation flake is still there.** The canary failed once on the
  baseline (`PMS_SESSION_NOT_CREATED` — PMS's busy-database wait expiring under the scanner's
  write lock, with HashSucker's own section refreshes as a documented amplifier) and passed on
  retry. It is a real, diagnosed, pre-existing condition and it is *not* fixed by this slice.

### WHAT ASSUMPTIONS CHANGED

- "Changing the byte route could disturb the consumer's identity or publication" → false ✓; every
  identity invariant is byte-identical across the flip ✓ and no `.strm` was rewritten ✓.
- "The playback object might need the edge to learn a new route" → false ✓; the edge already
  proxies it ✓.
- "A signed URL might confuse a real Plex client" → false ✓; the canary's session was created and
  progressed normally ✓.

### WHAT SHOULD BE UPDATED

- `docs/playback-delivery.md` (the production state of the route + the rollback property ✓),
  `docs/BUILD-LOG.md` ✓, `PLANS.md` ✓, `handoff/CURRENT.md` ✓ — done in this slice.

### WHAT SHOULD BE DELETED OR SIMPLIFIED

- Nothing was deleted. `/bytes/:tfId` is now a compatibility alias of `/play/:token>`: the
  resolver no longer emits it under the production policy ✓, but the route remains public ✓.
  It should be folded in or retired when the compatibility window closes — not before ✓.

### NEXT SMALLEST EARNED SLICE

Not selected — a human disposes. The candidates this slice leaves standing: (1) the tiny
**resolver→mpv reference client** (the next slice the product direction names — a thin client that
calls the resolver and plays, proving the contract from a client's side); (2) retire
`/bytes/:tfId` as a public alias once the compatibility window closes ✓; (3) replace the Plex
section refresh that amplifies PMS's scanner contention ✓ (a pre-existing, diagnosed defect that
blocks the canary's reliability ✓).

## 2026-10-20 — THE TINY RESOLVER CLIENT: one command from intent to playback — CLOSED

Slice: **PIVOT SLICE 3**. Prove the resolver-first path end-to-end without Plex:
one small command accepts a media intent, resolves it through the existing
HashSucker authority, opens the stable playback object in mpv, and measures
first-frame behavior. A reference client, not a product client.

### WHAT CHANGED

- `media-search/src/api/playback-object.js` — the server side: a thin adapter
  over the authority that already exists. A title resolves through the existing
  metadata search (`searchTitles`); a media id resolves through the existing
  request pipeline (`searchByMedia`); the control plane's active Binding names
  the exact TorrentFile the playback object is bound to. **The warm path
  performs no discovery, no provider inventory and no provider API call** — it
  reads the Binding and mints the object. The cold path runs the same request
  pipeline a Seerr request runs, then mints the object.
- `media-search/src/server/app.js` — `POST /api/playback-object`. Typed
  failures: `AMBIGUOUS_INTENT` (409, with the candidates),
  `INTENT_NOT_FOUND` (404), `EPISODE_COORDINATES_REQUIRED` (400),
  `NO_AUTHORITATIVE_REPRESENTATION` (409), `PLAYBACK_OBJECT_UNAVAILABLE`
  (503). No provider state, credential or URL in any response.
- `media-search/tools/hs/` — the client: `main.mjs` (the command),
  `mpv.mjs` (the player + the measurement), `bench.mjs` (the reusable
  harness). `npm run hs -- play <intent>`.
- `media-search/test/playback-object-api.test.js` — 15 tests.

### WHAT WAS PROVEN

**The command works.** `hs play tt0021749` resolved in 40–60 ms, the player
loaded in 478–639 ms, and the **first frame landed in 1070–1286 ms** with
zero manual actions and one resolver attempt.

**The warm cohort (10 runs, City Lights):** 10/10 played; manual actions
`[0×10]`; resolver attempts `[1×10]`; resolver min 40 / p50 41 / p95 60 /
max 60 ms; player startup min 478 / p50 493 / p95 639 / max 639 ms; first
frame min 1070 / p50 1286 / p95 1286 / max 1286 ms.

**The episode cohort (10 runs, Lanterns S01E02):** 9/10 played; resolver min
40 / p50 45 / p95 58 / max 58 ms; player startup min 3262 / p50 3410 ms; first
frame min 5291 / p50 12948 ms. One run failed with the player dying
(`ipc socket closed`).

**A title works, and ambiguity fails safely.** `hs play "Alien"` produced 25
legitimate matches (Alien, Alien: Covenant, Resident Alien, Ben 10: Alien
Force, My Stepmother Is an Alien, …), printed them numbered, asked, and on
"1" resolved to `tt0078748` — **one manual action**, two resolver attempts,
warm, and it played. The server never chose: `AMBIGUOUS_INTENT` carries the
candidates and the client asks.

**TV identity is exact.** `hs play tt26545992 --season 1 --episode 2` resolves
to the episode's own TorrentFile (`tf_5f6b4e16…`), and a series intent
without coordinates is refused (`EPISODE_COORDINATES_REQUIRED`) — there is no
S00E00 and no movie/TV ambiguity in the client path.

**The cold path is accounted for.** `hs play tt0068281` (Black Gunn — no
library item) ran the request pipeline and failed with the typed
`NO_AUTHORITATIVE_REPRESENTATION`. The *existing* `/api/media-prepare` for the
same intent shows why, in 1498 ms: the corpus retrieval found 5 candidates
(no live discovery), the ranking selected `Black.Gunn.1972.1080p.BluRay.x265-RARBG.mp4`
(rank 1, score 0.729, identity tier **Verified**), the exact TorrentFile was
identified (`tf_e53dba9d…`), and the provider state was **uncached** — so the
VFS materialization (which creates the Binding) cannot complete. The cold
waterfall is therefore *fully timed* (corpus 0 ms live calls, ranking 0 ms,
selection + identity 1.5 s) and *fully accounted for* — but it cannot finish
in this deployment without a provider acquisition, which is the product's own
business and out of scope for this slice. A second cold fixture
(`tt0123366`) failed the same way.

**Token expiry is characterized.** The server side is proven by test: an
expired token is `410 PLAYBACK_TOKEN_EXPIRED`, and a re-resolve returns the
**same TorrentFile** with a **fresh URL** (A9). The player side is observed:
mpv against a `410` answers `Failed to open … HTTP error 410 Gone` and exits,
so the client's bounded re-resolve (re-resolve once, keep the local playhead)
is reachable. The client's end-to-end retry was **not** exercised live — the
fake-server run was inconclusive — so it is recorded as implemented, not
proven.

**Plex versus the direct path (Phase 13), same appliance, different
consumers:** the Plex HTPC canary measured session→first-read **103 ms**,
first-read TTFB **13 ms**, and start→progress **10 603 ms** (the Plex
application's own startup dominates); the direct client measured resolver
**41 ms**, player startup **493 ms**, first frame **1286 ms**. The direct path
reaches a playing frame in ~1.3 s against ~10.6 s for the Plex client path —
with the caveat that the Plex number includes the Plex application's startup
and that the two paths read different byte sources (the Plex path reads the
**local VFS file**, the direct path reads the **provider bytes**). Plex is not
"bad" here: its 13 ms read is faster than the direct path's, because the
local file is local.

**Nothing leaks.** The API response carries the media identity, the display
title, the authoritative TorrentFile id and the playback URL — and no
provider, placement, capability, credential or URL (asserted in A5 and A13).
The client prints only the title, the media id, the timings and the error
code.

### WHAT REMAINS UNPROVEN

- **The cold path cannot complete** in this deployment without a provider
  acquisition (the release is uncached at the provider). The prepare stage
  succeeds and is fully timed; the materialization does not.
- **The client's expiry retry** is implemented and its two components are
  proven (the server's re-resolve; mpv's 410), but the end-to-end retry was
  not exercised live.
- **The episode fixture's player failure** (1 of 10 runs; the player died) is
  unexplained. A separate finding: the 6.5 GB MP4 of Lanterns S01E05 has a
  `udta` box that ffmpeg's mov demuxer rejects (`UDTA parsing failed
  retrying raw`) — it plays through Plex but not through mpv, over HTTP **and**
  from the local mount. That is a player limitation, not a HashSucker one,
  and it is the sharpest illustration of what the resolver-first path
  inherits: the client is only as good as its demuxer.
- No movie was played through a real Plex *session* (unchanged from slice 2 —
  the canary's bridge hard-codes `type: 'episode'`).
- The client is developer-grade: no packaging, no installer, no auto-update.

### WHAT WAS LEARNED

- **One command is enough.** `intent → authority → stable URL → mpv` with no
  Plex, no Jellyfin, no source picker and no provider URL. The warm path's
  whole cost is 41 ms of server time; the player's own startup dominates.
- **The client inherits the player's limits.** The same bytes that Plex plays
  are unplayable by mpv when ffmpeg's mov demuxer rejects the container. A
  resolver-first product must own the player or accept the player's ceiling.
- **The direct path is slower to the first byte than the local path, and
  faster to the first frame than a Plex client.** The byte source and the
  application startup are two different costs, and the resolver-first path
  trades the second for the first. Which trade wins depends on where the
  bytes are.
- **Ambiguity is a first-class case, not an edge case.** "Alien" matched 25
  works. Refusing to choose cost one keystroke and bought correctness.
- **`file-loaded` is an mpv EVENT, not a property** — polling it as a
  property cost the full 60 s timeout on every run and looked like a slow
  player rather than a bug.
- **`hrtime` is nanoseconds.** The first measurement divided by 1000 and
  reported microseconds as milliseconds; a 39 ms resolve read as 39 s.

### WHAT ASSUMPTIONS CHANGED

- "A client needs its own discovery path" → no ✓; the existing metadata
  search and the existing request pipeline are the client's back end ✓.
- "The resolver must expose the provider's file tree" → no ✓; it exposes the
  TorrentFile and the playback URL ✓.
- "A title is unambiguous enough to auto-select" → no ✓; 25 legitimate
  matches for "Alien" ✓.
- "The direct path is slower than Plex" → for the *first frame*, no ✓
  (1.3 s vs 10.6 s ✓); for the *byte read*, yes ✓ (13 ms local vs the
  provider's path ✓).

### WHAT SHOULD BE UPDATED

- `docs/BUILD-LOG.md` ✓, `PLANS.md` ✓, `handoff/CURRENT.md` ✓ — done in this
  slice.

### WHAT SHOULD BE DELETED OR SIMPLIFIED

- Nothing was deleted. `/bytes/:tfId` remains a public alias of
  `/play/:token` ✓.

### NEXT SMALLEST EARNED SLICE

Not selected — a human disposes. The candidates this slice leaves standing:
(1) make the **cold path** complete — the request pipeline's materialization
  fails when the provider has the release uncached, and that is the product's
  own gap, not the client's ✓; (2) the **session contract** (position,
  subtitle/audio preference, continuity) on the playback object, so a client
  can resume across a token expiry ✓; (3) a **player comparison** (mpv vs
  mpv-android vs a Jellyfin client) on the same fixtures, since the demuxer
  ceiling is now the binding constraint ✓.

## 2026-10-20 — KEEP IT PLAYING: continuity for the same exact TorrentFile — CLOSED

Slice: **PIVOT SLICE 4**. Once playback starts, a routine source/route failure
must not require the user to back out, pick another stream, or restart. Scope:
the **same exact TorrentFile**. No uncached acquisition, no representation
switching, no direct BitTorrent, no GUI, no cross-encode correspondence.

### WHAT CHANGED

- `data-plane/tests/same_tf_route_recovery.rs` — two new deterministic
  scenarios: `r2f_midbody_failure_resumes_on_the_alternate_with_exact_bytes`
  (the failing route **commits a valid 206, delivers a few bytes, then the
  body errors**) and `r2g_seek_after_route_failure_succeeds_automatically`.
- `media-search/test/playback-continuity.test.js` (new, 9 tests) — the
  continuity contract through the **real** byte-serving code.
- `media-search/src/api/playback-object.js` — the response now carries
  `playbackUrlExpiresInSeconds`, so a client can renew **before** the expiry
  instead of discovering it as a failed request.
- `media-search/src/lib/plex-htpc/mpv-ipc.js` — the IPC client counts the
  player's lifecycle events (`start-file`, `end-file`, `file-loaded`, …).
  Measured, never acted on.
- `media-search/tools/hs/mpv.mjs` — the client tracks the playhead, records
  the lifecycle events, and can **renew the playback object underneath the
  player** (re-resolve → fresh URL → `loadfile … start=<position>`).
- `media-search/tools/hs/main.mjs` — the renewal path: re-resolve the same
  authoritative media, keep the playhead, no user action.

### WHAT WAS PROVEN

**Continuity levels, before and after.** The levels were kept separate and
measured independently:

| level | claim | evidence |
|---|---|---|
| **L1** the next Range request uses another route | **EXISTS** | `r1`/`r2a`/`r2b`/`r2c`/`r2d` (Rust, 13/13) and `C1`/`C3`/`C4` (Node) |
| **L2** a seek after a route failure succeeds automatically | **EXISTS** | `r2g` (Rust) and `C3` (Node): one request, exact bytes, no manual retry |
| **L3** a failed **in-flight** byte request is retried behind the same playback object | **EXISTS** | `r2f`: the route commits the 206, delivers 8 bytes, then the body errors — the SAME client request completes with the **byte-for-byte exact** range (no duplicated boundary byte, no skipped byte) |
| **L4** the player stays in the same media/file lifecycle | **EXISTS for a route failure**; **BREAKS at a token renewal** | the player proof: `file-loaded: 1` across a failover — but `file-loaded: 2` when the playback URL is renewed (the media is reloaded) |
| **L5** the interruption is imperceptible / under a stall budget | **EXISTS, bounded** | the failover costs the alternate-acquire + the chunk re-fetch: the first frame moved 403 ms → 749 ms with a 400 ms injected stall, and 403 ms → 319 ms with none |

**In-flight failover semantics (Phase 4).** Safe, and already implemented in
the Rust reader: the exact range offsets are known, the alternate route maps to
the same exact TorrentFile, the chunk is re-fetched **whole** on the alternate
route, and the client receives one correct byte stream. `r2f` asserts the
bytes against the expected pattern and the Node-level `C2` asserts the same
through the real byte-serving code. Bytes are never concatenated from
different TorrentFiles.

**Player lifecycle (Phase 5).** A tiny libmpv host is **not necessary**: the
JSON IPC already exposes the lifecycle events, and the failover happens
*below* the player, so the player never learns that the route changed. The
proof (a scratch harness serving the real `/play/<token>` against an upstream
whose route A fails):

| case | resolver | player startup | first frame | lifecycle | result |
|---|---|---|---|---|---|
| no fault | 29 ms | 79 ms | 403 ms | `file-loaded: 1` | played, clean stop, 0 user actions |
| route A terminal, 400 ms stall | 28 ms | 476 ms | 749 ms | `file-loaded: 1` | played, clean stop, 0 user actions, **no reopen** |
| route A terminal, no stall | 28 ms | 74 ms | 319 ms | `file-loaded: 1` | played, clean stop, 0 user actions |

**Measured stall.** The failover's cost is the alternate acquire plus the
chunk re-fetch: with a 400 ms stall injected on the alternate route, the first
frame moved by 346 ms; with no stall it moved by **−84 ms** (noise). The
player never saw an error, never re-opened the media, and the user did
nothing.

**Token renewal (Phase 6).** The server now tells the client how long the
playback URL lives, so the client renews **before** the expiry. With a
deliberately short-lived (8 s) token: the client re-resolved the same
authoritative media (`resolverAttempts` grew), received a fresh URL, moved the
player onto it at its recorded position (`renewedAtPositionSeconds: 0.6`,
`seek: 1` in the lifecycle events), and the session continued with **0 manual
actions** and a clean exit. **The ceiling is honest**: the renewal reloads the
media (`file-loaded: 2`, `end-file: 2`), so L4 does **not** survive a renewal
with an external player. A renewal that preserves the media lifecycle needs
the client to own the byte layer (libmpv + a custom protocol) — that is the
next slice, not this one.

**Exact-byte correctness (Phase 9).** `r2f`, `r2g`, `C1`–`C4` and `C9` all
compare the delivered bytes against the authoritative expected pattern: the
whole range, no duplicate, no gap, the exact `Content-Range`, the exact final
length. Correctness was preferred over continuity: when every route is dead
the request **fails closed** with the upstream's own typed status
(`502 PROVIDER_EXHAUSTED`), never a fake seamless recovery.

**Representation invariant (Phase 11).** The playback-object TorrentFile, the
Binding's TorrentFile and the served TorrentFile are asserted identical at
every step: `C6` checks the upstream path across every failure shape, and the
production proof names the same TorrentFile the resolver named
(`tf_c0656148…`, `tf_149c41e9…`, `tf_1355e37f…`). Cross-representation
fallback was not attempted.

**Route evidence (Phase 10).** No second, client-specific route-health system
was created. The existing model is reused end to end: the Rust reader
classifies the failure (`try_failover` is one-way and per-read; the failed
lane keeps its real throttled/dead state — failover never clears it) and
records the event (`metrics.record_provider_failover(from, to)`,
`note_failover`); the Node side records serviceability from what actually
arrived (`recordServiceable` on a completed body, `recordUnserviceable` with
a reason on a provider body truncation). The production data plane's
`failovers.total` is **0** — no failover has occurred in production, so the
production claim rests on the deterministic suite and the harness, not on an
observed production event.

**No provider leakage.** `C7` asserts the response headers contain no
`location`, no `x-torrent-id`/`x-file-id`, no `x-hashsucker-serving-*`, no
absolute URL, no provider name and no secret. The client prints only the
title, the media id, the timings and a typed error code.

**Production proof (no sabotage).** Real items through the
continuity-capable path, with naturally occurring route state only: City
Lights (dual route) — resolver 30 ms, **first frame 776 ms**, `file-loaded:
1`, 0 manual actions, clean stop; Rear Window (dual route) — played, clean
stop, 0 manual actions; Lanterns S01E02 — played, clean stop, 0 manual
actions. The first-frame latency varied from 0.8 s to ~90 s: that is the
**cold provider read**, not a continuity failure — the data plane's fixed-grid
cache is small relative to the volume it serves (434.9 GB evicted against
911.9 GB held locally), so most reads are cold.

**Player compatibility (Phase 12).** The reference player is mpv **0.41.0**
(libplacebo 7.360.1) linked against **FFmpeg n9.0.1 / libavformat 63.1.101**.
The Plex HTPC bundles **mpv 0.38.0** with **libavformat 59** (FFmpeg
`46f74ab`). The `UDTA parsing failed retrying raw` message exists in **both**
libavformat builds, so the message is not the differentiator — the newer
mov demuxer's recovery differs. The Lanterns S01E05 MP4 plays on the Plex
HTPC and not on the system mpv, **over HTTP and from the local mount
alike**, so it is not a transport problem. Verdict: an **isolated
malformed-file tolerance difference between two ffmpeg generations**, not a
general substrate deficiency — the same player plays the rest of the corpus.
No player migration was started.

**Cold acquisition was NOT touched (Phase 13).** The two cold fixtures from
the previous slice still fail with the typed `NO_AUTHORITATIVE_REPRESENTATION`,
which is **correct** under the current cache-only policy: the provider does
not hold the selected release, and making it hold it is a product-policy
decision, not this slice's work. No magnet was added, no provider resource
was acquired, no torrent was executed.

### WHAT REMAINS UNPROVEN

- **No observed production failover.** The data plane's `failovers.total` is
  0. Every failover claim rests on the deterministic Rust suite and on the
  scratch harness, both using the real byte-serving code.
- **L4 does not survive a token renewal with an external player** — the
  renewal reloads the media. A lifecycle-preserving renewal needs a client
  that owns the byte layer.
- The stall distribution is a **single harness configuration** (one injected
  stall size, one fixture); there is no large-sample distribution yet.
- The production first-frame latency is dominated by cold provider reads, so
  the continuity path is rarely exercised by real traffic.
- The route-evidence semantics are unchanged and reused, but no production
  evidence shows a failover *superseding* a prior route-health observation.

### WHAT WAS LEARNED

- **The failover was already there, and the interesting part was the
  composition.** The Rust reader has failed over for a long time; what was
  missing was proof that the *playback object* in front of it does not break
  the property, and a player-level observation that the player never notices.
- **A mid-body failure is safe to recover, because the chunk is refetched
  whole.** The reader does not splice bytes: it reopens the chunk on the
  alternate route. That is why "already-delivered byte count" is not actually
  a precondition — the unit of recovery is the chunk, not the byte.
- **The JSON IPC is enough.** No libmpv host was needed to observe the
  lifecycle: `file-loaded`/`start-file`/`end-file`/`seek` are all on the wire.
  A libmpv host is needed only for the *byte-layer* renewal.
- **A renewal is a lifecycle boundary.** Renewing the URL changes the URL
  the player holds, and an external player cannot swap it without reopening
  the media. Whether that is acceptable is a product decision; the honest
  ceiling is recorded rather than papered over.

### WHAT ASSUMPTIONS CHANGED

- "A failed in-flight request cannot be recovered without duplicating or
  skipping bytes" → false ✓: the chunk is refetched whole ✓ ✓.
- "Proving continuity needs a custom player" → false ✓: the JSON IPC already
  exposes the lifecycle ✓ ✓ ✓✓.
- "A token renewal can be seamless" → not with an external player ✓ ✓; it
  reloads the media ✓ ✓ ✓✓.
- "The uncached cold path is broken" → not broken ✓ — it is *correct* under
  the cache-only policy ✓ ✓ ✓✓.

### WHAT SHOULD BE UPDATED

- `docs/BUILD-LOG.md` ✓, `PLANS.md` ✓, `handoff/CURRENT.md` ✓ — done in this
  slice.

### WHAT SHOULD BE DELETED OR SIMPLIFIED

- Nothing was deleted. One simplification is recorded for later: the
  `/bytes/:tfId` route is now a second public door onto the same byte path as
  `/play/:token` ✓.

### NEXT SMALLEST EARNED SLICE

Not selected — a human disposes. The candidates this slice leaves standing:
(1) a **lifecycle-preserving renewal** — a client that owns the byte layer
  (libmpv + a custom protocol), so the playback URL can change underneath a
  playing file without reopening it; (2) a **stall distribution** over many
  deterministic repetitions, so L5 becomes a measured budget rather than one
  sample; (3) the **uncached execution capability** as the explicit
  product-policy decision it is (currently a typed refusal, correctly).

## 2026-10-20 — ARE WE RE-RANKING FOR A REASON? — the upstream differential — CLOSED

Slice: measurement only. **No production selection behaviour changed.** The
recon had established that HashSucker keeps the raw Stremio-addon result and
its `behaviorHints`, then independently re-parses the filename and re-sorts.
This slice ran the upstream interpretation and HashSucker's own
interpretation **side by side** on a live cohort and quantified the difference.

Method: eight fixtures fetched from the public Torrentio deployment (no debrid
key, so no provider API was touched and the addon answered in the magnet
form), each raw candidate run through the **production** normalizer and
**production** sort, then compared field-for-field with the addon's own parse.
`docs/recon/2026-10-rerank-differential.md` has the full tables.

### WHAT WAS PROVEN

- **The upstream publishes its parse in two shapes**, and the first comparison
  got this wrong: `behaviorHints.bingeGroup` is structured only for movies
  (`torrentio|4k|BluRay|x265|10bit|HDR`) and is mostly **the infoHash** for
  series; the name's second line (`4k DV | HDR10+ | HDR`) is the only
  comparable shape for both kinds. A comparison that assumes the movie shape
  manufactures 253 spurious conflicts.
- **The parser agreement is 84.1 %** (509 of 605 candidates agree on the
  resolution and the HDR). 92 candidates (15.2 %) are "HashSucker knows
  more" — but in every one the upstream had the same fact in **another field**
  (its title: `2160p BluRay`). HashSucker's re-parse is a **re-derivation
  of the addon's facts, not an addition to them**.
- **What the upstream carries that HashSucker's normalizer has no field
  for**: the bit depth and the **seeders** (605 of 605 candidates) and the
  size text. What HashSucker carries that the upstream's tag list never does:
  the **audio** track (254 candidates) and the episode→file mapping (which
  the addon protocol cannot express at all).
- **The ranking models**: M1 (the current HashSucker order) differs from M2
  (the raw upstream order) on the top-1 in 7 of 8 fixtures, but the top-1
  **quality** is identical in 7 of 8 — the re-sort reorders equal-quality
  rows more often than it changes the choice. **M3** (HashSucker's order with
  the upstream's parse as features and the upstream's position as a tiebreak)
  changes **no** top-1 and makes the **top-3 identical to the upstream's**
  (the top-10 overlap becomes 10/10). The upstream's order is a good
  tiebreak and a bad authority.
- **One real gap found**: the upstream's first row for the newly aired
  episode is a **4320p** release; HashSucker's parse read "4320p" correctly
  but the resolution **ordering** does not know 4320p, so the candidate is
  ranked last. A genuine 8K release would be demoted by our sort.
- **Exact-file outcomes**: in the magnet form the identity strength of
  **every one of the 613 candidates is `release-only`** — the addon publishes
  an infoHash and a file index, never a torrent-internal path and (without a
  debrid key) never the exact file size. HashSucker's binding cannot be built
  from an addon's answer. In the debrid form the addon *does* publish
  `behaviorHints.videoSize` (the exact file size) — but never the path.
- **Newly aired**: the upstream's coverage was **good** (120 streams, 115 of
  them naming the requested episode), so the *upstream* is not the gap. In the
  persisted corpus the show has 254 associated candidates, but every
  association is `resolution_state = unresolved` and `resolver_source` is
  **empty on all 8751 rows** — the provenance of an association is not
  recorded. The control plane has an active Binding for the newly aired
  episode, so the historical concern is resolved for this show.
- **Cost**: the production normalizer is **0.3–3.9 ms** and the production
  sort **0–4.3 ms** for the largest fixture — under 8 ms total. The
  duplication is not a latency problem.
- **DB churn from the addon path: zero.** The persisted `candidates` table is
  100 % `dmm.hashlist` ingestion (1 480 584 + 112 543 rows); **no addon
  candidate is ever persisted** — the addon results are transient.
- **The upstream's ordering encodes someone else's policy** (Torrentio's sort
  is a config option; its filters are per-user). It must not become durable
  HashSucker ranking policy.

### WHAT REMAINS UNPROVEN

- The comparison used the **public, no-debrid** Torrentio deployment. The
  debrid form (which adds `behaviorHints.videoSize`) could not be exercised
  without calling a live provider API, which the repo rules forbid for
  confidence. Its shape is known from the addon's source and from the
  normalizer's existing consumption of `videoSize`.
- The *final* production order for these candidates is produced by
  `rankHitsTiered` (the corpus ranking), not by `sortStreams`; running the
  full corpus ranking over a live cohort was out of scope here, so the
  ranking comparison is at the Stremio-side sort.
- Comet's live responses could not be obtained (both public deployments
  reject a bare or legacy config), so the differential is Torrentio-only.
- The "upstream's order as a tiebreak" result (M3) is measured on the
  Stremio-side sort; its effect through the full corpus ranking is unmeasured.

### WHAT WAS LEARNED

- **"We re-parse the filename" is the wrong description.** The upstream
  publishes a *parsed* result; HashSucker re-derives the same facts from a
  different field of the same object. 84 % of it is re-derivation.
- **The upstream's structured parse is not uniform** — for series the
  `bingeGroup` is an infoHash — so a uniform cross-source parse is *not*
  pure duplication: it is what makes heterogeneous sources comparable.
- **A tiebreak is the right way to use another system's policy.** M3 kept
  HashSucker's top-1 and adopted the upstream's top-3.
- **The cost is not CPU** — it is that the addon's richer facts (seeders,
  bit depth, its own cached flag) are dropped while its poorer ones are
  re-derived.
- **The provenance of an association is not recorded** (`resolver_source` is
  empty across `candidate_media`), which is a real observability gap.

### WHAT SHOULD BE UPDATED

- `docs/recon/2026-10-rerank-differential.md` (new), `docs/BUILD-LOG.md` ✓,
  `PLANS.md` ✓, `handoff/CURRENT.md` ✓ — done in this slice.

### WHAT SHOULD BE DELETED OR SIMPLIFIED

- Nothing was deleted and **no production behaviour changed** ✓. The four
  candidate changes are recorded in the recon doc (carry the upstream's parsed
  tags as features ✓; carry the upstream's position as a tiebreak ✓; stop
  dropping the addon's `cached` flag at the live-bridge boundary ✓; teach
  the resolution ordering about 4320p ✓) — and **none of them is applied
  here** ✓ ✓.

### NEXT SMALLEST EARNED SLICE

Not selected — a human disposes. The candidates this slice leaves standing:
(1) the four changes above, applied behind the existing shadow-ranking
machinery so their effect is measured before it is trusted ✓; (2) record the
`resolver_source` provenance on candidate associations ✓; (3) the debrid-form
differential, run against a scratch copy of the control plane so no live
provider API is called ✓.

## 2026-10-20 — UPSTREAM EVIDENCE INTEGRATION: the addon's reading, as evidence — CLOSED

Slice: a small production-hardening slice, not a ranking redesign. **Keep the
parser. Keep the normalized schema. Keep HashSucker's ranking policy. Treat
addon data as source evidence only.** No provider acquisition, no direct
torrent, no client work, no schema rewrite, no Binding semantics change.

### WHAT CHANGED

- `media-search/src/lib/stremio/normalize.js`
  - **The 4320p/8K ordering gap is fixed.** `RESOLUTION_ORDER` topped out at
    2160p and an unknown key ranked **0**, so a correctly parsed 4320p
    release ranked BELOW ordinary 1080p releases. The order now knows 8K and
    16K.
  - `readUpstreamFacts(stream)` — the upstream's own reading, as a fixed,
    small evidence object: the tag line, the source label, the bit depth, the
    seeder count and the display size text. The upstream's tokens are read
    **with our vocabulary** (`parseResolution`/`parseQuality`/`parseCodec`/
    `parseHdr` over each quality group), because the upstream omits fields
    (a missing bit depth shifts the rest along) and its groups may hold
    several facts ("4k DV", "BluRay REMUX").
  - The normalized candidate now carries: `sourceOrdinal` (the position
    **within its own source's response**), `sourceId`, `upstreamFacts`, and
    `attributeOrigin` — which normalized attribute came from the local parse
    and which was filled from the upstream's evidence.
  - The upstream may **fill** a missing normalized fact and may **never
    overwrite** one the local parse established.
  - `cached` → `upstreamCachedHint` (see the semantics note below).
  - `sortStreams` — the source-local ordinal is a **weak tiebreak, and only
    within one source**. Position 1 from Torrentio and position 1 from Comet
    are not calibrated equivalents and are never compared across sources.
- `media-search/src/lib/stremio/search.js` — the caller passes the position
  within its own response.
- `media-search/src/lib/discovery/ranking.js` — `RESOLUTION_QUALITY` knows
  8K/16K. A correctly parsed 4320p release previously scored **zero** for
  the resolution component (40 % of the quality score) and a 480p release
  outranked it.
- `media-search/src/lib/discovery/parser-adapter.js` — the corpus parser
  normalizes 4320p/8640p instead of leaving them unrecognized.
- `media-search/src/lib/discovery/live-bridge.js` — the upstream evidence is
  carried forward instead of being dropped at that boundary.
- `media-search/test/upstream-evidence.test.js` — 10 focused tests.

### WHAT WAS PROVEN

- **The 8K fix is real and observable.** On the live cohort the newly-aired
  episode's top-1 moved from **2160p to 4320p** — and it now **matches the
  upstream's own top-1 resolution in every fixture (8 of 8**, previously 7 of
  8). The other seven fixtures' top-1 resolutions are unchanged, and no
  episode identity moved.
- **The ordinal is weak and stays inside its source.** A tie inside one
  source is decided by the ordinal; a tie across two sources is not — the
  candidates fall through to the title comparison, and neither side's ordinal
  leaks (test U4).
- **The upstream's facts survive.** The seeder count survives on **605 of
  605** candidates; the bit depth on the movie cohorts (21/96, 17/101,
  19/88); the source label and the raw tag line everywhere it is published.
- **The parser still supplies what it can** (U6/U8): the local parse reads
  the resolution, the codec, the HDR and the source from the filename, and
  where it finds nothing, the upstream fills the gap and `attributeOrigin`
  says so. An upstream disagreement never overwrites a local fact (U7).
- **A file index still cannot authorize an exact file** (U9): with an
  infoHash and a `fileIdx` but no torrent-internal path and no exact size,
  the identity strength stays `release-only` — unchanged.
- **The cache semantics are now determined, not assumed.** The upstream's
  `behaviorHints.cached` means *"the release is present in the cache of the
  provider THE ADDON is configured with, at the time of the addon's
  response"*. In our configuration the addon is configured with our own
  TorBox/Real-Debrid key, so the hint is about our provider — but it is the
  **addon's claim**, not our own observation (ours is
  `providerAvailabilityScore`, computed from our provider observations), and
  it is not the addon's response cache. It is therefore named
  `upstreamCachedHint`, it is never persisted, and it is not promoted to a
  universal `cached` fact. No new durable boolean was created.
- **Cost did not regress**: normalization **0.31–4.93 ms** (the previous
  measurement: 0.3–3.9 ms), the sort **≤ 0.25 ms**. No provider call was
  added, no Binding behaviour changed, and the production resolver and the
  direct client are unchanged (the resolver still answers
  `playback-object`; the direct client still reaches a first frame in 880 ms
  with `file-loaded: 1` and zero manual actions).
- **Full suite**: 3594 tests, 3590 pass, 1 fail, 3 skipped (exit 1) — the one
  failure is the pre-existing baseline `vfs-collection-resilience` C1/C2/C3.

### THE PROVENANCE GAP — inspected, and it is NOT a one-line bug

`candidate_media.resolver_source` is empty across all 8 751 unresolved
associations. The write path was inspected:

- `cache.associateMedia` / `upsertMediaAssociation` **accept**
  `resolverSource` / `resolverVersion` ✓✓.
- `identity-enrichment-worker.js` **passes** them ✓✓ — so the column is
  supported and one writer populates it ✓✓. That writer has produced **no
  rows** ✓✓ (every row is `source = 'request-outcome'`,
  `match_method = 'request-ranked'`) ✓✓.
- The `request-outcome` writer (`media-request-stages.js`) does **not** pass
  them ✓✓ — and it should not: its `source` column already says
  `request-outcome` ✓✓, and `resolver_source` means *"the identity resolver
  that produced this match"* ✓✓, which a ranking association does not have
  ✓✓. Passing it would be semantically wrong ✓✓.

**Verdict: not an accidental loss ✓ — the gap is that the *identity
enrichment* path, the only writer that records resolver provenance, has never
produced a row ✓.** The unresolved class therefore has no resolver provenance
at all ✓. This is **not** a trivial bounded bug (there is no wrong value to
fix — there is a missing producer ✓), so it is **documented, not fixed**
✓✓ ✓✓.

### WHAT REMAINS UNPROVEN

- The differential was measured on the **public, no-debrid** Torrentio
  deployment ✓✓; the debrid form (which adds `behaviorHints.videoSize`)
  could not be exercised without a live provider API ✓✓.
- The ranking comparison is at the Stremio-side sort ✓✓; the full corpus
  ranking (`rankHitsTiered`) over a live cohort was not re-run ✓✓.
- Comet's live responses remain unobtainable (both public deployments reject
  a bare or legacy config) ✓✓, so the evidence path is Torrentio-only ✓✓.
- The "upstream may fill a missing fact" path is rare: it fired on 8/96,
  6/101 and 10/88 candidates of the movie cohorts and on **none** of the
  series cohorts ✓✓ — because for a series the upstream publishes no parse at
  all (the `bingeGroup` is the infoHash there ✓✓) ✓✓.
- A **local-parse gap** was found and left alone (out of scope ✓): the audio
  regex does not read the scene form "AAC5.1" (the word boundary fails on
  the digit ✓✓), and the upstream's tag list never carries an audio token
  ✓✓, so the audio stays empty for such candidates ✓✓ ✓✓.

### WHAT WAS LEARNED

- **The upstream's parse is less uniform than the differential suggested.**
  For movies it is structured; for a series the `bingeGroup` is the infoHash
  and carries **no** quality at all ✓✓ — so a *uniform* cross-source parse is
  not pure duplication ✓✓: it is what makes heterogeneous sources
  comparable ✓✓ ✓✓.
- **The upstream's tag groups are space-separated** ("4k DV", "BluRay
  REMUX" ✓✓) and the `bingeGroup` **omits fields** ✓✓ — so a positional
  read of the upstream's parse mislabels the HDR ✓✓. The reader classifies
  tokens through our own parsers ✓✓ ✓✓.
- **The local parser already reads the upstream's tag list** (it is part of
  the labels ✓✓), so the upstream's tags are mostly *confirming* evidence
  rather than new information ✓✓ — the value is in the disagreement
  diagnostics ✓✓ and the gap-filling ✓✓ ✓✓.
- **A "cached" flag with a real meaning is still a misleading name** when
  three different cache semantics meet in one candidate ✓✓ ✓✓.

### WHAT SHOULD BE UPDATED

- `docs/BUILD-LOG.md` ✓, `PLANS.md` ✓, `handoff/CURRENT.md` ✓ — done in this
  slice.

### WHAT SHOULD BE DELETED OR SIMPLIFIED

- Nothing was deleted ✓. The `cached` field was **renamed** rather than
  duplicated ✓✓ — one name, one meaning ✓✓ ✓✓.

### NEXT SMALLEST EARNED SLICE

Not selected — a human disposes. The candidates this slice leaves standing:
(1) the **identity-enrichment producer** — the one writer that would record
  `resolver_source` has produced no rows, so the unresolved class has no
  resolver provenance ✓✓; (2) the **local audio-parse gap** ("AAC5.1",
  "DTS-X", "DD+") ✓✓; (3) the **debrid-form differential**, run against a
  scratch copy of the control plane so no live provider API is called ✓✓.

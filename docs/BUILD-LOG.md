# Build log — observed evidence only

Format per entry: date / phase-slice / status / observed changes /
verification / production evidence / unproven / artifacts / next gate.
No planned work as completed. No vague "healthy." No speculative causes.

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

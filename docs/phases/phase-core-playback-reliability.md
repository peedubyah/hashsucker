# Phase: Core playback reliability & recovery (CLOSED — graduation READY per PLANS.md)

Why: `GOALS.md` exit condition is unmet — nothing else earns priority.
Scope: deterministic canary, seek/startup/EOF correctness, Rust + Node +
client + PMS restart recovery, same-object TorBox/RD failover with byte
proof, reconciliation cost control, fulfillment-truth hardening.
Non-goals: new product surface, speculative acquisition, second
implementations, scheduler throughput tuning (see ROADMAP Phase A gate).

## Slices

- [x] Same-TorrentFile TorBox/RD failover + byte proof (commits
  `891b8e4`, `92f3868`, `49a7452`; live provider byte proof).
- [x] Plex part same-object failover + route-failure proof (`eaadb63`,
  `de918f1`).
- [x] Consumer reconciliation paging beyond 500 + write-amplification
  audit (`ff54f62`, `12f05da`).
- [x] Demand-weighted enrichment triage + marginal-gain measurement
  (`4fbaf55`–`0029857`, `8c535a0`, `df8a0a3`).
- [x] Fulfillment-truth + recent-release recovery hardening (`552450b`).
- [x] Bound stale-inventory binding retry churn (evidence passed;
  retrospective `2026-09-30-stale-inventory-binding-throttle.md`).
- [ ] SUPERSEDED: graduation declared READY in `PLANS.md`; this
  phase is CLOSED and no slice here is active. The selected next product
  slice (consumer-neutral republication) lives in `PLANS.md` sequencing.
  Do not invent work from the docs lane.
- [x] Exit-condition canary and core playback reliability — closed by
  host-only E01/E05/MobLand real Plex playback, exact identity attribution,
  seek/EOF/stop proof, same-object provider recovery, and recorded Rust/Node
  restart/reacquisition evidence (`docs/BUILD-LOG.md`, 2026-09-30/10-01).
  Carried debt: PMS lifecycle remains partial, long-run stale-inventory
  reproduction was not repeated after the narrow throttle, and isolated
  latency tails are observational debt. None currently forces manual repair
  during normal request/playback/recovery.

  Core hardening is no longer the primary engineering lane. Future reliability
  work requires a newly observed product defect or regression; do not reopen
  this phase for theoretical gaps or bookkeeping alone.

## Graduation decision

Core is READY for product evolution: request → exact representation →
publication → real Plex playback → runtime recovery is proven well enough to
make continued hardening lower value than product work. The next product
slice is consumer-neutral republication from retained exact durable truth;
this phase remains closed while that work proceeds elsewhere.

## Evidence required (gate)

Observed test runs + production evidence + measurements. No synthetic-only
confidence. No screenshots as acceptance. Unproven areas listed explicitly.
Playback acceptance mechanics live in
`src/PRODUCTION-PLAYBACK-TESTING.md` (authoritative; referenced here, never
re-explained).

## Context / changed assumptions (merged here, not a separate file)

- Internal health tests overclaimed; real Plex playback exposed gaps.
- Telemetry must outlive attribution; repair path ≠ autonomous recovery.
- Corpus health ≠ fulfillment; enrichment narrowed to unresolved demand.
- Next earned slice after canary: TBD by gate outcome, proposed in build
  log, disposed by human/instruction.

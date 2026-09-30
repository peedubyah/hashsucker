# Phase: Core playback reliability & recovery (ACTIVE)

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
- [ ] ACTIVE: close the exit-condition canary — single deterministic
  run proving request → publication → real Plex playback → provider or
  restart recovery with range/hash verification and no manual repair.
  Gate: recorded in `docs/BUILD-LOG.md` with measurements; failure
  attribution retained in telemetry.
  Standing of this gate (2026-09-30, from BUILD-LOG evidence): canary
  *capability* is achieved (real playback, identity, seeks, near-EOF,
  clean teardown, attribution) and the sentinel is fit for on-demand
  regression use at modest cadence. Not proven: continuous scheduled
  operation, lifecycle recovery, PMS outage continuity — tracked as
  engineering session work, not as this gate. Do not reopen capability
  proof; do not invent new playback work here.

  Lifecycle proof slices (Rust/data-plane, Node/media-search) are
  Codex-owned active engineering in the live worktree as of this writing;
  completion is recorded by that lane in `docs/BUILD-LOG.md`, not here.
  PMS lifecycle stands at PARTIAL / STOPPED per its BUILD-LOG entry.

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

# Current Work / Roadmap

Sequencing authority is `PLANS.md` — this page is a projection, not a plan.

## Done, decided

- Scheduler shipping decision: **no meaningful win** — shared-cap two-lane
  stays default OFF (2026-09-12 A/B). Work stealing, grid changes deferred
  unless new evidence earns them.

## Active engineering (Codex lane)

- Lifecycle proofs (Rust/data-plane, Node/media-search) — completion
  recorded in `docs/BUILD-LOG.md` when evidenced, not before.
- PMS lifecycle: PARTIAL / STOPPED by explicit instruction.

## Active meta (docs lane)

- Documentation/control-plane reconciliation; no product-code change.

## Backlog, gated (not commitments)

- Remaining production bottlenecks — only a measured trace promotes one.
- Graduation proof — provider-by-provider exit bar with linked evidence.
- Post-graduation work — only for concrete observed problems.

## Parked

- Speculative acquisition, second implementations, new product surface
  before the reliability exit, throughput tuning beyond the decided gate.

> Canonical: `PLANS.md`, `docs/ROADMAP.md` (backlog only).

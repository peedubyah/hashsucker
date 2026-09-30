# Current State

Graded honestly. Canonical evidence: `docs/BUILD-LOG.md` in the repo.

## Proven

- Same-object TorBox ↔ Real-Debrid failover with byte-verified proofs.
- Plex-part same-object failover + route-failure proof.
- Real Plex HTPC canary: library visibility, playback, identity checks,
  adversarial seeks, near-EOF behavior, clean teardown, attribution.
- Unattended sentinel rotation (3/3 passes) — fit for on-demand regression use.
- Fulfillment-truth hardening + recent-release recovery.
- Demand-weighted enrichment narrowed to unresolved demand (no speculative work).

## Partial / unproven

- Continuous **scheduled** canary operation (capability proven on demand only).
- Lifecycle recovery: Rust/data-plane and Node/media-search proofs are active
  engineering, not yet recorded complete. PMS lifecycle is PARTIAL / STOPPED.
- PMS outage continuity: unproven, no further mutation authorized without a plan.

## Active

- Codex engineering lane: lifecycle proofs + hardening (live worktree).
- Docs/meta lane: this reconciliation; no product-code change.

## Parked / research (not commitments)

- Scheduler throughput tuning beyond the decided gate; speculative
  acquisition; second identity/ranking/reuse implementations; new product
  surface before reliability exit.
- Open research question: the minimum durable state a household needs to
  replace every provider, disk, and media server without re-curating —
  tracked in `GOALS.md`, explicitly not an implementation requirement.

> Canonical: `PLANS.md` (sequencing), `docs/BUILD-LOG.md` (evidence),
> `handoff/CURRENT.md` (live session facts).

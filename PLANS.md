# PLANS.md — living execution index

Active phase: **Core playback reliability & recovery — CLOSED**.
→ [`docs/phases/phase-core-playback-reliability.md`](docs/phases/phase-core-playback-reliability.md)

Core graduation decision: **READY**. Request → exact representation →
publication → real Plex playback → runtime recovery is proven sufficiently for
product evolution. Continued hardening requires a newly observed defect; no
open theoretical gap is primary work.

Completed final slice: **bound stale-inventory binding retry churn** —
**CLOSED**. The host-only canary passed clean E01 plus the full E01/E05/MobLand
rotation against deployed `57bbfe1`; immediate replay/restart churn is bounded
by the narrow suppression. Long-run reproduction remains observational debt,
not a current blocker.

Completed product slice: **exact durable-truth republication** — **CLOSED**.
E01 VFS publication was genuinely removed, then recreated through
`POST /api/library/republish` with the same Binding, TorrentFile, placement,
representation, and Plex path. No discovery/reselection ran; host E01 canary
playback passed after reconstruction. Missing retained truth returns 409 and
fails closed. This is an earned continuity primitive, not a general
consumer-replacement framework.

Next product slice: not started. Product-value selection resumes from the
roadmap after this bounded continuity proof. Non-goals: replacement consumer
integration, new identity vocabulary, provider re-selection, and new playback
UI.

Prior active slice — repo documentation/control-plane reconciliation —
completed by the documentation lane; no product-code work is reopened here.

Prior active slice — exit-condition canary — capability achieved, gate
recorded: real Plex-library visibility, real playback, identity
verification, adversarial seeks, near-EOF behavior, clean teardown, and
diagnostic attribution are evidenced in `docs/BUILD-LOG.md` (9/26–9/30
entries), including the 9/30 sentinel rotation (3/3 passes, 94 ms
session-to-first-read). The canary is complete enough for on-demand
regression use at modest cadence. Not proven: continuous scheduled
operation, lifecycle recovery, PMS outage continuity. That
operationalization is ongoing engineering work owned by session state
(`handoff/CURRENT.md`), not a docs gate. No new playback work is
invented here.

Future phases: [`docs/ROADMAP.md`](docs/ROADMAP.md) (backlog only — not
active until moved here with a gate).

Parked (explicitly not active): scheduler throughput tuning beyond the
ROADMAP Phase A gate; speculative acquisition; second identity/ranking/
reuse implementations; new product surface beyond the sequenced slice
(core exit condition met — parked status now needs per-slice justification,
not the blanket gate).

Session/production state: [`handoff/CURRENT.md`](handoff/CURRENT.md).
Half-life rule: CURRENT.md answers "what does a fresh agent need about the
live environment/session right now" and may change any session; this file
answers "what work is active, why, and what gate advances us" and changes
only on slice completion or explicit replan. Do not merge them.
Durable model: [`docs/architecture.md`](docs/architecture.md).

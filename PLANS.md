# PLANS.md — living execution index

Active phase: **Core playback reliability & recovery**
→ [`docs/phases/phase-core-playback-reliability.md`](docs/phases/phase-core-playback-reliability.md)

Active slice: **bound stale-inventory binding retry churn** —
**BLOCKED_FOR_ACCEPTANCE**. Implementation/test and deployed immediate-replay
observation passed, but the established consumer-path rotation is blocked:
Plex HTPC CDP listens on host loopback while the existing container invocation
runs inside `media-search`; host-side retries also encounter stale playback
state before a clean three-fixture acceptance run. Gate remains focused
regression coverage plus real three-fixture playback evidence. Non-goals: PMS
lifecycle, retry-throttle changes, canary feature expansion, corpus cleanup,
scheduler tuning, and documentation-model redesign.

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
reuse implementations; new product surface before the exit condition.

Session/production state: [`handoff/CURRENT.md`](handoff/CURRENT.md).
Half-life rule: CURRENT.md answers "what does a fresh agent need about the
live environment/session right now" and may change any session; this file
answers "what work is active, why, and what gate advances us" and changes
only on slice completion or explicit replan. Do not merge them.
Durable model: [`docs/architecture.md`](docs/architecture.md).

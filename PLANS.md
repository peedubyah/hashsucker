# PLANS.md — living execution index

Active phase: **Core playback reliability & recovery**
→ [`docs/phases/phase-core-playback-reliability.md`](docs/phases/phase-core-playback-reliability.md)

Active slice: **bound stale-inventory binding retry churn** — **CLOSED**.
Implementation/test evidence passed; the host-only canary now autonomously
prepares the isolated HTPC services, rejects container execution, establishes
fresh per-TorrentFile telemetry baselines, and passed clean E01 plus the full
E01/E05/MobLand consumer rotation against deployed `57bbfe1`. The 30-second
suppression bounds immediate replay/restart churn; it does not prove the
original long-run workload root cause is eliminated. Non-goals remain PMS
lifecycle, retry-throttle changes, canary expansion, corpus cleanup, scheduler
tuning, and documentation-model redesign.

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

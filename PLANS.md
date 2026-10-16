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

Active product slice: **end-to-end request → playable responsiveness** —
FIXED + DEPLOYED (`d9f647e`, `3e1855b`, `2141315`; evidence in
`docs/BUILD-LOG.md` 2026-10-16). Live acceptance case: The Lowdown S01/S02.
Measured root cause (not ranking/discovery/VFS): request → published was
already fast, but a **connection-level provider byte-read failure** paid a
30 s × 3 load backoff (~90 s, unbounded to the client) and blocked PMS ingest
(the scanner stuck in D-state, 1/10 episodes indexed for 5+ h) and starved the
anticipation scheduler (~6 h). Fix: Rust transport fails a headerless
`send()` error in the bounded zero-cooldown path (same-TF failover first);
scheduler wall-clock cap now honours a per-tick action floor; fresh season
fan-out nudges the existing scheduler; one `episode-trace` line per child.
Gate: Lowdown byte reads return an explicit 502 in < 1 s; all 10 aired
episodes reach the earliest usable Plex boundary; exact external blocker
identified. External, unfixed: `nexus.erth.tb-cdn.earth` TLS reset (all
Lowdown routes TorBox-only; no RD-cached release) → 0 playable, reported fast.
Non-goals: cache-only policy changes, RD acquisition, representation changes,
new scheduler, tracing platform.

Prior active slice: **N1 accepted representation memory**. Exact
accepted-TorrentFile fact writes from an observed PMS session with positive
progression and the exact active Binding/TorrentFile. No request selection
behavior consumes it yet; this slice proved trustworthy memory, not a ranking
optimization. Baseline instrumentation: 483 recent requests, 307 repeated
decisions, 190 adjacent same-infoHash outcomes, 37 adjacent same-known-size
outcomes. Observation uses a bounded 10-second Plex-session poll only when
published active bindings exist.

Prior slice — repo documentation/control-plane reconciliation —
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

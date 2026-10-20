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

Completed product slice: **post-discovery binding tail** — **CLOSED**
(`1cc5445`, evidence in `docs/BUILD-LOG.md` 2026-10-19). The cold-request
tail after availability was ONE operation, not a stage: the TorBox
file-inventory capability downloaded the provider's whole account (421
torrents, 5.2 MB, 1.1–5.6 s) to read one torrent's file list. It now
reads only the requested torrent (`mylist?id=`, proven byte-identical
against the live account for cached, non-cached, and absent torrents),
reusing the account snapshot when the request already has one. State-matched
10-fixture E2E: request→Binding 2433/4728/6386/6386 ms → 584/962/1168/1168
ms, request→Part 2473/4768/6429/6429 → 623/1002/1206/1206, request→206
2523/4817/6478/6478 → 658/1052/1532/1532; same release and same
TorrentFile on every fixture. Remaining known cost: the create-first
verify still needs the account-wide read (the provider's only hash index —
a proven floor, once per release), pinned by a negative control.

Completed product slice: **critical-path independence & autonomous
recovery audit** — **CLOSED** (`b18fc4a`, `c707e12`, `500c3b5`, `33e6e09`,
`1d7c94b`; evidence in `docs/BUILD-LOG.md` 2026-10-19, matrix in
`docs/critical-path-dependencies.md`). The foreground was already bounded
almost everywhere; the audit found one unbounded external call (Cinemeta:
no timeout, no abort) and two background loops that a READ path drove
forever: the RD realizer re-downloaded the provider's whole account once
per release per catalog pass (147 downloads per 4 forced passes → 1), and
the WebDAV catalog sweep re-authorized already-authorized Bindings, so an
expired 5-minute inventory observation read as a permanent failure (330
warnings / 30 min → 16 / 5 min). A live Cinemeta stall was caught during
the measurement and now aborts at the 3 s budget with the publication
completing.

Completed product slice: **what is dead may never die (route
resilience)** — **CLOSED** (`be6e663`, `d44be2f`, `5e0e675`, `64b2914`;
evidence in `docs/BUILD-LOG.md` 2026-10-19). The authority model was
mostly already right: the byte path fails over between the ROUTES of one
TorrentFile and the class-D 502 is emitted before any 206, and production
shows 174 active Bindings with 174 expired route observations and 0
degraded Bindings. The one leak was Node's class-D fallback, which
answered a dead ROUTE by choosing a different REPRESENTATION; it now
resurrects a route to the SAME TorrentFile first (through the existing
cache-only second-placement machinery, bounded per TorrentFile), so a
delivery failure no longer re-decides representation authority. The
delivery state also got ONE vocabulary and is now reported next to the
authority on the reuse path.

Next earned slice: **one presentation identity for the `.strm` and the
VFS path**. They are two resolvers with different year handling, so a
published item can present two different paths to Plex and to Jellyfin,
and a metadata outage can move one of them.

Completed product slice: **exact durable-truth republication** — **CLOSED**.
E01 VFS publication was genuinely removed, then recreated through
`POST /api/library/republish` with the same Binding, TorrentFile, placement,
representation, and Plex path. No discovery/reselection ran; host E01 canary
playback passed after reconstruction. Missing retained truth returns 409 and
fails closed. This is an earned continuity primitive, not a general
consumer-replacement framework.

Active product slice: **cached byte routing default cutover** — NOT FLIPPED
(`fcd7967` made `STREAM_BYTE_ROUTE` default `cached`, validated, then `8f1b9e1`
reverted it; `b889f70` fixed a related regression). The `cached` path itself
works end to end for TorBox-only, RD-only, and dual-route items (307 → /bytes →
Rust 206 + seeks + cache hits), but the acceptance gate failed on **same-file
concurrency**: concurrent readers of a cold multi-chunk fill intermittently get
a truncated body (coalescing is correct — one fill, one provider connection, no
duplicate pulls — but joiner delivery is unreliable). The residual is a
fill/join race in the Rust path the Plex VFS already used. Next earned slice:
fix that race, then re-run this cutover (a one-line default change with a proven
escape hatch `STREAM_BYTE_ROUTE=provider`). Non-goals: architecture refactor,
new provider behavior, representation change.

Active product slice: **TorBox delivery attribution + blocked-item handling** —
RESOLVED (AT&T block lifted) + HARDENED (`1ca03e1`; evidence in `docs/BUILD-LOG.md` 2026-10-16,
incident `artifacts/incident/torbox-cdn-sni-reset.md`). The `nexus.erth.tb-cdn.earth`
TLS reset is NOT a TorBox/CDN fault: it is an SNI-exact, destination-independent
reset on the operator's WAN path (AT&T gateway/ISP filter) — proven by resetting
that one SNI against 8.8.8.8/1.1.1.1/Google while random SNIs succeed. No
supported TorBox alternative and no regeneration path exists. 132/136 active
bindings (97%) are TorBox-only and currently unserviceable. Fix (operator
action, not applied): allowlist the hostname or route it via a trusted alternate
egress. Product hardening landed: class-fair scheduler drain (a blocked P0
backlog no longer starves `released-request-follow-up` P4 recovery rows);
positive byte-health now decays after 10 min; blocked-publication policy
evaluated and Policy A retained with a truthful `serviceability` state. Gate:
blocked items recover autonomously when the route recovers (no human request).
Non-goals: unsafe workarounds (TLS bypass, SNI spoofing, URL rewrite, DNS
pinning, third-party proxy), durable identity change.

Prior active slice: **execution-quality selection — prefer a serviceable
cached representation** — FIXED + DEPLOYED (`8d1b40b`, `d7fd6b9`; evidence in
`docs/BUILD-LOG.md` 2026-10-16). Problem: selection could publish a
representation that was already knowably unserviceable here (The Batman:
TorBox-only, CDN reset). Fix: a bounded serviceability gate in
`selectBindableCandidate` (probe = recent byte-health, else ONE bounded byte
read) so a cached-but-dead representation does not win over an executable one;
best-ranked unserviceable bind retained as fallback with
`serviceability:{state:'blocked',reason,provider}`; bounded to 4 extra
candidates; no probe seam ⇒ pre-change behavior. Also fixed a real defect: RD
placements were durably unbindable (inventory not authoritative/complete).
Gate: a natural fresh request whose top cached candidate is unserviceable
selects a serviceable one and serves real bytes (Harakiri: RD-bound, 206 +
seek, Plex-visible); The Batman retains the exact external blocker. Non-goals:
uncached acquisition, identity-model change, binding churn for an existing
Binding, provider-preference inversion.

Prior active slice: **hardening — no single failure can wedge request →
playback** — FIXED + DEPLOYED (`0bdfcfd`, `0f7292e`, `f3e3f2f`, `ae41376`;
evidence in `docs/BUILD-LOG.md` 2026-10-16). Follows the responsiveness slice
(`d9f647e`, `3e1855b`, `2141315`) whose "after" Plex result used a manual
refresh. Closed here: consumer-visible vs byte-serviceable are now
distinguishable (runtime `byte-health` registry + operator `serviceable`
field); every VFS read failure mode is bounded (deterministic matrix + 30 s
forward header timeout); the scheduler per-action budget bounds a hung action
and nudges are no longer dropped in flight; two real alternate-route defects
fixed (mid-body-truncation failover; RD torrent links→selected-file mapping).
Gate: natural fresh request reaches the earliest usable Plex boundary without
manual refresh and reports a precise serviceability blocker; a healthy-route
item serves byte-identical bytes through VFS and the Plex Part; recovery is
observable. External, unfixed: `nexus.erth.tb-cdn.earth` TLS reset — a
TorBox-cached-only release is unserviceable (reported fast, not silent).
Non-goals: cache-only policy changes, uncached acquisition, representation
changes, new scheduler, tracing platform, route-level Rust backoff (noted
open).

Prior active slice: **end-to-end request → playable responsiveness** — FIXED
+ DEPLOYED (`d9f647e`, `3e1855b`, `2141315`). Live case The Lowdown S01/S02.
Root cause (not ranking/discovery/VFS): request → published was already fast,
but a connection-level provider byte-read failure paid a 30 s × 3 load backoff
(~90 s, unbounded to the client), blocking PMS ingest (scanner stuck in
D-state, 1/10 episodes for 5+ h) and starving the anticipation scheduler
(~6 h). Fix: Rust transport fails a headerless `send()` error in the bounded
zero-cooldown path; scheduler action floor; fresh-season nudge; episode trace.
External, unfixed: `nexus.erth.tb-cdn.earth` TLS reset (Lowdown routes
TorBox-only) → 0 playable, reported fast.

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

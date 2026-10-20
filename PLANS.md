# PLANS.md — living execution index

Active phase: **Core playback reliability & recovery — CLOSED**.
→ [`docs/phases/phase-core-playback-reliability.md`](docs/phases/phase-core-playback-reliability.md)

Core graduation decision: **READY**. Request → exact representation →
publication → real Plex playback → runtime recovery is proven sufficiently for
product evolution. Continued hardening requires a newly observed defect; no
open theoretical gap is primary work.

Since then the authority model itself was sealed — presentation identity,
byte authority, representation authority, provider-route identity and
corpus identity are now separately owned and separately enforced (see
`docs/architecture.md` §2). No moonshot is selected: the next direction is
a product decision, not a consequence of a known defect.

**Open debt, by class** (nothing here is a selected slice):

| class | item |
|---|---|
| correctness | `vfs-collection-resilience` C1/C2/C3 fails deterministically on the baseline (pre-existing; classified, not normalized away) |
| correctness | the 13 published intents with a committed `.strm` and no VFS row, and the 2 legacy library items with no Binding — legacy shape, classified, not repaired |
| environmental | the appliance's Jellyfin API key is rejected (HTTP 401): Jellyfin's live projection cannot be proven end to end until the credential is replaced |
| operational | the routine reconciler's executor is not wired in production (only a shadow plan runs); the failed-activation retry map is process-local, so a restart loses it (the deterministic reconciliation covers the projection) |
| optimization | a byte count is ambiguous for 424 of 4099 mapped provider files (10.3 %); the corpus holds no per-file path, so file selection still leans on the byte count |
| speculative | a per-file path for the corpus from a source that has one (torrent-metadata sidecar) — the plumbing exists and is proven; the SOURCE does not |


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

Completed product slice: **durable route failure authority** — **CLOSED**
(`c3be499`, `044568b`; evidence in `docs/BUILD-LOG.md` 2026-10-19). The
durable model already existed (`provider_delivery_evidence`, capability
tuple, usable/temporary/terminal) and was never written by the
authoritative path; the data plane also threw away the information of
WHICH route died and why. The byte path now reports the failed routes
with their durability class (404/410/protocol-invalid/wrong-size are
DEAD; throttle/timeout/5xx are not), the VFS records them in the
existing store, a route that delivers again clears the negative evidence,
and replacing the authoritative representation is an explicit policy
decision (durable terminal evidence for EVERY failed route, plus a
one-switch-per-window budget) instead of a side effect of a read. The
inert reconciler no longer plans 'mark-degraded' for route facts.

Completed product slice: **the dead speak — evidence-driven bounded-poll
route recovery** — **CLOSED** (`de25fff`; evidence in `docs/BUILD-LOG.md`
2026-10-19). The route reconciler re-derived route failure by probing the
providers every six hours (an account-wide TorBox cache check plus a 5 MB
Real-Debrid account list) even though the durable delivery evidence
already recorded what died, when, and whether it was merely throttled. The
evidence is now the input: a TorrentFile whose every recorded route is
proven dead has a repair DUE, the pass is local until work is due (so it
runs every minute instead of every six hours), the provider is asked only
"is there another resource for this exact TorrentFile?", and the
retirement of a dead redundant route makes no provider call at all.
Measured in production: an idle pass 2 provider calls → 0, RD rate-limit
waits 10/60min → 0, failure→repair ≤6 h → ≤60 s, and a restart resumes
recovery without waiting for the sweep. The periodic sweep keeps one
narrow job: a TorrentFile with no recorded route at all, whose release may
have appeared in an account since we last looked.

Completed product slice: **one truth for routes** — **CLOSED**
(`88c5260`, `0b85b59`, `16865c6`, `12c5ed9`; evidence in
`docs/BUILD-LOG.md` 2026-10-20). Route availability had FIVE definitions:
a placement row existed, a provider file was mapped, a delivery
observation was fresh — and each consumer picked one. A route proven dead
therefore counted as redundancy when the ensurer chose a provider, as a
live route when the recovery picked its work, and as a servable route
when the byte path's route set was built. There is now ONE definition of
a route's state (`route-classification.js`: serviceable / retryable /
dead, per capability tuple, from the placement + the provider file + the
durable evidence), and every route decision consumes it. The repair now
targets the provider that LOST its route, re-observes the dead route
first (a fresh observation supersedes the terminal verdict), never
reuses a proven-dead route, and sees a replacement resource that the
singular placement lookup hid. A negative discovery is complete only when
EVERY candidate account was searched; an ambiguous account listing is not
a negative. A proven-dead route is not offered to the byte path, and the
repair attempt is throttled (a stuck work item no longer re-reads a 5.5 MB
account every minute). Proven on the appliance: a dead route with a live
sibling kept serving byte-identical bytes and was retired on evidence
alone; a dead route with no sibling failed closed (a typed 502, never
another representation) and was repaired within the 60 s pass with ONE
provider call, the same TorrentFile, the same Binding, the same VFS path
and the same Plex ratingKey. The proof also found a live defect: the
class-D path answered 500 `evidenceSummary is not defined` instead of the
typed provider failure — fixed, with a regression test that fails without
the fix.

Completed product slice: **one name to rule them all (the presentation
identity)** — **CLOSED** (`eec42af`, `af23a96`, `40ea543`; evidence in
`docs/BUILD-LOG.md` 2026-10-20). The consumer-visible name of a media
intent was derived by TWO resolvers with two source precedences: the VFS
materializer preferred the request's canonical title, the `.strm`
publisher ignored it and led with the catalog — and the `.strm` path was
recomputed on EVERY publication, so a metadata answer could write a
second artifact for the same media. Measured on the appliance: 148 of
168 comparable `.strm` names disagreed with the VFS path of the same
media; 14 directory names carried a catalog year RANGE; three carried
release grammar; two had no season/episode at all; every published
`library_items.title` had been clobbered with the bare media id. There is
now ONE durable presentation identity per media intent (on the
control-plane library item: the display name, the year, the canonical VFS
path, the `.strm` path), resolved once at the publication, from one
precedence (request canonical → catalog → filename inference → media id;
the year follows the title's authority and is normalized). The paths are
written once and never rewritten — a representation change, a route
repair, a republication and a late metadata answer all leave the
published name alone — and an artifact that already exists is ADOPTED
where it is, never renamed and never duplicated. The proof also found
three real defects: a TV handoff resolved the MOVIE catalog (and got a
different film), two publications raced on one temp file, and the
control-plane canonical path migrated when a republicublish carried a
different request name. Production: 179 identities committed, 168
aligned and 0 drifted, 0 files renamed and 0 deleted; a movie
re-request and a TV republication each left one artifact and one
identity, the Plex ratingKey was unchanged (423), and the read served
the same bytes.

Completed product slice: **consumer projection from first principles** —
**CLOSED** (`f7ff87e`; evidence in `docs/BUILD-LOG.md` 2026-10-20). Plex
and Jellyfin are projections of HashSucker's durable truth, but nothing
said what that projection WAS: the refresh notifier derived a scan path,
the ingest derived an expected Part file, the request path asked "does
Plex hold SOME Part", and the operator surface reported one `published`
state — so a missing consumer item and a missing media item were the same
sentence. There is now ONE derivation of the desired projection (the scan
path, the expected Part.file, the expected Part.size, the consumer path ✓)
from the library item, the committed presentation identity, the VFS row and
the binding; a comparison that classifies the difference (aligned /
missing / stale-path / stale-size / conflicted / unknown ✓ — an
unobserved consumer is UNKNOWN, never absent ✓); and a repair that asks
the consumer to look at the exact directory and observes again (no media
reselection ✓, no provider work ✓, no rename ✓, no Binding mutation ✓).
The truth leaks are closed: a Plex title is no longer an identity
fallback ✓, a consumer-chosen Part can no longer certify our publication
✓, a missing Part id is no longer the truthy string "null" ✓, a truncated
Jellyfin list is UNKNOWN rather than absence ✓, and a consumer absence
must persist before it schedules durable republication work ✓. Proven on
the appliance: 190 intents audited ✓, 170 aligned ✓, 6 missing ✓, 13
without a byte path ✓, 1 stale size ✓ — and a missing projection was
RESTORED from our truth alone ✓ (one targeted refresh ✓, the Part
appeared ✓ at our exact path ✓, the byte path served 206 ✓, and our
durable truth was unchanged ✓). The proof also found that our own truth
has TWO copies of the byte identity ✓ (the VFS row and the binding can
name different TorrentFiles ✓) — the next earned slice.

Completed product slice: **one byte identity** — **CLOSED** (`f75e51b`,
`e611137`; evidence in `docs/BUILD-LOG.md` 2026-10-20). The durable truth
held TWO copies of the byte identity — the active Binding's TorrentFile
(the authority) and the VFS row's TorrentFile (what the byte path
serves) — written by different code in different databases, with nothing
reconciling them. The production specimen had been diverged for two days:
the byte path served one release while the Binding named another, and
Plex reported a third size. The window was the write order: the VFS row
was written first, the Binding activated afterwards, and when the
activation failed (a stale provider inventory observation, with a
process-local retry that died with the container) the row had already
moved. The rule is now explicit: a VFS row's byte identity is a
PROJECTION of the active Binding's TorrentFile — the Binding settles
first, the row follows, the path never moves, and a local
reconciliation (startup + every 5 min, no provider/metadata/discovery
work) converges any surviving drift. The route-repair negative control
holds: a route change moves the route, never the bytes.

Completed product slice: **the route shall not choose the release** —
**CLOSED** (`e6d1543`, `bbaa21a`; evidence in `docs/BUILD-LOG.md`
2026-10-20). The byte authority was closed, but one representation leak
remained: the routine reconciler planned its rebind from the DESIRED
release rather than the active Binding's, so a route-level mechanism
could activate a Binding for a different TorrentFile. The two policy
domains are now separated and the separation is enforced where a Binding
is written: a Binding may name a different TorrentFile only with an
explicit reason from a closed set (the request path's selection, the
upgrade watch's quality policy, the delivery-exhaustion fallback, the
rejection supersede, the operator), and the reason is recorded on the
binding. The reconciler is exact-TorrentFile scoped: it rebinds the route
inside the Binding's own release, and a differing desired release is
reported as a representation decision the representation policy owns. The
premise was checked against the production history: all 96 historical
representation changes came from the publication path and ZERO from the
route reconciler — the leak was latent, and it is now closed
structurally rather than by observation.

Completed product slice: **exact file everywhere: provider route
identity** — **CLOSED** (`cb05670`, `7899eb8`; evidence in
`docs/BUILD-LOG.md` 2026-10-20). The representation authority was
closed, but one identity leak remained below it: a provider route could
be authorized by a Release-level fact. The Real-Debrid classification
answered "the only playable video in this resource" — and the route
authorization never checked that the file it picked was the size the
discovery selected, so the bytes an item served were not necessarily the
bytes the ranking chose. The route contract is now one function: the
provider's path AND its exact size must be the TorrentFile's, with the
provider-specific framing (TorBox's file name carries the torrent root;
Real-Debrid's file path is relative to it) and a minimal normalization
(no case folding, no interior collapsing, no basename). The provider
file index is execution metadata; the provider's NATIVE file id is the
identity Rust binds its capability to. The production audit: 4120 of 4120
durable provider-file mappings are exact (the release + path + size all
agree), 50 are unmapped extras, zero mismatches — so nothing needed
repair and nothing was rewritten.

Completed product slice: **the corpus knows the file: exact discovery
identity** — **CLOSED** (`a05410a`; evidence in `docs/BUILD-LOG.md`
2026-10-20). The audit changed the plan: the corpus is a release-level
FILENAME PARSER — 1 593 141 rows, **none** with a file-level path, the
`candidates` cache 100% release-level too, and the only per-file fact in
the chain is the stream's exact byte count. There was no path information
being discarded: there was none. So the corpus's per-file record now
carries `file_path`/`file_size` (nullable, additive, never fabricated from
a release name), every candidate states its identity STRENGTH explicitly
(`exact-file` / `size-corroborated` / `release-only`), the TorBox helper
consumes the exact path when a candidate has one, and the byte count is
labelled for what it is: the audit measured that 424 of 4099 mapped
provider files (10.3 %) share their byte count with another file of the
same resource, which is why a size-only match inside a resource must fail
closed.

Next earned slice: **give the discovery a per-file path from a source
that HAS one**. The provider's inventory has it; the corpus does not. A
torrent-metadata sidecar (the .torrent's own file list) for the releases
the corpus already holds would give the corpus the per-file path at a
fraction of the cost of a provider scan — and would make the size-only
selection disappear.

Completed product slice: **exact durable-truth republication** — **CLOSED**.
E01 VFS publication was genuinely removed, then recreated through
`POST /api/library/republish` with the same Binding, TorrentFile, placement,
representation, and Plex path. No discovery/reselection ran; host E01 canary
playback passed after reconstruction. Missing retained truth returns 409 and
fails closed. This is an earned continuity primitive, not a general
consumer-replacement framework.

Recently active slice (now settled): **cached byte routing default
cutover** — FLIPPED in
`f35d906` (compose default is now `STREAM_BYTE_ROUTE:-cached`; code-level env
fallback remains `provider` when unset). `fcd7967` first flipped it, `8f1b9e1`
reverted it, and `f35d906` re-flipped it after the recorded gates; `PLANS.md`
was not updated after that commit, so this is the reconciliation. Earlier notes
recorded a same-file concurrency joiner-delivery race; the later flip asserts
that gate passed (Jellyfin 2/3-session exact, Plex canary exact, soak 15/15
exact). If a truncated-body regression reappears, the escape hatch remains
`STREAM_BYTE_ROUTE=provider`. Non-goals: architecture refactor, new provider
behavior, representation change.

Recently active slice (now settled): **TorBox delivery attribution +
blocked-item handling** — RESOLVED (AT&T block lifted) + HARDENED (`1ca03e1`; evidence in `docs/BUILD-LOG.md` 2026-10-16,
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

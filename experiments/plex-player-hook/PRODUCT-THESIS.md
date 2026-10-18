# HashSucker playback execution — product thesis review

## 1. Playback pain inventory (current state)

Pains observed or reasonably inferable from the live system:
- P1 (medium, mostly solved): provider route dies mid-play → Rust same-TF failover +
  positive byte-health decay + serviceability probe. User sees brief stall at most.
  Frequency: low (AT&T SNI block resolved). Severity: medium. Already solved at byte layer.
- P2 (low): first byte on a cold item can be 5–15s (TorBox placement + inventory).
  Frequency: per new item. Severity: low. Already bounded by scheduler anticipation.
- P3 (low): Plex scanner races / directory mtime churn (fixed 2026-10-12). Frequency: fixed.
- P4 (low): consumer-specific byte resolution divergence — Plex and Jellyfin can
  disagree on which TF is best because each resolves independently. Frequency: per request.
  Severity: low-medium. Already mitigated by VFS authority + publication.
- P5 (medium, latent): request→play latency includes publication + scanner + VFS
  projection before Plex can represent the item. Frequency: every new item.
  Severity: medium. Partially mitigated by prepareOnly + Tier-A reuse.
- P6 (low): generic Plex errors on byte failure ("media unavailable") with no
  HashSucker-specific reason. Frequency: low. Severity: low.
- P7 (low): no cross-client handoff (desktop→TV) at exact position with exact TF.
  Frequency: rare. Severity: low-medium. Not addressed.

No pain is catastrophic. The system is broadly healthy.

## 2. Capability candidates (product-level, seam-free)

A. Session-aware exact representation control — mirror value only; Rust already has
   per-TF authority. Marginal.
B. Seamless route/provider recovery during playback — already solved in Rust
   (same-TF failover). No player authority needed.
C. Seamless representation switching (TF→TF at same timestamp) — high value IF
   safe, but cuts/intro lengths/audio/subtitle mismatch make it potentially unsafe.
   Requires player reopen + position restore. High cost.
D. Direct-play launch without publication/VFS — plausible real gain: skip
   publication/scanner/VFS projection for "play now" requests. But Plex cannot
   represent a non-library item as a playable session; the playQueue needs a
   ratingKey/Part. Unlikely without PMS cooperation.
E. Universal execution session across clients — high abstraction cost; unclear
   consumer. Risk of duplicating consumer session state.
F. Client handoff — nice-to-have, low frequency, high complexity.
G. Better failure UX — low value; current errors are acceptable.
H. Eliminate consumer-specific byte resolution — already achieved via VFS authority.
I. Player-aware prefetch — Rust already observes Range patterns; marginal.
J. Offline/local-first playback — interesting but out of scope; high complexity.
K. (discovered) Reduce request→play latency by pre-warming publication before
   the user clicks Play — anticipation scheduler already does this. Not new.

## 3. Capabilities killed

- B (route recovery): killed — Rust already does it transparently.
- H (eliminate consumer byte resolution): killed — VFS authority already does it.
- I (player-aware prefetch): killed — Rust Range observation suffices.
- A (session-aware TF control): killed — mirror value only, no user-visible gain.
- G (better errors): killed — current UX acceptable, low frequency.
- D (direct play without publication): killed — Plex cannot represent a non-library
  item as a playable session; requires PMS cooperation we do not have.
- J (offline): killed — out of scope, high complexity, low frequency.
- F (client handoff): killed — low frequency, high complexity, no killer demo.

## 4. Strongest unresolved capability gap

Only one candidate survives scrutiny:

**C. Seamless representation switching (TF→TF at same timestamp) when the current
TF becomes impossible, without a consumer-visible restart.**

Current limitation: Binding chooses one authoritative TF. Rust fails over between
routes for the SAME TF. If that TF itself becomes impossible (provider removes it,
hash dies, no seeders), the user must manually request again or wait for the
scheduler's autonomous retry (which republishes a new TF but requires a new
play session). There is no in-session switch.

Required new authority: player source-open control + position restore + Binding
update mid-session. That is exactly the moonshot's native-hook territory.

Minimum viable architecture: a companion that can reopen the player at the same
timestamp on a new TF URL, while Plex keeps the session.

## 5. Architecture families explored

1. Existing consumer, deeper integration (Plex hook) — high coupling, upgrade risk.
2. Companion playback process — Plex session stays control plane; companion executes.
   Moderate cost, moderate portability.
3. Independent local player (mpv) mirroring Plex state — highest portability, highest
   complexity, duplicates consumer UX.
4. Virtual media server/player endpoint — HashSucker as media server. Duplicates
   Plex. Rejected.
5. Protocol-level execution service — clients consume HashSucker session API. High
   cost, unclear consumers.
6. No new player architecture — existing VFS→Rust + better orchestration.
7. Hybrid — different clients use different modes.

## 6. Current-path measurements (from production evidence, not new runs)

- Play start on a cached VFS item: sub-second to first byte (canary: 94 ms
  session-to-first-read).
- Seek latency: bounded, 206 ranges, cache hits.
- VFS overhead: rclone/WebDAV adds a hop but is already proven negligible in
  production (0 scanner churn after mtime fix).
- Failure recovery: Rust same-TF failover is transparent; TF-level failure requires
  a new request + republish (minutes, scheduler-driven).

So the only material gap is TF-level failure recovery during an active session.

## 7. Publication bottleneck analysis

Request→play for a NEW item: discovery → ranking → selection → Binding → handoff →
publication → VFS → scanner → Part creation → play. This is minutes for a cold
item. But the anticipation scheduler pre-warms published items, and Tier-A reuse
makes repeats instant. The moonshot cannot skip PMS library projection (Plex needs
a ratingKey/Part for a session). So "play before publication" is not feasible
without PMS cooperation. Killed.

## 8. Representation-switch analysis

Switching TFs mid-session is the one real capability gap, but:
- Different TFs may have different durations (different cuts).
- Intro lengths differ.
- Subtitle/audio track indices differ.
- PMS progress is tied to the original Part's duration.
- Switching would require: reopen at timestamp T, update Binding, update PMS
  viewOffset, handle mismatched duration.
This is genuinely hard and potentially unsafe. It is NOT a "small prototype."

## 9. Playback-session abstraction analysis

A HashSucker PlaybackSession would duplicate consumer session state. Consumers
already track position, duration, play state. The only unique HashSucker data is
TF/route identity, which is already durable in Binding. A session abstraction
adds complexity without clear consumer. Rejected.

## 10. Error UX analysis

Current errors: Plex shows generic "media unavailable" on byte failure. Rust
fails fast (no 90s hangs after the responsiveness slice). Severity: low.
Improving this requires player-level UI, which is a consumer concern, not a
HashSucker concern. Rejected.

## 11. Product capability matrix

| Capability | Current VFS→Rust | Deeper Plex hook | Companion player | Independent player | Execution service | Hybrid |
|---|---|---|---|---|---|---|
| request→play speed | good | same | same | worse (no library) | same | same |
| byte authority | yes | yes | yes | yes | yes | yes |
| session identity | consumer | consumer | consumer | HashSucker | HashSucker | consumer |
| same-TF recovery | yes (Rust) | yes | yes | yes | yes | yes |
| representation switching | no | possible | possible | possible | possible | possible |
| player failure UX | consumer | consumer | consumer | HashSucker | HashSucker | consumer |
| watch-state preservation | yes | yes | yes | no | no | yes |
| remote-control preservation | yes | yes | no | no | no | yes |
| casting | yes | yes | no | no | no | yes |
| subtitles/audio | yes | yes | maybe | maybe | maybe | yes |
| Plex upgrade resilience | high | low | medium | high | medium | high |
| portability | Plex-only | Plex-only | any | any | any | mixed |
| complexity | low | high | medium | high | high | medium |
| user-visible gain | baseline | low | low | low | low | low |

## 12. Kill criteria
- No killer demo produces meaningful visible improvement over current VFS path.
- All valuable recovery already lives in Rust.
- Plex session integration is brittle.
- Upgrade coupling too high.
- Standalone player adds more complexity than value.
- Simpler helper gets 80% of benefit.

## 13. Build criteria
- One killer demo clearly valuable.
- One architecture dominates.
- Minimum authority required understood.
- Plex semantics preservation proven feasible.
- Rollback simple.
- Maintenance burden acceptable.

None of the build criteria are met for representation switching (the only
surviving capability), because the safety/correctness problems are unsolved
and the cost is high.

## 14. Killer demos

### Demo 1: TF becomes impossible mid-play
User is watching a movie. The current TorrentFile's provider route dies
permanently (hash removed, no seeders). Current: Rust failover exhausts,
playback stops, user must re-request (minutes). Moonshot: HashSucker selects
alternate TF, reopens at same timestamp, Plex session continues.
Visible delta: no manual re-request, no visible restart.
Authority required: player source-open + position restore + Binding update.
Safety problems: duration mismatch, different cuts, subtitle/audio index mismatch.

### Demo 2: Cross-client handoff
User watching on desktop, clicks "continue on TV." Playback moves at exact
position with exact TF. Current: not possible (each client is independent).
Visible delta: seamless handoff.
Authority required: session control across clients.
Safety problems: client capabilities differ (subtitles, audio, track indices).

### Demo 3: Direct play before publication
User requests an item not yet in Plex library. HashSucker launches playback
immediately from Binding/TF. Current: must wait for publication + scanner.
Visible delta: minutes faster first play.
Authority required: PMS session for non-library item (does not exist).
Safety problems: Plex cannot represent a non-library item as a playable session.

## 15. Non-goals
- New media library UI
- Metadata server
- User/account replacement
- Plex clone
- Transcoder rewrite
- Chromecast replacement
- Cloud streaming platform
- Mobile app
- Giant cross-client framework

## 16. Plex value preservation map
Plex is genuinely good at: metadata UI, library, accounts, watch history,
play queues, remote control, companion apps, casting, subtitles, track UI,
discovery, polished client UX, TV platform support.

The moonshot must consume this value, not reimplement it. Any architecture
that loses remote control, casting, or watch-state persistence is unacceptable.

## 17. Simple-alternative comparison
- Could a normal mpv wrapper + Plex webhook/API get 80% of value? No —
  webhooks fire after events, not before source open. No interception.
- Could Jellyfin already do it? Jellyfin has a different plugin model but
  same fundamental constraint: client owns playback.
- Could Plex's remote-control API do it? No — it controls, doesn't replace
  byte source.
- Could a tiny helper process achieve the demo? No — without player source
  control, no.

## 18. Maintenance cost model
- Lines of code: 500–2000 for a native hook; 200–500 for a companion process.
- Plex-version coupling: HIGH (native hook) / MEDIUM (companion).
- mpv-version coupling: MEDIUM.
- User setup complexity: HIGH (native hook requires LD_PRELOAD wrapper).
- Failure modes: player wedge, PMS session leak, progress discontinuity.
- Test burden: high (requires real Plex + real content).
- Upgrade burden: every Plex update risks breakage.
- Support burden: high (version matrix).
- Rollback: easy (unset env var) for hook; moderate for companion.

## 19. Security model
- Local player control: localhost-only, no auth needed for single-user.
- Auth tokens: must not leak to HashSucker (strip X-Plex-Token).
- Arbitrary file access: HashSucker already controls TF access via Binding.
- Session hijacking: low risk on localhost.
- Cross-user Plex accounts: not in scope.

## 20. Strategic product direction
HashSucker's value today is: discovery → ranking → fulfillment → durable
identity → byte authority → consumer integration → autonomous convergence.

Player execution is an **adjacent product**, not a deepening of the core
thesis. The core thesis is about byte authority and identity, which is
already achieved. Player execution would create "HashSucker Player" as a
separate product line, with its own support burden and user expectations.

## 21. Competitive/simple alternative test
- Could a normal mpv wrapper get 80%? No (no interception point).
- Could Jellyfin already do it? No (same constraint).
- Could Plex's API do it? No.
- Could a tiny helper achieve the demo? No.

## 22. Kill criteria (explicit)
- No killer demo produces meaningful visible improvement over current VFS path.
  → Demo 1 (TF failover) is the only candidate, but safety problems are unsolved.
- All valuable recovery already lives in Rust. → True for same-TF; TF-level is the gap.
- Plex session integration is too brittle. → Likely true for native hooks.
- Upgrade coupling too high. → True for native hooks.
- Standalone player adds more complexity than value. → True.
- Simpler helper gets 80% of benefit. → False, but the benefit is marginal.

## 23. Build criteria (explicit)
- One killer demo clearly valuable. → Demo 1 is valuable but unsafe.
- One architecture dominates. → No; C has coupling, E has unproven feasibility.
- Minimum authority required understood. → Yes (player source-open + position restore).
- Plex semantics preservation proven feasible. → Not proven.
- Rollback simple. → Yes for hooks.
- Maintenance burden acceptable. → No for native hooks.

**Build criteria are NOT met.**

## 24. Product pitch (strongest case for building)

### Problem
When a TorrentFile becomes permanently unavailable mid-playback, the user must
manually re-request (minutes) or wait for autonomous retry. Rust handles
same-TF route failover, but TF-level failure requires a new play session.

### Insight
HashSucker already knows the exact Binding/TF and can resolve alternates. It
has the authority to select a different representation. The missing link is
player source-open control.

### Product
A companion playback controller that, on TF-level failure, reopens the player
at the same timestamp using an alternate TF URL, while preserving the Plex
session identity.

### User experience
Playback pauses briefly (<2s), then resumes from the same position on a
different representation. No manual re-request. No visible restart.

### Why now
Binding/TF identity, Rust byte authority, serviceability probes, and same-TF
failover are all proven. The only missing piece is player source control.

### Why not simpler
VFS→Rust already handles same-TF recovery. TF-level failure requires either
a new request (minutes) or player source control (seconds).

### Defensibility
HashSucker's unique advantage is durable TF identity + serviceability-aware
selection. No other tool has this.

### Cost
500–2000 lines, high Plex coupling, high maintenance, unproven safety.

### Kill switch
Unset env var → Plex runs stock. No data loss.

## 25. Anti-pitch (strongest case against)

- The current VFS path already works. Users are not complaining about playback
  failure recovery because Rust handles the common case.
- TF-level failure is rare (requires a hash to die mid-play, not just a route).
- The safety problems (duration mismatch, different cuts, subtitle/audio index
  mismatch) are genuinely hard and could cause worse UX than a clean stop.
- Native hooking has high upgrade coupling; every Plex update risks breakage.
- The complexity budget (500–2000 lines + testing + maintenance) is large for
  a rare failure mode.
- A standalone "HashSucker Player" would be a separate product with its own
  support burden, competing with Plex/Jellyfin instead of complementing them.
- The simpler alternative (better scheduler retry + faster republish) could
  reduce the TF-level failure window from minutes to seconds without any
  player authority.

## 26. Rebuttal

The rebuttal is weak. The anti-pitch is mostly correct:
- TF-level failure is genuinely rare.
- The safety problems are real and unsolved.
- The simpler alternative (faster autonomous retry) addresses 80% of the pain
  without player authority.
- The maintenance cost is disproportionate to the frequency of the problem.

The only compelling part of the pitch is "direct play before publication"
(Demo 3), but that requires PMS cooperation that does not exist.

## Final recommendation

**PARK**

Reasoning:
- The only surviving capability (TF-level representation switching) is
  genuinely valuable but genuinely hard and genuinely rare.
- The safety problems (duration/cut/subtitle/audio mismatch) are unsolved
  and could make the UX worse, not better.
- The simpler alternative (faster autonomous retry + earlier pre-warming)
  addresses most of the pain without player authority.
- Build criteria are not met (Plex semantics preservation unproven,
  maintenance burden unacceptable).
- The moonshot should not be killed (the capability gap is real and
  HashSucker is uniquely positioned), but it should not be built now.

### If promoted later
- Product: "HashSucker Playback Recovery" (companion controller, not a player).
- Architecture family: companion playback process (Family 2).
- Killer demo: Demo 1 (TF dies mid-play → alternate TF at same timestamp).
- Minimum prototype: scheduler-driven pre-warm of alternate TFs + companion
  that reopens mpv on failure. No native hooks. No Plex modification.
- Build criteria to meet first: prove alternate-TF reopen preserves Plex
  session (position + progress + watch state) on a controlled fixture.

### Do not build
- Native libmpv hooks (upgrade coupling too high).
- JS webpack hooks (upgrade fragility).
- Standalone HashSucker Player (adjacent product, not core thesis).
- Direct-play-before-publication (requires PMS cooperation).

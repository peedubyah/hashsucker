# Product Reconnaissance — HashSucker (2026-10)

Status: reconnaissance only. No code, no seam selection, no implementation.
Purpose: discover what HashSucker has actually become and which moonshots emerge
from the real system rather than from abstract architecture.

## 0. Scope and method

Examined (not summarized mechanically; product direction extracted):

- Repo docs: `README.md`, `GOALS.md`, `docs/architecture.md`,
  `docs/discovery-ranking.md`, `docs/playback-delivery.md`,
  `docs/operations.md`, `docs/ROADMAP.md`, `docs/GRADUATION-MATRIX.md`,
  `docs/seam-audit.md`, `docs/CROSS-FILE-KEYING-AUDIT.md`,
  `docs/PRODUCTION-STATE-2026-09-11.md`, `docs/S1-CONTROL-CONTRACT.md`,
  `docs/TEST-STRATEGY.md`, `src/PRODUCTION-PLAYBACK-TESTING.md` (via handoff).
- Strategy/research: `docs/strategy/2026-10-post-core-product-strategy.md`,
  `docs/strategy/2026-10-post-core-roadmap.md`,
  `docs/strategy/2026-10-capability-proof-of-need.md`,
  `docs/research/open-questions.md`, `docs/phases/*`,
  `docs/retrospectives/*`.
- State: `PLANS.md`, `handoff/CURRENT.md`, `docs/BUILD-LOG.md`.
- Wiki projection: `wiki/*` (non-authoritative; used only for orientation).
- Prior moonshot work: `experiments/plex-player-hook/*`,
  `docs/archive/hy4/moonshot/*`.
- Runtime: live `hashsucker` compose stack, `GET /health`, `/api/diagnostics`,
  `/api/future-intents`, `/api/metrics`, `/api/operator/*`, container logs,
  production DBs (read-only via API), Rust `/metrics`.
- Code surfaces: `media-search/src/server/*`, `media-search/src/api/*`,
  `media-search/src/lib/{vfs,consumers,library,anticipation,lifecycle,...}`,
  `data-plane/src/*`.
- History: `git log --oneline` (top 40) and retained commit narratives in
  `handoff/CURRENT.md`.

No product state was mutated. No code was changed.

## 1. What HashSucker claims to be vs. what it is

Claim (README): "self-hosted media fulfillment layer for debrid-backed
Plex/Jellyfin libraries"; "Give it media intent; it finds the best viable
release, makes it playable, and keeps the lifecycle healthy automatically";
"no management UI by design."

Reality today:

- It is a two-database, two-plane control plane: discovery/ranking/intent in
  Node, exact-byte delivery in Rust, with a filesystem importer as a third
  service. It is not a resolver anymore; it is a durable fulfillment OS.
- It owns exact-object identity across providers (`infoHash` + canonical
  internal path + exact size), bindings, placements, exposures, repair
  transactions, future intents, publication, byte-health, evidence aggregates.
- It has grown a household-facing web UI (Home/Search, Requests, Library,
  Downloads, Settings) and a separate operator TUI. The "no management UI"
  claim is now false at the operator layer and only partly true at the
  household layer.
- It has grown predictive/anticipatory machinery (future intents, scheduler,
  prewarm) whose value is explicitly unmeasured and mostly self-traffic.
- It has grown an evidence/observability substrate (`evidence_observations`,
  source census, calibration) that is more mature than several product
  behaviors it is meant to justify.

What it has stopped doing / backed away from:

- Provider-direct byte delivery is now a compatibility path; authoritative
  bytes go through Rust `/files/:tfId`.
- Native player interception was explored and parked.
- Show-identity resolver integration was explored and parked.
- Contextual-memory abstraction was explored and parked.
- Predictive prewarming expansion is vetoed.
- Watched-state ownership is deferred.
- Automated retirement defaults to OFF.

What evolved accidentally (but now defines the product):

- Exact-object identity became the spine; everything else is a projection
  over it.
- "Consumer-visible vs byte-serviceable" became a first-class semantic split
  after a real failure (Lowdown).
- Readiness became a scattered, multi-layer concept rather than one state.
- Publication became both a core product step and a compatibility tax.
- Operator observability (TUI, diagnostics, byte-health, serviceability)
  became a product surface in its own right.

What remains aspirational:

- Memory actually changing selection outcomes (write path not yet landed).
- Consumer reconstruction beyond a single VFS row.
- Preservation policy and keep/remove expression.
- Route-health knowledge surviving process lifetime.
- Scheduled canary cadence and PMS-outage continuity.
- Measured time-to-play wins from anticipation.

Docs vs. runtime disagreement (observed this round):

- `STREAM_BYTE_ROUTE` defaults to `cached` in compose, but PLANS records the
  cutover as NOT FLIPPED because of a fill/join concurrency race. The docs
  and the compose default disagree; the runtime is on `cached` per
  compose, yet the acceptance gate is recorded as failed. This is a live
  tension, not a documentation nit.
- Production diagnostics report `degraded` because Jellyfin credentials are
  rejected (`JELLYFIN_AUTH_FAILED`), while Plex is healthy. Retirement
  requires Jellyfin by default, so retirement is effectively dead in this
  environment.
- Production DB/schema drift: production lacks `evidence_observations` and
  `evidence_query_observations` that current `main` creates; historical rows
  predate metadata columns. Many production behaviors are therefore
  measured on scratch DBs, not on the live corpus.
- Corpus ingestion is `degraded` (delta 21 ok / 279 failed decompress).
- Production has 14 incomplete library items and 6 prepared items; 145 of
  164 published.
- Anticipation scheduler is active (ticks every 60s) but the prior audit
  found zero pre-explicit-demand fulfillments; most volume is synthetic/proof
  traffic.

## 2. Product surfaces and the job each performs

| Surface | Job actually performed |
|---|---|
| `POST /api/media-request`, Seerr ingress | Translate external intent into durable discovery/ranking/selection/binding/publication; idempotent re-entry. |
| `POST /api/media-prepare` | Pay provider proof off the human path; persist reusable truth with no presentation. |
| `POST /api/future-intents` + scheduler | Anticipatory preparation ahead of demand; prepare → publish → byte probe → prewarm. |
| Requested-season fan-out / season ownership | One owner per season; episodes converge autonomously; failed rows park honestly. |
| `/vfs`, `/vfs/Movies`, `/vfs/TV` | Authoritative consumer-neutral namespace; Node selects TF, Rust serves bytes. |
| `/stream/:type/:id` | Dual-mode resolver: compose default `STREAM_BYTE_ROUTE=cached` can 307 to `/bytes/:tfId`; otherwise provider redirect. Revalidates/selects provider in provider mode. |
| `GET /bytes/:tfId` (Rust) | Exact-TorrentFile byte authority with Range/cache/coalescing/recovery. |
| `/api/library/*` (republish, unpublish, reconcile, retirement) | Projection lifecycle over durable truth; exact continuity primitive. |
| `GET /api/diagnostics` | Readiness without SQLite archaeology; consumer/provider/publication/lifecycle. |
| `/api/operator/*` + TUI | Repair/inspect/retry/reset/probe; the real management surface. |
| Playback observer (Plex sessions) | Consumption-aware retention; accepted-TF evidence. |
| Rust `/metrics`, byte-health | Runtime attribution: routes, cache, coalescing, scheduler, serviceability. |
| Web UI | Household appliance: search/request, library, downloads, settings. |
| Evidence endpoints | Source yield, calibration, provenance; measurement substrate. |

The product is already performing two distinct jobs that are rarely separated
in documentation: (a) durable exact-object fulfillment, and (b) consumer
projection and visibility. Most friction lives in the seam between them.

## 3. Real user journey (from the user's side)

Movie request:

1. User requests in Seerr/Requestrr/API.
2. Waits. Hidden: discovery (corpus + live), ranking (~50 candidates),
   availability, binding selection, handoff persistence, publication
   (VFS materialization, STRM, Jellyfin notify, metadata hydration, Plex
   targeted refresh + deterministic ingest confirm).
3. Item appears in Plex/Jellyfin. Consumer visible, not necessarily
   byte-serviceable.
4. User clicks play. Hidden: PMS Part resolution, VFS entry, Node TF
   selection, Rust capability acquire, provider byte read, cache fill.
5. Playback starts. Observed: sub-second first byte on cached items
   (canary 94 ms session-to-first-read); seeks are bounded 206 ranges.
6. Seek/stop. Hidden: Rust Range serving, coalescing, cache; PMS
   `viewOffset` advances independently of byte source.
7. Return later. Tier-A reuse makes exact repeat effectively instant
   (p50 0.149 ms in scratch proof); near-repeat still pays full discovery.
8. Better representation appears later. Hidden: upgrade-watch (~3 lifetime
   firings / 95 rows), durability veto, byte-readiness gate.
9. Provider route dies. Hidden: same-TF failover, byte-health suppression,
   positive-health decay after 10 min, class-fair scheduler drain.
10. TF itself dies. Hidden: scheduler eventually republishes a new TF;
    user-visible gap is minutes, not seconds.

Season request:

1. User/Seerr requests season or series.
2. Hidden: Seerr TV fan-out; one season owner; per-episode prepare/publish;
   scheduler ticks every 60s; anticipation prewarm.
3. Episodes appear incrementally in Plex/Jellyfin.
4. Newly aired episodes: future intents wake inside prepare window; failed
   rows get one `releasedWake`; parked rows retry on 7-day cold cycle.
5. Recovery from unavailable route/representation follows the same path as
   movies, per episode.

Where Plex/Jellyfin are doing useful work:

- Metadata, library, accounts, watch history, play queues, remote control,
  casting, subtitles/audio track UI, polished client UX, TV platforms.
- PMS progress (`viewOffset`) is authoritative for resume position.
- Part identity and scanner presence gate consumer playability.

Where they are merely projections over HashSucker:

- Byte identity, representation choice, route health, serviceability,
  recovery, publication truth, future readiness. The VFS row names the
  release the Binding declares; the Binding is durable truth.

Visible latency that matters:

- Cold new item: minutes (discovery → publication → scan → Part).
- Cached repeat: sub-second.
- TF-level failure recovery: minutes (scheduler-driven).
- RD rate-limit waits: ~380 ms per torrents-list (not user-visible alone,
  but compounds).
- Scheduler granularity: 60 s ticks; future wake delays are on that scale.

## 4. Production evidence (this round, not past reports)

Live stack: media-search healthy, data-plane healthy, edge healthy,
torbox-importer running. Diagnostics degraded only because Jellyfin auth
fails; Plex healthy; both providers healthy.

Observed:

- Library: 164 items, 145 published, 5 absent, 14 incomplete; VFS 73 movies
  + 72 episodes; prepared count 6.
- Future intents: many states including `playable`, `withdrawn`, `failed`;
  at least 3 rows parked after 6 attempts (`class=P5 actionable=false`).
- Scheduler: class-fair drain; snapshot of 3 failed rows; 0 actions; tick 1 ms.
- Anticipation: active ticks every 60s; season sync updates known counts;
  no pre-explicit-demand fulfillment evidenced historically.
- Playback observer: polls Plex sessions every 2s; 0 sessions at observation
  time; accepted-TF evidence only when real sessions occur.
- RD rate limiter: ~380 ms spacing on `torrents-list`, continuous.
- Corpus: 1.58M candidates, 5.7k associations, 4.6k pending enrichment;
  ingestion degraded (279 failed decompress in latest delta).
- Jellyfin observations: 149, 0 present, 3 absent, 146 unknown (auth failure).
- Plex observations: 149, 38 present, 111 absent, 0 unknown.
- Cached byte routing: default compose says `cached`, but the acceptance
  gate is recorded as failed on same-file concurrency; this is unresolved.
- Byte-health: positive observations decay after 10 min; blocked items
  recover when route recovers (no human request).

Repeated patterns:

- Scheduler starvation was real and fixed; class-fair drain now prevents
  blocked P0 backlogs from starving recovery.
- Publication confirmation staleness was real and fixed by deterministic
  ingest confirm.
- VFS/handoff divergence was real and fixed by binding-authoritative
  recovery.
- RD mapping bug was real and fixed.
- TorBox SNI reset was an external WAN filter, not a provider fault;
  97% of bindings were TorBox-only and unserviceable until the operator
  fixed egress. This is the strongest evidence that route diversity and
  route-health knowledge matter more than player control.

## 5. Authority map

| Domain | HashSucker | Plex/Jellyfin | Shared | Projection only |
|---|---|---|---|---|
| Media intent | Canonical (`media_intents`, future intents) | Request ingress (Seerr) | Requested item identity | — |
| Representation selection | Canonical (ranking, binding) | — | — | — |
| Exact TorrentFile identity | Canonical | — | — | — |
| Provider route choice | Canonical for selection; Rust runtime within TF | — | — | — |
| Byte execution | Rust authoritative | — | — | — |
| Cache | Rust runtime | — | — | — |
| Serviceability | Runtime registry + probe | — | — | consumer-visible flag |
| Lifecycle/retry | Canonical scheduler + repair | — | — | — |
| Publication | Canonical binding/exposure | Consumer scan/Part | Published state | VFS/STRM |
| Consumer visibility | Observed/projection | Authoritative presence | Reconcile | — |
| Playback session | Observed only (accepted TF) | Canonical | View offset | — |
| Progress/watch state | — | Canonical (Plex/Jellyfin) | Observed | — |
| UI/navigation | Household appliance + operator TUI | Canonical clients | — | — |
| Accounts/users | — | Canonical | — | — |
| Metadata | Cinemeta corpus | Canonical library metadata | IMDb/TMDB/TVDB ids | — |

Awkward splits:

- Serviceability is precise in HashSucker but only partially reaches the
  consumer; consumers see generic unavailability.
- Publication is durable truth in HashSucker but consumer visibility is
  observed, not owned; retirement depends on consumer observations that are
  currently broken (Jellyfin auth).
- Playback session is owned by the consumer, but HashSucker repeatedly
  reconstructs identity from it (Plex session polling, accepted-TF evidence).
- Route health is runtime-only in Rust and Node; no durable history survives
  process lifetime, so no decision can use age or correlation.
- Consumer-specific byte resolution is centralized in VFS authority, but
  Jellyfin also has a direct Binding path, so two adapters coexist.

## 6. Compatibility-tax map

Essential product semantics:

- Media intent and requested scope.
- Release/TorrentFile exact identity.
- Binding (item/path → release/placement/TF/exposure).
- Serviceability (can this exact TF produce bytes here now).
- Byte authority and Range serving.
- Publication as durable desired state.
- Lifecycle, retry, future intent, recovery.
- Evidence/telemetry for decisions.

Compatibility adapters (exist because Plex/Jellyfin require different shapes):

- VFS WebDAV namespace and rclone mount.
- STRM generation and content verification.
- Scanner refresh and Part confirmation.
- Jellyfin notification.
- `/stream` provider redirect.
- `/media/:infoHash/:fileIndex` proxy.
- Consumer-specific path roots and mount assumptions.
- Plex session polling for retention.

Is there a more powerful layer underneath both adapters? Yes, and it already
exists implicitly: `Binding → TorrentFile → bytes` is consumer-neutral. The
VFS and STRM layers are projections over it. The open question is not
whether that layer exists; it is how much of the consumer experience can be
served from it without losing Plex/Jellyfin value (accounts, watch state,
remote control, casting, subtitles UI). The direct `/bytes/:tfId` path proves
the byte layer is already consumer-neutral; what is missing is a
client-facing readiness/identity contract and a decision about which clients
should use it.

## 7. Duplicated consumer semantics

Duplicated across Plex and Jellyfin:

- Playback readiness.
- Representation identity.
- Serviceability.
- Route health.
- Session diagnostics.
- Initial byte source.
- Recovery state.
- Publication visibility.

Could HashSucker become a consumer-neutral execution/control layer? It
already is at the byte layer: the authoritative VFS path selects a TF and
Rust serves bytes; `/bytes/:tfId` is consumer-agnostic. But it is not
neutral at the session layer: Jellyfin lacks Plex's session-aware retention,
and Plex retains Part identity and watch state. A full consumer-neutral
execution layer would duplicate session/watch state, which the strategy
explicitly vetoes. The realistic middle ground is a consumer-neutral byte
and readiness layer that feeds, but does not replace, consumer session state.

## 8. Playback: Plex path vs. Jellyfin path

Plex path:

`Plex → PMS → VFS (rclone/WebDAV) → Node /vfs → Rust /files/:tfId →
Node S-1 projection → cache/provider bytes → stream back`

Jellyfin path (directer):

`Jellyfin → STRM/Binding → /bytes/:tfId → Rust /files/:tfId → bytes`
(plus Jellyfin's own scan/monitoring)

Comparison:

- Cleaner/more direct: Jellyfin's direct Binding path removes the
  filesystem/WebDAV/scanner/Part indirection. It is closer to a
  consumer-neutral byte contract.
- Plex retains: remote control, casting, watch state, Part identity,
  session polling, richer consumption integration, subtitles/audio track UI.
- Semantic loss in Plex VFS path: TF identity is derived from the VFS
  entry rather than session-bound; scanner/mtime races historically caused
  churn (fixed).
- Semantic loss in Jellyfin direct path: no session-aware retention, no
  accepted-TF evidence from playback, no Part-level confirmation.
- Neither path gives HashSucker player source-open control; both treat the
  consumer as owner of the session.

Do not replace either. The comparison suggests the leverage is in the shared
byte/readiness layer, not in forcing one consumer's shape onto the other.

## 9. Latency boundaries (what users actually notice)

| Boundary | Current | User-visible? |
|---|---|---|
| Request → first playable (cold) | Minutes (discovery/ranking/binding/publication/scan/Part) | Yes |
| Request → first playable (prepared Tier-A) | Sub-ms reuse (p50 0.149 ms in scratch proof) | No (already instant) |
| Playback start (cached VFS item) | Sub-second (94 ms canary session-to-first-read) | Barely |
| Seek | Bounded 206 ranges, cache hits | No |
| Future episode convergence | 60s scheduler ticks; 15m→1h→4h→24h backoff | Sometimes (hours) |
| Recovery from unavailable route | Same-TF failover transparent; TF-level = minutes | Yes (TF-level) |
| Recovery from unavailable representation | Selection gate + republish | Yes |
| RD rate-limit waits | ~380 ms per torrents-list | Compounds |

If a moonshot saves 5 ms, kill it. The visible wins are in cold-start
minutes, TF-level recovery minutes, and repeated ranking labor.

## 10. Failure UX

What users see:

- Plex/Jellyfin show generic "media unavailable" on byte failure; HashSucker
  knows the exact reason (provider, TF id, serviceability state, retry
  window).
- Diagnostics reports provider/consumer/publication state but is operator
  surface, not consumer surface.
- Byte-health suppresses known-bad routes and decays positive health after
  10 min; blocked items recover autonomously when the route recovers.
- Serviceability probe distinguishes consumer-visible from byte-serviceable
  at selection time.
- Publication has typed stage errors (`durable-publication-failed`,
  `adapter-publication-failed`).

Opportunity: HashSucker has precise truth that never reaches the user or the
consumer. But consumer UX constraints (Plex/Jellyfin own errors) limit
direct propagation. The more realistic opportunity is operator-grade
attribution that is already improving, plus consumer-compatible readiness
gating so an item is not shown as playable until it is byte-serviceable.

## 11. What still requires Plex publication

Publication is required for:

- Consumer library presence and watch state.
- Part identity for PMS sessions.
- Scanner-driven discovery by the consumer.
- Remote control/casting/subtitle UI (consumer-owned).

Publication is a compatibility tax for:

- Byte authority (already available via `/bytes/:tfId`).
- Representation identity (already in Binding).
- Readiness (can be probed without publication).

"Play Now" before publication is not feasible for Plex because PMS needs a
ratingKey/Part for a session. But it is feasible for clients that can consume
a byte URL directly (mpv, Infuse, Jellyfin in some modes). This splits the
publication question by client capability rather than treating all playback
as publication-bound.

## 12. Representation lifecycle

Binding is durable and sticky (one active per item), but adaptive:

- Upgrades replace the active Binding when a better representation is
  selected (with durability veto).
- Superseded/failed bindings are never reactivated.
- Repair transactions plan/execute changes without discovery.
- Known-bad memory (future) will add negative selection pressure.

Tension: durable identity vs. adaptive playback. The Binding is meant to be
permanent enough to survive route loss, but replaceable enough to upgrade.
TF-level failure during a session is not handled in-session; it requires a
new request or scheduler-driven republish. This tension is real, but the
in-session switching variant is rare and safety-uncertain (duration/cut/
subtitle/audio mismatch). The more tractable variant is autonomous
replacement between sessions, which the scheduler already approaches.

## 13. Cross-client semantics (revisited)

HashSucker already centralizes:

- Byte authority (Rust).
- Representation identity (Binding/TF).
- Serviceability (runtime registry + probe).
- Route health (runtime budgets/cooldowns).
- Recovery (same-TF failover, byte-health).

Consumer-specific duplication remains in:

- Session diagnostics (Plex session polling vs. none for Jellyfin).
- Publication visibility confirmation.
- Watch-state ownership.
- Client-class compatibility (none recorded today).

The concept of a consumer-neutral execution/control layer exists implicitly
at the byte layer. It does not exist at the session layer, and should not be
forced there without migration-loss evidence.

## 14. Session identity

Current state:

- No first-class HashSucker playback session entity.
- Plex session identity is reconstructed every 2s by polling
  `/status/sessions`, mapping guids to IMDb, fetching metadata for unmapped
  entries, and inferring completion conservatively.
- `accepted_torrent_files` records exact LibraryItem + TF from an observed
  PMS session with positive progression.
- Rust has no session concept; it serves bytes for a TF.

Is a first-class session missing? Reconstruction is repeated and somewhat
expensive (Plex metadata fetches), but a durable session object would
duplicate consumer session state, which the strategy vetoes. The lighter
fix is to cache the session→identity mapping and treat accepted-TF memory
as the durable residue of sessions. A full session abstraction is not
earned unless reconstruction cost or correctness becomes a measured
problem.

## 15. Player observability

The Plex canary already observes session, Part, TF, mpv time-pos, seek,
PMS viewOffset, exact byte reads. HashSucker does not operationally use
position except for accepted-memory evidence and retention.

Potential uses:

- Cache planning (next-chunk warming) — Rust already does sequential-read
  detection and prefetch; player position could reduce false positives
  after seeks.
- Next-episode warming — could use position to predict episode completion;
  but anticipation already keys on future intents.
- Recovery and handoff — position is consumer-owned; HashSucker cannot
  reopen a player without player authority.

Player observability is a latent primitive. It is not yet a product
capability because no measured cache or recovery improvement depends on it.

## 16. Cache behavior through a product lens

Rust cache: fixed 8 MiB grid, coalescing, fills, seeks, backfill, plus
playback-intel sequential detection and bounded prefetch (default ON,
Try/Auto modes, 1-4 chunks ahead, 3 sequential reads to arm).

Policy is driven by byte requests, not player intent. Higher-level playback
intent could improve:

- Likely-seek warming (if seek patterns are predictable).
- Next-episode warming (if completion is predictable).
- Handoff warming (if cross-client continuation is supported).

But Range observation already supplies the strongest signal, and the
prefetch module is explicitly conservative (never delays demand, never
amplifies provider calls). A player-aware cache policy is only worth
building if Range signal proves insufficient in measured traces. Kill it
otherwise.

## 17. Requested-season + playback convergence

HashSucker already does request season → prepare episodes → publish → play.
The opportunity is to make "requested" mean "continuously ready to play"
rather than "published eventually":

- Pre-serviceability: probe byte readiness before claiming playable.
- Prewarming: head+tail grid fill before play.
- Next-episode readiness: prepare N+1 when N is playing.
- Route diversity ahead of play: enrich second provider before demand.
- Cache warming based on intent: warm likely episodes.

This is more frequent and less risky than player interception. It attacks
the minutes-scale cold start and the TF-level recovery gap at the
fulfillment layer rather than the player layer.

## 18. Hidden operator burden (remaining)

Already solved or surfaced:

- Why isn't this playable? → serviceability + diagnostics + byte-health.
- Why hasn't this appeared? → publication stages + operator requests.
- What route is it using? → resolver telemetry + byte-health provider.
- Why did selection choose this? → search-debug + skippedCandidates.
- Is the provider broken? → diagnostics + budgets/cooldowns.
- Is this exact TF healthy? → byte-health + serviceability probe.

Still burdensome:

- Why is Jellyfin auth broken and retirement dead? (currently degraded)
- Why are 14 items incomplete? (operator must inspect)
- Why is corpus ingestion degraded? (decompress failures)
- Why are 3 intents parked after 6 attempts? (needs reason endpoint)
- Whether a published item will actually converge to playable.
- Whether an alternate TF/route will recover, and when.
- Production/schema drift and cached-routing race status.

The remaining burden is increasingly about convergence status and external
auth, not about identity or byte authority.

## 19. Historical failure classes as product clues

Failures: scanner churn from mtime; publication confirmation stale;
scheduler starvation; wrong identity; provider reachability; unserviceable
Binding; concurrent cache truncation; VFS/handoff divergence; RD mapping bug;
future wake delay.

Common pattern: durable identity and runtime/projection state diverged;
failures propagated across boundaries because readiness was conflated;
retries were unbounded or misclassified; consumer projections were treated
as truth.

Implication: the next moonshot is more likely to be about invariant-driven
runtime, readiness orchestration, and projection minimization than about
player control. The failures cluster around boundaries, not around playback
execution.

## 20. Latent abstractions (duplicated concepts)

Concepts appearing under different names across subsystems:

- Intent/request: `media_requests`, `media_intents`, `future_intents`,
  `download_requests`.
- Binding/handoff/publication: `bindings`, `playback_handoffs`,
  `exposures`, VFS entries, STRM files.
- Serviceability/readiness/availability: byte-health, serviceability probe,
  availability revalidation, `/api/library` serviceable, diagnostics.
- Route: provider placement, provider file, delivery capability, byte-health
  provider.
- Retry: job-retry, scheduler wake classes, byte-health backoff,
  capability reacquisition.
- Consumer confirmation: reconcile, exposures, retirement, Plex ingest
  confirm.

Duplicated concept that most strongly hints at a missing abstraction:
**readiness**. It is computed in at least four places (publication,
byte-health, serviceability probe, diagnostics) with no single owner. This
is a candidate moonshot in itself.

## 21. Dead/unused code as archaeology

- `media-metadata.js`: table defined, module never imported (dead).
- Show-identity resolver: built, benchmarked, parked.
- Contextual-memory abstraction: replayed, parked.
- Predictive prewarming expansion: vetoed.
- Promotion/download workers: exist with zero production rows.
- Compatibility taxonomy: parked pending observed divergence.
- Native player hook: explored, parked.
- Provider-direct byte path: retained as compatibility, not primary.

Reading: HashSucker has a healthy discipline of parking. The dead code is
mostly "unrealized useful primitives" or "obsolete compatibility," not
failed products. The most interesting unrealized primitive is the
evidence substrate, which has now landed but has not yet driven a decision.

## 22. Git history: product direction

Major transitions, in order of implication:

1. Corpus + resolver (search/media) → discovery/ranking.
2. Provider placement and binding → durable fulfillment.
3. Rust data plane → exact-byte authority moved out of Node.
4. VFS authority → consumer projection over durable truth.
5. Serviceability → consumer-visible separated from byte-serviceable.
6. Requested-season scheduler → autonomous convergence.
7. Evidence instrumentation → measurement substrate.
8. UI split → household appliance vs operator control room.

Consistent direction: from resolver/proxy to durable exact-object
fulfillment control plane with consumer projections and autonomous
convergence. Player execution was repeatedly explored and parked. Memory
and readiness are the next natural layers, not player ownership.

## 23. Product trajectory

HashSucker began as: a media search/resolver with a release corpus.

It has evolved into: a durable exact-object fulfillment control plane with
consumer projections, autonomous convergence, and an operator surface.

Architectural direction has consistently been: exact identity first, then
byte authority, then consumer projections, then autonomous lifecycle,
then measurement/evidence. Player execution and taste prediction are
explicitly out of the core thesis.

Remaining tension: durable identity vs. adaptive playback; consumer
projections vs. consumer-neutral execution; measured value of memory and
prediction; operator burden around auth and convergence; cached byte
routing concurrency race.

Therefore the next moonshot may be: not player interception, but making
"ready to play" a first-class autonomous state and reducing projection tax
— or a memory layer that measurably removes repeated work.

## 24. Moonshot candidates

### 1. Readiness Orchestration (first-class "ready to play")
- Observed tension: publication, byte-health, serviceability probe, and
  diagnostics each compute readiness differently; an item can be published
  and consumer-visible while byte-unserviceable.
- New capability: one owned readiness state with autonomous convergence
  actions and honest consumer/operator surfacing.
- User-visible: fewer "media unavailable" after click; items appear as
  playable only when byte-serviceable; clearer recovery ETA.
- Why existing architecture cannot simply do it: readiness is scattered
  across Node publication, runtime byte-health, probe, and diagnostics;
  no single owner or state machine.
- Smallest architecture change: unify readiness ownership and scheduler
  actions around it; no new consumer.
- Preserves: Plex ecosystem (readiness gates visibility, does not replace).
- Cost: medium.
- Killer demo: request a season; each episode transitions published →
  byte-serviceable → ready with probe proof; playing any episode starts
  without generic failure.
- Kill argument: readiness checks add latency without preventing failures,
  or consumers ignore the state.

### 2. Accepted Representation Memory (P1) + known-bad
- Observed tension: 63 repeat groups on 482 requests; repeats re-run
  ~50-candidate ranking; transcode traps re-derived every request; reuse
  fast path only covers byte-identical exact published items.
- New capability: persist (TF, outcome, reason, context); prefer accepted;
  avoid known-bad; explained preference.
- User-visible: faster repeat plays; fewer transcode traps; less waiting.
- Why existing cannot: `tryReuseHealthyPublication` only short-circuits
  exact healthy published repeats; near-repeats still pay full discovery.
- Smallest change: write path + selection preference; no schema sprawl.
- Preserves: all (selection policy layer).
- Cost: low.
- Killer demo: re-request after market change selects previously accepted
  TF with stated reason; a known-bad TF is skipped with reason.
- Kill argument: outcomes identical with memory on/off; hit rate below
  noise floor.

### 3. Consumer-Neutral Direct Execution (projection-free play for capable clients)
- Observed tension: byte authority is already consumer-neutral, but every
  item must still be published/scanned/Part-created before any client can
  play; `/bytes/:tfId` exists but has no client-facing readiness contract.
- New capability: capable clients (mpv, Infuse, Jellyfin modes) play
  directly from HashSucker byte authority + readiness, while Plex remains
  projection for library/watch state.
- User-visible: seconds instead of minutes for first play on capable
  clients; no scanner for ephemeral items.
- Why existing cannot: publication is assumed prerequisite for all play;
  `/bytes` lacks auth/readiness/identity contract and client guidance.
- Smallest change: formalize `/bytes` + readiness + TF identity as a
  client-facing execution contract; no UI.
- Preserves: Plex ecosystem (Plex still uses VFS/publication).
- Cost: medium.
- Killer demo: `mpv http://hashsucker/bytes/<tfId>` plays with seek and
  survives route failover, while Plex library unchanged.
- Kill argument: security/auth burden; no client benefits; duplicates
  consumer UX.

### 4. Representation Healing (single-route/TF reacquisition)
- Observed tension: TF-level failure stops playback and requires manual
  request or minutes of scheduler retry; Rust only fails over within the
  same TF; repair transactions exist but are not autonomous.
- New capability: autonomous reacquisition for an exact Binding when no
  healthy route, preserving identity where possible.
- User-visible: unavailable item recovers without manual request.
- Why existing cannot: no acquisition path is wired to binding repair;
  scheduler can republish but is minutes-scale and not in-session.
- Smallest change: connect failover exhaustion to bounded acquisition +
  republish; reuse existing repair planner (shadow mode).
- Preserves: identity and Plex projection.
- Cost: medium-high.
- Killer demo: remove all routes for a TF; HashSucker acquires alternate
  placement and republishes same media without rediscovery.
- Kill argument: no observed single-route loss in the wild; quota burn.

### 5. Projection Reconstruction (consumer rebuild levels 2-3)
- Observed tension: publication is a projection over truth; consumer loss
  requires re-curation; only single VFS row rebuild is proven.
- New capability: rebuild consumer projections from truth with
  consumer-visible confirmation and byte-verified playback.
- User-visible: after item deletion or DB loss, HashSucker recreates
  entries without re-discovery.
- Why existing cannot: republish route is single-item and fail-closed; no
  consumer-level confirmation or byte proof yet.
- Smallest change: bounded rebuild demo over existing reuse predicate.
- Preserves: consumer contracts (filesystem expectations stay in adapters).
- Cost: medium.
- Killer demo: delete a Plex item; HashSucker republishes and Plex plays it
  byte-verified.
- Kill argument: rebuilds never fire; Plex contracts block fidelity.

### 6. Durable Route-Health Knowledge
- Observed tension: route health is runtime-only (budgets, cooldowns,
  byte-health); decisions cannot use history older than process lifetime;
  throttling self-harm and dead-link picks recur.
- New capability: per-route last-ok/fail/class history that informs
  selection and healing.
- User-visible: fewer dead-link picks; smarter failover.
- Why existing cannot: no durable per-route history; budgets reset on
  restart.
- Smallest change: update-on-change persistence; delete if unread.
- Preserves: all.
- Cost: low (if consumed).
- Killer demo: after process restart, a previously dead route is avoided
  with stated reason; a recovered route is retried.
- Kill argument: unread after N slices; runtime state suffices.

### 7. Intent-Driven Cache Intelligence
- Observed tension: cache policy is driven by byte requests; Rust prefetch
  already does sequential detection; player/season intent could improve
  next-episode and seek warming.
- New capability: cache planning from media intent with measured startup
  delta.
- User-visible: faster next-episode start; fewer stalls on likely seeks.
- Why existing cannot: prefetch arms on 3 sequential reads; no intent
  input; next-episode warming is not implemented.
- Smallest change: feed future-intent/position hints into prefetch planner;
  keep conservative contention policy.
- Preserves: all.
- Cost: medium.
- Killer demo: next episode starts with cache hit on first byte after
  previous episode completes.
- Kill argument: Range signal already sufficient; no measured delta.

### 8. Typed Reason Propagation to Consumers
- Observed tension: HashSucker has precise serviceability reasons that
  never reach Plex/Jellyfin; users see generic "media unavailable".
- New capability: propagate actionable failure state through consumer-
  compatible channels (metadata, retry hints, operator surface) without
  new UI.
- User-visible: clearer failure and recovery ETA.
- Why existing cannot: consumers own error UX; no propagation channel
  beyond generic unavailability.
- Smallest change: enrich publication/exposure state with reason + retry;
  expose via diagnostics and maybe consumer metadata.
- Preserves: consumer UX ownership.
- Cost: low-medium.
- Killer demo: a blocked item shows provider/route reason and expected
  recovery time in operator surface and consumer metadata.
- Kill argument: consumer constraints make propagation impossible or low
  value.

### 9. Compatibility-Knowledge Memory (per client class)
- Observed tension: one success is not universal; Shield vs tablet diverge;
  no per-client outcome memory; TRaSH profiles are static.
- New capability: accepted/known-bad scoped by client class; selection
  adapts per client.
- User-visible: fewer transcode traps on specific devices.
- Why existing cannot: accepted memory (future) is global; no client-class
  context recorded today.
- Smallest change: record client context from day one; exploit on observed
  divergence.
- Preserves: all.
- Cost: low-medium.
- Killer demo: a TF that fails on one client class is avoided there but
  still used on another, with reason.
- Kill argument: outcomes do not diverge by client in practice.

### 10. Projection Minimization / Hybrid Consumer Mode
- Observed tension: publication tax (scan, Part, notify) applies to every
  item; ephemeral items may not need full library projection; scanner
  churn and Part creation are recurring costs.
- New capability: hybrid mode where ephemeral items are playable on demand
  from byte authority while durable items keep full projection.
- User-visible: less scan churn; faster first play for watch-once items.
- Why existing cannot: publication is assumed prerequisite for all play;
  retirement/keep-remove policy is not yet expressive.
- Smallest change: distinguish durable vs ephemeral publication intent
  (already partially in library intent) and skip full projection for
  ephemeral where client supports direct play.
- Preserves: Plex value for durable items.
- Cost: medium-high.
- Killer demo: a watch-once request plays via direct bytes without a Plex
  scan/Part, then retires automatically.
- Kill argument: loses library/watch-state value; consumer constraints.

## 25. Candidate ranking matrix (1-5, higher better unless noted)

| Candidate | User value | Frequency | Leverage | Uniqueness | Reuse | Risk (lower better) | Maint (lower better) | Compat | Reversibility | Prototype safety | Total (rough) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Readiness Orchestration | 4 | 4 | 5 | 4 | 4 | 3 | 3 | 5 | 4 | 4 | 38 |
| Accepted Memory | 4 | 5 | 4 | 5 | 5 | 2 | 2 | 5 | 5 | 5 | 42 |
| Consumer-Neutral Direct Execution | 4 | 3 | 4 | 4 | 4 | 3 | 3 | 4 | 4 | 3 | 36 |
| Representation Healing | 3 | 2 | 4 | 5 | 3 | 4 | 4 | 4 | 3 | 2 | 30 |
| Projection Reconstruction | 3 | 2 | 4 | 5 | 4 | 3 | 3 | 4 | 4 | 3 | 34 |
| Route-Health Knowledge | 3 | 3 | 3 | 3 | 4 | 2 | 2 | 5 | 5 | 5 | 35 |
| Intent-Driven Cache | 3 | 3 | 3 | 3 | 4 | 3 | 3 | 5 | 4 | 4 | 34 |
| Typed Reason Propagation | 2 | 3 | 2 | 2 | 4 | 2 | 2 | 3 | 5 | 5 | 30 |
| Compatibility Memory | 3 | 3 | 3 | 3 | 4 | 2 | 3 | 4 | 4 | 4 | 34 |
| Projection Minimization | 3 | 3 | 4 | 4 | 3 | 4 | 4 | 3 | 3 | 2 | 29 |

Ranking (rough, evidence-gated): Accepted Memory first (cheap, frequent,
measurable), then Readiness Orchestration (high leverage, scattered
ownership), then Route-Health Knowledge (cheap option), then Projection
Reconstruction (rare × catastrophic), then Consumer-Neutral Direct
Execution (challenges publication tax), then the rest.

## 26. Surprising candidates (not player interception)

- Readiness Orchestration: not a player feature, but addresses the most
  common visible failure (playable-but-not-serviceable) and is already
  partially built in scattered form.
- Accepted Representation Memory: a data/memory feature, not execution;
  attacks repeated ranking labor and transcode traps.
- Projection Reconstruction: a recovery feature; attacks re-curation, not
  playback.
- Consumer-Neutral Direct Execution: challenges the assumption that all
  play must be published, without replacing Plex.

At least one challenges a current architectural assumption:
- Projection Minimization / Consumer-Neutral Direct Execution challenge
  the assumption that publication is a mandatory product step rather than
  a compatibility projection.

At least one unexpected before recon:
- Readiness Orchestration emerged from the serviceability split and the
  repeated "consumer-visible vs byte-serviceable" tension, not from any
  playback thesis.

## 27. Revised view of playback ownership

Playback ownership should remain split and asymmetric:

- Plex/Jellyfin own: session, UI, watch state, accounts, remote control,
  casting, subtitles/audio track selection UI, metadata.
- HashSucker owns: exact byte authority, TF identity, representation
  selection, route recovery, serviceability, readiness, publication truth,
  lifecycle, evidence.

The earlier PARK of TF-level representation switching as a player-hook
moonshot survives as a park decision, but the reasoning that "TF-level
switching is the only real gap" does not. The real gaps are more frequent
and more tractable at the fulfillment/readiness/memory layer. Player
interception remains high-cost, rare-benefit, and safety-uncertain.

## 28. Does the previous PARK verdict survive?

Partially.

- The PARK of building a player hook: survives. No native hooks, no
  standalone player, no direct-play-before-publication without PMS
  cooperation.
- The claim that "TF-level representation switching is the only real gap":
  does NOT survive. Recon shows multiple real gaps with higher frequency
  and lower risk: readiness conflation, repeated ranking labor, known-bad
  retry, TF-level recovery delay, consumer projection reconstruction,
  route-health ephemerality.
- The conclusion that simpler alternatives (faster autonomous retry +
  pre-warming) address most pain: survives and is strengthened. Readiness
  orchestration and memory are those simpler alternatives.

What changed: the previous verdict reasoned from a playback-centric model
and treated Rust's same-TF failover as "recovery solved." Recon shows
recovery is solved only within a TF and within a process lifetime; the
gaps are in readiness ownership, memory, and projection reconstruction.

## 29. Top 3 ideas worth further interrogation

1. Readiness Orchestration — unify the scattered readiness computation
   into one owned state with autonomous convergence and honest surfacing.
2. Accepted Representation Memory (+ known-bad) — cheap, frequent,
   measurable; directly attacks repeated ranking and transcode traps.
3. Consumer-Neutral Direct Execution / Projection Minimization — challenges
   the publication-tax assumption; uses existing `/bytes` authority; may
   materially reduce cold-start and scanner burden for capable clients.

## 30. Immediate (non-moonshot) note

Cached byte routing is not a current blocker: `f35d906` flipped the compose
default to `cached` after the recorded gates, while the code-level env
fallback remains `provider`. The earlier fill/join race note in `PLANS.md`
predates that commit and was reconciled in this round. The escape hatch
remains `STREAM_BYTE_ROUTE=provider`.

# Authority Pivot — HashSucker (2026-10)

Status: synthesis attack / moonshot reframe. Not an implementation plan.
This document deliberately discards the previous candidate ranking and
rebuilds from the authority progression.

## 0. Reconciliation of stale current-state claims

Before any synthesis, three factual errors in the previous recon are
corrected:

1. Cached byte routing: `f35d906` flipped the compose default to
   `STREAM_BYTE_ROUTE:-cached` after the recorded gates. `PLANS.md` was
   not updated after that commit; the "NOT FLIPPED / fill-join race" line
   was stale. This round reconciles it. The code-level env fallback remains
   `provider` when unset, which is the safe default for direct runs.
2. `/stream` is dual-mode, not a pure provider redirect: in cached mode it
   can 307 to the authoritative `/bytes/:tfId` data-plane path; in provider
   mode it revalidates/selects a provider. Both modes coexist.
3. The previous recon mixed epochs by describing `/stream` and cached
   routing from the pre-cutover architecture. The reconciliation above is
   the floor for trusting the rest of this document.

Inspected deployed commit for this round: `main` at `c1075c5`-era tree plus
local `f35d906` (cached default). Production media-search container is on
the v0.4.0-era image; compose default is cached. No claim below depends on
the stale "blocked cutover" premise.

## 1. Why the previous synthesis failed

The previous document did archaeology, then ranked incremental work by
cheapness. That is backlog scheduling, not pivot discovery. Its #1
candidate ("Accepted Representation Memory") scored highest because it was
cheap, frequent, low-risk, and reversible. Those are sprint criteria, not
category criteria. It also proposed "Readiness Orchestration" as a single
owned Ready state, which risks recombining dimensions (consumer-visible,
byte-serviceable, published, bound, cached, provider-ready) that were
deliberately separated because they fail independently. The AT&T/TorBox
incident explicitly retained publication of blocked media rather than
emptying the library; "published but temporarily unserviceable" is a
legitimate state, not a bug.

Its user-journey timings were assertions, not measurements. Its killer
demos were operator-visible hygiene ("dead route avoided after restart",
"known-bad candidate skipped"). None would make a human say the product
became something else.

The useful buried observation was: fulfillment truth and consumer projection
are now substantially separable. This document starts there.

## 2. The real progression: external inference → internal durable truth

HashSucker's history is not feature accumulation. It is a repeated
conversion of questions once asked of external systems into durable
internal truth:

- Which release? → Binding (was: ask the provider/search result each time)
- Which exact bytes? → TorrentFile (was: file index / basename / ordinal)
- Where can they come from? → ProviderPlacement + DeliveryCapability
  (was: CDN URL / provider state)
- Can they actually be served? → serviceability + byte evidence (was: try
  and see)
- Should this keep converging? → intent + scheduler ownership (was: manual
  re-request / Arr polling)
- What is the exact published projection? → VFS entry + Binding (was:
  filesystem scan / filename)

Each step moved an external dependency from "question asked at use time" to
"durable truth owned internally," while still exploiting the external
system for presentation or execution. That is the product's actual thesis.

The pivot question is therefore not "what feature is missing?" It is:

> What is the next external dependency HashSucker still asks permission from,
> but could instead reduce to a projection over its own truth?

## 3. Remaining external authorities (the pivot surface)

For each, the question is: what becomes possible if HashSucker no longer
depends on that system for truth, while still exploiting it for
presentation/ecosystem value?

- Consumer publication (Plex/Jellyfin library presence, scan, Part).
- Playback session (position, play state, next-item control).
- Watch state / resume / history.
- Metadata and identity resolution (Cinemeta/TMDB/TVDB).
- Client compatibility (device-specific success).
- User intent ingress (Seerr/Radarr/Sonarr, watchlists).
- Acquisition (provider addMagnet, importer, disk).
- Presentation (UI, clients, casting, remote control).
- Storage locality (provider cache, disk, permanent promotion).
- Network egress (ISP/provider filtering).
- Time/availability (provider cache state, air dates).

## 4. Radically different reframes (not backlog)

### R1. Plex/Jellyfin as Index, HashSucker as Origin
Assumption invalidated: consumer publication is a mandatory product step.
HashSucker already has Binding → TF → bytes. Instead of treating Plex/
Jellyfin library presence as the definition of "available," HashSucker
exposes a consumer-agnostic playable origin: identity + bytes + readiness.
Plex/Jellyfin become optional indexers over it, catching up asynchronously.
Plex keeps its UI/accounts/watch-state value; it stops being the source of
truth for playability.

- Killer demo (60s): request an item; ~10s later play it via mpv or a
  Jellyfin-direct path while the Plex library is still empty; later Plex
  scans and indexes it with no re-discovery and no second provider call.
- Unique to HashSucker: exact TF identity + serviceability + autonomous
  convergence already exist; no other tool can make "playable before
  indexed" honest.
- Simplest 80% alternative: keep `/stream` direct play on demand. It
  loses because it still depends on consumer publication for identity and
  watch state and does not make playability independent of indexing.
- Cost: medium (auth/readiness contract + client guidance).

### R2. Execution Policy over a Ranked Representation Set
Assumption invalidated: Binding pins one authoritative TF.
Instead of durably selecting one TF, HashSucker maintains a ranked,
serviceability-aware representation set and makes execution-time choices
using memory, route health, and byte evidence. Identity stays exact; the
execution decision becomes adaptive. This is Stremio-like breadth but with
exact identity, serviceability, and memory, and without per-play
re-selection labor.

- Killer demo: a provider route dies mid-play; playback continues on an
  alternate representation at the same timestamp with no manual request and
  no Plex session restart; the Binding is updated, not replaced by a new
  request.
- Unique to HashSucker: exact TF identity + serviceability + route
  diversity + accepted memory; competitors re-pick blindly.
- Simplest 80% alternative: current Binding + scheduler republish. It
  loses because recovery takes minutes and requires a new play session.
- Cost: high (player source control or clean reopen + position restore);
  safety (duration/cut/subtitle/audio mismatch) must be solved or scoped.

### R3. Availability as a Guaranteed Property (Autonomous Survival)
Assumption invalidated: provider cache state is an external fact HashSucker
observes; acquisition is storm-only.
HashSucker treats availability as its own responsibility: every wanted
item must have at least one healthy route, and HashSucker acquires/migrates
automatically when routes die. Providers become interchangeable execution
backends, not sources of truth for availability.

- Killer demo: disable a provider route mid-library; affected items
  reacquire elsewhere automatically; playback continues; no "media
  unavailable"; operator sees a migration event, not a failure.
- Unique to HashSucker: exact TF identity + provider placement + repair
  transactions + scheduler; no incumbent guarantees survival across
  provider loss.
- Simplest 80% alternative: manual re-request after failure. It loses
  because it requires human action and minutes, and does not preserve
  identity.
- Cost: medium-high (acquisition policy change; conflicts with
  cache-only provider policy and quota budgets).

### R4. Household Demand Graph (Intent as Authority)
Assumption invalidated: user intent is external ingress (Seerr/Arrs).
HashSucker owns the household's demand graph—what is wanted, by whom,
when—and drives fulfillment/retirement autonomously. Seerr/Arrs/Plex watch
state become sensors, not authorities. Prediction is not the product;
durable intent ownership is.

- Killer demo: a monitored series airs; episodes become playable before
  anyone requests them; after viewing, temporary items retire automatically;
  zero Seerr/Arr interaction in the loop.
- Unique to HashSucker: future intents + scheduler + publication +
  retirement already exist; competitors require explicit requests.
- Simplest 80% alternative: Seerr deferred requests + anticipation (current).
  It loses because it still requires explicit request and has no proactive
  lifecycle or retirement.
- Cost: medium; requires measured demand evidence (currently absent).

### R5. Portable Playable Truth (Consumer-Independent Media Life)
Assumption invalidated: a household's media life lives inside one consumer.
HashSucker's fulfillment truth becomes the portable artifact: a household
can move between Plex, Jellyfin, mpv, or a new client without re-curation,
because identity, representation, and availability are not stored in the
consumer. Consumers become renderers.

- Killer demo: wipe a Plex library; point Jellyfin at HashSucker truth;
  library and playability restore without re-discovery; (watch state is
  honestly reported as not restored unless migration evidence exists).
- Unique to HashSucker: exact-object identity + bindings + placements +
  serviceability; no incumbent stores truth outside the consumer.
- Simplest 80% alternative: backups. They lose on provider loss,
  corruption, or cross-consumer migration.
- Cost: high (contract stability, cross-consumer proof).

### R6. Readiness as a Proof Vector (not a state)
This is a correction, not a pivot. "Ready" must not be collapsed into one
state. The useful abstraction is a proof vector: identity proven, bytes
proven, route proven, consumer projection proven, with each dimension
failing independently. This is already implicit in the serviceability split.
It should be exploited, not recombined.

## 5. Discontinuity-first ranking (cost deferred)

Rank by (magnitude of changed user behavior, uniqueness to HashSucker,
leverage from existing primitives, whether it changes product category).
Cost is introduced only after.

| Reframe | Behavior change | Uniqueness | Leverage | Category change | Cost |
|---|---:|---:|---:|---:|---|
| R1 Origin/Index | High | High | High | High | Medium |
| R3 Autonomous Survival | High | High | Medium | High | Medium-High |
| R2 Adaptive Execution | High | High | Medium | High | High |
| R5 Portable Truth | Medium-High | High | Medium | High | High |
| R4 Demand Graph | Medium | Medium | High | Medium | Medium |
| R6 Proof Vector | Low-Medium | Medium | High | Low | Low |

Discontinuity leaders: R1, R3, R2. R4/R5 are category bets with weaker
near-term demos. R6 is infrastructure, not a pivot.

## 6. Top 3 in required format

### Top 1 — R1: Plex/Jellyfin as Index, HashSucker as Origin

Before: a request is not "available" until a consumer scans, creates a
Part, and indexes it; playability is defined by consumer projection; cold
start is minutes; provider bytes are already there.

After: playability is defined by HashSucker truth (identity + bytes +
readiness); capable clients play before any consumer indexes; consumers
catch up as projections. Plex remains the best UI and watch-state owner,
but stops being the gate for first play.

Why this is not just a feature: the authority boundary moves from "consumer
library presence" to "HashSucker playable origin." That changes what
HashSucker is: not a feeder into media servers, but the media origin they
index.

Killer demo: request an item; within seconds play it in mpv or
Jellyfin-direct while Plex library is empty; later Plex indexes it with no
re-discovery and no second provider call.

Simplest competing implementation: keep on-demand `/stream` direct play.
Why it loses: it still treats consumer publication as the identity/playability
gate and does not make first play independent of indexing.

### Top 2 — R3: Availability as a Guaranteed Property

Before: provider cache state is an external fact; when a route dies the
item becomes unavailable until a human re-requests or the scheduler
eventually republishes; 97% TorBox-only bindings were unserviceable during
the AT&T incident.

After: HashSucker guarantees at least one healthy route for every wanted
item and migrates automatically; provider loss is an internal event, not a
user-visible failure.

Why this is not just a feature: availability moves from provider truth to
HashSucker truth. That is the same kind of authority move that made
Binding and TorrentFile durable.

Killer demo: disable a provider route; affected items reacquire elsewhere
automatically; playback continues; operator sees a migration, not an outage.

Simplest competing implementation: manual re-request after failure. Why it
loses: requires human action and minutes; does not preserve identity or
continuity.

### Top 3 — R2: Execution Policy over a Ranked Representation Set

Before: one authoritative TF is pinned by Binding; Rust fails over only
within the same TF; TF-level failure stops playback and requires a new
request or scheduler-driven republish.

After: HashSucker maintains a ranked, serviceability-aware representation
set and makes execution-time choices with memory; TF-level failure can be
handled by policy rather than by a new request, with position preserved
where safe.

Why this is not just a feature: representation choice moves from a durable
single selection to an adaptive execution policy over exact objects. That
changes the product from "chosen release" to "continuously best playable
representation."

Killer demo: a route dies mid-play; playback continues on an alternate
representation at the same timestamp; no manual request; Plex session
continues or cleanly reopens.

Simplest competing implementation: current Binding + scheduler republish.
Why it loses: minutes of downtime and a new play session; does not handle
in-session failure.

## 7. Attack on the "memory/readiness are the next layers" hypothesis

Treat it as a hypothesis, not a conclusion.

- Memory (accepted TF, known-bad) is valuable but is a selection-quality
  improvement, not a category change. It makes repeats cheaper; it does not
  change what HashSucker is. It should be built if measured, but it is not
  the pivot.
- Readiness as a single state is likely a category error. The valuable
  abstraction is a proof vector, not a new state machine. "Published but
  temporarily unserviceable" is legitimate and was deliberately retained
  during the AT&T incident.
- Route-health persistence is only valuable if it becomes control state;
  as evidence it is a byproduct. Persisting "route was bad" risks stale
  negative authority unless expiration and re-proof are designed first.
- Reconstruction is operational resilience, not product leverage; a true
  Plex DB-loss recovery also needs watch state, metadata choices, and users,
  which HashSucker explicitly does not own.

The pivot is more likely to be an authority move (origin, availability,
adaptive execution) than a memory/readiness cleanup.

## 8. What would falsify this pivot

- If capable clients cannot play before consumer indexing in practice
  (auth, codec, subtitle constraints), R1 collapses to "bypass Plex," which
  is not a pivot.
- If autonomous acquisition burns quota or violates provider policy, R3
  collapses to "manual re-request is cheaper."
- If adaptive representation switching cannot preserve position safely, R2
  collapses to "scheduler republish," which already exists.
- If none of these produce a visible, undeniable demo, the honest answer is
  that HashSucker's category is already "reliable fulfillment" and the
  moonshot does not exist yet.

This document proposes directions, not implementations. No seam, no code,
no commit of product changes beyond this document.

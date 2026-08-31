# HashSucker

Self-hosted service that turns a media intent — a movie, or one specific episode — into a ranked
  
torrent release on a debrid provider, then hands Plex or Jellyfin a URL that stays valid after the
  
provider, the mount, or the file changes underneath it.

Four jobs, deliberately kept apart:

- **Discovery and ranking.** Find plausible releases and score them on evidence, not on which
    
  source produced them.
- **Debrid fulfillment.** Determine whether a provider actually has the bytes cached, and place the
    
  torrent when it does not.
- **Playback handoff.** Give the player a stable URL per title, then re-validate the provider at the
    
  moment of playback rather than at the moment of request.
- **Control plane.** Record what was placed at a provider, exposed on a filesystem, and bound to a
    
  library path — as three separate facts, because they fail in three separate ways.

It is not a scraper, not a download manager, and not a media frontend. Library metadata, artwork,
  
subtitles, and *arr automation belong to other tools.

## What problem it solves

Given "Dune (2021)" or "The Sopranos S02E06", the work that actually matters is:

1. Find candidate releases from a local corpus and from live indexers.
2. Apply hard identity constraints — a wrong episode is not a worse candidate, it is not a
     
   candidate.
3. Score the survivors on evidence: quality, resolution, identity confidence, provider
     
   availability. Missing data is neutral, never a penalty.
4. Check whether the provider has the release cached.
5. Persist the ranked result set, not just the winner.
6. Publish a URL the player can hold indefinitely.
7. At playback time, re-check availability. If the winner has gone cold, walk down the persisted
     
   alternates instead of failing the request.

The failure mode this is built around is not "discovery returned nothing". It is "this worked last
  
week": a provider evicted the torrent, a mount moved, a CDN URL expired. HashSucker does not
  
prevent those. It tries to turn them into a redirect decision instead of a broken library entry.

## Current flow

```text
Seerr webhook / Plex Watchlist script / API intent
  -> media identity resolution (IMDb is canonical; TMDB is translated at the boundary)
  -> corpus lookup + live discovery (DMM hashlists, Torrentio, Comet, Torznab)
  -> merge on exact releaseKey
  -> episode eligibility gate (TV, when season+episode are explicit)
  -> scored ranking + confidence tier
  -> provider availability observation
  -> persist request, per-rank results, and the selected handoff
  -> publish .strm containing /stream/{type}/{id}

Plex / Jellyfin  ->  /stream/{type}/{id}
  -> revalidate availability at playback time
  -> Real-Debrid first, TorBox fallback
  -> 307 redirect to the provider
  -> on "do not redirect": next persisted alternate; no re-discovery, no re-ranking
```

A second delivery path exists beside the redirect: `/media/{infoHash}/{fileIndex}` proxies bytes
  
directly from a mounted filesystem, with `Range` support. It serves direct clients and the WebDAV
  
internals. The two paths do not overlap and neither falls through to the other.

## What is worth stealing

Design decisions that hold up independent of the rest of the project:

- **Two identity layers, never collapsed.** Library identity is `<type>:<mediaId>[:<editionKey>]`;
    
  release identity is `(infoHash, fileIndex)`. A provider resource ID, CDN URL, filesystem path, or
    
  mount path is never identity — each is a replaceable observation. Renaming a file, re-adding a
    
  torrent, or moving a mount must not change identity.
- **Null file index is not zero.** A torrent-level release renders as `torrent` in the release key
    
  and is stored with file index `-1`. Collapsing the two into `0` silently merges distinct
    
  evidence.
- **Per-file mapping as data, not assumption.** `fileIndex` and the provider's file id are different
    
  numbers from different systems. An explicit mapping row is the only thing that relates them, and
    
  the code refuses to equate them.
- **Hard eligibility gating before scoring.** With explicit episode intent, a release whose filename
    
  does not structurally cover the requested season and episode is ineligible, not merely
    
  low-ranked. Wrong season, wrong episode, out-of-range, malformed range, and unresolvable coverage
    
  are all rejected before the score runs.
- **Persisted ranked alternates.** Every request writes one result row per rank, not only the
    
  winner, so fallback has somewhere to go.
- **Fallback without re-discovery or re-ranking.** When the primary goes cold at playback time, the
    
  resolver filters already-persisted candidates by eligibility and takes the next one in the
    
  original persisted order. No new provider search, no score recomputation.
- **Playback-time revalidation with typed outcomes.** A fresh observation costs zero provider calls.
    
  A stale or missing one costs exactly one bounded, timeout-capped check. The result maps to `307`,
    
  `409 PROVIDER_NOT_CACHED`, or `503 PROVIDER_CHECK_FAILED`. A failed check persists `unknown`,
    
  never `uncached` — uncertainty and absence are different facts.
- **Stable presentation URLs.** A `.strm` holds one line: `{RESOLVER_BASE_URL}/stream/{type}/{id}`.
    
  It names the intent rather than the resource, so it survives provider changes, re-binding, and
    
  mount moves.
- **Append-only observations with `expiresAt` freshness.** Observations are never deleted and never
    
  overwritten in place; one older than the stored value is rejected. Freshness is a pure function of
    
  `expiresAt` against an injected clock: `fresh | stale | unbounded | missing`. Stale degrades
    
  effective state to `unknown`; missing triggers re-observation, not repair.
- **Seerr season-to-episode fan-out.** A series request is expanded through the Seerr TV API into
    
  per-episode intents. Each child carries its own source id, is independently retryable, and is
    
  skipped on webhook replay if it already completed.

## What is actually proven

**Proven on this deployment, as canaries.** DMM-backed corpus discovery over a locally ingested
  
hashlist corpus; media-ID-driven combined search and ranking; TorBox `requestdl` `307` delivery;
  
playback-time provider revalidation; fallback to the next persisted candidate when the selected
  
release goes cold; Plex and Jellyfin playback with seeking against provider-backed media; Seerr
  
movie ingress; `.strm` publishing and idempotent re-publish.

These are canaries on one operator's stack — one provider account, one set of mounts, one pair of
  
clients. They establish that these paths work here. They are not a portability guarantee.

**Two fallback mechanisms, which are not the same thing:**

- **Provider fallback** — before abandoning a selected release, the resolver tries a different
    
  provider for that same release: Real-Debrid first, then TorBox.
- **Persisted candidate fallback** — when the selected release cannot be served at all, the
    
  resolver walks to the next already-persisted ranked candidate, filtered by eligibility and in the
    
  original persisted order. No re-discovery, no re-ranking.

**Present but on no live path.** Reconciliation planning runs in shadow mode only. Repair
  
execution, the acquisition library, and the stream-resolver stub have no runtime callers.
  
Reconciliation observes drift; it does not correct it.

**Not yet proven.**

- Bare title search. `GET /api/search?q=` without `type` and `mediaId` resolves through Cinemeta's
    
  catalog endpoint, which returns static popular results whatever the query. Discovery driven by a
    
  media ID — the `?type=&mediaId=` path — is the exercised one.
- Seerr TV. Season-to-episode fan-out is implemented and focus-tested, but the first Seerr
    
  production canary stopped at season parsing: `/api/v1/tv/{tmdbId}` carries no root-level
    
  `imdbId`, so TV identity has to come from the external-IDs endpoint. Until that lands, series
    
  fan-out is not proven end to end. Movie ingress is.

## How it fits together

- **`media-search`** — Node service holding everything except acquisition: HTTP API, both SQLite
    
  databases, discovery, ranking, the resolver, WebDAV, `.strm` publishing, and a React UI. Bound to
    
  loopback by default.
- **Two SQLite databases** — one for the discovery corpus and request results, one for the control
    
  plane (placements, exposures, bindings, observations). No external database, no message broker.
- **TorBox and Real-Debrid** — debrid providers. Real-Debrid is tried first for delivery; TorBox is
    
  the fallback and the placement target for physical acquisition.
- **`torbox-importer`** — separate container that drains a filesystem queue, places torrents with
    
  TorBox, and hands the download to Radarr or Sonarr for import. The queue directory, not the
    
  database, is the authority for acquisition ownership.
- **`edge`** — Caddy, the only public listener. Transport only: it forwards `Range` untouched and
    
  does not buffer media.
- **Optional ingress** — Seerr pushes requests in by webhook behind a shared bearer token. Plex
    
  Watchlist is a script you run yourself: movies only, no scheduler, no removals.
- **Corpus and discovery sources** — DMM hashlists for the local corpus; Torrentio, Comet, and
    
  Torznab for live discovery, which run only when the corpus returns nothing for the requested
    
  media. Corpus ingestion is operator-triggered and not resumable: there is no scheduler, and each
    
  run walks fragments from the beginning.

## Repository map

- `media-search/` — the service: API, discovery, ranking, resolver, control plane, WebDAV, UI.
- `torbox-importer/` — shell-based acquisition worker; places with TorBox, hands off to
    
  Radarr/Sonarr.
- `edge/` — Caddyfile for the public listener.
- `scripts/` — smoke test.
- [`docs/architecture.md`](docs/architecture.md) — services, identity model, data model, HTTP
    
  surface, invariants.
- [`docs/discovery-ranking.md`](docs/discovery-ranking.md) — sources, score model, confidence
    
  tiers, request pipeline.
- [`docs/playback-delivery.md`](docs/playback-delivery.md) — resolver, `.strm`, redirect vs proxy,
    
  mounts, WebDAV, physical import.
- [`docs/operations.md`](docs/operations.md) — deployment, environment variables, health checks,
    
  known risks.

## Running it

```sh
cp .env.example .env      # every secret is required; see docs/operations.md
docker compose up -d --build
scripts/smoke-test.sh     # eight read-only wiring probes
```

Node 24+ for local development. Compose is not required to run tests.

## Status and caveats

This is an actively developed personal system, not a turnkey product.

- There is no application authentication on the API. Keep it off the public interface.
- It is built for one operator's host. Paths, defaults, and queue permissions reflect that. There
    
  is no promise of plug-and-play portability.
- Some control-plane machinery is observational only: reconciliation runs in shadow mode and nothing
    
  executes a repair. A degraded binding is recorded, not fixed.
- Configuration is inconsistent in places — mount and resolver URL defaults differ between
    
  services. These are documented rather than fixed.
- Interfaces and environment variable names may move.

# HashSucker

Media release discovery, indexing, ranking, and playback handoff.

HashSucker answers three questions and keeps the answers apart:

1. **Which release is this?** — exact identity from `(infoHash, fileIndex)`, never from a
   provider resource ID, a CDN URL, or a filesystem path.
2. **Is it worth asking for?** — a deterministic six-component score over evidence, not over
   source origin.
3. **Where should the player look?** — a stable URL that never needs rewriting when the
   provider, binding, or mount changes underneath it.

The separation that matters most: **media metadata** (what a title represents), **release
candidates** (individual files or torrents), and **availability observations** (what a provider
said, and when). Conflating these is the failure mode the whole design is arranged against.

## Topology at a glance

Three containers, one public port:

| Service | Role | Port |
|---|---|---|
| `media-search` | API, corpus, ranking, control plane, WebDAV, resolver, UI | `127.0.0.1:3000` |
| `torbox-importer` | Physical acquisition worker; drains the filesystem queue | none |
| `edge` | Caddy reverse proxy; the only public listener | `0.0.0.0:8080` |

```sh
cp .env.example .env    # fill in the required keys
docker compose up -d --build
scripts/smoke-test.sh   # eight first-boot probes
```

Requires Node 24+ for local development; Compose is not required to run tests.

## Documentation

| Document | Contents |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | Components, identity model, data model, HTTP surface, invariants |
| [`docs/discovery-ranking.md`](docs/discovery-ranking.md) | Sources, canonicalization, score model, confidence tiers, request pipeline |
| [`docs/playback-delivery.md`](docs/playback-delivery.md) | Resolver, `.strm`, redirect vs proxy, mounts, WebDAV, physical import |
| [`docs/operations.md`](docs/operations.md) | Deployment, environment reference, health, operator routes, open risks |

Start with `architecture.md` for the model, then the two pipeline docs, then `operations.md`
when you are actually running it.

## Reading the code

`media-search/src/server/app.js` is the whole HTTP surface in one file — read it first. The two
files that carry the most weight are `media-search/src/lib/discovery/ranking.js` (scoring and
identity tiers) and `media-search/src/api/media-request.js` (`searchByMedia`, the request
pipeline every ingress converges on).

## Status

Implemented: canonical candidate pipeline, multi-source ingestion, release parsing, identity
classification, tier-aware ranking, Seerr and Plex Watchlist ingress, multi-ID persistence
(IMDb/TMDB/TVDB), durable playback handoff, redirect resolver with availability revalidation and
alternate fallback, WebDAV virtual filesystem, `.strm` publishing, control-plane store and
read-only reconciliation.

Not implemented: automatic repair execution (`repair-planner.js` and `repair-executor.js` have no
runtime callers), provider-driven acquisition decisions (`src/lib/acquisition/**` has no runtime
callers outside tests), and application authentication on mutation routes. See
[`docs/operations.md`](docs/operations.md#7-known-operational-risks) for the resulting operational
risks.

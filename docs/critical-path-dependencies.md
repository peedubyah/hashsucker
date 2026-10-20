# Critical-path dependencies

What the live HashSucker request → playback path depends on, and what each
dependency is allowed to cost.

Scope: `POST /api/media-request` → discovery → identity → ranking →
provider evidence → Binding → VFS publication → WebDAV → Plex ingest →
MediaPart → bytes, plus the background paths (re-request of healthy media,
requested-season fulfillment, provider reconciliation, publication replay,
playback recovery).

This document records **established** facts (code + production measurement,
2026-10-19). It is not a design proposal.

## Classification

| class | meaning |
|---|---|
| **A** | authority-critical — correctness cannot proceed without the fact |
| **B** | critical only when local evidence is insufficient |
| **C** | reconciliation — refreshes durable state, need not block a request |
| **D** | enrichment — should fail soft |
| **E** | telemetry / consumer projection — must never block |

## Foreground matrix

| dependency | caller | class | timeout | abort | retry / limiter | fallback | durable substitute | failure owner |
|---|---|---|---|---|---|---|---|---|
| Cinemeta `/meta/*` | request identity, VFS presentation, `.strm` title | D (B for the title cross-check) | 3 s | yes | none; 30 s per-(transport,path) failure memory | request canonical identity → release attributes → release filename | corpus `release_attributes`, handoff canonical identity | caller (soft) |
| Cinemeta `/catalog/*/search` | identity resolver | D | 3 s | yes | as above | resolver short-circuit | corpus associations | resolver (soft) |
| Torrentio / Comet | `searchStremio` | A (live path) | 5 s | yes | none | Torznab → corpus → Prowlarr | corpus | live bridge (per-source disposition) |
| Torznab | `searchTorznab` | B | 5 s | yes | none | corpus | corpus | live bridge |
| Prowlarr | `searchProwlarr` | B (escalation only) | 8 s | yes | none | — | corpus | live bridge |
| TorBox `checkcached` | availability checker | B | 2 s | yes | 30 req/min | cached observation (5 min) | `provider_observations` | availability checker |
| TorBox `mylist` (account) | placement lookup, create-verify | A (create path) | 15 s | yes | 1 (coordinator) | — | durable placement rows | create-first path |
| TorBox `mylist?id=` | file inventory | A (binding) | 15 s | yes | 1 | — | durable `provider_files` + inventory snapshot | request path |
| TorBox `createtorrent` | create-first placement | A (create path) | 5 s | yes | none | passive lookup | — | request path |
| Real-Debrid `torrents` | RD ensure, RD realizer, coverage ensurer | B / C | 10 s | yes | 1 (rate-limit), 500 ms min interval, global cooldown | durable RD placement | `provider_placements` | realizer (memory + snapshot + single-flight) |
| Real-Debrid `torrents/info/*` | RD realizer | B | 10 s | yes | as above | — | durable `provider_files` | realizer |
| PMS section refresh | `notifyPlex` | E | 5 s | yes | coalescer 60 s | Plex's own scan | VFS row + `.strm` | notifier (fire-and-forget) |
| PMS activities / metadata | `plex-ingest` | D | 10 s/req | yes | poll 250 ms | `.strm` + VFS | VFS row | publication path (20 s/60 s bounded) |
| PMS `confirmPlexEpisode` | reuse + publication confirm | D | 60 s | yes | none | publish state | VFS row | request path |
| Jellyfin `/Library/*` | `notifyJellyfin` | E | 5 s | yes | none | Jellyfin's own scan | `.strm` | fire-and-forget |
| data-plane `/files/:tfId` | byte serve, serviceability probe | A (playback) | 30 s (headers) | yes | Rust-owned | alternate TorrentFile (class D) | — | Rust |
| edge (Caddy) | ingress | A | — | — | — | — | — | Caddy |

## Background paths

| path | cadence | external work | owner |
|---|---|---|---|
| healthy re-request | per request | none (12–39 ms) | request path |
| requested-season reconciliation | 60 s tick | intent rows only | anticipation scheduler |
| provider route reconciliation | 6 h, single-flight | TorBox cache probe + RD account list | route reconciler |
| publication replay | per request | VFS + `.strm` + consumer notify | reuse/republish path |
| playback recovery | per byte read | Rust same-TorrentFile failover, class-D alternate | Rust |
| catalog sweep (read traffic) | ≤60 s, per PROPFIND | materialization + binding check + RD enrichment | WebDAV handler |

## Measured facts (2026-10-19)

- Cinemeta healthy p50 80 ms / max 205 ms; slow-but-valid outlier 1.72 s →
  budget 3 s.
- Torrentio/Comet discovery: 0.9–5.0 s per request (dominates the live
  request wall time; bounded at 5 s each).
- TorBox account `mylist` (whole account, 421 torrents, 5.2 MB): 1.1–5.6 s
  → replaced by a targeted read of 143–250 ms on the binding path.
- RD account list: 147 downloads per 4 forced catalog passes before the
  realizer memory/snapshot/single-flight; 1 after.
- Binding re-authorization on read traffic: 330 warnings / 30 min before
  the identity-scoped skip; 16 / 5 min after (the residual is provider
  route churn, which is intended to re-point the route).

## Recovery states and their owners

| state | notices | retries | durable record | wake-up | hot-loop guard | human needed |
|---|---|---|---|---|---|---|
| Cinemeta unavailable | caller | next request | — | next request | 30 s memory | no |
| Cinemeta degraded presentation | publication | never (path stable) | VFS row + `.strm` | — | — | no |
| Discovery source down | live bridge | next request | source disposition | next request | — | no |
| No serviceable route | selection | bounded alternates | response `serviceability` | next request | bounded 4 | no |
| Stale ProviderPlacement | route reconciler | 6 h | placement row | reconciler | single-flight | no |
| Stale ProviderFile | request path | next request | provider_files | next request | — | no |
| Negative byte-health | selection probe | half-open | in-process registry | next probe | 20 s → 5 min | no |
| Published but consumer-invisible | Plex notify | coalescer | VFS row + `.strm` | Plex scan | 60 s | no |
| PMS down | notify/confirm | next request | — | next request | 5/10/60 s | no |
| Binding route fails | Rust | same-TorrentFile failover | byte-health | byte read | per route | no |
| Alternate route exists | Rust + VFS | class D | persisted alternate | byte read | — | no |
| No alternate route | VFS | terminal 5xx | — | new request | — | no |

## Known residual issues

- The `.strm` title and the VFS canonical path use two different
  presentation resolvers with different year handling, so a published item
  can present two different paths to Plex and to Jellyfin, and a metadata
  outage can move one of them.
- The first-acquisition path still reads the whole provider account: it is
  the only hash index, and the ">1 resource matches this hash" conflict
  rule cannot be proven by a targeted read.
- The provider inventory observation's TTL is an authorization gate, so an
  expired observation is a binding failure unless the Binding is unchanged
  (it is now skipped) or the route evidence is refreshed.

# HashSucker

HashSucker is a self-hosted media fulfillment layer for debrid-backed Plex/Jellyfin libraries.

You request a movie or episode through tools you already use. HashSucker finds the best release, binds it to TorBox and/or Real-Debrid, publishes a stable library entry, and keeps the provider details out of the consumer path.

The philosophy: request somewhere else → HashSucker quietly handles discovery, ranking, providers, durable identity and publication → media appears in Plex/Jellyfin.

No management UI by design. Not a media frontend, not a torrent browser, and not another Radarr/Sonarr replacement — those tools stay exactly where they are.

## What runs

- **media-search** — Node service owning durable truth and selection: HTTP API, discovery, ranking, the resolver, request/intent handling, and VFS/STRM publication. Bound to loopback by default.
- **data-plane** — Rust byte delivery: per-TorrentFile serving, exact Range requests, same-TorrentFile provider recovery, fixed-grid disk cache.
- **torbox-importer** — optional TorBox physical-import bridge for Arr libraries. Not required for normal debrid-backed playback.
- **edge** — Caddy frontend, the single external listener. Transport only.
- **SQLite** — local persistent state (discovery corpus + request results, control plane). No external database, no message broker.

Optional integrations, by role:

- Requests and intents: **Seerr** (webhooks, including deferred unavailable requests), **Sonarr/Radarr** (monitored movies/episodes become scheduled intent).
- Candidate intelligence: local **DMM corpus**, **Torrentio**, **Comet**, **Prowlarr/Torznab**.
- Consumers: **Plex**, **Jellyfin** (library refresh; STRM files work regardless).
- Providers: **TorBox**, **Real-Debrid** — TorBox only, Real-Debrid only, or both are supported configurations.

## Install

Packaged images, no source build:

```sh
cp .env.example .env      # then edit: provider key(s) + two host paths
docker compose pull
docker compose up -d
```

Minimal config — choose at least one provider, nothing dummy for the other:

- `TORBOX_API_KEY` and/or `REALDEBRID_API_KEY`
- `HASHSUCKER_DATA_PATH` — persistent databases and state (back this up)
- `HASHSUCKER_MEDIA_PATH` — STRM/publication output, visible to Plex/Jellyfin
- `PUID`/`PGID` only if your host needs it (Unraid: `99`/`100`)

Unraid-style examples:

- `HASHSUCKER_DATA_PATH=/mnt/user/appdata/hashsucker`
- `HASHSUCKER_MEDIA_PATH=/mnt/user/media/hashsucker`

See `UNRAID.md` for the Compose Manager path. Everything else in `.env.example` is optional and clearly marked; absent integrations disable cleanly.

## What to expect after install

Containers start → diagnostics (`GET /api/diagnostics`) report `ready` within seconds → the corpus begins background bootstrap → the system is usable before the corpus completes → the corpus keeps improving in bounded sessions.

- Initial corpus bootstrap is resumable, runs in bounded background sessions, and a restart never throws the work away.
- Requests work while it is building: discovery, ranking, provider binding, stable library publication — later rerequests are near-instant.
- Future requests can be remembered: near release, HashSucker searches again on its own. Low-quality CAM/TS-style movie releases are never speculatively published; acceptable releases can be prepared and published before the human returns.

## What HashSucker does well

- **Durable TorrentFile identity** — Release + exact path + immutable size, surviving provider churn and restarts.
- **Independent TorBox and Real-Debrid fulfillment** — either provider alone, or both, with exact-file mapping and same-TorrentFile provider fallback.
- **Restart/reacquire** — durable truth persists; rerequests complete in milliseconds; Range/seek correctness holds across restarts.
- **Prepared fulfillment** — discovery and binding ahead of demand.
- **Speculative publication** — quality-gated (no CAM/TS), windowed for movies vs TV episodes.
- **Deferred unavailable requests** — Seerr requests that can't fulfill yet become durable intent, with availability wakeups.
- **Sonarr/Radarr intent sensors**, **Prowlarr live candidate sourcing**, **resumable corpus bootstrap**, quality-aware ranking with per-candidate score explanations.

See `docs/architecture.md`, `docs/discovery-ranking.md`, `docs/playback-delivery.md`, and `docs/operations.md` for internals.

## Current weaknesses and limitations

- Actively developed; interfaces and tunables may still move.
- arm64 images build successfully but are not yet field-proven.
- No Community Apps template — Compose Manager is the supported Unraid path.
- Some historical/shadow diagnostics remain in the codebase.
- Corpus bootstrap uses meaningful RAM (hundreds of MB) while importing.
- Provider-backed media is ephemeral by nature; HashSucker is not archival storage.
- Permanent-local-storage promotion is not yet implemented.

## Remaining work

Product gaps (not preferences):

- Permanent-storage promotion contract (backup/restore semantics for appdata).
- Real-world arm64 validation.
- Continued household dogfooding.

Possible later: provider-side lifecycle/GC, Unraid distribution polish.

## Architecture and operations docs

- [`docs/architecture.md`](docs/architecture.md) — services, identity model, data model, HTTP surface.
- [`docs/discovery-ranking.md`](docs/discovery-ranking.md) — sources, score model, confidence tiers, request pipeline.
- [`docs/playback-delivery.md`](docs/playback-delivery.md) — resolver, `.strm`, redirect vs proxy, mounts, WebDAV, physical import.
- [`docs/operations.md`](docs/operations.md) — deployment, environment variables, health checks.
- [`UNRAID.md`](UNRAID.md) — Unraid Compose Manager quick-start.

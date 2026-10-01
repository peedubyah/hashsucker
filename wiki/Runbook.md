# Operations / Runbook

Practical, not philosophical. Assumes the compose deployment in
`compose.yaml` with `.env` from `.env.example`.

## Services and ports

| Service | Exposes | Talks to |
|---|---|---|
| media-search (Node) | host-loopback `:3000` | data-plane `:3001`, both SQLite DBs, providers (outbound) |
| data-plane (Rust) | internal `:3001` | `CONTROL_URL=http://media-search:3000/api`, providers (outbound), cache volume |
| edge (Caddy) | public `:8080` | media-search `:3000` (byte-transparent) |
| torbox-importer | no listener | TorBox API, filesystem queue, Arr targets |

## Startup / shutdown

```sh
docker compose pull && docker compose up -d     # atomic update, no manual migration
docker compose restart media-search             # safe; self-heals in seconds
```

Source is baked into images: after media-search product changes,
`docker compose build media-search && docker compose up -d --no-deps
media-search`. Never `docker cp` host source into a running container.

## DBs, config, paths

- `/home/patrick/hashsucker-data/discovery/discovery-cache.db` and
  `.../control-plane.db` — same backup unit; back these up, nothing else matters as much.
- Env is the only config (see `media-search/src/lib/config/env.js`);
  no config files. Key vars: `TORBOX_API_KEY` / `REALDEBRID_API_KEY`,
  `HASHSUCKER_DATA_PATH`, `HASHSUCKER_MEDIA_PATH`, `STRM_OUTPUT_PATH`,
  `DATA_PLANE_URL`, `PLEX_URL`/`PLEX_TOKEN`, `SEERR_WEBHOOK_TOKEN`,
  `*_ENABLED=0` to disable any background timer family.
- Scratch rule (incident-earned): `df -h /` + `docker system df` before
  large proofs; scratch under `/var/tmp/patrick/hashsucker/<run>`;
  harness DBs must be copies of BOTH live DBs unless the proof needs the
  live corpus; delete disposables; never `docker system prune -a --volumes`.

## Health checks

```sh
curl -s localhost:3000/api/diagnostics | head -c 300   # ready within seconds
curl -s localhost:3000/health
npm run test:production-smoke    # from media-search/
npm run test:production-canary   # bounded rotation, quiet on success
```

Operator surfaces: `/api/operator/*` (activity, downloads, workers,
corpus, evidence, enrichment, hygiene, quality, requests, logs, events),
`/api/metrics`, data-plane `/metrics`, TUI via `npm run tui` (reads only).

## Triage: Plex problem or HashSucker problem?

1. PMS session exists but no HashSucker reads → consumer/scan issue, not byte path.
2. HashSucker reads present but provider errors → route/provider issue; check placement state + provider 429 history, not the library.
3. `416`/short reads → size/identity mismatch; check TorrentFile row vs provider file.
4. Stuck Plex scanner → zurg-side/dead-link cause; HashSucker repairs dead links on access, never via background polling storms.
5. Stale VFS entry → check binding status (active/superseded/degraded/failed) before touching anything.

## Safe vs unsafe recovery

Safe: container restarts, re-running the canary, replays, re-observing
placements, re-running reconcile. Unsafe (never do): mutating or
checkpointing live discovery for convenience, hand-editing bindings/
placements/VFS rows, uncached provider downloads to "fix" availability,
broad Docker prunes, deleting production volumes or corpus state.

## Source references

- `docs/operations.md`, `docs/architecture.md`,
  `media-search/src/lib/operator/`, `media-search/src/server/index.js`

# HashSucker handoff

**Last code-verified:** 2026-08-21  
**Canonical baseline:** [`docs/audit/8-21-audit.md`](docs/audit/8-21-audit.md)  
**Machine-maintained integration state:** [`docs/project-state.md`](docs/project-state.md)

This is the only canonical durable project handoff. It separates implemented behavior from target architecture. Recommendations below are not claims of existing behavior. Read it together with the generated project state; if that artifact is missing or stale, run `node scripts/update-project-state.mjs` from the repository root.

## State ownership boundary

- **Human-maintained:** Product north star, architecture boundaries, invariants, authority, roadmap intent, and constraints agents must not casually redesign. These belong in `HANDOFF.md` and the canonical documents it cites.
- **Machine-maintained:** Current repository and integration facts reproducibly derived from Git-visible files, package manifests, root Compose, schema/protocol sources, and explicit roadmap metadata. These belong only in [`docs/project-state.md`](docs/project-state.md).
- **Future task system:** Agent ownership, active issue/task, branch/worktree ownership, and acceptance state. These do not belong in either handoff document.

Worker branches/worktrees must not routinely regenerate or commit shared project state. After accepted branches are merged, the canonical integration/root workflow runs the updater and commits the resulting artifact. Resolve generated-file conflicts by regenerating from the integrated tree, never by hand-merging generated prose.

## Current verified system state

### Implemented

- Root Compose defines `media-search` and `torbox-importer` only.
- `media-search` is an unauthenticated Node HTTP API. It performs Cinemeta title/media lookup, local SQLite/FTS5 retrieval, live Torrentio/Comet/Torznab discovery, local ranking, request publication, and operator-triggered ingestion/attribute work.
- Discovery SQLite models candidates, parsed release attributes, media associations, provider observations, and an FTS5 index. It defaults to memory unless `DISCOVERY_DB` is set.
- A separate `ui/` React/Vite prototype supports title search and release comparison. It is not built, served, or deployed by root Compose, and its metadata DTOs currently diverge from the API.
- `torbox-importer` claims JSON requests from a shared filesystem queue, resolves TorBox placement to an expiring download URL, downloads into local staging, and submits `ManualImport` to Sonarr or Radarr.
- Physical import accepts an explicit movie or exactly one TV episode. The importer independently maps and validates provider files; browser-selected file evidence is not authoritative.
- Direct TorBox cache-check code exists with useful batching/failure semantics, but it belongs to a legacy CLI path and is not connected to the active combined server search.
- Real-Debrid appears only as a Torrentio discovery configuration. There is no direct Real-Debrid provider adapter or placement integration.

### Not implemented

- Real-Debrid placement, Zurg deployment, TorBox WebDAV validation, rclone provider mounts, mount inventory, provider-file inventory, canonical virtual-library projection, reconciliation, provider failover, and playback/catalog health.
- A provider-neutral capability contract or provider-independent canonical binding model.
- Learned cache priors, release-family reputation, or unbiased provider-outcome training telemetry.
- Production UI deployment or an executable shared API contract.

### Known deployment truth

- Root Compose does not set `DISCOVERY_DB` or mount discovery storage; corpus and observations are lost on restart.
- Root Compose does not deploy the React UI; the backend has no static route.
- `media-search/Dockerfile` copies source but does not run `npm ci`/`npm install`, so clean images lack `lz-string`.
- Mutation routes are not authenticated. Credential-bearing addon configuration has been committed and must be treated as exposed pending rotation and history cleanup.

## Product north star

```text
large hash corpus
  → release/media intelligence
  → efficient provider-specific cache probing
  → provider placement
  → provider-authoritative file mapping
  → mature provider transport
  → stable provider-independent virtual library
  → Plex / players
```

- **Control plane:** HashSucker owns intent, exact candidates, release intelligence, probe and placement decisions, provider observations, canonical library identity, bindings, reconciliation, and typed telemetry.
- **Data plane:** Zurg, provider WebDAV, and rclone expose and transport provider bytes.
- **Catalog/players:** Plex and other consumers see stable HashSucker-owned canonical paths, not volatile provider paths.
- **Secondary mode:** Local download plus Sonarr/Radarr import remains supported and isolated.
- **Non-goal:** Do not resurrect a custom HTTP byte proxy as the primary architecture. Consider one only after measured failures show mature transports cannot satisfy playback requirements.

A useful first virtual-library slice does not require machine learning. Deterministic desirability, authoritative provider checks, exact placement/file mapping, and stable projection are enough to validate the product direction.

## Critical invariants

1. Public candidate identity is exact `(infoHash, fileIndex)`, represented as `releaseKey = lower(infoHash) + ":" + (fileIndex ?? "torrent")`.
2. `fileIndex = null` means torrent-level or unknown-file evidence, never file zero.
3. Browser/corpus file indexes are evidence. The provider’s file inventory is authoritative after placement.
4. Release desirability, provider-specific cache prior, confirmed provider state, placement, exposure, binding, cataloging, and playback are separate states.
5. Provider timeouts, rate limits, network errors, and 5xx responses remain unknown/error; they never become `uncached`.
6. HashSucker owns stable canonical library identity and auditable binding history. Provider paths, torrent names, mount order, or rclone-union policy do not define media identity.
7. Rebinding may change backing placement/file without changing logical library identity or canonical path.
8. The shared filesystem queue remains authoritative for physical-acquisition commands. Virtual desired state belongs in transactional control-plane persistence.
9. Sonarr/Radarr retain final media/import authority in physical mode. Do not weaken importer identity, hash, size, post-import, or ownership checks.
10. Cleanup is conservative and ownership-aware. Do not delete provider resources or projections not provably created for the request.
11. Explicit episode intent remains explicit even if a selected release is a pack. Never broaden user intent from release contents.
12. Routine media bytes do not pass through `media-search`.

## Current architectural boundaries

| Boundary | Current authority | Target authority |
|---|---|---|
| Metadata | Cinemeta adapter in `media-search` | Provider-neutral metadata adapters in `media-search` |
| Candidate corpus | Discovery SQLite | Persistent, measured SQLite unless benchmarks justify change |
| Search/ranking | Local FTS/ranking plus separately normalized live results | One identity-safe eligibility, normalization, and ranking pipeline |
| Provider observations | Latest-value rows; active server does not hydrate direct checks | Provider-scoped, fresh, typed observations plus event history |
| Physical fulfillment | Filesystem queue → `torbox-importer` → TorBox → Arr | Retained secondary policy |
| Virtual fulfillment | Absent | HashSucker placement/binding/reconciliation above hidden provider mounts |
| Byte transport | TorBox signed URL copied by `aria2c` | Zurg/provider WebDAV/rclone for virtual mode |
| Catalog | Sonarr/Radarr after physical import | Plex/players over canonical projection; Arr optional/advisory in virtual mode |

Keep `media-search` as the primary control-plane codebase. A materializer/reconciler starts as a logical module; split it into a worker only for mount access, scheduling, fault isolation, or privilege separation. DMM sync should become a one-shot command from the same image, not a new product.

## Current known defects

Critical defects, in priority order:

1. Local corpus retrieval is not selected-media scoped; empty local queries can return unrelated rows.
2. Local and live candidates are not globally ranked; live candidates receive score `0`.
3. Hash-only merging drops file-aware identity. UI keys, request handoff, and importer persistence also omit exact `releaseKey` propagation.
4. Deployment is incomplete: ephemeral discovery DB, no UI, and a clean backend image without installed dependencies.
5. Mutation endpoints lack authentication; committed credential-like configuration requires rotation/removal.
6. The API-reachable DMM runner accepts an obsolete script-call wrapper while current sampled fragments use iframe/hash. The compatible importer is test-only/unwired and parses each decoded JSON array in memory.
7. Provider-observation age is ignored; there is no active provider hydration in combined server search.
8. API documentation and UI types disagree with active normalized metadata fields.
9. The importer always resumes the first `processing` item; one blocked/manual request can starve later work.
10. There is no end-to-end virtual-library lifecycle, so cached, placed, exposed, bound, cataloged, and playable cannot yet be reported separately.

See [`docs/known-gaps.md`](docs/known-gaps.md) for the maintained register.

## Current roadmap stage

The project is at **Stage 0: security and deployability**. Stages are ordered in [`docs/roadmap.md`](docs/roadmap.md); do not skip directly to learned cache models or broad provider abstractions.

Resume implementation with:

1. Rotate/remove committed secrets and define route access controls.
2. Make clean deployment truthful: install dependencies, choose a UI deployment model, persist `DISCOVERY_DB`, and test restart persistence.
3. Then establish one executable API contract and propagate `releaseKey`/`fileIndex` through API, UI, queue, and importer state.
4. Scope local retrieval by selected media identity and globally rank normalized local/live candidates.
5. Only after those foundations, add provider capability/observation contracts and a shadow canonical-library reconciler.

Do not create LongCat implementation contracts during this documentation pass. The next planning pass may define durable implementation contracts after Stage 0/1 scope is confirmed.

## External integrations

| Integration | Current use | Target use / caution |
|---|---|---|
| Cinemeta | Active metadata search/details | Keep behind provider-neutral metadata interface |
| DMM corpus | Source fragments; active HTTP ingestion currently incompatible with sampled wrapper | Resumable one-shot synchronization with checkpoints and measured capacity |
| Torrentio | Live discovery configured for TorBox and optionally Real-Debrid | Discovery evidence, not provider-authoritative placement/file state |
| Comet | Optional live discovery manifest | Same evidence limitation |
| Torznab/Prowlarr-like endpoints | Generic JSON search path | Add capability discovery; do not assume JSON or generic search support |
| TorBox API | Physical acquisition; direct cache checker exists off active path | Add explicit cache/placement/file capability and validate native WebDAV |
| Real-Debrid | Torrentio discovery only | Direct provider adapter, placement, and Zurg integration are target work |
| Zurg | Not deployed | Target Real-Debrid WebDAV data plane; paths are not canonical identity |
| rclone | Not deployed | Target hidden read-only VFS mounts; union policy is not semantic identity |
| Sonarr/Radarr | Authoritative physical import and validation | Retain physical authority; virtual participation is optional until no-copy behavior is proven |
| Plex/players | Not integrated | Consume stable canonical projection and expose catalog/playback health separately |

## What must not be casually redesigned

- Do not replace SQLite before a reproducible workload benchmark.
- Do not split logical modules into microservices without an operational boundary requiring it.
- Do not turn the shell importer into the provider-neutral virtual materializer.
- Do not replace the physical filesystem queue merely for fashion; fix liveness within its ownership model.
- Do not weaken importer validation or cleanup safeguards to ease discovery integration.
- Do not deduplicate exact candidates by hash or release family.
- Do not use provider paths or an rclone union as the canonical library.
- Do not equate predictions or downstream success with authoritative cache state.
- Do not require Sonarr/Radarr completed-download import in virtual mode.
- Do not introduce a custom byte relay without measured transport evidence.

## Authoritative documents

1. [`README.md`](README.md) — project entry point.
2. `HANDOFF.md` — this durable architectural and project handoff.
3. [`docs/project-state.md`](docs/project-state.md) — generated current repository/integration facts.
4. [`docs/architecture.md`](docs/architecture.md) — implemented versus target boundaries.
5. [`docs/data-model.md`](docs/data-model.md) — current storage and target entities.
6. [`docs/pipeline.md`](docs/pipeline.md) — current and target flows.
7. [`docs/roadmap.md`](docs/roadmap.md) — staged implementation order and exit criteria.
8. [`docs/known-gaps.md`](docs/known-gaps.md) — current defects and risks.
9. [`docs/audit/8-21-audit.md`](docs/audit/8-21-audit.md) — detailed canonical assessment/evidence baseline.
10. [`media-search/src/api/API_CONTRACT.md`](media-search/src/api/API_CONTRACT.md) — code-adjacent current HTTP contract; code wins if drift is discovered.
11. Component READMEs — local development and operational constraints only.

ADRs record decisions; evaluations record bounded evidence. `docs/archive/` and `handoff/` are non-authoritative history. Archived claims must be reverified against current code before reuse.

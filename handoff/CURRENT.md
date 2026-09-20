# HashSucker self-handoff (durable — survives session death)

If this session dies right now: `main` == `github/main` at 85b039c (pushed).
Read this file, `../AGENTS.override.md` (operating rules), and
[`../docs/architecture.md`](../docs/architecture.md) (durable model). Do not
trust old containers or historical HY4 handoffs.

## Architecture boundaries (frozen)

- **Node owns durable truth:** Release, TorrentFile, ProviderPlacement,
  ProviderFile, binding/publication/VFS semantics, discovery/ranking,
  persisted candidates, selection of another TorrentFile or Release.
- **Rust owns execution and byte motion:** DeliveryCapability lifecycle,
  TorBox/Real-Debrid Range delivery, retry/`Retry-After`, limiter/breaker,
  same-TorrentFile provider recovery, cache, coalescing, scheduling.
- Rust may switch providers only for the same exact TorrentFile. Only Node
  may select a persisted alternate TorrentFile or Release, and only after
  the authoritative VFS path receives classified provider exhaustion.
- Authoritative byte path: client → edge (`:8080`) → Node `/vfs` selects
  TorrentFile → Rust `/files/:tfId` → Node `/api/data-plane/files/:tfId`
  projection → cache or provider bytes → stream back. `/stream/*` and
  `/media/:infoHash/:fileIndex` are legacy compat paths, not authoritative.

## Frozen identity model

| Entity | Durable meaning |
|---|---|
| Release | `infoHash` |
| TorrentFile | `(infoHash, canonicalInternalPath)` + immutable positive size; Rust cache/coalescing key also includes size |
| `torrent_files.id` | routing UUID / forensic label only |
| ProviderPlacement | `(provider, accountScope, providerResourceId)`; `infoHash` immutable for that key |
| ProviderFile | current file observation within a placement; maps to a TorrentFile when authoritative |
| MediaBinding | library item/path → release, placement, ProviderFile, read-only exposure |
| DeliveryCapability | private Rust runtime state (ephemeral signed URL); never persisted, never identity |

Same exact Range of the same TorrentFile must be byte-identical on TorBox
and Real-Debrid. Different bytes for one TorrentFile = identity violation.

## Deployment topology

- Compose project `hashsucker`: `media-search` (host-loopback `:3000`;
  container `hashsucker-media-search-1`; source baked into image — rebuild +
  `up -d --no-deps` after product changes), `data-plane` (internal `:3001`),
  `edge` (public `:8080`, Caddy reverse proxy), `torbox-importer`
  (no listener; filesystem-queue acquisition → Arr import).
- Images: `${HASHSUCKER_REGISTRY:-ghcr.io/peedubyah}/hashsucker-<svc>:${HASHSUCKER_VERSION:-latest}`.
- DBs (same backup unit): `/home/patrick/hashsucker-data/discovery/discovery-cache.db`,
  `.../control-plane.db` (`download_requests` lives in control-plane.db).
- Download staging root: `HASHSUCKER_DOWNLOAD_PATH` (unset = 409/503, no worker).

## Release/version state

- Packages at `0.0.1` (placeholder); shipping identity is GHCR
  `latest`/`main`/`v0.1.0` tags, not package versions.
- `main` == `github/main` == 85b039c (pushed): staged-download
  post-consumption lifecycle closed the generic-download loop.
- Household canary (2026-09-20, scratch stack on DB copies, real
  data-plane image + provider bytes): fresh hd request selected capped
  1080p in 6.6s; omitted re-request reused in 0.5s; bounded ranges
  (first byte + 2 seeks) byte-identical; 255MB download staged exact,
  handed off, ACKed, swept. Found + fixed: movie-scope profile intent
  missed fanned-out episode items (`setPublicationProfile` now fans out
  on exact-miss). Production media-search was down during the canary;
  Requestrr/Seerr/Plex are not present in this environment — their exact
  HTTP seams were driven instead.

## Major completed features (recent first)

- Named intent quality profiles bound selection + upgrades (`balanced` /
  `hd` / `max`; 149ae66).
- Corpus ingestion cooperative yielding (82823f5).
- Download-intent tranche: persisted `/api/download-request` → resolver
  worker → TorrentFile binding → materialization → staged, with bounded
  retry, re-stage-on-re-POST, request snapshot retention.
- Durable importer handoff: versioned outbox manifests + consumer ACKs
  (`pending/accepted/completed/failed`, version-guarded, idempotent).
- Autonomous quality-tier upgrades with durability-confidence veto;
  upgrade-watch loop; publication persists/honors profile.
- Temporary publications (watch-once + Plex-session-aware retirement).
- RD terminal states map to valid CHECK; durability requires ready.
- Dual-provider enrichment for published single-provider TFs; storm-triggered
  resilience escalation.
- Fixed-grid cache (8 MiB default — do not change without production
  evidence), per-chunk single-flight coalescing, scheduler observability.

## Lifecycle automation (all in `media-search/src/lib/`)

- `lifecycle/upgrade-watch.js` + `upgrade-policy.js` + `quality-profiles.js`
  (tier ladder, veto, caps); `coverage-escalation.js` (cheap second
  placement, storm escalation); `job-retry.js` (bounded retry budgets);
  `anticipation/scheduler.js` (pre-warm); `promotion/` (library permanents);
  `download/` (`store`/`worker`/`resolve`/`handoff`/`paths` — back-door
  staging); `library/retirement.js` (temporary publication expiry).
- Staged-download end of life (staged-cleanup slice): HashSucker owns
  staging, consumer owns the destination. pending/accepted/failed retain
  the file indefinitely. completed schedules cleanup after a 1h grace,
  tied to the exact completing handoff version (`cleanup_*` columns;
  a new handoff version voids prior scheduling). The sweep rides the
  existing download timer (no daemon, no filesystem scan, owned-root
  unlinks only, no discovery/provider calls). A missing file at sweep
  time is the expected atomic-move outcome (converge, no error); unlink
  failures re-due boundedly (15min x 48, then parked, file retained)
  without touching media resolution. Re-POST after cleanup reactivates
  the same durable row (reset, re-stage, new handoff version). Completed
  rows predating the deploy entered the lifecycle with one full grace
  at migration.

## Known provider behavior

- TorBox: cached-gate for enrichment (never uncached addMagnet from
  coverage paths); byte-read CDN 429 = bounded temporary state with
  per-capability backoff; transport 502 must not trigger destructive repair.
- Real-Debrid: account-scoped discovery; missing-observation fixtures drive
  the 8-case resolver decision ladder (deterministic tests); RD-only path
  preserves TorrentFile identity (provider-neutral resolution proof).
- Live proofs so far: both providers delivered exact Ranges, survived
  seeks/cancel/reopen, reacquired capabilities after data-plane restart
  without acquisition storms.

## Performance findings

- Phase A closed A3 (2026-09-12): shared-cap two-lane default OFF, no
  production case justified it; concurrent pressure already parallelizes via
  capability-pool growth (`first_alive_busy`). Do not tune without a new
  concrete workload gap. A/B scripts/artifacts stay untracked, unmodified.
- Metrics are process-lifetime cumulative: use bounded before/after deltas
  with known cache state. Lane counters cover shared-cap only; zero lanes
  does not rule out distinct-cap two-lane.

## Bootstrap/corpus behavior

- Discovery corpus persists eligible ranked outcomes as durable
  candidate→media associations (post-commit backfill, best-effort).
- Ingestion yields cooperatively; do not re-run full corpus/bootstrap
  proofs when a cheaper proof establishes the same fact.

## Profile model (quality-profile tranche — single implementation)

- `media-search/src/lib/lifecycle/quality-profiles.js` is the ONLY profile
  vocabulary: `normalizeQualityProfile` (unknown = 400, never silent),
  `profilePolicy`, `selectionMaxTier` (hd → 42, balanced/max → null).
- `balanced` (default): today's behavior exactly; upgrades to global
  terminal (Remux 2160p) with <10-tier durability veto.
- `hd`: 1080p-class terminal; initial selection never above BluRay-1080p
  class; upgrades park there; same veto. Empty fallback: all-above-cap
  selects unfiltered instead of failing. No-downgrade guard: a healthy
  binding above the cap stays; profile is recorded for future terminal
  behavior.
- `max`: terminal = balanced, durability veto never fires (fragility for
  quality); byte-readiness still gates every switch.
- `media-request` accepts/persists/honors it; publication + upgrades honor
  it; `/download` threading landed in 5ae84ca (both resolver paths).

## Do-not-regress invariants

- Release identity = infoHash. TorrentFile = infoHash +
  canonicalInternalPath + exact positive size. Never key durable byte
  identity on file ordinal, basename, provider filename, releaseKey, Comet
  fields, or capability/CDN URLs. Provider state and delivery capabilities
  are ephemeral; validate persisted DB refs at application boundaries.
- ProviderPlacement durable; DeliveryCapability runtime-only. Node
  chooses; Rust serves/recovers the same TorrentFile; Rust never picks
  another Release. No shared cross-TorrentFile serialization.
- Product principle: no human decision required → no human interface required.
- No second profile implementation. No ranking rewrite for profiles.
  No staged-file upgrade loop. No Arr profile mapping.

## Scratch/disk rules

- In `../AGENTS.override.md` ("Operating rules"). Short version: preflight
  `df -h /` + `docker system df` before large proofs; record scratch
  paths/volumes/containers/stacks before creating; never keep simultaneous
  host + Docker copies of one multi-GB artifact; bounded Range/hash over
  full downloads; scratch under `/var/tmp/patrick/hashsucker/<run-name>`;
  scratch HTTP/integration servers use scratch copies of BOTH DBs unless
  the proof explicitly needs the live dev corpus (never mutate/checkpoint
  live discovery merely for convenience); delete your own disposables;
  never touch `hashsucker_hy4-cache` or active production volumes; never
  `docker system prune -a --volumes` without Patrick. End every substantial
  proof with the 5-line cleanup report.

## Recent important commits

- 149ae66 `feat(profile): named intent quality profiles bounding selection
  and upgrades` (HEAD, pushed).
- 82823f5 `perf(corpus): cooperative yielding in ingestion paths` (pushed).
- 60a8935 master logo assets; f60bc45 brand docs; e9a2916 product-first README.
- Before those: single-provider dual coverage, consumption-aware temporary
  publication, durable importer handoff, RD terminal-state mapping,
  watch-once publications, durability veto, bounded retry, autonomous
  upgrades, staged re-stage on re-POST.

## Deliberately parked

- Shared-cap two-lane (default OFF, A3); work stealing as a separate
  shipping question; 8 MiB grid changes from synthetic evidence.
- Untracked A/B kit: `scripts/ab-baseline-driver.sh`,
  `scripts/ab-concurrent-driver.sh`, `artifacts/ab-baseline-off.jsonl`,
  `artifacts/ab-off-vs-on.json` — do not modify, stage, or commit.
- Doc queue (do not derail the active slice; track here): verify README
  never documents TorrentFile identity as `(infoHash,fileIndex)`; make
  Rust/data-plane differentiation more prominent above the fold; decide
  project license; set GitHub description/topics if still unset.
- No UI, no Arr mapping, no Requestrr changes in the profile slice.

## Next active slice — staged-download lifecycle (IN PROGRESS, uncommitted)

Goal: bound the post-consumption life of staged artifacts before household
use fills disk. Model: pending/accepted/failed retain; completed + 1h grace
→ sweep unlinks (owned root only) or converges when already moved; unlink
failures re-due boundedly without media retry; stale handoff versions can
never authorize deletion; re-POST after cleanup reactivates the same row.
Implemented in `download/store.js` (`cleanup_*` columns + migration +
`listCleanupDue`/`markCleanupDone`/`deferCleanup`), `download/worker.js`
(`sweepStagedCleanup`), `server/index.js` (existing download timer, no new
daemon), `server/app.js` (GET exposes `cleanupDueAt`/`cleanupDoneAt`),
`download/handoff.js` (doc). Tests: `download.test.js` (+6 cleanup tests,
30/30 green with neighbors 63/63). Live proof done on a scratch stack
(both DBs fresh, 1KB fixtures): pending/accepted/failed retained, completed
due at +60min, expiry → removed, pre-move → converged, stale v1 ACK → 404,
restart preserves due byte-identical, re-POST → same-row reset. Then one
coherent feature commit.

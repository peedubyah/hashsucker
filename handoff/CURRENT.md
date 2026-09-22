# HashSucker self-handoff (durable — survives session death)

If this session dies right now: `main` == `github/main` at c1075c5 (pushed).
Production media-search RUNNING v0.4.0. Web UI = household appliance,
TUI (`npm run tui` in media-search/) = operator control room.
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
- media-search reactivated 2026-09-21 on image 9193caa9f324 (local build
  of 1fcb52b; GHCR latest was Sep-16 and 12 commits stale). `.env` now
  pins `HASHSUCKER_{DISCOVERY,QUEUE,STRM}_HOST_PATH` to leaf paths: the
  legacy leaf aliases double-append (`.../discovery/discovery`) and would
  boot media-search on empty state. LANDMINE (pre-existing, do not touch
  the healthy importer to fix): `DOWNLOADS_HOST_PATH` has the same
  leaf/suffix mismatch for any future importer recreate.
- Images: `${HASHSUCKER_REGISTRY:-ghcr.io/peedubyah}/hashsucker-<svc>:${HASHSUCKER_VERSION:-latest}`.
- DBs (same backup unit): `/home/patrick/hashsucker-data/discovery/discovery-cache.db`,
  `.../control-plane.db` (`download_requests` lives in control-plane.db).
- Download staging root: `HASHSUCKER_DOWNLOAD_PATH` (unset = 409/503, no worker).

## Release/version state

- Packages at `0.0.1` (placeholder); shipping identity is GHCR
  `latest`/`main`/`v0.1.0` tags, not package versions.
- `main` == `github/main` == c1075c5 (pushed): v0.4.0 released,
  production re-pinned, housekeeping clean.
- v0.4.0 RELEASED (tag → 32c0f45; all 4 images amd64+arm64,
  revision labels verified, `:latest` + `0.4`/`0.4.0` aliases live):
  appliance UI, operator API, diagnostics probe cache, housekeeping
  utility, deploy path pins. Fresh-install smoke green on published
  images (schemas, honest not-ready → TorBox key → ready, correct
  mounts, write path). Production re-pinned to v0.4.0 (media-search
  only; rest untouched): new UI served, counts unchanged, byte range
  sha256-identical to pre-release proof. Host housekeeping
  (`scripts/hashsucker-housekeeping`, report default, labelled `--clean`
  proven incl. a self-caught volume-guard bug) shows zero cleanable.
- Production media-search ACTIVE since 2026-09-21 00:4x UTC on local
  image 9193caa9f324 (=1fcb52b incl. the profile fan-out fix): 14
  migrations applied, VFS 66/26, counts unchanged, reconcile/Arr/corpus/
  upgrade ticks quiet, production byte path proven (206 + identical
  sha256 on bounded ranges), one restart clean. Leave it running.
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

### Landed: durable request intent policy

Commits `6340e90` and `415d1c3` are local, not pushed. The normalized
library outcomes are `library`, `watch`, and `immediate`; `/api/download-request`
remains the separate direct-download outcome. Omitted intent preserves legacy
behavior (`temporary:true` → watch, otherwise library); `qualityProfile`,
`ttlHours`, and direct `/download` behavior remain compatible. Intent and
upgrade policy persist on `library_items`, survive restart/re-request, and
use non-destructive transitions: watch → library adopts permanent, library →
watch never demotes an existing permanent publication, immediate → library
re-enables upgrades, and same-intent requests are no-ops. Watch publications
retain existing TTL/playback retirement and do not chase upgrades; immediate
publications are permanent but do not chase upgrades; library publications
retain normal upgrade behavior. UI vocabulary is limited to Keep in library,
Watch once, and Best available now. Focused intent/operator/library/download
validation passed (77 tests). The previous `search.js` syntax report was
confirmed: HEAD was genuinely invalid because the cache failure logger
callback lacked its closing `});`; standalone fix is `6340e90`. Unrelated A/B
artifacts remain untracked and untouched. No release/build/tag work performed.

### Landed: media-facing Web / operator TUI split

Commit `ce67880` is pushed to `github/main`. Browser navigation is now Home /
Search, Requests, Library, Downloads, Settings. The browser uses normalized
metadata search, household intent actions, request-centric progress projection,
and user-facing download/library views; provider, corpus, worker, identity,
placement, log, probe, and housekeeping internals remain in the TUI. Added
`GET /api/operator/media-requests` with durable request metadata and coarse
stages (`discovering`, `preparing`, `retry scheduled`, `ready`, `failed`),
without fake percentages or duplicate internal events. TUI now has Requests,
Corpus, Workers, and Storage/housekeeping sections; storage is report-only and
shows `scripts/hashsucker-housekeeping --clean`. Focused backend validation:
51 tests passed; UI typecheck/build passed. Real PTY walkthrough visited
Requests, Library, Providers, Corpus, Downloads, Workers, Logs, Probes, and
Storage; q exit and detail/probe navigation worked. Source UI desktop review
confirmed the five-tab media surface and real search/request flow. Scratch DB
copies were used for bounded endpoint proof and removed. Historical production
rows predate the new metadata columns, so their fallback rate is currently
100% for persisted media-request titles; new browser requests persist title,
year, and poster metadata. No release/build/tag work performed.

### Landed: evidence-before-intelligence observation slice

Commit `db34b6d` is pushed to `github/main`. Existing telemetry was audited
first: candidate first/last seen and source arrays, DMM generation/source
observations, candidate-media provenance, provider observation event/current
history, historical provider evidence, RD download correlations, compact
selection evidence snapshots, playback handoffs, timing/events, Rust runtime
metrics, and Plex consumption state already existed. This slice adds one small
bounded aggregate table, `evidence_observations`, keyed by existing Release /
TorrentFile/media/provider/observer dimensions. Repeated identical observations
update `last_seen_at` and `observation_count`; they do not append duplicate
rows. Discovery ingestion records normalized source release and association
observations with novelty (`novel_release`, `novel_association`, or
`repeat_observation`). Fulfillment records compact selection evidence: request
source/intent, profile, reason, candidate/alternative counts, and identity tier.
Availability observations distinguish observer from claimed provider and support
shared correlation IDs for later third-party-claim calibration. No ranking,
provider, acquisition, scheduler, or quality behavior changed. The TUI has a
read-only Evidence summary; the browser is unchanged. Retention is aggregate
knowledge retained by bounded upsert; fine-grained provider history remains
under its existing bounded/history policies. Scratch proof covered repeated and
cross-source Release evidence, third-party RD claim plus direct RD observation,
TorrentFile and selection evidence; 61 focused tests passed. No backfill was
run. No release/build/tag work performed.

### Landed: evidence calibration and source yield

Commit `cd7e746` is pushed to `github/main`. Evidence aggregates now support
bounded query-yield summaries by source class: query count, hashes observed,
novel releases, novel associations, selections, and average latency. Third-party
cache claims can be calibrated against later direct-provider observations by
Release/provider/time-window age buckets (`<15m`, `15-60m`, `1-6h`, `6-24h`,
`>24h`); correlation IDs are optional and not part of identity. Repeated
aggregate matching explicitly handles SQLite NULL dimensions. Bulk DMM ingestion
is excluded from generic evidence rows because `dmm_source_observations` already
provides generation/fragment provenance. A 10k live-source-shaped ingest created
10k bounded generic rows at ~721 candidates/s and ~6.2MB scratch DB; a 10k DMM
ingest created zero generic evidence rows, 10k existing DMM provenance rows, and
~5.3MB scratch DB at ~547 candidates/s. Focused calibration/DMM/operator/intent
validation passed (64 tests). No real provider acquisition or source fan-out was
forced; the existing source adapters and timing paths remain unchanged. No
release/build/tag work performed.
### Landed: real live discovery source census

Commit `3de4c43` is pushed to `github/main`. Instrumented the existing logical
live boundary in `live-bridge.js`: Torrentio, Torznab, and optional Prowlarr
are measured as one logical query each per media identity, with latency,
result count, failure, and normalized unique-hash yield. Query aggregates feed
the existing bounded evidence query table; no per-candidate query rows and no
ranking/provider behavior changes. A fair scratch census covered 12 movies,
episodes, and a miniseries. Torrentio returned 35,362 normalized hashes across
12 successful queries, average latency 1.09s; Torznab and Prowlarr were
configured as logical query slots but returned zero candidates in this
environment. Per-source latency p50/p95/max reporting is available in the TUI
Evidence view and operator evidence endpoint. DMM remains on its existing
provenance path and is not duplicated into generic evidence aggregates. No
provider acquisition was forced. Scratch DB copies were removed. Focused test
suite passed (54 tests).

### Landed: live source identity/disposition correction

Commit `acff7e2` is pushed to `github/main`. Stremio configuration was audited:
Torrentio and Comet are independently configured addon manifests and are called
concurrently by `searchStremio`; addon metadata existed but was lost when the
bridge flattened normalized results into one `torrentio` bucket. Observer
identity now preserves actual addon/provider identity (`torrentio-*`,
`comet-*`) with transport/source class `stremio`. Query evidence distinguishes
`queried_success`, `queried_empty`, `not_configured`, `timeout`, and
`upstream_error`; unconfigured Prowlarr is not recorded as successful empty.
Candidate provenance retains multiple observers on one Release. The 35,362
novelty audit confirmed the hashes were absent from the copied production
candidate baseline; novelty uses existing `(infoHash,fileIndexKey)` identity and
recognizes prior evidence rows. Focused source/evidence/operator tests passed
(54 tests). No ranking, fan-out, or provider behavior changed. No release/build/tag work performed.

### Landed: corrected independent-source mini census

Commit `95a14a6` is pushed to `github/main`. Identity wording now explicitly
states that `fileIndex`/`file_index_key` are discovery candidate keys, never
TorrentFile identity; TorrentFile remains `infoHash + canonicalInternalPath +
exact positive size`. A six-identity scratch census queried configured Stremio
observers independently against one immutable pre-query baseline: two Torrentio
manifests and two Comet manifests were active; no manual Comet manifest was
configured. Results: Torrentio-TorBox 819 hashes, Torrentio-RD 591, Comet-TorBox
3541, Comet-RD 3541 across six queries each; all succeeded. Comet TB/RD were
identical per identity (near-1.0 overlap); Torrentio TB/RD overlapped 0.61-0.82.
Torrentio/Comet overlap was 0.10-0.36, with Comet expanding the union materially
in this sample. Exclusive hashes were mostly Torrentio-TorBox (1-6 per item);
Comet had zero exclusive hashes because its larger sets contained the other
sets. No Torznab/Prowlarr census calls were included in this independent
Stremio-only run; their prior state remains disposition-based. The six baselines
had 13/17 known releases for the two popular movies and zero known associations
for the other four IDs; no persisted winners were used. No provider acquisition,
ranking, or fan-out changes. No release/build/tag work performed.

### Completed: corpus coverage and retrieval audit

No code changes were required. On scratch copies of the current discovery DB,
all six baseline identities were reproduced. The database contains 1,586,607
candidates, 1,586,549 attribute rows, and only 5,711 distinct candidate/media
associations; 1,584,812 candidates have no media association. Useful attributes
cover 1,585,821 candidate/file keys and the enrichment queue has 4,598 pending
rows. The zero baseline for `tt0903747:5:14` is an identity/association issue,
not corpus absence: show-level `tt0903747` has 221 associations but the exact
colon episode ID has zero. `tt0944947` has 56 show-level associations but zero
for `tt0944947:1:1`; `tt10986410` has 256 show-level and zero exact episode
associations. FTS/title attributes exist, but the normal media-scoped search
requires candidate_media identity confidence and explicit episode coverage, so
knowledge disappears at exact episode association/retrieval. Movie coverage in
a bounded 20-ID sample: 14/20 any associations, 14/20 with >=3 and >=10.
Episode coverage: 6/20 for all three thresholds. This supports a structural TV
association gap. No live source was re-run, no provider work, no ranking change,
no backfill or enrichment pass was started. No release/build/tag work performed.

## Next active slice — corpus stale-ownership recovery (IN PROGRESS, uncommitted)

Busy markers (UPDATING/BOOTSTRAPPING) carry a heartbeat (updated_at,
refreshed by progress writes + new heartbeats in the update loop and
around the attribute pass). Shared recoverStaleCorpusState used by the
tick, isCorpusBusy, and boot: frozen >60min (env override) converges
to usable/usable-partial/absent without touching ingested work; fresh
markers pass through. Boot logs "Recovered stale corpus lifecycle
state (was X, heartbeat Nm old)". Live root cause: updateOnce writes
UPDATING then does unbounded work (fragment loop had no heartbeat);
a kill in the window froze it (live: 29.6h). Crash-proven on scratch
copies incl. SIGKILL mid-marker. No release until Patrick says so.

Surgical repair of provably-wrong associations (DELETE the mapping
row only; Releases/TFs/placements never touched). Shared matcher with
enrichment; R-episode structural + R-show for machine-tier rows under
published truth only; transliteration/alternates/orphans can only flag;
published bindings never deleted. Status at /api/operator/hygiene +
TUI line; repairs logged to a bounded ring. Live-proven on scratch
copies (poison repaired, guard flagged, packs/orphans spared). The
first live tick exposed two over-firing bugs (since fixed): absent
candidate evidence repaired, and path-like reference titles. Pristine
historical scan (84 published medias, ~825 associations, 907ms):
795 ok, 0 repair, 30 flagged — flags are exactly the right shapes
(Polish Biuro, Spanish Gone-With-The-Wind, 500-film collections,
filename-only rows). No release until Patrick says so.

### Landed just before: idle enrichment worker

One bounded live-discovery query per quiet hour through the normal
pipeline seams (ingest/associate/attributes); never acquisition.
Priority: future intents → recent requests → thin/below-terminal/sparse.
Gates: downloads, human requests (background sources excluded),
loop lag, worker hints, corpus state. Hygiene: episode-exact + title
agreement (published truth > consensus > substantial resolved title).
Backoff per source, daily cap, zero-yield rotation, no durable queue.
Status at /api/operator/enrichment + TUI diagnostics. Live-proven on
scratch copies (true positives learned, wrong-show rows refused).
No release until Patrick says so.

Browser proven with real Firefox screenshots (1440/1024/390): dominant
state never contradicts health; first-run names exact missing keys;
Activity/Library/Downloads read like a product; providers/settings hide
raw tokens and state names. TUI toured over pty (all screens + probes).
No release until Patrick says so.

Browser = household appliance (7 small tabs, first-run state, no admin
controls, no raw dumps); terminal (`npm run tui`) = control room (live
overview, identity/placement detail, logs via host docker CLI, read-only
probes). Shared operator API; diagnostics probes cached 60s so neither
interface creates provider traffic. Proven on scratch DB copies + empty
boot; TUI toured over pty. No release until Patrick says so.

Operator workbench replaced with a 7-tab appliance surface (Overview,
Activity, Library, Downloads, Providers, Diagnostics, Settings) on a
small read-mostly operator API (`/api/operator/activity|downloads|
quality`, `POST /api/library/profile`, failure headlines shared with a
future TUI). Manual-maintenance controls removed; first-run state when
no provider is configured; diagnostics probes cached 60s so UI polling
never becomes provider traffic. Proven on a scratch copy of production
state + empty-state boot. Production still serves the old workbench
until the next image build — re-pin then.

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

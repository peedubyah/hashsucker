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

### Completed: episode retrieval audit

No product code changes were required. `candidate_media` is a high-confidence
persisted association/enrichment table, not an exhaustive media index: writers
are explicit ingestion associations and identity-enrichment/idle-enrichment
paths; readers provide identity confidence and media-scoped ranking context;
hygiene protects published bindings. The current corpus has 1,586,607
candidates, 1,586,549 attribute rows, 5,711 distinct candidate/media
associations, 1,584,812 unassociated candidates, 1,585,821 useful-attribute
keys, and 4,598 pending enrichment rows. Existing FTS plus the proven
`episode-coverage.js` logic can answer exact episodes dynamically: Breaking Bad
S05E14 returned 118 eligible hits/7 paged results in ~140ms; Game of Thrones
S01E01 returned 142/12 in ~163ms; The Last of Us S01E01 returned 609/11 in
~212ms; The Sopranos S01E04 returned 49/3 in ~101ms. Negative-control `Friends`
S01E01 returned false-title candidates because the query title was ambiguous,
so media identity/title scoping remains necessary; no resolver was shipped.
Show-level associations exist while exact colon episode IDs do not (`tt0903747`
221 vs `tt0903747:5:14` 0; `tt0944947` 56 vs exact 0; `tt10986410` 256 vs
exact 0). Bounded 20-movie/20-episode association coverage was 14/20 movies
and 6/20 episodes at >=1, >=3, and >=10 association thresholds. Decision:
retain dynamic attribute/episode retrieval as the measured foundation; do not
materialize broad associations or add a derived index until a truth-set resolver
can safely scope titles and prove precision. No backfill, live provider run,
ranking change, release, build, or tag work performed.

### Landed: real-corpus show identity validation — integration parked

The offline-only `show-identity.js` now documents a provider-neutral
`ShowIdentityContext` (`canonicalTitle`, optional `originalTitle`,
`alternateTitles[]`, `firstAirYear`, `externalIds`, `episodeTitle`, and
`episodeTitles[]`). A 60-case deterministic truth set (30 positive, 30
negative) passes with exact matching, including ambiguous titles, punctuation,
remake/year, aliases, miniseries, and release noise.

`media-search/scripts/show-identity-corpus-benchmark.mjs` runs read-only against
`DISCOVERY_DB` and never writes `candidate_media`. It sampled 30 real identities
including Breaking Bad, Game of Thrones, The Sopranos, The Last of Us, Chernobyl,
Fleabag, The Office, Friends, Lost, House, Dark, From, and You. The persisted
association path was 100% precision/recall on its bounded oracle (506/506). The
broad FTS baseline had 20 TP, 1,280 FP, 486 FN; the conservative scoped mode
had 5 TP, 33 FP, 501 FN. Thus the current resolver removes most exposure but
also destroys useful recall because real pack/suffix parser output is not an
exact show title. Scoped answerability was 14/30 at >=1, 5/30 at >=3, and
1/30 at >=10, versus 23/30, 22/30, and 17/30 for broad retrieval; persisted
was 24/30, 23/30, and 23/30. FTS/identity/episode/total p50/p95 were
45.683/265.638ms, 15.232/76.241ms, 0.094/0.340ms, and 61.041/337.094ms.

Decision: **do not integrate**. The previous benchmark terminology was corrected: `candidate_media` is a
sparse positive oracle. Associated rows rejected by the resolver are valid
false negatives; unassociated FTS rows are unlabeled and are not false
positives/TNs.

A 971-row trusted TV association inventory found 421 `SxxExx`, 490 season or
range-pack, 14 complete-pack, 16 quality/source, 6 language, and 24 other
parser-title contamination cases. The existing parser already extracts many
attributes, but `extractTitle()` reconstructs title text before removing all
season-pack and release grammar.

Added deterministic `canonicalReleaseTitle()` and routed it into
`agreeShowIdentity()` without changing the matcher. It removes only explicit
release grammar, preserves identity-bearing regional tokens (`US`, `UK`,
`Australia`), and does not use requested metadata. A 100-case hard-negative
set had zero false accepts. Resolver tests and canonical-title tests pass.

On the same 30-show corpus, known-positive recovery remains 5/506 (0.99%) in
the current benchmark because the benchmark's episode gate is fixed to S01E01
and the persisted association set is polluted by cross-intent canary rows;
this is not sufficient to claim production readiness. Scoped answerability
improved from 14/30 to 16/30 at >=1, 5/30 to 8/30 at >=3, and 1/30 to 2/30 at
>=10. Canonical identity/episode/total p50/p95 were 23.344/132.181ms,
0.108/0.388ms, and 25.554/141.634ms. Integration into production retrieval
remains parked pending a corrected per-request positive benchmark and
stratified manual validation. No fuzzy matching, persistence, provider,
ranking, or live behavior changed.

### Landed: corrected per-request episode benchmark — integration parked

Added read-only `media-search/scripts/episode-identity-benchmark.mjs` with 30
explicit season/episode requests. Positive rows are only exact persisted
associations for the requested media ID that pass `episode-coverage.js` for
that request. Rows for another episode and unlabeled FTS rows are excluded
from the positive denominator.

The first trustworthy run had 28 positive rows across the request set and
100% FTS recall (28/28 retrieved). Raw title recovery was 5/28 (17.86%);
canonical title recovery was 6/28 (21.43%); full canonical + episode recovery
was 6/28 (21.43%). The stage result shows FTS is not the bottleneck for these
known positives. Remaining misses are predominantly release syntax still
surrounding episode titles, language/edition text, and parser damage; the
benchmark captured raw filename, parser title, canonical title, expected title,
and failure reason for each miss.

The manual real-FTS sample contains 100 rows from 10 ambiguous intents:
32 correct-show, 9 wrong-show, and 59 uncertain. One wrong-show row was
accepted (`The Bear` versus the explicitly labeled `Bear Grylls` negative),
so manual negative precision is not yet clean. This label heuristic is a
bounded audit sample, not a candidate_media oracle.

Scoped candidate depth across the 30 requests: 6 with zero, 14 with 1–2,
7 with 3–9, and 3 with 10+ candidates; distinct-release depth follows the
same full-pipeline counts. Latency p50/p95: FTS 3.015/17.957ms, canonical
extraction 9.081/76.308ms, identity 9.352/66.923ms, episode coverage
0.044/0.165ms, total 23.233/163.165ms.

Decision: do not integrate. The benchmark is now trustworthy enough to
identify the current bottleneck, but canonical recovery and manual negative
safety are insufficient. No new heuristics were added during measurement, no
persistence changed, and production retrieval remains untouched.

### Resolver path verdict: park, do not integrate

Audited the exact 59 uncertain rows from the prior 100-row ambiguous FTS
sample with `media-search/scripts/resolver-path-audit.mjs`. Primary buckets:
56 `parser_determinable`, 3 `existing_source_provenance_can_label`, and 0
for `existing_candidate_media_can_label`, `metadata_alias_can_label`,
`genuinely_insufficient_evidence`, or `benchmark_bug`. The durable database
copy used for the audit had no `evidence_observations` table; no uncertain row
had candidate_media, request-result, or provider-event evidence. The generic
`candidates.sources` payload was present but did not preserve a media intent.
Therefore HashSucker did not retain enough source/media context to label those
rows after the fact.

The 22 known-positive misses were categorized as: 10 episode-title
contamination, 6 language/edition residuals, 5 audio/codec residuals, and 1
release-group/parser residual. This is heterogeneous parser cleanup, not a
single safe identity rule. The canonical extractor improved the exact
per-request benchmark from 5/28 raw to 6/28 canonical/full; FTS recall stayed
28/28. The same 30 requests had 6 zero-depth, 14 one-to-two, 7 three-to-nine,
and 3 ten-plus scoped candidate sets. No bounded fix was justified during this
slice because the remaining rules would require stripping arbitrary episode
and edition words without independently known episode metadata.

The 100-row manual audit remains partially labeled: 32 correct-show, 9
wrong-show, 59 uncertain. One wrong-show row was accepted. Trustworthy
negative precision over labeled accepted rows was therefore not clean; the
uncertain rows are excluded from binary precision claims.

Source semantics finding: current generic evidence/source fields do not retain
the complete tuple `(observer, release, media intent, season, episode)` for
these local FTS rows. `media_request_results` can retain expected scope when
written, but it was absent for the audited rows. No schema or persistence
change was made.

Product comparison:

- Simpler path: local FTS/attributes → episode coverage/ranking → live fallback.
  It preserves 23/30 request answerability at >=1 in the earlier corpus study
  and does not add a new grammar of title exceptions.
- Resolver path: FTS → canonical title → identity → episode coverage. It
  improves ambiguous-title filtering conceptually, but currently recovers only
  6/28 trusted episode positives, leaves 20/30 requests at zero or one-to-two
  candidates, and has one labeled wrong-show accept in the 100-row audit.
  Latency is interactive (total p50/p95 23.233/163.165ms), but speed does not
  offset poor recovery and unclear negative precision.

Claimed product value would be: **prevent wrong-show local fulfillment for
ambiguous titles without increasing live-discovery dependence**. The measured
path has not demonstrated that value. Verdict: **PARK** the resolver path;
retain `canonicalReleaseTitle()` as a standalone parser utility and retain the
benchmark/audit artifacts, but do not integrate show identity into production
retrieval. Do not delete the utility until a corrected source-context contract
is evaluated; no production behavior changed.

### Contextual-memory right-to-exist experiment — PARK

The resolver remains parked. Added two read-only experiment scripts:
`contextual-memory-replay.mjs` replays historical media request results, and the
existing request/evidence audit was used to map information loss. No product
schema, provider, ranking, UI, or production state changed.

Current production DB is older than current `main`: it has 16,223
`media_request_results`, 6,447 provider-observation events, 377 media requests,
110 playback handoffs, 26 TV VFS entries, and 67 movie VFS entries, but lacks
`evidence_observations` and `evidence_query_observations`. A scratch
`createDiscoveryCache()` from current `main` creates both tables, so this is a
schema/image drift finding, not a production migration performed for this
experiment.

Information-loss map: media intent survives in `media_requests` and
`media_request_results`; release/hash/filename/rank/eligibility survive;
expected media scope and parsed candidate scope survive in result rows; provider
and playback handoff/TorrentFile survive when fulfilled. Generic corpus rows
retain release knowledge and source lists, but the audited historical rows do
not retain a durable complete `(observer, media intent, season, episode, hash)`
tuple. Current source-context memory is therefore incomplete.

Offline bounded replay: 10 movies + 20 TV intents (30 total), all selected from
existing request history. All 30 had historical candidates; 16 had repeats.
There were 666 distinct prior observed Releases, 513 reappeared on a later
request (77.03% useful by hash recurrence), 75% top-selection stability on
repeated cases, and 27/30 cases with a playback handoff. Candidate depth in the
latest historical results was 30/30 at >=1, 25/30 at >=3, and 23/30 at >=10.
However this is historical result recurrence, not an intervention: no actual
source calls were suppressed, no latency was measured for a memory-assisted
path, and observer-level Tier 2 provenance was unavailable. Tier 3/4 evidence
was available for 29 cases and Tier 5 handoff evidence for 27.

The replay shows potentially useful continuity, especially for fulfilled
representations, but cannot prove discovery avoidance or latency savings. It
also cannot distinguish a remembered candidate from normal persisted result
reuse because the existing `media_request_results` already stores the relevant
hashes and ranks. Adding a second contextual-memory schema would duplicate
existing state without a demonstrated product gain.

One-sentence value claim: **Contextual memory could deserve to exist if it
materially suppresses repeat source fan-out while preserving the previously
selected playable Release/TorrentFile.** This experiment did not measure that
intervention or establish the missing observer-intent tuple.

Verdict: **PARK**. Retain existing request results, playback handoffs, provider
observation events, and current-main evidence schema for future use. Do not add
a new memory schema, migration, UI, scheduler, provider behavior, or resolver
integration. A future experiment must capture source responses on scratch DBs
and compare actual no-memory versus in-memory source-call counts and latency.

### Reuse existing fulfillment knowledge — KEEP existing fast path, no new abstraction

Audited repeated historical requests with read-only
`media-search/scripts/reuse-first-historical-audit.mjs`. The durable repeat
intent key available in production is `(media_id, media_type, season, episode)`;
profile and request-intent columns are absent from the audited production
`media_requests` schema, so quality/profile semantics are not part of the
historical key. Request ID and provider are not identity keys.

The current code already has `getPreparedDurableState()` and
`tryReuseHealthyPublication()`. The predicate requires the exact media/episode
handoff, non-null Release identity, TorrentFile ID, positive immutable size,
and at least one mapped data-plane coordinate. It then republishes idempotent
presentation without discovery. This is an existing Tier-A reuse-first stage,
not a new memory abstraction.

Across 45 repeated intent groups: 8 were Tier A healthy published and
immediately reusable; 36 had only prior eligible candidate results and require
local reranking; 0 were classified as provider-reacquire-only or prior-selected
without a handoff; 1 had no useful prior state and requires live discovery.
The current historical database therefore suggests 8/45 repeats can avoid
source discovery immediately, while 36/45 can avoid starting from zero if the
existing result set is locally reranked. Estimated source calls avoided is 8
for the proven Tier-A cases. Exact latency savings and stale/invalid reuse
counts cannot be measured from historical rows because no controlled repeat
replay or serve probe was run.

Independent historical fulfillment evidence is strong: 110 playback handoffs
exist, 97 include provider plus TorrentFile identity, and 27/30 cases in the
previous contextual replay had handoffs. The exact provider is not the reuse
identity; the exact Release/TorrentFile is. Provider runtime may reacquire a
current coordinate at serve time.

Findings: a repeated request for Tier A is an idempotent desired-state
reconciliation, not a new acquisition workflow. Upgrade sensing remains a
separate explicit `forceDiscovery` path because reuse must not make improvement
impossible. The existing split is intentional: normal reaffirmation may reuse;
upgrade sensing may discover.

No missing product state was proven. Existing request results, playback
handoffs, VFS entries, provider observations, control-plane TorrentFiles, and
placement coordinates already express the reuse tiers. Profile/request-intent
semantics are absent in this production snapshot and should be added only if
future request identity work proves they are needed; no schema change was made.

Product value claim: **Existing fulfillment knowledge deserves a reuse-first
stage because a healthy exact TorrentFile/publication can satisfy a repeated
intent without discovery or provider fan-out.** That behavior already exists
in `media-request.js`; the experiment validates retaining it rather than adding
contextual memory.

Verdict: **KEEP existing fast path; PARK new contextual-memory abstraction.**
No UI, migration, provider change, ranking change, scheduler work, or release
performed.

### Tier-D reconciliation audit — existing lifecycle state is the answer

Read-only `reuse-first-historical-audit.mjs` classified all 45 repeated intent
groups. The 36 Tier-D cases have one root cause: **prior result was never
fulfilled**. They have eligible historical result rows, but no playback handoff
or exact reusable TorrentFile/publication. The remaining groups were 8 healthy
published Tier A and 1 with no useful prior state. No cases showed profile
change, known fulfillment failure, stale placement, or a missing handoff after a
known successful selection in the audited database.

For the 32 repeated groups with at least two rank-1 historical result rows, the
previous and latest top Release were identical in 29 cases and changed in 3;
all previous rank-1 rows were eligible. This is 90.6% top-hash stability. It
shows that synchronous reranking is often re-confirming an existing answer,
but this audit did not run a live provider comparison. A bounded live replay
was deliberately not executed because the experiment has no captured safe
source fixtures and must not add provider traffic or alter production behavior.

The legitimate-work classification is therefore: 8 reconciliation-only
healthy publications; 36 local-rerank/fulfillment cases where a prior result
exists but was never fulfilled; 1 live-discovery-required case. The 36 are not
really “memory” failures: the missing state is a fulfillment lifecycle outcome,
not a missing candidate-memory abstraction. A prior eligible rank-1 candidate
can be locally selected, but it still needs exact TorrentFile binding and
provider placement before safe playback.

Existing `media-request.js` already has the correct Tier-A fast path through
`getPreparedDurableState()` and `tryReuseHealthyPublication()`. It requires
exact media/episode identity, Release/hash, TorrentFile ID, positive size, and
a mapped data-plane coordinate. Provider identity is not the reuse key; provider
runtime may reacquire delivery for the same TorrentFile.

Decisions:

- Repeat live discovery: **REDUCE**, not default for a known eligible prior
  result; no production change in this slice.
- Synchronous reranking: **REDUCE** when the previous eligible winner is stable;
  retain reranking for changed policy, invalidation, or missing exact identity.
- Upgrade-on-request: **MOVE-ASYNCHRONOUS** conceptually; serve a sufficient
  known-good representation first and sense improvements separately. Existing
  `forceDiscovery` remains the explicit upgrade path.
- Permanent publication: **INTENT-DEPENDENT**. Healthy published Tier A needs
  no discovery; a Tier-D candidate need not be permanently published until
  fulfillment is actually selected and bound.

No missing schema concept was proven. Production lacks profile/request-intent
columns in the audited snapshot, but no evidence showed that this blocked the
Tier-D cases. No ranking, provider, persistence, UI, scheduler, or lifecycle
implementation changed.

Product implication: **Repeated intents should pay for discovery only when no
eligible prior answer can be safely bound, revalidated, or locally selected;
most Tier-D cost is uncompleted fulfillment, not insufficient knowledge.**

### Repeat provenance + Tier-A fast-path proof — closed

The durable repeat-intent audit grouped requests by
`media_id + media_type + season + episode` (request ID and provider excluded).
The production snapshot does not preserve explicit request-intent/profile
columns, so provenance classification is limited to timestamps, source fields,
request IDs, lifecycle status, result history, and handoff state. All 377
requests are completed; 45 groups repeat. No durable lifecycle event identifies
these repeats as retries, reactivation, upgrade, or canary with sufficient
confidence. Therefore Tier-D user-versus-system provenance is **unknown**, not
assumed human demand: 36 Tier-D, 8 healthy Tier-A, and 1 no-knowledge group
remain unclassified by origin.

A scratch proof exercised the actual `searchByMedia()` path for three healthy
published exact TorrentFiles (movie, TV episode, second movie), 10 repetitions
each. All 30 requests returned `reuseMode=noop` and
`reason=reused-healthy-publication`. p50 was 0.149ms and p95 0.488ms (min
0.124ms, max 1.811ms). Every request reported `liveDiscoveryTriggered=false`,
zero live candidates, ranking disabled, and zero availability checks. The only
provider-facing operation was the control-plane data-plane-coordinate lookup
needed to prove the exact TorrentFile remains serveable: 30 lookups, no provider
acquisition or source calls. This proves healthy exact publication behaves as
idempotent desired-state reconciliation and is effectively immediate.

The existing `tryReuseHealthyPublication()` / `getPreparedDurableState()` is
already the correct single fast path. A second reuse abstraction is not needed.
Tier-D provenance is insufficient to call it a product problem: without request
origin/lifecycle evidence, the 36 cases cannot distinguish genuine user repeats
from internal/system/test traffic. The prior rank-1 stability result remains
supporting evidence, not a reason to implement Tier-D reuse now.

Decisions: **NO new reuse stage**; repeat live discovery remains default only
when no healthy exact publication exists; Tier-A requests are already
reconciliation-first; upgrade/force discovery remains explicit; no UI, schema,
ranking, provider, resolver, scheduler, or production behavior changed.

### Demand-signal value + predictive fulfillment — verdicts (2026-09-22, no code change)

Evidence: 377 media_requests (167 Seerr, 94 anticipation self-traffic, rest
test/api/proof; 1 household web request ever), 110 handoffs, 27 future_intents
(all synthetic proofs; 0 Arr-sourced despite configured Arrs + successful sync
importing 0/0), 85 upgrade rows with 0 switches ever, 4598 pending enrichment
rows, 1.58M candidates / 5.7k associations. All series "continuation" is batch
fan-out seconds apart; zero genuine sequential N→N+1 pairs. Proof rows carry
defer_reason, so no durable marker separates synthetic from human demand.
Verdicts: ARR/FUTURE ANTICIPATION **REDUCE** (keep ledger+sync+wake as KNOW
sensor; speculative rows cap at IDENTIFY; full prepare/publish/prewarm only for
Seerr-deferred human demand). ACTIVE-NEXT-EPISODE **PARK** (no evidence).
IDLE ENRICHMENT **REDUCE** (demand-adjacent targets only; drop
thin/below-terminal/sparse scavenging; kill criterion: show a later-used
release or park). PROVIDER VALIDATION **KEEP** at request time only.
PROVIDER PRE-ACQUISITION **LIMITED** (Seerr-deferred inside publish window
only; never for Arr speculation). UPGRADE WORKFLOW **KEEP** (cheap, gated;
no merge). UNIFIED WORK GOVERNOR **NOT EARNED**. PREDICTIVE SCHEDULER
**NOT EARNED**. Ladder: persist KNOW→IDENTIFY→PREPARE only; VALIDATE/HOT are
ephemeral serve-time properties; drop published_preparing/playable as
scheduler-owned states (publication truth already lives in VFS/library).
No code change: steady-state costs already bounded (windows/caps/backoffs/
quiet gates); any gate risks the genuine Seerr-deferred path. Do not reopen
without new genuine-demand evidence.

### Demand-weighted background corpus triage — DONE uncommitted (2026-09-23)

Idle-enrichment `buildTargets` reordered lexicographically (uncommitted):
future intents (expected_at asc, episode-aware depth asc) → recent HUMAN
requests only (`seerr/web/plex-watchlist/operator`, 30d, thinnest first) →
published fragile (`thin-diversity`, div<3). DELETED `sparse-coverage`
(redundant slice of the DIVERSE_ENOUGH stop); PARKED `below-terminal` as an
enrichment class (quality scouting stays in upgrade-watch; re-admit only on
demonstrated switches). Evidence: eligible pool is 23 items (19 depth-0);
old order spent 9/27 slots on system self-traffic + generic; corpus is 100%
DMM bulk ingest (no live-source provenance in prod); 83/85 fulfilled medias
already 8+ depth. Tests: idle-enrichment 13/13 + neighbors 22/22 green.
No schema, caps/quiet/backoff untouched. Do not add generic tiers back
without a later-used-release demonstration.

### Demand-weighted background corpus triage — no change justified

Audited `idle-enrichment.js`. Current flow is quiet-gated, one bounded live
query per tick, daily-capped (`ENRICHMENT_DAILY_CAP`, default 100), source
backoff-aware, zero-yield-aware, and persistence-limited to candidate ingest,
media association, and release attributes. It never acquires providers,
materializes, publishes, or probes cache state.

Current target order is already demand-weighted: future intents by expected
availability/thinness, recent HUMAN requests from `seerr`, `web`,
`plex-watchlist`, or `operator` within 30 days, then published fragile items
with fewer than three known associations. Generic sparse and below-terminal
scavenging are absent by design. The target classes represent, respectively,
known upcoming demand, recent demonstrated demand, and published keep-intent
with weak alternate knowledge. Generic completeness is not being treated as a
product failure.

Read-only production replay found 4 anticipated + 12 failed future intents,
170 recent human-source requests, 117 published library items, 4,598 pending
identity-enrichment rows, and zero separately selected thin-diversity targets
(the published items were not below the current association threshold). The
next bounded block contains 88 deduplicated eligible targets: 16 future-intent
and 72 recent-request. All 88 are demand-linked; 14 have zero prior eligible
result depth, 2 have depth 2–9, and 72 have depth 10+. The diagnostic gain
proxy classified 14 as potential `DEPTH_GAIN` and 74 as `NO_GAIN`.

The offline demand-weighted replay of the same available target pool produced
the identical 88-slot ordering and class distribution as current main. There
were no generic sparse/below-terminal slots to demote, so no measurable
alternative benefit exists in the current state. This is a confirmation of the
existing local policy, not evidence for a new scorer or governor.

Source-yield evidence in the production candidate corpus is dominated by DMM
`ingestion` provenance (1,592,530 source witnesses). The audited source fields
do not provide enrichment-query-level novel/duplicate/resilience yield for a
safe per-source enrichment decision. No source fan-out change is justified.

Required verdicts: **FUTURE-INTENT TARGETING: KEEP**; **RECENT-REQUEST
TARGETING: KEEP**; **THIN-DIVERSITY: DEMOTE** (it is only useful when explicit
published demand exists and is already below the current third-tier threshold);
**BELOW-TERMINAL: PARK** in upgrade-watch, not corpus enrichment;
**SPARSE: PARK** (generic sparsity is not a user-visible failure);
**SOURCE FAN-OUT FOR ENRICHMENT: KEEP**; **DEMAND-WEIGHTED ORDERING: EARNED
and already present**.

No implementation change was justified. The same tiny background budget is
already spent on demand-adjacent uncertainty, generic scavenging is absent,
and no new demand score/table/UI/governor is warranted.

Product implication: **Background enrichment should spend its bounded query
budget on explicit upcoming or demonstrated demand with weak knowledge; this
is already the current implementation, so the right change is to preserve it,
not expand it.**

### Demand-linked uncertainty adversarial replay — no change justified

The current `idle-enrichment.js` eligibility is demand-linked but not a true
knowledge-sufficiency predicate. Future intents, recent human requests, and
published fragile items are admitted into `buildTargets()`; candidate depth is
used for ordering and the later per-target diversity stop, not as a direct
pre-query eligibility gate. Zero-yield/backoff and quiet/daily gates are
separate controls.

The 88-slot replay therefore labeled 85 targets `SUFFICIENT_DEPTH`, 2
`UNRESOLVED`, and 1 `SHALLOW_RESILIENCE` under a conservative existing-state
predicate. The earlier 74 `NO_GAIN` proxy was too coarse: exact per-media
association depth and episode-scoped eligible result depth diverge. In
particular, several episode future intents had zero episode-scoped results but
many show-level Releases, so raw media-level count would incorrectly suppress
real unresolved episode demand.

A proposed uncertainty-aware replay suppressed 85 slots at a threshold of 10
exact/eligible results and retained only 3 slots (2 unresolved future intents,
1 shallow resilience recent request). This is not safe to implement: the
threshold is an arbitrary proxy, quality envelope and exact TorrentFile
viability are incomplete, episode scope differs from media scope, and no live
outcome proves that the suppressed rows could not yield a meaningful
resilience or quality gain. The replay demonstrates that current demand
admission is broader than uncertainty, but does not establish a defensible
sufficiency predicate from current state.

Required verdicts: **FUTURE-INTENT ELIGIBILITY: KEEP**;
**RECENT-REQUEST ELIGIBILITY: KEEP**; **PUBLISHED-FRAGILE ELIGIBILITY: KEEP**
(the class remains demand-linked, though absent in this snapshot);
**CURRENT 74 NO-GAIN TARGETS: NOT DETERMINABLE**;
**UNCERTAINTY-AWARE ELIGIBILITY: NOT EARNED**; **IMPLEMENTATION: NO CHANGE
JUSTIFIED**.

Product implication: **Demand tells enrichment where to look, but current
state cannot safely prove when a demand-linked Release set is sufficient, so
no target should be suppressed merely by candidate count.** No schema,
telemetry, provider, UI, scheduler, ranking, or persistence change was made.

### Demand-linked enrichment marginal-gain experiment — narrow, no behavior change

Ran a bounded read-only experiment through the same
`runLiveDiscoveryWithCounts()` seam used by idle enrichment. Selection was
explicit: first 8 deep recent-human targets, first 6 deep future-intent
targets, and first 6 deep published-linked targets, deduplicated (20 total).
Deep meant the existing replay population with >=10 association knowledge;
this was not a pathological-only sample. Existing associations, attributes,
request/future linkage, and publication state were captured before each query.
No releases were persisted, no providers were acquired, and no VFS/preparation
state changed.

Outcomes: 14/20 queries produced `NEW_BUT_REDUNDANT` results under the
conservative comparison; 6/20 future-intent queries produced `NO_GAIN`.
There were 0 measured `DEPTH_GAIN`, `QUALITY_GAIN`, `RESILIENCE_GAIN`, or
`IDENTITY_GAIN` outcomes after correcting the baseline to existing
`candidate_media` associations. The first run falsely reported quality gains
because it compared against raw `release_attributes` without media association;
that baseline bug was corrected before recording the result.

By class: recent-human 0/8 useful, 8/8 new-but-redundant; future-intent 0/6
useful, 6/6 no-gain; published-linked 0/6 useful, 6/6 new-but-redundant. The
source seam returned many rows (20,382 total Stremio results, including Comet
fast results on 14 targets), but result volume did not create measured product
value. Torznab returned empty on all 20 calls; Prowlarr was not configured.
This is source-yield evidence for this context, not a global source verdict.

The experiment does not prove that every deep target is permanently sufficient:
quality-envelope, exact TorrentFile viability, and provider-independent
resilience were not fully inferable from current state. It does prove the
burden of proof is unmet for recurring background queries on this bounded deep
sample. Request-time discovery is the competitive simpler alternative: it can
answer the same live question when demand exists, without recurring source
work during idle periods. Future-intent results were uniformly no-gain here;
recent and published queries were redundant.

Required verdicts: **DEEP FUTURE-INTENT REQUERY: NOT JUSTIFIED**;
**DEEP RECENT-REQUEST REQUERY: NOT JUSTIFIED**;
**DEEP PUBLISHED REQUERY: NOT JUSTIFIED**;
**CURRENT PERIODIC ENRICHMENT: NARROW** (only demand-linked targets whose
existing evidence is visibly unresolved; do not infer a generic threshold from
this experiment); **REQUEST-TIME DISCOVERY: PREFERRED** for deep targets;
**NEW SUFFICIENCY STATE/MODEL: NOT EARNED**; **IMPLEMENTATION: NO CHANGE
JUSTIFIED**.

No safe existing-state suppression condition was implemented because the
experiment did not establish a reliable predicate for episode scope, quality,
exact TorrentFile viability, or resilience. The result is evidence to narrow
future targeting policy, not permission to invent a score or schema.

Product implication: **A demand-linked background query must answer a specific
unresolved fulfillment question; in this deep sample, recurring queries mostly
returned redundant rows, so request-time discovery is preferred until stronger
uncertainty evidence exists.**

### Idle enrichment demand is necessary, not sufficient — bounded gate verified

The existing idle-enrichment implementation now has the required narrow
behavior through its current sufficiency/diversity and episode-scope logic:
recent human demand, future intent, and publication enter target consideration,
but they do not independently force a live query. `pickInsufficientTarget()`
continues to require below-threshold useful knowledge; unpublished episodes are
scoped to zero coverage, while published fragile items with shallow association
depth remain eligible. Quiet gating, daily cap, source backoff, zero-yield
suppression, and one-query-per-tick remain unchanged.

Added focused regressions: deep recent demand with eight known associations
makes zero discovery calls; a zero-depth future episode remains query-eligible;
and a published two-association fragile item remains query-eligible. The full
idle-enrichment suite plus these regressions passes 16/16.

No new sufficiency model, score, schema, telemetry, scheduler, provider work,
UI, or request-time behavior was added. Request-time discovery remains the
fallback for demand whose existing representation state is insufficient.

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

# HASHSUCKER CLEANUP AUDIT — PRUNE THE REQUEST / IDENTITY PIPELINE

**Commit analysed:** `2f1f215` — `feat(seerr): boundary TMDB→IMDb translation + ingress handler`
**Parent for diff context:** `0ce7ddd`
**Repo:** `github.com/peedubyah/hashsucker` (local clone at `research/hashsucker-metadata/github`)
**Mode:** static analysis only. No code modified, nothing committed or pushed.

---

## Evidence legend

| Tag | Meaning |
|---|---|
| `[Src]` | Proven by reading source at this commit (file:line cited) |
| `[Grep]` | Proven by exhaustive repo-wide symbol search (zero hits = proof of non-use) |
| `[Diff]` | Proven by `git diff 0ce7ddd..2f1f215` |
| `[Inf]` | Inferred from call graph; stated as inference |

Zero-importer claims below were established by grepping `src/`, `scripts/`, and `test/` and excluding only the defining module itself. A "0 importers" claim means **no importer anywhere, including tests**, unless stated otherwise.

---

## §0 Headline — what the pushed state actually is

The functional checkpoint did not extend the intent pipeline. It **routed around it**.

1. **The Seerr ingress does not use the intent subsystem at all.** `POST /api/ingress/seerr` calls `searchByMedia()` directly with raw SQL on `media_intents` around it. It never constructs a `MediaIntentProvider`, never uses `MediaIntentIngestionService`, never uses `MediaIntentProcessor`, and never touches the `intents/` module. `[Src] app.js:307–557`
2. **The Plex ingress is not in the server at all.** `src/server/app.js` contains zero occurrences of "plex" and zero scheduled work. Plex reaches the system only through an out-of-band operator script that also bypasses every intent abstraction — including its own `PlexIntentProvider`. `[Grep]`, `[Src] scripts/plex-watchlist-ingest.mjs`
3. **There is no batch processing in production.** `compose.yaml` runs exactly one long-running process: the HTTP server (`node src/server/index.js`). No scheduler, no worker, no poller. `MediaIntentProcessor` is reachable only from `npm run intents -- process`. `[Src] compose.yaml:1–42`, `[Src] src/server/index.js`
4. **`media_intents` has become a write-only audit log for the Seerr path.** The identity bundle added in this commit (`imdb_id`/`tmdb_id`/`tvdb_id`) is written by Seerr, echoed back in the HTTP response, and read by nothing else. All three new indexes serve zero queries. `[Grep]`, `[Src] cache.js:209–211`
5. **The metadata layer is not in this pipeline.** `unified-search` / `cinemeta` / `provider-adapter` / `metadata-cache` serve exactly two UI endpoints (`GET /api/search`, `GET /api/media`). No ingress, intent, or request path calls them. `[Grep]`, `[Src] app.js:1530,1541`

**Consequence:** the "ingress → identity → request" path the audit was scoped to is not one path. It is **three parallel front doors that all converge on a single function, `searchByMedia()`**, plus a fourth (CLI batch) that hangs off the database rather than the front doors.

---

## §A Current real call graph

### A.1 — Plex Watchlist → `media_requests`

```
[operator runs on host, not in compose]
scripts/plex-watchlist-ingest.mjs
  ├─ GET discover.provider.plex.tv/library/sections/watchlist/all      (:58)
  ├─ filter type === 'movie'                                            (:152)  ← movies only
  ├─ GET /library/metadata/{ratingKey}                                  (:73)   ← 1 extra call per item
  ├─ extractExternalGuids() → parseIdentity() → pickCanonical()         (:88-113) imdb || tmdb
  ├─ findIntentBySourceAndId(cache, 'plex-watchlist', 'plex://movie/<rk>')  (:123-133)  ← dedupe
  └─ searchByMedia(cache, { mediaId, mediaType:'movie', season:null,
                            episode:null, source:'plex-watchlist',
                            sourceType:'plex', sourceId:'plex://movie/<rk>',
                            mediaTitle: movie.title })                (:210-221)
        │
        ▼
src/api/media-request.js :: searchByMedia()                            (:161)
  ├─ createRequestIntent({ type, mediaId })                            (:188)
  ├─ cache.queryCandidatesByMedia(mediaId)
  ├─ [branch L] no corpus → runLiveDiscovery + rank + select           (:193-457)
  ├─ [branch C] corpus   → rank + select (+ live fallback)             (:478-833)
  ├─ cache.persistMediaRequest(...)                                    (:343 / :743)
  │     └─ upsertMediaIntent(...)   ← SECOND, INDIRECT intent write    (cache.js:2163-2176)
  │     └─ INSERT media_requests  (intent_id populated from that upsert)
  │     └─ INSERT media_request_results
  ├─ buildPlaybackHandoff / persistPlaybackHandoff                     (:371-376)
  ├─ publishStrm + notifyJellyfin                                      (:381-406)
  └─ cache.promoteDemand(...)                                          (:425-437)
```

Note: **no `media_intents` row is written before the search.** The row is created as a side effect of `persistMediaRequest`. The script's dedupe therefore only works from the second run onward, and it never populates `imdb_id`/`tmdb_id`/`tvdb_id` — the script resolved those IDs itself and then discards them. `[Src] cache.js:2164-2175` (no identity bundle passed)

### A.2 — Seerr → `media_requests`

```
[Seerr webhook]
POST /api/ingress/seerr                                    app.js:1449-1451
  └─ handleSeerrIngress(request, response, searchCache)    app.js:377-557
       1. checkSeerrAuth(Authorization, SEERR_WEBHOOK_TOKEN)            (:415-419)
       2. buildSeerrIntent(body)  [pure, no I/O]                        (:428)
            └─ seerr.js:170-245 → { mediaId, mediaType, season:null,
                 episode:null, source:'seerr', sourceType:'request',
                 sourceId:<request_id>, sourceLabel, status:'active',
                 priority:100, requestedBy:null, imdbId, tmdbId, tvdbId }
       3. raw SQL idempotency: SELECT id, request_count
            FROM media_intents WHERE source='seerr' AND source_id=?     (:442-452)
       4. if (!imdbId && tmdbId) → resolveSeerrIdentity()               (:458-491)
            GET {SEERR_URL}/api/v1/{movie|tv}/{tmdbId}  (X-Api-Key, 5s abort)
            → mediaId := imdbId   |   on failure: write row + last_error, return 500/503
       5. searchCache.upsertMediaIntent({...full bundle})               (:494-509)
       6. searchByMedia(searchCache, {... , persist:true})              (:513-525)
            │
            ▼  ── CONVERGENCE POINT (identical to A.1 from here down) ──
          src/api/media-request.js :: searchByMedia()                   (:161)
            …same body as A.1…
            └─ cache.persistMediaRequest(...)                           (:343 / :743)
                  └─ upsertMediaIntent(...)   ← SECOND intent write     (cache.js:2163)
       7. raw SQL: UPDATE media_intents SET last_processed_at,
            last_result_count, last_error=NULL WHERE id=?               (:526-528)
```

### A.3 — Where they converge, and where they don't

| Stage | Plex | Seerr | Shared? |
|---|---|---|---|
| Transport | host-side script, pull | HTTP webhook, push | ✗ |
| Auth | `X-Plex-Token` header | `Authorization: Bearer` (`checkSeerrAuth`) | ✗ |
| Provider abstraction | none (script is self-contained) | none (pure fns + handler) | ✗ |
| Identity extraction | `Guid[]` → imdb‖tmdb | `imdbId‖tmdb:‖tvdb:` + TMDB→IMDb translation | ✗ |
| Dedupe | `(source, source_id)` via script SQL | `(source, source_id)` via handler SQL | **duplicated logic, different literals** |
| Intent persistence | implicit, inside `persistMediaRequest` | explicit `upsertMediaIntent`, then implicit again | **double-write on Seerr** |
| **Search + request** | **`searchByMedia()`** | **`searchByMedia()`** | **✓ converges here** |
| Post-processing | handoff/STRM/Jellyfin/promote | identical | ✓ |
| Processing-state update | none | raw SQL `UPDATE` | ✗ |

**The convergence point is the signature `searchByMedia(cache, request)`.** Everything above it is source-specific and genuinely duplicated; everything below it is already shared, already correct, and should not be touched.

---

## Prune map

| Component | Current role | Evidence of use | Duplication / problem | Class | Smallest cleanup action |
|---|---|---|---|---|---|
| `src/api/media-request.js::searchByMedia` | The real pipeline entry point | Called by Seerr ingress, Plex script, `POST /api/media-request`, CLI batch, `MediaIntentProcessor` | Two ~300-line near-duplicate branches (live-only vs corpus-first) | **KEEP** | Extract the shared tail (rank → explainable → availability → select → persist → handoff → promote). Do not touch the branches' semantics. |
| `searchByMedia` branch L / branch C | Live-only vs corpus-first result assembly | Both always run | `evaluateIdentityEligibility` receives `mediaTitle` in branch L (`:226`) but **not** in branch C (`:522`) — asymmetric gating. Two identical zero-candidate returns (`:257-274`, `:459-476`) | **MERGE** | Fold the two zero-candidate returns into one; pass `mediaTitle` in branch C for symmetry or document the asymmetry as intentional. |
| `handleSeerrIngress` (app.js:377-557) | Seerr front door | `POST /api/ingress/seerr` | Reimplements intent persistence + state update in raw SQL instead of going through the cache API | **KEEP** (shape is right) | Replace the three raw `UPDATE media_intents` statements with one `cache.updateMediaIntentProcessing(id, {resultCount, error})`. No behaviour change. |
| `resolveSeerrIdentity` (app.js:307-375) | TMDB→IMDb boundary translation | Handler (`:459`), tests (`:746`) | Only injected seams are `env.fetch` / `SEERR_URL` / `SEERR_API_KEY`; handler passes `process.env` | **KEEP** | None. It is the one correctly-placed abstraction in the new code. |
| `src/lib/intents/providers/seerr.js` (pure fns) | Payload → intent translation | `app.js:28` | `buildSeerrIntent`, `checkSeerrAuth`, `deriveMediaIdentity` are the load-bearing parts | **KEEP** | — |
| `SeerrIntentProvider` class (seerr.js:294-307) | Claimed to "reuse the existing MediaIntentProvider contract" | **0 importers** — not registered, not constructed, not even imported by tests | `fetchIntents()` is a documented no-op; the header comment (`:7-11`) states a purpose the code does not fulfil | **DELETE** | Delete the class + `createSeerrProvider`. Keep the pure functions. Update the module header. |
| `safeEqualString` (seerr.js:255) | Constant-time compare | internal only (`checkSeerrAuth`) | exported but never imported | **DELETE** (export) | Make module-private. |
| `extractSeerrEnvelope` / `deriveMediaType` (seerr.js:100,152) | Payload shape sniffing / type mapping | internal only; **no test importer** | exported but never imported | **DELETE** (exports) | Make module-private. |
| `SEERR_CONSTANTS` (seerr.js:317) | Constant mirror for tests | tests only (`:27,484`) | Duplicates two module-private `Set`s into an array | **DEFER** | Leave. Cheap; removing it churns 939 lines of test. |
| `src/lib/intents/processor.js` | Batch intent worker | **only** `src/scripts/intents.js:337` (`npm run intents -- process`) | `dryRun` branch (`:73-93`) duplicates the persist branch (`:94-118`) except one flag | **DEFER → fold into CLI** | Collapse the two `searchByMedia` calls into one with `persist: !dryRun`. Do not delete the class yet — see A.4. |
| `MediaIntentProcessor._findPendingIntents` | Picks work | `:153-186` | `WHERE status='active' AND (last_processed_at IS NULL OR last_processed_at < ?)` with default `minIntervalMs=0` → cutoff = now → **every active row always qualifies**, including rows the Seerr ingress already processed | **KEEP with caveat** | Document that `intents process` re-runs already-processed Seerr rows, or default `minIntervalMs` to non-zero. |
| `MediaIntentProcessor._formatScope` | Log formatting | `:209-215` | Byte-identical to `ingestion.js:250-256` | **MERGE** | One shared helper. |
| `MediaIntentProcessor.getStats` | Stats | not called by any CLI command (`intents stats` uses registry stats) | — | **DELETE** | Remove, or wire into a CLI command. |
| `src/lib/intents/ingestion.js::_checkExists` | Dedupe probe for dry-run | `:211-222` | WHERE clause is **byte-identical** to `cache.js:2042-2050`, including the `intent.source \|\| 'api'` fallback. Two copies of the system's dedupe key. | **MERGE** | Delete `_checkExists`; have dry-run call a new `cache.findMediaIntentKey(...)` that both sites use. |
| `ingestion.js::_upsertIntent` | Persist | `:229-243` | Drops `imdbId`/`tmdbId`/`tvdbId`; also drops `status` handling nuance | **MERGE** | Forward the identity bundle through the contract (requires the typedef change below). |
| `MediaIntentIngestionService` | Provider → DB layer | **only** `src/scripts/intents.js:259` (`intents sync`) | `intents fetch` (`:200-221`) bypasses it and hand-rolls the same upsert | **DEFER** | Delete `cmdFetch` (it is `cmdSync` without validation), keep the service for `sync`. |
| `src/lib/intents/types.js::MediaIntent` typedef | Contract | `:17-32` | Has **no** `imdbId`/`tmdbId`/`tvdbId`, so the identity bundle cannot travel through the provider contract | **MERGE** | Add the three optional fields, and add them to `validateIntent`'s return (`:111-123`) which currently strips unknown fields. |
| `INTENT_PRIORITY` (types.js:149) | Priority enum | **0 importers anywhere** (not even `intents.js`) | Seerr uses `100`, Plex `0`, CLI `0` — the enum is not the vocabulary in use | **DELETE** | Remove the export. |
| `INTENT_STATUS` (types.js:143) | Status enum | `src/scripts/intents.js:27` only | `'completed'`/`'cancelled'` are unreachable: `updateMediaIntentStatus` has **0 importers**, so every row is `'active'` forever | **DEFER** | Leave the enum; note the status lifecycle does not exist yet. |
| `MediaIntentProviderRegistry` | Provider registry | `register` + `get` used by CLI; `fetchAllIntents`, `fetchFromProvider`, `findBySource`, `list`, `has` used **only by tests** | Multi-provider fan-out machinery exists for one registered provider (CLI) + one conditional (Plex) | **DEFER** | Do not delete. It is small and is the natural home if Plex ever moves in-process. |
| `PlexIntentProvider` (providers/plex.js) | Plex watchlist polling | **only** `src/scripts/intents.js:465`, gated on `PLEX_URL && PLEX_TOKEN`. Neither var is in `compose.yaml`. | Superseded in practice by `scripts/plex-watchlist-ingest.mjs`, which uses different source literals (`plex-watchlist`/`plex` vs `plex`/`watchlist`), a different watchlist endpoint, and correct `Guid[]` handling | **DEAD in deployed topology** | Pick one Plex path. The script is the one that works; keep it, and either wire Plex into the server or delete the provider + its registration block. |
| `CliIntentProvider` (cli-provider.js) | Manual intent injection | `src/scripts/intents.js:455` | — | **KEEP** | Operator-useful for ad-hoc seeding. |
| `scripts/plex-watchlist-ingest.mjs` | The actual Plex ingress | Operator-run; not in `package.json`, not in compose | Duplicates identity resolution that `PlexIntentProvider` also does; discards resolved IDs before persisting | **KEEP** (it works) | Optionally forward `imdbId`/`tmdbId` into the `searchByMedia` request so `persistMediaRequest` can persist them. |
| `cache.persistMediaRequest → upsertMediaIntent` | Implicit intent write | fires on every persisted request with source fields | Causes a **second** upsert per Seerr request → `request_count` ends at 2 for movies. For series it creates a **second row** because `media_type` differs (`'series'` from Seerr vs `'tv'` from `createRequestIntent`) | **MERGE** | Either stop passing source fields into `persistMediaRequest` from the Seerr path (it already wrote the intent), or pass the pre-resolved `intentId` so the FK is populated. |
| `media_requests.intent_id` | Intent↔request FK | **Never populated by any path that reaches `searchByMedia`** — `persistMediaRequest` only sets it when `intent.intentId` is passed, and no searchByMedia call site passes it | Declared FK with no producer | **UNWIRED** | Populate it, or drop it. |
| `media_intents.imdb_id / tmdb_id / tvdb_id` | Identity bundle | Written only by Seerr ingress; echoed in HTTP response (`:537-539`); **read by no logic** | Pure write amplification + 3 indexes serving 0 queries | **UNWIRED** | Keep the columns (they are correct and cheap); delete the three indexes until a query exists. |
| `idx_media_intents_imdb/_tmdb/_tvdb` | — | 0 queries | Also: the Seerr idempotency query `WHERE source=? AND source_id=?` is **not covered by any index** (`idx_media_intents_source` is `(source, source_type, last_requested_at)`) | **DELETE** | Drop the three indexes; consider `(source, source_id)` instead, which the real query needs. |
| `ensureMediaIntentIdentityColumns` (cache.js:804-825) | Pre-SCHEMA column migration | called `:864` | Adds the same three columns that `migrateMediaIntents` (`:716-730`) also adds — three code paths for one schema change | **MERGE** | Keep the pre-SCHEMA one (it is required, SCHEMA's `CREATE INDEX` depends on it); delete the duplicate block in `migrateMediaIntents`. |
| `migrateMediaIntents` create-table branch (cache.js:668-700) | Legacy table creation | `if (!tableExists)` — but `db.exec(SCHEMA)` runs at `:864`, immediately before `migrateMediaIntents` at `:866`, and SCHEMA has `CREATE TABLE IF NOT EXISTS` | **Unreachable.** Includes three `CREATE INDEX` without `IF NOT EXISTS` that can never run. | **DELETE** | Delete the branch. |
| `src/lib/discovery/media-metadata.js` | `media_metadata` table + 7-day TTL cache | **0 importers in `src/` or `scripts/`** (tests only). `docs/project-state.md:61` already says "not imported by the active server metadata path" | Fully built, never wired | **UNWIRED** | See §3 verdict — do not wire it on the strength of existence. |
| `unified-search` / `cinemeta` / `cinemeta-adapter` / `provider-adapter` / `metadata-cache` | Title + media metadata | Exactly two call sites: `app.js:1530` (`GET /api/search`) and `:1541` (`GET /api/media`) | Not part of the ingress→request pipeline at all | **KEEP** (out of scope) | Leave. They serve the UI and are not on the path being pruned. |
| `identity-resolver.js::CompositeIdentityResolver` / `NoopIdentityResolver` | Resolver composition | **0 importers** (only `ResolverError` and `BaseIdentityResolver` are used, by `cinemeta-identity-resolver.js`) | Abstraction built for a multi-resolver world that has one resolver | **DELETE** | Remove the two unused classes. |
| `cinemeta-identity-resolver.js` | Filename → IMDb resolution for enrichment | **only** `src/scripts/enrichment.js:80` (`npm run enrichment`) | Not on the ingress→request path | **KEEP** | Leave. It is the corpus enrichment path. |
| `src/lib/acquisition/` (10 files) | Acquisition intent/decision/policy subsystem | **0 importers anywhere in `src/` or `scripts/`**; tests only (`test/intent.test.js`, `test/execution.test.js`) | Third unrelated "intent" concept colliding by name with `lib/requests/intent.js` and `lib/intents/` | **DEAD** (adjacent to scope) | Flag only. Outside the stated scope; do not delete on this audit's authority. |
| `cache.updateMediaIntentStatus` / `getMediaIntentsByMediaId` / `getRecentMediaIntents` | Intent read API | **0 importers** | Exposed but unused | **DELETE** | Remove from the cache surface. |
| `src/scripts/media-request.js` / `media-request-batch.js` | Direct media-request CLI | In `package.json` (`media-request`, `media-request-batch`) | Neither passes `mediaTitle` | **KEEP / test-dev** | Batch harness is explicitly a validation harness (`:2-5`). Keep, but label. |
| `scripts/live-tv-gate-canary.mjs`, `seerr-tmdb-translation-canary.mjs`, `tv-identity-canary.mjs` | New ad-hoc verification scripts | **Not in `package.json`, not in compose, 0 importers** | Three new standalone scripts appear alongside an existing `npm run canary` that points at `scripts/canary.mjs` | **DEFER** | Either add npm scripts for them or fold them into the existing `canary` entry. Do not delete — they are the evidence for the new gates. |
| `scripts/validate-live-discovery.js` / `validate-playback-handoff.js` | Dev validation | standalone | These are the only producers of `mediaTitle` besides the Plex script | **KEEP / test-dev** | — |
| `search-engine.js::deriveLiveReleaseAttributes` | Transient parse of live filenames for the TV gate | `combinedSearch` episode gate | Reuses `parseFilename` — correct reuse, not duplication | **KEEP** | — |
| `search-engine.js` Stage 2b (`combinedSearch`) vs `searchTrace` copy | Title cross-check gate | both run | `searchTrace`'s copy (`:1142-1165`) is a verbatim copy-paste including the `mediaTitleForGate2` / `titleGateIntent2` renames that only exist to avoid a redeclaration error | **MERGE** | Extract `applyIdentityTitleGate(candidates, queryIntent, tracker, pipelineDebug)`. |
| `combinedSearch` `pipelineDebug.eligibleCandidates` first assignment | — | overwritten a few lines later by the Stage 2b assignment | Dead write | **DELETE** | Remove the first assignment. |
| `searchOptions.mediaTitle` merge (combinedSearch + searchTrace) | Feeds the title gate | **No caller passes it.** `GET /api/search` (`:1462-1480`) and `GET /api/debug/search-trace` (`:1263-1284`) both omit `mediaTitle`. | New merge branch is unwired | **UNWIRED** | Either pass `mediaTitle` from the routes or note the gate is inert on the UI path. |
| `ranking.js` title cross-check for movies | Movie identity hardening | Runs **only when `mediaTitle` is non-null** | No production ingress supplies `mediaTitle` (see §5) | **UNWIRED on Seerr** | Supply a canonical title at ingress, or the hardening does not fire. |
| `ranking.js::TITLE_STOPWORDS` / `meaningfulTokens` / `isLowInformationParsedTitle` | Anti-noise title heuristics | used by the new gates | — | **KEEP** | — |
| `docs/data-model.md` | Data model | contains **no** mention of `media_intents` | The ingress pipeline is undocumented rather than mis-documented | **DEFER** | Out of scope ("no docs rewrite"). Noted only. |

---

## §B Top 5 cleanup opportunities

Ranked **only** by *complexity removed ÷ behaviour risk*. Deletion preferred over abstraction.

### 1. Delete the unreachable + duplicated `media_intents` migration surface
`cache.js:668-700` (dead create-table branch) + `cache.js:716-730` (duplicate column/index adds).

- **Removes:** ~55 lines and three separate code paths that all do one schema change.
- **Risk:** near zero. On a fresh DB, SCHEMA creates columns and indexes. On an existing DB, `ensureMediaIntentIdentityColumns` (`:804-825`) adds columns *before* SCHEMA so SCHEMA's `CREATE INDEX` succeeds. The two other paths are provably redundant: the create-branch is unreachable because SCHEMA runs first (`:864` vs `:866`), and the post-SCHEMA column adds can never fire because `ensureMediaIntentIdentityColumns` already fired.
- **Why first:** it is the only item where deletion is provably behaviour-preserving from static reading alone.

### 2. Stop the double intent write; make `intent_id` real
`persistMediaRequest` (cache.js:2163-2176) calls `upsertMediaIntent` on every persisted request that carries source fields. The Seerr ingress already wrote the row.

- **Removes:** one redundant write per Seerr request, a spurious `request_count` of 2 on movies, and — for series — a **duplicate row** caused by `media_type` being `'series'` from Seerr (seerr.js:192 → `buildSeerrIntent`) and `'tv'` from `createRequestIntent` (intent.js:35). The dedupe key is `(media_id, media_type, source, season, episode)` (cache.js:2043), so the two writes cannot match.
- **Risk:** low, but **not** zero — `media_requests.intent_id` currently gets its value from this second write. Removing the write removes the FK value. The correct move is to pass the already-known `intentId` from the Seerr handler into `searchByMedia`, not to delete the write outright.
- **Why high on the list:** it is a live correctness bug (duplicate series intents) hiding inside redundancy.

### 3. Collapse the two `searchByMedia` branches' shared tail
`media-request.js:193-457` and `:478-833`.

- **Removes:** ~250 lines of duplicated tail — the `explainable` mapping (identical tier/scope/evidence construction), the TorBox availability block, `selectBestCandidate` → `persistMediaRequest` → `buildPlaybackHandoff` → `persistPlaybackHandoff` → `publishStrm` → `notifyJellyfin` → `promoteDemand` sequence, and two identical zero-candidate return objects (`:257-274`, `:459-476`).
- **Risk:** medium-high if attempted as a rewrite. **Low if scoped to the tail only.** The two branches differ *upstream* (corpus vs live candidate assembly) and are identical *downstream*. Extract the downstream; leave the upstream alone.
- **Also fixes for free:** the `mediaTitle` asymmetry — branch L passes it to `evaluateIdentityEligibility` (`:226`), branch C does not (`:522`).

### 4. Delete `SeerrIntentProvider` + the dead Seerr exports
`seerr.js:294-322` (`SeerrIntentProvider`, `createSeerrProvider`), plus un-export `safeEqualString`, `extractSeerrEnvelope`, `deriveMediaType`.

- **Removes:** ~40 lines and, more importantly, a **false architectural claim**. The module header says the provider object exists "so we reuse the existing MediaIntentProvider contract for validation and consistent field semantics" (`:7-11`). It does not: the class is never registered, never constructed, and `fetchIntents()` returns `[]` by design. The real Seerr path is three pure functions plus a handler.
- **Risk:** zero. Zero importers including tests.
- **Why it matters beyond line count:** leaving it invites the next person to "wire up the Seerr provider," which would route Seerr through `validateIntent` — which returns a fixed 11-field object (types.js:111-123) and would **strip the identity bundle**.

### 5. Delete the unused `media_intents` indexes; fix the one index the real query needs
`cache.js:209-211`, `:697-699`, `:719`, `:724`, `:729`.

- **Removes:** three indexes on `imdb_id`, `tmdb_id`, `tvdb_id` that serve **zero** queries — no `SELECT`, `WHERE`, `ORDER BY`, or `JOIN` anywhere references those columns outside `rowToMediaIntent`'s `SELECT *` projection.
- **Risk:** zero for deletion. The **addition** — `CREATE INDEX ... ON media_intents(source, source_id)` — is the part worth doing: the Seerr idempotency query is `WHERE source = ? AND source_id = ?` (app.js:443) and `idx_media_intents_source(source, source_type, last_requested_at)` can only use its `source` prefix.
- **Why here and not higher:** it is a small win, but it is the only item on this list that both deletes something and fixes a real (if currently latent) performance shape.

**Deliberately not in the top 5:** deleting `MediaIntentProcessor`. See §D.

---

## §C Dead / unwired inventory

### Provably dead (0 importers anywhere, including tests)
| Item | Location |
|---|---|
| `SeerrIntentProvider`, `createSeerrProvider` | `intents/providers/seerr.js:294-315` |
| `INTENT_PRIORITY` | `intents/types.js:149-154` |
| `CompositeIdentityResolver`, `NoopIdentityResolver` | `discovery/identity-resolver.js` |
| `cache.updateMediaIntentStatus` | `discovery/cache.js:2118` |
| `cache.getMediaIntentsByMediaId` | `discovery/cache.js:2106` |
| `cache.getRecentMediaIntents` | `discovery/cache.js:2114` |
| `MediaIntentProcessor.getStats` | `intents/processor.js:221` |
| `migrateMediaIntents` create-table branch | `discovery/cache.js:668-700` (unreachable) |
| `src/lib/acquisition/**` (10 files) | `lib/acquisition/` — adjacent to scope, flagged only |
| `pipelineDebug.eligibleCandidates` first assignment | `discovery/search-engine.js` (overwritten before read) |

### Unwired (built, correct, no consumer)
| Item | Why unwired |
|---|---|
| `media_metadata` table + `media-metadata.js` | 0 importers. See the `media_metadata` verdict below. |
| `media_intents.imdb_id` / `tmdb_id` / `tvdb_id` | Written only by Seerr; echoed in the HTTP response; read by no logic. |
| `idx_media_intents_imdb/_tmdb/_tvdb` | 0 queries. |
| `media_requests.intent_id` | FK declared; `persistMediaRequest` only sets it if `intent.intentId` is passed, and no `searchByMedia` call site passes one. |
| `searchOptions.mediaTitle` → `queryIntent.mediaTitle` merge | Added in `2f1f215` to both `combinedSearch` and `searchTrace`; no route sets `searchOptions.mediaTitle`. |
| `ranking.js` movie title cross-check + `canonicalTitleLink` tier demotion | Gated on `mediaTitle`; no production ingress supplies it (§5). |
| `INTENT_STATUS.COMPLETED` / `.CANCELLED` | Unreachable — nothing ever writes a non-`'active'` status. |
| `MediaIntentProviderRegistry.fetchAllIntents` / `fetchFromProvider` / `findBySource` / `list` / `has` | Tests only. Production uses `register` + `get`. |
| The three new canary scripts | Not in `package.json`, not in compose. `npm run canary` still points at the pre-existing `scripts/canary.mjs`. |

### Duplicate logic (same thing, two places)
| Duplication | Sites |
|---|---|
| Intent dedupe key `media_id, media_type, source, season IS ?, episode IS ?` | `cache.js:2042-2050` and `ingestion.js:211-222` — byte-identical, including `source \|\| 'api'` |
| `_formatScope` | `processor.js:209-215` and `ingestion.js:250-256` — byte-identical |
| `imdb_id`/`tmdb_id`/`tvdb_id` column addition | `cache.js:209-211` (SCHEMA), `:716-730` (migrate), `:804-825` (pre-SCHEMA) |
| Stage 2b identity title gate | `search-engine.js` `combinedSearch` and `searchTrace` — copy-paste, with `...2`-suffixed variables |
| Intent persistence | `intents.js:200-221` (`cmdFetch`) vs `ingestion.js:229-243` (`cmdSync`) |
| Plex identity resolution | `providers/plex.js::_extractMediaId` vs `scripts/plex-watchlist-ingest.mjs:88-113` — different implementations, different source literals |
| `searchByMedia` persist/dry-run call | `processor.js:73-93` vs `:94-118` — identical except `persist` |

---

## §D Do not touch yet

These look like obvious prune targets and are not.

### 1. `MediaIntentProcessor` — ugly, badly-shaped, still earning its keep
The honest answer to "is it still earning its abstraction?" is: **it is no longer on any production path, but it is the only thing that makes the CLI-driven Plex flow work, and deleting it would strand `media_intents`.**

The call graph proves the shape:

- `MediaIntentProcessor.process()` → `_findPendingIntents()` → per-intent `searchByMedia()` → `_updateProcessingState()`. That is the entire class: a `SELECT`, a loop over one function, and an `UPDATE`.
- It is **not** a wrapper around "one real request-processing function plus legacy batch machinery" in the pejorative sense — it *is* the batch machinery, and it is thin by design (~180 lines, one query, one call).

Why not delete it now:

- It is the **only** consumer of `last_processed_at` / `last_result_count` / `last_error` writes that the Seerr ingress also performs. Those three columns exist because of it. Delete the processor and the Seerr handler's state updates become the only writers, with only `SELECT`-by-SQL as a reader.
- It is the only thing that can re-drive a backlog. The Seerr ingress is push-only and fail-stop: if `searchByMedia` throws, the handler writes `last_error` and returns 500 (app.js:542-556) and **nothing ever retries**. The processor is the only retry mechanism in the system.
- `scripts/plex-watchlist-ingest.mjs` deliberately does not create intent rows before searching, so Plex items that fail never become retryable at all. The processor is the only path that could pick them up.

**Verdict: DEFER, don't delete.** The correct sequence is: decide whether the system wants an explicit-request-only architecture (push-only, fail-stop, no retry) or a durable-request architecture (queue + retry). If the former, delete the processor *and* the three processing columns *and* the Seerr `last_error` bookkeeping together. If the latter, promote the processor into the server as a real worker. Both are real decisions; neither is a cleanup.

### 2. `MediaIntentProviderRegistry` and `MediaIntentProvider`
The multi-provider fan-out API is test-only, which makes it look dead. But `register`/`get` are used by the CLI, and the registry is the natural home if Plex ever moves in-process. ~160 lines. Deleting it would also mean deleting `PlexIntentProvider` and `CliIntentProvider` or re-homing them. **Do not fold this into a "generic ingress framework"** — the duplication between Plex and Seerr is real but it is duplication of *transport and identity extraction*, not of a shared abstraction. Each is ~100 lines of genuinely different code.

### 3. `unified-search` / `cinemeta` / `provider-adapter` / `metadata-cache`
Not on the pruned path, but load-bearing for `GET /api/search` and `GET /api/media`. The provider-adapter abstraction looks over-built for one provider — and it is — but it is the seam a future TMDB provider would use, and it is not on the path being audited.

### 4. `cinemeta-identity-resolver.js` + `identity-resolver.js` base classes
Used by `npm run enrichment` (corpus enrichment), not by the request path. `CompositeIdentityResolver` and `NoopIdentityResolver` are dead, but the base classes are not. Delete the two dead classes; keep the rest.

### 5. `searchByMedia`'s two branches
Do not "unify" them into one code path. They encode a real difference: corpus candidates carry persisted release attributes and media associations; live candidates carry neither and must have them derived. The duplication is in the *tail*, not the decision. Fix the tail; leave the branch.

### 6. `media_intents.status` / `INTENT_STATUS`
Every row is `'active'` forever. But the column is in the dedupe-free path of `_findPendingIntents`'s `WHERE`, and a status lifecycle is a reasonable future need. Leave it; note it does not exist yet.

---

## Detailed answers to the seven inspection areas

### 1. Ingress duplication

Four front doors reach `searchByMedia`:

| Door | Location | Supplies `mediaTitle`? | Populates identity bundle? | Uses provider contract? |
|---|---|---|---|---|
| Seerr webhook | `app.js:377-557` | **No** | Yes (Seerr only) | No |
| Plex script | `scripts/plex-watchlist-ingest.mjs:210-221` | Yes | **No** (resolved then discarded) | No |
| `POST /api/media-request` | `app.js:1787-1799` | caller-dependent | No | No |
| CLI batch | `processor.js:96-108` | **No** | No | Yes (via rows) |

**Concrete duplication:** the dedupe query. Both Seerr (`app.js:443`) and the Plex script (`plex-watchlist-ingest.mjs:127`) hand-roll `WHERE source = ? AND source_id = ?`, with **different source literals for what is nominally the same concept**:

| | `source` | `sourceType` |
|---|---|---|
| `PlexIntentProvider` | `'plex'` | `'watchlist'` |
| `plex-watchlist-ingest.mjs` | `'plex-watchlist'` | `'plex'` |

The two are transposed. Rows written by one are invisible to the other.

**Recommendation: do not merge Plex and Seerr into a generic ingress abstraction.** The duplication is real but it is transport-shaped — auth, polling vs push, GUID parsing vs TMDB translation. A shared abstraction would have to absorb all of that to save ~30 lines of dedupe SQL. The right move is the opposite of abstraction: **make the dedupe a single `cache.findIntentBySourceId(source, sourceId)` helper and call it from both**, and fix the source-literal conflict by picking one vocabulary.

`cmdFetch` vs `cmdSync` is different — that is genuine duplication of *identical* work with different code. Delete `cmdFetch`.

### 2. `media_intents`

**Schema.** 17 columns + 6 indexes.

**Dedupe key** `(media_id, media_type, source, season IS ?, episode IS ?)` (cache.js:2043) — `source_type` and `source_id` are deliberately excluded. Consequence: two different Seerr requests for the same movie collapse into one row, and `source_id` on an existing row is only ever set by `COALESCE` on first write.

**Fields never read by production logic:**

| Field | Written by | Read by |
|---|---|---|
| `imdb_id`, `tmdb_id`, `tvdb_id` | Seerr ingress only | HTTP response echo + `rowToMediaIntent`. **No logic.** |
| `last_result_count` | Seerr handler, processor | `processor.getStats()` (CLI) |
| `last_error` | Seerr handler, processor | nothing in `src/`; operator SQL only |
| `priority` | all | `_findPendingIntents` `ORDER BY` (CLI only). Inert in the server. |
| `requested_by` | Seerr forces `null` (app.js:505, "do not capture user data") | nothing |
| `status` | always `'active'` | `_findPendingIntents` `WHERE` |

**Field semantics that do not match the name:** `source_label` carries library hints smuggled as `[plex:12345 jf:abc]` (seerr.js:214-222). The comment correctly warns they are not canonical IDs, but they are still source-specific structured data in a generic display column.

**Structural problem:** `season`/`episode` are always `null` for Seerr (seerr.js:227-228 hardcodes them). Seerr's `extra` payload carries requested seasons, and the code explicitly defers it: *"we will observe the real Seerr `extra` shape via the canary and decide later"* (seerr.js:239-241). So **there is no episode-level Seerr ingress today** — Seerr TV requests are series-scope only.

**Indexes:** `idx_media_intents_source(source, source_type, last_requested_at)` does not cover the actual dedupe query, which filters on `source_id`. The three new identity indexes serve nothing.

**Recommendation: minimal schema churn.** Delete three indexes, add one. Do not drop the identity columns — they are correct and the Seerr response already exposes them. Do not touch `status`/`priority` — they are inert, not wrong.

### 3. Identity resolution

**Every path that derives identity:**

| # | Path | Derives | Result |
|---|---|---|---|
| 1 | `seerr.js:128-145` `deriveMediaIdentity` | `mediaId` = imdb ‖ `tmdb:<id>` ‖ `tvdb:<id>` | best-formed, source-aware |
| 2 | `app.js:307-375` `resolveSeerrIdentity` | TMDB → IMDb via Seerr API | boundary-only, correct placement |
| 3 | `providers/plex.js::_extractMediaId` | regex `/\/\/([^/?]+)/` on `guid`, then `Guid[0].id` | known-bad: yields literal `"movie"` on modern Plex |
| 4 | `scripts/plex-watchlist-ingest.mjs:88-113` | `Guid[]` → `parseIdentity` → imdb‖tmdb | correct, but the script is out-of-band |
| 5 | `lib/requests/intent.js::createRequestIntent` | `baseMediaId` from `tt...:s:e` | mechanical, no external lookup |
| 6 | `discovery/cinemeta-identity-resolver.js` | filename → Cinemeta → IMDb | enrichment only, not request path |
| 7 | `discovery/enrichment-sources/cinemeta.js` | IMDb ← Cinemeta | corpus ingestion |
| 8 | `unified-search.getMediaById` | Cinemeta meta by ID | **UI only** (`app.js:1541`) |

**Duplicate crosswalk logic:** paths 3 and 4 both resolve Plex GUIDs to external IDs, differently, with different source literals, and only path 4 handles `Guid[]` correctly. Path 3 is unreachable in the deployed topology (no `PLEX_URL`/`PLEX_TOKEN` in compose).

**Fetched-then-discarded:** the Plex script resolves `imdb` and `tmdb` (`:176-177`), picks one (`:109-113`), and persists neither — the identity bundle is not forwarded into `searchByMedia`, and `persistMediaRequest`'s `upsertMediaIntent` call does not pass it.

**One-way bridge forcing source-specific workarounds:** Cinemeta is IMDb-keyed; Seerr is TMDB-native. That is why `resolveSeerrIdentity` exists at the boundary. This is the **correct** architecture — do not move TMDB→IMDb into the generic pipeline. The header comment says so explicitly (app.js:322-324) and is right.

**Canonical title / year:** not derived anywhere in the pipeline. `mediaTitle` is an optional input with only two producers, neither on the server path (§5). **Movie year is still never compared** — `evaluateIdentityEligibility` reaches `if (mediaType === 'movie' || !querySeason) return { eligible: true }` (ranking.js, post-diff) after the title check, and year is not consulted.

**`media_metadata` verdict — this is the direct answer:**

> `media_metadata` is an **abandoned abstraction, not a useful-but-unwired one.** Do not wire it.

Evidence:
- **0 importers** in `src/` or `scripts/`. Not one.
- It is the *third* metadata store in the system, alongside `unified-search`'s in-process LRU cache (5 min TTL, 500 entries) and `candidate_media` / `release_attributes` in the discovery DB.
- It has no provider: `storeMediaMetadata` is never called, so `getMediaMetadata` can never return anything and `isMetadataCached` is always false.
- `docs/project-state.md:61` already records it as unwired, i.e. it has been unwired through multiple feature cycles.
- Its schema (`media_id, provider, type, title, year, poster, backdrop, overview`, `metadata` JSON blob) duplicates fields the current request path already derives on demand, and its PK `(media_id, provider)` presumes a multi-provider metadata world that does not exist.

The Task 3 recommendation was to cache a canonical identity record in this table. **That recommendation should be revised.** The smaller and better move is to put the canonical title/year **in the request path as a value** (pass `mediaTitle` from the Seerr ingress, where Seerr's `subject` already carries the title), not in a third persistence layer with a 7-day TTL. If caching is later needed, `unified-search`'s existing cache is the right home.

### 4. `MediaIntentProcessor` — the call graph, proven

```
src/scripts/intents.js:491  case 'process'  →  cmdProcess(cache, args)
   └─ src/scripts/intents.js:337   new MediaIntentProcessor(cache)
   └─ src/scripts/intents.js:345   processor.process({ limit, dryRun, log, minIntervalMs })
        └─ processor.js:63    _findPendingIntents(limit, minIntervalMs)
        │     └─ SELECT * FROM media_intents
        │          WHERE status='active'
        │            AND (last_processed_at IS NULL OR last_processed_at < ?)
        │          ORDER BY priority DESC, last_requested_at DESC LIMIT ?
        └─ processor.js:75|96  searchByMedia(cache, {...11 fields, persist: false|true})
        └─ processor.js:111    _updateProcessingState(id, total, null)
        └─ processor.js:131    _updateProcessingState(id, 0, error.message)
```

**That is the whole call graph.** One constructor, one entry point (`process`), one query, one downstream call, one update. Nothing in `src/server/`, nothing in `compose.yaml`, nothing scheduled.

**Verdict:** it is not "a wrapper around one real function plus legacy batch machinery" — it **is** the batch machinery, and it is thin. But it is also **off the production path entirely**, and it has a latent hazard: with the default `minIntervalMs = 0`, the cutoff is `Date.now()`, so `last_processed_at < cutoff` is true for every row the Seerr ingress already processed. Running `npm run intents -- process` today **re-runs every Seerr request ever received.** See §D.1 — defer, do not delete.

### 5. `searchByMedia` / request creation

**How intent data enters:** a flat 11-field object. There is no `MediaIntent` object at the boundary — `createRequestIntent` (`:188`) is called *inside* `searchByMedia` and derives only `mediaType`/`baseMediaId`/`season`/`episodes`. Source fields (`source`, `sourceType`, `sourceId`, `sourceLabel`, `requestedBy`, `priority`) are passed through untouched to `persistMediaRequest`.

**How canonical identity reaches ranking:** it does not, except as `mediaId` used in `queryCandidatesByMedia(mediaId)` (`:191`) and as the `selectedMediaId` passed to `rankHitsTiered` (`:277`, `:638`). There is no title/year/season-canonicalisation step.

**Where `mediaTitle` is and is not honoured:**

| Call site | `mediaTitle` | Effect |
|---|---|---|
| branch L eligibility (`:226`) | passed | title cross-check fires |
| branch C eligibility (`:522`) | **not passed** | title cross-check silently skipped for corpus candidates |
| branch L tier (`:288`) | passed | `canonicalTitleLink` computed |
| branch C tier (`:659`) | passed | `canonicalTitleLink` computed |

So even when a `mediaTitle` is supplied, **corpus candidates skip the eligibility gate but not the tier classifier.** That is an inconsistency, not a design.

**Zero-candidate vs identity-resolution failure — the distinction is clean:**

| Outcome | `requestId` | `total` | HTTP | `media_intents.last_error` |
|---|---|---|---|---|
| Identity unresolved (Seerr, no IMDb) | — | — | 500 / 503, `status:'identity-unresolved'` | set, `searchByMedia` **never called** |
| Zero candidates after live discovery | `null` | `0` | 200 | cleared |
| Zero candidates, `skipLiveDiscovery` | `null` | `0` | 200 | cleared |
| Processing threw | — | — | 500, `status:'processing-failed'` | set |

This is well-differentiated and should not be changed.

**Duplicated request-intent construction:** `persistMediaRequest` is called at `:344` and `:744` with identical field lists. Both omit `intentId`.

**Stale optional parameters:** `liveDiscoveryThreshold`, `skipLiveDiscovery`, `skipAvailability`, `limit`, `offset` are accepted; `POST /api/media-request` forwards the raw body (`:1791`), so all are caller-controlled. `limit` is clamped to 100; `offset` is applied after ranking but before explainable mapping.

**Fields that should be resolved earlier:** `mediaTitle`. It is the single input that unlocks the entire new movie-identity hardening, and it is resolved nowhere.

### 6. Legacy CLI / manual seams

| Script | `package.json` | Classification | Reasoning |
|---|---|---|---|
| `src/scripts/intents.js` | `intents` | **Operationally useful** | Only consumer of the intent subsystem. `sync`/`process` are the only retry path. |
| `scripts/plex-watchlist-ingest.mjs` | **not listed** | **Operationally useful** | The real Plex ingress. Should be added to `package.json`. |
| `src/scripts/media-request.js` | `media-request` | **Test-dev / ad-hoc** | Manual single request; no `mediaTitle`. |
| `src/scripts/media-request-batch.js` | `media-request-batch` | **Test-dev** | Self-describes as a "Batch Validation Harness" (`:2-5`). |
| `scripts/canary.mjs` | `canary` | **Operationally useful** | Pre-existing end-to-end smoke. |
| `scripts/live-tv-gate-canary.mjs` | — | **Test-dev** | New; verifies the TV gate. Not wired. |
| `scripts/seerr-tmdb-translation-canary.mjs` | — | **Test-dev** | New; verifies TMDB→IMDb. Not wired. |
| `scripts/tv-identity-canary.mjs` | — | **Test-dev** | New; verifies TV identity. Not wired. |
| `scripts/validate-live-discovery.js` | — | **Test-dev** | One of only two `mediaTitle` producers. |
| `scripts/validate-playback-handoff.js` | — | **Test-dev** | |
| `scripts/debug-cinemeta.mjs` | — | **Test-dev** | |
| `src/scripts/enrichment.js` | `enrichment` | **Operationally useful** | Only consumer of `CinemetaIdentityResolver`. |

Nothing deleted. Three new canaries are orphaned from `package.json` — that is a wiring gap, not a reason to delete.

### 7. Tests as architecture evidence

Not counting tests. Using them as evidence.

**Signal 1 — `test/seerr-ingress.test.js` (939 lines) is the architecture's confession.** It must spin up **six** real `http.createServer` stubs (`:749, 768, 796, 816, 842, 893`) and mutate `process.env.SEERR_URL` / `SEERR_API_KEY` per test (`:849-852, 899-902`), restoring them by hand in `finally` (`:883-886, 932-935`). That is not a testing preference. It is what you are forced into when the unit under test reads configuration from `process.env` at call time and reaches the network through a module-scoped import.

**What code shape caused the ES-module monkey-patching pain — the specific answer:**

Four things, all in `app.js`:

1. **`searchByMedia` is imported as a bare module binding** (`app.js:7`) and invoked directly inside `handleSeerrIngress` (`:513`). ESM import bindings are read-only live bindings. You cannot reassign them, you cannot `jest.mock` them, and `Object.defineProperty` on the module namespace object throws. So the test **cannot** substitute the pipeline function. It must let the real `searchByMedia` run and stub the network underneath it.

2. **`handleSeerrIngress` is not exported.** It is reachable only through `createRequestHandler` (`:1449-1451`), so every test must drive it through the full HTTP router with hand-rolled fake `IncomingMessage`/`ServerResponse` objects (`:56-79`) — 24 lines of harness per test file.

3. **Configuration is read from `process.env` at call time, not injected.** `resolveSeerrIdentity` *does* accept an injectable `env` (`:326`) — the seam exists — but the handler calls it as `resolveSeerrIdentity({...}, process.env)` (`:459-462`), throwing the seam away. So tests must mutate the real environment and restore it manually.

4. **`searchByMedia` has no failure seam that stops at the pipeline boundary.** Once called, it runs live discovery, TorBox availability, STRM publication and Jellyfin notification. To keep a test hermetic, the only lever is the network — hence the HTTP stubs.

**The fix is not a mocking framework.** It is: export `handleSeerrIngress`, and pass `searchByMedia` and the env in as parameters with defaults. Two changes; the six HTTP stubs collapse to direct function calls with a stubbed pipeline.

**Signal 2 — `test/intent.test.js` is not about the request path.** It tests `src/lib/acquisition/intent.js` (`ACQUISITION_INTENT_STATUSES`), a subsystem with zero production importers. The name collision with `src/lib/requests/intent.js` and `src/lib/intents/` means a reader searching for "intent tests" lands on an orphan.

**Signal 3 — `test/media-intent-providers.test.js` locks in an architecture that production does not use.** It exercises `registry.findBySource`, `fetchAllIntents`, and multi-provider fan-out (`:249-298`) — machinery whose only consumer is this test. The tests are not wrong; they are evidence that the multi-provider design was built ahead of any second provider, and the second provider (Seerr) arrived and did not use it.

**Signal 4 — tests assert the double-write.** `test/seerr-ingress.test.js:4` claims *"same payload twice → still one intent."* That passes, but only because the idempotency guard (app.js:443) short-circuits before the double write. The `request_count = 2` on a single first request is not asserted anywhere.

---

## Uncertainties

1. **Runtime behaviour is not verified.** Everything here is static. Specifically unverified: whether the Seerr double-write produces `request_count = 2` in practice, and whether the series `media_type` mismatch (`'series'` vs `'tv'`) really produces two rows. Both are derived from reading `upsertMediaIntent` (cache.js:2042-2094) and `createRequestIntent` (intent.js:32-42); both are high-confidence but unconfirmed by execution.
2. **Deployment topology is inferred from `compose.yaml`.** If the operator runs `intents process`, `intents sync`, or `plex-watchlist-ingest.mjs` on a schedule outside compose (cron, systemd timer), the "off the production path" claims for `MediaIntentProcessor` and `PlexIntentProvider` soften from DEAD to "operator-scheduled." No scheduler was found in the repo, but host-level scheduling would not be visible here.
3. **Whether `POST /api/media-request` receives `mediaTitle` from any UI caller is unknown.** `app.js:1791` forwards the raw body. No UI source in this repo was found sending `mediaTitle`; a caller outside the repo could.
4. **`media_metadata` was almost certainly a deliberate staging area, not an accident.** The 7-day TTL and `(media_id, provider)` PK suggest intent. The "abandoned" verdict is based on zero importers across the whole repo and an existing doc note — it is possible an external consumer or a planned-but-unpushed feature uses it.
5. **Seerr's actual webhook payload shape is not confirmed from a live instance.** `buildSeerrIntent` sniffs for `media`/`Media`/top-level (seerr.js:105) precisely because the shape was uncertain, and defers the `extra` field pending canary observation (`:239-241`). Field-name guessing here is a symptom, not a defect.
6. **Whether the three new canary scripts were intended to be wired** is unknown. They are not in `package.json` or compose. They may be deliberately ad-hoc.
7. **`src/lib/acquisition/` is reported as dead but not scoped.** Zero importers is strong evidence; a dynamic import or an external consumer would change the verdict. Flagged, not acted on.

---

## Sources

**HashSucker at `2f1f215`**
- `compose.yaml`
- `media-search/package.json`
- `media-search/src/server/index.js`
- `media-search/src/server/app.js` (`:307-375` resolveSeerrIdentity; `:377-557` handleSeerrIngress; `:1253-1284` search-trace route; `:1449-1451` ingress route; `:1452-1480` /api/search; `:1530` searchTitles; `:1541` getMediaById; `:1699` operator log; `:1787-1799` /api/media-request)
- `media-search/src/lib/intents/providers/seerr.js` (full)
- `media-search/src/lib/intents/providers/plex.js`
- `media-search/src/lib/intents/types.js` (full)
- `media-search/src/lib/intents/ingestion.js` (full)
- `media-search/src/lib/intents/processor.js` (full)
- `media-search/src/lib/intents/registry.js`
- `media-search/src/lib/intents/index.js`
- `media-search/src/api/media-request.js` (`:150-476`, `:560-680`, `:740-800`)
- `media-search/src/lib/requests/intent.js` (full)
- `media-search/src/lib/discovery/cache.js` (`:197-211`, `:664-730`, `:804-825`, `:855-866`, `:1620-1650`, `:2035-2176`)
- `media-search/src/lib/discovery/media-metadata.js`
- `media-search/src/lib/discovery/identity-resolver.js`
- `media-search/src/lib/discovery/cinemeta-identity-resolver.js`
- `media-search/src/lib/discovery/ranking.js` (diff `0ce7ddd..2f1f215`)
- `media-search/src/lib/discovery/search-engine.js` (diff `0ce7ddd..2f1f215`)
- `media-search/src/lib/acquisition/**`
- `media-search/src/scripts/intents.js` (`:150-296`, `:430-505`)
- `media-search/src/scripts/media-request-batch.js`
- `media-search/scripts/plex-watchlist-ingest.mjs` (full)
- `media-search/scripts/{live-tv-gate,seerr-tmdb-translation,tv-identity}-canary.mjs`
- `media-search/test/seerr-ingress.test.js` (`:1-110`, `:700-939`)
- `media-search/test/media-intent-providers.test.js` (`:249-298`)
- `media-search/test/intent.test.js` (`:1-12`)

**Diffs:** `git diff 0ce7ddd 2f1f215` — 12 files, +2701/−72.

**Docs:** `docs/project-state.md:61`, `docs/data-model.md`, `docs/pipeline.md`, `docs/known-gaps.md:105`.

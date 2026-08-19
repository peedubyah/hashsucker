# media-search — Codex implementation contract

## Project purpose

`media-search` is the user-facing search and request application for a separate
media acquisition/import system.

It is developed in this repository, but its production target is an Unraid
Docker host.

The development checkout is NOT a runtime dependency.

The application must remain fully functional after this repository is copied
to an Unraid appdata/project directory and built/deployed there.

The application should eventually replace the current need to use TorBox
Manager as the user-facing release search/selection interface.

---

## Critical architecture boundary

There are two separate applications.

### media-search owns

- media discovery/search
- title selection
- season/episode selection
- explicit human media intent
- release discovery
- provider cache-status enrichment
- release selection
- request construction
- request submission
- coarse request lifecycle/status display
- the browser UI
- the HTTP API used by that browser UI

### torbox-importer owns

- provider acquisition
- TorBox torrent creation/reuse
- inspection of torrent contents
- physical torrent-file selection
- Sonarr/Radarr parsing and authority
- selective provider file download
- staging
- Sonarr/Radarr ManualImport
- post-import verification
- provider ownership
- provider cleanup
- importer workflow state

DO NOT duplicate importer logic inside media-search.

DO NOT make media-search decide which physical file from a torrent should be
downloaded.

DO NOT make media-search depend directly on the importer's SQLite database.

DO NOT invoke importer shell scripts from media-search.

The request interface is the boundary between these applications.

---

## Existing code is authoritative

Before implementing anything, inventory and understand the existing repository.

The following existing modules represent working backend primitives and should
be preserved and built around rather than rewritten for convenience:

- `src/lib/search.js`
- `src/lib/providers/torbox.js`
- `src/lib/requests/intent.js`
- `src/lib/requests/handoff.js`
- `src/lib/requests/queue.js`
- `src/lib/stremio/normalize.js`
- `src/lib/stremio/manifest.js`

Inspect their actual APIs before designing routes or components.

Do not perform a broad rewrite of `src/lib`.

Do not replace working provider/search/request primitives merely to fit a UI
framework.

Refactor only where there is a concrete need and preserve existing behavior
with tests.

---

## Production deployment model

The production application must be a self-contained Docker deployment suitable
for Unraid.

Preferred production shape:

    browser
       |
       v
    media-search container
       |
       +-- serves compiled browser UI
       +-- exposes /api/*
       +-- performs provider/discovery requests server-side
       +-- submits importer requests
       |
       v
    shared request transport
       |
       v
    torbox-importer container

Prefer a single production `media-search` container.

A development server may be used locally, but production must NOT require:

- a Vite development server
- source files outside the image
- `/home/patrick/...`
- development-machine services
- development proxying
- globally installed Node packages
- absolute development host paths

Use a multi-stage Docker build if appropriate:

    Node build stage
      -> compile browser application

    production Node stage
      -> API server
      -> serves compiled static UI

The server should listen on a configurable port.

---

## Unraid requirements

Provide and maintain:

- `Dockerfile`
- `.dockerignore`
- `compose.yaml`
- `.env.example`
- a production start command
- healthcheck if practical
- README deployment instructions
- existing deployment tooling such as `deploy.sh`, if present

Host-specific values belong in environment variables or Compose configuration.

Do not hard-code Unraid host paths inside application code.

An example Compose deployment may bind:

    media-search persistent config:
        host appdata path -> /config

    shared request queue:
        /mnt/database/appdata/media-request-queue -> /requests

The exact host-side application source/project path must not matter to runtime.

Application source belongs in the image.

Do not put application source or `node_modules` into `/config`.

`/config` is only for mutable application state/configuration if such state is
actually needed.

---

## Importer communication

The current proven importer transport is the shared durable request queue.

Both applications may mount:

    /requests

The request spool contains:

    /requests/incoming
    /requests/processing
    /requests/done
    /requests/failed

media-search submits requests through the existing request queue implementation.

torbox-importer atomically claims and processes them.

media-search may derive coarse request lifecycle from the spool.

This queue behavior is already proven and is the authoritative v1 transport.

Do NOT replace it with a newly invented importer HTTP API during this task.

However, hide transport details behind an importer client abstraction so the
transport can later be replaced without changing the UI or business logic.

Suggested conceptual interface:

    submitRequest(...)
    getRequestStatus(...)
    getRequest(...)

A reasonable implementation layout is:

    src/lib/importer/client.js
    src/lib/importer/queue-client.js

Do not make unrelated code know how queue files are stored.

A future HTTP transport should be able to implement the same interface.

---

## Request lifecycle

Request submission must continue to use the existing request intent, handoff,
and atomic queue primitives.

Do not hand-write incompatible request JSON in route handlers.

Do not write directly to importer SQLite.

Do not mutate files under `processing`, `done`, or `failed`.

A submitted request should transition observationally through:

    incoming
      -> processing
      -> done

or:

    incoming
      -> processing
      -> failed

The browser should be able to show this coarse state.

Polling is acceptable for the initial UI.

Do not create a websocket architecture unless there is a demonstrated need.

---

## Critical TV semantic

Human intent and release granularity are independent.

This is one of the most important architectural rules in the project.

A user may explicitly request:

    Black Mirror S07E03

while selecting a release representing:

    Black Mirror Season 7 Complete — 61 GB

The request MUST remain:

    mediaType: tv
    scope: episode
    season: 7
    episodes: [3]

The release may contain S07E01 through S07E06.

media-search MUST NOT expand `[3]` to `[1,2,3,4,5,6]`.

media-search MUST NOT infer wanted episodes from the release title.

media-search MUST NOT infer wanted episodes from Sonarr's missing state.

media-search MUST NOT infer intent from Sonarr monitoring state.

The importer is responsible for inspecting the release and mapping the explicit
episode intent onto the correct physical provider file.

A standalone S07E03 torrent and a whole-season torrent containing S07E03 must
produce the same media intent.

---

## Current proven unattended scope

The currently proven request-driven backend is:

    mediaType: tv
    scope: episode

Treat explicit single-episode TV requests as the production-supported MVP.

The schema may be capable of representing more than the proven backend.

That does NOT make those operations safe to expose.

Do not expose functioning request buttons for:

- full TV series
- full TV seasons
- arbitrary multi-episode requests
- other unproven request modes

unless the current backend code is inspected and demonstrably supports them.

Movies may appear in search results if existing discovery supports them, but do
not claim the request workflow is supported unless the current importer request
path actually supports it.

Prefer a clear "not yet supported" UI over silently routing through an
unproven path.

---

## Discovery/provider architecture

Discovery should remain provider-neutral.

The release identity is not synonymous with TorBox.

TorBox cached state is enrichment attached to a release.

Do not design browser or API data structures that make another debrid/provider
impossible later.

For example, conceptually:

    release
      infoHash
      title
      size
      metadata
      providers
        torbox
          cached: true

rather than making `torboxRelease` the fundamental domain object.

The existing provider-neutral search result structure should be preserved where
possible.

---

## Secrets and browser boundary

Provider credentials are server-side secrets.

Never include the TorBox API key in:

- browser JavaScript bundles
- API responses
- HTML
- client-side environment variables
- logs intended for the browser

The browser talks only to media-search.

The media-search server performs provider-cache enrichment.

Do not have the browser call TorBox directly.

Do not expose Sonarr/Radarr API keys to the browser.

Do not log secrets.

Provide `.env.example` with names/placeholders only.

Never commit real credentials.

---

## Suggested application organization

Do not reorganize existing working modules gratuitously, but a target shape may
look like:

    media-search/
    ├── CODEX.md
    ├── README.md
    ├── Dockerfile
    ├── compose.yaml
    ├── .dockerignore
    ├── .env.example
    ├── package.json
    ├── deploy.sh
    │
    ├── src/
    │   ├── lib/
    │   │   ├── search.js
    │   │   ├── providers/
    │   │   ├── requests/
    │   │   ├── importer/
    │   │   │   ├── client.js
    │   │   │   └── queue-client.js
    │   │   └── stremio/
    │   │
    │   ├── server/
    │   │   ├── index.js
    │   │   ├── routes/
    │   │   └── ...
    │   │
    │   └── ui/
    │       ├── ...
    │       └── ...
    │
    └── tests/

Follow the existing repository where it already has sensible structure.

The point is separation of concerns, not achieving this exact tree.

---

## Server/API MVP

Build the smallest useful server API around the existing library modules.

Conceptually the UI needs operations equivalent to:

    GET /api/search?q=...

Search media.

    GET /api/media/:id

Return enough media information for title/season/episode presentation.

    GET /api/releases?mediaId=...

Return normalized release candidates and provider/cache enrichment.

    POST /api/requests

Validate explicit user intent + selected release and submit through the existing
handoff/queue system.

    GET /api/requests/:requestId

Return coarse queue lifecycle/status.

These exact paths are suggestions, not mandatory compatibility requirements.

Prefer straightforward REST over an unnecessary RPC framework.

Validate all request bodies server-side.

---

## UI MVP

The initial UI should prioritize function, clarity, responsiveness, and
information density over animation or visual polish.

Required flow:

    search
      -> choose a series
      -> choose season
      -> choose exact episode
      -> view releases
      -> see TorBox cached status
      -> choose release
      -> confirm exact episode intent
      -> submit
      -> observe request status

The release list should make useful metadata easy to scan:

- title
- size
- resolution/quality if already available
- codec/HDR if already available
- provider cache state

Do not spend substantial implementation time deriving metadata that the
existing normalization/search code does not currently provide.

For an episode request against a season-pack release, make the distinction
visible.

For example:

    Requested:
        Black Mirror S07E03

    Selected release:
        Black Mirror Season 7 DV HDR10 WEB-DL 2160p
        61 GB
        TorBox Cached

    Import behavior:
        Requested episode only

This is both useful UX and protection against accidental scope confusion.

---

## Status UI

For v1, coarse states are enough:

- queued
- processing
- done
- failed

These may map directly from spool location:

    incoming   -> queued
    processing -> processing
    done       -> done
    failed     -> failed

If a failure request file contains usable safe failure information, it may be
displayed.

Do not couple status display to importer SQLite.

Do not invent fake percentage progress.

A later importer API can expose richer progress.

---

## Error handling and safety

Fail closed.

If required media intent is incomplete or ambiguous:

    do not submit

If a release lacks the required identity such as a valid infoHash:

    do not submit

If the queue is unavailable:

    return an explicit error

If provider enrichment fails:

    distinguish "unknown" from "not cached"

Do not silently broaden request scope.

Do not silently fall back to "download all missing episodes."

Do not silently invoke unsupported request types.

---

## Atomicity

The existing request queue implementation performs atomic handoff.

Preserve that behavior.

A browser request must never leave a partially written `.json` file visible in
`incoming`.

Do not replace the proven queue writer with direct `fs.writeFile()` into the
final incoming filename unless equivalent atomic semantics are explicitly
preserved and tested.

---

## Docker/container behavior

The container must:

- run without root when reasonably practical
- honor a configurable listen port
- honor `/requests` or configurable request-root path
- start with one production command
- serve the browser UI itself
- expose the API from the same application/origin
- not require Docker socket access
- not require SSH access
- not require access to torbox-importer appdata
- not require access to importer SQLite
- restart safely
- tolerate the importer container being temporarily offline because the queue
  is durable

Do not use host networking unless there is a concrete requirement.

---

## Testing requirements

Preserve existing tests.

Add tests for the new API/client/UI-domain behavior.

At minimum prove these invariants:

1. Selecting TV S07E03 with a whole-season release produces:
       season: 7
       episodes: [3]
   and never expands intent to all files in the release.

2. Selecting a standalone S07E03 release produces the same media intent.

3. A request cannot be submitted without valid explicit media intent.

4. A request cannot be submitted without a valid release infoHash.

5. Request submission uses the existing request/handoff/atomic queue path.

6. TorBox cached state survives search -> server API -> UI without becoming
   media intent.

7. Status correctly maps incoming/processing/done/failed.

8. No provider credentials appear in browser-facing data.

9. The application can be built in Docker without relying on files outside the
   repository.

10. Production server serves both the compiled UI and API.

Use integration tests where they add value, but do not require live TorBox for
the normal automated test suite.

Mock provider calls appropriately.

---

## Deployment acceptance test

The meaningful MVP is complete when the following can happen without using a
shell as part of the user interaction:

    source copied/deployed to Unraid
        ->
    docker compose build
        ->
    docker compose up -d
        ->
    open media-search in browser
        ->
    search for Black Mirror
        ->
    choose Season 7 Episode 3
        ->
    choose a TorBox-cached release
        even if that release is the entire season pack
        ->
    click Request
        ->
    media-search emits the correct explicit episode request
        ->
    torbox-importer consumes it
        ->
    UI observes queued -> processing -> done

No development-machine process may be required for this flow.

---

## Scope discipline

Do not burn implementation time on:

- authentication/accounts
- multiple users
- watchlists
- Plex integration
- recommendations
- transcoding
- streaming playback
- websocket infrastructure
- torrent-file selection
- importer workflow duplication
- direct Arr management
- elaborate settings systems
- animation-heavy UI
- premature database introduction

unless required by existing repository behavior.

The immediate goal is an excellent search -> episode -> release -> request
workflow.

---

## Working method

Before modifying code:

1. Inventory the repository.
2. Read the existing search/provider/request modules.
3. Run existing tests.
4. Identify the current runtime/deployment assumptions.
5. Present a concise implementation plan.

Then implement incrementally.

Prefer small coherent changes.

Run tests after meaningful stages.

Build the Docker image before declaring completion.

Do not perform broad rewrites when an adapter or thin route/component is
sufficient.

When an existing implementation contradicts assumptions in this document,
inspect the code and preserve proven behavior rather than guessing.

Document any remaining blockers or unsupported paths clearly in the final
handoff.

# Current Implementation Handoff

## Current state

- IMPLEMENTED: dependency-free Node HTTP server, same-origin static browser UI, Cinemeta title/media metadata adapter, existing Stremio release search with TorBox cache enrichment, explicit episode request submission, queue-backed coarse status polling.
- IMPLEMENTED: browser flow for TV series search -> season -> one episode -> normalized torrent releases -> TorBox cache indicator -> release selection -> explicit request confirmation -> queued/processing/done/failed polling.
- VERIFIED: in-process/no-socket server integration tests cover routing, static serving, request validation, handoff construction, API projection, and secret exclusion.
- VERIFIED ON UNRAID: the production container builds and runs, `GET /health` returns HTTP 200 with `{"ok":true}`, and the process runs non-root as `node` UID 1000.
- VERIFIED ON UNRAID: the shared spool owned `99:100` with mode `2775` is writable when Compose adds supplementary GID 100; a media-search-created request file was owned `1000:100`.
- VERIFIED LIVE END TO END: Black Mirror search, Season 7 / Episode 3 selection, Comet release discovery, TorBox cache enrichment, browser-only request submission, queued observation, importer claim/acquisition, exact S07E03 selection, one-file download, Sonarr ManualImport and post-import verification, request-owned TorBox cleanup, and finalization to `/requests/done` all succeeded. The pre-existing/TBM-owned Season 7 pack remained untouched.
- NOT IMPLEMENTED: authentication, series/season/multi-episode requests, importer HTTP transport, rich importer progress.
- IMPLEMENTED IN MEDIA-SEARCH + STAGED FOR IMPORTER: explicit movie requests (`mediaType: movie`, `scope: movie`) are supported in the UI and server API, covered by unit tests. The candidate torbox-importer bridge in `handoff/movie-importer-bridge/` connects queue movie requests to `process-movie.sh`, validates Radarr identity against request intent, preserves pre-existing and shared-hash provider material, fails closed on mismatch without retrying, and has been verified by standalone tests. It has not yet been deployed to Tower.
- INTENTIONALLY DISABLED: series, season packs as TV intent, and multi-episode requests (only explicit single TV episodes and explicit single movies are supported).
- IMPLEMENTED BUT NOT LIVE-VERIFIED: stabilization UI with sticky desktop selection/status pane, sticky mobile bottom pane, compact normalized release badges, result/cached/resolution counts, exact-infoHash deduplication, cached-first stable ordering, filters, incremental 100-row rendering, and debounced stale-safe title search.
- IMPLEMENTED BUT NOT LIVE-VERIFIED: server timing fields for title search, media detail, Stremio discovery, TorBox enrichment, and total release latency. No performance cache was added before collecting live measurements.
- LIVE UX REDEPLOY VERIFICATION FAILED (2026-08-19): a row can appear blue/selected while the confirmation pane remains empty; the selection/action pane is not viewport-accessible while scrolling a long list; filter controls render detached/raw; release/cached/filtered counts are missing or not obvious; and Resolution/Codec option sets remain empty despite normalized fields in rows. Treat these as Priority-1 regressions until redeployed and retested.
- VERIFIED LIVE IN THE SAME REDEPLOY: cached-first ordering, denser rows, normalized resolution/source/codec/HDR/size presentation, large-result rendering, real Black Mirror S07E04 discovery, TorBox enrichment, and exact S07E04 episode context continue to work. Preserve these behaviors.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: selection now uses one exact/case-normalized infoHash predicate, null selection cannot render selected styling, selected rows carry an explicit `Selected` badge, keyboard focus uses a separate neutral dashed outline, and confirmation visibility has an explicit `[hidden]` rule. Filtering/rerendering retains the selected release object and confirmation.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: the desktop confirmation/action/status pane is now viewport-fixed with reserved release-list space; narrow layouts use a viewport-fixed bottom pane. It no longer relies on `position: sticky` ancestor behavior.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: filters are a compact contiguous labeled toolbar; Resolution and Codec choices derive once per load from the complete deduplicated normalized dataset with tested stable ordering; filtering does not rebuild/collapse option sets; Clear restores all filters.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: summary visibly reports total releases, cached releases, showing count, and resolution counts.
- ROOT CAUSE/RISK FIXED LOCALLY: stable-name JS/CSS assets previously used `max-age=3600`, allowing mixed old/new HTML, JS, and CSS after redeploy. All unfingerprinted UI assets now use `Cache-Control: no-cache`; HTML also uses a new asset-version query to bypass already-cached prior responses. Both are covered by server tests.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: one compact popover anchored below the main search field progressively transforms from debounced title rows -> selected-series season list -> selected-season episode rows. Episode rows show title, SxxExx, air date, and thumbnail when Cinemeta supplies one. Back returns to seasons, Cancel dismisses, and only exact episode selection commits intent and starts discovery. This borrows an interaction pattern only; media-search styling, APIs, release workflow, and exact episode semantics remain authoritative.
- VERIFIED LIVE ON UNRAID AFTER UX REDEPLOY: anchored search-as-you-type; title -> season -> episode drill-down; optional episode thumbnails; automatic release discovery after exact episode selection; release counts; cached-first dense normalized rows; explicit Selected state distinct from focus; and the right-side action/status concept all work.
- VERIFIED LIVE REQUEST: browser-originated Black Mirror S07E04 transitioned visibly QUEUED -> PROCESSING -> DONE; importer download/import/verification and Sonarr import succeeded; exact single-episode semantics remained intact.
- VERIFIED LIVE PERFORMANCE: representative S07E04 release lookup measured approximately 146 ms discovery + 504 ms TorBox enrichment = 650 ms total. This is excellent; retain instrumentation and do not add speculative caching absent a measured regression.
- LIVE POLISH TEST FOUND: the globally fixed action pane could overlap search/drill-down and appear prematurely during the episode-to-loading transition; after submission it retained incorrect `Confirm request` terminology/disabled submit UI; and the secondary release line exposed Comet emoji/provider presentation noise.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: the release workspace is again a two-column CSS grid and the pane is a grid-contained `position: sticky` child aligned with releases/filters, not globally fixed. It cannot render during discovery because loading, filters, and workspace have explicit mutually staged visibility.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: pane lifecycle now replaces confirmation after submission with `Request in progress`, then `Request complete` or `Request failed`; the submit control disappears, terminal actions appear, and request episode/release snapshots remain accurate. Change episode/New search are disabled during active processing and re-enabled at terminal state.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: release rows no longer render the secondary Comet/Stremio decorated title line. The raw filename/title identity and normalized badges remain unchanged.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: release filters map metadata to compact user-facing categories without mutating releases: `2160p / 4K`, `1080p`, `720p`, `480p`; `HEVC / x265`, `AVC / x264`, `AV1`, `VP9`; and `HDR / HDR10`, `Dolby Vision`, `HLG`. Choices derive from the complete deduplicated dataset. Optional numeric Max size is blank/unlimited by default; unknown-size releases are excluded only when a maximum is explicitly active. Large season packs are never capped by default.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: a per-release overflow menu offers Copy magnet and Copy infoHash. The magnet is locally reconstructed from the validated 40-character infoHash and display name; no raw/provider URL is exposed.
- INVESTIGATED / DEFERRED: normalized Stremio objects may internally contain `infoHash`, `nzbUrl`, HTTP stream URL, and raw addon data. Torrent magnet URLs are normalized into `infoHash`; browser-safe API projection intentionally omits `raw`, `url`, and `nzbUrl`. Provider URLs can be provider-specific or sensitive. Direct download is not implemented because an entire-season torrent cannot safely become a one-episode browser download without duplicating importer inspection/file-selection logic and bypassing the proven Request Episode workflow.

## Architecture as implemented

- One production Node process serves both static files in `src/ui` and `/api/*` from the same origin. There is no UI compilation step or frontend dependency; the static ES-module UI is copied into the production image.
- `src/server/index.js` starts the HTTP server; `src/server/app.js` owns routing and browser-safe response projection.
- Title and episode metadata are fetched server-side from Cinemeta through `src/lib/metadata/cinemeta.js`.
- Release discovery calls the existing `searchMedia()` path. Stremio normalized releases are enriched server-side through the existing TorBox cache API adapter.
- `QueueImporterClient` implements the importer-client boundary. Submission delegates to the existing atomic `queueHandoff()` writer with an explicit `incoming` directory.
- Status is observed read-only by locating `<requestId>.json` in `/requests/incoming`, `/requests/processing`, `/requests/done`, or `/requests/failed`.
- Container paths: `/app` for immutable application files and `/requests` for the shared queue. `/config` is not needed by the current implementation.
- Environment variables currently read: `PORT`, `HOST`, `REQUESTS_ROOT`, `TORBOX_API_KEY`, `CINEMETA_BASE_URL` (optional metadata-service override).
- Compose adds supplementary GID 100 while preserving the image's `node` UID/GID 1000. This is required for the verified host spool owned `99:100` with setgid/group-writable directories.
- Deviation: the UI is static ES modules rather than framework-compiled assets because the repository had no frontend toolchain and the MVP needs no build-time transformation. It remains a single same-origin production server/container.

## Important invariants

- Explicit episode intent is independent from release granularity. `tt2085059:7:3` always creates TV episode intent with `season: 7` and `episodes: [3]`.
- Selecting a season-pack release never expands `[3]`; release titles and contents do not modify intent.
- The live Black Mirror S07E03 season-pack acceptance test proved this invariant through import: exactly E03 was selected/downloaded while the pre-existing season pack remained untouched.
- media-search never selects physical torrent files and contains no importer materialization logic.
- media-search never reads importer SQLite and never calls importer shell scripts.
- The shared four-directory request queue is the v1 importer boundary.
- TorBox credentials are used server-side only. API releases use an allowlist and exclude raw addon/provider data.
- Unsupported request scopes fail closed in server-side validation.

## Files changed

- `package.json`: adds production start, development, and Node test scripts.
- `src/lib/search.js`: retains authoritative discovery behavior, adds dependency injection for tests, and maps TorBox enrichment failures to explicit unknown state instead of losing all releases.
- `src/lib/requests/queue.js`: retains atomic write/rename and accepts an optional target directory; legacy default behavior remains when no request root is configured.
- `src/lib/importer/client.js`: future-compatible importer-client interface.
- `src/lib/importer/queue-client.js`: shared-spool submission and lifecycle observation.
- `src/lib/metadata/cinemeta.js`: server-side title search and TV episode metadata, including optional episode thumbnail/date fields for the anchored picker.
- `src/server/app.js`: validated HTTP API, browser-safe release projection, static UI serving, health endpoint.
- `src/server/index.js`: production entry point.
- `src/ui/index.html`, `src/ui/styles.css`, `src/ui/app.js`: functional single-episode workflow and status polling.
- `src/ui/release-model.js`: pure exact-hash deduplication, cached/resolution/size ordering, filtering, and summary logic shared by UI and Node tests.
- `test/*.test.js`: intent/release invariant, queue lifecycle, cache-state, secret-boundary, static/API, and request validation tests.
- `Dockerfile`, `compose.yaml`, `.dockerignore`, `.env.example`: non-root single-container production packaging and shared queue configuration.
- `README.md`, `deploy.sh`: exact Unraid instructions and host-configurable project copy helper; no development host is hard-coded.
- `docs/importer-progress-design.md`: DESIGNED/DEFERRED importer-authored atomic structured progress contract; no log/SQLite parsing and no implementation claim.

## Existing authoritative modules

- `src/lib/requests/intent.js` remains unchanged and authoritative for parsing Stremio episode IDs from the end, including IDs whose base contains a colon.
- `src/lib/requests/handoff.js` remains unchanged and authoritative for handoff schema and release projection.
- `src/lib/requests/queue.js` remains authoritative for atomic write-then-rename; only optional destination injection was added so the queue client can target `incoming`.
- `src/lib/search.js` remains authoritative for normalized discovery and TorBox enrichment; it was minimally adapted to expose unknown provider state and permit isolated tests.
- `src/lib/providers/torbox.js`, `src/lib/stremio/manifest.js`, `src/lib/stremio/normalize.js`, and `src/lib/stremio/search.js` remain unchanged.

## Tests and verification

- Baseline before changes: `npm test` failed because no test script existed.
- Most recent `npm test`: VERIFIED, 6 test files passed (16 tests), 0 failed (2026-08-19).
- VERIFIED: intent/handoff season-pack invariant, movie request acceptance and handoff, queue filesystem lifecycle, cache enrichment/unknown state, route/static behavior, request validation, handoff construction, TorBox state through API projection, and secret/raw-data exclusion.
- VERIFIED LOCALLY (MOVIE BRIDGE): `handoff/movie-importer-bridge/tests/movie-request-bridge.sh` passes 100%, covering `worker.sh` `NOT EXISTS` legacy query exclusion (ensuring request-linked and failed-validation jobs are never processed by the legacy crawler while unrequested legacy jobs remain supported), multi-request shared-hash fail-safe retention, non-terminal job filtering, terminal state sync (`done`, `already_present`, `failed`), Radarr TMDB/IMDb match validation, and fail-closed settlement on identity mismatch.
- VERIFIED LOCALLY: Compose regression test preserves `USER node`, supplementary GID 100, and rejects a root user override; release-model tests prove exact-hash-only deduplication, cached-first/resolution/size ordering, distinct hashes with identical titles, filtering, and counts.
- VERIFIED LOCALLY: release filter choices are derived from the complete normalized dataset in stable `2160p`, `1440p`, `1080p`, `720p`, `576p`, `480p`, then other ordering; codecs are stable alphabetical. Selection identity tests prove null/different hashes are not selected and case-equivalent exact hashes are selected. Static server tests prove all stable-name UI assets revalidate with `no-cache`.
- VERIFIED LOCALLY: pure pane-state tests cover processing, done, and failed terminology/action state. Full suite remains 6 test files, 0 failures.
- VERIFIED LOCALLY: category-option tests cover normalized resolution/codec/HDR vocabularies from the full dataset; max-size tests prove blank means unlimited and explicit limits apply; utility tests expose only validated infoHash plus reconstructed magnet and reject invalid/provider-link inputs. Asset version is now `ux4`.
- VERIFIED: `node --check` for production entrypoint/server/UI and `git diff --check`.
- ENVIRONMENT LIMITATION: this Codex sandbox rejects localhost binds with `listen EPERM`. Tests use an in-process/no-socket request harness. The production entrypoint still uses normal `server.listen(PORT, HOST)`.
- VERIFIED ON UNRAID: actual TCP listener, Docker image build/start, health endpoint, non-root UID 1000, real Cinemeta/Comet/TorBox browser workflow, queue handoff, importer lifecycle, selective import, cleanup ownership, and done state.
- VERIFIED LIVE ACCEPTANCE: browser confirmation displayed `Black Mirror S07E03` and `Requested episode only`; the emitted request retained exact episode intent and the importer materialized exactly one episode file.
- LOCAL CODEX ENVIRONMENT: `docker build -t media-search:local .` cannot run because no Docker, Podman, Buildah, or nerdctl CLI is installed. The production image build itself is separately VERIFIED ON UNRAID for the pre-stabilization baseline; the stabilization changes still require redeploy verification.
- TIMING INSTRUMENTATION VERIFIED BY TESTS: API responses now report title/media totals and release `discoveryMs`, `torboxMs`, and `totalMs`. BEFORE/AFTER LIVE TIMINGS NOT YET MEASURED; redeploy and record representative Black Mirror queries before adding server caches.

## Deployment

- Required environment variable by name: `TORBOX_API_KEY`.
- Required discovery configuration by name: `STREMIO_ADDON_MANIFEST_URL`.
- Optional/configuration environment variables: `MEDIA_SEARCH_PORT`, `REQUESTS_HOST_PATH`, `PORT`, `HOST`, `REQUESTS_ROOT`, `CINEMETA_BASE_URL`.
- Queue mount: `${REQUESTS_HOST_PATH}` -> `/requests`; Compose sets `REQUESTS_ROOT=/requests`.
- Queue permission requirement: keep container user `node` UID/GID 1000 and add supplementary GID 100 in Compose so it can write a host spool owned `99:100` with mode `2775`. Verified request files are created as `1000:100`.
- Healthcheck URL is `GET /health`.
- On Unraid: copy `.env.example` to `.env`, set required values, then run `docker compose build && docker compose up -d && docker compose ps && curl --fail http://localhost:${MEDIA_SEARCH_PORT:-3000}/health`.
- `MEDIA_SEARCH_PORT` must not collide with another Unraid host service; 3000 is valid but commonly occupied.

## Current blockers / known issues

- ENVIRONMENT LIMITATION: localhost listener verification cannot run in the Codex sandbox. This is not an application blocker; the normal TCP listener is verified on Unraid and production architecture must remain unchanged.
- ENVIRONMENT LIMITATION: Docker image build cannot run because no Docker-compatible CLI is installed.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: the live-found selection, viewport accessibility, filter layout/options, summary, and stale-asset issues are fixed locally and covered where practical by tests.
- NON-BLOCKING: status lookup reports only lifecycle and does not expose a safe failure message.
- NON-BLOCKING: the discovery manifest URL is supplied as an environment value; operators must use a discovery-only addon configuration and avoid embedding debrid credentials.
- INTENTIONALLY DEFERRED: importer HTTP transport and unsupported media/request scopes.

## Next recommended work

1. Redeploy on Unraid and verify the grid-contained sticky pane begins beside releases, never overlaps search/drill-down/requested context, appears only after loading settles, and transforms Confirm -> In progress -> Complete/Failed during a real request.
2. Capture representative API/UI timing values for title search, media detail, Stremio discovery, TorBox enrichment, and total Find Releases latency; record before measurements here.
3. Add only evidence-supported short-lived bounded caching, then measure and record after values. Cache availability state only briefly.
4. Re-run the Black Mirror S07E03 season-pack acceptance flow to ensure the stabilization pass did not regress exact intent or importer behavior.
5. Coordinate `docs/importer-progress-design.md` with torbox-importer before implementing optional `/requests/status/<requestId>.json` support.
6. Consider a read-only server-side TorBox account view only after stabilization is live-verified; do not add destructive operations.

## Repository state

- Branch: `master`.
- Latest existing commit: `da8667d Add atomic request queue handoff`.
- Current `git status --short`: modified `.gitignore`, `Dockerfile`, `compose.yaml`, `deploy.sh`, `package.json`, `src/lib/requests/queue.js`, `src/lib/search.js`, and `src/lib/stremio/search.js`; untracked `.dockerignore`, `.env.example`, `CODEX.md`, `README.md`, `ai-handover.md`, `docs/`, `src/lib/importer/`, `src/lib/metadata/`, `src/server/`, `src/ui/`, and `test/`.
- No commits have been made during this session.

## Continuation instructions

Read all of CODEX.md first.
Treat the architectural contract above as binding.
Read this handoff section for current implementation state.
Inspect the cited files before changing architecture.
Run the existing tests before modifying code.
Continue from "Next recommended work".
Do not redo completed work unless verification shows it is broken.

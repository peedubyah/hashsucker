# media-search AI handover

Read all of `CODEX.md` first. Its architectural contract is binding; this file is the concise operational continuation record.

## Verified baseline

VERIFIED LIVE ON UNRAID (2026-08-19): the Docker image builds and runs as non-root `node` UID/GID 1000, the production listener is LAN-reachable, and `GET /health` returns HTTP 200 `{"ok":true}`. Real Cinemeta title navigation, Comet release discovery, and TorBox cache enrichment work.

VERIFIED LIVE END TO END: Black Mirror S07E03 was selected and submitted entirely in the browser from a cached season-pack release. The request retained `mediaType: tv`, `scope: episode`, `season: 7`, `episodes: [3]`. The UI observed queued; torbox-importer claimed it, selected/downloaded exactly E03, completed Sonarr ManualImport and post-import verification, deleted its request-owned TorBox source, preserved an older TBM-owned season pack, and finalized the request under `/requests/done`. Sonarr showed E01/E02/E03 present.

This is the product baseline. Do not regress it.

## Runtime and permissions

- One Node container serves static UI and `/api/*`; normal production TCP listener remains in `src/server/index.js`.
- Shared queue command/status transport: `/requests/{incoming,processing,done,failed}` through `QueueImporterClient`.
- Image user remains `node` UID/GID 1000. The live spool is owned `99:100`, directories mode `2775`/setgid. Compose must add supplementary GID 100. Verified created request ownership is `1000:100`.
- Server-side configuration names: `TORBOX_API_KEY`, `STREMIO_ADDON_MANIFEST_URL`, `REQUESTS_ROOT`, `PORT`, `HOST`; Compose also uses `MEDIA_SEARCH_PORT` and `REQUESTS_HOST_PATH`.
- Provider credentials never reach the browser. media-search never reads importer SQLite, calls importer scripts, chooses torrent files, or infers episode scope from releases.

## Stabilization implementation state

- IMPLEMENTED + LOCALLY VERIFIED: `compose.yaml` adds supplementary GID 100 and preserves non-root `USER node`; README documents the `99:100`, `2775`/setgid queue model and host-port collision avoidance.
- IMPLEMENTED + LOCALLY VERIFIED: exact-infoHash-only deduplication, cached-first then resolution/size stable ordering, cached/resolution/codec/HDR filters, summary counts, and 100-row incremental rendering. Distinct hashes remain distinct even when titles match; large season packs remain available.
- IMPLEMENTED BUT NOT LIVE-VERIFIED: compact release workspace with sticky episode context and desktop selection/status pane; mobile uses a sticky bottom pane. The panel preserves Requested, Selected release, Cache state, and `Requested episode only` plus an always-reachable Request action.
- IMPLEMENTED BUT NOT LIVE-VERIFIED: debounced 325 ms search-as-you-type with minimum two characters, AbortController cancellation, latest-query sequence protection, and retained Search/Enter behavior.
- IMPLEMENTED BUT NOT LIVE-VERIFIED: coarse status stays in the sticky pane, duplicate submit remains disabled, terminal state is visually distinct, request UUID is under details, and Request another episode returns to the picker.
- IMPLEMENTED + LOCALLY VERIFIED: timing fields for title/media totals and release discovery/TorBox/total latency. No speculative server cache was added.
- DESIGNED / DEFERRED: `docs/importer-progress-design.md` proposes importer-authored atomic `/requests/status/<requestId>.json` with coarse fallback. It is not implemented and does not parse logs/stdout or read SQLite.
- FAILED LIVE VERIFICATION ON UNRAID: selection visuals can imply selection while the confirmation remains empty; the supposed sticky pane falls below the full list; filter controls appear detached/raw; result/cached/filtered counts are not obvious; and Resolution/Codec options remain empty despite normalized row metadata. These are active Priority-1 regressions.
- PASSED LIVE IN THAT BUILD: cached-first order, dense release rows, normalized metadata readability, large-list rendering, real E04 discovery/TorBox enrichment, and exact Black Mirror S07E04 context.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: one tested exact-hash selection predicate now drives row styling; selected rows have an explicit badge, neutral focus is visually separate, `[hidden]` is enforced, and selection persists through filtering/rerendering.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: desktop uses a viewport-fixed 320px action/status pane with list space reserved; mobile uses a fixed bottom pane.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: filters are contiguous labeled controls; option sets come from the full deduplicated normalized dataset with tested resolution/codec ordering; summary shows total, cached, showing, and resolution counts.
- FIXED LOCALLY: unfingerprinted JS/CSS previously cached for one hour and could mix deployment versions. Static UI responses now use `Cache-Control: no-cache`, and HTML uses a new asset-version query to bypass already-cached prior responses; tests cover both.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: a single search-anchored popover transforms through debounced title rows, season list, and compact episode rows (title, code, date, optional thumbnail) with Back/Cancel. Exact episode selection alone commits intent and starts releases. Only the progressive-disclosure pattern was adopted—not TorBox Manager styling, navigation, provider flow, API, or semantics.
- VERIFIED LIVE ON UNRAID: anchored search/drill-down, thumbnails, exact-episode automatic discovery, summary/counts, cached-first dense rows, distinct Selected state, and the action/status pane concept work. A browser-originated Black Mirror S07E04 request visibly moved QUEUED -> PROCESSING -> DONE and completed importer/Sonarr successfully with exact single-episode semantics.
- VERIFIED LIVE TIMING: about 146 ms discovery, 504 ms TorBox, 650 ms total. Do not add speculative caching; retain timing instrumentation.
- LIVE POLISH TEST FOUND: globally fixed pane overlapped/appeared beside unrelated search UI and before release layout settled; pane remained a stale Confirm state after submission; secondary row text exposed Comet emoji/provider decoration.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: results now use a two-column grid with a grid-contained sticky pane; loading is staged before filters/workspace/pane become visible, preventing the premature floating card.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: pane replaces Confirm with In progress, then Complete/Failed and terminal actions. Submit disappears after successful submission; active request context is snapshotted and episode/new-search changes are disabled until terminal state.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: secondary Comet-decorated row text is removed; raw release identity and normalized metadata remain.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: compact filters use normalized display categories for resolution, codec, and HDR; optional Max size GB is blank/unlimited by default. Options come from the full deduplicated dataset and do not collapse during filtering.
- IMPLEMENTED BUT NEEDS LIVE REDEPLOY VERIFICATION: per-row overflow safely copies a locally reconstructed magnet or validated infoHash. Browser API still excludes raw/provider URLs.
- INVESTIGATED / DEFERRED: normalized internals can contain infoHash, NZB/HTTP URLs, and raw addon data, but the public API intentionally allowlists infoHash and metadata. Direct download is unsafe for season packs because browser-side behavior cannot select only the requested episode without duplicating importer logic; keep Request Episode as the primary path.

Read-only TorBox account view, recent activity, rich progress implementation, and all destructive provider operations remain deferred.

## Next work

1. Redeploy and verify results-grid sticky placement, loading transition, Confirm/In progress/Complete/Failed lifecycle, and clean normalized rows with a real long-list request.
2. Record representative live timing values shown for title/media/discovery/TorBox/total latency.
3. Optimize only if those measurements identify a bottleneck; use short-lived bounded caches and record before/after values.
4. Repeat Black Mirror S07E03 from a season pack through `/requests/done` to prove no stabilization regression.
5. Coordinate the structured progress proposal with torbox-importer before implementing it.

## Verification state

- VERIFIED locally after latest polish: `npm test` passes 5 test files, 0 failures. Tests cover deployment identity/group, request invariants, queue lifecycle, release/filter/category/max-size/utility/selection/pane models, cache/timings, versioned API/static behavior, and browser-secret exclusion. `node --check` and `git diff --check` pass.
- VERIFIED live externally: Docker build/listener/browser/importer/Sonarr acceptance flow described above.
- IMPLEMENTED BUT NOT LIVE-VERIFIED: the new stabilization UI and timing display. The Codex sandbox cannot bind localhost; production TCP architecture remains normal and already proved live before this pass.
- Keep both this file and the `# Current Implementation Handoff` section of `CODEX.md` accurate after each substantial milestone.

## Repository state

- Branch: `master`; latest existing commit: `da8667d Add atomic request queue handoff`.
- Current modified tracked files: `.gitignore`, `Dockerfile`, `compose.yaml`, `deploy.sh`, `package.json`, `src/lib/requests/queue.js`, `src/lib/search.js`, `src/lib/stremio/search.js`.
- Current untracked work: `.dockerignore`, `.env.example`, `CODEX.md`, `README.md`, `ai-handover.md`, `docs/`, `src/lib/importer/`, `src/lib/metadata/`, `src/server/`, `src/ui/`, `test/`.
- No commits were made in these implementation sessions.
- Run `npm test` before and after meaningful changes. Do not commit unless requested.

## Continuation rule

Read `CODEX.md`, inspect the cited implementation, run tests, then continue from the current iteration list. Do not redo verified work unless verification shows it is broken.

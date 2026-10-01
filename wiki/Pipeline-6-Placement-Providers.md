# Stage 6 — Provider Placement and Acquisition

Placement answers "where do the bytes live right now" as durable
inventory. Acquisition (adding to a provider) is bounded and deliberate;
observation is cheap and constant.

## TorBox path

- Cache check: `providers/torbox.js:checkTorBoxCached` (`checkcached`,
  chunked) + `observe` (cached/uncached/unknown, 5-minute TTL).
- Inventory: `torbox-inventory.js` (`mylist?bypass_cache`, per-request
  coordinator: single-flight + memo + retry, snapshot invalidation).
- Placement: `createPlacement(add_only_if_cached)` — binding/probing must
  never turn into an uncached provider download.
- Identity: `resolver/torbox-file-identity.js:ensureTorBoxFileIdentity`.
- Delivery/repair: `resolver/torbox-delivery.js` (reuse-or-create,
  single-flight repair, mark-removed + recreate).
- Execution submit needs `getMagnetForIdentity` with `addOnlyIfCached:true`.
- Budgeting: `torbox-call-budget.js` + `torbox-call-coordinator.js`
  (bounded 5xx/429 retry).
- CDN/download URLs: `resolver/torbox-download-url-cache.js` —
  process-local, never persisted, never logged, TTL + backoff.

## Real-Debrid path

- Client: `providers/realdebrid/client.js` (bounded torrent listing,
  addMagnet, info, selectFiles, deleteTorrent); global 60s cooldown, max
  1 retry, `RdCooldownError`, fail-fast `resolverSafe`, honors Retry-After.
- Placement/observe: `placement.js`, `observe.js`, `ensure.js`
  (durable-first revalidate, hygienic probe delete, select-only-mapped +
  `status==downloaded`).
- Resolution cache: `rd-resolution-cache.js` (TTL; exact behavior
  unconfirmed — see Source gaps).
- Unknowns: exact RD cache TTL in ms is unconfirmed from code.

## Durable vs ephemeral

Durable (SQLite): placements, ProviderFile/TorrentFile rows, observation
events, readiness observations, inventory snapshots, candidate file
mappings, handoffs, historical evidence. Ephemeral: live cache hints,
`mylist` snapshots, CDN URLs, `providerState` inside handoffs
(point-in-time only).

## Error taxonomy (`providers/errors.js`)

`authentication, authorization, rate-limit, timeout, network, not-found,
conflict, invalid-request, invalid-response, temporarily-unavailable,
unsupported, unsafe-operation, infringing, unknown` via
`ProviderOperationError`/`classifyProviderError`. RD adds
`RdResolutionError` codes + `RdCooldownError`; TorBox adds
`TORBOX_FILE_IDENTITY_ERROR_CODES` (`NO_PLACEMENT`,
`INVENTORY_UNAVAILABLE/ERROR`, `AMBIGUOUS_FILE_SIZE`, etc.).

## Source references

- `media-search/src/lib/providers/`, `media-search/src/lib/resolver/torbox-*.js`,
  `media-search/src/lib/control-plane/rd-placement-realizer.js`

# Discovery and Ranking

How a release becomes a ranked candidate, and how a request becomes a selection. For the HTTP
surface see [`architecture.md`](architecture.md); for what happens after selection see
[`playback-delivery.md`](playback-delivery.md).

## 1. Sources

| Source | Kind | Wired via |
|---|---|---|
| DMM hashlists | Corpus ingest, automatic lifecycle | scheduler + `POST /api/corpus/update` → `discovery/corpus-lifecycle.js` |
| Torrentio | Live Stremio add-on | `stremio/search.js` |
| Comet | Live Stremio add-on | `stremio/search.js` |
| Torznab | Live indexer search | `torznab/torznab.js`, indexers from `TORZNAB_URLS` |
| Prowlarr/TPB | Live tracker search (candidate intelligence only) | `discovery/prowlarr.js` → same live merge/rank; `PROWLARR_URL` + `PROWLARR_API_KEY` |

Prowlarr rows carry tracker provenance (`prowlarr` origin) but tier exactly
like equivalent live rows (relevance 0.7 input handicap, same ranker and
weights). Whole-torrent sizes are never presented as per-file sizes, and
key-bearing Prowlarr URLs are never logged or stored — only bare infoHashes.
Same-hash rows dedupe to the established source position; failures isolate
per-source via `Promise.allSettled` plus a bounded search timeout.

Anti-bot boundary: HashSucker consumes Prowlarr's normalized search surface
only (`/api/v1/search`, `/indexer`, `/health`). Tracker challenges, proxies,
and helpers (Trawl/Byparr/FlareSolverr) are configured between Prowlarr and
the helper, never in HashSucker. No browser automation or challenge bypass
exists here by design.

The two live adapters run concurrently through `Promise.allSettled`; a source that fails degrades
to a count of zero rather than failing the search. Live discovery runs only when the corpus has
nothing for the requested media.

The corpus lifecycle keeps a revision-pinned DMM baseline: blank deployments
bootstrap automatically (resumable, never advertised partial), then a scheduler
applies compare-based deltas every few hours. Revision advances only on fully
successful updates; failures preserve the last-good corpus. Request outcomes
are backfilled as candidate→media associations, so the corpus incrementally
learns to serve previously-requested media. See `architecture.md` (Discovery
and requests) and `corpus` in `GET /api/diagnostics`.

## 1b. Corpus identity (media-addressable corpus)

Raw DMM records carry almost no explicit identity (~0.1% embed IMDb/TMDB
markers; the rest is release names). Parsed release attributes give exact
title/year for ~41% of rows and exact season/episode for ~36%; ~23% are
effectively unidentifiable. Identity confidence tiers:

- **STRONG** — explicit upstream IDs or high-confidence request-outcome
  associations (served via `candidate_media`).
- **STRUCTURED** — exact normalized title (+year for movies, +S/E for
  episodes) resolved against the local FTS title index. The only fuzzy-free
  automatic tier besides STRONG.
- **WEAK** — release-name-only inference. Never auto-populates; diagnostic only.

For a wanted identity, `discovery/corpus-identity.js` resolves title/year
(caller-supplied canonical identity, else one cached metadata lookup — never
a fanout) and returns STRUCTURED candidates into the normal ranking pipeline
under unchanged weights. The 4,446-row `identity_enrichment_queue` (per-row
external enrichment, no consumer) is deliberately not finished: feeding it
would be an external-call fanout, and the title index answers the same need
with zero network calls.

## 2. Canonicalization and merge

Local and live candidates are normalized into one evidence shape
(`toCanonicalLocal` / `toCanonicalLive`) and merged on exact `releaseKey` by
`deduplicateByReleaseKey`. Consequences that matter:

- Merge identity is exact `releaseKey`, never the info hash alone and never a release family.
  Same-hash file indexes and torrent-level evidence stay distinct.
- Higher-confidence evidence wins per field.
- **Source origin does not determine desirability.** Evidence does.
- Provider cache hints from Torrentio and Comet are evidence, not authoritative observations.
- Deterministic tie-breakers make identical input produce identical ordering.
- Reported `total` is the post-merge count, not a whole-corpus count.

## 3. Score model

One global rank over the merged pool:

```text
S = 0.25·R + 0.20·Q + 0.20·Cr + 0.15·Ci + 0.10·P + 0.10·E
```

| Term | Weight | Meaning |
|---|---|---|
| `R` relevance | 0.25 | Title and metadata match |
| `Q` quality | 0.20 | Resolution 40% + source 30% + codec bonus + HDR 0.15 |
| `Cr` releaseConfidence | 0.20 | Corpus evidence strength |
| `Ci` identityConfidence | 0.15 | From `candidate_media`, or live provider scoping |
| `P` providerAvailability | 0.10 | Fresh authoritative availability observation |
| `E` episodeMatch | 0.10 | Season/episode fit |

Unknown or missing data scores `0.5` (`NEUTRAL`) — it is neutral, never a penalty. There is no
learned or ML component anywhere in the score.

## 4. Confidence tiers

Candidates are bucketed first, then ranked within a bucket. Bucket order is the primary ordering
signal; score only orders inside a bucket.

```text
Verified → ProviderConfirmed → Probable → ProviderScoped → TextOnly → Rejected → Ineligible
```

| Tier | Meaning | Confidence |
|---|---|---|
| `Verified` | Explicit `candidate_media` association to the requested media; strengthened to 1.0 on season/episode match | 0.9 |
| `ProviderConfirmed` | Live provider returned it scoped to the requested media **and** independent title or S/E evidence agrees | 0.8 |
| `Probable` | Strong corpus or title match but no explicit association; also bare live discovery with no provider scoping | 0.5 |
| `ProviderScoped` | Live provider scoped to the media, but no independent identity evidence | 0.4 |
| `TextOnly` | Retrieved only by search-text similarity | — |
| `Rejected` | No target media, or associated with a different media | 0.0 / 0.1 |
| `Ineligible` | Excluded by an eligibility override | — |

Note the ordering: `Probable` outranks `ProviderScoped`. A provider saying "yes, I have this for
that ID" with nothing else to corroborate it is weaker evidence than a strong metadata match.
That is deliberate — provider scoping alone has been wrong often enough to not be trusted.

## 5. Eligibility

Hard eligibility is applied before preferences: selected-media association, explicit episode
compatibility, acceptable candidate shape, and policy constraints. Quality, size, seeders,
desirability, and predicted cache likelihood are preferences, never identity proof.

Rejections are tracked rather than silently discarded, so a candidate that disappears is
attributable to a reason.

## 6. Endpoints and which pipeline they use

| Path | Pipeline |
|---|---|
| `GET /api/search?mediaId&type` | `combinedSearch` — corpus plus live, 2000-row retrieval window, projected to public DTOs. The UI path. |
| `GET /api/search/internal` | `searchReleases` — corpus FTS5 only, no live discovery |
| `GET /api/search?q=` | `searchTitles` — Cinemeta title search, **not** release search |
| `GET /api/media?type&id` | Cinemeta media details |
| `POST /api/media-request` | `searchByMedia` — the canonical request pipeline |
| `POST /api/requests` | Physical acquisition handoff |

## 7. The request pipeline

`searchByMedia` (`media-search/src/api/media-request.js`) is the single convergence point. Every
ingress — Seerr webhook, Plex Watchlist script, direct API call — lands here.

```text
parse intent (createRequestIntent)
  → corpus candidates by media
  → live discovery only if corpus is empty
  → eligibility / rejection
  → rankHitsTiered
  → availability check
  → selectBestCandidate
  → persistMediaRequest
  → buildPlaybackHandoff
  → publish .strm
  → notify Jellyfin
```

`createRequestIntent` parses the media ID into a scope. Movies give
`{ mediaType: 'movie', scope: 'movie' }`. Series parse a trailing `:season:episode` from the end
of the ID so that colon-bearing base IDs such as `tmdb:1399:1:1` work; a match yields
`scope: 'episode'`, otherwise `scope: 'series'`.

## 8. Ingress

### Seerr webhook

`POST /api/ingress/seerr`, bearer-authenticated against `SEERR_WEBHOOK_TOKEN` with a constant-time
compare; the service fails closed with 503 if the token is unconfigured.

1. Envelope validation and intent construction. Requires `request_id` and `media`; requires at
   least one of IMDb, TMDB, or TVDB; ignores test notifications and non-approval events.
2. Idempotency on exact `(source, source_id)` — a repeat returns `duplicate`.
3. **TMDB→IMDb translation at the boundary**, only when no IMDb ID is present. Calls Seerr's
   own API for the external IDs. On failure the intent is persisted with `last_error` and the
   request fails — a `tmdb:` ID is never fed to the IMDb-keyed pipeline.
4. Persist the durable intent with all three IDs.
5. Advance through `searchByMedia`. Success clears `last_error`; failure records it and returns
   500. Nothing retries automatically.

### Plex Watchlist

`scripts/plex-watchlist-ingest.mjs` is a **manually run host script**. There is no cron, timer, or
scheduler — nothing invokes it automatically. It imports `searchByMedia` directly and runs it
in-process rather than calling an HTTP endpoint. Movies only. Per item it fetches the cloud
watchlist, resolves GUIDs from `/library/metadata/{ratingKey}`, prefers IMDb then TMDB, and
deduplicates on `(source, source_id)`.

Source vocabulary: `source: 'plex-watchlist'`, `sourceType: 'plex'`,
`sourceId: 'plex://movie/<ratingKey>'`.

### Multi-ID persistence

`media_intents` carries `imdb_id`, `tmdb_id`, and `tvdb_id` as three nullable columns, written by
`upsertMediaIntent` with COALESCE on update. The operational `media_id` is always the IMDb form
when one is resolvable.

## 9. Metadata

`Cinemeta` is the only metadata provider, behind an adapter with an in-memory TTL/LRU cache.

- **Trustworthy:** `GET /meta/{type}/{id}.json` — direct lookup by a known IMDb ID. Returns
  normalized `id`, `type`, `title`, `year`, poster and backdrop URLs, overview, and `videos[]`
  for series.
- **Unusable:** `GET /catalog/{type}/top/search={q}.json` returns static popular results
  regardless of the query. It cannot be used for identity resolution at all. An IMDb-shaped query
  short-circuits to the `/meta/` path; a free-text query does not, which is a live defect in
  `GET /api/search?q=`.

Enrichment findings are additive: `candidate_media` rows are inserted and upserted but never
deleted, so an association is never retracted. Associations are enrichment, not a retrieval gate —
except that when `mediaId` is set, identity confidence is scoped to that media's association only.
Treat enrichment as a hint generator, not an authority.

## 10. What is persisted

Every request writes: a `media_request` row, one `media_request_results` row per rank (including
`identity_tier` and the score breakdown), and a `playback_handoffs` row for the selection.
`/api/debug/search-trace` and `/api/debug/search-decisions` expose the trace.

## 11. Known divergences

- `combinedSearch` (the `/api/search` path taken when both `type` and `mediaId` are supplied)
  applies a fixed Stage 1 retrieval window before composite ranking — default 2000 rows,
  overridable only by `RETRIEVAL_WINDOW`. The public `limit` paginates the ranked result and never
  determines which candidates can win.
- DMM ingestion fails against current source fragments (see §1); the compatible importer is
  unwired.
- Enrichment has no retraction lifecycle: a `candidate_media` association can be overwritten but
  never removed.

# Stage 4 — Ranking and Representation Selection

Ranking picks exactly one playable file and explains every rejection.
Weights (`lib/discovery/ranking.js`): relevance .25, quality .20,
releaseConfidence .20, identityConfidence .15, providerAvailability .10,
episodeMatch .10. Order: score → releaseConfidence → quality →
relevance → hash → fileIndex. Tiers, best first: Verified,
ProviderConfirmed, Probable, ProviderScoped, TextOnly, then
Rejected/Ineligible.

## Hard filters (any one kills the candidate)

Identity eligibility (`evaluateIdentityEligibility`): title mismatch, low-
information parsed title, movie year mismatch, season/episode mismatch,
season-pack mismatch, Prowlarr season contradiction / unverifiable episode.
Episode coverage (`episode-coverage.js:coversEpisode`): wrong season/
episode, out-of-range, unknown coverage, malformed range. Tracker
(`rejection-tracker.js`): missing hash, duplicated, invalid release, low
metadata confidence, quality filter, below score threshold, paginated away.

## File inside torrent

`lib/resolver/tv-episode-resolver.js`: playable video extensions,
anti-sample, positive size; season/episode parsed from the
`canonicalInternalPath`; zero matches → `EPISODE_NOT_FOUND`, more than
one → `EPISODE_AMBIGUOUS`, non-video → `EPISODE_NOT_PLAYABLE`. RD-side
classification in `providers/realdebrid/resolve.js` (single-playable
select, else filename+size; `RD_FILENAME_FILTER_RULES`).

## Selection with binding paths (`lib/discovery/selection.js`)

`selectBestCandidate` (eligible only, cached > unknown > uncached);
`selectBindableCandidate`: PATH A exact-size TorBox ensure, PATH B
movie-single-file / TV-episode via cached-only placement, PATH C RD
ensure. Fallback is TV-only, cached-first; skipped paths carry typed
reasons (`NO_PLACEMENT`, `INVENTORY_UNAVAILABLE`, `movie-ambiguous`,
`tv-resolution-failed`, `rd-*`, deferred-uncached-unattempted).
`resolver/alternate-fallback.js` + `availability-revalidation.js`
(`RevalidationError`, cached/uncached/unknown outcomes) govern retries.

## Candidate entering ranking (representative shape)

```js
{ hash:"ab…40", fileIndex:null, releaseKey:"ab…:torrent",
  filename:"Show.S01E01.1080p.WEB-DL.x265-GRP.mkv", relevance:0.83,
  releaseAttributes:{title,year,season:1,episode:1,resolution:"1080p",
    sourceType:"WEB-DL",codec:"x265",hdr:false,audio,releaseGroup},
  parserConfidence:0.9,
  mediaAssociations:[{mediaId:"tmdb:123",source,confidence,evidence}],
  providerObservations:[{provider:"torbox",accountScope:"default",
    kind:"authoritative",state:"cached",fresh:true}],
  sources:[{origin:"corpus"|"live",confidence}],
  selectedMediaId:"tmdb:123", selectedFileSize:1234567890,
  provenance:{source:"dmm-corpus"|"live",releaseKey,hash,discoveredAt} }
```

## Source references

- `media-search/src/lib/discovery/ranking.js`,
  `rejection.js`, `rejection-tracker.js`, `episode-coverage.js`,
  `selection.js`, `media-search/src/lib/resolver/tv-episode-resolver.js`,
  `alternate-fallback.js`, `availability-revalidation.js`

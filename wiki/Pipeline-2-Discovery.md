# Stage 2 — Discovery

Discovery answers "what releases exist for this intent" — nothing more.
It creates no identity and no provider state.

## Sources

**Live (authoritative per request):**

| Source | Code | Notes |
|---|---|---|
| Stremio addons | `lib/stremio/search.js` (`searchStremio`) | Torrentio/Comet-class manifests |
| Torznab/Jackett/Prowlarr | `lib/torznab/torznab.js`, `lib/discovery/prowlarr.js` | Indexer XML rows; hash from link/guid; unenforced S/E hints get a special ranking guard |
| Bloodhound path | `lib/discovery/live-bridge.js` (`runLiveDiscovery`, `runBloodhoundDiscovery`) | Alternate live path with episode classification |

Fan-out lives in `lib/search.js:searchMedia()` → `mergeStreams()`, then
`enrichAndFinalize()` annotates TorBox cache hints.

**Corpus (advisory, stored):**

- DMM-derived bulk ingest: `lib/discovery/adapters/dmm.js`,
  `lib/ingestion/dmm.js`, `lib/discovery/dmm-ingestion-runner.js`, lifecycle
  in `lib/discovery/corpus-lifecycle.js` (generations/fragments tables).
- FTS5 retrieval (`release_search` + triggers on `release_attributes`,
  window 2000) in `lib/discovery/search-engine.js`; parses year/SxxExx/
  resolution/source from the query.

## Normalization and dedup

`lib/discovery/canonical.js`: canonical candidate shape carries
`hash`, `fileIndex`, `releaseKey`, `relevance`, `releaseAttributes`,
`parserConfidence`, `mediaAssociations`, `providerObservations`,
`providerEvidence`, `sources`, `selectedMediaId`, `selectedFileSize`,
`provenance`. Dedup is exact-key only (`hash:fileIndex`, null ≠ 0);
merges take higher-confidence attrs, union media IDs and sources,
newest-wins provider evidence; conflicting `selectedMediaId` throws
rather than guessing.

Ingest boundary: `lib/discovery/ingest.js` (`ingestCandidates`) —
upserts, preserves `sources`, optional authoritative provider
observations, DMM provenance recorded.

## Cache behavior

`lib/discovery/cache.js` (`createDiscoveryCache`, `node:sqlite`,
30s maxAge): `candidates` PK `(info_hash, file_index_key)`,
`provider_observations` + event-sourced
`provider_observation_events/_current`, `candidate_media`,
`release_attributes` + FTS, `evidence_observations/_query`,
`historical_provider_evidence[_sightings]`,
`rd_download_observations/correlations`, request/result tables,
`playback_handoffs`, `vfs_movie/tv_entries`. Write-through with
failure isolation — on cache failure the live path still serves.

## Completeness limits and fallback

- Live remains authoritative; corpus never overrides a live observation.
- Torznab/Prowlarr S/E hints are untrusted until ranking verifies them.
- If live discovery is skipped or empty, ranking works the corpus and
  says so (`hasLiveDiscovery:false`); unfulfilled outcomes carry typed
  reasons rather than silent gaps.

## Source references

- `media-search/src/lib/search.js`, `media-search/src/lib/discovery/`,
  `media-search/src/lib/stremio/search.js`,
  `media-search/src/lib/torznab/torznab.js`

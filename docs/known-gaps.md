# Known Gaps

Unresolved work items, verified against current code (2026-08-21).

---

## Critical

### No Automated Scheduler
**Impact:** DMM ingestion, attribute parsing, and enrichment must be triggered manually.
**Required:** Cron or interval-based trigger for `DMMIngestionRunner.run()` and enrichment workers.
**Location:** No scheduler exists. `runDMMIngestion()` is API-triggered only.

### No Provider Observation Hydration
**Impact:** Provider cache state always empty. Search ranking cannot factor in TorBox/Real-Debrid availability.
**Required:** TorBox cache status worker. Real-Debrid cache status worker. TorBox library inspection.
**Location:** `provider_observations` table exists but no worker populates it.

---

## High Priority

### Parser Edge Cases
**Impact:** 11.3% of releases fail enrichment (per 62-sample evaluation).
**Issues identified:**
- Year-at-start filenames (`2001.A.Space.Odyssey.1968...`) — year extracted incorrectly
- Numeric titles (`1917`, `300`, `2012`) — year/title ambiguity
- Foreign language titles — Cinemeta match rate 75% for foreign films
- Packs/collections — not detected (e.g., "Trilogy", "Collection", "Saga")
**Location:** `src/lib/discovery/parser-adapter.js`

### No TMDB/IMDb Enrichment Source
**Impact:** Cinemeta-only enrichment misses titles with alternate names, non-English titles, or recent releases.
**Required:** TMDB enrichment source (requires API key). IMDb enrichment source.
**Location:** `src/lib/discovery/enrichment-sources/` — only `cinemeta.js` exists.

---

## Medium Priority

### Packs / Multifile / Archive Handling
**Impact:** Season packs and collections are not detected or handled specially.
**Required:** Parser patterns for "Complete Series", "Trilogy", "Collection", "Saga", etc.
**Location:** `src/lib/discovery/parser-adapter.js`

### DMM Lifecycle / Snapshot Strategy
**Impact:** No strategy for DMM hashlist rotation or historical retention.
**Required:** Decide on snapshot retention policy, handle hashlist fragment updates.
**Location:** No lifecycle management exists.

### Artwork Proxy/Cache
**Impact:** Poster URLs may break or be slow.
**Required:** Artwork proxy/cache layer.
**Location:** Artwork URLs passed through from Cinemeta/TMDB.

---

## Low Priority

### Future Metadata Providers
**Impact:** Limited to Cinemeta catalog.
**Required:** TMDB, TVDB, IMDb providers.
**Location:** `src/lib/metadata/` — only `cinemeta.js` exists.

### Future Playback/Provider Abstraction
**Impact:** TorBox is hardcoded as primary provider.
**Required:** Abstract provider interface for multi-provider support (Real-Debrid, Premiumize, etc.).
**Location:** `src/lib/providers/torbox.js` — only TorBox exists.

### StremThru/Zurg/RTN Research
**Impact:** Not yet evaluated for HashSucker use cases.
**Required:** Evaluate these tools for potential integration.
**Location:** No evaluation exists.

---

## Resolved (Historical Context)

These were previously gaps but are now implemented:

| Gap | Resolution |
|-----|-----------|
| Filename parsing | ✅ `parser-adapter.js` — 100% success on 62 samples |
| Cinemeta enrichment | ✅ `enrichment-sources/cinemeta.js` — 88.7% success |
| Confidence scoring | ✅ `enrichment-sources/confidence.js` |
| FTS5 search | ✅ `search-engine.js` |
| Media associations | ✅ `enrichment.js` — additive, higher confidence wins |
| Persistent storage | ✅ `cache.js` — SQLite WAL mode |
| Release attributes | ✅ `release-attributes.js` — evidence separate from identity |

# Media Identity Enrichment — Gap Analysis

**Date:** 2026-08-20
**Status:** Audit complete

---

## 1. Current State Summary

### 1.1 What EXISTS (Storage + Boundaries)

| Component | File | Status |
|-----------|------|--------|
| Media association storage | `cache.js` (`associateMedia`, `getMediaAssociations`, `queryCandidatesByMedia`) | ✅ Implemented and tested |
| Enrichment boundary API | `enrichment.js` (`enrichCandidate`, `enrichCandidates`) | ✅ Implemented and tested |
| Enrichment worker orchestration | `worker.js` (`runEnrichmentWorker`, `createEnrichmentWorker`) | ✅ Implemented and tested |
| Unenriched candidate query | `enrichment.js` (`getUnenrichedCandidates`) | ✅ Implemented and tested |
| Cinemeta metadata client | `metadata/cinemeta.js` (`searchCatalog`, `getMedia`) | ✅ Implemented (used for catalog search) |
| Release attributes (filename parsing) | `parser-adapter.js` + `release-attributes.js` | ✅ Implemented and tested |
| Confidence model | `enrichment.js` (documented) | ✅ Designed, partially implemented |

### 1.2 What is MISSING (Enrichment Sources)

| Component | Status |
|-----------|--------|
| Filename → media identity resolver | ❌ Does not exist |
| Cinemeta enrichment source (search by parsed title) | ❌ Not wired |
| TMDB/IMDb metadata provider | ❌ Does not exist |
| Sonarr/Radarr parse API integration | ❌ Does not exist |
| Media identity confidence scoring function | ❌ Not implemented |
| Enrichment worker scheduling | ❌ Not implemented |

---

## 2. Architecture Audit

### 2.1 Current Flow (What Exists)

```
Candidate (from DMM ingestion)
    │
    ▼
release_attributes (from attribute worker)
    │
    ▼
[EMPTY — no resolver connected]
    │
    ▼
candidate_media (empty for most candidates)
```

The pipeline stops at `release_attributes`. No component currently bridges from parsed filename attributes to media identity associations.

### 2.2 Desired Flow (Target)

```
Candidate (from DMM ingestion)
    │
    ▼
release_attributes (filename → title, year, season, episode)
    │
    ▼
Media Resolver (search Cinemeta/TMDB by parsed title + attributes)
    │
    ▼
candidate_media (mediaId, confidence, evidence, source)
```

### 2.3 Confidence Model (Documented)

From `enrichment.js` and research docs:

```
confidence = base_score + bonuses - penalties

Where:
- base_score: 0.5 (default for any association)
- bonuses:
  - title_exact_match: +0.2
  - year_match: +0.1
  - season_episode_match: +0.15
  - multiple_source_corroboration: +0.1
- penalties:
  - title_partial_match: -0.1
  - year_mismatch: -0.2
  - ambiguous_result: -0.15

Clamped to [0.0, 1.0]
```

Refuse association when:
- No title extracted
- Title < 3 characters
- Ambiguous (multiple results within 0.15 confidence spread)
- Confidence < 0.5 after penalties

### 2.4 Storage Boundaries (Verified)

**candidate_media table:**
| Column | Type | Purpose |
|--------|------|---------|
| `info_hash` | TEXT | FK to candidates |
| `file_index_key` | INTEGER | FK to candidates |
| `media_id` | TEXT | Media identifier (e.g., `tt2085059:7:3`) |
| `source` | TEXT | Source of association (e.g., 'cinemeta', 'tmdb') |
| `confidence` | REAL | 0.0–1.0 |
| `evidence` | TEXT | JSON array of evidence tags |
| `associated_at` | INTEGER | Epoch ms |

**Invariants (verified in code):**
- Candidate identity = `(infoHash, fileIndex)` — never mutated by enrichment
- Release attributes = evidence only — no media association implied
- One candidate may have zero or multiple media associations
- Higher confidence wins on conflict (equal → latest wins)
- Source attribution is preserved
- Evidence tags are mandatory

---

## 3. Metadata Providers Audit

### 3.1 Cinemeta (EXISTS, Not Wired to Enrichment)

**File:** `src/lib/metadata/cinemeta.js`

**Capabilities:**
- `searchCatalog(query)` — search by title, returns top 40 results
- `getMedia(type, id)` — get full metadata + videos for a media ID

**Current usage:** Only used by the catalog search endpoint (`/api/search`), NOT by enrichment.

**Enrichment potential:**
- Search by parsed title from `release_attributes`
- Match by year, season, episode
- Extract media ID in `tt1234567:season:episode` format
- Confidence based on title match quality + attribute corroboration

**Rate limits:** Unknown (no documented limit, but should assume ~1 req/sec to be safe)

### 3.2 TMDB/IMDb (DOES NOT EXIST)

No TMDB or IMDb client exists in the codebase. These would require:
- API key management
- Rate limit handling (TMDB: ~5 req/sec with key, 1 without)
- Title → ID mapping
- Metadata normalization

### 3.3 Sonarr/Radarr Parse API (DOES NOT EXIST)

No integration exists. Potential for:
- Parse filename → structured release info (title, year, season, episode, resolution)
- Higher confidence than regex parser (0.9+ vs 0.6-0.85)
- Local API call (no external rate limit)

**Note:** Sonarr/Radarr parse is for RELEASE info parsing (filename → release_attributes), not media identity resolution (filename → TMDB ID). Different purpose.

---

## 4. Worker Flow Audit

### 4.1 Current Implementation

```javascript
// worker.js
export async function runEnrichmentWorker(cache, options = {}) {
  const { enrich, limit, onProgress } = options;
  // ...
  for (const candidate of candidates) {
    const enrichment = await enrich(candidate);  // INJECTED FUNCTION
    if (enrichment) enrichments.push(enrichment);
  }
  enrichCandidates(cache, enrichments);  // Batch write
}
```

### 4.2 Gap

The `enrich` function is **never provided**. The worker is a skeleton — it orchestrates but has no enrichment source to call.

### 4.3 Required Enrichment Function Signature

```javascript
async function enrich(candidate) {
  // Input: { infoHash, fileIndex, title, filename, ... }
  // Output: {
  //   infoHash: string,
  //   fileIndex: number|null,
  //   matches: [{ mediaId: string, confidence: number }],
  //   source: string,  // e.g., 'cinemeta', 'tmdb'
  //   evidence: string[]  // e.g., ['title_exact_match', 'year_match']
  // }
}
```

### 4.4 Required Implementation Steps

1. **Create `src/lib/discovery/enrichment-sources/cinemeta.js`**
   - Export `async function enrichWithCinemeta(candidate, cache)`
   - Read parsed title/year/season/episode from `release_attributes`
   - Search Cinemeta by title
   - Match results by year, season, episode
   - Return media associations with confidence + evidence

2. **Wire into worker**
   - Import `enrichWithCinemeta`
   - Call `runEnrichmentWorker(cache, { enrich: enrichWithCinemeta })`

3. **Add scheduling**
   - Run enrichment worker after DMM ingestion
   - Or run as periodic catch-up

---

## 5. Minimal Implementation Needed

### 5.1 Priority Order

| Priority | Component | Effort | Impact |
|----------|-----------|--------|--------|
| 1 | Cinemeta enrichment source | Medium | High (enables basic media identity) |
| 2 | Wire into enrichment worker | Low | High (completes the pipeline) |
| 3 | Add confidence scoring function | Low | Medium (better ranking) |
| 4 | TMDB fallback provider | Medium | Medium (better coverage) |

### 5.2 Cinemeta Enrichment Source (Minimal)

**File to create:** `src/lib/discovery/enrichment-sources/cinemeta.js`

**Logic:**
1. Get `release_attributes` for the candidate
2. Extract parsed title, year, season, episode
3. Call `cinemeta.searchCatalog(title)`
4. For each result, compute confidence:
   - Base: 0.5
   - Title exact match (case-insensitive): +0.2
   - Title starts with: +0.1
   - Title includes: +0.05
   - Year match (if both have year): +0.1
   - Season/episode match (if applicable): +0.15
   - Clamp to [0.0, 1.0]
5. Filter results with confidence >= 0.5
6. Return matches with evidence tags

**Edge cases to handle:**
- No release_attributes → skip candidate
- No parsed title → skip candidate
- No Cinemeta results → return empty (don't force association)
- Multiple results within 0.15 spread → return all (ambiguous)
- Year mismatch → penalize heavily (-0.2)

### 5.3 Confidence Scoring

Should be a shared utility:
**File:** `src/lib/discovery/enrichment-sources/confidence.js`

```javascript
export function computeConfidence({
  titleMatch: 'exact'|'starts'|'includes'|'none',
  yearMatch: boolean,
  seasonMatch: boolean,
  episodeMatch: boolean,
}) {
  let score = 0.5;
  if (titleMatch === 'exact') score += 0.2;
  else if (titleMatch === 'starts') score += 0.1;
  else if (titleMatch === 'includes') score += 0.05;
  if (yearMatch) score += 0.1;
  if (seasonMatch && episodeMatch) score += 0.15;
  return Math.min(1.0, Math.max(0.0, score));
}
```

---

## 6. Boundary Verification

### 6.1 Candidate Identity

**Invariant:** `(infoHash, fileIndex)` is never mutated by enrichment.

**Status:** ✅ VERIFIED
- `enrichCandidate()` only calls `cache.associateMedia()` — does not touch `upsertCandidate()`
- `worker.js` never calls `cache.upsertCandidate()`

### 6.2 Release Attributes

**Invariant:** `release_attributes` remains evidence-only.

**Status:** ✅ VERIFIED
- No code path creates media associations from `release_attributes`
- The attribute worker (`attribute-worker.js`) only writes to `release_attributes`

### 6.3 Candidate_media

**Invariant:** Explicit association with confidence + evidence.

**Status:** ✅ VERIFIED
- `associateMedia()` requires `mediaId`, `confidence`, `evidence`
- Primary key `(info_hash, file_index_key, media_id)` allows multiple associations per candidate

### 6.4 Provider Observations

**Invariant:** `provider_observations` remain separate.

**Status:** ✅ VERIFIED
- `enrichment.js` never calls `recordProviderObservation()`
- `worker.js` never calls `recordProviderObservation()`

---

## 7. What This Audit Does NOT Cover

The following are intentionally excluded from this audit:

1. **Provider hydration** — TorBox/RD cache status checks (separate concern)
2. **Torrentio/Comet integration** — Live intelligence sources (future milestone)
3. **Sonarr/Radarr parsing** — Release info parsing, not media identity
4. **DHT crawling** — Explicitly excluded by project scope
5. **Frontend/Stremio addon** — Explicitly excluded by project scope

---

## 8. Recommendation

**Implement the Cinemeta enrichment source first.**

Rationale:
- Cinemeta client already exists and is tested
- No external API key required
- Sufficient for basic media identity resolution
- Low risk — failures don't break existing functionality
- Completes the MVP pipeline: DMM → release_attributes → candidate_media → search with media

**Do NOT:**
- Implement TMDB/IMDb until Cinemeta proves insufficient
- Implement provider hydration until media identity works
- Redesign the storage layer
- Hardcode provider assumptions

---

## 9. Decision Record

### Enrichment Source Architecture

**Decision:** Create `enrichment-sources/` directory for pluggable metadata providers.

**Rationale:**
- Multiple providers will exist (Cinemeta, TMDB, Sonarr/Radarr)
- Each provider should be independently testable
- Worker should accept any enrichment function (already designed this way)

**Impact:**
- New directory: `src/lib/discovery/enrichment-sources/`
- Files: `cinemeta.js`, `tmdb.js` (future), `confidence.js`
- No changes to existing `enrichment.js` or `worker.js` needed

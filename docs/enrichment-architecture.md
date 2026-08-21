# Enrichment Architecture

This document describes the media identity enrichment system that resolves DMM candidates to known media IDs (IMDb, TMDB).

## 1. Enrichment Boundary

The enrichment system is **separate** from ingestion:

```
Candidate (from DMM ingestion)
   │
   ▼
Attribute parsing (filename → structured data)
   │
   ▼
Optional enrichment worker
   │
   ▼
Candidate_media associations (mediaId, confidence, evidence)
```

### Key Principles

1. **Media IDs are optional** — Candidates exist without enrichment
2. **Enrichment is additive** — Multiple sources can contribute associations
3. **Confidence is explicit** — Every association has a confidence score
4. **Evidence is preserved** — Why an association was made is tracked
5. **No forced associations** — Unknown matches remain unknown

## 2. Data Flow

### 2.1 Enrichment Worker (`worker.js`)

The worker is source-agnostic — it processes candidates through an injected enrichment function:

```javascript
await runEnrichmentWorker(cache, {
  enrich: async (cache, candidate) => {
    // Return enrichment result or null
  },
  limit: 100,
});
```

### 2.2 Enrichment Sources

Each source implements the same interface:

```javascript
async function enrichSource(cache, candidate, options) {
  return {
    infoHash: candidate.infoHash,
    fileIndex: candidate.fileIndex,
    matches: [
      { mediaId: 'tt1234567', confidence: 0.95, ... }
    ],
    source: 'cinemeta',
    evidence: ['title_exact_match', 'year_match'],
  };
}
```

### 2.3 Confidence Scoring (`enrichment-sources/confidence.js`)

```
base: 0.5
+ title exact match: +0.2
+ title starts with: +0.1
+ title includes: +0.05
+ year match: +0.1
+ season+episode match: +0.15
= clamped to [0.0, 1.0]
```

## 3. Enrichment Sources

### 3.1 Cinemeta (implemented)

Searches Cinemeta with parsed title/year from release attributes.

**Pros:**
- No API key required
- Fast responses
- Good movie/TV coverage

**Cons:**
- No TMDB/IMDb IDs directly (uses Cinemeta IDs)
- Limited season/episode matching in catalog search

### 3.2 Future Sources

| Source | Status | Notes |
|--------|--------|-------|
| TMDB | Planned | Requires API key, comprehensive |
| TVDB | Planned | Requires API key, TV-focused |
| IMDb | Planned | No official API, scraping only |
| Custom | Planned | Manual associations, user corrections |

## 4. Database Schema

### `candidate_media` table

```sql
CREATE TABLE candidate_media (
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  media_id TEXT NOT NULL,           -- 'tt1234567' or 'tt1234567:1:1'
  source TEXT NOT NULL DEFAULT 'search',
  confidence REAL NOT NULL DEFAULT 1.0,
  evidence TEXT,                    -- JSON array
  associated_at INTEGER NOT NULL,
  PRIMARY KEY (info_hash, file_index_key, media_id)
);
```

### Merge Rules

- **Higher confidence wins** — New association replaces old if confidence is higher
- **Equal confidence → latest wins** — Timestamp breaks ties
- **Lower confidence is skipped** — Preserves stronger associations

## 5. Enrichment Effectiveness

### 5.1 Parser Audit Results

For comprehensive parser and enrichment metrics against 62 real DMM corpus samples, see the [Enrichment Evaluation Report](evaluation/ENRICHMENT-EVALUATION-2026-08-21.md).

**Key findings (2026-08-21):**
- Parser success: 100% (62/62 samples)
- Title extraction: 100% (62/62)
- Enrichment success: 88.7% (55/62 samples)
- Enrichment avg confidence: 0.744

### 5.2 Highest-Value Improvements

Based on the evaluation, the highest-value improvements are:

1. **Parser: Year extraction** — 32.3% of titled releases have year extraction failures (edge cases like year-at-start)
2. **Alternate title support** — Foreign language titles need TMDB/IMDb enrichment source
3. **Provider additions** — TMDB needed for disambiguation of ambiguous titles (multiple matches)
4. **Parser: Pack detection** — Collections, trilogies, sagas not currently detected

## 6. Identity Resolution Potential

### 6.1 Filename Sufficiency

Based on the audit:
- **~85% of filenames** have sufficient data for identity resolution (title + year or title + season/episode)
- **~15% are ambiguous** (common titles, missing year, no season/episode)

### 6.2 Enrichment Success Estimate

| Scenario | Expected Success |
|----------|-----------------|
| Movie with year | ~90% (title + year is strong match) |
| TV episode with S/E | ~85% (title + S/E is strong match) |
| Movie without year | ~60% (title alone is ambiguous) |
| TV with title only | ~40% (need S/E for accuracy) |

### 6.3 Confidence Thresholds

| Confidence | Meaning | Action |
|------------|---------|--------|
| 0.9–1.0 | Exact match | Auto-accept |
| 0.7–0.9 | Strong match | Auto-accept |
| 0.5–0.7 | Possible match | Queue for review |
| < 0.5 | Weak match | Reject |

## 7. Next Steps

### 7.1 Immediate

- [ ] Add HDR10+ pattern to parser
- [ ] Improve DDP/Atmos audio extraction
- [ ] Add more streaming service tags (iT, PLAY, etc.)

### 7.2 Short-term

- [ ] Implement TMDB enrichment source
- [ ] Add manual association UI
- [ ] Build enrichment queue dashboard

### 7.3 Long-term

- [ ] Machine learning for title matching
- [ ] Fuzzy matching for misspelled titles
- [ ] Cross-reference multiple sources for confidence boosting

## 8. API Reference

### Enrichment Worker

```javascript
import { runEnrichmentWorker } from './src/lib/discovery/worker.js';

const stats = await runEnrichmentWorker(cache, {
  enrich: enrichWithCinemeta,
  limit: 100,
  onProgress: (candidate, result) => {
    console.log(candidate.infoHash, result);
  },
});
```

### Enrichment Boundary

```javascript
import { enrichCandidate } from './src/lib/discovery/enrichment.js';

const result = enrichCandidate(cache, {
  infoHash: 'abc123',
  fileIndex: null,
  matches: [{ mediaId: 'tt1234567', confidence: 0.95 }],
  source: 'cinemeta',
  evidence: ['title_exact_match'],
});
```

### Confidence Scoring

```javascript
import { computeConfidence } from './src/lib/discovery/enrichment-sources/confidence.js';

const confidence = computeConfidence({
  titleMatch: 'exact',
  yearMatch: true,
  seasonMatch: true,
  episodeMatch: true,
});
// Returns: 0.95
```

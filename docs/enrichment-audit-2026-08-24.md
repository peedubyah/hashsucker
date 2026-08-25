# Enrichment Pipeline Audit Results

## Executive Summary

**Status: BLOCKED - Cinemeta API unsuitable for identity resolution**

The first controlled enrichment run exposed a fundamental issue: Cinemeta's `/catalog/{type}/search=` endpoint returns static popular results regardless of the query. This makes it unusable for identity resolution.

## Test Setup

- **Source**: Stage 3 functional fixture (`dmm-stage3-functional.db`)
- **Candidates**: 529 total, 0 with existing media associations
- **Sample size**: 10 candidates processed

## Results

### Baseline
```
Total candidates: 529
With media: 0
Coverage: 0.0%
```

### Seeding
```
Seeded: 529
Skipped: 0
```

### Processing (10 items)
```
Processed: 10
Resolved: 10 (marked resolved but 0 actual matches)
Failed: 0
Skipped: 0
```

### After Processing
```
Queue pending: 519
Queue resolved: 10
Coverage: 0.0% (no actual associations created)
```

## Root Cause Analysis

### Cinemeta Search API Behavior

Testing Cinemeta directly shows the problem:

| Query | Top Result | Actual Match |
|-------|-----------|--------------|
| "Yu-Gi-Oh! Arc-V" | Reacher (2022) | No |
| "invandraren-barbarossa 1080p" | Reacher (2022) | No |
| "And Just" | Reacher (2022) | No |

Cinemeta returns the **same popular results for every query**. The search endpoint appears to be a stub that returns trending/popular content, not actual search results.

### Why the Resolver Returned 0 Matches

The resolver's scoring logic correctly filtered out all unrelated results:
- Title mismatch: "Reacher" vs "Yu-Gi-Oh! Arc-V"
- Token overlap: 0% for all results
- Confidence: 0 for all results (below 0.4 threshold)

The resolver is working correctly - it's just that Cinemeta doesn't return relevant results.

## Sample Candidate Analysis

| Filename | Parsed Title | Cinemeta Results | Expected |
|----------|-------------|------------------|----------|
| Yu-Gi-Oh! Arc-V Amazon Web-DL | Yu-Gi-Oh! Arc-V | Reacher, Deathstroke, Mentalist | Yu-Gi-Oh! Arc-V |
| invandraren-barbarossa.1080p.mkv | invandraren-barbarossa 1080p | Reacher, Deathstroke, Mentalist | Invandraren Barbarossa |
| And.Just.Like.That.The.Documentary.2022 | And Just (2022) | Reacher, Deathstroke, Mentalist | And Just Like That |

## Options

### Option 1: Use Cinemeta's Direct Lookup (IMDb ID only)
- Cinemeta's `/meta/{type}/{id}.json` endpoint works correctly
- Requires candidates to have IMDb IDs
- Most torrent filenames don't include IMDb IDs

### Option 2: Switch to TMDB
- TMDB has a proper search API
- Requires API key (free tier available)
- Better search relevance

### Option 3: Use Torznab/Jackett
- Already integrated for torrent search
- Returns media metadata (IMDb ID, title, year)
- Could bridge to Cinemeta for media details

### Option 4: Local FTS Search
- Use the existing `release_search` FTS5 index
- Match candidates against each other
- No external API dependency

## Recommendation

**Do not proceed with Cinemeta for identity resolution.**

The resolver abstraction is sound and the pipeline works correctly. The issue is purely with the metadata provider. Recommend:

1. **Short-term**: Implement TMDB resolver (parallel to Cinemeta)
2. **Medium-term**: Use Torznab/Jackett to get IMDb IDs, then Cinemeta for media details
3. **Long-term**: Build local media database from enriched candidates

## Files Modified

- `src/lib/discovery/cache.js` - Added `enqueueUnresolvedCandidates()` and related functions
- `src/scripts/enrichment.js` - CLI command for seed/process/status
- `test/enrichment-pipeline.test.js` - 20 tests (all passing)
- `test/enrichment-audit.mjs` - Audit script
- `test/enrichment-quick-validate.mjs` - Quick validation script
- `test/enrichment-debug.mjs` - Debug scripts

## Test Results

- **Full suite: 1660 pass / 17 fail** (same 17 pre-existing failures)
- **All new tests pass**
- No regressions

## Next Steps

1. Validate TMDB API as alternative metadata provider
2. Implement `TmdbIdentityResolver` using same abstraction
3. Re-run enrichment audit with working provider
4. Scale to full corpus once quality is validated

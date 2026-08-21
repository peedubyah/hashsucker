# Enrichment Effectiveness Evaluation Report

**Date:** 2026-08-21T04:11:10.678Z
**Total Samples:** 62

## Executive Summary

| Metric | Value | Rate |
|--------|-------|------|
| Parser Success | 62/62 | 100.0% |
| Enrichment Success | 55/62 | 88.7% |
| Parser Avg Confidence | 0.964 | - |
| Enrichment Avg Confidence | 0.744 | - |

## 1. Parser Success Metrics

| Field | Extracted | Correct | Rate |
|-------|-----------|---------|------|
| Title | 62/62 | 60/62 | 100.0% |
| Year | 42/62 | 40/42 | 67.7% |
| Season | 15/62 | - | 24.2% |
| Episode | 15/62 | - | 24.2% |
| Media Type | 62/62 | - | 100.0% |

## 2. Identity Resolution

| Metric | Value |
|--------|-------|
| Matched | 55 |
| Unmatched | 7 |
| Avg Confidence | 0.744 |

### By Source

| Source | Count |
|--------|-------|
| cinemeta | 55 |

## 3. Category Breakdown

| Category | Samples | Parser Success | Enrichment Success |
|----------|---------|----------------|--------------------|
| movies | 15 | 15/15 (100%) | 14/15 (93%) |
| tvEpisodes | 15 | 15/15 (100%) | 15/15 (100%) |
| ambiguous | 11 | 11/11 (100%) | 10/11 (91%) |
| foreign | 8 | 8/8 (100%) | 6/8 (75%) |
| packs | 5 | 5/5 (100%) | 3/5 (60%) |
| edgeCases | 8 | 8/8 (100%) | 7/8 (88%) |

## 4. Failure Categories

### title_mismatch (2)

- Crouching.Tiger.Hidden.Dragon.2000.1080p.BluRay.x264-SiNNERS.mkv
- 2012.2009.1080p.BluRay.x264-SiNNERS.mkv

### year_mismatch (2)

- 2001.A.Space.Odyssey.1968.1080p.BluRay.x264-SiNNERS.mkv
- 2012.2009.1080p.BluRay.x264-SiNNERS.mkv

### no_match (7)

- Schindlers.List.1993.1080p.BluRay.x264-SiNNERS.mkv
- Terminator.2.Judgment.Day.1991.1080p.BluRay.x264-SiNNERS.mkv
- Amelie.2001.1080p.BluRay.x264-SiNNERS.mkv
- Crouching.Tiger.Hidden.Dragon.2000.1080p.BluRay.x264-SiNNERS.mkv
- The.Lord.of.the.Rings.Trilogy.2001-2003.1080p.BluRay.x264-SiNNERS.mkv
- ... and 2 more

### ambiguous (11)

- Batman.1989.1080p.BluRay.x264-SiNNERS.mkv
- Batman.Begins.2005.1080p.BluRay.x264-SiNNERS.mkv
- The.Dark.Knight.Rises.2012.1080p.BluRay.x264-SiNNERS.mkv
- Halloween.1978.1080p.BluRay.x264-SiNNERS.mkv
- Halloween.2018.1080p.BluRay.x264-SiNNERS.mkv
- ... and 6 more

### foreign_language (8)

- Amelie.2001.1080p.BluRay.x264-SiNNERS.mkv
- City.of.God.2002.1080p.BluRay.x264-SiNNERS.mkv
- Pan's.Labyrinth.2006.1080p.BluRay.x264-SiNNERS.mkv
- The.Lives.of.Others.2006.1080p.BluRay.x264-SiNNERS.mkv
- Downfall.2004.1080p.BluRay.x264-SiNNERS.mkv
- ... and 3 more

### pack_collection (5)

- The.Lord.of.the.Rings.Trilogy.2001-2003.1080p.BluRay.x264-SiNNERS.mkv
- The.Matrix.Trilogy.1999-2003.1080p.BluRay.x264-SiNNERS.mkv
- Star.Wars.Saga.1977-2019.1080p.BluRay.x264-SiNNERS.mkv
- Harry.Potter.Collection.2001-2011.1080p.BluRay.x264-SiNNERS.mkv
- Marvel.Cinematic.Universe.Phase.One.2008-2012.1080p.BluRay.x264-SiNNERS.mkv

## 5. Highest-Value Improvements

| Priority | Area | Issue | Impact | Recommendation |
|----------|------|-------|--------|----------------|
| HIGH | Parser Improvements | Year extraction failures | 32.3% of titled releases | Add year patterns for edge cases (year at start, year in parentheses) |
| HIGH | Alternate Title Support | Foreign language titles | 8 samples | Add TMDB/IMDb as enrichment source for better foreign title matching |
| MEDIUM | Provider Additions | Ambiguous titles (multiple matches) | 11 samples | Add TMDB for disambiguation (year + title matching) |
| LOW | Parser Improvements | Pack/collection detection | 5 samples | Add patterns for detecting collections, trilogies, sagas |

## 6. Detailed Sample Analysis

### Parser Failures

- **Crouching.Tiger.Hidden.Dragon.2000.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"Crouching Tiger Hidden Dragon","year":2000,"type":"movie","language":"chinese"}
  - Parsed: {"title":"Crouching Tiger Hien Dragon","year":2000,"mediaType":"movie","confidence":0.9500000000000002}
  - Failures: title_mismatch

- **2001.A.Space.Odyssey.1968.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"2001 A Space Odyssey","year":1968,"type":"movie"}
  - Parsed: {"title":"A Space Odyssey","year":2001,"mediaType":"movie","confidence":0.9500000000000002}
  - Failures: year_mismatch

- **2012.2009.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"2012","year":2009,"type":"movie"}
  - Parsed: {"title":"2009","year":2012,"mediaType":"movie","confidence":0.9500000000000002}
  - Failures: title_mismatch, year_mismatch

### Enrichment Failures

- **Schindlers.List.1993.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"Schindlers List","year":1993,"type":"movie"}
  - Parsed title: Schindlers List
  - Failures: no_match

- **Terminator.2.Judgment.Day.1991.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"Terminator 2 Judgment Day","year":1991,"type":"movie"}
  - Parsed title: Terminator 2 Judgment Day
  - Failures: no_match

- **Amelie.2001.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"Amelie","year":2001,"type":"movie","language":"french"}
  - Parsed title: Amelie
  - Failures: no_match

- **Crouching.Tiger.Hidden.Dragon.2000.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"Crouching Tiger Hidden Dragon","year":2000,"type":"movie","language":"chinese"}
  - Parsed title: Crouching Tiger Hien Dragon
  - Failures: no_match

- **The.Lord.of.the.Rings.Trilogy.2001-2003.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"The Lord of the Rings Trilogy","type":"pack"}
  - Parsed title: The Lord of the Rings Trilogy 2003
  - Failures: no_match

- **Harry.Potter.Collection.2001-2011.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"Harry Potter Collection","type":"pack"}
  - Parsed title: Harry Potter Collection 2011
  - Failures: no_match

- **2012.2009.1080p.BluRay.x264-SiNNERS.mkv**
  - Expected: {"title":"2012","year":2009,"type":"movie"}
  - Parsed title: 2009
  - Failures: no_match

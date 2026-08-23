# Retrieval Architecture Findings

**Date:** 2026-08-23  
**Status:** Production evidence complete  
**Source corpus:** `data/dmm-corpus.db` (1,480,357 candidates, repaired FTS)

---

## 1. Original Assumption

> A pre-rank retrieval window of **2,000 candidates** (FTS BM25-ordered) preserves top-1 recall for production queries.

Rationale: BM25-ordered retrieval should place the strongest title matches near the top, so a 2000-cap would capture all viable candidates while bounding worst-case latency.

---

## 2. Experiment Design

### 2.1 Corpus

- Source: production `dmm-corpus.db` (1.48M candidates)
- FTS5 schema with porter unicode61 tokenizer
- Triggers keep FTS in sync with `release_attributes`
- Identity: `(info_hash, file_index_key)` where `-1` → `null`

### 2.2 Query Suite

30 production-realistic queries across categories:

| Category | Queries |
|----------|---------|
| Anime | Dragon Ball, One Piece, Naruto, My Hero Academia, Attack on Titan |
| Western TV | The Flash, Game of Thrones, Stranger Things, The Mandalorian, Breaking Bad |
| Movies | Avatar, Avengers, Spider-Man, Batman, Joker |
| Genre | Horror, Comedy, Action, Sci-Fi, Documentary |
| Release format | Criterion, Remux, Director's Cut, Extended, Theatrical |
| Audio/subtitle | Dual Audio, Subs, Dubbed, AAC, DTS-HD |

### 2.3 Ranking Formula (HashSucker-aligned)

```
score = relevance × 0.25
      + quality × 0.20
      + releaseConfidence × 0.20
      + identityConfidence × 0.15
      + providerAvailability × 0.10
      + episodeMatch × 0.10
```

Where:
- **relevance** = `1.0 / (1.0 + abs(bm25))` — FTS BM25 score
- **quality** = `resolution*0.4 + source*0.3 + codec_bonus + hdr(0.15) + 4k_hevc(0.1)`
- **releaseConfidence** = parser confidence (0.0-1.0)
- **identityConfidence** = 0.5 (NEUTRAL placeholder — downstream may override)
- **providerAvailability** = 0.5 (NEUTRAL placeholder — **reserved for live provider observations from downstream**)
- **episodeMatch** = 0.5 (NEUTRAL placeholder for non-S/E queries)

> **Architectural note:** Stage 3 fixture mode uses neutral availability assumptions. Live provider observations are applied by the downstream acquisition layer.

Tie-breakers (deterministic, in order):
1. Higher composite score
2. Higher releaseConfidence
3. Higher quality
4. Higher relevance
5. Lower hash string (lexicographic)
6. Lower fileIndex (null sorts last)

### 2.4 Test Method

For each query:
1. Run capped retrieval (LIMIT 2000 on FTS MATCH)
2. Run uncapped retrieval (no LIMIT, up to 2M)
3. Dedup by `(info_hash, file_index_key)`
4. Rank all deduped candidates
5. Compare capped vs uncapped winners

### 2.5 Test Databases

Three fixture databases exist for different purposes:

| DB | Rows | Purpose |
|----|------|---------|
| `dmm-stage3-functional.db` | 529 | End-to-end integration tests (small, portable) |
| `dmm-stage3-ranking.db` | 314,662 | Full retrieval regression (all FTS neighborhoods for 30 queries) |
| `dmm-corpus.db` | 1,480,357 | Production corpus (large, not committed) |

---

## 3. Measured Results

### 3.1 Winner Agreement

| Metric | Value |
|--------|-------|
| Total queries | 30 |
| Capped ↔ Uncapped agreement | **19/30** |
| Disagreements | **11/30** |
| Deep winners (ordinal > 2000) | **11/30** |

### 3.2 Deep Winner Cases

| Query | Candidate Count | Winner Ordinal | Winner Hash (prefix) |
|-------|----------------|----------------|---------------------|
| AAC | 138,264 | 138,252 | `1cc48599…` |
| Remux | 76,437 | 76,437 | `970c5fd8…` |
| Subs | 46,132 | 46,129 | `cf9a905f…` |
| DTS-HD | 52,479 | 52,479 | `970c5fd8…` |
| Dual Audio | 9,111 | 9,105 | `4d12f370…` |
| Dubbed | 11,446 | 11,446 | `cf9a905f…` |
| Extended | 5,820 | 5,818 | `27c2f9cd…` |
| One Piece | 4,617 | 4,605 | `4d4d590f…` |
| Horror | 2,785 | 2,771 | `4558851d…` |
| Criterion | 2,637 | 2,637 | `f38ebee3…` |
| Batman | 2,458 | 2,458 | `2ef37e1c…` |

### 3.3 Latency Measurements

| Metric | Value |
|--------|-------|
| Max uncapped latency | 694ms |
| Median uncapped latency | 69ms |
| Avg uncapped latency | ~150ms |
| Max retrieval latency | ~400ms |

---

## 4. Why RETRIEVAL_WINDOW=2000 Failed

The core problem: **BM25 title-match ranking is poorly correlated with composite ranking score.**

### 4.1 Explanation

BM25 scores relevance of title tokens. The composite score includes:
- **Quality** (resolution, source type, codec, HDR) — not in title
- **Release confidence** — parser metadata, not in title
- **Identity/provider availability** — contextual, not in title

A candidate with a mediocre title match but high quality (e.g., Remux 2160p) can outrank a perfect title match with low quality (e.g., 360p webrip).

When high-quality candidates have long or rare filenames, they sort low in BM25 order (high BM25 score = less relevant). With 138k "AAC" candidates, the true winner sits at position 138,252 — far beyond any practical window.

### 4.2 Concrete Example: "Remux"

- 76,437 candidates match FTS `"Remux"*`
- BM25 orders them by title match strength
- The highest-quality 2160p Remux has title "Star Wars 4K Remux" — not a strong BM25 match
- It sorts at position 76,437 (last!)
- Composite ranking correctly promotes it to #1
- Under window=2000, it's never retrieved → wrong winner

### 4.3 Why Latency Is Acceptable

Max uncapped latency is 694ms (production queries), median 69ms. The 2M-row LIMIT cap in the experiment is far beyond any production need — it exists only to prove no winner exists beyond the measured cardinality. Real queries with >100k matches are pathological and should be handled separately.

---

## 5. Recommended Retrieval Architecture

### 5.1 Remove Pre-Rank Cap

**Paginate only after ranking.** Apply LIMIT/OFFSET on the sorted, deduped, scored result set — not on raw FTS retrieval.

### 5.2 Query-Specific Strategies

| Cardinality | Strategy |
|-------------|----------|
| < 5,000 | Uncap → dedup → rank → paginate |
| 5,000 – 50,000 | Uncap → dedup → rank → paginate; add timeout guard |
| > 50,000 | Pre-filter by quality/resolution before FTS, then cap |

### 5.3 Pre-Filter Heuristics (for high-cardinality queries)

- **Quality floor**: Only retrieve candidates with `confidence > 0.6` or `resolution IN ('1080p', '2160p')`
- **FTS narrowing**: Require AND-match on quality tokens (e.g., `"Remux"* AND "1080p"* AND "x264"*`)
- **Query intent detection**: If query contains only generic terms (codec, resolution), apply stricter pre-filtering

### 5.4 Ranking Stages (final)

```
Stage 1: FTS retrieval (MATCH + ORDER BY bm25 ASC) — no cap
Stage 2: Dedup by (info_hash, file_index_key)
Stage 3: Score with composite formula
Stage 4: Sort by composite score + tie-breakers
Stage 5: Paginate (LIMIT/OFFSET) for API response
```

---

## 6. Remaining Unknowns

### 6.1 Not Measured

| Unknown | Impact | Why not measured |
|---------|--------|------------------|
| True positive rate vs. ground truth | Unknown if winners are actually "correct" | Requires manual labeling |
| Query-time quality/resolution distribution shift | May change ranking over time | Static corpus snapshot |
| Episode-match / identity-confidence effects | Generic queries used NEUTRAL=0.5 | Requires provider/cache integration |
| Title-alias coverage | Some releases use alternate titles | Requires alias mapping |
| Source-preference bias | Same identity, multiple sources deduped by source | Source selection not in scope |

### 6.2 Open Questions

1. **Should quality affect retrieval ordering?** Currently quality is only a ranking signal — FTS ordering is title-only. Adding quality to FTS (e.g., weighted fields) would require FTS5 column filters.

2. **Is a two-stage retrieval warranted?** Stage 1: FTS for recall. Stage 2: quality filter for precision. This adds complexity but may bound latency for pathological queries.

3. **How to handle >100k candidates?** AAC (138k matches) is a real query. The 694ms uncapped latency is acceptable but may degrade under load. Consider materialized quality-precomputed views.

---

## 7. Reproducing These Results

```bash
# Clone repo (no large artifacts needed — use functional fixture)
cd dmm-corpus-builder

# Run retrieval suite against functional fixture (529 rows, reproducible)
node scripts/run-retrieval-suite.js \
  data/fixtures/dmm-stage3-functional.db \
  data/fixtures/stage3-query-vectors.json \
  --mode experiment

# Run regression test
node scripts/regression-test.js \
  data/dmm-corpus.db \
  data/fixtures/regression-queries.json

# Inspect corpus state
node scripts/corpus-observability.js data/dmm-corpus.db
```

---

## 8. Fixture Artifacts

| File | Purpose | Size |
|------|---------|------|
| `data/fixtures/dmm-stage3-functional.db` | 529-row diverse sample | 0.55 MB |
| `data/fixtures/dmm-stage3-ranking.db` | Full FTS neighborhoods for 30 queries | 303 MB |
| `data/fixtures/dmm-stage3-fixture-manifest.json` | Query expectations | 9 KB |
| `data/fixtures/stage3-query-vectors.json` | Test vectors for automation | ~5 KB |
| `data/fixtures/regression-queries.json` | Regression suite (32 queries) | ~6 KB |

---

## 9. Evidence Constraints

- All measurements are corpus-relative. No external ground truth was used.
- "Winner" means "highest composite score under HashSucker-aligned ranking" — not necessarily the "best" match.
- Results are specific to this corpus snapshot. New releases may shift cardinalities and winners.
- HashSucker runtime was not modified. No provider/live integration was used.

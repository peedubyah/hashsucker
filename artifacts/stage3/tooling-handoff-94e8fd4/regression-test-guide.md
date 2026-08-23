# Retrieval Regression Test Guide

This directory contains scripts for testing retrieval/ranking behavior.

## Scripts

### `run-retrieval-suite.js`

Full experiment runner. Opens a DB, loads a query suite, runs both capped and uncapped retrieval, and produces JSON + Markdown reports.

```bash
# Run against production DB
node scripts/run-retrieval-suite.js data/dmm-corpus.db data/fixtures/stage3-query-vectors.json

# Run against ranking fixture (faster, smaller)
node scripts/run-retrieval-suite.js data/fixtures/dmm-stage3-ranking.db data/fixtures/regression-queries.json --mode regression
```

Output: `data/benchmark-results/retrieval-latest.json` and `retrieval-latest.md`

### `regression-test.js`

Validates that retrieval winners match expected values. Exits non-zero on mismatch.

```bash
# Test against full production DB (1.48M rows) — authoritative
node scripts/regression-test.js data/dmm-corpus.db data/fixtures/regression-queries.json
```

**Note:** The regression suite was generated from the production DB at fixture creation time. If the production corpus has changed (new releases ingested), winners may differ. Update the suite with `scripts/generate-regression-suite.js` to match current production.

### `generate-regression-suite.js`

Generates `data/fixtures/regression-queries.json` from the fixture manifest. Run this after rebuilding fixtures to sync expected winners.

```bash
node scripts/generate-regression-suite.js
```

### `corpus-observability.js`

Inspects any HashSucker-compatible corpus DB for health metrics.

```bash
# Full report
node scripts/corpus-observability.js data/dmm-corpus.db

# Specific section
node scripts/corpus-observability.js data/dmm-corpus.db coverage
node scripts/corpus-observability.js data/dmm-corpus.db identity
```

Sections: `size`, `coverage`, `identity`, `duplicates`, `attributes`, `ranking`, `ingest`, `fts`

## Fixture Databases

| File | Size | Rows | Purpose |
|------|------|------|---------|
| `dmm-stage3-functional.db` | 560 KB | 529 | Integration tests, fast validation |
| `dmm-stage3-ranking.db` | 303 MB | 314,662 | Retrieval regression (full FTS neighborhoods) |
| `dmm-corpus.db` | 1.4 GB | 1,480,357 | Production corpus (not committed) |

## Query Fixtures

| File | Queries | Purpose |
|------|---------|---------|
| `stage3-query-vectors.json` | 30 | Original Stage 3 experiment queries |
| `regression-queries.json` | 30 | Regression suite (edge cases, deep winners) |

## Reproducing Stage 3 Results

```bash
# Against production (authoritative)
node scripts/run-retrieval-suite.js data/dmm-corpus.db data/fixtures/stage3-query-vectors.json

# Against ranking fixture (faster, 303 MB)
node scripts/run-retrieval-suite.js data/fixtures/dmm-stage3-ranking.db data/fixtures/stage3-query-vectors.json
```

Expected: 19/30 capped↔uncapped agreement, 11 deep winners (ordinal > 2000).

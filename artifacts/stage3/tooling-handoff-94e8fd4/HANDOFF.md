# Stage 3 Tooling Handoff Package

**Stage:** 3 (Candidate Retrieval)  
**Commit:** `94e8fd4`  
**Date:** 2026-08-23  
**Purpose:** Transfer deterministic retrieval regression tooling and explain architectural boundaries for downstream consumption.

---

## 1. Purpose

Stage 3 provides the ranked candidate set — the best static evidence for a media intent from local corpus intelligence.

This tooling lets you:
- Run a reproducible retrieval experiment against a HashSucker-compatible corpus DB
- Validate that retrieval/ranking behavior has not regressed
- Inspect corpus health and attribute coverage
- Query observability metrics (FTS coverage, identity uniqueness, attribute completeness)

**What Stage 3 proves:**
- `RETRIEVAL_WINDOW=2000` fails for 11/30 production queries
- 11 queries have winners beyond ordinal 2000 (deep winners)
- Max uncapped latency is 694ms (median 69ms)
- BM25 title-match ranking is poorly correlated with composite ranking score

---

## 2. Architectural Boundary

### Stage 3 OWNS:
```
Media intent → candidate retrieval → identity validation → static candidate intelligence → ranked candidate set
```

### Stage 3 DOES NOT own:
- Provider availability
- Cache state
- Fulfillment decisions
- Placement
- Library projection

### Downstream contract:
The next layer combines:
```
Candidate ranking (Stage 3 output)
+ Provider reality
+ Fulfillment policy
= Final acquisition decision
```

The ranked candidate set is the input. Provider availability and fulfillment policy are applied **after** Stage 3 produces ranked candidates.

---

## 3. Commit & Files

### Commit: `94e8fd4`

**Files added:**
```
Docs/evaluation/regression-test-guide.md
Docs/evaluation/retrieval-findings.md
scripts/corpus-observability.js
scripts/generate-regression-suite.js
scripts/regression-test.js
scripts/run-retrieval-suite.js
scripts/verify-pipeline.js
```

### Key scripts:

| Script | Purpose |
|--------|---------|
| `run-retrieval-suite.js` | Run retrieval experiment, output JSON + Markdown |
| `regression-test.js` | Validate winners match expected values |
| `generate-regression-suite.js` | Generate regression fixture from query vectors |
| `corpus-observability.js` | Analyze corpus health (size, FTS, identity, attributes) |
| `verify-pipeline.js` | End-to-end verification of fixtures + scripts |

---

## 4. How to Run

### Retrieve against production DB (1.48M rows):
```bash
# Full experiment (capped vs uncapped)
node scripts/run-retrieval-suite.js data/dmm-corpus.db data/fixtures/regression-queries.json

# Validate winners match expected values
node scripts/regression-test.js data/dmm-corpus.db data/fixtures/regression-queries.json
```

### Against ranking fixture (303 MB, 314K rows — portable):
```bash
node scripts/run-retrieval-suite.js data/fixtures/dmm-stage3-ranking.db data/fixtures/regression-queries.json --mode regression

node scripts/regression-test.js data/fixtures/dmm-stage3-ranking.db data/fixtures/regression-queries.json
```

### Against functional fixture (560 KB, 529 rows — fast smoke test):
```bash
node scripts/regression-test.js data/fixtures/dmm-stage3-functional.db data/fixtures/regression-queries.json
```

### Inspect corpus health:
```bash
node scripts/corpus-observability.js data/dmm-corpus.db
node scripts/corpus-observability.js data/dmm-corpus.db coverage
node scripts/corpus-observability.js data/dmm-corpus.db identity
```

---

## 5. Expected Outputs

### `run-retrieval-suite.js` outputs:
- `data/benchmark-results/retrieval-results-<timestamp>.json` — full machine-readable results
- `data/benchmark-results/retrieval-report-<timestamp>.md` — human-readable report
- `data/benchmark-results/retrieval-latest.json` / `retrieval-latest.md` — latest run aliases

### `regression-test.js` exits:
- `0` — all winners match expected values
- `1` — one or more winners differ (regression detected)

### `verify-pipeline.js` outputs:
- File existence checks
- Query vector integrity
- FTS coverage percentage
- Sample query validation

---

## 6. Ranking Formula (HashSucker-aligned)

```
score = relevance × 0.25 + quality × 0.20 + releaseConfidence × 0.20
      + identityConfidence × 0.15 + providerAvailability × 0.10 + episodeMatch × 0.10
```

Where:
- **relevance** = `1.0 / (1.0 + abs(bm25))`
- **quality** = `resolution*0.4 + source*0.3 + codec_bonus + hdr(0.15) + 4k_hevc(0.1)`
- **releaseConfidence** = parser confidence (0.0-1.0)
- **identityConfidence** = 0.5 (NEUTRAL placeholder — downstream may override)
- **providerAvailability** = 0.5 (NEUTRAL placeholder — **reserved for live provider observations from downstream**)
- **episodeMatch** = 0.5 (NEUTRAL placeholder for non-S/E queries)

> **Architectural note:** Stage 3 fixture mode uses neutral availability assumptions (`0.5`). Live provider observations are applied by the downstream acquisition layer. Stage 3 produces deterministic ranked candidates from static corpus evidence only.

Tie-breakers (deterministic): score → releaseConfidence → quality → relevance → hash asc → fileIndex asc (null last)

Identity semantics: `(info_hash, file_index_key)` where `-1` → `null` (torrent-level). `null != 0`.

---

## 7. Known Limitations

1. **RETRIEVAL_WINDOW=2000 is broken.** Do not use it as a pre-rank cap. Deep winners exist beyond ordinal 2000 because BM25 title-match ranking is uncorrelated with composite ranking. Paginate only after ranking.

2. **Regression suite is corpus-dependent.** Expected winners were captured at fixture creation time. If production corpus changes, regenerate with `generate-regression-suite.js`.

3. **Availability/identity confidence are NEUTRAL placeholders.** Stage 3 uses `0.5` for `providerAvailability`, `identityConfidence`, and `episodeMatch`. These are **reserved slots** for downstream enrichment — live provider observations are not part of Stage 3's static ranking.

4. **No ground-truth labeling.** Winners are "best composite score" not necessarily "correct match." No manual annotation was performed.

5. **Max uncapped latency: 694ms.** Acceptable for production but monitor if corpus grows significantly beyond 1.5M rows.

---

## 8. Fixture Artifacts (separate transfer)

| File | Size | Purpose |
|------|------|---------|
| `dmm-stage3-functional.db` | 560 KB | Integration smoke tests (529 rows) |
| `dmm-stage3-ranking.db` | 303 MB | Full retrieval regression (314K rows) |
| `dmm-stage3-fixture-manifest.json` | 9 KB | Query expectations, cardinalities, winner identities |
| `stage3-query-vectors.json` | 18 KB | JSON test vectors with deep-winner annotations |

Large DBs (`dmm-corpus.db` 1.4 GB) are not committed. Use ranking fixture for portable regression testing.

---

## 9. Next Agent Instructions

### What to build next:
- **Acquisition layer** — consume the ranked candidate set and combine with provider reality + fulfillment policy
- **Provider availability integration** — replace neutral `providerAvailability` placeholder (0.5) with live cache observations from downstream
- **Fulfillment policy** — decisions about placement, library projection, retry behavior

### What NOT to do:
- Do not modify HashSucker runtime behavior based on these findings alone
- Do not assume RETRIEVAL_WINDOW=2000 is safe to keep
- Do not conflate composite score with ground-truth correctness
- Do not add provider/cache logic inside Stage 3 — keep the boundary clean

### Validation before continuing:
```bash
# Verify pipeline integrity
node scripts/verify-pipeline.js

# Confirm regression suite passes against production
node scripts/regression-test.js data/dmm-corpus.db data/fixtures/regression-queries.json

# Review findings document
cat Docs/evaluation/retrieval-findings.md
```

---

## 10. Downstream Consumption Pattern

```javascript
// Stage 3 output: ranked candidate set (deterministic, static evidence only)
const rankedCandidates = await retrieveAndRank(corpusDb, mediaIntent);
// Returns: [{ hash, fileIndex, score, components, ... }]
// Note: score uses neutral availability placeholder (0.5)

// Downstream combines with provider reality + fulfillment policy
const acquisitionDecision = await buildAcquisitionPlan({
  candidates: rankedCandidates,     // from Stage 3
  availabilityPrior: cacheState,    // live provider observations from downstream
  fulfillmentPolicy: policy,        // from downstream
});
```

The ranked candidate set is **pure** — no provider state, no cache mutations, no side effects. It is a deterministic function of (corpus, query).

---

**End of Stage 3 handoff.**

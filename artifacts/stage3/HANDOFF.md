# Stage 3 Handoff Package — RIGHTMON Integration Testing

**Version:** 1.0.0  
**Generated:** 2026-08-23  
**Source:** dmm-corpus-builder (commit `2b6f13b`)  
**Source DB:** `data/dmm-corpus.db` (1.48M candidates, repaired FTS)

---

## 1. Corpus Summary

| Metric | Value |
|--------|-------|
| Total candidates | 1,480,357 |
| release_attributes rows | 1,480,357 |
| FTS rows | 1,480,357 |
| Schema version | HashSucker-compatible (FTS5 + triggers) |
| Identity semantics | `(info_hash, file_index_key)` where `-1` → `null` (torrent-level) |
| NULL fileIndex != 0 | ✅ Verified (no `file_index=0` rows exist) |

### Identity Semantics

- **infoHash:** 40-char hex string (SHA-1)
- **fileIndex:** `null` for torrent-level evidence, integer ≥ 0 for specific files
- **file_index_key:** `-1` in DB when `file_index` is NULL (SQLite convention)
- **NULL != 0:** A torrent-level candidate (fileIndex=null) is distinct from file index 0
- **No duplicate identities:** Each `(info_hash, file_index_key)` is unique

### FTS Schema

```sql
CREATE VIRTUAL TABLE release_search USING fts5(
  title, filename, resolution, source_type, codec,
  audio, release_group, language, media_type,
  tokenize='porter unicode61'
);
```

Three triggers keep FTS in sync with `release_attributes`:
- `release_attributes_ai` — AFTER INSERT
- `release_attributes_ad` — AFTER DELETE
- `release_attributes_au` — AFTER UPDATE

---

## 2. HashSucker-Aligned Retrieval Semantics

### Stage 1: FTS Retrieval

```sql
SELECT ra.info_hash, ra.file_index_key, ra.filename, ...
FROM release_search rs
JOIN release_attributes ra ON ra.rowid = rs.rowid
WHERE release_search MATCH ?
ORDER BY bm25_score ASC
LIMIT @retrievalWindow
```

**FTS query format:** Prefix-matchable AND semantics
- Each term becomes `"term"*` (prefix match)
- Multiple terms joined with AND
- Example: `"Dragon Ball"` → `"Dragon"* AND "Ball"*`

### Composite Ranking Formula

```
score = relevance × 0.25
      + quality × 0.20
      + releaseConfidence × 0.20
      + identityConfidence × 0.15
      + providerAvailability × 0.10
      + episodeMatch × 0.10
```

### Component Details

| Component | Formula | Source |
|-----------|---------|--------|
| relevance | `1.0 / (1.0 + abs(bm25))` | FTS BM25 score (lower = more relevant) |
| quality | `resolution*0.4 + source*0.3 + codec_bonus + hdr(0.15) + 4k_hevc(0.1)` | Parsed release attributes |
| releaseConfidence | `confidence` field | Parser confidence (0.0-1.0) |
| identityConfidence | `0.5` (NEUTRAL) for generic queries | Media association confidence |
| providerAvailability | `0.5` (NEUTRAL) for local-only | Provider cache observations |
| episodeMatch | `0.5` (NEUTRAL) for non-S/E queries | Episode coverage |

### Quality Tiers

```javascript
RESOLUTION_QUALITY = { '2160p': 1.0, '1080p': 0.9, '720p': 0.7, '480p': 0.4, '360p': 0.2 }
SOURCE_QUALITY = { 'Remux': 1.0, 'BluRay': 0.95, 'WEB-DL': 0.85, 'WEBRip': 0.75, 'HDTV': 0.6, 'DVD': 0.4 }
CODEC_BONUS = { 'x265': 0.1, 'x264': 0.05 }
HDR_BONUS = 0.15
HEVC_4K_BONUS = 0.1 (additional)
```

### Tie-Breakers (deterministic, in order)

1. Higher composite score wins
2. Higher releaseConfidence wins (parser evidence strength)
3. Higher quality wins (resolution/source evidence)
4. Higher relevance wins (title match strength)
5. Lower hash string wins (lexicographic, deterministic)
6. Lower fileIndex win (null sorts after 0)

---

## 3. Known RETRIEVAL_WINDOW=2000 Failure Cases

**Key finding:** 11/30 production queries have different winners under the 2000-cap.

| Query | Uncapped Winner Ordinal | Capped Winner |
|-------|------------------------|---------------|
| One Piece | 4605 | Different |
| Batman | 2458 | Different |
| Horror | 2771 | Different |
| Criterion | 2637 | Different |
| Remux | 76437 | Different |
| Extended | 5818 | Different |
| Dual Audio | 9105 | Different |
| Subs | 46129 | Different |
| Dubbed | 11446 | Different |
| AAC | 138252 | Different |
| DTS-HD | 52479 | Different |

**Recommendation:** Remove the pre-rank cap entirely. Paginate only after ranking. Max uncapped latency is 694ms (production queries), median 69ms.

---

## 4. Fixture Artifacts

### Files

| File | Size | Purpose |
|------|------|---------|
| `dmm-stage3-functional.db` | 0.55 MB | 529-row diverse sample for end-to-end testing |
| `dmm-stage3-ranking.db` | 303 MB | All FTS neighborhoods for 30 production queries |
| `dmm-stage3-fixture-manifest.json` | 9 KB | Query expectations, winners, cardinalities |
| `stage3-query-vectors.json` | — | JSON test vectors for automated testing |

### Checksums (SHA-256)

```
85b137eef12daf5bda2106b29bb84d8c906f43ae8ce470efb00753eba60963cf  dmm-stage3-fixture-manifest.json
b420de8fc3cdf30cb5d4aa78ad56452737a2631e3174bbce241b08df4a3d2645  dmm-stage3-functional.db
07151dd4c4aac82d89a10377a1b92f138cc22f6abd98ae59b0a57f4d422dec9b  dmm-stage3-ranking.db
```

### Generation

```bash
# Rebuild from production DB
node scripts/build-stage3-fixture.js data/dmm-corpus.db

# Validate
node scripts/validate-fixture.js

# Inspect
node scripts/inspect-fixture.js ranking
node scripts/inspect-fixture.js functional

# Show query vector
node scripts/show-query-vector.js "Dragon Ball"
```

---

## 5. Integration Vectors (Query Test Cases)

### Deep Winner Cases (ordinal > 2000)

These test whether retrieval preserves strong candidates that rank low in BM25 order:

| Query | Winner Hash (prefix) | Ordinal | Candidate Count |
|-------|---------------------|---------|-----------------|
| AAC | `1cc48599...` | 138,252 | 138,264 |
| Remux | `970c5fd8...` | 76,437 | 76,437 |
| Subs | `cf9a905f...` | 46,129 | 46,132 |
| DTS-HD | `970c5fd8...` | 52,479 | 52,479 |
| Dual Audio | `4d12f370...` | 9,105 | 9,111 |
| Dubbed | `cf9a905f...` | 11,446 | 11,446 |
| Extended | `22fa5654...` | 5,818 | 5,820 |
| One Piece | `4d4d590f...` | 4,605 | 4,617 |
| Horror | `4558851d...` | 2,771 | 2,785 |
| Criterion | `f38ebee3...` | 2,637 | 2,637 |
| Batman | `2ef37e1c...` | 2,458 | 2,458 |

### High-Cardinality Cases (>40k matches)

| Query | Candidate Count | Winner Hash |
|-------|----------------|-------------|
| AAC | 138,264 | `1cc48599...` |
| Remux | 76,437 | `970c5fd8...` |
| DTS-HD | 52,479 | `970c5fd8...` |
| Subs | 46,132 | `cf9a905f...` |

### Null fileIndex Cases

All production queries have winners with `fileIndex: null` (torrent-level). The fixture preserves this semantic:
- `file_index IS NULL` in DB → `fileIndex: null` in results
- `file_index = 0` does NOT exist in this corpus
- `file_index_key = -1` is the DB representation of NULL

---

## 6. RIGHTMON Usage Guide

### Copy Fixtures

```bash
# From corpus-builder repo
scp data/fixtures/dmm-stage3-* user@rightmon:/path/to/fixtures/
scp data/fixtures/stage3-query-vectors.json user@rightmon:/path/to/fixtures/
```

### Validate Fixtures (on RIGHTMON)

```bash
# Run validation suite
node scripts/validate-fixture.js

# Inspect ranking fixture
node scripts/inspect-fixture.js ranking

# Show specific query vector
node scripts/show-query-vector.js "Naruto"
```

### Integration Testing Pattern

```javascript
// Load query vectors
const vectors = require('./data/fixtures/stage3-query-vectors.json');

for (const qv of vectors.queries) {
  const result = await hashSuckerSearch(qv.query);
  
  // Verify winner identity
  assert.strictEqual(result.winner.infoHash, qv.expectedWinner.infoHash);
  assert.strictEqual(result.winner.fileIndex, qv.expectedWinner.fileIndex);
  
  // Verify score is close (allowing for floating-point)
  assert(Math.abs(result.winner.score - qv.expectedWinner.rankingScore) < 0.001);
}
```

---

## 7. Known Limitations

1. **BM25 scores are corpus-dependent.** Ranking fixture preserves production BM25 scores as metadata, but re-running FTS queries on the subset will produce different BM25 values. Use `production_bm25` column for exact reproduction.

2. **2/30 winners differ in fixture vs production.** `Remux` and `Subs` have tie-break sensitivity to BM25 corpus scope. Both are within 0.001 rank score.

3. **No live discovery data.** Fixtures contain only local corpus results. No provider observations, no media associations.

4. **No episode-coverage data.** Season/episode fields exist but are sparsely populated in this corpus.

5. **Confidence values are DMM-derived.** All rows have `source: "dmm"` and `confidence: 0.6`. Real-world queries may have multiple enrichment sources.

---

## 8. Schema Version History

| Version | Date | Change |
|---------|------|--------|
| 1.0.0 | 2026-08-23 | Initial release. HashSucker-compatible schema with `production_rowid` and `production_bm25` metadata columns. |

---

## 9. Commands Reference

```bash
# Build fixtures from production DB
node scripts/build-stage3-fixture.js data/dmm-corpus.db

# Validate fixtures
node scripts/validate-fixture.js

# Inspect fixture contents
node scripts/inspect-fixture.js functional
node scripts/inspect-fixture.js ranking

# Show query vector for specific query
node scripts/show-query-vector.js "Dragon Ball"

# Run full test suite
npm test

# Compute checksums
sha256sum data/fixtures/*
```

---

**End of HANDOFF.md**

# Stage 3 tooling handoff integration

- Integrated: 2026-08-23
- Accepted baseline: `3eeed24`
- Source archive: `stage3-tooling-handoff.tar.gz`
- Archive SHA-256: `62681c6e5268e6fae3250cb513ba39f0b4d0a22150019c86281c105aabb3bcbe`
- Claimed source commit: `94e8fd4` (not present in this repository's Git object database)

## Disposition

The archive passed gzip/tar extraction and every checksum in its internal `Checksums.txt`. Its five files are preserved verbatim under [`tooling-handoff-94e8fd4/`](tooling-handoff-94e8fd4/) as source provenance.

The package contains documentation, checksums, and one query-data projection. It does **not** contain the five executable scripts its handoff document attributes to source commit `94e8fd4`. Those missing source scripts were therefore not imported or reconstructed.

The current accepted Stage 3 baseline remains authoritative because it already contains the maintained and executable replacement tooling:

- [`../../media-search/src/lib/discovery/stage3-fixture-evaluator.js`](../../media-search/src/lib/discovery/stage3-fixture-evaluator.js)
- [`../../media-search/src/scripts/stage3-fixture-report.js`](../../media-search/src/scripts/stage3-fixture-report.js)
- [`../../media-search/test/stage3-fixture-harness.test.js`](../../media-search/test/stage3-fixture-harness.test.js)
- [`../../docs/evaluation/RIGHTMON-STAGE3-FINALIZATION-2026-08-23.md`](../../docs/evaluation/RIGHTMON-STAGE3-FINALIZATION-2026-08-23.md)
- `npm run stage3:report`, `npm run test:stage3`, and `npm run test:stage3:ranking` from `media-search/`

## Comparison with the accepted baseline

| Archived file | Result |
|---|---|
| `regression-queries.json` | Same 30 query names and expected winner identity, file index, ordinal, and score as `stage3-query-vectors.json`. The accepted vectors additionally preserve candidate counts, capped winners, and the measured summary, so this is retained as provenance rather than used as a second oracle. |
| `retrieval-findings.md` | Earlier producer analysis. Its 19/30 cap agreement and 11 deep-winner class agree with the accepted result. Some prose ordinals and fixture-local examples conflict with the accepted production-vector/reference distinctions. |
| `regression-test-guide.md` | References scripts and `data/fixtures` paths not supplied by the archive and not used by this repository. The accepted commands above supersede it. |
| `HANDOFF.md` | Correctly places provider reality and acquisition decisions downstream of Stage 3, but its script inventory is absent from the archive and its exact-oracle language predates the accepted native/reference separation. |
| `Checksums.txt` | All four archived payload checksums pass. It covers only this nested handoff, not the accepted fixture databases. |

The accepted fixture checksums remain in [`Checksums.txt`](Checksums.txt). The 303 MiB `dmm-stage3-ranking.db` remains intentionally local and ignored; the functional fixture, manifest, vectors, and producer handoff remain tracked.

## Recorded conflicts

1. The archived guide names `run-retrieval-suite.js`, `regression-test.js`, `generate-regression-suite.js`, `corpus-observability.js`, and `verify-pipeline.js`, but none is included in the archive. The current fixture evaluator/report/harness is retained instead of inventing source.
2. The archived findings propose quality pre-filtering and a cap for cardinality above 50,000. The accepted measured decision is no pre-rank truncation for this workload unless future representative evidence establishes a safe policy.
3. The archived findings mix fixture-local and production-BM25 winners in examples such as `Remux` and `Subs`. The accepted finalization keeps those phases separate and records frozen vector conflicts explicitly.
4. Producer latency values in the archive are historical evidence only; the current harness validates correctness and fixture immutability, not a new production latency benchmark.
5. No current runtime ranking or retrieval semantics were changed to reconcile these conflicts.

## Preserved boundary

```text
Stage 3 static evidence → ranked candidate set
ranked candidate set + fresh provider reality + fulfillment policy → downstream acquisition decision
```

Stage 3 does not probe providers, interpret live cache state, create placements, or choose final acquisition. Provider reality and acquisition decisions remain downstream.

## Remaining source-handoff gap

The original five scripts from claimed commit `94e8fd4` remain unavailable. This does not block the accepted Stage 3 regression contract because current executable tooling covers fixture integrity, native/reference comparison, the 11-query cap regression, exact identity, and immutable source evaluation. Recover the original scripts only for historical provenance or additional corpus-observability work; do not substitute them for the accepted baseline without a new review.

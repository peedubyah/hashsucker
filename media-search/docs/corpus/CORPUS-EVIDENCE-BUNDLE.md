# CORPUS-EVIDENCE-BUNDLE.md

## Slice 2R — Candidate Evidence Bundle Projection

**Status:** Complete
**Commit:** (pending)

## Purpose

Provides a unified read-only projection of all available evidence for a candidate identity. Composes persistence, topology, and confidence projections into a single deterministic bundle that downstream acquisition, materialization, and repair layers can consume.

This is **NOT** acquisition. It is a normalized evidence contract.

## Architecture

```
corpus-evidence-bundle.js
  ├── corpus-persistence-features.js  (Slice 2O)
  ├── corpus-topology-features.js    (Slice 2P)
  ├── corpus-confidence-features.js  (Slice 2Q)
  └── release_attributes table
```

The bundle composes existing projections instead of duplicating logic. No new data sources are accessed.

## Contract

```javascript
{
  identity: {
    infoHash,       // string
    fileIndex,      // number|null (null for torrent-level)
  },

  release: {
    attributes,     // Array of release_attribute rows for this info_hash
    count,          // number of release attribute rows
  },

  persistence: {
    temporal: {
      firstObserved,  // epoch ms|null
      lastObserved,   // epoch ms|null
      ageMs,          // number|null (last - first)
    },
    persistence: {
      versionsObserved,   // number of versions containing this candidate
      versionsAvailable,  // total versions for this source
      survivalRate,       // versionsObserved / versionsAvailable (0-1)
    },
    lifecycle: {
      currentlyPresent,   // boolean — present in latest version
      addedCount,         // number of version transitions into presence
      removedCount,       // number of version transitions out of presence
      churnCount,         // addedCount + removedCount
    },
  },

  topology: {
    files: {
      totalFiles,
      mediaFiles,     // video + subtitle + archive
      nonMediaFiles,  // everything else
      videoFiles,
      subtitleFiles,
      archiveFiles,
    },
    structure: {
      singleFileMedia,    // true if exactly one video file
      hasExtras,          // bonus/trailer/behind-the-scenes
      hasSamples,         // sample files detected
      hasSeasonStructure, // season metadata present
      largestFileRatio,   // largest file size / total size (0-1)
    },
    quality: {
      likelyPlayableTarget,   // boolean — video file > 10MB, not sample
      topologyConfidence,     // 0-1 structural quality estimate
      warnings,               // topology-level warnings
    },
  },

  confidence: {
    overall,  // 0-1 weighted combination of persistence, topology, metadata
  },

  risks: [
    // Deduplicated risk signals from all evidence layers:
    'corpus_not_persistent',    // survivalRate < 0.5
    'no_longer_in_corpus',      // was present, now gone
    'high_churn',               // churnCount > 2
    'no_files',                 // topology has zero files
    'sample_present',           // sample files detected
    'multiple_video_candidates',// > 1 video file (ambiguous target)
    'low_topology_confidence',  // topologyConfidence < 0.4
    'unknown_topology_quality', // no topology confidence computed
    'missing_metadata',         // no release attributes found
  ],

  evidenceQuality: {
    hasPersistenceHistory,      // versionsAvailable > 0
    hasTopologyData,            // totalFiles > 0
    hasReleaseAttributes,       // release attributes exist
    persistenceVersionsObserved,
    topologyTotalFiles,
    releaseAttributeCount,
  },
}
```

## Identity Semantics

The bundle preserves `(info_hash, file_index_key)` identity semantics:
- `null` file index maps to `file_index_key = -1`
- `0` file index maps to `file_index_key = 0`
- These are distinct identities throughout all composed projections

## Explicit Prohibitions

This projection **MUST NOT**:
- Modify scoring or ranking
- Select winners or choose between candidates
- Call providers or access provider observations
- Create materialization records
- Alter database schema
- Write to any table
- Access acquisition logic

## Evidence Composition

The bundle collects risks from multiple layers:

1. **Persistence risks** — survival rate, presence state, churn frequency
2. **Topology risks** — missing files, samples, ambiguous video count, low structural confidence
3. **Confidence risks** — missing metadata, warnings from confidence projection

All risks are deduplicated in the final `risks` array.

## Graceful Degradation

The bundle tolerates missing evidence gracefully:
- No persistence history → empty temporal, zero counts, null survival rate
- No topology data → zero file counts, null confidence
- No release attributes → empty array, zero count
- Unknown hash → all defaults, all flags false

## Determinism

Output is fully deterministic for a given identity:
- Same inputs always produce same output
- No randomness, no time-dependent values beyond what corpus already stores
- No external state consulted

## Tests

14 tests covering:
- Complete evidence candidate
- Missing persistence history
- Missing topology data
- Missing release attributes
- Multiple file indexes
- Deterministic repeated output
- Identity isolation between hashes
- No ranking behavior
- No provider access
- Risk collection
- Null vs 0 file index distinction
- Unknown hash handling
- Evidence quality summary

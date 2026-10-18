# Temporal Correspondence Experiment Results (2026-10)

Status: isolated research. No production code, schema, Binding, playback, or
provider behavior changed.

## Verdict

`PROMISING — correspondence primitive is technically credible`

Audio-based temporal correspondence at low sample rate distinguished
same-cut encodes from materially different cuts on the tested corpus, recovered
a 12-second global offset, and exposed a piecewise insertion with sufficiently
fine window scanning. False positives on scored negative controls were zero
under a coverage-gated confidence model. The transform is not yet safe for
automatic substitution without conservative gating and better piecewise
extraction.

## Test corpus

| Pair | Media | Files | Durations | Believed ground truth | Basis |
|---|---|---|---|---|---|
| P1 | tt0386676 S01E02 | `base_300.mkv` vs `enc_h264_720.mp4` | 300s vs 300s | SAME_TIMELINE | Same 300s segment, re-encoded to H.264 720p |
| P2 | tt0386676 S01E02 | `base_300.mkv` vs `enc_h264_1080.mkv` | 300s vs 300s | SAME_TIMELINE | Same 300s segment, re-encoded to H.264 1080p |
| P3 | tt0386676 S01E02 | `base_300.mkv` vs `offset_plus12.mkv` | 300s vs 312s | SAME_WITH_GLOBAL_OFFSET | Same segment with 12s lead-in |
| P4 | tt0386676 S01E02 | `base_300.mkv` vs `piecewise_insert.mkv` | 300s vs 335s | PIECEWISE_CORRESPONDENT | 30s segment inserted at ~120s |
| P5 | tt0386676 S01E02 | `base_300.mkv` vs `deleted_scene.mkv` | 300s vs 248s | DIFFERENT_CUT | 60s middle scene deleted |
| P6 | tt0386676 S01E01 vs S01E02 | two episodes | 300s vs 300s | WRONG_CONTENT | Different episodes |
| P7 | Total Recall | 2160p 6796s vs 2160p 7816s versions | 300s sampled vs 300s sampled | DIFFERENT_CUT | Real title with different durations/cuts |

Exact pair identity, sizes, TF IDs, and release names are recorded in the
experiment directory's `metadata.json` and generated corpus filenames. The
VFS-backed active files were used for real pairs; synthetic variants were
derived from `tt0386676` S01E02 to create controlled positive, offset, and
piecewise cases.

## Methods tried

1. Structural metadata baseline:
   - duration, container, codec, resolution, audio layout, track counts,
     chapter counts.
2. Audio correspondence:
   - Downmix to mono.
   - Resample to 1000 Hz PCM.
   - FFT cross-correlation for global lag.
   - 10-second window matching across the full timeline.
3. Piecewise mapping:
   - Per-window best-match scan.
   - Coverage and lag-consistency inspection.
4. Cost measurement:
   - Wall-clock and CPU time for extraction and correlation.

Video fingerprinting was not implemented. Audio alone was sufficient to
separate the tested controls; video remains a secondary evidence source for
audio-less, multi-language, or commentary-track cases.

## Raw signal observations

Structural metadata:

- Duration alone rejected grossly different cuts (Total Recall 6796s vs 7816s).
- Duration alone did not distinguish same-cut re-encodes (both 300s) from
  offset or piecewise variants.
- Codec, resolution, and audio layout changed across same-cut re-encodes,
  so structural metadata alone would falsely reject valid correspondences.
- Chapter metadata was absent for all tested files, so chapter-based
  alignment was unavailable.

Audio global correlation:

- Same-cut re-encodes: correlation ~0.988.
- 12s offset: best lag 12.011s, correlation 0.884.
- Piecewise insertion: global correlation 0.656, lower and less decisive.
- Deleted scene: global correlation 0.716, misleadingly high.
- Wrong content: global correlation 0.430, a seductive false positive.
- Total Recall different cut: global correlation -0.019.

Audio window coverage:

- Same-cut: 10/10 windows matched, coverage 1.00.
- Deleted scene: 4/10 windows matched, coverage 0.40.
- Piecewise insertion: 4/10 windows matched at coarse 30s scan, coverage 0.40;
  a finer scan found an individual window at B@155s with correlation 0.935.
- Wrong content: 0/10 windows matched, coverage 0.00.
- Total Recall: 0/10 windows matched, coverage 0.00.

## Pair-by-pair results

| Pair | Global corr | Best lag | Window coverage | Verdict |
|---|---:|---:|---:|---|
| P1 same-cut 720p | 0.9876 | ~0s | 1.00 | PROVEN_CORRESPONDENT |
| P2 same-cut 1080p | 0.9884 | ~0s | 1.00 | PROVEN_CORRESPONDENT |
| P3 12s offset | 0.8838 | 12.011s | 1.00 | PROVEN_CORRESPONDENT with global offset |
| P4 piecewise insertion | 0.6563 | ~0s (misleading) | 0.40 coarse; fine scan found 0.935 | CORRESPONDENT_WITH_GAPS |
| P5 deleted scene | 0.7162 | ~0s | 0.40 | CORRESPONDENT_WITH_GAPS / different cut |
| P6 wrong content | 0.4301 | -0.078s | 0.00 | INCOMPATIBLE |
| P7 Total Recall | -0.0187 | 39.254s | 0.00 | INCOMPATIBLE |

## Derived maps

- Same-cut pairs: identity mapping `A[t,t+win] ↔ B[t,t+win]`.
- Offset pair: `A[t,t+win] ↔ B[t+12s,t+12s+win]`.
- Piecewise pair: first ~120s align at zero offset; inserted 30s region has
  no counterpart in A; post-insertion content aligns with a ~32.8s offset.
- Deleted-scene pair: first ~120s align; subsequent content is absent from B,
  producing an unmappable gap rather than a clean global offset.
- Wrong-content and Total Recall pairs: no stable window correspondence.

## False positives

- Strict false positives on scored negative controls: 0.
- The global-correlation-only model would have produced false positives
  (wrong content 0.43, deleted scene 0.72). The coverage-gated model rejected
  them.
- The 12s offset and piecewise cases show that global correlation alone is
  insufficient; window coverage and lag consistency are required.

## False negatives

- Strict false negatives on scored positive controls: 0.
- The deleted-scene case is not a false negative: it is a materially different
  cut and was not labeled PROVEN_CORRESPONDENT.

## Ambiguous cases

- Piecewise insertion detection depends on scan resolution. A 30s window step
  missed the exact insertion boundary; a finer scan found the transition.
- Audio mixing differences, commentary tracks, language differences, and
  silence were not tested in this corpus.
- Video fingerprint evidence was not evaluated.

## Cost envelope

Per 300s at 1000 Hz:

- PCM extraction: ~0.5s wall-clock.
- Global cross-correlation: ~0.11s CPU/wall.
- Full 10-window x 33-window scan: ~30-40s for one pair.
- Temporary disk: ~0.6 MB PCM per 300s; window files negligible.

Extrapolated qualitatively:

- Global alignment is cheap enough for on-demand use.
- Full window-scan correspondence is better suited to idle/offline analysis
  or rare representation-switch preparation, not per-play latency.
- Sparse probes should be used first; full scans only when a candidate
  survives initial gating.

## Best evidence combination

1. Structural duration gate to reject grossly different cuts.
2. Audio global cross-correlation to estimate offset.
3. Windowed audio correspondence to measure coverage and detect gaps.
4. Conservative classification:
   - high coverage + stable lag -> PROVEN_CORRESPONDENT
   - high coverage + one stable offset -> PROVEN with global offset
   - partial coverage + detectable transition -> CORRESPONDENT_WITH_GAPS
   - low coverage -> INCOMPATIBLE or INSUFFICIENT_EVIDENCE

## Known failure modes

- Global correlation can be misleadingly high for partial overlaps.
- Window-scan resolution determines piecewise detection quality.
- Different audio mixes, languages, commentary tracks, PAL speed differences,
  and silence were not tested.
- Synthetic variants share the same source audio, which is a stronger
  positive control than independent encodes but does not test codec-induced
  audio differences.
- Total Recall VFS file reported broken keyframe markers, though audio
  extraction succeeded.

## Reusable fingerprints

A per-TorrentFile audio fingerprint could be compared against many alternates
cheaply if stored as windowed hashes or compact spectral features. Raw PCM
should not be stored. Evidence should be invalidated when:
- the transform is contradicted by a later probe
- a representation is found to be a different cut
- the file's audio track changes
- the confidence model is revised

Pairwise correspondence should be the initial unit; per-file reusable
fingerprints are plausible but require a separate experiment.

## Recommendation

The correspondence primitive is technically credible as an evidence-backed,
conservative, non-boolean transform. It should remain isolated research
until:
- independent real pairs are tested
- audio edge cases are exercised
- a confidence model is calibrated on a larger corpus
- false positives remain zero under stricter conditions

No production integration is warranted yet.
## Real-world phase (added 2026-10)

### Real corpus scored

Synthetic fixtures remain debugging controls only and are not counted in the
real-world claims below.

| Pair | Media | Source A | Source B | Ground truth confidence | Temporal correspondence | Same semantic cut | Safe position mapping |
|---|---|---|---|---|---|---|---|
| R1 | The Matrix (1999) | active HYPERION remux | superseded RERIP encode | HIGH | Yes | Yes | SAFE |
| R2 | Breaking Bad S01E01 | active 1080p BDrip | superseded 2160p NF WEB-DL | MEDIUM | Partial | Likely, but audio mismatch | UNKNOWN |
| R3 | Star Wars IV | active theatrical | superseded Rogue Cut fanedit | HIGH | No after initial shared region | No | UNSAFE |
| R4 | Total Recall | 2020/6796s version | 2012/7816s version | HIGH | No | No | UNSAFE |
| R5 | Dune | Dune (2020) | Dune (2021) | HIGH | No | No (different movies) | UNSAFE |
| R6 | tt0386676 S01E01 vs S01E02 | two episodes | two episodes | HIGH | No | No | UNSAFE |

### Real-pair audio results

- R1: 3/3 windows matched at ~0s lag with correlations 1.000, 0.968, 0.985.
- R2: 3/3 windows matched near 0s lag with correlations 0.871, 0.581, 0.762.
  Lower correlation is attributed to mastering/mix differences, not necessarily
  a different cut.
- R3: first 30s window correlated at 0.549; later windows dropped to 0.064 and
  below. Treated as different cut / fanedit.
- R4: 0/10 window coverage.
- R5: 0/10 window coverage despite near-equal total duration.
- R6: 0/10 window coverage.

### Audio-track robustness

- Matrix: both sources had comparable 6-channel English audio; high agreement.
- Breaking Bad: both sources had 6-channel English audio, but correlation was
  materially lower, showing that same-language/same-channel-count audio is not
  sufficient for high confidence.
- Commentary, alternate languages, stereo-vs-5.1, and silence-heavy cases were
  not represented in the real corpus.
- Star Wars superseded file exposed only 3 streams in the fetched prefix; track
  selection was not fully validated.

### Video evidence

Video fingerprints were not implemented in this phase. Audio evidence alone was
sufficient to reject the real negative controls, but it was not sufficient to
resolve the Breaking Bad audio-mismatch case. Video corroboration remains a
plausible next step for ambiguous audio cases.

### Real-world verdict

`USEFUL ONLY AS SUPPORTING EVIDENCE`

Reasoning:
- One high-confidence real positive pair (Matrix).
- One ambiguous real pair (Breaking Bad) where likely same cut could not be
  established safely from audio alone.
- Four real negative pairs rejected with zero coverage.
- Corpus is too small and audio edge cases are untested, so automatic
  substitution is not justified.

### Exact next bounded step

1. Add 5-10 more independently sourced real pairs, including stereo-vs-5.1,
   alternate languages, commentary-first files, and near-duration different cuts.
2. Implement sparse video fingerprints only for pairs with ambiguous audio.
3. Measure whether video corroboration changes any verdict.
4. Re-run the same confidence model; automatic substitution remains blocked
   until false positives stay zero on a larger real corpus.

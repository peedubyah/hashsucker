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

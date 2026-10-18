# Retrospective: identity-trust slice (wrong-content selection)

## Expected vs actual
Expected a narrow matcher tightening plus an association audit. Got a
structural redesign of where identity is decided: the audit's first run
(1252 contradicting rows, nearly all legitimate Oppenheimer/Matrix
releases) proved naive strictness was a false-negative machine, forcing
portion isolation (series-S/E, movie-year) instead of any stoplist.

## Surprises
1. Parser residue, not titles, was the dominant false-negative source.
   Stored `release_attributes.title` routinely embeds codec/audio/edition
   tokens ("Oppenheimer 10bit 6CH"). Comparing filenames structurally
   fixed ~80% of the audit bucket in one move.
2. The parser stores `season: NULL` for bare-SNN packs, blinding the gate
   to season evidence the filename plainly carries. Filename-derived
   `effSeason` (single unambiguous token only) fixed TV packs without
   touching stored data.
3. The en-richment worker (5397 pending, zero writes ever) uses raw
   substring `includes` matching — a live poison pipeline one manual run
   away from arming. Hardened despite dormancy.
4. The Rogue Cut binding proved the audit's worth within hours: a real
   fanedit serving as canonical ANH in production, repaired same-slice.
5. `Se7en`'s 7 stands for V, not T — a fixed leet map yields "seten".
   Built it, measured it wrong, deleted it. Alias evidence only.

## Disproved assumptions
- "Substring containment is mostly fine with a title gate." False: it
  was the Diddy mechanism and the Mogul superstring class.
- "Association confidence reflects evidence strength." False: backfill
  wrote tier confidence for merely-eligible rows; capped at 0.6 now and
  tier-restricted.
- "The year gate is enough for movies." False without title isolation:
  same-year different-film clusters (1963→8½) sailed through until the
  title gate hardened.
- "A curated alias table will rot." Mitigated by the admission bar
  (observed-or-verified, same-media-only, needed-only) + per-entry
  provenance comments.

## Wasted effort / cause
- The foldStylized leet implementation + tests (built, then deleted on
  measurement). Cause: assumed the stylization mapping instead of
  testing one example first.
- One edit clobbered a function header (`extractOtherSeasonToken`) and one
  dropped a `catch` line; both caught by `node --check` immediately.
  Lesson: run the syntax check after every edit, not every few.

## Most useful test
`identity-gate.test.js` adversarial fixtures (Diddy/Mogul, superstrings,
residue movies). They caught two real regressions during construction
(MobLand-S01 benign extras; Blade Runner Final Cut).

## Lying / overconstraining test
Two ranking tests encoded the old unsafe semantics (wrong-season
Verified-at-lower-score; aggregate counter keyed on old evidence
strings) and were updated to the new contract, not deleted.

## Automation that should disappear
Nothing added that should disappear. The scratch audit/quarantine scripts
are deleted post-slice (repo must not accumulate them).

## Guidance change
- Portion isolation before comparison is now the house pattern for any
  future title work; stoplists are a last resort with a documented
  blast-radius analysis.
- Association writes require hardened-eligibility proof; confidence caps
  are not a substitute for tier gates (tiers ignore confidence).
- Known-alias additions need an observed release spelling in the comment.

## Complexity to remove
- `matchBilingualSegments` is now redundant with the affix rule (dash
  collapses to space before matching) but kept as defense-in-depth for
  raw-dash shapes. Revisit: if no bilingual row ever needs the raw-dash
  path in 3 months, delete it and keep affix-only.
- `diagnoseIdentityEligibility`/`countIdentityEligibility` still describe
  association presence without the veto semantics; they are diagnostics,
  but their "Rejected" language now disagrees with `classifyIdentityTier`.
  Reconcile or relabel on next touch.

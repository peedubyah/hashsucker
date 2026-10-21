# Retrospective: what does exactness cost us?

## Expected vs actual

Expected to measure a price: demote the top-ranked candidate, name the
quality the user got instead, and price the cheapest way to stop paying.

Found the opposite shape. The tax is not a metadata gap and not a
provider-lookup gap — it is a **wrong fact already in hand**. The corpus
path hands the selection a release's *total* byte count and calls it the
candidate's *exact file size*; for a release with more than one playable
file that number matches no file, so the exact-size proof cannot succeed
and the candidate is demoted. The upstream publishes the real per-file size
in the response the live path already receives, and it proves a file in
93.7 % of cases against the corpus count's 45.1 %.

The measurement also found the price is currently **small** — one decision
bound in the cohort, with a pairwise delta of Negligible 7 / Minor 3 /
Material 0 / Severe 0, and the user received 2160p every time. The tax is
paid in *proof* before it is paid in *quality*, and the cohort's demotions
happened to be among near-equivalent candidates.

## Surprises

1. **The question was unanswerable from the persisted record.** The
   ranking is persisted (`media_request_results`), the winner is persisted
   (`playback_handoffs`), and **nothing persisted the losers or the reasons
   they lost**. "Was rank-1 demoted because its identity was unprovable, or
   because of something else?" was undecidable after the fact. Every
   answer in the previous slice's notes about *why* a candidate lost was an
   inference. The diagnostic had to be built before the question could be
   asked — and it is now the answer to "what changed?"
2. **The exclusion matters more than the effect.** 537 of 560 skips
   (95.9 %) were provider-unavailable, not exactness. A naive "the top
   candidate lost" read overstates the tax by an order of magnitude. The
   event definition had to be narrow or the number would have been a lie.
3. **A targeted provider lookup — the obvious fix — does not work.** 29 of
   the 32 multi-file candidates that reach selection are **episode packs**.
   The candidate's release name names the *pack*; the provider's inventory
   lists *files*. No inventory call can turn a pack name into a file name.
   A per-file fact about the candidate closes 32/32; a provider inventory
   call closes 4/32.
4. **The upstream was already publishing the answer.** `behaviorHints.videoSize`
   on 456 of 582 streams. This is the same fact the earlier recon recorded
   as "absent without a debrid key" — with a debrid key it is *the exact
   per-file byte count*, and the live path already carries it as
   `exactFileSize`. The corpus path throws it away and substitutes the
   release total.
5. **A real defect surfaced only because the measurement needed it.** The
   availability checker's batch-failure path used the error category
   `'transient'`, which is not in `PROVIDER_ERROR_CATEGORIES`, so the
   observation layer **threw out of the catch block**. The intended
   degradation never happened, the exception escaped, and every candidate
   lost its cached/uncached state — so the uncached-deferral traversal
   silently stopped deferring. It fires exactly when the availability fact
   matters most.

## Disproved assumptions

- "The demotions are because the corpus lacks a per-file path." No: the
  corpus lacks a per-file path **and** the selection is given a number
  that is not a file size either. The path's absence is a real debt; the
  *wrong number* is the immediate cause, and it is free to fix.
- "The tax is a provider problem." No: the provider holds the release and
  lists the files. The provider already has the answer.
- "A provider lookup on rank#1 would recover the quality." No — for a
  pack it cannot; the candidate's own name does not name a file.
- "The historical record can be replayed to measure this." No, and now for
  a sharper reason than "the candidates were never persisted": even where
  the candidates *are* persisted, the *decision* was not, so the
  reason a candidate lost is gone. That is why the diagnostic exists.

## Wasted effort and its cause

- **Three cohort runs measured the harness, not the product.** The
  shadow seam dropped the control plane, so every binding failed closed
  with `INVALID_INPUT` and every candidate looked "unprovable". The
  production seam in `app.js` injects the control plane itself; the
  harness had to match it. The first two runs were discarded rather than
  reported. **The cost was not the run, it was the temptation to report
  them**: a run whose numbers are dramatic and wrong is the most
  dangerous kind of result, and the only defence is the production seam
  being reproduced exactly, not approximately.
- **Chasing `INVALID_INPUT` through three layers of indirection.** The
  selection calls the seam; the seam calls the ensure; the ensure
  validates its inputs. The trace was cheaper than the reasoning: one
  print of the parameters named the cause in a line.
- **A 2.1 GB corpus copy** to run a cohort that mostly did not need it.
  The scratch copy was right (the rules require it), and the disk was
  fine, but the cohort would have been just as decisive against the
  smaller control-plane copy plus a filtered corpus.

## The most useful test

`availability.test.js`'s new case — *a failing batch degrades to
`unknown`, it does not throw*. It pins a behaviour that was silently
broken and that no other test would have caught, because the failure only
happens when the provider fails, and every other test has the provider
succeeding. It is the difference between "the measurement worked" and
"the measurement measured something".

## The lying / over-constraining test

None written in this slice. The diagnostic's five tests assert *behaviour*
(the reasons are verbatim, the table is append-only, a write failure is
contained, recording does not mutate the selection) — not the schema, not
the row count, not the JSON shape. The one test that came closest to
over-constraining was the "no update or delete surface exists" assertion:
it pins the *absence* of a capability, which is a real requirement here
(append-only is the point) but would need revisiting if a retention policy
ever needs a delete. Worth noting as a deliberate constraint, not an
accident.

## Automation that should disappear

The two measurement scripts (`proof-tax-cohort.mjs`, `proof-tax-probe.mjs`)
are tools, not product. They are worth keeping for the next cohort — the
terminal condition in the build log needs exactly them — but they must not
be wired into any runtime path. Both write only to scratch DBs and neither
is reachable from the server.

## Guidance change

**A measurement slice must first prove that the fact it needs is
persisted.** Two slices in a row now failed the same way for the same
reason: the first-try-wins slice could not price the user-visible delta
because the selected candidate's score was not stored beside the handoff,
and this slice could not classify a demotion because the losers' reasons
were not stored. The rule that follows: *if the question is about a
decision, the decision's context must be durable before the question is
asked* — and the diagnostic table is the first thing to build, not the
last.

Second: **a shadow harness must reproduce the production seam exactly,
or its numbers are a story about the harness.** The failure was silent
and dramatic.

## Complexity to remove

- The corpus path's `selectedFileSize: row.size` (and its twin
  `exactFileSize: row.size`) is a **lie in the field's own terms**: the
  field means "the exact per-file byte count" and the value is a
  release total. It is the single cheapest defect to remove, and it is
  *not* in this slice (measurement only) — it is the next slice's first
  candidate, and the build log states it.
- The `exactness` cause bucket has one member with a real cause
  (`movie-ambiguous` — the release holds several playable files and
  nothing names the one wanted) and one bucket that mixes two different
  failures (`no-bindable-path` covers both "the size matched no file" and
  "no path to try"). If the taxonomy is ever promoted into the product,
  those two must separate.

## What the next agent should know

- The production container still runs the **previous** build. The
  instrumentation and the availability fix are committed and pushed but
  **not deployed**; the availability fix has a unit test and no production
  request.
- The cohort's live arm bound **once**: most live candidates are
  releases the TorBox account does not hold, so the live arm's decisions
  ended in provider-unavailable. The live arm's *fact* is measured (93.7 %);
  its *decisions* are not observed in bulk. A cohort that binds the live
  arm in bulk is the next measurement.
- 58 releases (6.3 %) where **neither** the corpus count nor the upstream
  size proves a file are unexplained.
- The Real-Debrid inventory was never exercised for the size match.
- The terminal condition for the next slice is in the build log: *would
  carrying the upstream's per-file size instead of the release-level count
  have produced a different — and better — representation?*

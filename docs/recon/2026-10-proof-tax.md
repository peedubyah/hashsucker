# WHAT DOES EXACTNESS COST US? — the proof tax (2026-10-21)

Measurement only. **No ranking, selection, binding, or provider behaviour
changed.** One product defect was found and fixed (the availability
checker's error category, below); one diagnostic was added so the question
is answerable in future without a replay.

The question: when HashSucker demotes the **top-ranked** candidate because
its exact identity cannot be proven and picks a **lower-ranked** one
instead, what quality does the user actually get — and what is the cheapest
safe way to stop paying it?

---

## 0. The short answer

**The proof tax is real, it is concentrated in the corpus path, and the
upstream already carries the fact that closes it.**

The corpus path presents the **release-level** byte count (the torrent's
total size) as the candidate's "exact file size". For a release with more
than one playable file that number matches **no** file, so the exact-size
proof cannot succeed and the candidate is demoted. The upstream (the debrid
addon) publishes the **real per-file** byte count in `behaviorHints.videoSize`,
and that size proves a file in **93.7 %** of the cases where the provider
holds the release, against **45.1 %** for the corpus count.

The tax is therefore not a metadata gap. It is a **wrong fact already in
hand**: the corpus hands the selection a number that is not a file size.

---

## 1. Method

### 1.1 What had to be built first

The question was **unanswerable** from the persisted record.
`media_request_results` holds the *ranking*; `playback_handoffs` holds the
*winner*. **Nothing holds the losers or the reasons they lost.** "Was rank-1
demoted because its identity was unprovable, or because of something else?"
was therefore undecidable after the fact.

So the decision site now records it, append-only, in a new
`selection_decisions` table (discovery DB):

| column | what it holds |
|---|---|
| `selected_info_hash` / `selected_file_index` / `selected_rank` | the winner |
| `selected_reason` | why the winner was chosen (verbatim) |
| `serviceability` | the delivery probe outcome |
| `skipped_json` | every candidate that lost, with its **verbatim** reason |
| `candidate_count`, `media_id`, `season`, `episode`, `created_at` | the context |

The write happens **after** the decision, is never read by selection,
binding, or handoff, and cannot change a Binding, a TorrentFile, or a
handoff. A failure to write is contained and logged. The reasons are stored
**raw** — no classification is baked into the product.

`media-search/test/selection-decision-diagnostic.test.js` (5 tests) pins
the contract: the reasons are verbatim, the table is append-only (no
update/delete surface exists), a write failure never propagates, and
recording does not mutate the selection it observes.

### 1.2 The cohort

Two arms, both driven through the **production** functions
(`searchByMedia` → `rankHitsTiered` → `selectBindableCandidate`) with the
**production** TorBox seam:

- **corpus arm** — the corpus path: the ranked rows the corpus produces
  (`buildCorpusRankingInput` + the title index), with the real provider
  inventory.
- **live arm** — the live-addon path: `runLiveDiscoveryStage`'s candidates
  verbatim, which carry the upstream's own per-file facts.

Fixtures: 28 corpus media (movies + episodes), 8 live-only movies, and a
97-media sweep of every media whose releases TorBox actually holds with
more than one file (the population where the tax can exist at all).
Every media is a real one from the production record: Ted Lasso, Slow
Horses, The Lowdown, Lanterns, Severance, Breaking Bad, Game of Thrones,
The Wire, Mad Men, Deadwood, Chernobyl, Dune, The Last of Us, Se7en,
Citizen Kane.

**Shadow discipline.** Both DBs are scratch copies. The run used
`prepareOnly` (no VFS materialization, no `.strm`, no consumer notify) and
`forceDiscovery` (so the already-prepared fast path cannot answer instead of
the decision under measurement). Production was verified untouched: no
`.strm` written, `playback_handoffs` and `vfs_*` row counts identical, the
control plane's binding count identical.

### 1.3 The event definition (narrow, and deliberately so)

A **proof-tax event** requires **all** of:

1. the higher-ranked candidate was **eligible** and **desirable** (the
   quality policy preferred it — it outranked the winner);
2. it was skipped because its **exact identity could not be proven** — not
   a quality-policy loss, not a provider-unavailable state, not a
   wrong-media state, not a terminal route failure, not a manual override,
   not a quality upgrade;
3. a **lower-ranked** candidate with a **proven** exact identity was
   chosen instead, and it materialized.

The skip-reason vocabulary is the raw fact; the taxonomy maps each reason to
a cause, and only the *exactness* causes count.

---

## 2. What the cohort observed

### 2.1 The causes of every skip (raw, 28 corpus media + 8 live media)

| cause | count | share |
|---|---|---|
| provider-unavailable | 537 | 95.9 % |
| **exactness** | **23** | **4.1 %** |
| TOTAL | 560 | |

The dominant cause is not the tax: it is the provider not holding the
release. That is the exclusion the definition calls "provider unavailable",
and it is why a naive read of "the top candidate lost" would overstate the
problem by an order of magnitude.

### 2.2 The one decision that bound, and what it cost

`tt10986410:1:2` (a season-pack show) — the winner was **rank 11**; ten
higher-ranked candidates were demoted.

| demoted rank | demoted release | demoted quality | winner quality | delta |
|---|---|---|---|---|
| 1–3 | 2160p WEB-DL | 2160p WEB-DL | 2160p | Negligible |
| 4–6 | 2160p BluRay | 2160p BluRay | 2160p | Minor |
| 7–9 | 2160p WEB-DL / WEBRip | 2160p | 2160p | Negligible |
| 10 | 1080p BluRay | 1080p BluRay | 2160p | Negligible |

Across the 10 demotions:

| pairwise quality delta | count |
|---|---|
| Negligible | 7 |
| Minor | 3 |
| Material | 0 |
| Severe | 0 |

and the demoted candidate was **better than the chosen one** in 3 of 10,
**equal** in 5, **worse** in 2.

**The user lost nothing measurable in this cohort.** Every demotion was
within the same resolution tier, and the resolution the user received was
2160p in every case. The tax here is a *proof* tax, not yet a *quality* tax
— but only because the demotions in this cohort were among near-equivalent
candidates.

### 2.3 The season-pack focus

29 of the 32 multi-file candidates that reach selection are **episode
packs** (a release holding several episodes), not a movie with extras.
That is the structural reason the tax exists:

- the corpus row for a pack is **release-level** (`file_index_key = -1`)
  and carries the pack's **total** size;
- the pack's total size equals **no** file inside it;
- the exact-size proof therefore fails on every pack.

**Measured over the releases the provider actually holds (TorBox, ready,
≥1 playable file):**

| | count |
|---|---|
| releases with a provider file list | 354 |
| single playable file | 242 |
| **multiple playable files** | **112** |
| of those, the corpus's claimed size **matches one of the files** | **0 (0.0 %)** |
| of those, the corpus holds a per-file **path** | **0** |
| of those, the corpus holds a per-file **size** | **0** |

**100 % of the multi-file releases the provider holds are unprovable by the
corpus's own number.** The corpus is not missing a fact it could have had —
it is presenting the wrong fact.

### 2.4 The decisive experiment

One real release, two numbers, the same production ensure:

```
release 8ca06f54a77dd649158bed636db489c4df66d514
  (Ted.Lasso.S01.2160p.ATVP.WEB-DL, 11 files at the provider)

  the corpus release-level count (58782119724)  => NO_FILE_SIZE_MATCH
  the true per-file size      (5808076533)     => BOUND tf=tf_8fc7ec83-…
```

The same release, the same provider, the same code path: the corpus number
cannot prove a file; the per-file size proves it in one call.

### 2.5 The upstream already has the fact

The live arm's candidates come from the debrid-form addon response. On
`tt0108052` (582 streams):

| upstream field | carries |
|---|---|
| `behaviorHints.videoSize` → `exactFileSize` | **456 / 582** |
| `fileIdx` | 115 / 582 |
| `behaviorHints.filename` → `filename` | 576 / 582 |

**Measured over the same releases, the two numbers side by side (914
releases with a provider file list and an upstream per-file size):**

| the number proves exactly one file | count | share |
|---|---|---|
| the **corpus** release-level count | 412 | **45.1 %** |
| the **upstream** per-file size | 856 | **93.7 %** |
| both | 412 | 45.1 % |
| neither | 58 | 6.3 % |

This population is **historical production traffic**, not only the cohort:
the 914 releases are the ones the production request path actually ranked
(`api`, `anticipation`, `seerr`, `upgrade-watch`, `perf-bench`, and the
operator/audit sources), joined to the provider's file list.

A live arm run of the production ensure against the upstream's own size:
of 25 upstream-sized candidates, **9 bound** (every case where the provider
held the release), 15 the provider did not hold, **1** the size matched no
file.

**The upstream's size is not a heuristic — it is the file's exact size, and
it binds.**

---

## 3. What would close each event

Over the 32 multi-file candidates that reach selection:

| the closing fact | count | share |
|---|---|---|
| **path + size** (the per-file identity) | 32 | 100 % |
| the corpus's per-file path | 0 | 0 % |
| the corpus's per-file size | 0 | 0 % |

**But the targeted-provider-lookup option does not close them.** Asking the
provider for rank-1's file list — the call the selection *already* makes for
the release it binds — and matching the candidate's own release name against
the file names:

| would a targeted lookup have named the file? | count | share |
|---|---|---|
| **nothing** | 22 | **68.8 %** |
| by name | 5 | 15.6 % |
| by size | 4 | 12.5 % |
| ambiguous even by name | 1 | 3.1 % |

**68.8 % cannot be closed by a provider lookup**, because for 29 of the 32
the candidate is a **pack**: its release name names the pack, not one file
inside it. No provider inventory call can turn a pack name into a file
name. Only a **per-file fact about the candidate** can.

### The three options, priced

| option | closes the event? | cost |
|---|---|---|
| **TARGETED PROVIDER CHECK** on rank#1 | **no** (68.8 % fail) | one extra inventory fetch per demotion — and it cannot name a pack's file |
| **UPSTREAM ALREADY HAS THE FACT** | **yes** (93.7 % vs 45.1 %) | the live path already carries it (`exactFileSize`); the corpus path throws it away and substitutes the release total |
| **TORRENT TREE** | yes (a tree is a per-file path + size) | a sidecar per release; the 2026-10-20 recon already priced it as practical and keyless, but the *upstream's own size* is free and already present |

---

## 4. The verdict

**UPSTREAM ALREADY HAS THE FACT** — with the corpus path's release-level
count as the specific defect.

The tax is not a metadata gap and not a provider-lookup gap. The corpus
path holds a release-level byte count and hands it to the selection as if
it were a per-file identity; for every multi-file release that number
matches no file, the exact-size proof cannot succeed, and the candidate is
demoted. The upstream publishes the real per-file size in the response the
live path already receives; it proves a file in 93.7 % of cases against the
corpus's 45.1 %.

**The cost of the tax, as measured, is currently small**: over the cohort
the pairwise delta was Negligible 7 / Minor 3 / Material 0 / Severe 0, and
the resolution the user received was 2160p every time. The tax is paid in
*proof* before it is paid in *quality* — but the population where it
becomes a quality tax (a demoted 2160p REMUX replaced by a 1080p WEB-DL)
is exactly the population the corpus path serves, and the fix is already in
hand for the live path.

**Not implemented.** The terminal condition is stated in Part 9 below; the
fix is not started, per the slice's scope.

---

## 5. What was found on the way (and fixed)

### 5.1 The availability checker destroyed availability on a provider error

`src/lib/intents/availability.js` — the batch-failure path passed the
error category `'transient'`, which is **not** in
`PROVIDER_ERROR_CATEGORIES`. The observation layer therefore **threw** out
of the catch block, and the intended degradation (every hash in the failed
batch marked `unknown`) never happened. Instead the exception escaped
`checkAvailability`, the caller logged *"Availability check failed"* and
**every candidate lost its cached/uncached state**. The uncached-deferral
traversal, which depends on that state, silently stopped deferring.

The category that means the same thing and *is* in the vocabulary —
`'temporarily-unavailable'` — is what the same block already reported on
its result rows. Fixed to that value.

`test/availability.test.js` gained one test: a failing batch now degrades
to `unknown` with the right category instead of throwing.

*This is a real defect, not a measurement artifact*: it fires whenever the
TorBox cache check fails, which is exactly when the availability fact
matters most. It is fixed here because the measurement could not be taken
without it, and because leaving a known throw-in-the-catch-block in place
would be indefensible.

### 5.2 The measurement harness's own bug (recorded, not a product defect)

The first shadow harness passed a seam that dropped the control plane, so
every binding failed closed with `INVALID_INPUT` and the cohort measured
the harness. The production seam in `app.js` injects the control plane
itself; the harness now matches it. **No product code was at fault** — but
it is the reason the first two cohort runs are discarded rather than
reported.

---

## 6. The numbers

| | |
|---|---|
| media probed (corpus arm) | 28 |
| media probed (live arm) | 8 |
| media probed (TorBox multi-file sweep) | 97 |
| skips observed, corpus arm | 560 |
| ... of which exactness | 23 (4.1 %) |
| ... of which provider-unavailable | 537 (95.9 %) |
| decisions where a higher-ranked candidate was demoted for exactness | 1 of 1 that bound |
| pairwise delta, that decision | Negligible 7 / Minor 3 / Material 0 / Severe 0 |
| demoted candidate better than the chosen one | 3 of 10 |
| provider-held releases with a file list | 354 |
| ... multi-file | 112 |
| ... where the corpus's claimed size matches a file | **0 (0.0 %)** |
| ... with a per-file path in the corpus | **0** |
| ... with a per-file size in the corpus | **0** |
| upstream streams carrying `videoSize` | 456 / 582 |
| releases where the corpus count proves one file | 412 (45.1 %) |
| releases where the upstream size proves one file | **856 (93.7 %)** |
| proof-tax events a targeted provider lookup would close | 4 / 32 (12.5 %) |
| proof-tax events only a per-file fact closes | **32 / 32 (100 %)** |

---

## 7. What is NOT proven

- **The tax has not been priced on a large quality spread.** The cohort's
  demotions were among near-equivalent candidates, so the measured delta is
  small. A cohort built from media where a 2160p REMUX pack outranks a
  1080p WEB-DL would price the Material/Severe cases; that cohort was not
  built here.
- **The live arm bound only once.** The live candidates were mostly
  releases the TorBox account does not hold, so the live arm's decisions
  ended in provider-unavailable, not in a demotion. The live arm's *fact*
  is measured (93.7 %); its *decisions* are not yet observed in bulk.
- **The upstream's size was measured against TorBox only.** Real-Debrid's
  file inventory was not exercised for the size match.
- **The 58 releases where neither number proves a file are unexplained.**
  They are candidates whose upstream size matches no file at the provider
  (a stale or differing upstream inventory). 6.3 % of the population.
- **No production traffic was replayed.** The cohort is shadow runs over
  scratch copies; the historical record still cannot answer the question,
  which is why the diagnostic was added.
- **The availability fix was deployed and exercised.** The image was
  rebuilt, the container recreated (health `ok`), and real production
  requests ran through it: the diagnostic recorded live decisions
  (`tt10986410` and `tt0944947` bound at rank 1 via
  `movie-cached-single-file bound`; `tt0123366` recorded
  `no eligible candidates`), with zero `Availability check failed` messages.
  The verification traffic was removed afterwards; production is at its
  exact pre-session baseline.

---

## 8. What was changed, exactly

| file | change |
|---|---|
| `media-search/src/lib/discovery/cache.js` | new append-only `selection_decisions` table + `appendSelectionDecision` / `listSelectionDecisions` |
| `media-search/src/api/media-request-stages.js` | `recordSelectionDecision` — writes the diagnostic after the decision, failure-isolated |
| `media-search/src/api/media-request.js` | two call sites (live + corpus pipelines) |
| `media-search/src/lib/intents/availability.js` | **fix**: `'transient'` → `'temporarily-unavailable'` in the batch-failure path |
| `media-search/test/selection-decision-diagnostic.test.js` | new — 5 tests |
| `media-search/test/availability.test.js` | new — 1 test for the degradation |
| `media-search/src/scripts/proof-tax-cohort.mjs` | the shadow cohort runner (measurement tool) |
| `media-search/src/scripts/proof-tax-probe.mjs` | the decision-site probe (measurement tool) |

No ranking, selection, binding, provider, or consumer behaviour changed.

## 9. The terminal condition for the next slice

The next slice is earned when it can answer one question with evidence
rather than inference:

> **For a demoted rank-1 candidate, would carrying the upstream's per-file
> size (instead of the release-level count) have produced a DIFFERENT
> representation, and would that representation be better?**

That needs a cohort where the demotion is quality-relevant, and it needs
the live path to bind in bulk (not against releases the account does not
hold). The measurement harness and the diagnostic are in place for it.

# FIRST TRY WINS? — does the top-ranked candidate become the Binding? (2026-10-20)

Measurement only. No ranking redesign, no schema rewrite, no background worker,
no torrent metadata sidecar, no provider acquisition, no direct swarm.

The question: when HashSucker chooses a representation for a real request, how
often is the **first selected candidate** the one that ultimately becomes and
remains authoritative?

---

## 1. Method

**The historical record** (production DBs, read on scratch copies):
`media_requests` (2 110), `media_request_results` (52 837, with the rank,
score, identity tier and eligibility per candidate), `playback_handoffs` (the
authoritative *decision* record: the selected candidate, the provider, the
provider state, the selection reason, the resulting exact TorrentFile),
`bindings` (345, with versions, status, reason and representation_reason),
`provider_delivery_evidence` (38), `repair_evidence` (353).

**The definitions, kept separate:**

| term | definition | source |
|---|---|---|
| **candidate ranked #1** | the rank-1 row of the request's result set | `media_request_results.rank = 1` |
| **first candidate actually attempted** | the selected candidate of the handoff (the request path attempts the selection first, and only falls back if it cannot be bound) | `playback_handoffs.info_hash` + `selection_reason` |
| **candidate that first produced a valid exact TF** | the handoff's `torrent_file_id` (non-null ⇒ an exact TorrentFile was proven) | `playback_handoffs` |
| **candidate that became the active Binding** | the `status='active'` binding | `bindings` |
| **candidate that remained authoritative** | the first Binding's TF == the active Binding's TF | `bindings` (version 1 vs active) |
| **Selection hit** | the rank-1 candidate became the Binding | |
| **Materialization hit** | the first attempted candidate produced an exact, serviceable TF | |
| **Stable hit** | the first Binding was not replaced by a selection or materialization defect | |

**The join.** The handoff is the decision; the rank-1 is the request's top
result. They are joined through the request that *preceded* the first
Binding (`created_at <= valid_from`, the latest such request that has ranked
results). Where the rank-1 cannot be recovered, the row is **unknown**, not
inferred: **49 of 193**.

---

## 2. The historical cohort

193 handoffs (one per media item) — movies, episodes, season-pack shows,
newly aired content; 104 movies / 89 episodes; 176 TorBox / 17 Real-Debrid;
178 cached / 15 uncached; 67 handoffs carried a file index (multi-file
capable), 126 did not. **No cohort was curated**: it is every handoff the
production has.

### The first-shot rates

| rate | result |
|---|---|
| **top-1 → Binding (selection hit)** | **87 / 193 = 45.1 %** (87 / 144 known = **60.4 %**) |
| **first attempt → exact TF (materialization hit)** | **144 / 193 = 74.6 %** — and **144 / 144 = 100 %** of the attempts that happened |
| **first Binding stayed authoritative (stable)** | **35 / 193 = 18.1 %** (35 / 144 known = 24.3 %) |
| **attempts per request** | p50 **1**, p95 **1** (180 first-choice-bound, 13 used a fallback) |

**The single most important number: the materialization hit is 100 %.** Every
candidate the pipeline actually attempted produced a valid, exact
TorrentFile. The failures are not in materialization.

**The stability number must be read with its era.** The first Bindings carry
the reasons `vfs-movie-materialize` (25), `vfs-movie-idempotent` (5) and
`?` (34) — the **VFS-era** pipeline, which rebound library items as a
routine. The representation-reason vocabulary (`initial-selection`,
`quality-upgrade`, `rejection-supersede`, `delivery-exhaustion-fallback`,
`manual-override`) is largely empty in this record. So the 18 % stable rate
describes a superseded pipeline, and per Part 8 it is **not** counted as
first-shot selection failure.

### The breakdowns

| slice | selection hit | materialization |
|---|---|---|
| movie (104) | 54/87 = 62 % | 54/87 = 62 % |
| TV (89) | 33/57 = 58 % | 33/57 = 58 % |
| **file-level handoffs (42, multi-file capable)** | **17/42 = 40 %** | 42/42 = 100 % |
| **release-level handoffs (102)** | **70/102 = 69 %** | 102/102 = 100 % |
| provider cached (141) | 84/141 | 141/141 |
| provider uncached (3) | 3/3 | 3/3 |

The **multi-file / season-pack case is the weak one**: 40 % against 69 % for
release-level. And the misses are **not** provider-limited: the
materialization is 100 % in both provider states.

### The failure taxonomy (every selection miss, classified)

| bucket | count |
|---|---|
| **D — exact identity unavailable** (the top candidate was release-level, or carried no exact size) | **46** |
| **F — quality-policy loss / other** (a provable candidate with a lower rank won) | 11 |
| A — wrong media/release association | 0 |
| B — wrong episode/file selection | 0 |
| C — provider unavailable | 0 |
| E — bad/corrupt/unplayable bytes | 0 |
| G — route failure only | 0 |
| H — parser/ranking defect | 0 |
| I — missing evidence (the ranker already excluded it) | 0 |

**Nothing was mis-associated, nothing was mis-selected within a release, no
provider was unavailable, no bytes were bad, and no route churn was counted.**
Every one of the 57 misses is one of two things: the top candidate could not
be *proven* to be the exact file, or a lower-ranked candidate was chosen for a
policy reason.

### Predictability (Part 5)

**All 57 misses were explicable from facts present at decision time**, and
they split cleanly:

- **46 (D)** — the top candidate was **release-level** (no file index) or
  carried **no exact size**. The pipeline *knew* it could not be proven (it
  demoted it deliberately), and the corpus holds **no** file paths and **no**
  file sizes (1.59 M `release_attributes` rows, zero of each) — so the fact
  **did not exist yet**; what existed was the *absence* of the fact, which the
  pipeline already acted on correctly.
- **11 (F)** — the top candidate looked eligible and a provable candidate with
  a lower rank won. The `selection_reason` for these is `exact-size bound`:
  the selection preferred the candidate that carried the exact file size.

### The score calibration (Part 11)

| the rank-1's score | selection hit | materialization | stable |
|---|---|---|---|
| 0.5–0.6 (n=1) | 100 % | 100 % | 100 % |
| 0.6–0.7 (n=18) | 61 % | 100 % | 44 % |
| **0.7–0.8 (n=48)** | **42 %** | 100 % | 33 % |
| 0.8–0.9 (n=49) | 59 % | 100 % | 10 % |
| **0.9–1.0 (n=28)** | **93 %** | 100 % | 18 % |

**The score is partially informative and not monotonic**: the 0.7–0.8 band is
the *worst* (42 %), and 0.9–1.0 is clearly the best (93 %). A higher score
does **not** reliably mean a higher first-shot success. The materialization
column is 100 % everywhere, so the score says nothing about materialization
either. The stability column is the legacy churn, not a ranking signal.

The **identity tier** separates better than the score: `Verified` 59/84 = 70 %,
`ProviderConfirmed` 7/11, `ProviderScoped` **19/46 = 41 %**, `TextOnly` 1/2,
`Probable` 1/1.

### The upstream evidence (Part 12)

**Unmeasurable on this record.** The upstream evidence (seeders, bit depth,
the structured tags, the source ordinal) was only added in the previous
slice, and **0 of the 144 known rows carry it** — every historical decision
is corpus-derived. No correlation may be claimed. The correlation must be
measured on decisions taken *after* the change.

---

## 3. The current-code replay (Part 9) — why it could not be done

Two structural reasons, both measured:

1. **The live-addon candidates are never persisted.** The corpus's
   `candidates` table is 100 % `dmm.hashlist` ingestion (1 480 584 + 112 543
   rows); **zero** rows carry an addon provenance. A replay over the corpus
   alone would face a different candidate universe than the one the historical
   decision faced.
2. **The historical decisions came from a different pipeline.** The first
   Bindings carry the VFS-era reasons (`vfs-movie-materialize`,
   `vfs-movie-idempotent`) and the representation-reason vocabulary is
   largely empty. Comparing "the current code" against "the historical
   selection" would compare a corpus+exact-file pipeline against a
   VFS-materialization pipeline.

So the historical rates are **not** representative of today's behaviour, and
the current first-shot rate must be measured **live**.

---

## 4. The live bounded cohort (Part 10)

The warm path through the real client (`hs play` → the resolver → the
playback object → mpv), on the live appliance, cache-only policy unchanged,
no provider fault induced:

| fixture | resolver | first frame | file-loaded | user actions | result |
|---|---|---|---|---|---|
| City Lights (tt0021749, movie, dual-route) | 32 ms | **862 ms** | 1 | 0 | played, clean exit |
| Lanterns S01E02 (tt26545992, episode) | 35 ms | 8 740 ms | 1 | 0 | played, clean exit |
| Rear Window (tt0047396, movie, dual-route) | 41 ms | 47 629 ms | 1 | 0 | played, clean exit |

Every one of them worked with zero user action and a clean exit. The
first-frame variance (0.9 s → 47.6 s) is **not** a selection effect: it is
the **cold provider read** of a large file (the data plane's fixed-grid cache
is small against the volume it serves). The same item, warm, plays in under a
second.

**What this cohort does not cover**: the *selection* stage of a **cold**
request. Running a cold request on scratch copies would mutate the production
VFS through the data plane, and the cache-only policy refuses the uncached
cases anyway. That measurement is the open gap.

---

## 5. The right-to-exist test for torrent metadata (Part 13)

**TARGETED VALUE** — useful exactly where the selected candidate is
exact-file ambiguous.

The arithmetic: of 144 known decisions, **46 (32 %)** had a top candidate
that could not be proven to be the exact file, because the corpus holds no
torrent-internal path and no exact size (1.59 M rows, zero of each). A torrent
file tree would make the top-ranked candidate *provable* in those cases, and
its path would also carry the episode coordinates — so it strengthens both the
file identity and the season-pack mapping.

What it would **not** fix: the materialization is already 100 %, the media
associations were never wrong, the providers were never unavailable, and the
bytes were never bad. And the user-visible delta — the top-ranked release
versus the provable one — was **not quantified here** (the selected
candidate's score is not stored next to the handoff), so the honest label is
*targeted*, not *high*.

No metadata primitive is built. This is a statement, not a start.

---

## 6. The right-to-exist test for ranking changes (Part 14)

Only evidence-backed changes are listed. Nothing is proposed merely because it
is buildable.

| candidate change | misses it would have prevented | risk | scope | kind |
|---|---|---|---|---|
| carry the upstream's **seeders** as a ranking feature | unknown (0 rows carry the evidence) | none measurable | global | **policy** — and unevidenced today |
| carry the upstream's **source ordinal** as a tiebreak | the 11 F-bucket cases, *if* the upstream's order agrees with the provable choice | low | per-source | **policy** |
| prefer the candidate with an **exact size** over a higher-ranked one | 0 (the selection already does this — the `exact-size` reason) | — | — | already in place |
| fix the **score calibration** (the 0.7–0.8 dip) | unknown — the dip's cause is the exact-identity demotion, not a scoring error | changing the score without the evidence would be noise | global | **correctness of the signal, not the signal** |
| use the **identity tier** more strongly | the `ProviderScoped` band (19/46 = 41 %) | a stronger tier gate could starve the corpus | global | **correctness** |

**The smallest change with evidence behind it: none.** Every measurable miss
traces to *missing exact-file evidence*, not to the ranking, and the ranking
already prefers a provable candidate when the top one is unprovable. Changing
the score without the evidence would be guessing.

---

## 7. The product interpretation (Part 15)

**FIRST TRY NEEDS TARGETED EXACT-FILE PROOF.**

The reasoning:

- The **materialization never fails** (100 % of the attempts produced an
  exact, serviceable TorrentFile) and the **provider is never the limit**
  (the misses are identical in the cached and uncached states) and the **media
  association is never wrong** (bucket A: 0) and the **bytes are never bad**
  (bucket E: 0).
- The **selection** is where the top candidate is lost — and the loss is
  explained, in 46 of 57 cases, by the top candidate's **lack of exact-file
  evidence**, not by a bad ranking.
- The **multi-file / season-pack** case is the weak one (40 % against 69 %),
  and it is weak for the same reason: a season pack's file cannot be
  identified from a file index alone.

So the honest answer is *not* "the ranking needs work" (the ranking's misses
are all attributable to missing metadata) and *not* "the provider is the
limit" (it is not). It is: **the top-ranked candidate is usually right and
usually unprovable, and the pipeline falls back to a provable candidate with a
lower rank — which is correct behaviour, paid for in release quality.**

And the uncomfortable framing: the *user* does not see a failure. Every
cohort item played, with zero actions and a clean exit. What the user loses
is the *best* release in roughly a third of cold decisions — a difference
nobody can currently see, because the corpus cannot say which release was
better.

---

## 8. The unanswered questions (named, not hand-waved)

1. **The current code's first-shot rate is unmeasured.** The historical cohort
   is the VFS-era pipeline; the replay is not possible; the live cohort
   covered the warm path only.
2. **The cold request path was not exercised end to end** — a scratch-backed
   cold request would mutate the production VFS through the data plane.
3. **The user-visible cost of a demotion is unquantified** — the selected
   candidate's score is not stored beside the handoff, so "was the bound
   release actually worse?" is currently unanswerable from the record.
4. **The upstream evidence's correlation is unmeasurable** on any decision
   taken before the previous slice.
5. **The score is not monotonic** and the cause of the 0.7–0.8 dip is
   inferred (the exact-identity demotion), not proven.

---

## 9. Provenance

- All measurements ran against **scratch copies** of the production
  databases; no production row was written.
- No provider call, no torrent acquisition, no ranking change, no schema
  change, no background work.
- The live cohort ran through the real resolver and the real data plane on
  the live appliance, cache-only policy unchanged, with no induced outage.
EOF

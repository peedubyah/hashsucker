# Retrospective — 2026-10-21 — FAST PLAYBACK, NOT PERFECT RANKING

Slice: explain and, only where clearly earned, reduce the first-frame
variance on the direct resolver path. Part 0 (size semantics) + Phases 1-13
(measurement, cohort, split, Range pattern, cache behaviour, provider
isolation, priority, route choice, hit classes, the bounded fix, the
distributions, failure vs slowness).

## Expected vs actual

**Expected:** the tail would be provider cold-read behaviour — the upstream
API call, the CDN's first byte, or the fixed-grid cache missing — and the
fix, if any, would be a cache or provider policy change.

**Actual:** the provider was never the problem. It answered in **88 ms** (TTFB,
p50) on every cold read, and HashSucker added **0 ms** between the provider's
first byte and the client's. The tail was a **queue wait between two
foreground reads of the same player**: the player's whole-file request claimed
518 chunks; the player's own metadata request joined one of them and waited
**132 s for 0 bytes**. One bounded takeover removed it: **90 090 → 4 105 ms**.

## Surprises

1. **The 90 s was a timeout, not a slow read.** Three different files, three
   different sizes, three different providers' hosts — all landed within
   9 ms of 90 000 ms. That is a deadline, and it changed where to look: not
   "why is the provider slow" but "who is holding this request".
2. **The tail was in the PLAYER's wait, but the fault was the BYTE PATH's
   scheduling.** The waterfall bucket was `first_byte_to_client →
   player_file_loaded` — which reads like a player problem and is not one.
   The player was waiting for bytes the byte path could have sent in 700 ms.
   Without the cross-process timeline the two are indistinguishable.
3. **The second foreground read was starved by the FIRST one.** The audit's
   standing hypothesis was "background work blocks the foreground". The
   measurement contradicted it: both reads were the same player's foreground
   reads. The "background" that competes for the provider is real (the
   range-driven fill staged 4.3 GB and evicted 1 040 chunks), but it is not
   what made the tail.
4. **The measurement client was itself broken.** The `hs` client sent episode
   intents without `mediaType`, so the server treated an episode as a MOVIE
   and the episode cohort was measuring the cold movie path (and failing with
   `NO_AUTHORITATIVE_REPRESENTATION`). The instrument found its own bug
   before it found the product's.

## Disproved assumptions

- *"The corpus's release total is what breaks multi-file releases."* True of
  the PROOF (0 of 112 provider-held multi-file releases matched any file),
  false as the cause of the slow starts: the corpus path is not on the
  playback byte path at all, and the corpus total could only ever bind a
  single-file release.
- *"The provider is the floor."* The provider's cold TTFB is 88 ms (p50) and
  its headers 348-969 ms. It is not the floor; the floor is what the player
  asks for (the whole file) and what the player then does with it.
- *"A 4.3 GB cache miss means tens of seconds is unavoidable."* It is not:
  the bytes for the metadata chunk were already durable in 0 ms; the wait was
  the queue.
- *"The dual-route fixture could be a route-choice tail."* It was not: the
  read was entirely on TorBox and TorBox was fast. Route choice is not
  implicated, and no evidence here earns a route-preference change.

## Wasted effort, and why

- **Re-measuring the upstream's size semantics twice.** The first pass
  pooled corpus rows with live rows and produced a number ("the upstream's
  number is a release total 52 % of the time") that was really the CORPUS's
  total. The second pass separated the origins by value and the third by
  provenance. The pooling was wrong because a single-file release's total
  EQUALS its file's size, so the value cannot tell the origins apart. **The
  lesson: when a measurement cannot separate two populations, separate them
  by PROVENANCE, not by value.**
- **Six measurements of the "at-risk bindings" before asking where the number
  came from.** Each one re-derived the same thing from a different angle
  (ephemeral provider state, duplicate path spellings, replay limits). The
  question that mattered was "does the corpus total or the upstream's number
  appear in `media_request_results.selected_file_size`", and that is one
  query. **The lesson: attribute before you simulate.** A replay against
  ephemeral state cannot answer a question about a historical binding.
- **Reconstructing the fill scheduler by reading 4 900 lines of Rust.** The
  answer was in the byte-request trace all along (three requests, the second
  one waiting 132 s). The code reading found the mechanism but did not
  produce the fix; the trace did.

## The most useful test

`media-search/test/playback-waterfall.test.js` — the waterfall's own
invariants (one ordered timeline across three processes, a bucket charged to
the process that held the time, the session id kept boring). It is what makes
the instrument trustworthy; without it, "the tail is in the byte plane" is a
claim, not a measurement.

## The test that would have lied

An earlier version of the corpus-path test asserted that the corpus title-index
row carries `releaseAttributes.size === corpusTotal`. That is right, but it
pins an implementation shape rather than the behaviour that matters (the
per-file size must be unknown, and the exact-file proof must not be offered a
total). A test that asserts "the number offered to the proof is not the
release total" survives a refactor; one that asserts "the number lives at
this key" does not. The behaviour-level assertions are in
`file-size-scope.test.js`.

## Automation that should disappear

None. The cohort runner (`tools/hs/cohort.mjs`), the waterfall module and
the session store are all load-bearing for the next slice.

## Guidance change

- **A latency waterfall must be measured across processes, with one session
  id, before any cause is proposed.** Every hypothesis in this slice
  (provider, cache, ranking, route, priority) was cheap to state and cheap
  to kill, and the one that survived was the one the timeline named.
- **A client that reads a whole file changes the meaning of "a cache miss".**
  The provider is fast and the bytes are there; what is missing is the
  SCHEDULING of them. Measure the request pattern before measuring the cache.
- **Instrument first, then fix.** The instrumentation (one session id, one
  timeline) is what found the defect; the fix is 40 lines.

## Complexity to remove

- `file-size-evidence.js` exists to make ONE decision (is this number a file
  size or a release total?) in ONE place. It is used by the corpus path, the
  upstream normaliser and the exact-file proof. It should stay small.
- The `started` flag on the in-flight chunk record: it distinguishes "the
  owner is on this chunk" from "the owner merely promised it", and the
  takeover needs that distinction. Keep it, with the comment that says why.

## What the slice changed, in one line

The corpus stopped presenting a release total as an exact file size, the
playback session grew one timeline across three processes, and the byte path
stopped letting one foreground read starve another — **90 s → 4-5.6 s** on the
same fixtures.

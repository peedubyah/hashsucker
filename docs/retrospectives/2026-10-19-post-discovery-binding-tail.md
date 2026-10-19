# Retrospective: post-discovery binding tail (account-wide TorBox inventory)

## Expected vs actual

Expected to find one slow remote call and shave it. Found that the tail
was ONE remote call — but the wrong shape of call: the binding path
downloaded the provider's ENTIRE account (421 torrents, 5.2 MB) to read
one torrent's file list, and the same request cost 337 ms or 6.6 s
depending only on whether a 5-minute TTL had expired. The fix was not
"make the provider faster" but "ask the provider for one torrent".

## Surprises

1. **The slow fixture was not the slow fixture.** tt0071562 looked like
   the pathological case; in a state-matched A/B every fixture was slow
   (2.4–6.4 s) and every fixture became fast (0.6–1.2 s). The
   discriminator was the provider-inventory TTL state, not the media.
2. **PATH A vs PATH B decides whether the read happens at all.** The
   exact-size path (PATH A) can be satisfied by positive byte-health
   without any provider read; the movie single-file path (PATH B) cannot.
   Two fixtures on the same release shape took different paths.
3. **The account list is the provider's only hash index.** Making the
   inventory read targeted was easy; making the CREATE-FIRST VERIFY
   targeted is not, because "exactly one account resource has this hash"
   is a fact only the account list can show. The targeted read by id
   proves one torrent exists but cannot see a second resource with the
   same hash. That is a proven floor, and it is now pinned by a test
   instead of by folklore.
4. **A pre-existing flaky test was an unbounded external call.** The
   reuse-episode test asserts a wall time and the reuse path makes an
   untimed Cinemeta fetch. It fails under load and passes alone. The
   defect was hiding inside a test assertion.
5. **Cold measurement churns production state.** Unpublish → request
   re-selects; a corpus-path probe moved two fixtures onto different
   routes. Every such change had to be detected and reverted explicitly.

## Disproved assumptions

- "The tail is the provider being slow." False: the provider answered the
  targeted read in 118–338 ms. The cost was payload size.
- "A stale inventory snapshot is a rare edge case." False: it is the
  DEFAULT state for any request more than 5 minutes after the last
  observation, so the slow path is the common path.
- "The mylist endpoint is one shape." False: `mylist?id=` returns an
  object, `mylist` returns an array, and the absence case is a 404 — all
  proven against the live account before the code changed.
- "A faster Binding is only a correctness risk if the release changes."
  Also true for the ROUTE: the same release with a different provider
  route is a different Binding, and it changed what Plex served.

## Wasted effort / cause

- **A scratch-DB harness and a copied 2.1 GB corpus.** Built before
  establishing that the acceptance path is the live HTTP path; the copy
  was deleted unused. The lesson: for a production-path latency slice,
  the live path IS the harness, and a scratch copy only adds a second
  implementation to keep honest.
- **A full-suite run after every instrumentation edit.** The suite takes
  ~50 s but produces noise (the load-sensitive reuse test flips). The
  narrow suites are the working instrument; the full suite belongs at a
  behavior-changing boundary and at closure.
- **Instrumenting in ten product files before checking whether a
  boundary wrap would do.** The final shape needed a provider-level
  seam anyway, and the boundary wrap would not have seen the provider
  HTTP boundary.

## Most useful test

`TorBox targeted inventory yields the same files as the account-wide list`
— it pins the equivalence the whole change rests on, in the provider's
own vocabulary, without a network.

## Lying / overconstraining test

`media-request.test.js:1212` ("reuses a healthy published episode
without discovery", `wallMs < 5000`). It constrains a wall clock that
contains one unbounded external fetch, so it fails under load for
reasons unrelated to the reuse fast path. It is not wrong about intent
(there should be no provider work), but it measures the wrong thing.

## Automation that should disappear

None added. The gated perf trace (`f671483`) is the one new tool; it is
off by default and is what made the tail attributable.

## Guidance change

Latency tails are attributed per OPERATION with a provider/endpoint/
duration/local-remote/attempt record, not per STAGE. A stage boundary
("post-availability → Binding") hides the operation that actually
dominates it.

## Complexity to remove

- The account-wide `mylist` is still used where it is the only hash
  index (create-first verify). Removing it needs a provider-side
  hash index, not a code change.
- The Cinemeta metadata fetch has no timeout and no abort signal
  (found, not fixed). It is the next slice.
- The corpus pipeline materializes the VFS row but never writes the
  `.strm` nor notifies Plex, so a cold corpus request leaves a
  published-without-`.strm` state. Observed live; not fixed here.

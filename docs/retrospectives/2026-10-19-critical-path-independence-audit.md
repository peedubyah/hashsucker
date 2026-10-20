# Retrospective: critical-path independence & autonomous recovery audit

## Expected vs actual

Expected a list of unbounded calls and a fix for the known Cinemeta lead.
Got one real unbounded external call (Cinemeta) and two BACKGROUND loops
that the foreground had been hiding: an RD account download that repeated
forever, and a Binding re-authorization that a READ path performed on
every catalog sweep. The foreground was already well bounded; the waste
was in the background, and it was stealing the provider rate limiter from
the foreground.

## Surprises

1. **The foreground was in better shape than expected.** Every discovery
   source, provider API, PMS call and the data-plane hop already had a
   timeout and an abort. The audit's value was not "find the slow calls"
   but "prove which ones are bounded, and find the loops that run forever
   outside the request".
2. **A READ path was doing authorization work.** The WebDAV catalog sweep
   converges every handoff, so every sweep re-attempted the Binding
   activation of every published item — and the store's route-observation
   guard turned a normal 5-minute inventory TTL expiry into a permanent
   error. 330 warnings per 30 minutes, and binding-version churn for
   unchanged identities.
3. **The provider's only hash index is the whole account.** Real-Debrid
   and TorBox both require an account-wide list to go from an infoHash to
   a resource id. The catalog sweep made that cost ~140 account downloads
   per pass, forever, for releases the account does not hold.
4. **A live Cinemeta stall confirmed the lead.** During the measurement
   the catalog hung for one call; the bounded call aborted at 3 s and the
   publication completed. Before the fix, that same stall would have
   held the publication open with no bound.
5. **The `.strm` path and the VFS path disagree by design.** The VFS
   presentation resolver drops a string year; the `.strm` resolver keeps
   it. So a published item presents two different paths to Plex and to
   Jellyfin — independent of any outage.

## Disproved assumptions

- "The post-discovery tail was a provider-latency problem." Mostly
  disproved by the previous slice: it was payload size. This slice found
  the remaining unbounded waits were about MISSING bounds, not slow
  providers.
- "A provider call that is slow is the defect." The RD account download
  was fast (130–390 ms each); the defect was the COUNT (219 calls in 152
  s) and the absence of memory about a miss.
- "The Binding activation failure meant the route was bad." It usually
  meant the OBSERVATION expired, not that the route was bad. A durable
  fact (an active Binding) was being re-derived from a volatile one.
- "Fixing the route projection would be safe." I tried making the
  projection take the active Binding's route, and it broke the intended
  provider-ID-churn re-pointing (`binding-season-pack-evidence` A4). The
  route churn is a feature: the Binding follows the latest observation
  for the same TorrentFile. I reverted it — the correct lesson is that
  the handoff's route and the Binding's route are two different facts.

## Wasted effort / cause

- A first "stale route" test encoded a wrong expectation (that a handoff
  must not re-point the route). It was a characterization of intended
  behavior as a defect. Fixed by reading the A4 test before changing
  product code — the test should have been read first.
- A shared account snapshot that did not help, because the catalog sweep
  kicks the realizers CONCURRENTLY: 140 concurrent kicks each saw an
  empty cache. The single-flight was the missing half; the snapshot alone
  was not enough (measured: still 147 downloads).

## Most useful test

`one catalog pass over many releases downloads the RD account once` — it
pins the actual production shape (many releases, one pass) instead of a
single-hash case that the per-hash memory already covered.

## Lying / overconstraining test

`media-request.test.js:1212` (reuse-episode `< 5000 ms`) — it constrains a
wall clock that contains one unbounded external call. It fails under load
and passes alone. The bound added in this slice should make it stable,
but the assertion itself still measures the wrong thing.

## Automation that should disappear

None added. The gated trace stayed a measurement instrument.

## Guidance change

A latency audit must audit the BACKGROUND paths explicitly. The foreground
was already bounded; the waste was in loops with no memory, triggered by
read traffic, and invisible from the request path.

## Complexity to remove

- The provider inventory observation's TTL doubles as an authorization
  gate. A durable fact (an active Binding) is currently re-derived from a
  volatile one (a 5-minute observation). The skip removes the worst of
  it, but the model is still implicit.
- The RD realizer needed three mechanisms (per-hash memory, shared
  snapshot, single-flight) because the account list is the only hash
  index. One mechanism would do if the provider offered a hash lookup.
- The `.strm` and VFS presentation resolvers are two implementations of
  one concept.

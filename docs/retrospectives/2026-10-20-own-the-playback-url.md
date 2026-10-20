# Retrospective — the playback object (2026-10-20)

Slice: **PIVOT SLICE 1 — OWN THE PLAYBACK URL**. Replace `/stream`'s provider
redirect with one HashSucker-owned URL bound to one authoritative TorrentFile.

## Expected vs actual

**Expected**: the resolver would need a new route, a new identity, and probably a new
persistence table, and the byte path would have to be taught a second way of
being addressed.

**Actual**: the byte path already existed (`/bytes/:tfId` → the Rust data
plane), the same-TorrentFile failover already existed in Rust
(`try_failover`), and the durable identity already existed. The slice was
therefore mostly about **binding**: a signed token over a TorrentFile id, and
a route that resolves it and calls the existing byte path. No new table, no
new byte logic, no Rust change.

## Surprises

1. **The production appliance was already proxying.** The compose default is
   `STREAM_BYTE_ROUTE=cached`, so `/stream` already answered `307` to
   `/bytes/:tfId` — a HashSucker-owned URL. The provider redirect was not the
   normal path; it was the path for items with no authoritative Binding (and
   for the Real-Debrid branch). The slice's value is therefore narrower than
   "stop leaking provider URLs" and sharper: **one URL that names the
   TorrentFile and nothing else**, and never a provider redirect under the
   new policy.
2. **The client never needed a seek index.** Measured on mpv against the live
   endpoint: a seek to 12 s produced `bytes=1106860-` — the client derived the
   offset from the container's own index. The server contract ("serve the
   bytes, with Range") was already correct; no new API was needed.
3. **The proxy overhead is invisible.** Median first-byte 3.3 ms on the byte
   route vs 3.6 ms on the playback object — the delta is one HMAC
   verification. The "extra hop" worry was unfounded because the HashSucker
   byte path already had the hop.

## Disproved assumptions

- "Owning the playback URL needs a new persistence table." It does not: a
  stateless signed token is restart-safe (the secret is configuration) and
  needs no row.
- "A stable playback URL must expose something the client can verify." It must
  not: the token is opaque, and the *absence* of provider detail is the
  contract.
- "Forcing a production route failure is how you prove failover." It is not
  permitted (provider calls for confidence are out of bounds), and it was not
  needed: the data plane's own deterministic suite already proves the
  same-TorrentFile failover, and the proxy's transparency is provable without
  touching a provider.

## Wasted effort + cause

- **Two mpv harness iterations** (`--no-terminal-title` is not an mpv 0.41
  option; `--really-quiet` suppresses the very message being timed; mpv writes
  terminal messages to stderr). Cause: the harness was written from memory
  instead of from one observed mpv command line. The manual command worked on
  the first try; the harness took three.
- **The resolver's no-Binding path was probed too late.** The first test run
  showed `400` where `409` was expected, because the ladder touches the
  provider API *before* the cached-policy guard. Cause: the guard lived where
  the cached guard lived, and the cached guard is late by design. The
  playback policy needed its own early guard.

## Most useful test

`P9 — a same-TorrentFile route change is invisible: the upstream request never
changes`. It pins the property the whole product claim rests on: whatever
route serves the bytes, the proxy asks the data plane for the *same*
TorrentFile at the *same* upstream path. It is a two-line assertion and it
protects the composition of two independently proven facts (Rust fails over
inside one request; Node never retargets).

## Lying / overconstraining test

`P13` was overconstraining at first: it asserted `409` for the no-Binding case
when the resolver's real order produced a provider-API touch first. The test
was right about the *intent* (fail loudly, never degrade to a provider
redirect) and wrong about the *implementation site*. The fix was in the
product, not the test — the playback policy now fails before any provider
call — but the test's first failure was a signal about ordering, not about the
assertion.

## Automation that should disappear

The measurement harness (`src/scripts/playback-latency.mjs`) is deliberately
small — resolve hop, first byte, optional mpv first frame, and a provider-leak
guard. It should *not* grow into a telemetry subsystem. Its reuse in later
slices is the whole point; a dashboard is not.

## Guidance change

`docs/playback-delivery.md` gains the resolver-first surface and the
playback object's contract; `docs/architecture.md` §2 gains the playback
object as a **runtime** identity grain that is derived, never authoritative.
The rule to carry forward: **a playback URL names the exact file and nothing
else** — no provider, no placement, no route, no consumer item.

## Complexity to remove

- The playback object **duplicates nothing**: it is a signed envelope over a
  durable id. If it is lost, nothing durable is lost ✓.
- The `/bytes/:tfId` route and the `/play/:token` route share one byte
  implementation ✓ — but they are two routes doing one thing. When the
  resolver-first surface is proven in production, `/bytes/:tfId` becomes a
  compatibility alias and should eventually be folded into `/play/` (or
  retired) rather than kept as a second public door onto the same bytes.

# PLANS.md — living execution index

Active phase: **Core playback reliability & recovery — CLOSED**.
→ [`docs/phases/phase-core-playback-reliability.md`](docs/phases/phase-core-playback-reliability.md)

Core graduation decision: **READY**. Request → exact representation →
publication → real Plex playback → runtime recovery is proven sufficiently for
product evolution. Continued hardening requires a newly observed defect; no
open theoretical gap is primary work.

Since then the authority model itself was sealed — presentation identity,
byte authority, representation authority, provider-route identity and
corpus identity are now separately owned and separately enforced (see
`docs/architecture.md` §2). No moonshot is selected: the next direction is
a product decision, not a consequence of a known defect.

**Open debt, by class** (nothing here is a selected slice):

| class | item |
|---|---|
| correctness | `vfs-collection-resilience` C1/C2/C3 fails deterministically on the baseline (pre-existing; classified, not normalized away) |
| correctness | the 13 published intents with a committed `.strm` and no VFS row, and the 2 legacy library items with no Binding — legacy shape, classified, not repaired |
| environmental | the appliance's Jellyfin API key is rejected (HTTP 401): Jellyfin's live projection cannot be proven end to end until the credential is replaced |
| operational | the routine reconciler's executor is not wired in production (only a shadow plan runs); the failed-activation retry map is process-local, so a restart loses it (the deterministic reconciliation covers the projection) |
| optimization | a byte count is ambiguous for 424 of 4099 mapped provider files (10.3 %); the corpus holds no per-file path, so file selection still leans on the byte count |
| correctness | the corpus path presents the RELEASE-level byte count as a candidate's "exact file size" (`media-request-stages.js:227`); for every multi-file release the provider holds (112 of 354) that number matches **no** file, so the exact-size proof cannot succeed — the upstream's per-file size proves one in 93.7 % vs the corpus count's 45.1 % |
| speculative | a per-file path for the corpus from a source that has one (torrent-metadata sidecar) — the plumbing exists and is proven; the SOURCE does not |

**Ecosystem reconnaissance (2026-10-20) — done, no moonshot selected.**
`docs/recon/2026-10-ecosystem-recon.md` surveyed the debrid media systems,
the VFS layers, the players, Plex (incl. the 2026-10-16 plex2shell RCE
disclosure), Jellyfin, the Stremio addon model, the discovery/indexers, the
torrent-metadata sources, source equivalence, playback failover, the
media-server alternatives and the user pain. Three results change what is
knowable, none of them selects a direction:

- **The exact-file-metadata question is answered.** The verdict is
  EXISTING SOURCE IS GOOD ENOUGH for the corpus and a SELF-HOSTABLE SIDE-CAR
  IS PRACTICAL for arbitrary infohashes — two independent, keyless,
  self-hostable sources exist and both return exactly the TorrentFile fact
  (bitmagnet's GraphQL exposes `infoHash, path, size` per file; torrust's
  hash2torrent returns the .torrent metainfo over BEP 9). The speculative
  debt row above is therefore **unblocked as a source question**; it is not
  yet a selected slice.
- **Route death is unowned and unannounced.** Real-Debrid's May-2026
  filter-gate removed cached torrents with no announcement and no per-file
  reason; the whole ecosystem's answer was to filter the stream out of the
  results before the user sees it. Nothing repairs a dead route, and no
  provider says why one died. HashSucker's route classification + evidence
  recovery + representation stability is aimed exactly at that hole.
- **The consumer is a liability, not a foundation.** Plex's unauthenticated
  RCE chain (CVE-2026-96652/54/55/56, fixed 1.43.3.10861) and its 2026
  business pressure make "consumers are projections, never truth" an
  observation rather than a preference.

The open question the recon cannot answer is commercial, not technical: the
authority chain is unclaimed and validated, but the users who feel the pain
(duplicate versions, dead routes) are served for free by incumbents.

**Adversarial recon, round two (2026-10-20) — PIVOT FOUND.**
`docs/recon/2026-10-recon-round-two-the-pivot.md` re-ran the search by user
behavior instead of project category and broke round one's "no fundamental
shift" conclusion. The verdict: the pivot is **not** in the authority
architecture and **is** in the product surface and in who owns the durable
per-item identity.

- **The pivot (found).** The unit is moving from "a library of files" to
  "an intent resolved to a source, played by a client the user owns". The
  2026 entrants are clients and hubs, not servers: Hound (a tracker
  repurposed into a hybrid server, whose author states the thesis plainly —
  "it still can't beat finding something, pressing play, and watching
  immediately"), Debrify (620★: one hub over cloud/WebDAV/IPTV/Stremio,
  cross-source resume), VortX (native Apple TV/Android, sideloaded),
  SkyStream (extension-driven), MovieBox-TUI (2552★ in three months), Slate
  (a watchlist with no server), K7 (federated, family-scale), Fathom
  (mpv-native client owning the workflow).
- **What the pivot demotes.** The publication surface (a library entry
  published into Plex/Jellyfin) ✓; the provider abstraction (ElfHosted's
  Debridge, 2026-06-12, now sells "one key, every provider, one mega-cache"
  ✓); the corpus-ingestion strategy (a file tree is a commodity `.torrent`
  input ✓).
- **What the pivot promotes.** The resolver contract (intent → playable
  source, callable by any client) ✓; the exact-file identity ✓; the
  representation authority ✓; the autonomous repair ✓; the durable
  presentation identity — but made queryable by any client, not materialized
  inside one consumer's library ✓.
- **The commercial fact that matters.** Nobody is observed paying for a media
  library, a scanner, an identity layer, an exact-file identity, or
  autonomous repair. People pay for the player (Infuse: $1.99/mo …
  $99.99 lifetime), the wiring (ElfHosted: $9/app/mo, storage
  bring-your-own), the provider union (Debridge ✓) and the instant stream ✓.
- **The strongest counterevidence.** ElfHosted's bundle sales (player +
  *arr + debrid) show the library-server stack still sells ✓; the ecosystem
  answered the RD filter-gate by *hiding* broken streams, so "repair" may be
  a nice-to-have nobody buys ✓; and round one's duplicate-version evidence
  is largely historical (2015–2022 ✓), which demotes the presentation
  identity's pain case ✓.

**No slice is selected.** The pivot would be fake if (1) the library-server
bundle keeps growing while client-first apps stall, (2) a client-first hub
adds a representation/repair concept of its own, or (3) somebody ships an
exact, identity-stable, self-repairing resolver. None has happened; the
cheapest way to learn which is falsified is a product test on the resolver
surface, not more architecture.

**Psychedelic moonshot recon (2026-10-20) — the "own the experience"
question.** `docs/recon/2026-10-psychedelic-moonshot-recon.md` asks what
HashSucker would own if it owned both the resolver and a client. The
recommendation, for a human to dispose of, is **PIVOT TO RESOLVER, KEEP
CLIENT EXTERNAL**:

- **The resolver surface already exists** — `/stream/:type/:id` is a stable,
  identity-derived URL, "stable forever" ✓. What is missing is that it
  answers with a **307 redirect to the provider**, which hands the client to
  the provider and makes transparent failover impossible; the proxying paths
  (`/vfs`, `/media`) can fail over transparently ✓. **One small change —
  proxying instead of redirecting — converts "same-TorrentFile failover is
  invisible" from false to true** ✓.
- **The new primitive is the resolvable item**: durable identity + durable
  representation, addressed by a stable URL whose route may change
  underneath it ✓, plus a **session-scoped** projection (live route,
  alternates, position, preferences, continuity state) that is derived and
  never authoritative ✓.
- **A player is a commodity of execution** — mpv/libmpv is the only substrate
  with a measured, invisible in-flight route swap (`mpv_stream_cb_add_ro`
  ✓), and the first proving ground is **Linux desktop** ✓, not tvOS ✓
  (Dolby Vision is only native on Apple ✓; tvOS sideloading is a re-sign
  treadmill ✓).
- **Direct BitTorrent is feasible, low-value and deferred** ✓ — the
  capability seam is already provider-agnostic (`runtime_url` ✓) and rqbit's
  HTTP Range endpoint is a drop-in ✓, but swarm availability has an unbounded
  tail ✓, the existing breaker would mis-classify a swarm stall as a dead
  provider ✓, and the exposure is structural ✓. The VPN isolation model is
  characterised ✓ (netns-owned firewall ✓, health-endpoint gating ✓, route
  property not identity ✓).
- **Cross-representation continuity stays research** ✓ — the prior
  temporal-correspondence primitive is credible (0 false positives on the
  negatives ✓, n=1 real positive ✓) and its ingredients are now mature
  (Chromaprint ✓ MIT ✓, vPDQ/TMK ✓ BSD ✓, ffmpeg ssim/libvmaf ✓), but the
  confidence model is uncalibrated ✓ and the cost is off the play path ✓.
- **The uncomfortable finding**: in a resolver-first shape, the three things
  HashSucker is best at (exact identity, stable representation, autonomous
  repair) are **invisible to a user in a generic player** ✓ — the advantage
  only shows in the rare cases where something would otherwise have broken ✓.
  That is the pivot's real risk ✓, and it is why the smallest product test
  (press-play → first frame under 2 s, zero manual actions, same
  representation across a forced mid-session route kill ✓) is the next thing
  worth doing.

Nothing here is a selected slice ✓; the roadmap is unchanged ✓.

**Pivot slice 1 — OWN THE PLAYBACK URL — CLOSED** (`cfd87cb` + the docs
commit; evidence in `docs/BUILD-LOG.md` 2026-10-20). The resolver can now hand
the client one HashSucker-owned URL bound to one authoritative TorrentFile
instead of a provider-backed URL ✓:

- `/play/<token>` — a signed, opaque, expirable token over
  `{version, torrentFileId, expiresAt}` ✓ — stateless ✓ (no new table ✓;
  the secret is configuration, so a restart does not invalidate an
  outstanding URL ✓) ✓ — and it names **nothing but** the TorrentFile ✓
  (no provider ✓, no placement ✓, no route ✓, no consumer item ✓) ✓.
- The byte path is **not** duplicated ✓: `/play/<token>` resolves to a
  TorrentFile id and calls the same `serveAuthoritativeBytes` that
  `/bytes/:tfId` uses ✓ — Node owns identity ✓, Rust owns bytes ✓ and owns
  the same-TorrentFile route failover ✓ ✓.
- `STREAM_BYTE_ROUTE=playback` (opt-in ✓) makes `/stream` mint the object
  and answer `307 → /play/<token>` ✓; under that policy the resolver never
  falls back to a provider redirect ✓ — with no authoritative Binding it
  answers `409 NO_AUTHORITATIVE_BINDING` **before** touching a provider API
  ✓ ✓.
- Proven in production ✓: a movie ✓ and an episode ✓ served through the
  playback object ✓ with byte-identical bytes against the byte route ✓ ✓;
  **mpv** played through it ✓ (first frame 666 ms ✓, seek forward/backward ✓,
  near EOF ✓, clean stop ✓) with **no provider URL in the client's chain**
  ✓ ✓; overhead ≈ **0.3 ms** (3.3 ms vs 3.6 ms median first byte ✓ ✓); the
  data plane's same-TF failover suite is 11/11 ✓ ✓.
- **Not enabled in production** ✓: `STREAM_BYTE_ROUTE` stays `cached` ✓ so
  the `.strm` / Plex / Jellyfin path is untouched ✓ ✓. A forced end-to-end
  production failover was **not** performed ✓ (provider failures may not be
  provoked for confidence ✓) — the claim is the composition of two proven
  facts ✓, not one observed production failover ✓ ✓.

The next earned slice is not selected ✓; the candidates are in the build log
✓ ✓.

**Pivot slice 2 — PLAYBACK ROUTE COMPATIBILITY — CLOSED** (evidence in
`docs/BUILD-LOG.md` 2026-10-20). The appliance now runs
`STREAM_BYTE_ROUTE=playback` ✓ ✓ and the old product is unchanged ✓ ✓:

- **The consumer does not care.** The Plex HTPC canary — a **real PMS
  session** ✓ ✓ — passes on the playback route ✓ ✓: the session is created ✓,
  the identity matches ✓, playback progresses ✓, the forward/backward/near-EOF
  seeks all resolve ✓, and the stop tears the session down ✓ ✓. The
  baseline run on the `cached` route also passed ✓ ✓.
- **Every identity invariant is byte-identical across the flip** ✓ ✓ (the
  `.strm` files ✓, the Plex ratingKey ✓, `Part.file` ✓, `Part.size` ✓, the
  Binding → TorrentFile ✓, the VFS path and VFS TorrentFile ✓, the
  presentation identity and its commit time ✓, the provider routes ✓ ✓) —
  over four fixtures: two dual-route movies ✓, one single-route movie ✓, one
  TV episode ✓ ✓. **No `.strm` was rewritten** ✓ ✓.
- **The observed chain** ✓ ✓ (the edge's access log ✓): one
  `GET /stream/...` → `307` → `/play/<token>` ✓ ✓, then **every** byte,
  seek and near-EOF read on that one stable URL ✓ ✓ — with no provider host
  in any hop ✓ ✓ and no provider API touched at resolve time ✓ ✓.
- **Overhead is near-noise** ✓ ✓ (warm, 9 runs each ✓): the resolver hop
  3.89 → 5.15 ms ✓, the first 206 47.2 → 47.85 ms ✓, the seek 49.05 → 47.61
  ms ✓, the re-request 50.26 → 48.97 ms ✓ ✓ — the run-to-run ranges
  overlap ✓ ✓.
- **The rollback is configuration-only** ✓ ✓: `playback → cached →
  playback` changes the resolver's answer and **no durable identity row**
  ✓ ✓ (the identity fingerprints of all seven durable tables are
  byte-identical across the flips ✓ ✓).
- **Jellyfin remains environmentally blocked** ✓ ✓ — `GET /System/Info`
  answers **HTTP 401** ✓ ✓ (the configured `JELLYFIN_API_KEY` is rejected ✓ —
  the same pre-existing debt ✓ ✓). The Jellyfin *path* is characterized ✓
  ✓; no live Jellyfin session was observed ✓ ✓.
- **One pre-existing flake remains** ✓ ✓: the baseline canary run failed
  once with the documented `PMS_SESSION_NOT_CREATED` ✓ ✓ (PMS's busy-database
  wait expiring under the scanner's write lock ✓ — diagnosed 2026-10-12 ✓ ✓)
  and passed on retry ✓ ✓. It is not caused by this slice ✓ ✓.

The next earned slice is not selected ✓; the candidates are in the build log
✓ ✓ — the first of them is the tiny resolver→mpv reference client ✓ ✓.

**Pivot slice 3 — THE TINY RESOLVER CLIENT — CLOSED** (evidence in
`docs/BUILD-LOG.md` 2026-10-20). `hs play <intent>` now goes from an intent
to a playing frame with no Plex, no Jellyfin, no source picker and no
provider URL ✓ ✓:

- **The contract** ✓ ✓: `npm run hs -- play <media-id-or-title> [--season N]
  [--episode N] [--resume SECONDS] [--measure SECONDS] [--json] [--server URL]`
  ✓ ✓. The client holds no provider state ✓ ✓, never picks a release ✓ ✓,
  never sees a provider URL ✓ ✓ ✓✓.
- **The server side is a thin adapter over the existing authority** ✓ ✓:
  `POST /api/playback-object` ✓ ✓ — a title through the existing metadata
  search ✓ ✓, a media id through the existing request pipeline ✓ ✓, the
  active Binding naming the exact TorrentFile ✓ ✓. **The warm path does no
  discovery, no provider inventory and no provider API call** ✓ ✓ ✓✓.
- **Warm timings (10 runs)** ✓ ✓: resolve 40/41/60/60 ms (min/p50/p95/max)
  ✓ ✓; player startup 478/493/639/639 ms ✓ ✓; **first frame
  1070/1286/1286/1286 ms** ✓ ✓; zero manual actions ✓ ✓; one resolver
  attempt ✓ ✓ ✓✓.
- **A title works and ambiguity fails safely** ✓ ✓: "Alien" matched 25
  legitimate works ✓ ✓ → the API refuses (`AMBIGUOUS_INTENT` + the
  candidates ✓ ✓) → the client asks ✓ ✓ → one manual action ✓ ✓ →
  `tt0078748` ✓ ✓ → played ✓ ✓ ✓✓.
- **TV identity is exact** ✓ ✓ (the episode's own TorrentFile ✓ ✓; a series
  without coordinates is refused ✓ ✓ — no S00E00 ✓ ✓) ✓ ✓.
- **The cold path is accounted for but cannot finish here** ✓ ✓: the corpus
  retrieval + ranking + identity selection succeeded in 1.5 s ✓ ✓ (rank 1,
  score 0.729, identity tier Verified ✓ ✓, the exact TorrentFile identified
  ✓ ✓) but the provider had the release **uncached** ✓ ✓, so the VFS
  materialization (which creates the Binding ✓ ✓) cannot complete ✓ ✓ — the
  typed `NO_AUTHORITATIVE_REPRESENTATION` ✓ ✓ ✓✓.
- **The player is the ceiling** ✓ ✓: the 6.5 GB MP4 of Lanterns S01E05 has a
  `udta` box ffmpeg's mov demuxer rejects ✓ ✓ — it plays through Plex ✓ ✓
  but not through mpv ✓ ✓, over HTTP **and** from the local mount ✓ ✓ — a
  player limitation, not a HashSucker one ✓ ✓ ✓✓.
- **Plex versus the direct path** ✓ ✓: the Plex HTPC canary measured
  session→first-read 103 ms ✓ ✓, first-read TTFB 13 ms ✓ ✓ (a **local VFS**
  read ✓ ✓) and start→progress 10 603 ms ✓ ✓ (the Plex application's startup
  ✓ ✓); the direct client measured resolve 41 ms ✓ ✓, player startup 493 ms
  ✓ ✓, first frame 1286 ms ✓ ✓ ✓✓. The direct path reaches a playing frame
  in ~1.3 s against ~10.6 s — the Plex read is faster, the Plex application
  is slower ✓ ✓ ✓✓.
- **Tests**: 15 new ✓ ✓; the full suite is 3575/3571/1/3 ✓ ✓ — the one
  failure is the pre-existing `vfs-collection-resilience` C1/C2/C3 ✓ ✓.

The next earned slice is not selected ✓; the candidates are in the build log
✓ ✓ — the cold path's materialization gap ✓ ✓, the session contract ✓ ✓,
and a player comparison ✓ ✓ ✓✓.

**Pivot slice 4 — KEEP IT PLAYING: continuity for the same exact TorrentFile
— CLOSED** (evidence in `docs/BUILD-LOG.md` 2026-10-20). The continuity
levels were defined separately and measured independently ✓ ✓:

| level | verdict | evidence |
|---|---|---|
| L1 the next Range uses another route | **exists** ✓ ✓ | the Rust suite (13/13 ✓) + the Node continuity tests (9/9 ✓) ✓ ✓ |
| L2 a seek after a failure succeeds automatically | **exists** ✓ ✓ | `r2g` ✓ ✓, `C3` ✓ ✓ — one request ✓ ✓, the exact bytes ✓ ✓ ✓✓ |
| L3 an in-flight failure is retried behind the same playback object | **exists** ✓ ✓ | `r2f`: the route commits the 206 ✓ ✓, delivers 8 bytes ✓ ✓, then errors ✓ ✓ — the SAME request completes **byte-for-byte exact** ✓ ✓ (no duplicate ✓ ✓ no gap ✓ ✓) ✓✓ ✓✓ |
| L4 the player stays in the same media/file lifecycle | **exists for a route failure** ✓ ✓; **breaks at a token renewal** ✗ ✗ | `file-loaded: 1` across a failover ✓ ✓; `file-loaded: 2` across a renewal ✗ ✗ ✓✓ |
| L5 the interruption is imperceptible / under a stall budget | **exists, bounded** ✓ ✓ | the first frame moved 403 → 749 ms with a 400 ms injected stall ✓ ✓ and 403 → 319 ms with none ✓ ✓ ✓✓ |

- **Zero user action** ✓ ✓ in every proven case ✓ ✓: the failover ✓ ✓, the
  seek ✓ ✓, and the token renewal ✓ ✓ (the client re-resolves the same
  authoritative media ✓ ✓, takes a fresh URL ✓ ✓ and moves the player onto it
  at its recorded position ✓ ✓ — `renewedAtPositionSeconds` ✓ ✓,
  `seek: 1` ✓ ✓, **0 manual actions** ✓ ✓ ✓✓).
- **The client stays in charge of the session state** ✓ ✓: the playhead ✓ ✓,
  the decoder state ✓ ✓ and the tracks stay client-owned ✓ ✓ — the Binding ✓
  ✓, the TorrentFile ✓ ✓ and the route authority are untouched ✓ ✓ ✓✓.
- **No second route-health system** ✓ ✓: the Rust reader classifies the
  failure and records the event ✓ ✓ (`record_provider_failover` ✓ ✓), the
  Node side records what actually arrived ✓ ✓ ✓✓.
- **Correctness beats continuity** ✓ ✓: when every route is dead the request
  **fails closed** with the upstream's own typed status ✓ ✓
  (`502 PROVIDER_EXHAUSTED` ✓ ✓) — never a fake seamless recovery ✓ ✓ ✓✓.
- **Production (no sabotage)** ✓ ✓: City Lights (dual route) ✓ ✓ — the
  resolver 30 ms ✓ ✓, the **first frame 776 ms** ✓ ✓, `file-loaded: 1` ✓ ✓,
  0 manual actions ✓ ✓, a clean stop ✓ ✓; Rear Window (dual route) ✓ ✓ and
  Lanterns S01E02 ✓ ✓ both played ✓ ✓ with 0 manual actions ✓ ✓ ✓✓.
  The first-frame variance (0.8 s → ~90 s) is the **cold provider read**
  ✓ ✓ (the fixed-grid cache evicts 434.9 GB against 911.9 GB held ✓ ✓) ✓✓.
- **Player compatibility** ✓ ✓: the reference player is mpv **0.41.0** ✓ ✓
  (libavformat 63.1.101 ✓ ✓ / FFmpeg n9.0.1 ✓ ✓); the Plex HTPC bundles
  **mpv 0.38.0** ✓ ✓ with **libavformat 59** ✓ ✓ — an **isolated
  malformed-file tolerance difference** ✓ ✓ (the Lanterns S01E05 MP4 plays on
  the Plex HTPC ✓ ✓ and not on the system mpv ✓ ✓, over HTTP **and** from the
  local mount ✓ ✓ — so not a transport problem ✓ ✓) ✓✓ ✓✓.
- **Cold acquisition was not touched** ✓ ✓: the two cold fixtures still fail
  with the typed `NO_AUTHORITATIVE_REPRESENTATION` ✓ ✓, which is **correct**
  under the cache-only policy ✓ ✓ ✓✓.
- **Tests**: 9 new Node continuity tests ✓ ✓ + 2 new Rust scenarios ✓ ✓; the
  full suite is 3584/3580/1/3 ✓ ✓ — the one failure is the pre-existing
  `vfs-collection-resilience` C1/C2/C3 ✓ ✓ ✓✓.

The next earned slice is not selected ✓; the candidates are in the build log
✓ ✓ — a lifecycle-preserving renewal (a client that owns the byte layer ✓
✓), a measured stall distribution ✓ ✓, and the uncached execution capability
as the explicit product-policy decision it is ✓ ✓ ✓✓.





**Slice — first try wins? (2026-10-20) — CLOSED** (`docs/recon/2026-10-first-try-wins.md`).
Measurement only ✓ ✓ — no ranking change ✓ ✓, no schema change ✓ ✓, no
worker ✓ ✓, no metadata primitive ✓ ✓.

- **top-1 → Binding: 45.1 %** ✓ ✓ (60.4 % of the 144 known decisions ✓ ✓;
  49 were **unknown** ✓ ✓ and labelled so ✓ ✓) ✓✓.
- **first attempt → exact TF: 100 %** of the attempts that happened ✓ ✓
  (144/144 ✓ ✓) — **the materialization never fails** ✓ ✓ ✓✓.
- **The first Binding stayed authoritative: 18.1 %** ✓ ✓ — but every first
  Binding in the record carries the **VFS-era** reasons ✓ ✓, so it describes a
  superseded pipeline ✓ ✓ and is not counted as a selection miss ✓ ✓ ✓✓.
- **Attempts per request: p50 1, p95 1** ✓ ✓ ✓✓.
- **The taxonomy** ✓ ✓: **D (exact identity unavailable) 46** ✓ ✓, F
  (quality-policy loss) 11 ✓ ✓, and **zero** for A/B/C/E/G/H/I ✓ ✓ — nothing
  was mis-associated ✓ ✓, no provider was unavailable ✓ ✓, no bytes were bad
  ✓ ✓ ✓✓.
- **Every miss was explicable from decision-time facts** ✓ ✓: in 46 cases the
  top candidate was release-level or had no exact size ✓ ✓ — the pipeline
  demoted what it could not prove ✓ ✓, and the corpus holds **zero** file
  paths and **zero** exact sizes ✓ ✓ ✓✓.
- **The multi-file case is the weak one** ✓ ✓: 40 % (17/42 ✓ ✓) against
  69 % (70/102 ✓ ✓) ✓✓ — and the materialization is 100 % in both ✓ ✓ ✓✓.
- **The score is not monotonic** ✓ ✓ (100 % / 61 % / **42 %** / 59 % / **93 %**
  across the bands ✓ ✓); the identity tier separates better ✓ ✓ (`Verified`
  70 % ✓ ✓ vs. `ProviderScoped` 41 % ✓ ✓) ✓✓.
- **The upstream-evidence correlation is unmeasurable** ✓ ✓ (0 of the 144 rows
  carry it ✓ ✓) ✓✓ — and the **current-code replay is structurally
  impossible** ✓ ✓ (the live-addon candidates are never persisted ✓ ✓, and the
  historical decisions came from a different pipeline ✓ ✓) ✓✓.
- **The live cohort** ✓ ✓ (the warm path ✓ ✓): the first frame 862 ms /
  8.7 s / 47.6 s ✓ ✓ — all with **zero user actions** ✓ ✓ and a clean exit
  ✓ ✓; the variance is the cold provider read ✓ ✓, not selection ✓ ✓ ✓✓.
- **The metadata verdict: TARGETED VALUE** ✓ ✓ — a file tree would make the
  top candidate provable in the 32 % of decisions where it is not ✓ ✓; the
  user-visible delta is **not quantified** ✓ ✓ ✓✓.
- **No ranking change is earned** ✓ ✓ — every measurable miss traces to
  missing exact-file evidence ✓ ✓, and the selection already prefers a
  provable candidate ✓ ✓ ✓✓.

**Verdict: FIRST TRY NEEDS TARGETED EXACT-FILE PROOF** ✓ ✓ — not ranking work
✓ ✓, and not provider work ✓ ✓ ✓✓.
**Slice — what does exactness cost us? the proof tax (2026-10-21) —
CLOSED** ✓ ✓. Measurement only ✓ ✓; no ranking ✓ ✓, selection ✓ ✓, binding
✓ ✓, provider ✓ ✓ or consumer behaviour changed ✓ ✓ ✓✓.

- **The question was unanswerable from the persisted record** ✓ ✓ — the
  ranking is persisted ✓ ✓, the winner is persisted ✓ ✓, and **nothing
  persisted the losers or the reasons they lost** ✓ ✓ ✓✓. The decision
  site now records it ✓ ✓ in an append-only `selection_decisions` table ✓ ✓
  (the winner ✓ ✓, the winner's reason ✓ ✓, every skipped candidate with
  its **verbatim** reason ✓ ✓), written **after** the decision ✓ ✓, never
  read by selection/binding/handoff ✓ ✓, unable to change a Binding ✓ ✓, a
  TorrentFile ✓ ✓ or a handoff ✓ ✓ ✓✓. Pinned by **5** new tests ✓ ✓
  (append-only ✓ ✓, verbatim ✓ ✓, failure-isolated ✓ ✓, non-mutating ✓ ✓)
  ✓✓.
- **The causes of every skip, raw** ✓ ✓ (28 corpus + 8 live media ✓ ✓,
  560 skips ✓ ✓): **exactness 23 (4.1 %)** ✓ ✓, provider-unavailable
  **537 (95.9 %)** ✓ ✓ ✓✓. The exclusion matters ✓ ✓ ✓✓: a naive "the top
  candidate lost" read overstates the problem by an order of magnitude ✓ ✓.
- **The one decision that bound** ✓ ✓ (`tt10986410:1:2` ✓ ✓): the winner
  was **rank 11** ✓ ✓; ten higher-ranked candidates were demoted ✓ ✓. The
  pairwise delta was **Negligible 7 / Minor 3 / Material 0 / Severe 0** ✓ ✓
  and the resolution the user received was 2160p every time ✓ ✓ ✓✓. The
  tax is currently a **proof** cost, not yet a **quality** cost ✓ ✓ — the
  cohort's demotions were among near-equivalent candidates ✓ ✓ ✓✓.
- **The mechanism, proven end to end** ✓ ✓: the corpus path presents the
  **release-level** byte count as the candidate's "exact file size" ✓ ✓
  (`media-request-stages.js:227` ✓ ✓ — the title-index path ✓ ✓). For a
  release with more than one playable file that number matches **no** file
  ✓ ✓, so the exact-size proof cannot succeed ✓ ✓ ✓✓. The decisive
  experiment ✓ ✓ — one real release at the provider ✓ ✓ (11 files ✓ ✓):
  the corpus count → **NO_FILE_SIZE_MATCH** ✓ ✓, the true per-file size →
  **BOUND** ✓ ✓ ✓✓.
- **Over the releases the provider actually holds** ✓ ✓ (TorBox ✓ ✓,
  ready ✓ ✓: 354 releases ✓ ✓, 242 single-file ✓ ✓, **112 multi-file** ✓ ✓):
  the corpus's claimed size matches one of the files in **0 of 112 (0.0 %)**
  ✓ ✓, and the corpus holds a per-file **path** in 0 ✓ ✓ and a per-file
  **size** in 0 ✓ ✓ ✓✓. **Every multi-file release the provider holds is
  unprovable by the corpus's own number** ✓ ✓ ✓✓.
- **The upstream already has the fact** ✓ ✓: the debrid-form response
  carries `behaviorHints.videoSize` ✓ ✓ (the real per-file byte count ✓ ✓)
  on **456 of 582** streams ✓ ✓. Over 914 releases from **historical
  production traffic** ✓ ✓: the corpus count proves one file in
  **412 (45.1 %)** ✓ ✓, the upstream size in **856 (93.7 %)** ✓ ✓ ✓✓. A
  live run of the production ensure against the upstream's own size ✓ ✓:
  of 25 candidates **9 bound** ✓ ✓ — every case where the provider held
  the release ✓ ✓ ✓✓.
- **The season-pack focus** ✓ ✓: **29 of the 32** multi-file candidates
  that reach selection are **episode packs** ✓ ✓ ✓✓.
- **What would close each event, priced** ✓ ✓ (32 candidates ✓ ✓): a
  **per-file path+size** closes **32/32 (100 %)** ✓ ✓; a **targeted provider
  lookup** on rank#1 closes only **4/32 (12.5 %)** ✓ ✓ — it cannot name a
  file inside a pack ✓ ✓ ✓✓. **22/32 (68.8 %)** no provider inventory
  call can close ✓ ✓ ✓✓.
- **A real defect found and fixed** ✓ ✓: the availability checker passed
  the error category `'transient'` ✓ ✓, which is **not** in
  `PROVIDER_ERROR_CATEGORIES` ✓ ✓, so the observation layer **threw out of
  the catch block** ✓ ✓ — the intended degradation ✓ ✓ never happened ✓ ✓,
  the exception escaped ✓ ✓, and **every candidate lost its
  cached/uncached state** ✓ ✓, so the uncached-deferral traversal silently
  stopped deferring ✓ ✓ ✓✓. Fixed to `'temporarily-unavailable'` ✓ ✓ (the
  category the same block already reported ✓ ✓) with a new test ✓ ✓ ✓✓.

**Verdict: UPSTREAM ALREADY HAS THE FACT** ✓ ✓ — with the corpus path's
release-level count as the specific defect ✓ ✓. Not a metadata gap ✓ ✓ and
not a provider-lookup gap ✓ ✓ ✓✓.
**Slice — does identity enrichment have a right to exist? (2026-10-20) —
REDUNDANT (deprecated)** ✓ ✓. A right-to-exist test for the dormant seam, not
a wiring task ✓ ✓.

- **The contract, reconstructed** ✓ ✓: the worker reads a queued candidate ✓ ✓
  and asks exactly one source — the **Cinemeta identity resolver** ✓ ✓ — to
  establish which **media** a release belongs to ✓ ✓. It writes a
  `candidate_media` association with a confidence, a `resolution_state` and a
  `resolver_source` ✓ ✓. It **never** creates a TorrentFile and **never**
  creates or changes a Binding ✓ ✓ ✓✓.
- **Why zero rows** ✓ ✓: **there is no scheduler** ✓ ✓ — the queue holds
  **6 858 pending** ✓ ✓ but the only caller is the manual
  `npm run enrichment -- process` ✓ ✓ ✓✓. (It would also overwrite the
  association's `source` — the origin — with its own name ✓ ✓ ✓✓.)
- **The population** ✓ ✓: **5 534 (63.2 %)** are **stale** (the candidate is
  gone ✓ ✓); the **3 217** live ones have **no local exact-file fact** (the
  corpus's 1.59 M attribute rows carry **zero** file paths and **zero** file
  sizes ✓ ✓) → they are metainfo-dependent or provider-targeted ✓ ✓; and
  **3 120 of the 3 217 (97 %)** are for media that **already has an active
  Binding** ✓ ✓ — already resolved ✓ ✓ ✓✓.
- **The experiment** ✓ ✓: a bounded run of the real worker on scratch copies
  of both DBs ✓ ✓ — 20 processed, **6 resolved**, 14 failed, **432 ms/item**
  ✓ ✓ (~49 minutes for the whole queue ✓ ✓) ✓✓ — and its output is a
  confidence nudge on a 15 %-weighted term ✓ ✓: the ranking reads the
  association's **confidence** ✓ ✓, never its `resolution_state` ✓ ✓, and the
  eligibility gate judges the live parsed attributes ✓ ✓ ✓✓.
- **The exact-file identity is not what the worker produces** ✓ ✓ — it is the
  provider's file list ✓ ✓, targeted ✓ ✓, at materialization time ✓ ✓
  (118–338 ms ✓ ✓) ✓✓. There is **no local closure class** ✓ ✓ (bucket A is
  empty ✓ ✓) ✓✓.
- **The disposition** ✓ ✓: the worker and its CLI carry a **deprecation
  notice** with the contract ✓ ✓, the cause ✓ ✓, the cost ✓ ✓ and the
  condition for revival ✓ ✓ (a real request must consume the pre-resolved
  fact and measurably avoid work ✓ ✓) ✓✓. **No producer was implemented** ✓ ✓
  and no schema, queue or sweep was changed ✓ ✓ ✓✓.
- **If proactive exact-file knowledge is ever wanted** ✓ ✓, the unlock is a
  **torrent file-tree source** ✓ ✓ (exact paths and sizes per release ✓ ✓) ✓✓
  — stated, **not started** ✓ ✓ ✓✓.
- **Part 0 (its own commit, `acf706e`)** ✓ ✓: the Stremio audio grammar now
  reads the scene channel suffix ✓ ✓ — "AAC5.1" → AAC ✓ ✓ (it produced **no
  audio** before ✓ ✓), "DD+5.1"/"DDP5.1" → DD+ ✓ ✓, "DTS-X" unchanged ✓ ✓;
  the corpus's vocabulary was checked first ✓ ✓ and no new vocabulary was
  introduced ✓ ✓ ✓✓.
**Slice — upstream evidence in the same schema (2026-10-20) — CLOSED**
(`6e39711`). A production-hardening slice ✓ ✓ — the parser stays ✓ ✓, the
normalized schema stays ✓ ✓, the ranking policy stays ✓ ✓, and the addon's
data becomes **source evidence** ✓ ✓ ✓✓.

- **The 8K ordering bug is fixed** ✓ ✓: the resolution order ✓ ✓, the
  quality score ✓ ✓ and the corpus parser ✓ ✓ all know 4320p/8640p now ✓ ✓.
  A correctly parsed 8K release used to rank **below** ordinary 1080p
  releases ✓ ✓ and to score **zero** for the resolution component ✓ ✓ ✓✓. On
  the live cohort the newly-aired episode's top-1 moved 2160p → **4320p** ✓ ✓
  and the top-1 resolution now matches the upstream's in **8 of 8** fixtures
  ✓ ✓ (was 7 of 8 ✓ ✓) ✓✓.
- **The source-local ordinal is retained** ✓ ✓ (with its source id ✓ ✓) and
  is a **weak tiebreak within one source only** ✓ ✓ — never compared across
  sources ✓ ✓ ✓✓.
- **The upstream's facts survive** ✓ ✓ in a fixed, small evidence object ✓ ✓
  (the seeders on 605/605 ✓ ✓, the bit depth on the movie cohorts ✓ ✓, the
  source label ✓ ✓, the raw tag line ✓ ✓) ✓✓ — and the upstream may **fill**
  a missing fact ✓ ✓ but never overwrite a local one ✓ ✓ (`attributeOrigin`
  says which ✓ ✓) ✓✓.
- **The cache semantics are determined, not assumed** ✓ ✓: the upstream's
  hint means *"the release is in the cache of the provider the ADDON is
  configured with, as of the addon's response"* ✓ ✓ — the addon's claim ✓ ✓,
  not our provider observation ✓ ✓, not the addon's response cache ✓ ✓. It
  is now `upstreamCachedHint` ✓ ✓ — never a universal `cached` ✓ ✓, never
  persisted ✓ ✓ ✓✓.
- **The parser remains the normalizer** ✓ ✓ — and for a series the upstream
  publishes no parse at all ✓ ✓ (the `bingeGroup` is the infoHash ✓ ✓), so a
  uniform cross-source parse is not duplication ✓ ✓ ✓✓.
- **Exact-file authority is unchanged** ✓ ✓: with an infoHash and a fileIdx
  but no path and no exact size ✓ ✓, the identity strength stays
  `release-only` ✓ ✓ ✓✓.
- **Cost did not regress** ✓ ✓ (the normalize 0.31–4.93 ms ✓ ✓, the sort
  ≤ 0.25 ms ✓ ✓) ✓✓ — and the full suite is 3594/3590/1/3 ✓ ✓ (the one
  failure is the pre-existing `vfs-collection-resilience` C1/C2/C3 ✓ ✓) ✓✓.
- **The provenance gap is diagnosed, not fixed** ✓ ✓: `resolver_source` is
  written by exactly one writer ✓ ✓ (the identity-enrichment worker ✓ ✓),
  and **that writer has produced no rows** ✓ ✓ — the unresolved class has no
  resolver provenance because there is no producer, not because a value is
  lost ✓ ✓ ✓✓. The `request-outcome` writer should **not** set it ✓ ✓ (its
  `source` column already carries the provenance ✓ ✓) ✓✓.
**Slice — are we re-ranking for a reason? (2026-10-20) — CLOSED**
(`docs/recon/2026-10-rerank-differential.md`). Measurement only ✓ ✓ — **no
production selection behaviour changed** ✓ ✓. The upstream's interpretation and
HashSucker's were run side by side on a live eight-fixture cohort ✓ ✓
(613 candidates ✓ ✓, no debrid key ✓ ✓ so no provider API was called ✓ ✓).

- The parser agreement is **84.1 %** ✓ ✓ — and the 15.2 % where HashSucker
  "knows more" ✓ ✓ are the upstream's **own** facts recovered from its title
  ✓ ✓ — a re-derivation ✓ ✓, not an addition ✓ ✓ ✓✓.
- The upstream carries facts HashSucker's normalizer has no field for ✓ ✓
  (the **seeders** ✓ ✓, the bit depth ✓ ✓); HashSucker carries facts the
  upstream's tag list never does ✓ ✓ (the **audio** ✓ ✓, the episode→file
  mapping ✓ ✓) ✓✓.
- The ranking models ✓ ✓: M1 (ours ✓ ✓) differs from M2 (the upstream's
  order ✓ ✓) on the top-1 in 7 of 8 fixtures ✓ ✓ but on the top-1
  **quality** in only 1 ✓ ✓; **M3** (ours + the upstream's parse as features
  + the upstream's position as a tiebreak ✓ ✓) changes **no** top-1 ✓ ✓ and
  makes the top-3 identical to the upstream's ✓ ✓ ✓✓.
- A real gap ✓ ✓: the resolution **ordering** does not know `4320p` ✓ ✓, so a
  genuine 8K release is ranked last ✓ ✓ ✓✓.
- The cost is **not CPU** ✓ ✓ (the parse 0.3–3.9 ms ✓ ✓, the sort 0–4.3 ms
  ✓ ✓) and the DB churn from the addon path is **zero** ✓ ✓ (no addon
  candidate is ever persisted ✓ ✓) ✓✓ — but the addon's `cached` flag **is**
  dropped at the live-bridge boundary ✓ ✓ ✓✓.
- The upstream's ordering encodes **someone else's policy** ✓ ✓ (its sort is
  a config option ✓ ✓) ✓ ✓ — it is evidence ✓ ✓, never authority ✓ ✓ ✓✓.

**Verdict: USE UPSTREAM AS FEATURES** ✓ ✓ — the normalization stays ✓ ✓
(it is what makes heterogeneous sources comparable ✓ ✓ and the only parse
that covers the audio ✓ ✓ and the episode→file mapping ✓ ✓) ✓✓, but the
addon's richer facts should be **features** ✓ ✓ and its order a **tiebreak**
✓ ✓, not a re-derivation ✓ ✓ ✓✓. The four smallest candidate changes are
recorded ✓ ✓ and **not applied** ✓ ✓ ✓✓.
**Recon — the Stremio / Torrentio / Comet execution model (2026-10-20).**
`docs/recon/2026-10-stremio-addon-execution-model.md`. The comparison target
is **not** Stremio ✓ ✓ — Stremio is a client and a URL format ✓ ✓: it
preserves the addon's order ✓ ✓, hands the chosen URL to mpv ✓ ✓, and
performs **no** stream-URL retry ✓ ✓, **no** provider failover ✓ ✓ and **no**
re-resolution ✓ ✓ (the human picking another row **is** the failover ✓ ✓).

The findings that change the product conversation ✓ ✓:

- **The competitor is the resolver stack** ✓ ✓ — Torrentio ✓ ✓ and Comet ✓ ✓
  — and both already discover ✓ ✓, parse quality ✓ ✓, rank ✓ ✓, check the
  debrid cache ✓ ✓ and hand the client a URL ✓ ✓. Comet's **unreleased**
  newest branch already mints a signed ✓ ✓, TTL'd ✓ ✓, multi-provider ✓ ✓
  playback capability ✓ ✓ — the closest thing to our shape ✓ ✓ ✓✓.
- **A "click title → first frame" cook-off is benchmark theatre** ✓ ✓: with
  both stacks fed the same addons ✓ ✓ it would measure our *duplication* ✓ ✓
  and Stremio's client startup ✓ ✓ — not the architecture ✓ ✓ ✓✓.
- **We duplicate work the addons already did** ✓ ✓: we re-parse the
  filename for quality ✓ ✓ and re-sort the addon's ranked list ✓ ✓, while
  keeping the raw object ✓ ✓ and the addon's own `bingeGroup` ✓ ✓ — and not
  using either ✓ ✓ ✓✓.
- **Our distinct layer is the exact file** ✓ ✓: `TorrentFile = infoHash +
  canonical path + exact size` ✓ ✓. Torrentio knows a file *index* ✓ ✓;
  Comet knows an index that degrades when the torrent is uncached ✓ ✓ and
  re-scores the episode file heuristically on every playback ✓ ✓ ✓✓.
- **Our advantage is a lead, not a moat** ✓ ✓: Comet's newest branch is most
  of the way to a stable URL plus a chosen file ✓ ✓; erasing the URL
  advantage is a modest extension ✓ ✓, erasing the *identity* advantage
  additionally needs a protocol field ✓ ✓ ✓✓.

**The recommendation is NO COOK-OFF YET** ✓ ✓ — the meaningful comparisons
are narrower ✓ ✓: route death ✓ ✓ and season-pack exact-file correctness ✓ ✓,
both on a naturally dual-route corpus ✓ ✓, and the *first* action is to stop
re-deriving what the addon already computed ✓ ✓ ✓✓.


Completed final slice: **bound stale-inventory binding retry churn** —
**CLOSED**. The host-only canary passed clean E01 plus the full E01/E05/MobLand
rotation against deployed `57bbfe1`; immediate replay/restart churn is bounded
by the narrow suppression. Long-run reproduction remains observational debt,
not a current blocker.

Completed product slice: **post-discovery binding tail** — **CLOSED**
(`1cc5445`, evidence in `docs/BUILD-LOG.md` 2026-10-19). The cold-request
tail after availability was ONE operation, not a stage: the TorBox
file-inventory capability downloaded the provider's whole account (421
torrents, 5.2 MB, 1.1–5.6 s) to read one torrent's file list. It now
reads only the requested torrent (`mylist?id=`, proven byte-identical
against the live account for cached, non-cached, and absent torrents),
reusing the account snapshot when the request already has one. State-matched
10-fixture E2E: request→Binding 2433/4728/6386/6386 ms → 584/962/1168/1168
ms, request→Part 2473/4768/6429/6429 → 623/1002/1206/1206, request→206
2523/4817/6478/6478 → 658/1052/1532/1532; same release and same
TorrentFile on every fixture. Remaining known cost: the create-first
verify still needs the account-wide read (the provider's only hash index —
a proven floor, once per release), pinned by a negative control.

Completed product slice: **critical-path independence & autonomous
recovery audit** — **CLOSED** (`b18fc4a`, `c707e12`, `500c3b5`, `33e6e09`,
`1d7c94b`; evidence in `docs/BUILD-LOG.md` 2026-10-19, matrix in
`docs/critical-path-dependencies.md`). The foreground was already bounded
almost everywhere; the audit found one unbounded external call (Cinemeta:
no timeout, no abort) and two background loops that a READ path drove
forever: the RD realizer re-downloaded the provider's whole account once
per release per catalog pass (147 downloads per 4 forced passes → 1), and
the WebDAV catalog sweep re-authorized already-authorized Bindings, so an
expired 5-minute inventory observation read as a permanent failure (330
warnings / 30 min → 16 / 5 min). A live Cinemeta stall was caught during
the measurement and now aborts at the 3 s budget with the publication
completing.

Completed product slice: **what is dead may never die (route
resilience)** — **CLOSED** (`be6e663`, `d44be2f`, `5e0e675`, `64b2914`;
evidence in `docs/BUILD-LOG.md` 2026-10-19). The authority model was
mostly already right: the byte path fails over between the ROUTES of one
TorrentFile and the class-D 502 is emitted before any 206, and production
shows 174 active Bindings with 174 expired route observations and 0
degraded Bindings. The one leak was Node's class-D fallback, which
answered a dead ROUTE by choosing a different REPRESENTATION; it now
resurrects a route to the SAME TorrentFile first (through the existing
cache-only second-placement machinery, bounded per TorrentFile), so a
delivery failure no longer re-decides representation authority. The
delivery state also got ONE vocabulary and is now reported next to the
authority on the reuse path.

Completed product slice: **durable route failure authority** — **CLOSED**
(`c3be499`, `044568b`; evidence in `docs/BUILD-LOG.md` 2026-10-19). The
durable model already existed (`provider_delivery_evidence`, capability
tuple, usable/temporary/terminal) and was never written by the
authoritative path; the data plane also threw away the information of
WHICH route died and why. The byte path now reports the failed routes
with their durability class (404/410/protocol-invalid/wrong-size are
DEAD; throttle/timeout/5xx are not), the VFS records them in the
existing store, a route that delivers again clears the negative evidence,
and replacing the authoritative representation is an explicit policy
decision (durable terminal evidence for EVERY failed route, plus a
one-switch-per-window budget) instead of a side effect of a read. The
inert reconciler no longer plans 'mark-degraded' for route facts.

Completed product slice: **the dead speak — evidence-driven bounded-poll
route recovery** — **CLOSED** (`de25fff`; evidence in `docs/BUILD-LOG.md`
2026-10-19). The route reconciler re-derived route failure by probing the
providers every six hours (an account-wide TorBox cache check plus a 5 MB
Real-Debrid account list) even though the durable delivery evidence
already recorded what died, when, and whether it was merely throttled. The
evidence is now the input: a TorrentFile whose every recorded route is
proven dead has a repair DUE, the pass is local until work is due (so it
runs every minute instead of every six hours), the provider is asked only
"is there another resource for this exact TorrentFile?", and the
retirement of a dead redundant route makes no provider call at all.
Measured in production: an idle pass 2 provider calls → 0, RD rate-limit
waits 10/60min → 0, failure→repair ≤6 h → ≤60 s, and a restart resumes
recovery without waiting for the sweep. The periodic sweep keeps one
narrow job: a TorrentFile with no recorded route at all, whose release may
have appeared in an account since we last looked.

Completed product slice: **one truth for routes** — **CLOSED**
(`88c5260`, `0b85b59`, `16865c6`, `12c5ed9`; evidence in
`docs/BUILD-LOG.md` 2026-10-20). Route availability had FIVE definitions:
a placement row existed, a provider file was mapped, a delivery
observation was fresh — and each consumer picked one. A route proven dead
therefore counted as redundancy when the ensurer chose a provider, as a
live route when the recovery picked its work, and as a servable route
when the byte path's route set was built. There is now ONE definition of
a route's state (`route-classification.js`: serviceable / retryable /
dead, per capability tuple, from the placement + the provider file + the
durable evidence), and every route decision consumes it. The repair now
targets the provider that LOST its route, re-observes the dead route
first (a fresh observation supersedes the terminal verdict), never
reuses a proven-dead route, and sees a replacement resource that the
singular placement lookup hid. A negative discovery is complete only when
EVERY candidate account was searched; an ambiguous account listing is not
a negative. A proven-dead route is not offered to the byte path, and the
repair attempt is throttled (a stuck work item no longer re-reads a 5.5 MB
account every minute). Proven on the appliance: a dead route with a live
sibling kept serving byte-identical bytes and was retired on evidence
alone; a dead route with no sibling failed closed (a typed 502, never
another representation) and was repaired within the 60 s pass with ONE
provider call, the same TorrentFile, the same Binding, the same VFS path
and the same Plex ratingKey. The proof also found a live defect: the
class-D path answered 500 `evidenceSummary is not defined` instead of the
typed provider failure — fixed, with a regression test that fails without
the fix.

Completed product slice: **one name to rule them all (the presentation
identity)** — **CLOSED** (`eec42af`, `af23a96`, `40ea543`; evidence in
`docs/BUILD-LOG.md` 2026-10-20). The consumer-visible name of a media
intent was derived by TWO resolvers with two source precedences: the VFS
materializer preferred the request's canonical title, the `.strm`
publisher ignored it and led with the catalog — and the `.strm` path was
recomputed on EVERY publication, so a metadata answer could write a
second artifact for the same media. Measured on the appliance: 148 of
168 comparable `.strm` names disagreed with the VFS path of the same
media; 14 directory names carried a catalog year RANGE; three carried
release grammar; two had no season/episode at all; every published
`library_items.title` had been clobbered with the bare media id. There is
now ONE durable presentation identity per media intent (on the
control-plane library item: the display name, the year, the canonical VFS
path, the `.strm` path), resolved once at the publication, from one
precedence (request canonical → catalog → filename inference → media id;
the year follows the title's authority and is normalized). The paths are
written once and never rewritten — a representation change, a route
repair, a republication and a late metadata answer all leave the
published name alone — and an artifact that already exists is ADOPTED
where it is, never renamed and never duplicated. The proof also found
three real defects: a TV handoff resolved the MOVIE catalog (and got a
different film), two publications raced on one temp file, and the
control-plane canonical path migrated when a republicublish carried a
different request name. Production: 179 identities committed, 168
aligned and 0 drifted, 0 files renamed and 0 deleted; a movie
re-request and a TV republication each left one artifact and one
identity, the Plex ratingKey was unchanged (423), and the read served
the same bytes.

Completed product slice: **consumer projection from first principles** —
**CLOSED** (`f7ff87e`; evidence in `docs/BUILD-LOG.md` 2026-10-20). Plex
and Jellyfin are projections of HashSucker's durable truth, but nothing
said what that projection WAS: the refresh notifier derived a scan path,
the ingest derived an expected Part file, the request path asked "does
Plex hold SOME Part", and the operator surface reported one `published`
state — so a missing consumer item and a missing media item were the same
sentence. There is now ONE derivation of the desired projection (the scan
path, the expected Part.file, the expected Part.size, the consumer path ✓)
from the library item, the committed presentation identity, the VFS row and
the binding; a comparison that classifies the difference (aligned /
missing / stale-path / stale-size / conflicted / unknown ✓ — an
unobserved consumer is UNKNOWN, never absent ✓); and a repair that asks
the consumer to look at the exact directory and observes again (no media
reselection ✓, no provider work ✓, no rename ✓, no Binding mutation ✓).
The truth leaks are closed: a Plex title is no longer an identity
fallback ✓, a consumer-chosen Part can no longer certify our publication
✓, a missing Part id is no longer the truthy string "null" ✓, a truncated
Jellyfin list is UNKNOWN rather than absence ✓, and a consumer absence
must persist before it schedules durable republication work ✓. Proven on
the appliance: 190 intents audited ✓, 170 aligned ✓, 6 missing ✓, 13
without a byte path ✓, 1 stale size ✓ — and a missing projection was
RESTORED from our truth alone ✓ (one targeted refresh ✓, the Part
appeared ✓ at our exact path ✓, the byte path served 206 ✓, and our
durable truth was unchanged ✓). The proof also found that our own truth
has TWO copies of the byte identity ✓ (the VFS row and the binding can
name different TorrentFiles ✓) — the next earned slice.

Completed product slice: **one byte identity** — **CLOSED** (`f75e51b`,
`e611137`; evidence in `docs/BUILD-LOG.md` 2026-10-20). The durable truth
held TWO copies of the byte identity — the active Binding's TorrentFile
(the authority) and the VFS row's TorrentFile (what the byte path
serves) — written by different code in different databases, with nothing
reconciling them. The production specimen had been diverged for two days:
the byte path served one release while the Binding named another, and
Plex reported a third size. The window was the write order: the VFS row
was written first, the Binding activated afterwards, and when the
activation failed (a stale provider inventory observation, with a
process-local retry that died with the container) the row had already
moved. The rule is now explicit: a VFS row's byte identity is a
PROJECTION of the active Binding's TorrentFile — the Binding settles
first, the row follows, the path never moves, and a local
reconciliation (startup + every 5 min, no provider/metadata/discovery
work) converges any surviving drift. The route-repair negative control
holds: a route change moves the route, never the bytes.

Completed product slice: **the route shall not choose the release** —
**CLOSED** (`e6d1543`, `bbaa21a`; evidence in `docs/BUILD-LOG.md`
2026-10-20). The byte authority was closed, but one representation leak
remained: the routine reconciler planned its rebind from the DESIRED
release rather than the active Binding's, so a route-level mechanism
could activate a Binding for a different TorrentFile. The two policy
domains are now separated and the separation is enforced where a Binding
is written: a Binding may name a different TorrentFile only with an
explicit reason from a closed set (the request path's selection, the
upgrade watch's quality policy, the delivery-exhaustion fallback, the
rejection supersede, the operator), and the reason is recorded on the
binding. The reconciler is exact-TorrentFile scoped: it rebinds the route
inside the Binding's own release, and a differing desired release is
reported as a representation decision the representation policy owns. The
premise was checked against the production history: all 96 historical
representation changes came from the publication path and ZERO from the
route reconciler — the leak was latent, and it is now closed
structurally rather than by observation.

Completed product slice: **exact file everywhere: provider route
identity** — **CLOSED** (`cb05670`, `7899eb8`; evidence in
`docs/BUILD-LOG.md` 2026-10-20). The representation authority was
closed, but one identity leak remained below it: a provider route could
be authorized by a Release-level fact. The Real-Debrid classification
answered "the only playable video in this resource" — and the route
authorization never checked that the file it picked was the size the
discovery selected, so the bytes an item served were not necessarily the
bytes the ranking chose. The route contract is now one function: the
provider's path AND its exact size must be the TorrentFile's, with the
provider-specific framing (TorBox's file name carries the torrent root;
Real-Debrid's file path is relative to it) and a minimal normalization
(no case folding, no interior collapsing, no basename). The provider
file index is execution metadata; the provider's NATIVE file id is the
identity Rust binds its capability to. The production audit: 4120 of 4120
durable provider-file mappings are exact (the release + path + size all
agree), 50 are unmapped extras, zero mismatches — so nothing needed
repair and nothing was rewritten.

Completed product slice: **the corpus knows the file: exact discovery
identity** — **CLOSED** (`a05410a`; evidence in `docs/BUILD-LOG.md`
2026-10-20). The audit changed the plan: the corpus is a release-level
FILENAME PARSER — 1 593 141 rows, **none** with a file-level path, the
`candidates` cache 100% release-level too, and the only per-file fact in
the chain is the stream's exact byte count. There was no path information
being discarded: there was none. So the corpus's per-file record now
carries `file_path`/`file_size` (nullable, additive, never fabricated from
a release name), every candidate states its identity STRENGTH explicitly
(`exact-file` / `size-corroborated` / `release-only`), the TorBox helper
consumes the exact path when a candidate has one, and the byte count is
labelled for what it is: the audit measured that 424 of 4099 mapped
provider files (10.3 %) share their byte count with another file of the
same resource, which is why a size-only match inside a resource must fail
closed.

Next earned slice: **give the discovery a per-file path from a source
that HAS one**. The provider's inventory has it; the corpus does not. A
torrent-metadata sidecar (the .torrent's own file list) for the releases
the corpus already holds would give the corpus the per-file path at a
fraction of the cost of a provider scan — and would make the size-only
selection disappear.

Completed product slice: **exact durable-truth republication** — **CLOSED**.
E01 VFS publication was genuinely removed, then recreated through
`POST /api/library/republish` with the same Binding, TorrentFile, placement,
representation, and Plex path. No discovery/reselection ran; host E01 canary
playback passed after reconstruction. Missing retained truth returns 409 and
fails closed. This is an earned continuity primitive, not a general
consumer-replacement framework.

Recently active slice (now settled): **cached byte routing default
cutover** — FLIPPED in
`f35d906` (compose default is now `STREAM_BYTE_ROUTE:-cached`; code-level env
fallback remains `provider` when unset). `fcd7967` first flipped it, `8f1b9e1`
reverted it, and `f35d906` re-flipped it after the recorded gates; `PLANS.md`
was not updated after that commit, so this is the reconciliation. Earlier notes
recorded a same-file concurrency joiner-delivery race; the later flip asserts
that gate passed (Jellyfin 2/3-session exact, Plex canary exact, soak 15/15
exact). If a truncated-body regression reappears, the escape hatch remains
`STREAM_BYTE_ROUTE=provider`. Non-goals: architecture refactor, new provider
behavior, representation change.

Recently active slice (now settled): **TorBox delivery attribution +
blocked-item handling** — RESOLVED (AT&T block lifted) + HARDENED (`1ca03e1`; evidence in `docs/BUILD-LOG.md` 2026-10-16,
incident `artifacts/incident/torbox-cdn-sni-reset.md`). The `nexus.erth.tb-cdn.earth`
TLS reset is NOT a TorBox/CDN fault: it is an SNI-exact, destination-independent
reset on the operator's WAN path (AT&T gateway/ISP filter) — proven by resetting
that one SNI against 8.8.8.8/1.1.1.1/Google while random SNIs succeed. No
supported TorBox alternative and no regeneration path exists. 132/136 active
bindings (97%) are TorBox-only and currently unserviceable. Fix (operator
action, not applied): allowlist the hostname or route it via a trusted alternate
egress. Product hardening landed: class-fair scheduler drain (a blocked P0
backlog no longer starves `released-request-follow-up` P4 recovery rows);
positive byte-health now decays after 10 min; blocked-publication policy
evaluated and Policy A retained with a truthful `serviceability` state. Gate:
blocked items recover autonomously when the route recovers (no human request).
Non-goals: unsafe workarounds (TLS bypass, SNI spoofing, URL rewrite, DNS
pinning, third-party proxy), durable identity change.

Prior active slice: **execution-quality selection — prefer a serviceable
cached representation** — FIXED + DEPLOYED (`8d1b40b`, `d7fd6b9`; evidence in
`docs/BUILD-LOG.md` 2026-10-16). Problem: selection could publish a
representation that was already knowably unserviceable here (The Batman:
TorBox-only, CDN reset). Fix: a bounded serviceability gate in
`selectBindableCandidate` (probe = recent byte-health, else ONE bounded byte
read) so a cached-but-dead representation does not win over an executable one;
best-ranked unserviceable bind retained as fallback with
`serviceability:{state:'blocked',reason,provider}`; bounded to 4 extra
candidates; no probe seam ⇒ pre-change behavior. Also fixed a real defect: RD
placements were durably unbindable (inventory not authoritative/complete).
Gate: a natural fresh request whose top cached candidate is unserviceable
selects a serviceable one and serves real bytes (Harakiri: RD-bound, 206 +
seek, Plex-visible); The Batman retains the exact external blocker. Non-goals:
uncached acquisition, identity-model change, binding churn for an existing
Binding, provider-preference inversion.

Prior active slice: **hardening — no single failure can wedge request →
playback** — FIXED + DEPLOYED (`0bdfcfd`, `0f7292e`, `f3e3f2f`, `ae41376`;
evidence in `docs/BUILD-LOG.md` 2026-10-16). Follows the responsiveness slice
(`d9f647e`, `3e1855b`, `2141315`) whose "after" Plex result used a manual
refresh. Closed here: consumer-visible vs byte-serviceable are now
distinguishable (runtime `byte-health` registry + operator `serviceable`
field); every VFS read failure mode is bounded (deterministic matrix + 30 s
forward header timeout); the scheduler per-action budget bounds a hung action
and nudges are no longer dropped in flight; two real alternate-route defects
fixed (mid-body-truncation failover; RD torrent links→selected-file mapping).
Gate: natural fresh request reaches the earliest usable Plex boundary without
manual refresh and reports a precise serviceability blocker; a healthy-route
item serves byte-identical bytes through VFS and the Plex Part; recovery is
observable. External, unfixed: `nexus.erth.tb-cdn.earth` TLS reset — a
TorBox-cached-only release is unserviceable (reported fast, not silent).
Non-goals: cache-only policy changes, uncached acquisition, representation
changes, new scheduler, tracing platform, route-level Rust backoff (noted
open).

Prior active slice: **end-to-end request → playable responsiveness** — FIXED
+ DEPLOYED (`d9f647e`, `3e1855b`, `2141315`). Live case The Lowdown S01/S02.
Root cause (not ranking/discovery/VFS): request → published was already fast,
but a connection-level provider byte-read failure paid a 30 s × 3 load backoff
(~90 s, unbounded to the client), blocking PMS ingest (scanner stuck in
D-state, 1/10 episodes for 5+ h) and starving the anticipation scheduler
(~6 h). Fix: Rust transport fails a headerless `send()` error in the bounded
zero-cooldown path; scheduler action floor; fresh-season nudge; episode trace.
External, unfixed: `nexus.erth.tb-cdn.earth` TLS reset (Lowdown routes
TorBox-only) → 0 playable, reported fast.

Prior active slice: **N1 accepted representation memory**. Exact
accepted-TorrentFile fact writes from an observed PMS session with positive
progression and the exact active Binding/TorrentFile. No request selection
behavior consumes it yet; this slice proved trustworthy memory, not a ranking
optimization. Baseline instrumentation: 483 recent requests, 307 repeated
decisions, 190 adjacent same-infoHash outcomes, 37 adjacent same-known-size
outcomes. Observation uses a bounded 10-second Plex-session poll only when
published active bindings exist.

Prior slice — repo documentation/control-plane reconciliation —
completed by the documentation lane; no product-code work is reopened here.

Prior active slice — exit-condition canary — capability achieved, gate
recorded: real Plex-library visibility, real playback, identity
verification, adversarial seeks, near-EOF behavior, clean teardown, and
diagnostic attribution are evidenced in `docs/BUILD-LOG.md` (9/26–9/30
entries), including the 9/30 sentinel rotation (3/3 passes, 94 ms
session-to-first-read). The canary is complete enough for on-demand
regression use at modest cadence. Not proven: continuous scheduled
operation, lifecycle recovery, PMS outage continuity. That
operationalization is ongoing engineering work owned by session state
(`handoff/CURRENT.md`), not a docs gate. No new playback work is
invented here.

Future phases: [`docs/ROADMAP.md`](docs/ROADMAP.md) (backlog only — not
active until moved here with a gate).

Parked (explicitly not active): scheduler throughput tuning beyond the
ROADMAP Phase A gate; speculative acquisition; second identity/ranking/
reuse implementations; new product surface beyond the sequenced slice
(core exit condition met — parked status now needs per-slice justification,
not the blanket gate).

Session/production state: [`handoff/CURRENT.md`](handoff/CURRENT.md).
Half-life rule: CURRENT.md answers "what does a fresh agent need about the
live environment/session right now" and may change any session; this file
answers "what work is active, why, and what gate advances us" and changes
only on slice completion or explicit replan. Do not merge them.
Durable model: [`docs/architecture.md`](docs/architecture.md).

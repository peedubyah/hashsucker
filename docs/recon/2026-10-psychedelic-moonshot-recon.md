# Psychedelic Moonshot Recon — What If HashSucker Owns the Experience? (2026-10-20)

Status: recon + product architecture only. No code, no client, no BitTorrent
integration, no roadmap change. Nothing in this document is a slice; it is the
evidence a human disposes of.

Inputs: round-two recon (`docs/recon/2026-10-recon-round-two-the-pivot.md`),
the sealed local model (`docs/architecture.md` §2, `docs/playback-delivery.md`),
the prior temporal-correspondence experiment
(`docs/recon/2026-10-temporal-correspondence-results.md`), and four parallel
external research streams (player substrates; torrent engines; VPN isolation +
latency; representation equivalence + semantic front door).

---

## 1. The pivot statement

HashSucker's center of gravity moves from *a fulfillment layer that publishes a
library into somebody else's media server* to *a resolver that any client can
call* — the durable identity, representation and route authority stay exactly
where they are, but the product boundary moves outward from "the `.strm` file
Plex discovers" to "one stable, signed, identity-derived URL that any player
can open", with HashSucker's own client existing only as a reference proof
rather than as a product. Everything the pivot demotes (the consumer library as
the product edge) is a *surface*; everything it promotes (the resolver contract,
the capability abstraction, the corpus as the thing that makes press-play
immediate) is *substrate*.

---

## 2. New product primitive

**The resolvable item**: a durable media identity plus a durable
representation, addressable by a stable URL, whose *route* may change
underneath it without the URL or the represented bytes changing.

HashSucker already owns this primitive in two of its three forms:

- `/stream/:type/:id` — a stable, identity-derived URL. But it answers with a
  **307 redirect to the provider**, so the client leaves HashSucker's trust
  boundary and the route is no longer HashSucker's to change.
- `/vfs/...` (WebDAV) and `/media/:infoHash/:fileIndex` — **proxying** paths
  that keep the bytes inside HashSucker's boundary and can therefore fail over
  transparently. The WebDAV path refreshes ephemeral provider URLs on
  `401/403/404/410`.
- `.strm` — a one-line file containing the `/stream/` URL. "Stable forever —
  the URL is derived from content identity, so changing provider, binding,
  exposure, or mount never requires rewriting a `.strm`."

**So the primitive exists; what is missing is its *session* contract.**
A client-first product needs one object that carries: the resolved identity,
the exact TorrentFile, the currently live route, alternates, the resume
position, the subtitle/audio preference, and the continuity/recovery state.
(Part 4's question — does this simplify the model or duplicate it? — is
answered in §13: it *duplicates* the Binding and the capability state, and its
only genuinely new content is the **session-scoped** part: position,
preferences, and the live-alternate list.)

The right shape is therefore not a new durable entity but a **projection of
existing durable facts, minted per session** — a signed, short-lived,
playback-scoped object the client can hold. It must be *derived*, never
authoritative: if it is lost, the durable state still knows what to play.

---

## 3. Client/server ownership boundary

| responsibility | owner | note |
|---|---|---|
| media identity (release, TorrentFile, presentation) | **HashSucker** | never the client, never a provider |
| representation choice + reason | **HashSucker** | the closed reason set stays server-side |
| exact delivery routes + health | **HashSucker** | the client must never learn provider identity |
| autonomous repair / route substitution | **HashSucker** | the client is a *sensor*, never a controller |
| fulfillment (materialize, cache, warm) | **HashSucker** | |
| playback position | **client** (authoritative for the session) | server may hold a durable copy |
| subtitle/audio preference | **client** (per session), **corpus** (availability) | the split that does not fit cleanly (§3.1) |
| decoder / renderer / device capability | **client** | |
| input (remote, keyboard, touch) | **client** | |
| discovery surface / browsability | **client** | it may be Stremio, a TV app, a browser |

### 3.1 Responsibilities that do not fit cleanly

1. **Subtitles and audio tracks.** The corpus knows which external subtitle
   tracks exist for a release; the client knows the user's language and
   accessibility needs. Neither owns the pair. The honest contract: the
   resolver *offers* the track inventory; the client *selects*; the server
   *serves* the bytes.
2. **Resume position.** The client knows where the user stopped; the durable
   presentation identity may know a better position (across devices). Today
   the server owns a durable presentation identity and the client owns
   nothing. Under a client-first model the client must be able to *report*
   position back without becoming authoritative for identity.
3. **The failover trigger.** Today "the player never triggers repair or
   refresh" (`docs/playback-delivery.md` §7). Under a client-first model the
   client *will* observe a `404/503` and will want to retry. The correct
   contract: the client's retry is a **read**, and the server's revalidation
   path (which already exists: fresh/stale observation, bounded provider
   check, `CACHED`/`UNCACHED`/`UNKNOWN` → `307`/`409`/`503`) does the repair
   before the client's next attempt. The client is not a control plane.
4. **Representation upgrades mid-session.** The server may want to move from a
   1080p WEB-DL to a 2160p remux. That is a *representation reason*, not a
   route change — and it requires the client to accept a source change. This
   is the one place the client must be told something structural, and it is
   exactly where the closed reason set earns its keep.
5. **"Which am I watching?"** The client may want to display a stable title.
   That is the presentation identity — server-owned ✓.

---

## 4. VFS verdict: **KEEP as compatibility, DEMOTE from product**

Evidence for keeping it:

- It is already a *projection*, not a store: "serves a synthetic WebDAV tree
  built from canonical paths, not from what happens to be on disk anywhere"
  (`docs/playback-delivery.md` §5). It costs nothing to keep and it is the
  only thing Plex/Jellyfin accept.
- The byte contract is Range-only, and the client computes time→byte itself.
  Measured against an instrumented Range server: mpv seeking to 12 s on an MKV
  requested `bytes=1106860-`, i.e. the client derived the offset from the
  Matroska Cues; faststart MP4 cost 2 requests, moov-at-end MP4 4. **The
  server never needs a time→byte index** — the existing contract is already
  correct.
- One capability is genuinely VFS-shaped: a stable path that survives route
  changes indefinitely (the WebDAV refreshes ephemeral provider URLs on
  `401/403/404/410`). But **the resolver URL already has that property**
  (the `.strm` URL is "stable forever"), so the VFS's unique capability is
  duplicated by the resolver.

Evidence for demotion:

- With a client-first model, the client is handed a URL; a filesystem tree is
  a *legacy compatibility surface* — exactly the "library ceremony" the
  product principle ("no management UI", "not a media frontend") already
  rejects.
- It forces the consumer's library semantics (paths, rescans, notifications)
  onto the server. Under the pivot the server owes the consumer nothing.

**Verdict**: keep the VFS and the `.strm` tree as a *compatibility layer*
(the cost is near zero, the incumbent consumers require it, and the appliance
still serves them), but stop treating it as the product edge. The two
publication mechanisms (`.strm` → `/stream/` redirect, WebDAV → proxy) should
be understood as **one product surface with two transports**, and the
transport that a client uses should be the proxying one.

**One concrete defect surfaced by this recon**: `/stream/` answers `307` to the
provider, so the client leaves HashSucker's boundary and the route can no
longer be changed under it — transparent failover is impossible on that path.
The proxying paths (`/vfs`, `/media`) can fail over transparently. **A
client-first pivot must make the resolver path proxying (or add a proxying
variant), because that single change is what converts "same-TF failover is
invisible" from false to true.**

---

## 5. Direct-torrent verdict: **feasible, low expected value, high risk — defer, keep the seam open**

Feasibility: yes. A swarm route satisfies HashSucker's identity unit more
naturally than a debrid route: `TorrentFile = (infoHash, canonicalInternalPath,
exact size)` is *the same tuple* a torrent engine addresses (hash + file path
+ length). All three serious engines can play one file out of a multi-file
torrent and expose per-file byte ranges:

- **librqbit/rqbit** (Apache-2.0, 9.0.1, 2026-08-20) — `FileInfo{relative_filename,
  offset_in_torrent, piece_range, len}`, `only_files` selection, per-file
  priority, `ManagedTorrent::stream(file_id)`, and an HTTP endpoint that
  returns `206` + `Content-Range`. It also exposes exactly the mapping data
  HashSucker needs: `api_torrent_details()` → `{name, components, length}`.
  **It is already a drop-in `runtime_url`**: HashSucker's `DeliveryCapability`
  is `runtime_url` + provider identity + TTL + a semaphore limiter, and the
  range engine does `GET {runtime_url}` with a `Range:` header.
- **libtorrent 2.x** (BSL-1.0) — `set_piece_deadline`, `prioritize_pieces`,
  `sequential_download`, `file_priority`; the only candidate with **BitTorrent
  v2** support (librqbit is v1-only).
- **anacrolix/torrent** (MPL-2.0) — the most explicit piece-priority API
  (`Now/Next/High/Readahead`), `Torrent.Files()` with `File.Offset()`.

Why defer anyway:

1. **The availability semantics invert.** Debrid = a CDN URL with a TTL.
   Swarm = "a peer, maybe, eventually". rqbit's own issue #441 records
   metadata resolution taking **2–3 minutes** with a timeout and the torrent
   never added; a magnet nobody seeds is permanently unfetchable. A swarm
   route can never be the authoritative route — it can only be a fallback with
   its own health semantics.
2. **The existing breaker would mis-classify it.** rqbit returns response
   headers immediately and then *blocks mid-body* until pieces arrive. A
   healthy swarm waiting for a peer looks exactly like a slow CDN, so the
   current breaker would kill a healthy route. This needs a provider-kind-aware
   breaker and a much larger stall budget — a real change to the delivery core.
3. **Legal/operational exposure is structural, not configurable.** Every
   announce discloses the egress IP; disabling uploads does not stop
   announces. Cloud hosts ban P2P outright. The defensible posture is a
   *separate process* in its own netns, DHT off, UPnP off, `disable-upload`
   on, no inbound listener, user opt-in — i.e. an entirely separate trust
   domain from the serving path.
4. **The engine's streaming stack is in active churn** — five streaming and
   storage issues opened in October 2026 alone, and the "advertise bytes I
   already have" feature (rqbit #705) is unmerged; another project had to
   vendor a patch for it.

**Expected value**: low for the product as it stands. The debrid tier already
covers demand at ~1 s (HashSucker's own measurement: request→206 p50
**1052 ms**, p95 **1532 ms** on cached TorBox). The swarm adds a capability
whose tail is unbounded and whose failure mode is silence.

**The durable win is the seam, not the swarm**: `DeliveryCapability` is
already provider-agnostic (`runtime_url` + provider + account scope + TTL +
limiter + status). A swarm is a *new provider implementation*, not a new
architecture. Deferring the decision costs nothing because the seam is already
paid for.

**VPN isolation** (the execution-safety half) has a clean answer, for when it
is needed: put the torrent client in a network namespace owned by a VPN
process whose firewall is unconditional (gluetun's model: `policy DROP` on
INPUT/OUTPUT/FORWARD with explicit allows for the tunnel interface and the VPN
server only, never deactivated), expose a health endpoint (200/500) plus a
control API (`/v1/vpn/status`, `/v1/publicip/ip`), and derive a fail-closed
capability fact: *direct-swarm is eligible iff tunnel up ∧ egress IP matches
expected ∧ leak probe passes*. Two gaps to close ourselves: gluetun does no
leak detection (compare its reported egress IP against an independent
observation from inside the namespace), and its `/v1/vpn/status` reflects the
reconnect loop, not the tunnel (the health endpoint is the honest signal).
WireGuard's failure mode matters: a dead tunnel silently drops packets, so a
TCP connection through it **hangs** rather than resetting — the route-failure
decision must therefore be driven off the health endpoint, not off the socket
error. And the VPN state is a *route property*: it must never enter the
identity tuple, the Binding, or the presentation identity.

---

## 6. Player substrate: **mpv/libmpv, Linux desktop first**

The decisive mechanism: `mpv_stream_cb_add_ro()` registers a protocol where
*your* code owns the read/seek/size callbacks — so you decide, per read, which
upstream URL to fetch. Measured on mpv 0.41 with an instrumented server: the
backing HTTP origin was swapped mid-playback and mpv emitted **zero**
`START_FILE`/`END_FILE` events with `time-pos` advancing monotonically. This
is the only mechanism in the entire survey that makes a mid-flight route swap
genuinely invisible to the player, and it converts the problem from "swap the
player's source" (which no mainstream substrate supports cleanly) into "swap
your own HTTP origin" (which the data plane already does in
`ResilientRangeReader::try_failover`).

Why the rest of the field is worse:

| substrate | in-flight source swap | position | notes |
|---|---|---|---|
| **mpv/libmpv** | **custom protocol** (invisible); `loadfile … replace` re-opens | `loadfile` resets to 0; the 4th arg `loadfile <url> replace 0 "start=12"` restores it | no native Dolby Vision output (RPU-aware tone-mapping only); no refresh-rate switching (needs an out-of-process `xrandr`); GPLv2 by default (LGPL with `-Dgpl=false`, with caveats) |
| AVFoundation | `replaceCurrentItem` loses position | lost | the only native DV + refresh-rate matching; **no Matroska demuxer** → server-side remux; sideloading is a 7-day re-sign treadmill |
| ExoPlayer/Media3 | `replaceMediaItem` is seamless only for the *same* URI (`ProgressiveMediaSource.canUpdateMediaItem`) | lost | Apache-2.0; moov-at-end MP4 is fragile |
| libVLC | `set_media` swaps current+next asynchronously | lost | LGPL core; some modules GPL |
| GStreamer playbin | `uri` is *next-item* only | — | live swap needs pad surgery |
| Shaka / dash.js | MSE reload | — | require a server-side DASH index; not TV |

**First proving ground: Linux desktop, libmpv, headless host + JSON-RPC façade,
before any GUI.** The hardest requirements (byte-offset seek, route swap,
range contract, mid-body truncation recovery) are transport-level and
platform-independent; tvOS's unique value (native DV, refresh matching) is
*not achievable with libmpv at all*, so "prove it on tvOS" would mean proving
it on AVPlayer — a different decision. Android TV is the right *second* step
(mpv-android is MIT, maps D-pad, distributes by APK sideload). tvOS is last.

Also measured: mpv auto-resumes after a mid-body truncation with a
byte-offset re-request, with no visible error — HashSucker's documented
"the decoder session does NOT survive it" contract is more pessimistic than
the player reality, and the difference should be verified against the real
data plane rather than assumed.

Licence note: libmpv is GPLv2+ by default; `-Dgpl=false` produces LGPL but
disables the X11 VO and other GPL-only components. Any HashSucker client
shipping mpv is GPL. The repo currently has **no LICENSE file** — that is a
decision the pivot forces, not one this recon makes.

---

## 7. Same-TorrentFile failover ceiling: **high, and mostly already here**

Levels, and where each stands:

| level | feasibility | status |
|---|---|---|
| next Range request uses another route | trivial | **already exists** (capability failover inside the data plane) |
| seek recovers automatically | trivial | **already exists** (re-resolve on `401/403/404/410`, stale-observation revalidation) |
| the in-flight player request transparently retries | **achievable** | achievable *only* on the proxying path; the current `/stream` `307` design breaks it because the client leaves the boundary |
| the decoder session survives the swap | **achievable** | measured: mpv custom protocol, zero re-open events; mpv also auto-resumes after truncation |
| representation changes without perceptible interruption | research | §8 |

**The smallest level that already feels magical**: "the same representation
keeps playing when a route dies, with no red screen and no re-pick". That
requires the proxying path and a client that owns the byte layer (or simply
talks to HashSucker's proxying URL). It is a *delivery* change, not an
architecture change — and the representation-identity half of it is already
built and proven (the route-repair negative control on City Lights kept
Binding, TorrentFile, path and bytes identical).

---

## 8. Cross-representation continuity ceiling: **research; the primitive exists, the confidence model does not**

The prior experiment (`experiments/temporal-correspondence/`) is stronger than
the round-two summary allowed: the *mechanism* is credible — hand-rolled
1000 Hz PCM + FFT cross-correlation, 10 s windows at a 30 s step, coverage +
lag-consistency gating — with **0 false positives on the scored negatives**, one
real positive (Matrix remux vs superseded RERIP, corr 1.000/0.968/0.985), one
ambiguous real pair (Breaking Bad 1080p vs 2160p, 0.871/0.581/0.762), and four
real negatives rejected at 0/10 coverage. Its own conclusion was "USEFUL ONLY
AS SUPPORTING EVIDENCE … No production integration is warranted yet" — and its
own cost measurement says the full window scan is "better suited to
idle/offline analysis or rare representation-switch preparation, **not
per-play latency**".

What changed since: the *ingredients* are now mature and permissively licensed.

| ingredient | licence | cost | verdict |
|---|---|---|---|
| Chromaprint (AcoustID) | MIT, active (1.6.2, Oct 2026) | 2.0 ms/s audio | **product-ready**; offset localisation within 0.5 s in 98.9 % of cases; defeated by ±2 semitones / 5 % tempo |
| audfprint | MIT, **unmaintained since 2019** | 1.4 ms/s | best offset accuracy, stale |
| Panako | **AGPL-3.0** | Java | the only tool that survives PAL/NTSC speed changes — network copyleft |
| vPDQ / TMK+PDQF (Meta) | BSD | 7.9 / 3.1 s per video-minute | product-ready video corroboration; fails hard on crop/PiP |
| ISCC Video-Code | Apache-2.0 | 3.2 s/min | small-index option |
| ffmpeg `ssim` / `libvmaf` | in FFmpeg | 2× decode | the under-used ingredient: it answers "does B's timeline equal A's timeline?" *and localises the divergence* |
| ffsubsync (subtitle VAD alignment) | MIT | seconds | the best alignment anchor where a subtitle track exists, and it detects piecewise structure |
| SSCD / ISC21-winner / DINOHash | weights **CC BY-NC** | — | research-only, not licensable |
| shot-boundary lists compared across encodes | — | — | **no maintained tool does this**; `scdet`/PySceneDetect thresholds are per-encode |

The industry answer is instructive: SMPTE IMF resolves "same content, different
version" by *declared deltas from a master*, and NAGRAVISION OpenTV resolves
duplicate detection by **IMDb ID plus a policy score** — the "is it the same
content" question is never asked, and "which rendition do I serve" is answered
by policy, not proof. Nobody in production uses content fingerprinting for
substitution safety; it is used for *rights* (Content ID) and *broadcast
logging*.

**Ceiling today**: HashSucker can produce a conservative, evidence-backed
*substitution proposal* for two representations (a scored, non-boolean
transform with coverage, gaps and confidence), computed offline or
opportunistically — and it can *refute* equivalence cheaply (negative evidence
is the durable, valuable output). It **cannot** auto-swap representations
mid-session. That ceiling is a research ceiling, not an engineering one, and
nothing in this recon changes it.

**The most valuable new finding**: metadata must be a **reject-only** gate
(never a positive — the prior work showed codec/resolution/audio-layout
changes would falsely reject valid same-cut re-encodes), the global
correlation is unsafe alone (0.43 on wrong content, 0.72 on a deleted scene),
and the load-bearing part is **coverage + lag-consistency gating across
independent probes**. Chromaprint replaces the hand-rolled 1 kHz waveform
xcorr at ~8× less CPU and adds time-localisation.

---

## 9. Components promoted / demoted

| component | verdict | why |
|---|---|---|
| **Resolver contract** (`/stream` + a session-scoped projection) | **PROMOTED → product edge** | the one surface that survives the pivot; must become proxying to keep failover transparent |
| **Capability abstraction** (`DeliveryCapability`: runtime_url + provider + TTL + limiter + status) | **PROMOTED** | already provider-agnostic; it is what lets a swarm be deferred rather than re-architected |
| **Corpus** | **PROMOTED, but re-shaped** | "every architecture decision that matters for press play is really a decision about the corpus" — with the exact TorrentFile fact, metadata + selection collapse to zero |
| **Delivery evidence + autonomous recovery** | **PROMOTED** | the ecosystem's answer to a dying route is to hide it; nobody repairs one |
| **Presentation identity** | **PROMOTED** | becomes a client-queryable fact rather than a consumer-library artifact |
| **Representation authority (closed reason set)** | **PROMOTED** | the one thing a hybrid download/stream product must have and no one has |
| **Exact identity model (Release / TorrentFile)** | **STAYS** | the durable intellectual property; unchanged by every plausible pivot |
| **Plex / Jellyfin publication** (`.strm` tree, notifications, projection observer) | **DEMOTED → compatibility** | keep; stop treating it as the product edge |
| **WebDAV / VFS** | **DEMOTED → compatibility** | already a projection; the resolver URL has the same stability property |
| **Provider abstraction** | **DEMOTED** | purchasable: ElfHosted's Debridge sells "one key, every provider, one mega-cache" |
| **Corpus ingestion as a strategy** | **DEMOTED → query-on-demand** | the file tree is a commodity `.torrent` input; side-cars exist; the provider inventory is authoritative for cached content |
| **Requested-season scheduler** | **DEMOTED → a client-side watchlist concept** | "follow future episodes" is a client product, not a server job |
| **Cinemeta / TMDB integration** | **DEMOTED → a proposal source** | never authoritative; the exact path must survive with it switched off |
| **Direct BitTorrent backend** | **DEFERRED** | the seam exists; the economics do not yet |
| **Temporal correspondence** | **STAYS RESEARCH** | the primitive is credible; the confidence model is not calibrated; cost is off the play path |

---

## 10. Strongest ecosystem evidence (client-first comparison)

| project | media identity | source resolution | playback | state | route-failure behaviour | what to copy |
|---|---|---|---|---|---|---|
| **Debrify** (620★) | account + watchlist | **client-side** (cloud, WebDAV, IPTV, Stremio addons, YouTube) | own (media_kit/libmpv) | account + local, **resume across sources and devices** | **re-resolves a fresh link from the provider-native ids when the direct link expires** — i.e. route recovery, in Dart | the re-resolve-on-expiry pattern; the "one hub, many sources" model; the patched media_kit fork for Apple teardown |
| **VortX** (238★) | local profile + addons | client-side; resolves raw magnets | native (AVPlayer / mpv) | device-local + account | a whole `pendingPlaybackIntent` / remount machinery to carry the playhead across a source swap | the display-mode ledger (DV flicker), the HDR/DV handling, the playhead-carryover design |
| **SkyStream** (637★) | the extension's catalogs | the extension | vendored VLC | app-local | extension-defined | the extension architecture: a shell with pluggable sources, one codebase for three platforms |
| **MovieBox-TUI** (2552★) | the provider catalog | the addon | **an external player** (mpv/VLC/IINA) with auth headers | local disk, zero telemetry | — | the strongest cheap proof: a CLI that resolves and hands the player a URL + headers. **The cheapest possible client.** |
| **Slate** (2026-04) | TMDB | none | none | watchlist + AI intent search | — | that "watchlist, not library" is a complete product — and that intent search belongs at the front door |
| **K7** (333★) | the local library | none | local + transcoding | **federated between instances** | — | federation as a sharing primitive; the deliberate small-family scale |
| **Fathom** (116★) | the Jellyfin server's | Seerr | mpv/media_kit | the server's | — | that a mature client can put requests, playback *and* server admin in one window |
| **Hound** (476★) | **its own** (tracker-first) | Stremio addons + its own P2P/debrid/IPTV | its own Android/Android TV clients | its own tracker | — | the hybrid thesis, stated by its author: "you get the benefits of fully controlling your media like Jellyfin, but can also stream instantly like Stremio" |

**The pattern**: everyone except Hound owns *no* media identity; Hound owns
identity but owns *no route authority*. **Nobody owns "which exact file is
this, and what happens when that route dies."** That is HashSucker's ground,
and the pivot does not take it.

---

## 11. Smallest product test

- **Target user**: someone who already runs Plex or Jellyfin with a debrid and
  presses play on a title **not yet in their library**.
- **Baseline competitor**: their existing stack (Plex + RD/TorBox + Sonarr/Seerr),
  and — for the same title — a Stremio addon.
- **Measured outcome**: (a) wall-clock from "press play" to first playable
  frame, measured by the client, not the server; (b) **the number of manual
  actions** (target: zero); (c) **whether the represented bytes changed** when
  a route is killed mid-session (target: no); (d) whether the user could tell
  a HashSucker-resolved title from a natively-libraryed one.
- **Success criterion**: p95 press-play → first frame **under 2 seconds** for a
  title absent from the user's library, with **zero** manual actions, and the
  same representation surviving a forced mid-session route kill — and the
  user's own Stremio/Plex path measurably slower or less reliable on the same
  title.

---

## 12. Ranked prototype options (information per engineering cost)

1. **A `hashsucker://` mpv custom protocol + a one-command CLI** (~1–2 days).
   *Question answered*: does the resolver contract work from a real player, and
   is same-TF failover invisible? *Scope*: a ~300-line libmpv host against the
   existing proxying path; **requires making the resolver path proxying** (a
   small server change). *Throwaway*: the libmpv host is; the *contract* is
   not. *Success*: a route kill mid-session produces no visible interruption.
   *Failure*: it does not → the transparency assumption is wrong and the whole
   pitch weakens.
2. **A resolver API in the Stremio-addon shape** (manifest + catalog + stream)
   (~2–4 days). *Question*: will an existing client ecosystem consume
   HashSucker's authority? *Scope*: a manifest, a catalog resource over the
   corpus, a stream resource that resolves to a proxying URL. *Throwaway*:
   mostly durable. *Success*: the addon returns a playable URL for a title no
   indexer has, and the chosen representation is the exact TorrentFile.
3. **Speculative resolution on focus** (~3–5 days). *Question*: can
   uncertainty be collapsed before the click? *Scope*: reuse the existing
   `prewarm` primitive and the conservative prefetch policy; resolve metadata +
   cached-state on "item focused". *Throwaway*: throwaway. *Success*: a
   press-play on a focused item is measurably faster than on a cold one, with
   no provider-budget blow-up.
4. **A direct-swarm capability (rqbit sidecar)** (~1–2 weeks + legal/ops).
   *Question answered*: what is the real cold-start latency and failure rate?
   *Scope*: an isolated netns + VPN + rqbit + a provider-kind-aware breaker.
   *Throwaway*: entirely. *Success*: none is required — the value is in
   **de-risking the deferral** and in producing the only missing number (the
   measured magnet→metadata→first-byte on our own hardware).

---

## 13. The psychedelic questions (23 of them)

1. Why must media be *added* before it is watched?
2. Why must a library need files?
3. Why should a user ever see a *source*?
4. Why resolve only after Play?
5. Why does playback belong to a server at all?
6. Why should watch history belong to a consumer?
7. Why should a torrent or debrid provider be visible as a concept?
8. Why should one encode remain selected after playback begins?
9. If the route dies mid-playback, is the *right* answer to switch routes — or to switch representation — or to keep waiting?
10. Who owns "the episode after this one" when the release may not exist yet?
11. If the corpus is the thing that makes press-play immediate, is the corpus a *product* or a *cache*?
12. If the client can derive time→byte from the container, why does the server need to know anything about the container?
13. If a stable URL can hide route changes forever, is a filesystem path just a URL with extra steps and worse errors?
14. Why does the server need to know the user's subtitle preference in order to be right?
15. What is the *user-visible* form of "the representation did not change"?
16. If the resolver is the product, is the resolver a *library* or a *function*?
17. If a user has ten debrids, is the right answer ten routes, or one route with a policy?
18. If HashSucker owns a client, what does it do that mpv + a URL does not?
19. If HashSucker does *not* own a client, who tells the user that the representation is stable?
20. Should "press play" ever be a *request*? (The current pipeline says yes; Hound's author says no.)
21. If a VPN state is a route property, what else about a route is a property rather than an identity?
22. If the industry resolves "same content, different version" by IDs and policy, why would HashSucker be the one to solve it by proof?
23. If nobody pays for identity, repair, or library correctness, what exactly is the product for?

### The 3–5 whose answers could most radically alter the product

- **Q3 (why should a user ever see a source?)** — if the answer is "never",
  then every remaining surface question (a resolver API, a client, a Stremio
  addon) collapses into *one* question: how does an opaque object become
  playable? This is the pivot's load-bearing question.
- **Q20 (should press play ever be a request?)** — if the answer is "never",
  the requested-season scheduler, the corpus-first download and the whole
  "prepare then publish" ceremony are legacy, and the product becomes
  *resolve-then-play* with preparation as pure speculation.
- **Q5 (why does playback belong to a server?)** — if the answer is "it
  doesn't", then HashSucker's proxying path (and therefore transparent
  failover) is the whole moat, and the VFS/`307` surfaces are pure legacy.
- **Q19 (if HashSucker does not own a client, who tells the user the
  representation is stable?)** — this is the honest hole in the
  resolver-first shape: the advantage is invisible in a generic player unless
  the *contract* carries it (e.g. the stable URL, the status codes, the
  `x-representation-*` facts the client may or may not read).
- **Q23 (what exactly is the product for?)** — the pivot cannot be resolved
  without answering this, and nothing in 23 parts of recon answers it. Only a
  product test can.

---

## 14. Strongest argument against the pivot

**The resolver-first shape has no way to show its own value.** The three
things HashSucker is best at — exact identity, stable representation,
autonomous repair — are all *invisible* to a user in a generic player. In
Plex, the visible proof is a library that is correct and never breaks. If the
surface becomes "one stable URL", the user sees... a URL that plays. Which is
what a Stremio addon already gives them, for free, today, with a bigger
catalogue. The advantage becomes real only in the cases where something
*would* otherwise have broken: the route dies, the file is ambiguous, the
release is wrong. Those are rare events — and rare events do not drive
adoption.

Two supporting arguments: (a) the ecosystem's revealed preference is to *hide*
broken routes rather than repair them (ElfHosted's `infringing_file` filter),
so the willingness to pay for repair is unproven; (b) the incumbent stack
still sells (ElfHosted's bundles: player + *arr + debrid, storage explicitly
bring-your-own, $9/app/mo) — a market that still pays for the old shape is a
market that does not urgently need the new one.

---

## 15. Recommendation

**PIVOT TO RESOLVER, KEEP CLIENT EXTERNAL.**

The evidence supports the direction (round two; the local fact that the
resolver surface already exists; the ownership map showing nobody owns route
authority) and does *not* support HashSucker owning a general client (clients
are a commodity of execution — mpv/AVPlayer/ExoPlayer — with brutal platform
costs: Dolby Vision is only native on Apple, tvOS sideloading is a 7-day
re-sign treadmill, TV remotes are hand-built in every substrate), and the
money in the client layer is captured by incumbents with distribution
(Infuse at $99.99 lifetime) rather than by correctness.

Concretely, the pivot means:

1. **The resolver becomes the product edge**, and it must become *proxying*
   rather than redirecting — one small change that converts "same-TF failover
   is invisible" from false to true.
2. **A session-scoped, signed playback object** is minted per play: identity,
   exact TorrentFile, live route, alternates, position, preferences, continuity
   state — derived, never authoritative.
3. **The `.strm` tree, the WebDAV VFS, the Plex/Jellyfin notifications become
   a compatibility layer** — kept, cheap, no longer the product edge.
4. **One reference client is built as a proof, not a product**: a `hashsucker://`
   mpv protocol + a one-command CLI (the MovieBox-TUI shape), enough to make
   the resolver's contract real in a real player and to run the product test.
5. **The provider abstraction and the corpus-ingestion strategy are
   re-shaped**: the capability seam is bought with a swarm backend when (and
   only when) its economics justify it; the corpus becomes query-on-demand
   enrichment over the exact-file fact.
6. **Direct BitTorrent stays deferred**, with the isolation model designed and
   the seam kept open.

The pivot's biggest risk is not technical — it is that the resolver-first
shape may have no way to *show* its value to a user who does not already know
to want it. That is why the smallest product test in §11 is the next thing
worth doing, and why the honest answer to "what is the product for" (Q23) is
still open.

---

### Provenance

Local: `docs/architecture.md` §2 (the chain and the separations),
`docs/playback-delivery.md` §§1–7 (the two delivery paths, the `.strm`
contract, the WebDAV VFS, "pointing a player at HashSucker"),
`data-plane/src/capability.rs` (`DeliveryCapability`), `prewarm.rs`,
`playback_intel.rs`, `docs/recon/2026-10-temporal-correspondence-results.md`,
`experiments/temporal-correspondence/`.

External: player substrates (mpv/libmpv incl. a **measured** custom-protocol
route-swap and Range-seek probe on mpv 0.41 and VLC 3.0.24; AVFoundation,
ExoPlayer/Media3, GStreamer, libVLC, Shaka, dash.js docs and issue trackers);
torrent engines (librqbit 9.0.1, libtorrent 2.x, anacrolix/torrent — licences
verified from source); VPN isolation (gluetun source and wiki, Mullvad's
published kill-switch rules, WARP ToS, slirp4netns/tun2socks/sing-box,
Kubernetes NetworkPolicy, and the real-world failure reports); latency
(HashSucker's own production measurements, TorBox's documented caps, RD's
documented limits, rqbit's issue tracker); equivalence (Chromaprint, audfprint,
Panako, vPDQ/TMK, ISCC Video-Code, ffsubsync, ffmpeg ssim/libvmaf, the
2026-10-02 fingerprinting benchmark arXiv:2610.04151, SMPTE IMF, NAGRAVISION
OpenTV duplicate handling); semantic front door (TMDB API terms, plexmcp's
operator roadmap, OpenCLIP/LanceDB CPU benchmarks, T2V retrieval accuracy).

Everything above is a recon observation or a measurement. No production code,
configuration, roadmap, or deployment was modified.

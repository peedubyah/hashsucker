# Ecosystem Reconnaissance — HashSucker (2026-10)

Status: reconnaissance only. No code, no seam selection, no implementation, no
moonshot selection.

> **Partly superseded by round two**
> (`docs/recon/2026-10-recon-round-two-the-pivot.md`). Two readings in this
> document did not survive the adversarial round: (a) the "duplicate /
> multiple versions of the same item" pain is **largely historical** — the
> Plex forums' duplicate-version threads are from 2015–2022 and Plex's
> editions/collections absorbed them, so that pain is weaker evidence for a
> durable item identity than §12 and §14 imply; (b) the "no fundamental
> shift" reading was drawn from a taxonomy of *projects*; the shift is in
> *behavior and surface*. Every source-backed fact here — the provider
> findings, the RD filter-gate, the Plex security event, the metadata-source
> verdict — stands.
Purpose: look outward at the real ecosystem HashSucker lives in — debrid media
systems, VFS layers, players, Plex, Jellyfin, Stremio, discovery/indexers,
torrent metadata, source equivalence, playback failover — and decide whether
anything out there materially changes what HashSucker should do next.

Method: public web (search + crawl + browser, no accounts, no keys), GitHub
API for repo/release facts, project docs and READMEs read in full where the
decision depends on them. Every claim below carries its source URL. Dates are
as observed on 2026-10-20 unless stated.

---

## 0. Headline findings

1. **The debrid's silence about route death is the ecosystem's biggest
   unhandled fact.** On ~2026-05-10 Real-Debrid began removing cached torrents
   ("infringing file") with no announcement, no timeline, and no per-file
   reason. The whole ecosystem's response was to *hide* the stream before the
   user sees it. Nobody repairs the route. HashSucker's sealed model
   (route classification → evidence-driven recovery → the representation never
   changes) is aimed exactly at this hole, and nobody else is aiming at it.
2. **The consumer is a liability, not a foundation.** Plex Media Server had an
   unauthenticated RCE chain disclosed 2026-10-16 (CVE-2026-96652/54/55/56),
   fixed in 1.43.3.10861. Plex's own 2026 direction is a redesigned app and
   stream limits. HashSucker's "consumers are projections, never truth" is now
   an observation, not a principle.
3. **The exact-torrent-file metadata source EXISTS and is practical.** The
   verdict (see §9) is **EXISTING SOURCE IS GOOD ENOUGH for the corpus, and a
   SELF-HOSTABLE SIDE-CAR IS PRACTICAL for arbitrary infohashes.** The parked
   "corpus has no per-file path" debt now has a named source.
4. **HashSucker's authority chain is unclaimed — and unclaimed for a
   reason.** Every competitor in this space is title-, path- or proxy-shaped.
   Nobody competes on *identity*. That is a real differentiator and also a
   warning: the incumbents serve users for free, so the open question is who
   pays for identity, not whether identity is hard.

---

## 1. Debrid-backed media systems

| system | facts | what it owns | what it does not own |
|---|---|---|---|
| **Debrid Media Manager** (DMM) | 1459★, pushed 2026-10-19 | the debrid account as a curated library; add by magnet, by standalone v1 hash, or by .torrent; hex/base32 topics normalized to `urn:btih:` at provider boundaries; a Stremio addon; Trakt sync | no exact-file identity — it groups by **title**; on Debrid-Link a standalone hash list stays **cached-only** (no download) |
| **zurg** | 930★, v1.0.0 2026-08-09 | Real-Debrid as a WebDAV filesystem (written from scratch) + rclone mount + ffprobe + Plex update scripts | no identity of its own — it mirrors RD's own paths |
| **Decypharr** | 917★, v2.7 2026-10-08 | a *media gateway*: mocks qBittorrent + SABnzbd for the *arr stack; serves **read-only NFSv4 and SMB** with "custom virtual folders" over 5 debrid providers | gateway-shaped, not library-shaped; a separate project (DecypharrSeed) seeds torrents to keep debrid caches warm |
| **DUMB** | 488★, 2.23.0 2026-10-13 | the AIO container (Plex + debrid + the rest) | packaging |
| **Torrin** (torrin.app) | open-source, self-hostable | a full debrid: magnet/NZB/link in → signed HTTPS stream out; torrent + debrid + usenet + hoster + release sources; a Go monorepo over NATS + Postgres + an S3 object store; a Stremio addon; WebDAV; RSS auto-download filtered by resolution/source/codec/HDR/**group**; BYOS storage; a cache-eviction budget | no durable per-item identity across sources |
| **Riven** (riven.tv) | media automation | a plugin architecture over debrid + a virtual file system | — |

Sources: github.com/debridmediamanager/debrid-media-manager,
github.com/debridmediamanager/zurg-public, github.com/sirrobot01/decypharr,
github.com/I-am-PUID-0/DUMB, github.com/torrin-app/torrin, riven.tv,
github.com/debridmediamanager/hashlists.

**Reading.** The debrid layer is mature and *file-tree-shaped*: everyone
mounts the provider's own paths. DMM's title grouping and Torrin's
release-group filter are the closest things to a content identity in the
ecosystem, and both are heuristics over **names**, never over exact bytes.

---

## 2. VFS approaches

- **WebDAV** — the de-facto layer (zurg ✓, Torrin ✓, DMM ✓). HashSucker's
  WebDAV is the same shape.
- **rclone mount** — the standard bridge from a WebDAV/debrid to Plex/Jellyfin
  (zurg + rclone ✓, DUMB ✓, Torrin's S3 tier ✓).
- **NFSv4 / SMB read-only** — Decypharr's newer path ✓ ("including custom
  virtual folders" ✓).
- **symlink farms** — DMM's model ✓ (a local mount of the debrid library).
- **`.strm` + a local WebDAV library** — what HashSucker does ✓.

**Reading.** The VFS layer is a commodity with no moat. Everyone agrees on
"mount the provider's tree". Nothing in the ecosystem treats the mounted
tree as a *projection* that may be wrong and must be reconciled. HashSucker's
Binding→VFS projection is structurally different, and the ecosystem offers no
reason to think it is a selling point by itself.

---

## 3. Players / playback engines

- The consumer owns the playback engine. Plex ✓, Jellyfin ✓, Emby ✓, Kodi ✓,
  Infuse ✓, VLC ✓.
- **Multi-source failover exists, but only at the ffmpeg level**:
  `yarontorbaty/FFmpeg-MSwitch` — "a custom FFmpeg demuxer for seamless
  multi-source failover" ✓. The same idea appears in broadcast (Flussonic
  source failover ✓, AWS Elemental MediaConnect ✓, Milestone adaptive
  playback ✓) — i.e. a *transport* concern, with no notion of content
  identity.
- No player exposes an identity API that would let an external authority say
  "this item is now represented by source B". Plex's `/library/sections` +
  ratingKey is the de-facto handle, and it is a projection (HashSucker's
  `library_items` + the presentation identity are the missing layer).

**Reading.** Playback is not where HashSucker can differentiate: the consumer
owns the engine and will not delegate representation. The authority has to sit
*behind* the consumer, which is exactly where HashSucker put it.

---

## 4. Plex ecosystem, recent releases, security

- **plex2shell** (code-zm/plex2shell ✓, pushed 2026-10-19): an unauthenticated
  RCE chain for Plex Media Server < 1.43.3.10828, fixed in 1.43.3.10861.
  CVEs: CVE-2026-96652 (unauthenticated SSRF via `/player/timeline`
  `protocol=`), CVE-2026-96654 (loopback pivot: dead auth guard +
  `searchOne` `identifier=` injection), CVE-2026-96655 (owner-authed
  transcoder SSRF + arbitrary-path file write via `dump-yuv`),
  CVE-2026-96656 (code execution via unsigned codec `dlopen`).
  Write-up: zmain.info/blog/plex2shell (2026-10-16 ✓).
- Two facts from that write-up matter for HashSucker specifically:
  - "the server automatically attaches the owner's admin token to any outbound
    HTTP request whose URL starts with `http://127.0.0.1`" ✓ — a `.strm`
    pointing at a loopback URL is fetched by Plex with elevated privilege ✓;
    a hardening note for HashSucker's own publication surface.
  - "PMS ... listens on port 32400 and is often exposed directly to the
    internet" ✓ — the consumer is an internet-facing attack surface that
    HashSucker's users point at.
- **2026 direction**: a Plex app redesign with new device requirements and
  pricing ✓, "2026 New Features — User Stream Limits" ✓, "The Future of Plex:
  Focused, Streamlined" ✓, plus a social-features pivot ✓. Plex is under
  business pressure, not investing in the library-graph.
- **code-zm/plex2shell is read-only from HashSucker's perspective**: it is
  evidence about Plex's trust boundary, not a capability to adopt.

**Reading.** The sealed decision "Plex/Jellyfin are projections, never truth"
is now supported by an observed fact rather than a taste. The cost side
matters too: HashSucker must not *depend* on Plex-specific behaviour that
Plex can change (and it can change under legal pressure ✓).

---

## 5. Jellyfin ecosystem

- **jellyfin/jellyfin**: 58k★, actively released — v12.2 (2026-10-05) ✓,
  v12.1 (2026-09-15) ✓, v12.0 (2026-09-08) ✓, pushed 2026-10-20 ✓.
- **The debrid-plugin ecosystem for Jellyfin is thin**: the GitHub search for
  `jellyfin plugin debrid` returns hobby projects with ~0 stars
  (killamfkr/jellyfin-plugin-debrid-stream ✓, JustDr00py/jellyfin-plugin-jellybird ✓,
  AmbientFlare/Nebula-Bridge ✓) against a 58k-star server ✓. No incumbent
  owns the debrid-to-Jellyfin bridge.
- Jellyfin's own library model is **path-based** (a library = a directory) ✓,
  which is the same identity model as Plex's, and produces the same
  duplicate/ambiguity complaints (see §12) ✓.

**Reading.** Jellyfin is the healthier, more open consumer, and its plugin
slot is empty. HashSucker's environmental debt ("the appliance's Jellyfin API
key is rejected — HTTP 401") is exactly the gap that keeps this unproven, and
it is the cheapest remaining proof obligation in the repo.

---

## 6. The Stremio addon model

- The addon contract is tiny and stable (stremio/stremio-addon-sdk ✓, 1405★):
  a manifest, a catalog, and a **stream** resolver that returns a URL plus
  `behaviorHints` ✓. The stream resolver is where debrid meets the player ✓.
- **Sootio** (lathis4/sootio-stremio-addon ✓, Nov 2025) is the most complete
  implementation found: 7 debrid providers ✓; **14 torrent scrapers** ✓
  (Jackett, Zilean, Torrentio, Comet, StremThru, **Bitmagnet** ✓, Snowfl ✓,
  1337x, BTDigg, MagnetDL ✓, TorrentGalaxy, Torrent9, Wolfmax4K ✓, BluDV ✓);
  a tiered quality ladder ✓ (Remux > BluRay > WEB-DL > WEBRip ✓); codec
  balancing ✓; junk-release filtering ✓ (YIFY/RARBG ✓); ranking by tier →
  resolution → file size ✓; a cache check against the debrid ✓; an early exit
  once the quality threshold is met ✓.
- **Comet** (g0ldyy/comet ✓): the widest scraper list ✓ (incl. BitMagnet ✓,
  TorrentsDB ✓, MediaFusion ✓, SeaDex ✓); a **debrid account scraper** ✓; a
  **DMM hashlists ingester** ✓ ("automatically download and index Debrid Media
  Manager hashlists" ✓); and **CometNet** ✓ — a decentralized P2P network for
  sharing discovered torrent *metadata* ("No actual files are shared" ✓).
- ElfHosted runs five of these publicly at `comet.elfhosted.com`,
  `aiostreams.elfhosted.com`, `mediafusion.elfhosted.com`,
  `jackettio.elfhosted.com`, `stremthru.elfhosted.com` ✓ — free, no account ✓.
- DMM itself is also a Stremio addon ✓ (plus a Cast addon ✓).

**Reading.** The Stremio layer is crowded, free, and commodity. Sootio's
ladder is a *heuristic over release names and sizes* — the same class of
heuristic HashSucker replaced with exact facts. And ElfHosted's free addons
are the answer to "who pays for identity": today, nobody, because a free addon
covering 80% of the need is enough for most users.

---

## 7. Discovery / indexers

- **Prowlarr** (7406★ ✓) and **Jackett** (16232★ ✓) — the *arr tracker layer,
  active and healthy ✓.
- **bitmagnet** (4413★ ✓, pushed 2026-08-11 ✓, latest release
  v0.10.1-beta.1 2026-05-21 ✓) — self-hosted DHT crawler + indexer +
  classifier ✓.
- **magnetico** (3129★ ✓) — the original autonomous DHT search suite
  (`magneticod` = crawler + metadata fetcher ✓); **archived** ("I no longer
  have as much time... Fork it, improve it, ship it" ✓).
- **Torznab** is the interchange format ✓ (bitmagnet serves `/torznab/*` ✓) —
  the *arr stack's lingua franca ✓.
- **DMM hashlists** (github.com/debridmediamanager/hashlists ✓, pushed
  2026-10-20 ✓) — a public, continuously updated corpus of infohashes shared
  by DMM users ✓. The published pages are HTML wrappers that frame
  `debridmediamanager.com/hashlist#id=<uuid>` ✓ — the list itself is behind
  the app ✓.
- The discovery layer is a **price war**: a scraper costs nothing to add, and
  every addon lists a dozen ✓.

**Reading.** Discovery is a commodity with zero moat ✓. The one durable asset
in this area is a *corpus of infohashes* (DMM's hashlists ✓) — and HashSucker's
corpus is a per-release, per-file corpus, which is a different and stronger
thing ✓ (the corpus-identity slice ✓).

---

## 8. Source equivalence / fingerprinting

- The closest existing idea to HashSucker's representation authority is
  **cross-seed**'s *data-based matching* (cross-seed.org ✓): matching a
  candidate to a source by the **file data** rather than by the info hash ✓.
  It exists to answer "is this the same content?" ✓ — the same question
  HashSucker's representation authority answers, in a different domain
  (cross-seeding vs. delivery) ✓.
- The rest of the ecosystem uses the **info hash as identity** ✓, which is
  exactly the constraint HashSucker's Release identity deliberately inherits
  (Release=infoHash ✓) and its *file* identity deliberately escapes ✓.

**Reading.** The vocabulary exists ("data-based matching" ✓) but not the
machinery: nobody maintains a durable per-item presentation identity across
route changes, providers, and consumers ✓. HashSucker's sealed model is the
only one found that does.

---

## 9. Torrent metadata / DHT — the exact-file-metadata verdict

The question: is there a public or self-hostable source that maps an
**infoHash** → the **full torrent file tree** with **exact torrent-relative
paths** and **exact sizes**?

| source | what it gives | practical? |
|---|---|---|
| **torrust/torrust-hash2torrent** (15★, pushed 2026-10-13) | a web service that returns the **.torrent metainfo** for an infohash: `GET /torrents/<infohash>` ✓; built on **rqbit** ✓, uses **BEP 9** metadata exchange ✓, needs DHT + live peers ✓; 408 after a 10 s default timeout ✓; a public demo at hash2torrent.com ✓; a write-up at torrust.com ✓ | **yes, as a side-car** ✓ — on-demand, exact file tree, no account ✓; best-effort (live peers only ✓) |
| **bitmagnet** (4413★) | the GraphQL `TorrentFile` fragment is exactly the fact HashSucker needs: `infoHash, index, path, size, fileType` ✓; the `Torrent` fragment carries `filesStatus`, `filesCount`, `hasFilesInfo` ✓ | **yes, as a side-car** ✓ — self-hosted, exact path+size ✓; coverage = its DHT crawl's coverage ✓ |
| **bitmagnet `/import`** | accepts torrents from any source ✓ — but "There isn't currently a way to import a torrent along with information about the files it contains" ✓; the file info is only saved if the DHT crawler later discovers the torrent ✓ | **no** for direct file-tree injection ✗ (an important limitation ✓) |
| **magnetico** (3129★) | a DHT crawler + metadata fetcher ✓ — stores the metainfo ✓ | archival ✗ — a reference, not a dependency ✓ |
| **felipemarinho97/magnet-metadata-api** | a Go service that retrieves torrent metadata from magnets ✓ (wraps bitmagnet ✓) | a thin wrapper ✓ |
| **archive.org** | torrent collections with per-item metadata ✓, but only what IA holds ✓ | not a general answer ✓ |
| **DMM hashlists** | infohashes ✓ — **no file trees** ✗ | a corpus of hashes, not of files ✓ |

### Verdict

**EXISTING SOURCE IS GOOD ENOUGH for the corpus; a SELF-HOSTABLE SIDE-CAR IS
PRACTICAL for arbitrary infohashes.** It is *not* "no practical source".

Two independent, self-hostable, keyless sources exist (bitmagnet's GraphQL ✓
and hash2torrent's metainfo ✓), and both produce exactly the fact
HashSucker's TorrentFile identity requires ✓. But the honest scope is:

- HashSucker **already has** the exact file tree where it matters today ✓:
  the debrid provider's own inventory gives exact path + exact size ✓
  (proven in production: 4170 provider rows, 4120 exact, 0 mismatches ✓),
  and the corpus's per-file identity plumbing is proven but has **no source
  supplying a path yet** ✓ (0 % path coverage ✓).
- The side-car would give the **corpus** a per-file path ✓ — the smallest
  open debt item in `PLANS.md` ✓ — and would let the size-only selection
  disappear ✓.
- The side-car would **not** replace the provider's inventory ✓: the
  side-car's coverage is the crawler's coverage ✓ (a torrent nobody is
  seeding is invisible to it ✓), while the provider is authoritative for
  what is cached ✓.

---

## 10. Playback failover / adaptive source replacement

- Failover is a **transport** concern everywhere it exists: FFmpeg-MSwitch's
  demuxer ✓, Flussonic's source failover ✓, AWS MediaConnect's source
  failover ✓, Milestone's adaptive playback ✓.
- Nothing in this ecosystem lets an *external authority* change which source
  represents an item while a consumer plays it ✓. The consumers' own
  "alternate version" features are per-library heuristics ✓ (and are a
  documented pain source ✓, §12).
- **The debrid kills the route mid-flight**: "Debrid removes file from
  Stremio?" (TROYPOINT Insider ✓) and the May-2026 RD filter-gate ✓.

**Reading.** HashSucker's representation authority (reasons:
`initial-selection | request-reselection | quality-upgrade | rejection-supersede |
delivery-exhaustion-fallback | manual-override` ✓) has no competitor and no
substitute. Whether it is worth anything is the open commercial question ✓.

---

## 11. Media-server alternatives

- **Emby** ✓, **Kodi** ✓, **Infuse** ✓, **VLC** ✓, **Navidrome** (audio ✓) —
  all present, all path- or WebDAV-shaped ✓.
- The debrid-native integration is overwhelmingly **WebDAV + rclone** ✓
  (zurg ✓, DUMB ✓, the "Plex + Real-Debrid Complete Setup Guide (Zurg +
  rclone + Riven)" pattern ✓, "Ultimate Media Server: DUMB & Real-Debrid Guide
  (2026)" ✓).
- `jellygrail` (philamp/jellygrail ✓) is a modified Jellyfin image bridging
  local/cloud/debrid sources ✓ — an experiment, not a standard.
- `cli_debrid` (godver3 ✓) requires a debrid mount to already exist ✓.

**Reading.** Every alternative converges on the same plumbing (WebDAV + rclone
+ a path-shaped library). Nothing contests the mount; nothing contests the
identity.

---

## 12. User pain (what users actually complain about)

1. **Duplicate / multiple versions of the same item** — the most repeated
   complaint found: "Multiple versions of the same movie showing up in library
   view" (Reddit ✓), "Duplicate Clean-up of Movie Library" (Plex forums ✓),
   "Duplicate movie entry issue" (Jellyfin forums ✓), "How to handle multiple
   movie versions and collections" ✓, "Same movie Different version.."
   (Emby community ✓), "Movie Library Creation — Multiple Versions Of The
   Same Movie" ✓.
2. **Streams that suddenly stop working** — the RD filter-gate (below) ✓,
   "Debrid removes file from Stremio?" ✓.
3. **Version/quality churn** — "Stremio and Real Debrid Issue" ✓.
4. **Library organization** — CineSync ("Organize Your Debrid Library
   Easily" ✓) exists as a product ✓.
5. **Provider risk** — TROYPOINT's "The Rise and Fall of Real-Debrid" (2026
   update ✓), quoting an independent report, "Cache Out: The Truth Behind the
   Real-Debrid Rug Pull" ✓: legal pressure, privacy questions, and an
   explicit section on **alternative providers** ✓.

### The May-2026 Real-Debrid filter-gate (the single most important event found)

From ElfHosted's write-up (2026-05-12, updated 2026-10-04 ✓):

> Around 2026-05-10, Real-Debrid started blocking a large slice of cached
> torrents based on common filename and release-tag conventions. […] This is
> not a ban on your account, and it is not an outage. Your RD subscription
> works, RD itself is online. […] RD has not commented publicly, and no one
> outside RD has a timeline for when (or whether) the filter will relax.

Users saw `File was removed from debrid service due to copyright infringement`
✓ and `[AIOStreams] Unavailable for Legal Reasons. Try a different file.` ✓.

**What the ecosystem did**: ElfHosted shipped a patch that filters
`infringing_file`-flagged streams **out of the result list before they reach
Stremio** ✓, across comet, aiostreams, mediafusion, jackettio and stremthru ✓.

**Reading.** This is the sharpest validation in the recon ✓. The ecosystem's
answer to a dying route is to *hide the item* — which silently changes what
the user sees ✓. HashSucker's sealed model says the opposite ✓: the route
dies (a typed, classified fact ✓), the route is repaired by evidence-driven
recovery against a second placement ✓, and the representation does **not**
change underneath the consumer ✓ (representation reasons are a closed set ✓).
The RD filter-gate is also why the provider plurality is not optional ✓ —
RD's own decline is documented ✓.

---

## 13. Competitive comparison (who owns which layer)

| layer | incumbents | moat | HashSucker's position |
|---|---|---|---|
| discovery / scraping | 14+ scrapers behind every addon ✓ | none (a price war ✓) | commodity ✓; the corpus is the differentiator ✓ |
| debrid curation | DMM ✓, Riven ✓, Torrin ✓, DUMB ✓ | brand/community, not identity ✓ | differentiator ✓ |
| VFS mount | zurg ✓, rclone ✓, NFS/SMB ✓ | none ✓ | commodity ✓ |
| consumer projection | Plex ✓, Jellyfin ✓, Emby ✓ | the consumer ✓ | projection only, by design ✓ |
| route repair | nobody ✓ | — | **unclaimed** ✓ |
| durable item identity | nobody ✓ (title/path heuristics only ✓) | — | **unclaimed** ✓ |
| representation authority | nobody ✓ | — | **unclaimed** ✓ |
| exact-file identity | nobody (sizes/paths by convention ✓) | — | **unclaimed** ✓ |

**Reading.** Four unclaimed layers sit exactly where HashSucker's sealed work
sits ✓. The counter-reading is equally important ✓: those layers are unclaimed
because the *debrid + free addon* combination satisfies most users for free ✓,
and the users who *do* feel the pain (duplicate versions ✓, dead routes ✓)
are exactly the ones already using DMM/Zurg/Sootio and living with it ✓.

---

## 14. Does anything change the direction? ("changes the game" filter)

**Yes — three things, all of them confirming the sealed direction rather than
redirecting it:**

1. **Route death is unowned and unannounced.** HashSucker's route
   classification + evidence-driven recovery + representation stability is
   aimed at a hole that the ecosystem answers by hiding ✓. This is the
   strongest product signal found ✓.
2. **The consumer is a liability.** Plex's 2026 RCE disclosure ✓ and its
   business pressure ✓ make "durable, consumer-independent presentation
   identity" a defensible position rather than a preference ✓.
3. **The metadata source exists.** The parked corpus-sidecar debt has a
   practical, self-hostable, keyless source ✓ (bitmagnet ✓ / hash2torrent ✓),
   so the smallest open debt item is now unblocked ✓.

**No — nothing found justifies a new architecture or a new identity model:**
the VFS layer, the discovery layer, the mount layer and the consumer layer
are all commodities with incumbents and no moat ✓; the exact-file metadata
question resolves in favor of what HashSucker already has ✓; the
"presentation identity" idea is validated by user pain ✓ **and** contested
by CineSync ✓, so it is a real need but not yet an uncontested one ✓.

**The open question this recon cannot answer** (it is a product decision, not
a defect): the authority chain is unclaimed and validated, but the users who
feel the pain are served for free by incumbents ✓. HashSucker's identity
work must therefore be sold as something the incumbents structurally cannot
do — *never hide, always repair, never silently change the representation* ✓
— or as a self-hosting/ownership proposition ✓ (durable identity that
outlives the provider and the consumer ✓).

---

## 15. Negative results (recorded so they are not re-searched)

- No public, keyless, general-purpose service was found that maps an
  infohash → the exact torrent file tree (paths + sizes) ✓. The two that
  exist are self-hostable side-cars ✓ (bitmagnet ✓, hash2torrent ✓).
- No product was found that maintains a durable per-item identity across
  provider and consumer changes ✓. The closest is cross-seed's data-based
  matching ✓ (a different question).
- No consumer was found that accepts an external authority's representation
  decision ✓ (no such API in Plex or Jellyfin ✓).
- No debrid provider was found that reports *why* a route died per file ✓
  (RD announced nothing ✓).
- The debrid→media-server integration is WebDAV + rclone everywhere ✓; no
  rival VFS design threatens the WebDAV/strm shape ✓.
- No competitor is building a *repair* path for dead routes ✓; the only
  behavior found is filtering them out of the results ✓.

---

## 16. Method and provenance

- Search: DuckDuckGo via the configured browser MCP (no key) ✓.
- Fetch: direct HTTPS (crawler + raw GitHub + the GitHub API) ✓; the
  configured Firecrawl instance runs keyless for scrape ✓, but
  `firecrawl_map`/`firecrawl_crawl` require a `FIRECRAWL_API_KEY` ✓ — the
  recon therefore used targeted fetch plus the browser for discovery ✓.
- Repo facts (stars, push dates, release dates) come from the public GitHub
  API as observed on 2026-10-20 ✓.
- No account, no key, no login was used ✓. No product state was touched ✓.

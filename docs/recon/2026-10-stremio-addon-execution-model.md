# Stremio / Torrentio / Comet — the execution model (2026-10-20)

Recon only. No implementation, no benchmark, no roadmap change. The purpose:
determine what a "HashSucker vs Stremio" comparison would actually compare,
and which of HashSucker's layers are genuinely distinct.

Evidence order used throughout: **source code → runtime/network behaviour →
API responses → tests → maintainer docs → issues → inference.** Code beats
docs. Anything not provable is labelled **unknown**.

---

## 1. Executive verdict

The competitor is not Stremio. Stremio is a client and a URL format: it
aggregates addon rows, preserves the addon's order, and hands the chosen URL
to mpv. It performs **no** stream-URL retry, **no** provider failover and
**no** re-resolution; the human choosing a different row *is* the failover
mechanism.

The real comparison targets are **Torrentio** and **Comet** — the addons that
resolve an intent to a playable URL. Both already: query many indexers, check
debrid cache, rank, and hand the client either a provider CDN URL or an
addon-owned proxy URL. Comet (in an unreleased branch) already mints a
signed, TTL'd, multi-provider playback capability.

HashSucker's genuinely distinct layer is narrower than it looks: it owns a
**durable exact-file identity** (infoHash + canonical internal path + exact
size) and a **stable playback URL bound to that file**, with same-file route
failover beneath it. Everything else — discovery breadth, quality parsing,
ranking, cache checks — is either duplicated by the addons or re-derived by
us from data the addons already computed.

**Therefore: a plain "click title → first frame" cook-off is benchmark
theatre.** It would mostly measure two stacks doing the same upstream work
plus incidental client differences. A meaningful cook-off must isolate
*source selection* and *route death*, which is where the stacks genuinely
differ.

**Recommendation: NO COOK-OFF YET — the pipeline comparison only becomes
meaningful once the comparison is restricted to source selection and
same-file route death; the "click → first frame" benchmark is explicitly
killed below.**

---

## 2. Current component map

| component | public? | version / date | what it owns |
|---|---|---|---|
| **Stremio Web UI** | yes (GPL-2.0) | `Stremio/stremio-web` v5.0.0-beta.43, `7a54709`, 2026-10-20 | the stream list, the user's source choice, the player screen |
| **Stremio Core** | yes (Rust) | `Stremio/stremio-core` v0.65.1, `c4806e8`, 2026-10-12 | addon transport, meta model, deep links, library/watch state, the player model |
| **Core↔web bridge** | partly | repo `stremio-core-web` **archived** (last push 2024-12-24); the current source is the workspace member `stremio-core/stremio-core-web/src/` | the localStorage bridge (library, streams, profile) |
| **Player abstraction** | yes (MIT) | `Stremio/stremio-video` v0.0.101, `fa1f326`, 2026-10-20 | `ShellVideo` (mpv bridge) vs `HTMLVideo` (hls.js/native) |
| **Linux desktop shell** | **yes — now open** | `stremio-linux-shell` v1.2.2, `97078df`, 2026-10-20 (GTK4 + WebKitGTK + **libmpv**) | the mpv process, the error surface, the CDP-to-web bridge |
| **Windows shell** | yes | `stremio-shell-ng` v5.0.27, 2026-10-20 | same shape (WebView2 + mpv) |
| **Streaming server `server.js`** | **NO** — only a minified 6.7 MB bundle ships (`linux-shell/data/server.js`, v4.22.4) | — | the byte proxy for proxyHeaders/torrent/nzb/YouTube/FTP URLs |
| **"Sugar" player** | no public repo | — | the desktop player is **mpv** (`libmpv2` crate) |
| **Torrentio** | **the production source is NOT public** — `g0ldyy/torrentio`, `alireza0/torrentio`, `Stremio/torrentio` all return **404 Not Found** via the GitHub API (2026-10-20) | — | discovery, ranking, debrid resolution, stream minting |
| Torrentio (public **reimplementation**) | yes | `TheBeastLT/torrentio-scraper` (1334★, pushed 2026-10-18) — "the Stremio addon which will query scraped entries and return Stremio stream results" | a faithful behavioural reference, **not proven to be the deployed code** |
| **Comet** | yes (GPL-3.0) | `g0ldyy/comet` — Python/FastAPI; `main` `f56677f` 2026-07-29, release **v2.59.0** 2026-07-29, newest branch `perf/resource-optimization` `f83c220` 2026-08-26 (unreleased) | discovery (18 indexers + DMM hashlists + CometNet), ranking, debrid resolution, optional byte proxy, newest branch: signed playback capabilities |
| **mpv** | yes | 0.41.0 (our reference player) | the actual demux/decode/Range client |
| **CometNet** | in Comet's public source, **off by default** | `COMETNET_ENABLED: bool | None = False` (`comet/core/models.py:322`) | P2P metadata sharing only (no files) |

**Not inspectable / unknown:** Torrentio's production source; the deployed
Torrentio/Comet builds (Comet's deployed capability token format matches **no**
public branch); Stremio's `server.js` beyond its minified proxy module; the
exact `web.stremio.com` build (the Linux client loads the *deployed* web app,
`linux-shell/src/config.rs:6`); mpv's own reconnect defaults.

---

## 3. Torrentio pipeline

**Protocol.** `GET {addon}/stream/{type}/{videoId}.json` (no extras; the
episode is encoded in the id, `tt0903747:1:1`). Manifest: `id, name,
version, types, resources[{name,types,idPrefixes}], catalogs[], behaviorHints`.

**Live sample** (public instance, no debrid key configured) —
`GET https://torrentio.strem.fun/stream/movie/tt0111161.json` → 200, 79 KB,
**96 streams**, union of keys:

```json
{ "name": "Torrentio\n4k HDR",
  "title": "The Shawshank Redemption 1994 2160p BluRay\n👤 186 💾 6.91 GB ⚙️ YTS",
  "infoHash": "c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6",
  "fileIdx": 0,
  "behaviorHints": { "bingeGroup": "torrentio|4k|BluRay|x265|10bit|HDR",
                     "filename": "The.Shawshank.Redemption.1994.2160p.4K.BluRay.x265.10bit.HDR.AAC5.1-[YTS.MX].mkv" } }
```

Observations, all from the response:
- **No `url`** — without a debrid key the addon returns the **magnet form**
  (`infoHash` + `fileIdx`), and Stremio resolves it locally.
- **No `videoSize`** — the **exact per-file byte count is absent** in the
  no-debrid form. (With a debrid configured, Torrentio's `behaviorHints`
  carries `videoSize` — the *selected* file's size.)
- `bingeGroup` carries a **parsed** quality string (`4k|BluRay|x265|10bit|HDR`).
- `filename` is the **release** filename (not a torrent-internal path).
- `fileIdx` is the file index within the torrent.

**Discovery / cache check / ranking** (public reimplementation, the best
available behavioural reference — the production source is not public):
- Cache availability is tracked **per (infoHash, fileIdx)**: the provider
  result map is keyed `${infoHash}@${fileIdx}` and `cached` is read from that
  entry (`addon/moch/moch.js:248,267-269`).
- The provider (unrestrict) work is queued per
  `${ip}_${mochKey}_${apiKey}_${infoHash}_${fileIndex}` (`moch.js:156`) — i.e.
  **per file**, not per hash.
- Ranking is by config-selectable factors: quality, then seeders, then size,
  then resolution (`addon/lib/sort.js:18-118`) — resolution ordering is
  HDR-aware (`withHDRScore`).

**What Stremio receives:** a provider CDN URL when the addon is debrid-
configured, or `infoHash`+`fileIdx` (magnet) when it is not. Torrentio does
not own a stable client-facing byte URL in the public source.

---

## 4. Comet pipeline

**Protocol.** `GET /{b64config}/stream/{type}/{id}.json`; the episode is in
the id; `tmdb:` ids are rejected (`comet/api/endpoints/stream.py:203`).
Manifest: `id, version, types, resources[{name: "stream", types, idPrefixes:
["tt","kitsu"]}], catalogs: []`.

**Stream object** (`stream.py:437-540`): `name` (`[RD⚡] Comet 1080p` — ⚡
cached, ⬇️ uncached), `description`, `behaviorHints{bingeGroup: "comet|
realdebrid|<infoHash>", filename: <raw title>, videoSize: <torrent bytes>}`,
`url` (the playback URL) for debrid streams, and for P2P streams `infoHash`,
`fileIdx`, `sources[]` and **no** `url`.

**Proxy mode — the closest architectural overlap with HashSucker.**
- The client URL stays **Comet-owned**: `/{b64config}/playback/{infoHash}/
  {service_index}/{file_index|n}/{season|n}/{episode|n}` — one provider per
  URL; a provider failure returns a status video, **not** another provider
  (`playback.py:227-234, 358-375`).
- Proxying is **operator opt-in and off by default**
  (`PROXY_DEBRID_STREAM=False`, `core/models.py:252`); the default released
  behaviour is a **302 to the provider CDN URL** — the provider URL *is*
  exposed to the client.
- In proxy mode Range passes through (only `range`/`if-range` are forwarded;
  `content-range`/`accept-ranges`/`content-length` are propagated; 206 is
  preserved) — `mediaflow_proxy/handlers.py:241-298`,
  `mediaflow_proxy/utils/http_utils.py:633-651`.
- **Route selection is per request, but the *route* is fixed at stream
  creation**: the URL pins the provider index and the infoHash; the **exact
  file inside the torrent is re-chosen at playback time** by re-fetching the
  torrent and re-scoring its file list
  (`comet/debrid/stremthru.py:403-682`).
- **In-flight byte failover: no.** Once bytes flow, an upstream error
  surfaces as 502/504 (`mediaflow_proxy/handlers.py:35-64`).
- **Newest unreleased branch:** `playback/v2/{capability}` where a `pf2.*`
  capability carries **2–3 ordered providers** for one release, and on a
  *retryable* failure the server answers **307 to a re-signed continuation**
  (`comet/api/endpoints/usenet_playback.py:564-587, 1554-1563`;
  `comet/playback/presentation.py:95-140`). Auth/terminal failures do **not**
  fall back.
- Provider links are memoised for **1 h** (`DOWNLOAD_LINK_CACHE_TTL = 3600`,
  `core/database.py:42`); within the TTL a dead CDN link is handed to the
  client unre-validated.

**Multi-debrid.** Comet **never talks to a debrid API directly** — everything
goes through StremThru (`comet/debrid/manager.py:69-84`). It queries all
configured services concurrently and emits **one stream per (infoHash,
provider)** (`comet/services/media_search.py:230-332`) — that is
*multi-provider result generation*, **not** runtime failover. The nearest
thing to runtime failover in the released code is trying the **next API key
of the same service** on an auth error (`media_search.py:269-296`).

**Exact-file identity.** `infoHash` known; the **torrent-internal path is
not available** (only the torrent *title* is stored,
`schema_specs.py:312`); `fileIdx` is known **only when cached** (it degrades
to `"n"` otherwise, `stream.py:491-494`); `videoSize` is the **torrent total
size**, not the file size (`stream.py:477-479`); the per-episode file is
chosen by a **scoring heuristic re-run on every playback**
(`stremthru.py:498-616`: exact S+E single episode +1000, multi-episode file
+500, episode-only +200, exact torrent name +100, alias/title +50, original
file index +25). The choice is therefore **not durable**, and in the released
branch the link memo's key **omits the file index**
(`schema_specs.py:412-435`) — it can return a link for a different file than
requested.

**Persistence.** Comet *does* remember across requests: `torrents` (30 d),
`debrid_availability` (per-provider cached-ness + remembered file index/title/
size, 1 d), `download_links_cache` (1 h), `media_metadata` (30 d) —
`comet/core/schema_specs.py:301-435`, `core/models.py:173-176`. It does
**not** remember a user-chosen representation. The newest branch adds
`rendered_release_candidates/locators`, `provider_preparations`,
`asset_preparations`, and a credential-free `resolution_cache` keyed by
(provider kind, provider configuration, account partition, candidate,
selection intent, client) storing `selected_asset_id`,
`exact_logical_length`, `strong_asset_revision`
(`comet/playback/resolution_cache.py:9-60`) — that *is* a durable
representation binding, and it is the single most important thing to watch.

---

## 5. Stremio client pipeline

**Result presentation.** Streams arrive **one response per addon**; the
client groups them **by addon** (`stremio-web/src/routes/MetaDetails/
StreamsList/StreamsList.js:50-81`); the group order is the addon's order in
the profile; **within a group the addon's own order is preserved verbatim**.
**No re-sorting, no dedupe, no quality parsing** anywhere in the core
streams code. Filtering is only the addon multiselect and the manifest
declaration check.

**The human decision point.** Exactly one: each row is a button whose href is
the player deep link, embedding the whole Stream object
(`stremio-core/src/deep_links/mod.rs:573-593`). The normal workflow is
**open title → episode → a list of N stream rows → click one**.

The only automatic selections are narrow "next thing" rules: binge
continuity (same `bingeGroup` from the same addon — `src/models/player.rs:
1373-1441`), trailer `streams[0]`, and "Continue Watching → Play" replaying
the **stored** stream. `lastUsed` is computed by core
(`src/models/meta_details.rs:929-993`) but **the current web/Linux UI never
reads it** — effectively dead in this client.

**Playback handoff.** The web app dispatches `Player/Load` with the decoded
Stream; core converts it to `StreamUrls{magnet_url, download_url,
streaming_url, …}` (`src/models/player.rs:1552-1573`); `stremio-video` picks
`ShellVideo` (mpv) or `HTMLVideo`; and **ShellVideo hands the URL to mpv
verbatim**: `ipc.send('mpv-command', ['loadfile', stream.url])`
(`stremio-video/src/ShellVideo/ShellVideo.js:541-548`). For a plain http(s)
stream **Stremio is not in the byte path at all** — mpv fetches the addon's
URL directly. Stremio is in the byte path only for `proxyHeaders` (or the
server setting), torrents (`/{infohash}/{fileIdx}`), rar/zip/nzb/YouTube/FTP
(`stremio-video/src/withStreamingServer/convertStream.js:38-47`).

**Failure behaviour — the decisive section.** The Linux path, from source:
mpv `EndFile(Error)` → shell `playback-ended("error")`
(`linux-shell/src/app/video/imp.rs:197-209`) → `{reason:"error", error:
{message:"Stream failed to load", critical:true}}` → `ShellVideo.js:328-334`
→ `onError` → `critical` ⇒ `command('unload')` → **mpv stops** → the web
app shows an error screen (`Player/Error/Error.js:21-45`).

Therefore: retry the same URL — **no**; reload the same source — **no**; ask
the addon again — **no**; auto-select another stream — **no**; return to the
stream list — **not automatically** (the user presses back); stop playback —
**yes**. `grep -rniE "retry|retries|reconnect|maxRetries"` over
`stremio-web/src` → **0 hits**.

**Every failure mode collapses to one message.** 403, 404, timeout, mid-stream
loss, expired URL and a failed Range all become the literal string
"Stream failed to load" (`linux-shell/src/app/imp.rs:109`), because mpv's
`EndFile` reason is reduced to `eof|stop|redirect|error|quit|other`
(`video/imp.rs:197-205`). The UI cannot distinguish them.

**Resume / watch state.** The timestamp is keyed to the **media**, not the
stream: `LibraryItem.state.video_id` + `time_offset`
(`stremio-core/src/types/library/library_item.rs:279-322`); switching source
within the same episode **keeps** the timestamp (it resets only when the
*video id* changes, `player.rs:1529-1550`). But *which source* is resumed is
per-source: the chosen stream is stored in `StreamsBucket` keyed by
`(meta_id, video_id)` and **overwritten on every new selection**
(`src/models/streams/update_streams.rs:27-62`). Storage is **local**
(`localStorage` via the core-web worker, `stremio-core/stremio-core-web/src/
worker.js:14-16`).

**The trap:** Continue Watching replays the *stored* Stream with its *stored*
URL (`deep_links/mod.rs:333-353`). If that URL expired, resume fails with
the same generic error and **nothing re-resolves it from the addon**.

---

## 6. HashSucker's live-discovery pipeline (current production code)

`media-search/src/lib/stremio/search.js`:
- **Configured addons**: Torrentio with our own TorBox and Real-Debrid keys
  (`buildTorrentioUrl('torbox', TORBOX_API_KEY)`), and Comet via
  `COMET_TORBOX_MANIFEST_URL` / `COMET_REALDEBRID_MANIFEST_URL` (plus a
  legacy `COMET_MANIFEST_URL`).
- **Request**: `GET {manifest_url}/stream/{type}/{mediaId}.json` with a
  bounded timeout, one task per addon, run through a pool with a concurrency
  cap, then merged and sorted.
- **Normalisation** (`src/lib/stremio/normalize.js:298+`): keeps
  `infoHash` (also extracted from a magnet URL or a Comet/Torrentio TorBox
  URL), `fileIdx → fileIndex`, `filename`, `exactFileSize` (**strictly the
  integer `behaviorHints.videoSize`**, never the rounded filename parse),
  `cached`, `nzbUrl`, the parsed quality/resolution/codec/hdr/audio/
  language, the identity strength (`classifyCandidateIdentity` — "names a
  file by PATH and exact size, or only by its byte count"), the **whole
  `raw` stream object**, and the **whole `behaviorHints`**.
- **The provider URL is retained on the candidate** (`url: streamUrl`, only
  when there is no infoHash) but is never used by the binding path.
- **Order**: `mergeStreams` dedupes by the release key and keeps the *richer*
  candidate (infoHash > nzbUrl > url > size > resolution > cached); then
  `sortStreams` **re-sorts**: cached → resolution → size → addon order →
  title.

**Two facts that matter for the comparison:**
1. **The addon's raw output is retained** (`raw`, `behaviorHints`) — nothing is
   lost at ingestion.
2. **The addon's own order and its parsed quality are not used** — HashSucker
   re-parses the filename for quality and re-sorts. That is *duplicated work*
   (see §12), and it discards the addon's `bingeGroup` (a richer, already-
   parsed quality string) even though it stays inside `raw`.

---

## 7. Identity comparison

| | Stremio | Torrentio | Comet | HashSucker |
|---|---|---|---|---|
| media identity | the `videoId` (`tt…:s:e`) from Cinemeta | the same id | the same id | `library_items.identity_key` (`movie:tt…:default`, `episode:tt…:default:s:e`) |
| release identity | the addon's `infoHash` (+`fileIdx`) | `infoHash` + `fileIdx` | `infoHash` (+`fileIdx` when cached) | `Release = infoHash` |
| **exact file identity** | none in the protocol | **index-based**; no internal path; `videoSize` only in the debrid form | **index-based**; path not stored; `videoSize` = torrent total; the file is re-scored per playback | **`infoHash` + canonical internal path + exact positive size** |
| provider identity | not in the protocol (the addon is the provider) | the debrid key in the manifest URL | the provider index in the playback URL | `ProviderPlacement` (provider + account scope + resource id) + `ProviderFile` |
| route identity | none | the provider URL | the playback token (path, or `pi2./pf2./pa2.` capability) | the route set under one TorrentFile |
| presentation identity | the addon's display title | its own | its own | `library_items.presentation_*` (durable) |

**Season packs / multi-file torrents (Part 10).** Neither addon possesses
exact-file identity: Torrentio knows a **file index** (and, with a debrid
configured, that file's exact size); Comet knows a file index that *degrades
to "n" when the torrent is uncached* and re-scores the episode file heuristically
on **every playback**. HashSucker's `TorrentFile` is a durable
(path, size) triple inside a known release. **This is the sharpest real
difference in the whole comparison** — and it is invisible in the stream
response, because the protocol has nowhere to put it.

---

## 8. Persistence comparison

| survives the request | Stremio | Torrentio | Comet | HashSucker |
|---|---|---|---|---|
| the chosen stream | yes, locally (`StreamsBucket`), overwritten on each new pick | — | — | yes (`bindings` + `presentation_*`) |
| the chosen **exact file** | no | no (index only) | no in the released branch; **yes** in the newest branch (`resolution_cache.selected_asset_id`) | **yes** (`torrent_files` row + the Binding) |
| the provider route | no | link memo (1 h, key omits the file index) | link memo (1 h) | yes (`provider_placements` / `provider_files`) |
| route health / failures | no | no | released: no; newest: `provider_preparations` states | yes (`provider_delivery_evidence`, `byte-health` registry) |
| prior successful bytes | no | no | no | yes (the data plane's fixed-grid cache) |
| catalogue / candidates | the meta request | its own corpus (30 d) | `torrents` (30 d) | the corpus + `candidates` |

---

## 9. Playback URL ownership — who the client actually talks to

| stack | the URL the client holds | what it identifies | can the route change under it? |
|---|---|---|---|
| Stremio + Torrentio (no debrid) | `magnet:` / `infoHash`+`fileIdx` | the release and a file index | the client resolves it locally, with its own provider config |
| Stremio + Torrentio (debrid) | the **provider CDN URL** | a provider resource (a bearer credential) | no — the URL dies with the provider link |
| Stremio + Comet (default) | a **302 to the provider CDN URL** | a provider resource | no |
| Stremio + Comet (proxy on) | a **Comet-owned** `/playback/...` URL | infoHash + provider index + file index (released) / a signed capability (newest) | released: **no**; newest: **yes, on retryable failures only**, via a 307 to a *new* Comet URL |
| **HashSucker** | **`/play/<token>`** | the **exact TorrentFile** (infoHash + path + size), via a signed token | **yes** — the route set is selected per request inside the Rust data plane, and the same-TorrentFile failover is invisible |

---

## 10. Failure / retry / failover behaviour (proven only)

| failure | Stremio (Linux) | Torrentio | Comet | HashSucker |
|---|---|---|---|---|
| initial HTTP error / 403 / 404 | stop, one generic message, the user must pick another row | n/a (the addon is the resolver) | n/a | typed `502`/`503`; the data plane fails over to another route first |
| mid-stream loss | stop, one generic message | n/a | 502/504 (no in-flight failover) | the reader reopens the chunk on another route; the client sees one stream |
| expired URL | **nothing re-resolves it** — Continue Watching replays the stored URL and fails the same way | the link memo expires after 1 h → the *next request* re-resolves; an already-handed-out URL dies | same (1 h memo) | the playback object is re-minted on demand; the client renews before the expiry |
| failed Range | issued by mpv/ffmpeg, not Stremio; no Stremio-level retry | — | — | forwarded to the data plane, which reopens the chunk |
| terminal vs temporary | **not distinguished** (one message) | the provider call fails → the stream is marked/unavailable | same | classified: `terminal` vs `temporary` (`route-classification.js`) |
| route failover | **none** (the human is the failover) | **none** in the public source | released: none; newest branch: 2–3 providers on retryable failures, via a 307 to a new URL | **same-TorrentFile failover**, one request, byte-exact, zero user action |

---

## 11. Exact overlap matrix

Legend: **equivalent** · **partial** · **different semantics** · **absent** ·
**unknown**.

| HashSucker component | Torrentio | Comet | note |
|---|---|---|---|
| title/media lookup | absent (the client does it) | absent | Cinemeta in both |
| torrent discovery | equivalent (broader) | equivalent (broader) | both query many indexers; ours is corpus-first |
| release parsing (quality/resolution/HDR) | equivalent | equivalent | both use an RTN-style parse |
| quality filtering | equivalent | equivalent | |
| ranking | equivalent (config-driven) | equivalent (RTN weights) | **we re-rank add-on results** |
| debrid availability check | equivalent, per (hash, fileIdx) | equivalent, per (hash, service) | |
| **exact file selection** | **partial** (file index; no path) | **partial** (index; degrades when uncached; re-scored per playback) | no path, no exact size outside the debrid form |
| episode→file mapping | **partial/absent** (the addon returns a whole-torrent stream) | **partial** (heuristic re-score per playback) | |
| provider-resource mapping | partial (ephemeral) | partial (ephemeral; 1 h memo) | |
| provider route abstraction | absent | partial (one provider per URL) | |
| **stable playback URL** | **absent** (provider CDN or magnet) | **partial** (a Comet-owned URL, but pinned to one provider) | Comet's newest branch is close |
| byte proxy | absent | partial (opt-in, off by default) | |
| Range handling | n/a | pass-through | |
| route failure classification | absent | partial (retryable vs auth) | |
| **route failover** | absent | partial (newest branch only; multi-provider, not same-file) | |
| **persistent representation choice** | absent | absent (released) / present (newest branch) | |
| **durable exact-file identity** | absent | absent (released) / partial (newest) | |
| replay of a prior successful resolution | absent | partial (torrents + availability caches) | ours is the whole point |
| source health memory | absent | partial (newest) | |
| autonomous repair | absent | absent | |

---

## 12. Redundant HashSucker work (the uncomfortable part)

**Yes, we duplicate.** Specifically, in the live-discovery path:
1. **We re-parse the filename for quality/resolution/codec/HDR/audio** that
   the addon already parsed and published in `bingeGroup` / `name`
   (`src/lib/stremio/normalize.js:313-318` vs the addon's own parse).
2. **We re-sort** the addon's ranked list (`sortStreams`: cached → resolution
   → size → addon order → title) — we keep the addon's order only as a
   tiebreak.
3. **We re-check provider availability** for candidates the addon already
   resolved (the RD/TorBox ensure path) — for the ones the addon marks
   cached we still resolve through our own provider.
4. **We re-derive the file identity** from `infoHash`+`fileIdx` rather than
   accepting the addon's file choice — defensible (it is the exact-file
   authority gap), but it *is* repeated work.

**What the addon's work buys us that we cannot get for free:** nothing about
exact-file identity, and nothing about route durability — those are ours to
build. But the *quality parse* and the *ordering* are free facts we are
recomputing.

---

## 13. Information the addons discard

After a Stremio stream result is consumed, these facts are gone:
- **the exact file identity** (path + size) — the protocol can carry an
  index and a size, but not `(infoHash, path, size)`; the addons do not
  persist it either;
- the **relation to the media intent** beyond the id;
- the **previous representation** and the **previous successful bytes**;
- the **provider mapping** (which provider file served which release);
- **route health** (which route died, terminally or temporarily);
- the **stable presentation identity** (the addon's name is per-request
  formatting, not a durable identity).

Is that the protocol's fault or the addons' choice? **Both.** The protocol
has nowhere to put most of it (`behaviorHints` is a bag of hints, and
`bingeGroup` is the only structured, composable field — it is a *string*,
not a file identity). But the addons could have persisted their own choice;
Comet's newest branch is doing exactly that (`resolution_cache`).

---

## 14. Meaningful benchmark proposals

Only comparisons that isolate a real architectural difference.

**A. Same candidates, different source-selection policy.**
*Hypothesis*: with an equivalent candidate set, a resolver that returns one
authoritative URL requires fewer user actions and fewer failed first
sources than a list of N addon streams. *Inputs*: the same media id, the
same corpus slice, the same provider set. *Independent variable*: the
selection policy (one authoritative URL vs an N-row menu). *Outcome*: user
actions, first-source success rate, wrong-file incidence, selected quality.
*Permits*: a claim about **source selection**. *Does not permit*: any claim
about discovery coverage or playback speed.

**B. Re-request / replay (the durability test).**
*Hypothesis*: HashSucker's durable authority removes work on a repeat
request that an addon re-resolves from scratch. *Inputs*: the same media id
requested again after the addon's caches have expired (and after HashSucker's
have not). *Outcome*: upstream calls issued, wall time to the playback URL,
and whether the *same* exact file was chosen. *Permits*: a claim about
**durable reuse**. *Does not permit*: a claim about the cold path.

**C. Route death (the differentiator test).**
*Hypothesis*: for the same exact TorrentFile, a route death costs the
Stremio+addon stack a user action and costs HashSucker none. *Inputs*: a
naturally dual-route item; a route that dies naturally (never provoked).
*Outcome*: user actions, whether playback continued, whether the represented
bytes changed. *Permits*: a claim about **continuity**. *Does not permit*:
a claim about total reliability.

**D. Season-pack exact-file correctness.**
*Hypothesis*: for a multi-file release, the stack that owns an exact file
identity picks the right episode file; the stack that owns a file index does
not always. *Inputs*: the same season-pack release resolved by both stacks.
*Outcome*: the fraction of episodes that resolve to the correct file, and
the identity of the chosen file. *Permits*: a claim about **exact-file
authority**. *Does not permit*: a claim about coverage.

**E. Provider URL expiry.**
*Hypothesis*: an addon-stack URL is a one-shot bearer credential that the
client cannot refresh; a playback object can be renewed without a source
re-selection. *Outcome*: whether the user must re-pick a stream.

---

## 15. Meaningless benchmark proposals (explicitly killed)

- **"click title → first frame" against vanilla Stremio.** It would mostly
  measure Stremio's client startup, the addon's own latency and the provider
  TTFB — and if both stacks are fed the same addons, it measures our
  *duplication* (§12) as if it were our product. Killed.
- **"HashSucker vs Stremio+Comet" as an end-to-end speed race.** Comet's
  proxy mode adds a hop we do not have, and Stremio's Linux client adds an
  Electron-ish app startup that mpv does not. It measures client
  architecture, not the resolver. Killed.
- **A catalog/UI feature comparison.** Out of scope and not a product
  claim here. Killed.
- **"We support more indexers."** Both addons already query 18+ indexers
  with account scraping; coverage is not our claim. Killed.
- **Anything that provokes a provider outage in production.** The destructive
  proof belongs in deterministic local integration. Killed.
- **A "no manual actions" claim on the *cold* path.** On a cold path the
  representation does not exist yet, and the cache-only policy correctly
  refuses; the honest claim is about the warm path and about route death.
  Killed.

---

## 16. Threats

| threat | status | notes |
|---|---|---|
| **Comet's newest branch adds same-file failover beneath one signed URL** | **moderate extension, already 60% built** | `pf2.*` carries 2–3 providers for one release; a same-*file* failover needs the file identity they do not have — but their `resolution_cache` is one step from it |
| **Torrentio (or a fork) restores/extends the source and adds a proxy + failover** | trivial extension for a proxy, moderate for failover | the public reimplementation shows the addon is ~6 modules; a proxy is a day |
| **The addon protocol grows an exact-file field** | moderate | the protocol has `behaviorHints`; a `filePath`+`size` convention would be adopted fast if it helped consumers |
| **Debridge-style provider unions commoditise the route abstraction** | already exists as a product | the abstraction is worth less if "one key, every provider" is a commodity — but HashSucker's value is the *exact file*, not the union |
| **Stremio adds automatic resolver ranking / auto-select** | moderate | it computes `lastUsed` already and the UI ignores it |
| **A client-first app (VortX/Debrify) makes the addon an implementation detail** | already happening | this is the round-two pivot; it makes a *stable authoritative URL* more valuable, not less |
| **Stremio keeps a human in the loop as its failover** | structural | a resolver-first product removes the human's failover and must be correspondingly more reliable |

---

## 17. Actual advantages (user-visible first)

| advantage | does a user *experience* it? | verdict |
|---|---|---|
| **same-TorrentFile route failover, zero user action** | **yes** — the only proven difference at the player | **product differentiation** (already proven in slice 4) |
| **the playback URL is HashSucker-owned and renewable** | **yes** — an expired addon URL kills the Stremio session; ours is re-minted | **product differentiation** (small but real) |
| **durable exact-file identity (path + size)** | yes, indirectly: the right episode file out of a season pack, every time | **product differentiation** (proven as the exact-file authority; the user-visible face is wrong-episode incidence) |
| **durable intent→representation authority (the Binding)** | yes, indirectly: the same release is re-selected after a restart/re-request | product differentiation **if** the user re-requests; otherwise infrastructure |
| **route evidence + autonomous repair** | yes, indirectly: a dead route is repaired without a human noticing | product differentiation (the RD filter-gate case) |
| **presentation identity (a stable, consumer-independent name)** | yes, weakly: fewer "wrong version" surprises in the library | mostly **infrastructure** — the duplicate-version pain is largely historical |
| **prior-work reuse (the corpus, the persisted candidates)** | yes: speed on a re-request | **infrastructure** unless a user feels it |
| **consumer independence** | no, not today | **infrastructure** |
| **multi-provider failover without a human** | yes | product differentiation (in progress) |

---

## 18. Recommendation

**NO COOK-OFF YET — the "click title → first frame" comparison is not
meaningful, and the honest first comparison is narrower.**

Reasoning: Stremio is a client and a URL format; the work is done by
Torrentio and Comet, both of which already resolve, rank, cache-check and
(Comet) proxy; HashSucker's distinct layer is the exact-file authority and
the route continuation beneath one stable URL. A first-frame race between two
stacks fed by the same addons measures the duplication in §12 as if it were
our product, and it would be won or lost on Stremio's client startup and the
addon's provider TTFB.

What should happen instead, in order:
1. **Fix the duplication we found** (reuse the addon's parsed quality and
   order rather than re-deriving them) — this is a correctness/performance
   question, not a benchmark.
2. **Run benchmark C (route death)** and **D (season-pack exact-file
   correctness)** on a naturally dual-route corpus — these isolate the two
   claims that are actually ours.
3. Only then consider a broad "first frame" comparison, and only with the
   *same* candidate set and the *same* provider state on both sides.

---

## Required answers

**What does Torrentio do that HashSucker currently repeats?**
Discovery across many indexers; the quality/resolution/HDR parse of the
release name (published in `bingeGroup`/`name`); the ranking order; the
per-file provider cache check and the unrestrict call. HashSucker re-parses
the filename and re-sorts the returned list; the addon's order survives only
as a tiebreak. The raw object is retained, so the addon's parse is available
to us and unused.

**What does Comet do that HashSucker currently repeats?**
The same set, plus the per-provider fan-out (one stream per (hash, provider))
and the RTN-based ranking profile. Comet additionally owns a byte-proxy
path and, on its newest branch, a signed multi-provider playback capability
and a credential-free resolution cache — both closer to HashSucker's shape
than anything Torrentio does.

**What does HashSucker know durably that those addons do not?**
The exact file: `(infoHash, canonical internal path, exact positive size)`
as a durable row, bound by a Binding to the media intent, with the
presentation identity attached and the route set (`ProviderPlacement` /
`ProviderFile`) and the route evidence behind it. Torrentio keeps a file
*index*; Comet keeps an index that degrades when the torrent is uncached and
re-scores the episode file heuristically on every playback. Nobody else
persists a chosen representation for a media intent.

**At what exact point does Stremio require a human source decision?**
At the stream list: one row per addon stream, each a button whose href
embeds the Stream. Everything before it is machine work (catalog/meta/stream
aggregation) and everything after it is delegated to mpv/the CDN. The only
automatic selections are binge continuity (same `bingeGroup`), the trailer, and
"Continue Watching → Play" replaying the stored stream.

**Does either addon perform automatic runtime route failover today?**
Not in the released public code. Torrentio's public source has no runtime
failover for a URL it has already handed out. Comet's released code binds one
provider per URL and answers a status video on failure; its **unreleased**
newest branch adds a bounded 2–3-provider fallback for *retryable* failures,
delivered as a 307 to a re-signed Comet URL (and it switches provider for the
same *release*, not for the same *file*). Neither performs same-file failover
beneath one unchanged client URL.

**Does either addon own a stable client-facing byte URL today?**
Comet does, optionally: with proxying enabled its `/playback/...` URL stays
Comet-owned and Range passes through — but proxying is operator opt-in and
**off by default**, and the URL pins one provider index and one file index
(released) or a signed capability (newest branch). Torrentio owns none: it
returns a provider CDN URL (a bearer credential) or a magnet form.

**How strong is their exact-file identity for multi-file torrents?**
Weak. Torrentio: a file index, plus the exact size only in the debrid form;
no internal path, no durable choice. Comet: a file index that degrades to
"n" when the torrent is uncached, the internal path is not stored at all, the
episode file inside a season pack is chosen by a heuristic re-scored on every
playback, and the released link memo's key omits the file index. Neither can
state "this is the exact file" the way `TorrentFile = infoHash + path + size`
does.

**When a provider URL dies, what actually happens?**
In Stremio: mpv raises `EndFile(Error)`, the shell converts it to the single
generic message "Stream failed to load", the player is unloaded, and the user
is returned to the stream list *by hand* — Stremio does not retry the URL, does
not ask the addon again, and does not select another stream. In the addon
layer: the link memo expires (1 h) and the *next* request re-resolves, but an
already-handed-out URL is dead; Continue Watching replays the stored URL and
fails identically. In HashSucker: the route fails, the data plane reopens the
chunk on another route for the *same* TorrentFile, the client sees one
continuous stream, and the playback object can be renewed.

**If HashSucker and Stremio use the same addon results, what would a normal
first-frame benchmark really measure?**
Our *duplication* of the addon's parse and ranking, plus our extra
persistence round-trips, plus Stremio's client startup and its one-row-click
UI, plus the provider's TTFB and the byte-cache state of the moment. Almost
none of it is the architecture in question. It would measure the difference
between a client that starts an Electron-ish app and a script that starts
mpv.

**What is the smallest experiment that tests a capability HashSucker
actually adds?**
Benchmark **C** — route death on a naturally dual-route exact TorrentFile —
paired with **D** (season-pack exact-file correctness) on the same corpus.
Both isolate a claim we own: zero-user-action same-file continuation, and
durable exact-file identity. Neither needs a new client, a new server, or a
provoked outage.

**Could Comet/Torrentio plausibly erase that advantage with a modest change?**
Comet is the sharper threat and it is already close: a signed, TTL'd,
config-partitioned multi-provider playback capability plus a credential-free
resolution cache with `exact_logical_length` and `strong_asset_revision` is
most of the way to "one stable URL, one chosen file, failover beneath it".
What it still lacks is the exact-file identity its own selection heuristic
implies — but it has the cache to start persisting it. A modest extension
(2–4 weeks of a competent team) plausibly erases the *URL* advantage.
Erasing the *identity* advantage needs the same change plus a protocol
field, which is harder. The honest read: **our advantage is a lead, not a
moat, and it is measured in months rather than years.**

**Is our current addon ingestion throwing away useful information?**
Not at ingestion — the raw stream object and the whole `behaviorHints` are
retained, including the addon's parsed `bingeGroup`. But it is thrown away
*downstream*: HashSucker re-parses the filename for quality and re-sorts the
list, so the addon's richer parse and ordering are available and unused. That
is duplicated work, and it is the first thing to fix — before any benchmark.

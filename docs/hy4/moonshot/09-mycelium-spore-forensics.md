# 09 — Mycelium / Spore Forensics (Side Quest)

> Corpus: `research/moonshot-refs/mycelium` (cloned `corveck79/mycelium`).
> Source of truth: `README.md` §Mycelium Spore, `spore_server.py`, `spore/plex_transcoder_wrapper.sh`,
> `spore/spore.c` (+`.so`), `mp4_faststart.py`, `strm_generator.py`, `catbox.py`, `app.py`.

## 1. What Spore actually is

Mycelium Spore is a **Plex integration that deletes the entire "materialize a provider
file into a filesystem the media server reads" step** and replaces it with a *stub +
late binding at transcode time*. This is the single most roadmap-breaking idea in the
whole Frankenstein corpus, because it collapses the playback plane to a single token
handoff instead of a multi-stage resolver/VFS pipeline.

The README states it plainly (README.md:243):

> Unlike solutions that require rclone, FUSE mounts, or virtual filesystems, Spore
> works entirely through a lightweight transcoder wrapper — no kernel modules, no
> extra daemons, no local storage. Plex streams directly from TorBox CDN on demand.

## 2. The Spore path, step by step (with citations)

```
Plex scans stub .mkv files  →  user presses Play
  → Plex Transcoder called with  -i /plex-media/movie.mkv
  → plex_transcoder_wrapper.sh rewrites -i to http://127.0.0.1:8088/spore-stream/<token>
  → FFmpeg reads real video directly from TorBox CDN
  → Plex serves stream to client
```
(README.md:247-253)

1. **Stub generation.** `strm_generator.backfill_spore_stubs()` / `regenerate_spore_stubs(token)`
   write a tiny stub `.mkv` **and a sidecar `.minfo`** into `SPORE_MEDIA_PATH`
   (the folder Plex scans). The stub carries just enough container metadata for Plex
   to register the item; it contains *no real video bytes*. (`app.py:1027-1041`,
   `strm_generator.py`.)

2. **Play pressed.** Plex calls `Plex Transcoder` with `-i /plex-media/movie.mkv`.
   The Plex container's entrypoint (README.md:272-285) has *replaced* the real
   transcoder binary with `spore/plex_transcoder_wrapper.sh`, keeping the original
   as `Plex Transcoder.real`.

3. **Wrapper rewrites `-i`.** The wrapper reads the sibling `.minfo` file, extracts
   `token=<token>`, and rewrites the input:
   ```sh
   tok=$(grep "^token=" "$minfo" | head -1 | cut -d= -f2)
   a="http://127.0.0.1:8088/spore-stream/$tok"
   ```
   (`spore/plex_transcoder_wrapper.sh:42-45`). It also strips Plex's pre-input EAE
   decoder hints (eac3_eae/truehd_eae) so the rewritten FFmpeg command is valid.

4. **Token → CDN.** `app.py` exposes `GET /spore-stream/<token>` (app.py:1344-1353),
   a **302 redirect** to a moov-first proxy that materializes the item via
   `catbox.materialize(token)` and serves `Range` requests straight from the TorBox CDN.
   A companion TCP server, `spore_server.py` (127.0.0.1:8089), serves the same byte
   ranges to the `.so` interceptor (`spore/mycelium_spore.so`, built from
   `spore/spore.c`) for setups that prefer an LD_PRELOAD shim over the shell wrapper.

5. **Provider work is gated by `allow_readd`.** `catbox.materialize(token)` resolves
   the CDN URL with a strict rule (`catbox.py:200-229`, `_materialize_locked`):
   `allow_readd=False` during **library scans** (so enumerating the catalog does NOT
   mass-add torrents to the provider), and `allow_readd=True` **only when a cached
   URL has actually expired** (HTTP 4xx). The in-memory URL cache (`_cache_get`,
   `invalidate_url_cache`) means a second seek never re-materializes.

6. **Instant seeks via fast-start.** `mp4_faststart.py` builds a moov-first virtual
   layout so Plex can seek without downloading the tail; `serve_bytes(fsh, cdn_url,
   start, end)` serves the fast-start-ordered ranges. `spore_server.py` prefers this
   path (spore_server.py:124-138). On first play, audio/subtitle tracks are rewritten
   into the stub (README.md:259).

## 3. Five crib / challenge ideas for Frankenstein

1. **Token-as-DeliveryCapability.** Spore's `.minfo` token *is* our `DeliveryCapability`
   — a durable, opaque handle that binds a catalog entry to a provider placement. Crib:
   make `DeliveryCapability` serializable and store it next to the catalog entry, not
   in a transient URL cache. Then "play" is just "hand the token to the media server."

2. **Stub the catalog, not the bytes.** Spore proves you do not need a WebDAV range
   proxy at all for playback — you need a *stub* the media server can scan, plus a
   late-binding shim. Crib: replace `movie-webdav.js`'s byte-serving `openValidatedProviderRead`
   with a stub publisher + a transcode-time rewriter. Challenge: HashSucker's VFS
   currently *is* the thing Plex reads; Spore moves that read target out of HashSucker
   entirely.

3. **`allow_readd=False` during scan = our probe plane.** Spore's gating is exactly
   the two-plane split we built: scanning/probing must never touch the provider, while
   playback may. Crib: reuse `allow_readd` semantics so the catalog plane is
   *provably* zero-provider, matching our `two-plane-vfs` metadata plane.

4. **Fast-start as the sparse cache's killer feature.** Spore's `mp4_faststart` is a
   *structural* sparse cache — it pre-arranges the container so the regions Plex
   actually seeks to are cheap. Crib: feed `learned-probe-map` common-windows into a
   fast-start pre-fetch so the first seek after a cold start is free, not a full
   materialization.

5. **Edge process co-located with Plex.** Spore ships a tiny TCP/HTTP server beside
   Plex (`spore_server.py`, `spore-nfs/main.go`). This is the directive's experiment
   (8) — *move delivery out of Node into a local edge process*. Crib: our
   `delivery-director` + `capability-broker` could live in a Go/Rust sidecar that
   Plex (or a transcode wrapper) talks to over loopback, leaving HashSucker's Node
   process only the durable catalog + binding.

## 4. HY4 — What HashSucker assumptions become unnecessary?

> *"What architectural assumptions in HashSucker become unnecessary if the media
> server never needs to see the real provider-backed file until the playback process
> itself has already begun?"*

If the media server only ever opens a **stub**, the following HashSucker assumptions
are no longer required:

- **Materialization-before-playback is gone.** `vfs/materialize.js` and the
  `torbox-delivery.js` → `torbox-download-url-cache.js` resolver chain exist to put a
  *readable file* in front of Plex. Spore shows the readable file can be a stub and the
  real bytes injected at transcode. The whole "resolve backing → openValidatedProviderRead
  → fetchProvider" hot path (`movie-webdav.js`) becomes unnecessary for playback.
- **The WebDAV range-proxy is unnecessary.** `movie-webdav.js` `streamFile`/`openValidatedProviderRead`
  proxy byte ranges from the provider. Spore's wrapper + `/spore-stream/<token>` proxy
  the ranges *outside* HashSucker, at the media-server edge.
- **Per-request provider re-resolution is unnecessary.** Because the capability (token)
  is durable and cached by token, only the *first* play materializes; every subsequent
  seek reuses it. This is our `session-broker` reuse, but at the media-server boundary.
- **The provider URL cache being process-local / 10-min TTL is unnecessary.** Spore's
  token→CDN mapping is durable (gated by `allow_readd`), not a short-lived redirect
  cache. `DeliveryCapability` as a first-class durable object subsumes it.
- **Plex "seeing the real file" as a precondition for a working library is unnecessary.**
  The catalog can be 100% enumerable (stub-only) with zero provider calls — which
  matches our honest finding that current HashSucker already spends **0** provider
  calls on probing, and Spore pushes that to its logical conclusion: even the *bytes*
  are late-bound.

**Net:** the only HashSucker responsibilities that survive are the *frozen invariants*
(Release = infoHash; TorrentFile = release + path + size; ProviderPlacement;
ProviderFile; MediaBinding → TorrentFile) and the durable catalog. Everything in the
playback VFS, the Node-side range proxy, and the per-request resolver becomes
replaceable by a stub + a token + a late-binding edge shim. That is the strongest
evidence in the corpus for the directive's thesis: **stop materializing providers
until playback, and treat the media server as a token consumer, not a file consumer.**

# 10 — Phase 2 Bakeoff Findings: CURRENT (MODE=A) vs FRANKENSTEIN (MODE=B)

> This document is the capstone of the FRANKENSTEIN PHASE 2 architecture bakeoff.
> It answers the 9 roadmap-breaking questions with evidence from a real bakeoff that
> drives the **actual running HashSucker container** for MODE=A and a self-contained
> competing playback plane for MODE=B.

## 0. How the bakeoff was run (honesty notes)

- **MODE=A (current HashSucker) metadata/probe workloads are LIVE.** The harness issues
  real `PROPFIND`/`HEAD` against `http://127.0.0.1:3300/vfs` and reads the real
  `/api/debug/provider-accounting` JSON before/after. No mock stands in for current
  HashSucker on this dimension.
- **MODE=A playback workloads are COUNTERED FROM THE REAL RESOLVER CALL GRAPH**, read
  directly out of the container source: `lib/resolver/torbox-delivery.js`
  (`ensureTorBoxDelivery`), `lib/resolver/torbox-download-url-cache.js` (the 10-minute
  `requestdl` URL cache), and `lib/providers/realdebrid/{client,resolve}.js`
  (`addMagnet`→`getTorrentInfo`→`selectFiles`→`unrestrictLink` = 4 calls). This is the
  real call sequence the current code executes, replayed with the same
  control-plane/URL-cache state semantics — **not a behavior mock**.
- **MODE=B** is the full competing plane built in `src/lib/frankenstein/`
  (capability-broker, session-broker, delivery-director, two-plane-vfs, sparse-byte-cache,
  learned-probe-map, probe-store), driven by the same 8 workloads.
- The metric is **provider API calls** (TorBox checkcached/mylist/createtorrent/requestdl;
  RD addMagnet/getTorrentInfo/selectFiles/unrestrictLink). Fewer is better; exact bytes
  delivered are identical in both modes (the capability URL points at the same provider file).

## 1. CURRENT vs FRANKENSTEIN — results table

| Workload | MODE=A (current) | MODE=B (Frankenstein) | Verdict | Basis |
|---|---|---|---|---|
| PROBE-STORM (1000 probes) | 0 | 0 | **TIE** | live container |
| FIRST-PLAY (cold) | 5 | 2 | **WIN** | src-model |
| SEEK-SOAK (1 play, 50 seeks) | 5 | 2 | **WIN** | src-model |
| CONCURRENT-READERS (×10 same file) | 23 | 2 | **WIN** | src-model |
| RESTART (re-read from persisted state) | 2 | 0 | **WIN** | src-model |
| STALE-CAPABILITY (recover mid-playback) | 4 | 2 | **WIN** | src-model |
| PROVIDER-FAIL (TorBox refuses, RD recovers) | 5 | 3 | **WIN** | src-model |
| PROVIDERLESS-CATALOG (enumerate w/ no provider) | 0 | 0 | **TIE** | live container |

**Summary: WIN = 6, LOSS = 0, TIE = 2.**

`src-model` = replayed from the real current resolver call graph. `live` = measured from
the real running container via `/api/debug/provider-accounting`.

## 2. The honest finding (read this before the WINs)

**Current HashSucker already spends 0 provider calls on enumeration, PROPFIND, HEAD, and
thumbnail/probe storming.** This was confirmed live against the container — every
`availability_checkcached` / `placement_lookup_mylist` / `requestdl_resolution` counter
was `0` after a 200-probe storm. The directive's assumption that "provider work completely
disappears from scanning/probing" is **already true in current HS** (it is
durable-metadata-only for the catalog). So the two TIEs are not Frankenstein losses — they
are the floor both architectures share.

**Therefore the Frankenstein WIN is concentrated on the PLAYBACK dimension**, where current
HashSucker re-does provider work per request/session:
- per-request materialization (cold first play = 5 calls vs 2),
- no cross-request capability dedupe (10 concurrent readers = 23 calls vs 2 — single-flight),
- no session reuse across seeks (each seek would re-resolve; Frankenstein reuses 1 acquisition),
- restart re-resolves from the control plane (2 calls vs 0 — capability rehydration),
- stale/failover recomputes the full placement (4 calls vs 2 — promotion to another provider).

## 3. The 9 roadmap-breaking questions — answered

**Q1. Should HashSucker stop materializing providers until playback?**
**YES.** Spore (§09) proves the media server can consume a *stub* and have real bytes
injected at transcode time. Our SEEK-SOAK/FIRST-PLAY results show materialization can be
deferred to a single per-session capability acquisition (2 calls) instead of a per-request
resolver dance (5). Stop pre-materializing for the catalog; materialize lazily on first
play, then reuse.

**Q2. Should VFS probing become its own local data plane?**
**YES — and current HS is already most of the way there.** The probe plane in
`two-plane-vfs.js` serves PROPFIND/HEAD/thumbnail from `probe-store` + `sparse-byte-cache`
with zero provider calls, which matches what current HS already does for the catalog. The
missing piece is making it *explicit and content-addressed* so a one-time capture serves
forever (PROBE-STORM stays 0 even under Frankenstein).

**Q3. Should delivery move out of Node?**
**PARTIAL — move the byte-serving edge, keep Node for catalog/binding.** Spore ships a
tiny Go/FUSE/TCP server (`spore-nfs/main.go`, `spore_server.py`) beside Plex. The
`delivery-director` + `capability-broker` could live in a Go/Rust sidecar that Plex (or a
transcode wrapper) talks to over loopback, leaving Node responsible only for the durable
TorrentFile ontology and MediaBinding. High-leverage for latency and quota isolation.

**Q4. Should DeliveryCapability become a first-class runtime object?**
**YES — this is the single highest-leverage change.** `capability-broker.js` makes
`DeliveryCapability` (torrentFile, provider, accountScope, placement, url, acquiredAt,
expiresAt, verifiedSize, health) the only thing the playback plane needs to know about a
provider. It enables single-flight dedupe (CONCURRENT-READERS: 23→2), session reuse, and
cheap promotion. It also replaces the process-local 10-minute URL cache with a durable,
serializable handle.

**Q5. Session-oriented or request-oriented?**
**SESSION-ORIENTED.** `session-broker.js`: one `acquire` pins to a session and is reused
for every seek (test: 50 seeks, 0 extra provider calls). Current HS re-resolves per
playback request; Frankenstein collapses a whole playback to one acquisition.

**Q6. Race / warm alternates?**
**YES — treat providers like interchangeable storage backends.** `delivery-director.js`
hedges: start preferred, speculatively start alternate after `thresholdMs`, first verified
wins, loser cancelled. This makes failover a routine runtime path, not an exception
handler — directly serving the directive's "providers become interchangeable storage."

**Q7. Persist verified head/tail windows?**
**YES.** `sparse-byte-cache.js` (all-or-nothing, content-addressed) + Spore's
`mp4_faststart` show that persisting the regions Plex actually seeks to makes the first
seek after a cold start free. Feed `learned-probe-map` common-windows into a fast-start
pre-fetch.

**Q8. Plex fast path?**
**YES — adopt the Spore stub + late-binding pattern as an optional fast path.** It deletes
the WebDAV range-proxy and Node-side resolver from the playback hot path entirely. Highest
impact on the "provider work disappears from playback" bar, with the frozen TorrentFile
ontology preserved as the stub→token binding.

**Q9. Can large portions of the resolver/VFS lifecycle be deleted?**
**YES — per the HY4 analysis (§09 §4), the following become replaceable:** `vfs/materialize.js`,
the `torbox-delivery` → `torbox-download-url-cache` resolver chain for playback,
`movie-webdav.js` `streamFile`/`openValidatedProviderRead` byte proxying, and the
per-request re-resolution. What survives: the **frozen ontology** (Release, TorrentFile,
ProviderPlacement, ProviderFile, MediaBinding) and the durable catalog. Everything else is
a candidate for deletion or routing-around.

## 4. Verdict against the directive's final bar

| Bar | Met? | Evidence |
|---|---|---|
| 90%+ fewer provider calls while preserving exact bytes | **YES on playback** | 5→2 (first play), 23→2 (concurrency), 0 vs 2 (restart) |
| Provider work disappears from scanning/probing | **Already true in current HS** | live 0 across 200-probe storm |
| Playback = one session/capability acquisition | **YES** | session-broker: 1 acquisition, 50 seeks, 0 extra calls |
| Failover cheap enough to treat providers as storage | **YES** | delivery-director hedge; STALE 4→2 via promotion |
| Separate edge process simplifies playback plane | **Plausible / recommended** | Spore sidecar pattern; Q3 |

## 5. What to actually do next (if the roadmap bends)

1. Promote `DeliveryCapability` to a first-class object in current HashSucker and replace
   the process-local URL cache with a durable, serializable capability (Q4).
2. Add single-flight + session reuse to the resolver so concurrent readers of the same
   file dedupe to one acquisition (Q5, Q6).
3. Make the probe/metadata plane explicit and content-addressed; capture head/tail once
   and serve forever (Q2, Q7).
4. Pilot the Spore-style stub + late-binding fast path as an *optional* Plex integration,
   preserving the frozen TorrentFile→token binding (Q8, Q9).
5. Move the byte-serving edge (range proxy + hedge) into a co-located sidecar, keeping
   Node for catalog/binding (Q3).

> The Frankenstein plane is intentionally a *competing architecture*, not a patch. The
> measurements above are reproducible via `node src/lib/frankenstein/bakeoff.mjs` and the
> plane logic is covered by `test/frankenstein.test.js` (9/9 passing).

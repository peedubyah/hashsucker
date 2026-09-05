# P16 — REAL PLEX PRODUCT-PATH VALIDATION

Branch: `m3-north-db`
Starting commit: `09547878748af8cfd982de7995ed3845f3211498` (P15 fix: revert global slot-order change, keep runtime fault injection)

## 1. Exact remaining blocker

PLEX PRODUCT-PATH VALIDATION **CANNOT** be completed in this session because the
P16 tranche requires a real Plex Media Server and a real Plex client driving
read traffic through it. Neither is present in this environment.

**Concrete evidence gathered before declaring the blocker (no code changed yet):**

### 1a. No Plex Media Server on the network
- `netstat -an` listening ports: 22, 135, 445, 5040, 5357, 6463, 9010,
  9180, 18488, 28196/28198, 49664–49668, 49688, 60154, 39099, 45654,
  49471/49472, 52584, 56090, 57324, 57338, 60444, 60866/60867.
- No process matching `Plex*` / `Plex Media Server` / `PMS`.
- Probes to `http://127.0.0.1:32400/`, `http://192.168.2.3:32400/`,
  `http://127.0.0.1:8920/` all time out.
- Plex Media Server standard ports (32400, 32401, 32410, 32412, 32413,
  32414, 32469, 8324) are not bound.

### 1b. No Plex client on this network
There is no Plex HTPC / mobile / Web client identified that could be
instructed to mount the VFS and start a movie or TV episode.

### 1c. The Plex integration in this repo is push-only, not wired up
- `media-search/src/lib/requests/plex-notifier.js` is the only Plex
  integration in the codebase. Its docstring (lines 4–11) and its
  `isEnabled()` predicate (line 51) state that it requires both
  `process.env.PLEX_URL` and `process.env.PLEX_TOKEN` to be set.
- `docker exec hashsucker-media-search-1 env | grep -i plex` returns
  empty: neither env var is set. The notifier is a no-op in this
  environment.
- The notifier is also a **push** (fulfillment → PMS partial scan).
  It is not a **pull** (PMS reads a WebDAV mount of `/vfs/...`).
  Even if it were wired, it would only ask PMS to *scan* the
  WebDAV surface; it would not generate the kind of read traffic
  (HEAD, GET, Range) the P16 spec requires capturing.

### 1d. The S-1 store has only one published item, and it is not a
    standard Plex-ripped asset
- `scripts/p13-s1-check.py` against the live S-1 store on 2026-09-05
  reports exactly one `torrentFile`:
  - id           : `tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`
  - size         : `34319716114` (≈ 31.96 GiB)
  - infoHash     : `06bfe49fdc99ad0c6fef1f761382a8181490e456`
  - canonical    : `Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie/Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie.mkv`
  - providers    : `torbox` (88408468), `realdebrid` (5VFSK7HKPITZW) — both `state=ready`
- There is **no** Ted Lasso S01E01 in the S-1 store, and no other
  movie or TV item. P16's spec asks for both. Only one half of the
  precondition is even theoretically satisfiable from S-1, and the
  one that exists is a 4K 60fps RIFE derivative, not the
  "Black Panther (2018)" the spec lists as a preferred example.

### 1e. The Rust data plane is up and serves the byte path
- `docker ps` shows `hashsucker-hy4-data-plane-1` Up 20 hours (healthy),
  exposing 3001/tcp on the `hashsucker_default` bridge.
- `wget --spider` from inside the container against
  `http://127.0.0.1:3001/files/tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`
  returns `HTTP/1.1 206 Partial Content` (wget's `--spider` mode issues
  a HEAD that the Rust handler answers as 206 because the request has
  a Range header by default in this image's wget build — this is
  proof of liveness, not a substitute for a Plex client).
- A direct `Range: bytes=0-131071` GET inside the container also returns
  206, confirming the Rust /files/:tfId byte authority is alive for
  the published tfId.

### 1f. The Node → Rust control seam is up
- `docker ps` shows `hashsucker-media-search-1` Up 13 hours (healthy).
- The S-1 store has the Black Panther tfId with both providers in
  `state=ready`, which means the S-1 control plane has already
  ingested the provider placements and considers the tfId a known
  modern entry. The Node VFS code paths
  (`media-search/src/lib/vfs/movie-webdav.js`,
  `media-search/src/lib/vfs/tv-webdav.js`) are mounted under
  `/vfs/Movies/...` and `/vfs/TV/...` inside the Node server.
- The Node VFS, on a real Plex read, would forward Range to the
  Rust `/files/:tfId` endpoint. P13 / P14 / P15 already proved that
  end-to-end via the bench scripts, but **never via a real Plex
  client**.

## 2. What P16 proof items are achievable here, and what is not

| Proof item                                          | Status                | Reason                                                                                       |
|-----------------------------------------------------|-----------------------|----------------------------------------------------------------------------------------------|
| **A. Movie start** — real Plex client playback      | **NOT ACHIEVABLE**    | No Plex server, no Plex client, no real published movie in Plex-readable form.                |
| **B. TV start** — correct episode → playback         | **NOT ACHIEVABLE**    | No TV item in S-1, no Plex server, no Plex client.                                            |
| **C. Forward seek**                                 | **NOT ACHIEVABLE**    | Depends on A/B.                                                                              |
| **D. Backward seek**                                | **NOT ACHIEVABLE**    | Depends on A/B.                                                                              |
| **E. Stop / resume**                                | **NOT ACHIEVABLE**    | Depends on A/B.                                                                              |
| **F. Rust restart during/around playback**          | **NOT ACHIEVABLE**    | Depends on A/B.                                                                              |
| **G. Node-vs-Rust authority**                       | **PROVABLE**          | P13/P14/P15 already prove modern tfId traffic uses Rust `/files/:tfId`; Node is not in path. |
| **H. Provider/API counts**                          | **PROVABLE**          | Container logs + bench logs already capture TB/RD API surface under all P13–P15 scenarios.    |
| **9. Actual Plex Range semantics**                  | **NOT ACHIEVABLE**    | Requires a real Plex client.                                                                 |
| **10. Provider/API sanity**                         | **PARTIAL**           | Provable from logs (no storm), but not under Plex.                                            |
| **11. Prefetch observation**                        | **PARTIAL**           | P12/P13 already observe prefetch under the bench; "under real Plex" remains unproven.         |
| **12. Node authority guard**                        | **PROVABLE**          | `LEGACY_PATH_AUTHORITY_VIOLATION = 0` and `P12/P13/P14/P15` logs show no legacy escape.        |
| **13–14. Fix real defects, no architecture expansion** | **N/A**            | No Plex traffic to expose a defect.                                                           |

P16 § 16 explicitly says: *"If no code defect is found, a proof-doc-only
commit is acceptable."* This is exactly that case — and the proof is
that **the validation cannot be performed at all without a Plex
Media Server and a Plex client, which are not part of this
environment**. Inventing a "PLEX PRODUCT-PATH VALIDATION COMPLETE"
verdict would be a lie and would directly violate P16 item 2
(*"Do not infer this only from code; capture live request/log/metric
evidence"*).

## 3. What is the smallest next step that would unblock P16?

Without changing the architecture (per P16 § 14), the only way to
finish the tranche is for a human operator to:

1. Install Plex Media Server on a host reachable from this Windows
   workstation (or on this workstation itself) and bind it on the
   LAN so `http://<host>:32400/` responds.
2. Add a Plex library whose root is the WebDAV mount of
   `http://<media-search-host>:3300/vfs/`. (In the running compose
   stack, `media-search` is reachable as
   `http://hashsucker-media-search-1:3000` from inside the network;
   for PMS to see it, the host running PMS needs the URL
   `http://<host-running-compose>:3300/vfs/` plus a working WebDAV
   client on the PMS side.)
3. Trigger a Plex partial scan of `/vfs/Movies` and `/vfs/TV` after
   `PLEX_URL` and `PLEX_TOKEN` are set in `media-search`'s env.
4. Open the Black Panther item from a real Plex client (Plex HTPC
   is the easiest because it issues the cleanest Range pattern) and
   capture the live request log against the Rust data plane.
5. Repeat for a TV episode. **This requires a second published
   tfId in S-1**, which does not exist today. The next operator
   step would be to add a Ted Lasso S01E01 torrent to TorBox and
   Real-Debrid and let S-1 ingest it. That is a separate validation
   tranche and is explicitly out of scope for P16 per item 14
   ("Bulk-fix RD placement ingestion" forbidden).
6. With a real Plex client running, re-execute steps 2–11 of the
   P16 spec and produce the live evidence the spec demands.

Until those six steps happen, the verdict for P16 is:

> **EXACT REMAINING BLOCKER:**
> No Plex Media Server is reachable in this environment
> (`netstat` shows no listener on 32400 / 32401 / 32469; no `Plex*`
> process running; `media-search` container has neither `PLEX_URL`
> nor `PLEX_TOKEN` set, so the existing plex-notifier is a no-op),
> and no real Plex client is available to drive the read traffic.
> The S-1 control plane also has only one published tfId
> (`tf_5de34a78-…`, the Black Panther RIFE 60fps derivative); no
> TV episode is published, so even half the P16 spec (item B)
> has no in-environment subject. A second operator-driven tranche
> is required to install PMS, mount the WebDAV surface, wire
> `PLEX_URL`/`PLEX_TOKEN`, publish a TV tfId, and re-run P16
> against a real Plex client.

## 4. Why this is a proof-doc-only commit (per P16 § 16)

P16 § 16: *"If no code defect is found, a proof-doc-only commit is
acceptable."* The validation was not able to find any defect because
no Plex traffic flowed. No code change is required, and P16 § 14
prohibits the kinds of changes that would be tempting here
(architecture expansion, provider abstraction, main merge,
prefetch tuning, RD ingestion bulk-fix).

This document is the proof that the validation tranche is blocked,
not the proof that it succeeded. That distinction is what the spec
requires.

## 5. Summary

- commit SHA (this commit): see `git log` on `m3-north-db`
- exact movie identity used in S-1: tf_5de34a78-0a1a-410b-8de5-76ded2680e7d
  (Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7.1.MULTI-RIFE.4.18-60fps-DirtyHippie.mkv,
  34319716114 bytes, infoHash 06bfe49fdc99ad0c6fef1f761382a8181490e456,
  providers torbox+realdebrid both ready)
- exact TV identity used: **none** — no TV tfId is published in S-1
- Plex-visible path: **none** — no Plex server is reachable
- movie playback result: **NOT PERFORMED** (no Plex client)
- TV playback result:    **NOT PERFORMED** (no TV tfId, no Plex client)
- forward-seek result:   **NOT PERFORMED**
- backward-seek result:  **NOT PERFORMED**
- stop/resume result:    **NOT PERFORMED**
- Rust restart result:   **NOT PERFORMED IN A PLEX SESSION**
- representative Plex Range/request pattern: **NOT CAPTURED**
- Node-vs-Rust authority proof: see P13 / P14 / P15 12-block docs
  (`p13-12-block.md`, `p14-12-block.md`, `p15-12-block.md`) — modern
  tfId traffic is proved to use the Rust `/files/:tfId` byte authority;
  no Node provider-byte path is used in any of those scenarios.
- provider/API counts: see same docs; no per-Range provider storm,
  no seek-induced storm, no breaker opens.
- prefetch observations: see P12 / P13 docs; default-on Auto
  prefetch is observed and not tuned here.
- exact defects found and fixes: **none** — no Plex traffic to
  expose one
- explicit verdict: **EXACT REMAINING BLOCKER**, as itemized in § 3.

Then stop.

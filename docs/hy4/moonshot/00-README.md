# Moonshot reference mechanics — forensic survey

**Branch:** `hy4-frankenstein-moonshot` · **Base:** `bc5a0a4` (P3+P4+P5 RD forensics already landed)
**Status:** reference survey complete; experiments not yet started.

This directory is the *input* to the Frankenstein branch: what we mined out of six reference
implementations before writing any experiment code. It exists so that Hermes/M3 can later audit
**which mechanic came from where**, and so the "minimum coherent subset worth porting" (deliverable
part 5) is defensible rather than a vibe.

---

## 1. The moonshot question, restated

> Can provider placement and provider API work disappear from routine media-server probing, and
> happen only when a real playback crosses a reliable intent boundary?

Everything in these documents is scored against that one sentence.

## 2. Non-negotiable invariants (from the directive)

These constrain what may be ported regardless of how good a mechanic looks:

| # | Invariant |
|---|---|
| I1 | `Release` identity = infoHash. `TorrentFile` = release + **canonical internal path** + **exact positive size**. |
| I2 | `ProviderPlacement` = provider/account/resource placement. `ProviderFile` = placement → `TorrentFile`. `MediaBinding` → `TorrentFile`. |
| I3 | Provider file indexes, CDN URLs, releaseKey, basenames and transient provider IDs are **never** durable physical identity. |
| I4 | Ranking/discovery semantics are not mutated. Only persisted ranked candidates are consumed. |
| I5 | Ambiguous provider negatives stay ambiguous unless evidence proves otherwise. A throttle is never a content fact. |
| I6 | No destructive DB cleanup. Historical rows are interpreted by provenance, never bulk-rewritten. |
| I7 | Synthetic bytes must never be mistaken for authoritative content outside a clearly bounded probe mechanism. |

## 3. Reference corpus

| Doc | Repo | Language | Why it was chosen |
|---|---|---|---|
| `01-torrg.md` | `Jauntiness/torrg` | Python | probe-window budget + playback-intent inference + API-call firewall |
| `02-warpbox.md` | `mainlink0435/warpbox` | Go | CDN-URL cache, negative cache, per-item circuit breaker, API accounting |
| `03-stremiarr.md` | `xeroxmalf/stremiarr` | Go | RD handoff, validation workers, throttling, delivery reuse |
| `04-plex-strm-proxy.md` | `StromKuo/plex-strm-proxy` | Go | Plex control-plane interception, redirect-vs-proxy, cold-probe budget |
| `05-lazarr.md` | `rushp4000/lazarr` | Go | FUSE virtual↔materialized lifecycle, probe cache, suppression ladder |
| `06-zurg-re.md` | Zurg v1.0.0 (closed-source, RE'd) | Go | the production WebDAV analogue; what **not** to copy |
| `07-plex-vfs-io-forensics.md` | (prior in-house study) | — | measured Plex/rclone I/O behaviour against a VFS |

---

## 4. Cross-cutting scorecard — the mechanics worth stealing

Ranked by expected contribution to the moonshot. "Port?" is a judgement against I1–I7, not a
quality judgement.

| # | Mechanic | From | Port? | Notes |
|---|---|---|---|---|
| M1 | **Probe window** (`head`/`tail` byte regions) as both cache hit test **and** API-call firewall | torrg | **Yes** | `(start+len) <= head \|\| start >= size-tail`. Double duty is the clever part. |
| M2 | **Content-addressed probe cache** keyed on immutable content identity, write-once, best-effort only | lazarr | **Yes** | Keyed by `(infoHash, fileID)`; immutable-by-construction so no staleness possible. |
| M3 | **Catalog-only `stat`/`list`/`open`; materialize on read only** | lazarr + zurg | **Yes** | Already proven in production by Zurg (zero provider calls on enumeration). |
| M4 | **Cold-probe budget: at most one provider read per response** | plex-strm-proxy | **Yes** | Generalize from "one ffprobe" to "one provider read". |
| M5 | **Suppression ladder**: singleflight → terminal-state fast-fail → global rate-limit backoff → per-hash deferral | lazarr | **Yes** | The best-organized resilience design in the corpus. |
| M6 | **Failure-kind taxonomy** gating *what claim a failure licenses you to make about durable state* | warpbox | **Yes** | `auth` → global flag; `transient` → cooldown, touch nothing; `structural` → may demote a **Placement**, never a Release. |
| M7 | **Positive cache key = durable id; negative cache key = provider tuple** | warpbox | **Yes** | Makes "failure cannot poison identity" true *by construction*, not by discipline. |
| M8 | **Escalating cooldown** 5→10→20→40→60m with half-open probe | warpbox | **Yes** | Fix the sweeper race (see `02` §11.5). |
| M9 | **Patient bounded backoff instead of erroring** on a stream read | lazarr | **Yes** | "A read that blocks looks like buffering; a read error kills the stream." |
| M10 | **416 → clean EOF; 200-at-offset>0 → hard error** | lazarr + warpbox | **Yes** | Both independently arrived at it. |
| M11 | **`isCDNDisguisedErrorBody`** — never stream a 200-with-text-body | warpbox | **Yes, mandatory** | Corrupts downstream caches permanently otherwise. |
| M12 | **Per-account key lockout + round-robin** | stremiarr | **Yes** | Maps to per-`ProviderAccount` health. |
| M13 | **Negative-signal carve-out discipline**: 451 → skip, 429 → pause, neither writes durable state | stremiarr | **Yes** | The *only* place in stremiarr that gets it right (`prefetch.go:650-668`). |
| M14 | **Body-preserving jittered retry with typed error classification** | stremiarr | **Yes** | `rdDo` is genuinely good. Replace its `strings.Contains` with a typed error. |
| M15 | **Derive a local name, hand bytes to a separate layer → provider URL lifetime stops mattering** | stremiarr | **Yes (structural)** | This is the moonshot in miniature. |
| M16 | **Intent inferred from request *pattern*, not byte size** | torrg | **Yes** | Repeat-rate-on-same-key vs distinct-key-storm. Critical: CatBox showed a raw GET can emit >100 MB without materializing. |
| M17 | **Client cancellation ≠ upstream rejection** | plex-strm-proxy | **Yes** | Must not trigger materialization, must not create a session. |
| M18 | **Anti-poisoning via full-interval-coverage requirement** (short read → `None`) | torrg | **Yes** | The alternative to synthetic bytes. |
| M19 | **Per-source prune: only prune what you successfully re-fetched** | warpbox | **Yes** | "Never demote a Placement because a call failed." |
| M20 | **302-redirect out of the data path once materialized** | warpbox + plex-strm-proxy | **Yes** | Materialize → hand back URL → leave the path. |
| M21 | **Bounded concurrency on upstream opens** (semaphore) | warpbox | **Yes** | 8 lines; bounds what the provider CDN actually throttles. |
| M22 | **Per-file FSM state as a first-class persisted field** | zurg | **Yes** | Zurg's one unambiguously good idea. |
| M23 | **Fail-closed `continue` on a bad file, never fail the listing** | zurg | **Yes** | One bad file must not blank a directory. |
| M24 | **Whole-torrent publication by value swap** | zurg | **Yes** | Atomic at torrent granularity. |
| M25 | **Targeted Plex refresh** (`/library/sections/N/refresh?path=`) instead of full scan | zurg + prior study | **Yes** | Every debrid stack converges here. |
| M26 | **Delivery-URL cache keyed on the provider link** | zurg | **Yes** | One unrestrict per file per cache lifetime. Pair with M7 (positive key = durable id). |
| M27 | **Size-before-exposure as a structural property** | zurg | **Yes, mandatory** | A `TorrentFile` with no size must be *impossible to publish*. Kills the nullable `size` column. |
| M28 | **`getlastmodified` = provider completion time** | zurg | **Yes** | Restart-invariant mtime, so a restart never invalidates Plex's scanner cache. |
| M29 | **Throttle at the provider boundary** (separate clients + separate limits per operation class) | zurg | **Yes** | Do not try to deduplicate client reads — bound the fan-out instead. |
| M30 | **Head cache 2–8 MiB + tail cache 2–8 MiB** | prior study G6 | **Measure first** | Three unrelated sources converge on the same window. Confirm with H1/H2 before building. |

## 5. The anti-patterns — do NOT port

| # | Anti-pattern | Seen in | Why it's fatal here |
|---|---|---|---|
| X1 | **Synthesize + publish a file from delivery data alone** | zurg (`assign_links.go:92-110`) | Born `ok_file`, therefore *sticky* — fresh inventory can never correct it. Self-perpetuating. |
| X2 | **Size + name as identity** | zurg repair matcher | Downgrade for us: we *have* a mapping table. Use path+size as **validation**, never as resolver. |
| X3 | **Key anything on basename** | zurg (`SelectedFiles` map key) | Provably collapses on packs. |
| X4 | **Use the provider URL as the primary key** | stremiarr (`db.go:145`) | Rotation orphans the row; re-materialization impossible by construction. |
| X5 | **Monotonic strike counter with no decay** | stremiarr | Three transient throttles = permanent death of a healthy stream. |
| X6 | **Throttle failure negative-cached identically to content failure** | warpbox (flat 30 s TTL, 4 sites) | Hides a systemic condition from the rate limiter. |
| X7 | **Eager validation at import** | stremiarr (`proxy.go:234-237`) | Its own 1.5 s throttle is an admission the work is too expensive at catalog scale. |
| X8 | **Eager full-library sync at boot** | warpbox (`sync.go:110`) | Exactly the work the moonshot deletes; we already have the durable catalog. |
| X9 | **Unbounded blocking queue, no deadline, no priority** | warpbox (`queue.go:136-138`) | We *know* probe vs playback at the intent boundary — use it for a priority lane. |
| X10 | **`strings.Contains(err.Error(), …)` as error taxonomy** | warpbox, stremiarr, lazarr | Breaks silently on any format change; two providers makes it a correctness hazard. |
| X11 | **Fabricated size (`size = 1`)** | lazarr (`qbit/server.go:420`) | Synthetic value with no marker. Violates I7. |
| X12 | **`rootNode.Readdir` = empty stub** | lazarr (`fs.go:282-294`) | Fine for FUSE+symlinks; fatal for WebDAV `PROPFIND`. |
| X13 | **Zero timestamps everywhere (epoch 1970)** | lazarr | Plex uses mtime for "recently added"; a whole library dated 1970 is an operational wart. |
| X14 | **No FUSE/attribute cache invalidation at all** | lazarr | Correctness depends entirely on a 1 s TTL. |
| X15 | **Boot-reconcile by deleting every untracked placement** | lazarr (`engine.go:289-316`) | We have durable `ProviderPlacements`; re-adopt instead of nuking. |
| X16 | **Fire-and-forget `addMagnet` with the returned ID discarded** | stremiarr (`debrid.go:604`) | No way to ever reconcile; the exact opposite of a durable `ProviderPlacement`. |
| X17 | **`files=all`, hardcoded, always** | stremiarr (`debrid.go:614`) | Force-materializes a 60 GB pack to serve one episode. |
| X18 | **Hang/poll (200 + hold the connection open)** | warpbox (`get.go:769-985`) | rclone-specific; holds goroutine + connection + semaphore slot for up to 5 min. |
| X19 | **Client/device sniffing for delivery decisions** | — | plex-strm-proxy explicitly forbids it (`AGENTS.md:13`) and is correct to. |
| X20 | **Provider URL string as the "alias" carried in-band in a query param** | stremiarr (`proxy.go:357`) | Unauthenticated, forgeable, un-re-materializable. |
| X21 | **All read errors collapse to one errno (`EIO`)** | lazarr (`fs.go:466`) | Throws away the entire internal error taxonomy at the VFS boundary. A caller cannot tell purge from rate-limit from cancellation. |
| X22 | **On-disk probe cache with no version tag and no integrity check** | lazarr (`probecache.go:267`) | `close()` is a documented no-op, so files persist across restarts unversioned. A format change serves garbage; corrupt provider bytes are cached forever. |

## 6. Where the corpus contradicts the moonshot

Honesty section. These are the findings that suggest provider-free probing may be harder than hoped:

1. **Zurg gets away with zero provider calls on enumeration because it *pre-built* the catalog from a
   full provider inventory at refresh time** — not because it is lazy. The catalog is warm; the probe
   path is cheap *because* someone already paid. (`06` §4.3, `06` §9)
2. **lazarr's grab path depends absolutely on TorBox's free, non-mutating `checkcached`.**
   `ARCHITECTURE.md:73-76` states plainly that Real-Debrid removed the equivalent endpoint in 2024.
   **For RD there may be no way to learn file names + sizes without mutating the account.** This is
   the single hardest constraint on the whole moonshot and it is provider-specific.
   (`05` §9 finding 7, `05` §11)
3. **A single 4 KiB `read()` at offset 0 triggers a full `CreateTorrent` in lazarr.** The first scan
   of a cold item is never free there. Only the *second* scan is. (`05` §6)
4. **Plex's scanner, Analyze, intro/credits detection and BIP generation all read real bytes.**
   With `.strm` they accidentally read 40 bytes. With a VFS reporting a real size they would read
   real bytes — possibly the whole file. `07` §3 quantifies this: extensive analysis = full file read
   per item per maintenance window; one measured mount saw 4.1 TB/month of reads with all analysis
   and thumbnails **off**. **Making the VFS look real makes Plex read more, not less.** (`07` §4)
5. **plex-strm-proxy needed ~2,500 lines (metadata injection + ffprobe + decision rewriting) purely
   because Plex could not probe the file.** A VFS that reports a real size and serves real bytes
   makes all of it unnecessary — but only if the bytes are actually there.
6. **"Request coalescing" — the hypothesis that motivated G2 — is NOT what the production system
   does.** `singleflight` appears **exactly once** in Zurg's 13,347-edge call graph, for archive
   inner-file listing. Zurg throttles at the provider boundary and caches the delivery URL, but does
   **not** deduplicate client reads. (`06` §4.2) Every system in this corpus that achieves "zero
   provider calls on enumeration" does so by **having already fetched everything**, not by being
   lazy. The moonshot's laziness claim is unproven by precedent.

## 7. Where the corpus confirms it

1. **Zurg: zero provider calls on the enumeration and stat paths.** Deliberate and proven. The
   complete call-target census for `ServeTorrentFilesForDav` contains no HTTP client, no
   `UnrestrictFile`, and no `DownloadMap` access. Burst defence is rate-limiting plus a persistent
   `DownloadMap` delivery-URL cache. (`06` §2.2, `06` §4)
2. **lazarr: `Getattr`/`Lookup`/`Readdir`/`Open` never touch the provider. Only `Read` does.** The
   intent boundary is the `read(2)` syscall — arguably more reliable than any heuristic. (`05` §0)
3. **lazarr's probe cache can serve a file that does not exist on the provider at all.** `ReadAt`
   checks the probe cache *before* `ensureMaterialized`. Zero `CreateTorrent`, zero `RequestDL`,
   zero CDN. This is the moonshot realized, hiding in an "optimization". (`05` §3.1, `05` §9.1)
4. **plex-strm-proxy's byte-delivery decision is 14 lines of pure config** — not client-aware at all.
   The redirect fast path is far simpler than the 6,900 lines around it suggest. (`04` §4)
5. **torrg has no synthetic bytes anywhere.** Anti-poisoning is done by requiring full-interval
   coverage and returning `None` on short reads, plus dropping the blob on real eviction. (`01` §4)
6. **Three unrelated sources converge on the same probe window.** torrg `PROBE_HEAD_MB=16` /
   `PROBE_TAIL_MB=2`; lazarr `defaultProbeRegionBytes = 4 MiB` + footer `size/500` clamped to
   [1 MiB, 8 MiB]; the prior Plex/rclone study's G6 head/tail 2–8 MiB. That convergence is the
   strongest empirical support E1 has. (`01` §2, `05` §3.2, `07` §7 G6)
7. **Zurg satisfies "an ambiguous negative never poisons durable identity" structurally** — the DAV
   layer has zero error paths, and broken files are pre-modelled as `broken_file` / `deleted_file`
   and skipped with `continue`. The listing path can never discover a failure, and therefore can
   never block on one. (`06` §2.3)

## 8. Open questions the experiments must answer

| # | Question | Experiment |
|---|---|---|
| Q1 | Can probes be served with **zero** provider calls and **zero** materializations, first scan included (not just second)? | E1 |
| Q2 | Can a real playback be distinguished from a probe without relying on byte size? | E2 |
| Q3 | Can one `TorrentFile` obtain delivery from TorBox **or** RD with failure never mutating identity? | E3 |
| Q4 | Do 429/451/failure conditions die locally, with instrumented real call counts? | E4 |
| Q5 | Is the optional Plex fast path worth keeping, or is it brittle/client-specific? | E5 |
| Q6 | **For RD specifically: is there any way to populate a virtual catalog without mutating the account?** | E3 / RD handoff |

Q6 is the one most likely to kill part of the architecture. It should be answered early.

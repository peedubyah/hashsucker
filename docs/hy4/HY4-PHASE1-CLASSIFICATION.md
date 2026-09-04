# HY4 PHASE 1 — TRANSPLANT CLASSIFICATION

**Status:** PHASE 1 ACCEPTED, **AMENDED (4 corrections incorporated)** — awaiting
approval. No implementation performed.

**Branch model (amendment 1):** `m3-north-db` **is** the convergence branch and
HY4's continuing baseline. **No second development branch is created.** HY4
transplants directly into `m3-north-db` and pushes back to the same remote
branch. `main` remains reference-only and untouched.

**Clean host checkpoint:** `m3-north-db` @ `9f36481e541eb9e9f04659ff76522dd51a0cad4a`
(confirmed via GitHub MCP). A fixed tag/ref at `9f36481` **may** be created
before mutation for comparison/rollback.

**South donor:** `frankenstein` @ `ef5f33c` (local workspace, read-only inspection)
**Oracle:** `playback-bench` @ `791885a`
**Baseline doc:** `HY4-SOUTH-BASELINE.md` (read in full; 412 lines, added by `9f36481` itself)

**Retention vocabulary (amendment 2):** two distinct classes are used throughout.
- **KEEP DURING TRANSPLANT** — protected until its value can be classified safely. May be deleted afterwards.
- **PERMANENT RETAINER** — survives into the continuing branch indefinitely.

### Amendments applied to Phase 1

| # | Amendment | Where it lands |
|---|---|---|
| 1 | No new development branch. `m3-north-db` is the convergence branch; `9f36481` may be tagged as the pre-HY4 reference; `main` is reference-only. | header, §2 step 2, §8 B-3, §6 preamble |
| 2 | Tighten permanent doc retention. Protect docs during transplant; afterwards keep only transplant/classification docs, useful Slice closures/proofs, Zurg RE + Plex VFS forensics, and `playback-bench`. `MERGE-PLAN.md` is **not** automatically permanent. | §1.4, §1.8, §6.2, §6.4 |
| 3 | `hy4-data/baseline/` is protected during transplant but **not** immortal — re-evaluate after the branch is functional. WAL handling is **not** a migration project; DBs stay at the same physical root. | §1.8, §2 step 1, §6.3, §6.4, §8 B-3 |
| 4 | Do **not** make the Slice 4.75 suite the acceptance gate. Use the bounded 9-item transplant proof ladder targeting new integration risk. Never relax `playback-bench` assertions to obtain green. | new **§7**, §1.9, §2 step 11, §6.1, §8 B-4 |

Evidence discipline: every remote fact below came from GitHub MCP against
`refs/heads/m3-north-db`. **No local Git state was used as evidence for remote
branch contents.** The local checkout `C:\src\hashsucker` sits on
`hy4-frankenstein-moonshot` @ `f524068`, which **does not exist remotely**
(`m3-north-db` and `main` are the only two remote branches).

---

## 0. The one structural finding that drives everything

The Frankenstein Rust plane is a **single-TorrentFile lab process**, not a
production service:

- `main.rs:1265` — `let tf_id = std::env::var("TORRENT_FILE_ID").expect(...)` — **required at startup, one value, process-wide.**
- `main.rs:1277` — control is fetched **once at boot**, not per request.
- `main.rs:1375-1378` — the entire router is two routes: `/` → `get_file`, `/metrics`.

So the transplant is **not** "copy `src/` and wire it up". `main.rs` must be
**split**: its bootstrap/routing/config third is lab scaffolding that has to be
replaced, while its `get_file` + span-fetch core is the proven payload. This
split is reflected per-component in §1.1 and is the largest single item of
ADAPT AT SEAM work.

---

## 1. Component classification

### 1.1 Rust data plane — `frankenstein/rust-data-plane/src/`

8 files, 228,680 bytes total.

| PATH / COMPONENT | BUCKET | SOURCE OF TRUTH | TARGET LOCATION | WHY | DELETE? |
|---|---|---|---|---|---|
| `transport.rs` (24,476 B) — `ResilientRangeReader`: logical byte position, mid-body resume, 429/5xx/dead classification, bounded recovery | **TRANSPLANT** | Frankenstein | `hy4-data-plane/src/transport.rs` | Authoritative south-of-DB. Owns byte motion + recovery. Proven: mid-body resume, `MAX_REACQUIRES=1`, `MAX_SAME_CAP_RETRIES=3`. | no |
| `capability.rs` (8,559 B) — `DeliveryCapability`, `Breaker`, `parse_retry_after`, `ApiKeys` | **TRANSPLANT** | Frankenstein | `hy4-data-plane/src/capability.rs` | DeliveryCapability lifecycle is explicitly south-owned. "Throttle is not death" is the behavior the legacy host lacks entirely. | no |
| `manager.rs` (22,167 B) — `CapabilityManager`: single-flight, pool, bounded negative cache, `reacquire_for_read`, `prunable`, `limiter_permit_waits` | **TRANSPLANT** | Frankenstein | `hy4-data-plane/src/manager.rs` | South-owned provider execution + limiter/breaker. Proven: 10 concurrent readers → 1 requestdl. | no |
| `provider.rs` (16,427 B) — `acquire_torbox` (no-redirect, parses `data`), `list_realdebrid_downloads` | **TRANSPLANT** | Frankenstein | `hy4-data-plane/src/provider.rs` | TorBox/RD byte delivery is south-owned. Legacy host's redirect-following path is the thing being replaced. | no |
| `cache.rs` (59,896 B) — fixed-grid chunk cache, format v2, per-chunk single-flight, `ChunkStager`, chunk-granular LRU | **TRANSPLANT** | Frankenstein | `hy4-data-plane/src/cache.rs` | Cache/coalescing/byte motion is south-owned. Proven by Slice 4.75 A–H + L/L2/M. Largest and most-proven file in the plane. | no |
| `metrics.rs` (27,946 B) — A/B/C layer accounting, capability lifecycle, stage timings, 32 surfaced cache metrics | **TRANSPLANT** (+ seam, see S-6) | Frankenstein | `hy4-data-plane/src/metrics.rs` | All §10 instrumentation lives here. Must move intact or every proof becomes unreproducible. | no |
| `main.rs` — `get_file` handler + `fill_chunk_run` + `window_slice` + span assembly (~1,000 of 1,481 lines) | **TRANSPLANT** | Frankenstein | `hy4-data-plane/src/serve.rs` (extracted) | The proven cold/hot serving path, including the `window_slice` clamp that was mutation-verified in 4.75. Extract into a module so the router is not entangled with it. | no |
| `main.rs` — `main()` bootstrap, `Router::new`, env var reads, `TORRENT_FILE_ID` startup fetch, fault-gate wiring (~480 lines) | **ADAPT AT SEAM** | Host | replaced by `hy4-data-plane/src/main.rs` | Single-file-process shape cannot survive. Must become multi-file, per-request control fetch, no `.expect()` on startup. | yes (the lab `main()`; not the file) |
| `control.rs` (3,282 B) — `GET {control}/data-plane/files/{tf_id}`, `schemaVersion` gate, `ControlResponse::target_file_id()` | **ADAPT AT SEAM** | Shared contract | `hy4-data-plane/src/control.rs` | Contract shape is correct and must be preserved verbatim (schema gating is the right pattern). But the endpoint it calls **does not exist on `m3-north-db`** — see S-1, the #1 seam. | no |
| `Cargo.toml` (deps: axum `=0.7.5`, tokio, reqwest 0.12 `rustls-tls`, bytes, futures-util, tokio-stream, serde, serde_json, rusqlite 0.32 **bundled**, parking_lot 0.12) | **TRANSPLANT** | Frankenstein | `hy4-data-plane/Cargo.toml` | Pin `axum =0.7.5` exactly (not `^0.7`) — the plane's API usage is version-specific. | no |
| `rust-data-plane/.gitignore` | DISCARD | — | — | Lab-only; host has its own. | yes |
| `rust-data-plane/scratch/proofs/{slice3.5,slice4}/` | DISCARD | — | — | Superseded by `playback-bench/src/slice475/`. Proof drivers, not implementation. | yes |

### 1.2 Frankenstein Node lab — `frankenstein/src/lib/frankenstein/`

12 files, ~51 KB. `package.json` describes this as *"FRANKENSTEIN PHASE 2 —
competing playback architecture bakeoff (MODE=A current HashSucker vs MODE=B
Frankenstein)"*. `build-plane.js` wires in `fakeProvider` / `defaultFleet`
from `provider-mock.js` — **this is a mock-driven simulation, not real provider
code.**

| PATH / COMPONENT | BUCKET | SOURCE OF TRUTH | TARGET LOCATION | WHY | DELETE? |
|---|---|---|---|---|---|
| `bakeoff.mjs`, `provider-mock.js`, `two-plane-vfs.js`, `sparse-byte-cache.js`, `capability-broker.js`, `session-broker.js`, `delivery-director.js`, `intent-classifier.js`, `learned-probe-map.js`, `probe-store.js`, `ontology.js`, `build-plane.js` | **DISCARD** | n/a (mock) | — | Fake-provider bakeoff harness. The Rust plane is the proven real implementation; these simulated it. Retaining both invites reconciliation, which the transplant rule forbids. | yes |
| `frankenstein/package.json` | **DISCARD** | — | — | Only wires `bakeoff` + `node --test` for the mock harness. | yes |
| `frankenstein/test/frankenstein.test.js` | **DISCARD** | — | — | Tests the mock plane, not the Rust plane. | yes |

### 1.3 Frankenstein control-plane daemon — `frankenstein/control-plane-daemon/`

| PATH / COMPONENT | BUCKET | SOURCE OF TRUTH | TARGET LOCATION | WHY | DELETE? |
|---|---|---|---|---|---|
| `server.mjs` (3,951 B) — the 3-endpoint `/data-plane/*` server | **ADAPT AT SEAM** (reference impl only — do **not** port) | Host | replaced by routes in `media-search/src/server/app.js` | It is the **executable specification** of the S-1 contract. Read it to build the host endpoint; do not ship it. It also demonstrates the single schema-stamping point (`send()` wraps every response). | yes |
| `store.mjs` (6,086 B) — reads authoritative DB to answer `/data-plane/files/:id` | **ADAPT AT SEAM** (reference only) | Host | logic re-expressed against `createControlPlaneStore` + `createDiscoveryCache` | Shows the exact projection north must build: TorrentFile + size + ordered provider coords. The *query* must be rewritten against host stores, not copied. | yes |
| `scratch/{contract-client.mjs, dune-query.js, schema-dump.js}` | **DISCARD** | — | — | Ad-hoc probes against the lab daemon. | yes |

### 1.4 Frankenstein docs — `frankenstein/docs/`

**Amendment 2 applies here.** The original pass over-classified this tree as
permanently KEEP. Retention is now split into **KEEP DURING TRANSPLANT**
(protected until value is classifiable, deletable afterwards) and
**PERMANENT RETAINER** (survives in the continuing branch).

Permanent retention is restricted to: transplant/classification documentation
needed to explain the resulting architecture; Slice closure/proof documents
that remain useful for provenance or known regressions; useful Zurg RE / Plex
VFS forensic material; and `playback-bench` as the independent external oracle.
Old planning documents, stale merge plans, redundant moonshot notes, and
historical lab documentation do **not** become permanent merely by existing.

| PATH / COMPONENT | BUCKET | SOURCE OF TRUTH | TARGET LOCATION | WHY | DELETE? |
|---|---|---|---|---|---|
| `TRANSPLANT-MAP.md` (Slice 3.5 forensic map, 6 behaviors) | **PERMANENT RETAINER** | Frankenstein | `docs/hy4/TRANSPLANT-MAP.md` | Transplant/classification doc needed to explain the resulting architecture. Behavior→causal-file→proof mapping. | no |
| `SLICE475-CLOSURE.md` | **PERMANENT RETAINER** | Frankenstein | `docs/hy4/SLICE475-CLOSURE.md` | Proof closure documenting a **known, un-repaired regression** (the chunk lead-in cold-latency penalty) and the `limiter_waits`/`limiter_permit_waits` semantic fix. Deleting it means re-discovering both. | no |
| `SLICE4-PROOF-CLOSURE.md`, `SLICE45-PROOF-CLOSURE.md` | **KEEP DURING TRANSPLANT** → re-evaluate | Frankenstein | `docs/hy4/` | Provenance of superseded cache generations. Once the fixed-grid chunk cache is the only cache in the tree, these describe a state that no longer exists. | **likely yes** |
| `architecture-freeze-slice0.md` | **KEEP DURING TRANSPLANT** → re-evaluate | Frankenstein | `docs/hy4/` | Establishes the north/south split and MOTION-vs-TRUTH rule — but those are now restated authoritatively in `HY4-SOUTH-BASELINE.md` §A and this artifact. Candidate for deletion as redundant. | **likely yes** |
| `slice3-report.md`, `slice3.5-report.md` | **KEEP DURING TRANSPLANT** → re-evaluate | Frankenstein | `docs/hy4/` | Historical lab reports. Retain only the sections that document a behavior still asserted by the transplant proof ladder (§7 items 5–7). | **likely yes** |
| `MERGE-PLAN.md` | **KEEP DURING TRANSPLANT** — **NOT automatically permanent** | Frankenstein | stage outside the repo, or `docs/hy4/` temporarily | Old planning document, superseded by this classification. Existence is not a retention argument. | **yes**, after the branch is functional and resumable |
| `moonshot/09-mycelium-spore-forensics.md` | **KEEP DURING TRANSPLANT** → re-evaluate | Frankenstein | `docs/hy4/moonshot/` | Forensic note on a third-party project. Retain only if it still informs a live seam; otherwise lab history. | **likely yes** |
| `moonshot/10-phase2-bakeoff-findings.md` | **KEEP DURING TRANSPLANT** → re-evaluate | Frankenstein | `docs/hy4/moonshot/` | Records *why* the bakeoff resolved to the Rust plane. That decision is now settled and restated in §1.2 — so the *conclusion* is preserved even if the document is not. | **likely yes** |

### 1.5 `_real_src/` — copied host source

| PATH / COMPONENT | BUCKET | SOURCE OF TRUTH | TARGET LOCATION | WHY | DELETE? |
|---|---|---|---|---|---|
| `_real_src/{client.js, provider-accounting.js, resolve.js, torbox-delivery.js, torbox-download-url-cache.js, torbox.js}` | **DISCARD** | Host (`m3-north-db`) | — | Verbatim copies of host files. Definitionally stale the moment the host moves. The authoritative copies are on the remote branch. | yes |

### 1.6 Host `m3-north-db` — north (frozen, do not touch)

| PATH / COMPONENT | BUCKET | SOURCE OF TRUTH | TARGET LOCATION | WHY | DELETE? |
|---|---|---|---|---|---|
| `media-search/src/lib/acquisition/rd-history.js` | **KEEP AS-IS** | Host | unchanged | North. `deriveEventId` + bounded merge. HY4 consumes, never replaces. | no |
| `media-search/src/lib/discovery/cache.js` (184,940 B) | **KEEP AS-IS** | Host | unchanged | North owns SQLite truth. Only the `historical_provider_evidence` PK matters to HY4. | no |
| `media-search/src/scripts/import-historical-provider-evidence.js`, `rd-census.mjs`, `rd-downloads-census.mjs` | **KEEP AS-IS** | Host | unchanged | North corpus tooling. | no |
| `media-search/src/lib/discovery/ranking.js` (79,338 B), `search-engine.js` (55,384 B), `confidence-projection.js`, `corpus-*.js`, `evidence-projection.js`, `selection.js`, `rejection*.js`, `episode-coverage.js` | **KEEP AS-IS** | Host | unchanged | Discovery/ranking/persisted candidates = north-owned. | no |
| `media-search/src/lib/control-plane/store.js` (102,188 B) | **KEEP AS-IS** | Host (read-only consumer for HY4) | unchanged | Durable identity + bindings live here. HY4 *reads* TorrentFile/ProviderPlacement; it must never write. | no |
| `media-search/src/api/release-contract.js` | **KEEP AS-IS** | Host | unchanged | `Release(infoHash,fileIndex)` + `'torrent'` sentinel. Do-not-break invariant. | no |
| `media-search/src/lib/plex/*`, `metadata/*`, `stremio/`, `torznab/`, `ingestion/`, `intents/`, `importer/` | **KEEP AS-IS** | Host | unchanged | Publication/Plex-facing semantics + intake = north-owned. | no |
| `media-search/src/lib/control-plane/{durability-*, repair-*, reconciler, background-durability-executor, rd-zurg-slice}.js` | **KEEP AS-IS** | Host | unchanged | Background durability is opt-in (`disabled` by default) and is north scheduling, not byte motion. | no |

### 1.7 Host `m3-north-db` — south (conflict surface, superseded)

These currently own behavior Frankenstein will replace. Full byte counts in §5.

| PATH / COMPONENT | BUCKET | SOURCE OF TRUTH | TARGET LOCATION | WHY | DELETE? |
|---|---|---|---|---|---|
| `lib/resolver/transport.js` (7,790 B) | **CONFLICT → superseded** | Frankenstein | removed; calls route to data plane | `createMediaStream` is the only consumer of `source.type`. The Rust plane replaces the whole stream-fetch. | yes |
| `lib/resolver/source.js` (4,946 B) | **CONFLICT → ADAPT AT SEAM** | Host (contract) / Frankenstein (behavior) | reduced to a projector | `buildMediaSource` still decides *which* TorrentFile/placement — that is north truth. The `source.type` discriminator becomes "hand to data plane". | no (rewired) |
| `lib/resolver/alternate-fallback.js` (25,796 B) | **CONFLICT → ADAPT AT SEAM** | Shared | kept, entry contract intact | Baseline says HY4 may rewrite the ladder, not the entry point. The ladder calls into the data plane per candidate. | no (rewired) |
| `lib/resolver/torbox-delivery.js` (34,757 B) | **CONFLICT → superseded** | Frankenstein (`provider.rs`) | removed | TorBox delivery + stale recovery. Slice 3.5 replaced this. | yes |
| `lib/resolver/torbox-download-url-cache.js` (24,519 B) | **CONFLICT → superseded** | Frankenstein (`manager.rs`) | removed | URL caching = capability reuse. `CapabilityManager` owns it. | yes |
| `lib/resolver/torbox-redirect.js` (4,471 B) | **CONFLICT → superseded** | Frankenstein (`provider.rs` no-redirect) | removed | The redirect hop is precisely what Slice 3.5 eliminated. | yes |
| `lib/resolver/torbox-file-identity.js` (14,611 B) | **CONFLICT → ADAPT AT SEAM** | Host | reduced to identity projection | TV file identity is durable identity (north). Only the *resolution* half moves. | no (reduced) |
| `lib/resolver/availability-revalidation.js` (13,761 B) | **CONFLICT → superseded** | Frankenstein (`capability.rs`) | removed | Liveness/revalidation is the DeliveryCapability lifecycle. | yes |
| `lib/resolver/terminal-delivery-evidence.js` (6,407 B) | **CONFLICT → ADAPT AT SEAM** | Shared | re-pointed at data-plane metrics | Evidence must now be emitted from Rust `/metrics`, not Node. | no (rewired) |
| `lib/resolver/liveness.js` (2,575 B), `profiler.js`, `telemetry.js`, `mounts.js`, `tv-episode-resolver.js` | **CONFLICT → superseded** | Frankenstein | removed (`profiler`/`telemetry` → `/metrics`) | Telemetry folded into `metrics.rs`. | yes |
| `lib/vfs/movie-webdav.js` (41,831 B), `lib/vfs/tv-webdav.js` (43,401 B) | **CONFLICT → ADAPT AT SEAM** | Host (mount shape) / Frankenstein (bytes) | VFS becomes a Range forwarder | `MOVIE_VFS_ROOT`, PROPFIND, and the Plex-visible mount shape are **north-owned library semantics** and must survive. Only the byte-serving half is replaced. **Do not delete these files.** | **no** |
| `lib/vfs/range-response-validator.js` (13,274 B) | **CONFLICT → superseded** | Frankenstein (`transport.rs` Content-Range validation) | removed | Byte exactness is south-owned and proven in Rust. | yes |
| `lib/vfs/materialize.js` (25,823 B) | **CONFLICT → ADAPT AT SEAM** | Shared | reduced | Materialization decisions are north; the byte fetch is south. | no (reduced) |
| `lib/providers/torbox*.js` (41,017 B across 5 files) | **CONFLICT → superseded** | Frankenstein (`provider.rs`) | removed (`torbox-inventory.js` partially — see below) | TorBox execution is south-owned. | yes |
| `lib/providers/torbox-inventory.js` (12,072 B) | **ADAPT AT SEAM** | Host | kept; exports the coord projection | Inventory = persisted provider resource identity (north). It must feed `ProviderCoord.providerResourceId` to the control endpoint. | no |
| `lib/providers/realdebrid/*.js` (58,508 B across 5 files) | **CONFLICT → superseded** | Frankenstein (`provider.rs`) | removed | RD byte delivery is south-owned. | yes |
| `lib/providers/realdebrid.js` (9,864 B, legacy re-export) | **CONFLICT → superseded** | Frankenstein | removed | Baseline §D.9 preserved it only for paths the new modules "don't yet cover". The Rust plane covers them. | yes |
| `lib/providers/provider-accounting.js` (16,747 B) | **ADAPT AT SEAM** | Host (the budget) / Frankenstein (the counters) | kept; counters fed from Rust `/metrics` | The **warm-playback budget is a do-not-break invariant**. The assertion survives; its data source becomes the Rust plane. | no |
| `lib/providers/accounting-cache-wrapper.js` (6,869 B) | **CONFLICT → superseded** | Frankenstein | removed | Wraps the download-URL cache that `manager.rs` replaces. | yes |
| `lib/providers/{observations,resources,zurg-metadata}.js` (25,307 B) | **KEEP AS-IS** | Host | unchanged | These **construct identity objects** from `createReleaseIdentity` — north territory, not byte motion. | no |
| `lib/providers/{capabilities,errors,filesystem-exposure}.js` (14,347 B) | **ADAPT AT SEAM** | Shared | `errors.js` kept; others reviewed | `errors.js` is the shared error taxonomy the ladder throws; keep it. | no |
| `lib/stream-resolver/index.js` (3,541 B) | **CONFLICT → superseded** | Frankenstein | removed | Duplicate stream-entry path. | yes |
| `src/server/app.js` (121,425 B) | **ADAPT AT SEAM** | Host | route table edited in place | Not deleted, not rewritten. Add the data-plane route + control endpoint; re-point `/stream/*` bytes. Baseline §D.1 forbids splitting it during non-HY4 work; HY4 is now that work, but a full rewrite is still out of scope for a mechanical transplant. | no |
| `src/server/index.js` (4,668 B) | **ADAPT AT SEAM** | Host | process lifecycle extended | Must spawn/health-check the Rust child and close it in `shutdown()`. Currently closes only `discoveryCache` + `controlPlaneStore`. | no |
| `compose.yaml` (3,677 B) | **ADAPT AT SEAM** | Host | add service + volume | Needs the Rust service, `SLICE4_CACHE_ROOT` volume, and provider key passthrough. | no |
| `edge/Caddyfile` (1,775 B) | **KEEP AS-IS** | Host | unchanged | Fronts media-search; the data plane is internal. | no |

### 1.8 Local lab sprawl — `C:\src\hashsucker`

**Amendment 3 applies here.** Both 1.7 G stores are **preserved throughout the
branch transition** because accidental data loss during a branch change is
unacceptable. But preservation-through-transition is not the same as permanent
retention, and the two stores are **not** symmetric:

- `hy4-data/discovery/` — the only one currently known to be part of the
  continuing runtime state.
- `hy4-data/baseline/` — protected during transplant, **re-evaluated after the
  new branch is functional**, deleted later if it proves redundant/lab-only.

**WAL handling is explicitly NOT a migration project.** The DBs stay in place
at the same physical root. No snapshot is taken unless a concrete later
operation requires one. The `-wal`/`-shm` note below is a caution against
*future* naive copying, not a task to schedule now.

| PATH / COMPONENT | BUCKET | SOURCE OF TRUTH | TARGET LOCATION | WHY | DELETE? |
|---|---|---|---|---|---|
| `hy4-data/discovery/` (1.7 G) | **PERMANENT RETAINER** (expected continuing data) | — | unchanged, same physical root | Known part of continuing runtime state. **Not moved, not copied.** Carries live `control-plane.db-wal` (16,512 B) and `-shm` (32,768 B) — if a snapshot is ever required, copy the `-wal`/`-shm` with the `.db` or checkpoint first (`PRAGMA wal_checkpoint(TRUNCATE)`); a bare `.db` copy loses committed transactions. | **no** |
| `hy4-data/baseline/` (1.7 G) | **KEEP DURING TRANSPLANT** — **re-evaluate after the branch is functional** | — | unchanged, same physical root | Protected only against accidental loss during the branch change. **Not classified as permanent / never-delete.** Continued existence requires a demonstrated continuing dependency. | **later, if redundant** |
| `docs/moonshot/` — `06-zurg-re.md`, `07-plex-vfs-io-forensics.md` | **PERMANENT RETAINER** | — | `docs/moonshot/` in repo | Named Zurg RE / Plex VFS forensic retainers. **Not present on `m3-north-db`** — `docs/` there is only 4 files. | **no** |
| `docs/moonshot/` — `00-README.md`, `01-torrg.md`, `02-warpbox.md`, `03-stremiarr.md`, `04-plex-strm-proxy.md`, `05-lazarr.md`, `08-moonshot-deliverable.md` | **KEEP DURING TRANSPLANT** → re-evaluate | — | stage for review | Third-party project surveys and moonshot planning. Redundant moonshot notes are **not** permanent by existence. Each needs a concrete continuing dependency to survive. | **likely yes** |
| `.env` | **PERMANENT RETAINER** (explicitly preserved) | — | unchanged | Never commit. | **no** |
| `hy4/` (lab scaffolding — `p3-*.tap/.txt`, `p3-backup/`, `pre-live-backup/`, `pre-rank5-retry/`, `commit*.msg`, 12 ad-hoc `.mjs` probes, `scratch/`) | **DISCARD** | — | — | TAP dumps, backups, one-shot forensic probes. No continuing dependency. | yes |
| `hy4-artifacts/` | **DISCARD** | — | — | Generated artifacts. | yes |
| `hy4-data/{downloads,importer,queue,requests,strm,vfs}/` | **DISCARD** | — | — | Runtime scratch, distinct from the two preserved stores. | yes |

### 1.9 Independent oracle

| PATH / COMPONENT | BUCKET | SOURCE OF TRUTH | TARGET LOCATION | WHY | DELETE? |
|---|---|---|---|---|---|
| `playback-bench` @ `791885a` (whole repo, including `src/slice475/`) | **PERMANENT RETAINER** (external) | — | stays a separate repo | Named retainer: the independent external oracle. Its value is *independence* — folding it into the host would let host bugs suppress their own evidence. Retained permanently, but **not** as the transplant acceptance gate (see amendment 4 / §7). | **no** |
| `playback-bench/src/slice475/` (`validate-chunks.mjs` ~1,100 lines; 7 drivers; `cleanup-proxies.sh`) | **KEEP AS-IS** | — | unchanged in playback-bench | Proofs A–H + L/L2/M. Must remain *runnable* against the transplanted plane, but running them is **not** the acceptance gate (§7). Assertions are never relaxed to obtain green. | no |

---

## 2. Transplant order

Safest mechanical order. Each step leaves the tree in a state that still runs.

1. **Verify preservation in place — do not copy (amendment 3).**
   `hy4-data/discovery/` and `hy4-data/baseline/` stay at the **same physical
   root**. Confirm both are intact and that `.env` and `docs/moonshot/` are
   intact. **No snapshot, no checkpoint, no WAL migration** — WAL handling is
   not a migration project, and nothing in this step requires a copy. Nothing
   else in §1.8 is needed.
2. **Checkout `m3-north-db` and pin the pre-HY4 reference (amendment 1).**
   **No new development branch is created.** In the canonical workspace
   (`C:\src\hashsucker`):
   - fetch/checkout the **existing remote** `m3-north-db`;
   - preserve `9f36481` as the pre-HY4 reference — a fixed tag/ref at
     `9f36481` may be created **before any mutation**, for comparison and
     rollback;
   - commit the transplant/classification documentation there
     (`docs/hy4/` + retained `docs/moonshot/`). Zero code change — proves the
     branch is resumable and gives later diffs a home;
   - **continue the transplant on `m3-north-db`**, pushing back to the same
     remote branch.
   `main` remains reference-only and untouched.
3. **Land `Cargo.toml` + the six pure TRANSPLANT modules unchanged** into
   `hy4-data-plane/src/`: `transport.rs`, `capability.rs`, `manager.rs`,
   `provider.rs`, `cache.rs`, `metrics.rs`. Get `cargo build --offline` clean
   **before** touching `main.rs`. These have no host dependency except
   `control.rs`'s types — so land `control.rs` here too, still pointing at
   `CONTROL_DAEMON_URL`.
4. **Build the control endpoint on the Node side (S-1).** Add
   `GET /api/data-plane/files/:tfId` to `app.js`, backed by
   `createControlPlaneStore` + `createTorBoxInventoryProvider`. Ship the
   `schemaVersion` stamping exactly as `control-plane-daemon/server.mjs`
   does. **Land this before the Rust plane is wired to it** — otherwise the
   plane cannot boot.
5. **Extract the serving core.** Move `get_file` + `fill_chunk_run` +
   `window_slice` out of the lab `main.rs` into `serve.rs`, parameterized by
   `(tf_id, control_response)` instead of process-global state.
6. **Rewrite `main.rs` bootstrap (S-2).** Multi-file router
   (`/files/:tfId`, `/metrics`), per-request control fetch, no
   `.expect()`-on-startup, no `TORRENT_FILE_ID`.
7. **Container wiring (S-3/S-4).** Add the service to `compose.yaml`, the
   cache volume, provider key passthrough, and the Rust build stage.
8. **Re-point the host south (§4 conflict surface), smallest first.**
   `stream-resolver` → `range-response-validator` → `torbox-redirect` →
   `torbox-delivery` → `torbox-download-url-cache` → `accounting-cache-wrapper`
   → RD modules → `transport.js`. Leave the VFS files for step 9.
9. **Rewire (do not delete) the VFS and the ladder.**
   `movie-webdav.js`/`tv-webdav.js` become Range forwarders;
   `alternate-fallback.js` calls the data plane per candidate;
   `source.js`/`torbox-file-identity.js` shrink to identity projectors.
10. **Metrics + accounting (S-6).** Bridge Rust `/metrics` into
    `provider-accounting.js` and `terminal-delivery-evidence.js`.
11. **Prove against the transplant proof ladder in §7 — not the Slice 4.75
    suite (amendment 4).** Run ladder items 1–9. **Do not** re-run A–H + L +
    L2 + M merely because the implementation moved; those properties are
    closed. Run a historical proof only if a concrete integration failure
    gives reason to suspect that specific behavior regressed.
12. **Only then clean up.** Everything marked `DELETE? yes` in §1, plus the
    re-evaluations that amendment 2 and 3 deferred.

---

## 3. Seam inventory

Every place north and Frankenstein must meet.

| ID | Seam | North side | Frankenstein side | Work required |
|---|---|---|---|---|
| **S-1** | **Control/identity fetch** | `NEW`: `GET /api/data-plane/files/:tfId` in `app.js` | `control.rs::fetch_control` | **Highest-risk, do first.** `search_code("data-plane repo:peedubyah/hashsucker")` → **0 hits**; the endpoint does not exist. Must return `{schemaVersion, torrentFile:{id,infoHash,canonicalInternalPath,size}, providers:[{provider,accountScope,providerResourceId,providerFileId,state,canonicalInternalPath,size}]}` and stamp `schemaVersion` on **every** response. Reference impl: `control-plane-daemon/{server,store}.mjs`. |
| **S-2** | **Process lifecycle** | `server/index.js` `shutdown()` | `main.rs::main()` | `index.js` currently closes only `discoveryCache` + `controlPlaneStore`. Must spawn/supervise the Rust child, health-check it, and terminate it inside `shutdown()`. |
| **S-3** | **Container wiring** | `compose.yaml` | needs a build stage | Add service, `SLICE4_CACHE_ROOT` volume, `TORBOX_API_KEY`/`REALDEBRID_API_KEY` passthrough. `rusqlite = bundled` means the build image needs a C toolchain — see §6. |
| **S-4** | **Config/env** | `compose.yaml` env block, `.env` | 15 env vars read via `std::env::var` | Full set: `CONTROL_DAEMON_URL`, `PROXY_PORT`, `SLICE4_CACHE`, `SLICE4_CACHE_ROOT`, `SLICE4_CACHE_MAX_BYTES`, `SLICE4_CHUNK_SIZE`, `TORBOX_API_KEY`, `REALDEBRID_API_KEY`, `TORBOX_TTL_SECONDS`, `RD_TTL_SECONDS`, `RD_MODE_B`, `TB_REDIRECT_TRUE`, `POOL_MAX`, `NEG_CACHE_TTL_SECONDS`, + 4 `SLICE3*/SLICE35*` fault gates. **The fault gates must not ship enabled.** |
| **S-5** | **Node↔Rust invocation** | `app.js` `/stream/*` branches | `/files/:tfId` route | Byte path becomes: VFS parses Range → forwards to data plane → streams back. `MOVIE_VFS_ROOT` and PROPFIND stay in Node. |
| **S-6** | **Metrics exposure** | `provider-accounting.js`, `terminal-delivery-evidence.js`, `/api/debug/*` | `GET /metrics` (JSON) | Rust exposes ~32 cache + A/B/C accounting + recovery counters as JSON. North must poll or proxy it. `metrics.rs` is the only source for `limiter_permit_waits`, `durable_sync_us`, `overfetch_ratio`, `collapse_ratio`. |
| **S-7** | **DB identity inputs** | `createControlPlaneStore`, `createDiscoveryCache`, `createTorBoxInventoryProvider` | `control.rs` structs (read-only) | Rust never opens host SQLite. Every identity field arrives through S-1. Preserve this — it is the MOTION-vs-TRUTH rule. |
| **S-8** | **Cache storage path** | host volume mounts | `cache.rs` → `cache/<torrentFileId>/<chunkIndex>.chunk` | Local filesystem only. Not an object store; no S3. Needs a durable host path with a byte budget. |
| **S-9** | **Publication/Plex hooks** | `lib/plex/*`, `openSeasonFanOutScope`, STRM output | untouched | Frankenstein has no Plex surface. Nothing to wire — confirm no byte-path regression breaks refresh. |
| **S-10** | **Error taxonomy** | `lib/providers/errors.js` | Rust `OpenError` variants | Map `Client416` → HTTP 416, `Client502` → 502, exhausted recovery → 503 so `alternate-fallback` still fires. |

---

## 4. Conflict inventory

Host code that currently owns behavior Frankenstein will replace. Grouped;
all paths under `media-search/`.

| Group | Files | Bytes | Disposition |
|---|---|---|---|
| Resolver delivery | `transport.js`, `source.js`, `alternate-fallback.js`, `torbox-delivery.js`, `torbox-download-url-cache.js`, `torbox-redirect.js`, `torbox-file-identity.js`, `availability-revalidation.js`, `terminal-delivery-evidence.js`, `liveness.js` | ~139,633 | 8 superseded / 2 rewired (`source.js`, `torbox-file-identity.js`) |
| VFS byte serving | `movie-webdav.js`, `tv-webdav.js`, `range-response-validator.js`, `materialize.js` | ~124,329 | 1 superseded (`range-response-validator.js`); 3 rewired — **VFS files must survive** |
| Provider execution | `torbox.js`, `torbox-inventory.js`, `torbox-execution.js`, `torbox-call-coordinator.js`, `torbox-call-budget.js`, `realdebrid/*.js` (5), `realdebrid.js`, `accounting-cache-wrapper.js` | ~132,893 | all superseded except `torbox-inventory.js` (rewired as coord projector) |
| Provider accounting | `provider-accounting.js` | 16,747 | rewired — the **budget invariant survives**, the counter source changes |
| Stream entry | `stream-resolver/index.js` | 3,541 | superseded |
| **Total conflict surface** | **~28 files** | **~417,143 B (~417 KB)** | |

Explicitly **not** in conflict (north-owned, despite living near the byte
path): `lib/providers/{observations,resources,zurg-metadata}.js` (identity
construction), `lib/control-plane/store.js` (durable identity),
`api/release-contract.js`, `lib/discovery/*`, `lib/plex/*`.

---

## 5. External dependency inventory

Everything Frankenstein depends on that is outside the future canonical repo.

| Dependency | Kind | Risk | Mitigation |
|---|---|---|---|
| `crates.io` — 10 direct crates (`axum`, `tokio`, `reqwest`, `bytes`, `futures-util`, `tokio-stream`, `serde`, `serde_json`, `rusqlite`, `parking_lot`) | Build-time | `axum` is pinned `=0.7.5` (exact, not caret) — a resolver surprise here breaks the plane | Vendor or commit `Cargo.lock`; build with `--offline` in CI |
| `rusqlite 0.32` **bundled** | Build-time | Compiles SQLite from source → needs a **C toolchain in the build image**. Alpine/musl + `cc` + `perl`. This is the most likely build failure. | Verify in the `media-search` base image before committing to it; otherwise move to `features=["bundled"]` with `cc` preinstalled, or vendored SQLite |
| Alpine container `hashsucker-media-search-1` (cargo 1.96.1, uid=1000 `node`, non-root) | Build-time | The only toolchain that currently builds the plane. `docker cp` **silently fails** on this Windows path — code must ship by **tar-pipe** | Document the tar-pipe in the build stage; do not rely on `docker cp` |
| `playback-bench` @ `791885a` | Test-time | Separate repo, not a submodule. If it drifts, proofs silently lose meaning | Pin by commit in CI; never auto-update |
| Local `hy4-data/{discovery,baseline}/` (1.7 G each) | Test-time | Live `-wal`/`-shm` present; a bare `.db` copy loses committed rows | Checkpoint before copying; never treat as a repo artifact |
| TorBox + Real-Debrid API keys (`TORBOX_API_KEY`, `REALDEBRID_API_KEY`) | Runtime | Already in host `compose.yaml` + `.env`; must reach the Rust child | Pass through explicitly — the plane reads them itself (`ApiKeys::from_env`) |
| Live TorBox CDN (for `SLICE35_FAULT_*` live runs) | Test-time | Live 429 behavior is nondeterministic | Keep deterministic fault gates as the CI gate; live runs are supplementary |
| `frankenstein` workspace itself | Provenance | If deleted, `control-plane-daemon/{server,store}.mjs` — the **only executable spec of the S-1 contract** — is lost | Port the contract (§1.3) before deleting; capture S-1 in a committed test fixture |

---

## 6. Cleanup inventory

All cleanup happens **only after `m3-north-db` is pushed and proven resumable**
(amendment 1 — it is the branch we push, not a new one). Amendments 2 and 3
converted several "permanent" entries into **deferred re-evaluations**.

### 6.1 Immediate / unconditional

| Target | Where | Precondition |
|---|---|---|
| `hy4/` (TAP dumps, `p3-*`, backups, `commit*.msg`, 12 probes, `scratch/`) | `C:\src\hashsucker\hy4\` | None — no continuing dependency |
| `hy4-artifacts/` | `C:\src\hashsucker\` | None |
| `hy4-data/{downloads,importer,queue,requests,strm,vfs}/` | `C:\src\hashsucker\` | Confirm nothing is a symlink target from compose |
| `frankenstein/src/lib/frankenstein/` (12 files), `frankenstein/package.json`, `frankenstein/test/` | WorkBuddy workspace | After the bakeoff *conclusion* is restated in the classification (it already is, §1.2) — the findings doc is no longer a precondition |
| `frankenstein/control-plane-daemon/` | WorkBuddy workspace | **Only after S-1 ships and a contract test exists** (ladder item 3 green) |
| `frankenstein/_real_src/` | WorkBuddy workspace | Immediate — stale copies, zero value |
| `frankenstein/rust-data-plane/scratch/proofs/` | WorkBuddy workspace | Superseded by `playback-bench/src/slice475/` |
| Superseded host south files (§4, ~417 KB) | `media-search/src/` | Only after the **§7 ladder** is green — **not** after a 4.75 re-run |

### 6.2 Deferred re-evaluation (amendment 2 — docs)

| Target | Disposition | Re-evaluate against |
|---|---|---|
| `MERGE-PLAN.md` | **delete** — old planning doc, superseded by this classification | Does it state anything not already in §1–§5? If no, delete. |
| `architecture-freeze-slice0.md` | likely delete | North/south split + MOTION-vs-TRUTH are now authoritative in `HY4-SOUTH-BASELINE.md` §A |
| `SLICE4-PROOF-CLOSURE.md`, `SLICE45-PROOF-CLOSURE.md` | likely delete | Describes cache generations that no longer exist in the tree |
| `slice3-report.md`, `slice3.5-report.md` | likely delete | Retain only sections backing a behavior still asserted by ladder items 5–7 |
| `moonshot/09-mycelium-spore-forensics.md` | likely delete | Needs a concrete continuing dependency |
| `moonshot/10-phase2-bakeoff-findings.md` | likely delete | Conclusion already preserved in §1.2 |
| `moonshot/{00,01,02,03,04,05,08}-*.md` | likely delete | Redundant moonshot notes are not permanent by existence |

### 6.3 Deferred re-evaluation (amendment 3 — data)

| Target | Disposition | Re-evaluate against |
|---|---|---|
| `hy4-data/discovery/` (1.7 G) | **retain** — expected continuing runtime state | — |
| `hy4-data/baseline/` (1.7 G) | **re-evaluate, then delete if redundant/lab-only** | Does any live path read it? If not, delete after the branch is functional. **Not** a never-delete entry. |

### 6.4 Never delete

`hy4-data/discovery/`, `.env`, `playback-bench` (all of it, external),
`docs/moonshot/{06-zurg-re.md, 07-plex-vfs-io-forensics.md}`,
`TRANSPLANT-MAP.md`, `SLICE475-CLOSURE.md`,
`movie-webdav.js`, `tv-webdav.js`, `provider-accounting.js`,
`alternate-fallback.js`, `source.js`, `torbox-inventory.js`,
`lib/providers/errors.js`.

**Removed from this list by amendment 3:** `hy4-data/baseline/`.
**Removed from this list by amendment 2:** `frankenstein/docs/` as a whole —
only two of its files are permanent retainers (§1.4).

---

## 7. Transplant proof ladder (amendment 4)

**Slice 4.75 is closed. It is not the transplant acceptance gate.** A–H + L +
L2 + M are **not** re-run merely because the implementation moved.
`playback-bench` remains valuable and independent, and its assertions are
**never relaxed to obtain green** — but transplant proof targets *new
integration risk*, not the re-proof of every historical property.

Run a historical proof only if a **concrete integration failure** gives reason
to suspect that specific behavior regressed.

| # | Ladder item | What it proves | Gate |
|---|---|---|---|
| 1 | Rust/host build succeeds | Toolchain + `rusqlite bundled` + `axum =0.7.5` resolve in the real host image (retires blocker **B-4**) | blocking |
| 2 | Integrated runtime/container starts with **real host config and existing data paths** | S-2/S-3/S-4 wiring; no lab-only env is required | blocking |
| 3 | **S-1 control endpoint returns the exact durable TorrentFile + provider coordinates expected by Rust** | The north→south identity projection is byte- and shape-correct, including `schemaVersion` stamping | blocking |
| 4 | **New MULTI-TorrentFile service shape:** two distinct TorrentFiles requested concurrently, with no process-global identity bleed and no cross-file cache/capability contamination | The **single largest transplant risk** — step 6 of the order replaced a process-global `TORRENT_FILE_ID` with per-request identity. Proof B (single-flight) and the 4.75 cache proofs were all written against a one-file process and **cannot** catch this. | blocking |
| 5 | One **real TorBox** arbitrary Range → exact status / length / bytes | Byte exactness through the new seam against a live provider | blocking |
| 6 | One **real Real-Debrid** arbitrary Range → exact status / length / bytes, **if that provider path is ready in this transplant** | Conditional. Do not block the transplant on RD if the RD path is deferred; record it as deferred rather than passing vacuously. | conditional |
| 7 | A nontrivial **follow-up Range/seek succeeds on the same logical file** | Mid-stream position handling survived the router rewrite (`window_slice` + span assembly) | blocking |
| 8 | A file-warm **cached region survives Rust/data-plane process restart without provider traffic** | Cache is durably promoted and re-discovered; nothing regressed to a provider round-trip | blocking |
| 9 | **`playback-bench` bounded black-box smoke, where useful** | Independent confirmation, used deliberately | optional / targeted |

**Notes on the ladder.**
- Item 4 is the one with no historical analogue. Everything in Slice 4.75 was
  proven against a process that could only ever serve one TorrentFile; the
  multi-file rewrite is new, unproven code by construction.
- Item 6 must not be silently skipped. If the RD path is not ready in this
  transplant, record it as **deferred with a stated reason** — a skipped item
  that reads as green is the same vacuous-proof hazard already seen four times
  in this project.
- Item 9 is "where useful", not "always". `playback-bench` is the oracle of
  last resort for investigating a failure, not a gate to pass.

---

## 8. Blockers

Only concrete blockers that prevent *beginning* the transplant.

1. **B-1 — S-1 control endpoint does not exist (hard blocker on step 4, not on steps 1–3).**
   `search_code("data-plane repo:peedubyah/hashsucker")` returns **0 hits**.
   The Rust plane refuses to boot without it (`main.rs:1283`,
   `std::process::exit(2)`). Steps 1–3 (branch, docs, pure modules) are
   unblocked; step 4 onward is not. **Not a blocker for starting.**

2. **B-2 — the plane is single-TorrentFile (blocker on step 6).**
   `TORRENT_FILE_ID` is a required process-wide env var and control is
   fetched once at boot. Production serves N files concurrently. This is a
   real design change, not a wiring change, and it is the reason `main.rs`
   splits. **Not a blocker for starting** (steps 1–5 are unaffected).

3. **B-3 — the canonical workspace is on the wrong branch for the transplant.**
   `C:\src\hashsucker` is on `hy4-frankenstein-moonshot` @ `f524068`, which is
   **local-only**. Amendment 1 makes `m3-north-db` the convergence branch, so
   step 2 must check out the existing remote `m3-north-db` in that workspace.
   That is a **branch switch in a directory whose sibling `hy4-data/` holds
   3.4 G of live DB state** — which is exactly why amendment 3 protects both
   stores and keeps them at the same physical root instead of copying them.
   A task, not a blocker — but it is the riskiest single step in the order.

4. **B-4 — `rusqlite` bundled build in the host image is unverified (potential blocker on step 3).**
   No evidence yet that the `media-search` base image can compile bundled
   SQLite. Should be checked **early** — it can invalidate the crate choice.
   Now doubles as **ladder item 1** (§7), which is a *blocking* gate.

**No blocker prevents beginning.** Recommended start: step 1 (verify in place),
then the B-4 spike (retires a blocking ladder item), then steps 2–3.

---

## 9. Notes

- `HY4-SOUTH-BASELINE.md` §F states `media-search/src/api/` has "4 files" and
  then lists 5; §D.14/§G place the canaries in root `scripts/`, but remote
  root `scripts/` contains 5 unrelated files and the canaries are under
  `media-search/scripts/`. Per instruction, **not fixed** — neither affects
  classification.
- Remote root `.audit-historical-prior-*.md` (2 files) **are tracked**, even
  though §G says `.audit-*.md` are gitignored — that rule is scoped to
  `media-search/.audit-*.md`. Recorded here; no action.

— end of Phase 1 classification —

# P20 — Final Convergence and Merge Handoff

**Branch:** `m3-north-db`
**Verdict:** `MOONSHOT READY TO MERGE`
**Scope:** convergence only. No features added, no VFS experiments, no host/
network/Plex changes, no TTFB/prefetch/provider tuning.

This is the single authoritative graduation record for the `m3-north-db` line.
It supersedes the individual P4–P19 tranche documents, which were removed from
the branch during convergence and remain recoverable in git history.

---

## 1. Frozen architecture

The north/south split is settled. **Node owns durable truth; Rust owns motion.**

### Node (media-search)

| Responsibility | Notes |
|---|---|
| Durable identity | Release, TorrentFile, ProviderPlacement, ProviderFile |
| Control-plane truth | SQLite; authoritative for every durable decision |
| Discovery and ranking | Candidate discovery, scoring, selection |
| VFS publication | WebDAV surface; Node remains the VFS authority |
| Persisted-candidate fallback | Fallback served from durable state, never from a runtime guess |

### Rust (hy4-data-plane)

| Responsibility | Notes |
|---|---|
| Provider execution | All provider I/O happens here |
| DeliveryCapability runtime lifecycle | Created, reused, reacquired, evicted — **never persisted** |
| TorBox / Real-Debrid byte delivery | The only byte path |
| Same-TF recovery | Slot-level recovery within one TorrentFile |
| Range serving | Byte-exact `Content-Range` on the authoritative size |
| Retries, rate limiting, circuit breaker | Per-provider, at the provider boundary |
| Cache and coalescing | Sparse fixed-grid chunk cache (8 MiB chunks) |
| Playback intelligence | Prefetch and seek reprioritization; default on, mode `auto` |

S-1 is the seam: `GET /api/data-plane/files/:tfId` (see
`S1-CONTROL-CONTRACT.md`). Node answers; Rust consumes.

---

## 2. Frozen durable identity

Identity is a tuple, never an index or a name.

| Entity | Identity |
|---|---|
| Release | `infoHash` |
| **TorrentFile** | `infoHash` + `internal_path` + exact positive `size` |
| ProviderPlacement | Provider/account-scoped durable placement |
| ProviderFile | Exact provider-owned file mapping |
| DeliveryCapability | **Runtime-only.** Not persisted by design. |

Two rules follow from this and are enforced in code:

- Never match on file index, on filename alone, or on size alone.
- A missing or zero `size` makes a TorrentFile unpublishable — size is
  structural, not an optional attribute.

The live database confirms the model is real, not aspirational: `infoHash`
`06bfe49f…` carries two distinct TorrentFiles — the 34,319,716,114-byte feature
and a 36,221-byte `output.jpg`. Same info hash, different identity.

> Note for anyone reading the schema: the live column is `internal_path`. There
> is no `canonical_internal_path` column.

---

## 3. Proven capabilities

### Frozen specimen

| Field | Value |
|---|---|
| `torrent_file_id` | `tf_5de34a78-0a1a-410b-8de5-76ded2680e7d` |
| `infoHash` | `06bfe49fdc99ad0c6fef1f761382a8181490e456` |
| size | 34,319,716,114 bytes |

### Reference byte SHAs (sha256, first 12 hex)

| Region | Range | SHA |
|---|---|---|
| front | `0–1048575` | `52daa79d4aff` |
| mid | `10485760–11534335` | `977afd3ce097` |
| tail | `34318667538–34319716113` | `11c81ee706e0` |

These three values are the byte-correctness contract. Every provider, every
failover direction, every restart must reproduce them exactly.

### Proven

| Capability | Evidence |
|---|---|
| TorBox exact bytes | P13-2: three ranges 206, all SHAs match; restart byte-stable |
| Real-Debrid exact bytes | P14-2: RD-only three-range proof matches the TB-only reference SHAs |
| Same-TF shielding, TB→RD | P14-4 and P15-2: TB slot attempted and failed, RD slot served 206 |
| Same-TF shielding, RD→TB | P14-5 and P15-3: RD slot attempted and failed, TB slot served 206 |
| Both-exhausted boundary | P14-6 and P15-4: `502 PROVIDER_EXHAUSTED` carrying the frozen tfId |
| Stale runtime recovery | P13-8 and P14-7: fresh acquire after staleness, SHAs unchanged |
| Restart / reacquire | P13-8: all three ranges byte-identical pre vs post restart |
| Sparse fixed-grid cache | `chunk_size` 8 MiB; warm TTFB 7–11 ms vs cold 565–1638 ms |
| No provider API storm | 4 range requests → 1 capability acquisition, 3 reuses, 2 provider API calls |
| Automatic RD placement lifecycle | P19; live DB shows `realdebrid` / `5VFSK7HKPITZW` `ready` alongside `torbox` / `88408468` `ready` |
| Prefetch default-on, mode `auto` | `playback_intelligence.enabled: true, mode: "auto"`, kill switch `PREFETCH_ENABLED=0` retained |
| DeliveryCapability is runtime-only | No `delivery_capabilities` table exists; only `provider_delivery_evidence` |

### P20 live regression (re-run after a clean restart)

```
S-1                   200   providers: realdebrid=ready, torbox=ready
front-1MiB            206   1048576/1048576  sha=52daa79d4aff   ttfb=565ms
front-1MiB (warm)     206   1048576/1048576  sha=52daa79d4aff   ttfb=10ms
mid-1MiB @10MiB       206   1048576/1048576  sha=977afd3ce097   ttfb=9ms
tail-1MiB (far seek)  206   1048576/1048576  sha=11c81ee706e0   ttfb=7ms
```

All three SHAs reproduce the frozen reference exactly, before and after restart.
`breaker_opens: 0`, `rate_limited: 0`, `limiter_waits: 0`.

---

## 4. Proof-only gates — retained as diagnostics

Five environment gates exist in the Rust data plane. **All are strict no-ops
when unset**, and none is set in `compose.yaml`, `compose.override.yaml`, or
`.env.example`.

| Gate | Location | Purpose |
|---|---|---|
| `HY4_FORCE_PROVIDER` | `main.rs` | Restrict a tfId to an explicit provider allowlist |
| `HY4_FORCE_FAIL_PROVIDER` | `main.rs` | Deny one provider before the manager sees it |
| `HY4_FORCE_EXHAUST_TFID` | `serve.rs` | Force `PROVIDER_EXHAUSTED` for a tfId |
| `HY4_FORCE_SLOT_ORDER` | `manager.rs` | Make slot order deterministic for bench runs |
| `HY4_FORCE_SLOT_FAILURE` | `manager.rs` | Inject a runtime slot failure inside the manager |

**Decision: KEEP all five.** Each is `if let Ok(spec) = std::env::var(..)`, so
production behaviour is bit-identical with them unset. They touch no durable
state and issue no provider call for a denied slot. They are the only way to
reproduce the shielding and exhaustion proofs without a real provider outage,
and removing them would require code changes the convergence explicitly forbids.
They must never be set in production.

---

## 5. Line-ending fence

`core.autocrlf=true` on a Windows host smudges every text file to CRLF on
checkout. That is actively dangerous here: 35 `.sh` files — including every
`torbox-importer/scripts/*.sh` — execute inside Linux containers, where CRLF
produces `\r: command not found`.

A minimal `.gitattributes` was added, covering only paths that are executed or
compiled inside a Linux container:

```
*.sh text eol=lf
*.rs text eol=lf
```

Proven non-invasive: `git check-attr` reports `text: set, eol: lf` for
`scripts/smoke-test.sh`, `torbox-importer/scripts/process-movie.sh` and
`data-plane/src/main.rs`, while `docs/architecture.md` and `compose.yaml`
stay `unspecified`. Adding it produced zero modification and zero content diff.
This is deliberately **not** a repo-wide normalization.

---

## 6. Deferred work

Stated plainly — none of this is done.

| Item | Status |
|---|---|
| **Real Plex product-path validation** | **Not done.** P16 was blocked; no Plex client has ever driven this stack. The Windows host cannot reach the deployment target and firewall changes are out of scope. Needs a sane topology. |
| **Future VFS alternative experimentation** | P18 verdict: keep Node WebDAV, reject the thin Rust WebDAV surface. Revisit only deliberately. |
| Zurg-derived semantics not adopted | `mtime` = provider completion time, the repair path, and TorBox-shaped semantics remain unimplemented |
| Prefetch not documented in operations | `PREFETCH_ENABLED` default `1`, mode `auto`, kill switch `0` — currently documented only in `hy4-data-plane/bench/p12/README.md` |
| `activateBinding` warning | Pre-existing and expected: the handoff binds the TorBox coordinate whose inventory expired 2026-09-02; `store.js` fails closed by design |
| 13 `node --test` EBUSY failures | Windows-only, pre-existing, unrelated to this line |
| Lifecycle / observability debt | Non-blocking; not addressed here |

---

## 7. Merge forecast

| Item | Value |
|---|---|
| Branch tip | see final commit on `m3-north-db` |
| Merge base with `main` | `9f36481e541eb9e9f04659ff76522dd51a0cad4a` |
| Commits: `main` ahead | 12 |
| Commits: `m3-north-db` ahead | 31 |
| Files changed on `main` | 28 |
| Files changed on `m3-north-db` | 142 |
| **Overlapping files** | **0** |
| **Conflicts** | **0** (`git merge-tree` exits 0, no conflict entries) |

### Classification

- **A — take `m3-north-db` wholesale:** everything it touches. No file it
  changes is touched by `main`, so no averaging is required.
- **B — take `main` (unrelated):** its 28 files are Real-Debrid downloads
  correlation, evidence reconciliation, quality features and size analytics —
  mostly new files, plus additive edits to `media-request.js`, `cache.js`,
  `canonical.js`, `ranking.js`.
- **C — semantic merge:** none required at the file level.

### Semantic risk assessment (low)

`main` modifies four modules `m3-north-db` leaves untouched. Its changes are
purely additive (`cache.js` +1538/−45, `canonical.js` +22, `ranking.js` +13,
`media-request.js` +18) and every export signature is unchanged — e.g.
`createDiscoveryCache({ dbPath = ':memory:', database = null } = {})` is
identical at base and on `main`. The only `m3-north-db` file importing any of
them is `media-search/src/server/app.js`, which `main` does not touch.

Deletions on `m3-north-db` (`HY4-SOUTH-BASELINE.md`, three
`handoff/movie-importer-bridge/original/scripts/*`, and three
`tt7137906`/`tt7366338` preflight scripts) are not modified on `main`, so
nothing is resurrected by the merge.

### Recommended strategy

Merge `m3-north-db` into `main` with default strategy; expect a clean result.
`m3-north-db` is authoritative for every file it touches; `main` contributes
only unrelated work. Do not reconcile architectures — take `m3` wholesale.

After merging, run the regression in §3 against the merged tree before
declaring the merge good.

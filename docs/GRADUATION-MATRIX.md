# HashSucker graduation matrix (Phase C exit bar)

**Date:** 2026-09-12. **Phase A:** closed as A3 — shared-cap two-lane stays
default OFF with no production-code change (see `handoff/CURRENT.md`,
`docs/ROADMAP.md`, `docs/PRODUCTION-STATE-2026-09-11.md` §15). Experimental
shared-cap scheduling graduates separately and does not block the default-OFF
data plane.

## Evidence legend

- **PROVEN LIVE** — observed against a real provider on the deployed or an
  isolated production-code stack, with byte/metric evidence.
- **PROVEN STRUCTURALLY** — implemented in production code and proven by
  deterministic mock-CDN/fault tests; no live real-provider fault forced.
- **PARTIAL** — one sub-proof is live, another is structural only (accepted
  below where the combination proves the invariant).
- Structural/mock evidence is never promoted to live evidence in this matrix.

Key records: `docs/PRODUCTION-STATE-2026-09-11.md` (PROD), `handoff/CURRENT.md`,
`handoff/DATA-PLANE-SCHEDULER-HANDOFF.md` §4 (T22 isolated-stack live proof),
`docs/black-panther-s1-dual-provider-proof.md` (BP),
`handoff/MAIN-REAL-PLAYBACK-TRACE.md` (RPTR),
`handoff/MAIN-PLEX-FUNCTIONAL.md` (PLEXF),
`data-plane/bench/p12/README.md` + `p12-*-final.txt` (P12 soak),
`data-plane/bench/p13/p13-*.mjs` + `scripts/p13-*-driver.sh` (P13),
`data-plane/bench/p14/p14-*.mjs` + `scripts/p14-*-driver.sh` (P14),
`data-plane/bench/p15/p15-*.mjs` + `scripts/p15-*-driver.sh` (P15),
`docs/S1-CONTROL-CONTRACT.md` (S1), `docs/CROSS-FILE-KEYING-AUDIT.md` (XKEY),
`docs/architecture.md` §2/§4/§5.

Reference specimens: Black Panther `tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`
(34,319,716,114 B; TB placement 88408468, RD placement 5VFSK7HKPITZW),
Oppenheimer `tf_c3c50dea-9282-4762-86e4-2867283b0917` (PLEXF),
Ted Lasso `tf_46203b5e-2a8d-44f7-9a93-20114c60b24d` (P12 soak).

## Provider-by-provider matrix

| # | Graduation requirement | TorBox | Real-Debrid |
|---|---|---|---|
| 1 | Resolve an eligible provider coordinate for the selected TorrentFile | **PROVEN LIVE** — S-1 projection returns the TB coord (BP P1/P2; RPTR baseline; S1; `scripts/p13-s1-check.py`); live TB-only benches (P13 TB-only, P12 soak on TB placement). | **PROVEN LIVE** — RD-only canary asserts RD-derived 1 MiB SHAs match TB refs via the `/torrents → info → unrestrict/link` path (`data-plane/bench/p14/p14-2-rd-only.mjs`, `scripts/p14-2-driver.sh`); T22 engaged the RD placement live (4 × `realdebrid-1-1` CDN 206s, api delta 0); PROD §5 cold RD run (67,108,864 upstream B, one fresh RD cap, cold regions selected so not cache-inferred). |
| 2 | Expose/mount the selected file through the VFS boundary | **PROVEN LIVE** — VFS selects the TorrentFile and forwards client Ranges to Rust; provider-agnostic after selection (`docs/architecture.md` §4; README current flow). Plex playback of the VFS entry incl. seek and post-restart playback (PLEXF steps 3–8; RPTR WebDAV stat + rclone mount + ratingKey 230 playback; BP P5). | **PROVEN LIVE** — same VFS path serves RD-backed bytes: T22 served 206 Black Panther bytes with `serving-primary provider=torbox` and `standby=realdebrid` ready, both placements `already_warm` via live prewarm (apiDelta 0); P13–P15 RD-gated reads return 206 through the same VFS/data-plane path. |
| 3 | Deliver the exact requested bytes | **PROVEN LIVE** — exact-range cross-provider hash: `bytes=3000000000-3001048575` → SHA-256 `2189218f…9306` identical on TB and RD/VFS (PROD §5); T22 small-range SHA `3E1D8D4C…BFBA99D5` and 64 MiB SHA `A636961A…4EE4C24` == VFS oracle; per-chunk SHAs in P12/P13/P14 logs. Serving path: `data-plane/src/serve.rs`. | **PROVEN LIVE** — same `2189218f…9306` hash for the same exact Range on RD (PROD §5); RD-only 1 MiB SHAs match TB refs `52daa79d4aff / 977afd3ce097 / 11c81ee706e0` (`p14-2-rd-only.mjs`); T22 4 × RD CDN 206s byte-exact. (An earlier misaligned-tail comparison reporting different hashes was a reporting error, not a content mismatch — PROD §5.) |
| 4 | Survive sequential reads, overlap, forward/backward seeks, cancel/reopen | **PROVEN LIVE** — playback-abuse canary passed (PROD §5: sequential, overlapping concurrent, large forward + backward seek, rapid cancel/reopen, hot/cold mix, restart; all ranges exact). RPTR 50-minute forward seek: abort → reprioritize → acquire → resume, T5 879 ms, oracle MATCHES, Plex `playing` no buffering. P12-B seek-heavy (`seek_repri`, no amplification, no latency regression); P12-E interleaved (5 repri, coherent per-TF state). Cold TB overlap probe joined in-flight chunk, no duplicate 8 MiB fill (`handoff/CURRENT.md`). | **PROVEN LIVE** — same playback-abuse canary passed for RD independently (PROD §5; `handoff/CURRENT.md` proven-live). Cancel/reopen + post-cancel reads + hot/cold mix covered per provider (PROD §5 lifecycle + abuse bars). Coalescer is provider-agnostic after TorrentFile identity (`data-plane/src/cache.rs` single-flight; `data-plane/src/serve.rs` run loop). |
| 5 | Restart and reacquire a fresh runtime capability | **PROVEN LIVE** — data-plane restart → fresh cap, stable bytes, no stuck in-flight, no stale reuse, no acquisition storm (PROD §5). P12-D: cache survives (8 chunks), runtime resets, exactly one re-acquire, new chunks fetch upstream (`p12-D-restart-final.txt`; P12 README §2-D). P13-8/P13-9: post-restart S-1 rebuild, same SHA (`p13-8-stale-repair.mjs`, `p13-9-mixed-restart.mjs`). PLEXF steps 1/7/8: restart survives, playback works without repair. | **PROVEN LIVE** — same restart bar passed for RD (PROD §5). RD stale-runtime repair live: `RD_TTL_SECONDS=5`, post-TTL range forces fresh acquisition (`cap.acq`++), 206 with reference SHA, bounded api delta (`data-plane/bench/p14/p14-7-rd-stale.mjs`, `scripts/p14-7-driver.sh`). P13-9 RD-only phase stable across gate cycling. |
| 6 | Repair or reject stale provider state without violating ownership | **PARTIAL (accepted)** — live: restart rebuild from S-1, stale-cap avoidance, no stale reuse (row 5 evidence; RPTR; PLEXF). Structural: forced dead-link (Class C 401/403/404/410) concurrency, dead-cap admission boundary, reclaim, fresh-cap retry, exactly-one retry ownership proven by deterministic mock-CDN tests — `26a05c2` (retry uses fresh cap B), `f809ff3`/`2bbe3ba` (retry ownership), `3cf7a2e`/`a914e32` (dead-cap replacement), `ea9136e`/`466f49e` (slot refresh), `6934fe0`/`bf6397a` (lease reentry), `7c26f93`/`a555462` (cancel/reclaim), `18cceb2` (child lifetime). Sources: `data-plane/src/capability_lease.rs`, `manager.rs` (`reacquire_for_read`), `serve.rs` (`stripe_worker_shared_child`), `transport.rs` (Class C). Deliberately forced real-provider dead-link concurrency was not part of live canaries (PROD §4). | **PARTIAL (accepted)** — same split as TorBox: live restart/stale-avoidance plus RD TTL-expiry reacquire proven live (row 5); forced real-provider dead-link concurrency proven structurally only, via the same provider-agnostic ownership tests and recovery path (`transport.rs` Class C → `manager.rs` single reacquire; `p15-3-rd-to-tb.mjs` exercises RD-slot failure shielding with `HY4_FORCE_SLOT_FAILURE`, fault-injected not provider-forced). |
| 7 | Preserve Release/TorrentFile identity across provider execution | **PROVEN LIVE** — same-TorrentFile same-Range identical bytes across providers (row 3 `2189218f…9306`); TB reference SHAs stable across TB-only/dual/RD-only gates (`p13-4-xprov-identity.mjs`; P13-9). Invariants: schema `(info_hash, internal_path)` uniqueness + immutable size, Rust key `(infoHash, canonical_path, size)` / SHA-256 physical key (PROD §3; XKEY; `data-plane/src/torrent_file_identity.rs`, `cache.rs`); S1 projection + target-size match (S1; `data-plane/src/control.rs`); `docs/architecture.md` §2/§5. | **PROVEN LIVE** — identity is a cross-provider property: RD bytes equal TB bytes for the same TorrentFile+Range (row 3). Same invariants and sources apply symmetrically; Rust never chooses another Release, only same-TorrentFile provider execution (PROD §2; `handoff/CURRENT.md` frozen boundaries). |
| 8 | Avoid API storms and handle throttling through bounded limiter/breaker behavior | **PARTIAL (accepted)** — live no-storm: `layer_A_api.requests`=1 per P12 pattern, `breaker_opens`=0, `retry_after`=0, `recovery.attempts`=0 (P12 README §3); P14-8 api sanity (`cap.acq`=1, reuse=4, bounded api, breakers 0; `p14-8-api-sanity.mjs`); PLEXF step 9; PROD §5 (no storm). Structural throttle handling: per-cap `Semaphore(1)`, per-(provider,account) breaker, negative-cache anti-storm, Class A/B/C recovery budgets (`MAX_SAME_CAP_RETRIES=3`, `MAX_REACQUIRES=1`), `Retry-After` honored, headerless-timeout zero-cooldown same-cap retry (`data-plane/src/capability.rs`, `manager.rs`, `transport.rs`; `47c17bb`; `3c1a990` metric semantics). No live forced-429 proof; none required (see gaps). | **PARTIAL (accepted)** — same split: live no-storm on RD paths incl. cold 67 MiB single-cap run (PROD §5); RD acquire triple bounded (`/torrents`+`info`+`unrestrict/link`, P14-7 api-delta check). Breaker/limiter/`Retry-After` are per-(provider,account) production code shared by both providers (same sources as TorBox). No live forced RD throttle proof; none required. |

## REMAINING GRADUATION GAPS

**Zero true blockers.** Every graduation requirement is satisfied per provider:
rows 1–5 and 7 are proven live; rows 6 and 8 combine live behavior with
deterministic structural proof of the exact fault/throttle paths that live
canaries deliberately did not force.

Explicitly not gaps (do not manufacture canaries for these):

- **Forced real-provider dead-link concurrency fault.** Deterministic fault
  ownership (exactly-one retry, Dead admission boundary, fresh-cap
  reacquire) plus live restart/reacquisition and live stale-expiry repair
  already proves the invariant adequately. A forced 401/403/404/410 against
  a real provider account would risk the account/provenance without changing
  the ownership conclusion.
- **Forced real-provider 429/throttle proof.** Bounded limiter/breaker,
  negative-cache anti-storm, `Retry-After`, and recovery budgets are
  implemented and tested; every live canary shows zero storm behavior.
  Forcing a real throttle is operational risk with no shipping decision
  attached.
- **Lifecycle hardening, shared-cap scheduler, 8 MiB grid.** No concrete
  defect reopens lifecycle work; Phase A (A3) closed shared-cap tuning; the
  grid changes only on playback-shaped evidence (PROD §7), which does not
  exist today.

## NEXT SHIPPING SLICE (exactly one)

**Phase B evidence pass: quantify small-range/seek upstream cost in real
playback-shaped telemetry — measurement only, no grid or scheduler change.**
Bounded before/after metric deltas with known cache state over real Plex/VFS
sessions; compare `bytes_upstream / bytes_requested_total` against the known
2.77× small-probe observation (PROD §7) and decide whether a material,
repeatable user-visible cost remains. Default outcome is no change.

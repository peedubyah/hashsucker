# HashSucker Data-Plane Scheduler Handoff

> **Active handoff:** use [`CURRENT.md`](CURRENT.md) for the next action.
>
> **Historical milestone:** this records scheduler graduation and its original
> proof. For the current production checkpoint, later lifecycle hardening,
> verified canaries, metric semantics, and active roadmap, use
> [`../docs/PRODUCTION-STATE-2026-09-11.md`](../docs/PRODUCTION-STATE-2026-09-11.md).

**Status:** graduated to `main` production. The scheduler code is now part of
HashSucker production; default-OFF paths are not thereby enabled. The original
development branch (`m3-north-db`) is no longer required as a live development
branch (see §6).
**Scope rule for this branch:** additive transplant only. No scheduler
redesign, no threatens to existing recovery ordering, no metrics project,
no live-provider benchmarking.

The scheduler was verified by the T21 integration gate (86 Rust lib tests,
`cargo check --bins`, 59 Node tests) and the T22 live proof below. This
document updates none of that behavior.

---

## 1. Final architecture

**Node owns durable truth; Rust owns motion.** Seam is S-1:
`GET /api/data-plane/files/:tfId` (see
`docs/S1-CONTROL-CONTRACT.md`). Node answers; Rust consumes.

### Node (media-search)

| Responsibility | Location |
|---|---|
| Durable Release / TorrentFile / ProviderPlacement truth (SQLite control plane) | `src/lib/control-plane/store.js` (untouched) |
| Second-placement readiness (recognize durable second placement, prepare only when missing) | `src/lib/control-plane/second-placement.js` (T7) |
| Playback redundancy activation (per-TF flight: intent → ensurer → prewarm caller; structural gates, no timing guesses) | `src/lib/control-plane/playback-redundancy.js` (T9; adapts proven P2I/P2K) |
| Validated prewarm client (calls the Rust prewarm endpoint) | `src/lib/control-plane/prewarm.js` (T6) |
| Playback Range intent wiring + request-scoped serving-primary reporting (fire-and-forget, never breaks bytes) | `src/lib/vfs/movie-webdav.js`, `tv-webdav.js`, `src/server/app.js` (T8/T10) |
| Alternate-Release fallback | pre-existing persisted-candidate path (untouched): only on classified `PROVIDER_EXHAUSTED`, never on transient Rust failure |

### Rust (data-plane)

| Responsibility | Location |
|---|---|
| Runtime-only DeliveryCapability (created, reused, reacquired, evicted — never persisted) | `src/capability.rs`, `src/manager.rs`, `src/provider.rs` (preserved) |
| Provider byte delivery (TorBox / Real-Debrid Range I/O, retries, limiter, breaker) | `src/transport.rs` (preserved; +3 additive accessors only) |
| Fixed-grid cache (8 MiB chunks) + per-chunk single-flight coalescer + staging | `src/cache.rs` (untouched) |
| Same-TF recovery (same-cap retry, dead-link reacquire-once, resume at offset) | `src/transport.rs` (untouched policy) |
| Warm prewarm / runtime slot refresh / prewarm endpoint (one refresh + one retry max) | `src/manager.rs` (T3/T4), `src/serve.rs` `prewarm_placement` (T5) |
| Two-lane scheduler (fixed split, stealing, retirement, auto, promotion, hedge, replacement, vacancy seam) | `src/serve.rs` (T11–T20, all default-OFF gates) |

---

## 2. Frozen identity rules

| Entity | Identity |
|---|---|
| Release | `infoHash` |
| **TorrentFile** | row identity: `infoHash` + `canonicalInternalPath`; exact positive `size` is immutable and is also included in Rust's cache/single-flight key |
| `torrent_files.id` | routing UUID only — forensic/logging, never a cache key |
| ProviderPlacement | durable, provider/account-scoped placement |
| DeliveryCapability | **runtime only** — signed URL, never logged/persisted/used as identity |
| Provider | execution metadata only — never byte identity |

Consequences enforced in code (T1 `fill_torrent_file_id` is the single
plan/fill constructor): the cache/coalescing/staging namespace is the
durable tuple; provider never enters it; Rust never chooses another
Release (fallback across TorrentFiles is Node's classified decision only).

---

## 3. Final scheduler behavior (landed, all default-OFF unless noted)

- **Warm same-TF standby reservation** (T2): same-slot first, then same-TF
  cross-provider; usable + free only; returns the slot-authoritative
  durable key. The reservation — never a pool peek — is every
  availability check; no cold acquisition is ever spent to create concurrency.
- **Prewarm + runtime slot refresh** (T3–T6): explicit warm-up of existing
  slots; one refresh + one retry at the endpoint; Node validated caller.
- **Playback-intent-triggered redundancy** (T9/T10): first qualifying
  foreground Range demand per TF schedules one bounded ensure → prewarm
  chain; the Range never awaits it. Standby selection needs a valid
  request-scoped primary attribution (cache-hit demands contribute
  nothing); a T7-created placement is the standby by construction.
- **Truthful request-scoped serving attribution** (T8): initial provider /
  resource / file / cap-id headers on provider-backed 206s; absent on pure
  cache hits (truthful absence, never a guess).
- **Fixed two-lane disjoint fill** (T11): first-span consecutive missing run
  splits ceil/floor across two pinned warm caps; ordered emission through
  cache/staging; max 2 lanes.
- **Work stealing** (T12): per-chunk fills over a shared coordinator, own
  front first, far-end steal iff donor holds ≥ 2 unstarted; head streams,
  rest emit durably.
- **Slow-lane retirement** (T13): relative useful-throughput observation
  (two independent clean samples, contamination latches, producer-change
  resets); retired lane finishes active, then gets nothing; survivor drains
  with the ≥ 1 gate.
- **Bounded automatic engagement** (T14): explicit TWO_SPAN or
  (AUTO + run ≥ min-chunks). With a distinct warm standby, AUTO without
  STEAL selects the fixed path; without one, shared fallback also requires
  `SHARED_CAP`, otherwise execution remains single-lane.
- **Sustained-low-throughput promotion** (T15/T16): detector (useful bytes
  over monotonic time from first byte, contamination boundary) +
  two-observation policy; warm-only handoff resuming at offset, else
  continue with no budget spent.
- **Bounded first-valid-wins hedge** (T17): one election per fill on policy
  arming; per-attempt staging gates + manual exactly-once winner staging;
  loser dropped (never a failure); failed race keeps its cap for promotion.
- **Retired-lane replacement** (T18): same worker rebinds once to a warm
  same-TF cap excluding survivor + retired ids.
- **Terminal-failure replacement** (T19): vacancy only after existing
  recovery exhausts/declines; failed record truncates delivery in order and
  is never refetched; emitter joins workers so the remainder drains durably.
- **Shared retired/terminal vacancy seam** (T20): distinct causes, one
  transition (`declare_vacancy`) and one predicate (`is_vacant`).
- Invariants: maximum two active lanes per scheduled missing run; zero cold acquisition for
  engagement, stealing, retirement drain, promotion, hedge, and replacement.

---

## 4. T22 live proof (2026-09-09, unmodified tip `04d2458`)

This was a live proof against real provider bytes in an isolated
production-code stack, not the deployed production stack. It exercised two
distinct capabilities, not the later shared-cap lease path.

Isolated transplant stack (fresh images, fresh cache volume, copied DBs;
production stack untouched) against the safe control:

- control TF: tt1825683 / `tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`
- TB placement 88408468, RD placement 5VFSK7HKPITZW (both durable, ready,
  same exact TF; nothing created)

| Proof | Result |
|---|---|
| small range (chunks 12–13, 16 MiB, below threshold) | single producer (+1 upstream Range/span/decision); exact bytes; SHA `3E1D8D4C…BFBA99D5` == production VFS oracle SHA |
| 64 MiB qualifying range (chunks 20–27) | two lanes engaged: 8 disjoint per-chunk Ranges, CDN attempts 4 × `torbox-1-0` + 4 × `realdebrid-1-1` (all 206); **api delta 0**; attribution torbox/88408468/1 (truthful initial selection); SHA `A636961A…4EE4C24` == oracle SHA |
| reread (same 64 MiB) | 206 with no attribution headers (truthful cache-hit absence); zero upstream (cdn/spans/decisions/api unchanged); +67108864 bytes_local; SHA identical |
| redundancy | VFS playback demand → `[t9] serving-primary … valid=true provider=torbox` → `[t9] activation … result=ready standby=realdebrid … t7=already_ready:0 prewarm=warmed`; both placements `already_warm` via the live prewarm endpoint (apiDelta 0, same durable key); 206 Black Panther bytes, no alternate Release, no fallback |

---

## 5. Gates

All experimental gates default OFF. Canonical `DATA_PLANE_*` names win over
the listed deprecated `HY4_*` aliases when both are set. Nothing below has a
recommended production value; the measurement defaults shown are the proven
experimental ones, not production thresholds.

| Gate | Default | Meaning when ON |
|---|---|---|
| `DATA_PLANE_PLAYBACK_REDUNDANCY=1` (`HY4_PLAYBACK_REDUNDANCY`) (Node) | OFF | playback-intent redundancy activation |
| `DATA_PLANE_ACTIVE_ACTIVE_TWO_SPAN=1` (`HY4_ACTIVE_ACTIVE_TWO_SPAN`) | OFF | explicit two-lane entry |
| `DATA_PLANE_ACTIVE_ACTIVE_AUTO=1` (`HY4_ACTIVE_ACTIVE_AUTO`) | OFF | bounded automatic entry |
| `DATA_PLANE_ACTIVE_ACTIVE_MIN_CHUNKS=n` (`HY4_ACTIVE_ACTIVE_MIN_CHUNKS`) | 4 | minimum missing chunks for AUTO entry (≥ 1) |
| `DATA_PLANE_ACTIVE_ACTIVE_SHARED_CAP=1` (`HY4_ACTIVE_ACTIVE_SHARED_CAP`) | OFF | shared-cap fallback; exact fixed/steal predicates are in the canonical production-state document |
| `DATA_PLANE_ACTIVE_ACTIVE_STEAL=1` (`HY4_ACTIVE_ACTIVE_STEAL`) | OFF | steal path (needs TWO_SPAN or qualifying AUTO) |
| `DATA_PLANE_ACTIVE_ACTIVE_RETIRE_SLOW_LANE=1` (`HY4_ACTIVE_ACTIVE_RETIRE_SLOW_LANE`) | OFF | slow-lane retirement (needs steal path) |
| `DATA_PLANE_ACTIVE_ACTIVE_RETIRE_RATIO=f` (`HY4_ACTIVE_ACTIVE_RETIRE_RATIO`) | 4.0 | sibling avg must exceed `f × slow` (finite, > 1) |
| `DATA_PLANE_ACTIVE_ACTIVE_REPLACE_LANE=1` (`HY4_ACTIVE_ACTIVE_REPLACE_LANE`) | OFF | warm replacement of vacant lanes (needs steal path) |
| `DATA_PLANE_HEDGE_ENABLED=1` (`HY4_HEDGE_ENABLED`) | OFF | one bounded hedge election per fill on policy arming |
| `DATA_PLANE_LOW_THROUGHPUT_BPS=n` (`HY4_LOW_THROUGHPUT_BPS`) | unset/0 = inert | sustained-useful-bytes floor arming detector + promotion |
| `DATA_PLANE_LOW_THROUGHPUT_WINDOW_MS=n` (`HY4_LOW_THROUGHPUT_WINDOW_MS`) | 10000 | bounded observation window |
| `DATA_PLANE_LOW_THROUGHPUT_BLOCKED_MS=n` (`HY4_LOW_THROUGHPUT_BLOCKED_MS`) | 50 | send-blocked hygiene threshold |
| `DATA_PLANE_CROSS_PROVIDER_STANDBY=1` (`HY4_CROSS_PROVIDER_STANDBY`) | OFF | cross-provider same-TF standby; not set by the current compose file |
| `HY4_TEST_ACQUIRE_BASE_URL` / `HY4_TEST_ACQUIRE_FAIL` | unset | test-only stubbed provider edge (never set in production) |
| `PREFETCH_ENABLED=0` | (compose diagnostic) | disables speculative prefetch so demand reads stay attributable |

Pre-existing production/test gates (`HY4_FORCE_PROVIDER`,
`HY4_FORCE_SLOT_FAILURE`, `HY4_FORCE_EXHAUST_TFID`, `HY4_FORCE_SLOT_ORDER`,
`SLICE3/SLICE35_FAULT_*`) are validation scaffolding, never set in
production, and were not touched by the transplant.

---

## 6. m3-north-db dependency check (T23)

Compared against `m3-north-db @ 905da9f` (read-only): every intended
P-slice is transplanted — P2E.1→T1, P2E→T2, P2G→T3, P2H→T4, P2G/H
endpoint→T5, Node prewarm client→T6, P2F→T7, P2J→T8 (P2K structural
gating is adapted inside T9 and was observed live: no attribution on
cache hits, standby selected only after a valid primary report), P2I→T9
(+T10 wiring), P2O→T11, P2P→T12, P2Q→T13, P2R→T14, P2L→T15, P2M→T16,
P2N→T17, P2T→T18, P2U→T19, P2V→T20.

Deliberately not transplanted (out of scope in every T-brief, not
oversights): the P2B/P2C/P2D promotion-coordinator architecture with its
threat deadlines and promotion budgets (this branch achieves the same
ends through fill-local policies + existing reopen paths by design);
P2S decision records and P2M/P2N/P2O event telemetry (no metrics project
by design); P2A latency artifacts and all live benches/proof JSONs
(explicitly excluded; none in this history).

**Conclusion: no intended P1–P2V production behavior remains only on
m3-north-db. The production candidate on `hy4-transplant` is
self-contained; m3-north-db is no longer required as a live development
branch.** (The branch itself is left untouched per task scope.)

---

## 7. What T23 changed

- `data-plane/src/serve.rs`: `retired_side()` (used only by unit
  proofs) is now `#[cfg(test)]`-bounded; production carries no dead
  query surface. No behavior change.
- This handoff document (new).
- Workspace: no tooling junk found (no `.opencode/`, `opencode.json`,
  `.harness-memory/`, `.tmp-tests/`, `.worktrees/`, or stray logs in the
  repo; nothing removed). No benchmark/proof artifacts were ever
  transplanted (verified in T21).
- Note: the task's PRODUCTION BASE REF `fd7a296` resolves in neither the
  transplant nor the source repo; the audit used the actual in-repo
  transplant base `46bde71` (same base as the T21 gate).

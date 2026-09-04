# Slice 3.5 — Transplant Map

Forensic map of the proven Slice 3.5 data plane. Every proven behavior is
listed with its causal files / functions, required dependencies, the
production analog / target seam, what it explicitly does NOT require, and
the proof artifact that established it.

This document is the entry point for a later forensic transplant into the
real HashSucker delivery path. It is intentionally implementation-agnostic
where the production analog is a different language (Node/TypeScript) or
different seam (decrypted-stream contract vs. RangeEngine).

The data plane is six modules in `rust-data-plane/src/`:

| Module | Role | Lines |
|---|---|---|
| `main.rs` | Thin HTTP boundary. Range parsing, AppState wiring, /metrics endpoint. **No business logic.** | 484 |
| `transport.rs` | `ResilientRangeReader` — the logical read/session that owns the current byte position and reopens the provider connection beneath the caller. | 472 |
| `capability.rs` | `DeliveryCapability` runtime, `Breaker`, `parse_retry_after`, `ApiKeys`. The "throttle is not death" lifecycle. | 239 |
| `manager.rs` | `CapabilityManager` — single-flight, pool, bounded negative cache, `reacquire_for_read`, `prunable`. | 527 |
| `provider.rs` | `acquire_torbox` (no-redirect, parses `data`), `list_realdebrid_downloads`. | 418 |
| `metrics.rs` | Three-layer (A=API / B=redirect / C=CDN) accounting + capability lifecycle + limiter/breaker + stage timing. | 249 |
| `control.rs` | Schema-version-gated control fetcher; refuses to run unless the daemon returns `schemaVersion === 1`. | 95 |

Total causal source: **2,484 lines**.

---

## Behavior 1 — Real TorBox CDN 429 survives internally

**CAUSAL FILES / FUNCTIONS**
- `transport.rs::ResilientRangeReader::open_at` — recovery loop owner
- `transport.rs::ResilientRangeReader::apply_transient` — Class B (429/5xx/transport)
- `capability.rs::DeliveryCapability::throttle` — cooldown-only, never expire
- `capability.rs::parse_retry_after` — `Retry-After` header parser
- `manager.rs::CapabilityManager` — single-flight, maxInFlight=1 per capability
- `metrics.rs::Metrics::record_recovery_attempt` / `record_retry_after` — telemetry
- `main.rs::get_file` — fault-gate wiring (the 5 fault env vars all default off)

**REQUIRED DEPENDENCIES**
- Logical byte position owned by the reader (`ResilientRangeReader::pos`)
- Shared throttle state on the capability (`Arc<Semaphore>` + `throttled_until: Mutex<Instant>`)
- `DeliveryCapability` reuse across the cooldown (no expire, no re-mint)
- Per-Range accounting with `recovery.{attempts, max_same_cap_retries, wall_ms_total}`

**PRODUCTION ANALOG / TARGET SEAM**
A Decypharr-style resilient read in the Node `media-search` `getFileStream` path,
backed by a session-shared `SessionThrottleState` keyed on the resolved CDN URL.
The `transport.rs::ResilientRangeReader` is the per-`Readable` instance; the
`capability.rs::DeliveryCapability` becomes a `SessionToken` (or equivalent) that
the `getFileStream` keeps open across the seek storm.

**DOES NOT REQUIRE**
- Byte cache, prefetch, coalescing, ranking
- WebDAV redesign
- Provider preference changes
- TTFB optimization

**PROOF ARTIFACT**
`frankenstein/docs/slice3.5-report.md` §5 (post-fix transient path) and Step 5
post-fix run: real TorBox workload, **1 live CDN 429 occurred and was healed
internally with `api.requests=1`, `client_503=0`, exact bytes preserved**.
Re-run command: `validate-slice35.mjs clean` (live TorBox will sometimes
emit a 429 during the 19-GET workload; behavior is unchanged either way).

---

## Behavior 2 — Concurrent shared throttle gate

**CAUSAL FILES / FUNCTIONS**
- `manager.rs::CapabilityManager` — single-flight `InFlight { Notify, AtomicBool }`
- `manager.rs::Slot::sf_key` — provider+accountScope+TF+resource+file key
- `manager.rs::Slot::caps` — the minted-capability vec (length ≤ target)
- `transport.rs::ResilientRangeReader::ensure_open` — shared permit acquisition
- `capability.rs::DeliveryCapability::limiter` — `Arc<Semaphore>(1)` per capability

**REQUIRED DEPENDENCIES**
- Per-capability `Semaphore(1)` (maxInFlight = 1)
- A single-flight guard around the per-key acquisition so 10 concurrent reads make
  1 `requestdl`, not 10
- The shared capability is reused for all readers — no fan-out into per-reader
  retry/requestdl storms

**PRODUCTION ANALOG / TARGET SEAM**
The `media-search` delivery path has a per-`sessionId` `getFileStream` reader;
the `CapabilityManager` becomes a `SessionManager` (or `InFlightBroker`) inside
`media-search/src/lib/delivery/`. The single-flight key is the
`(provider, accountScope, torrentFile, providerResourceId, providerFileId)` tuple —
identical to `Slot::sf_key`.

**DOES NOT REQUIRE**
- Any of the per-reader caching / coalescing the steering explicitly forbids
- A separate "throttle bus" — the per-capability `Semaphore` already implements it

**PROOF ARTIFACT**
`frankenstein/docs/slice3.5-report.md` §13. Concurrent run: **10 parallel
readers → 1 requestdl, 0 reacquires, 0 client 503, 0 limiter waits**.
Re-run command:
`SLICE35_FAULT_CDN_429_ONCE=1 PROXY_PORT=3509 ... && node
scratch/proofs/slice3.5/validate-slice35.mjs http://127.0.0.1:3509 concurrent`.

---

## Behavior 3 — Stale-capability single-flight reacquisition

**CAUSAL FILES / FUNCTIONS**
- `transport.rs::ResilientRangeReader::apply_dead` — Class C (401/403/404/410)
- `transport.rs::ResilientRangeReader::open_at` — calls `apply_dead` on stale status
- `transport.rs::ResilientRangeReader::recovery.reacquires` — bounded by `MAX_REACQUIRES=1`
- `manager.rs::CapabilityManager::reacquire_for_read` — single-flight reacquire
- `capability.rs::DeliveryCapability::mark_dead` — sets status to `Dead` so the
  `Slot::caps` vec will replace it

**REQUIRED DEPENDENCIES**
- `MAX_REACQUIRES = 1` constant in `transport.rs` (the bound)
- `mark_dead` to evict the rejected capability from `Slot::caps`
- `reacquire_for_read` that returns a fresh `ReservedCapability` for the same
  `Slot::sf_key`, so other readers behind the same single-flight wait

**PRODUCTION ANALOG / TARGET SEAM**
In the Node delivery path: when a CDN status of 401/403/404/410 is observed for
a session, mark the session dead and trigger exactly one `resolvePlayback`
re-issuance for the same `TorrentFile`. All in-flight `getFileStream` readers
behind that single-flight await the same fresh token. The constant 1 is the
contract; do not increase it without re-proving.

**DOES NOT REQUIRE**
- Re-querying for an alternate provider (the `manager.rs` same-TF failover
  exists, but it's only triggered after `reacquire_for_read` exhausts — i.e.
  only when the single cap is repeatedly rejected; not on the first rejection)
- Byte cache

**PROOF ARTIFACT**
`frankenstein/docs/slice3.5-report.md` §14. Stale-cap run: **1 reacquire,
`max_reacquires=1` (bounded), 0 client 503, exact bytes preserved**.
Re-run command:
`SLICE35_FAULT_CDN_DEAD=1 PROXY_PORT=3506 ... && node
scratch/proofs/slice3.5/validate-faultmin.mjs http://127.0.0.1:3506 faultdead`.

---

## Behavior 4 — Exact mid-body resume

**CAUSAL FILES / FUNCTIONS**
- `transport.rs::ResilientRangeReader::next_chunk` — owns the byte position
- `transport.rs::ResilientRangeReader::pos` — next byte to deliver (the
  Decypharr-style current-offset owner)
- `transport.rs::ResilientRangeReader::midbody_triggered` — fault-injection
  state
- `transport.rs::ResilientRangeReader::apply_transient` — same-cap reopen
  after a mid-body drop
- `transport.rs::ResilientRangeReader::open_at` — reopens with the correct
  `Range: bytes=pos-` (where pos = last delivered + 1)

**REQUIRED DEPENDENCIES**
- The reader must own the current byte position independently of the
  transport connection
- Mid-body transport errors must NOT close the logical stream — they must
  reopen the provider connection at `pos` and continue
- The `Content-Range` validation at the start of `open_at` enforces the
  byte-exact invariant: `(s, e, t) == (pos, req_end, size)`

**PRODUCTION ANALOG / TARGET SEAM**
The Node `Readable` stream returned by `getFileStream` must track the current
offset internally; on a mid-stream error, it must issue a fresh
`fetch(Range: bytes=<last+1>-<reqEnd>)` and `pipe` the result. The
`transport.rs` `next_chunk` loop is the per-chunk read step in that flow.

**DOES NOT REQUIRE**
- Connection pooling at the `reqwest::Client` level (the proxy uses a fresh
  `reqwest::Response` per reopen; this is intentional — the capability survives
  even when the connection does not)
- Re-buffering or re-aligning on the client side

**PROOF ARTIFACT**
`frankenstein/docs/slice3.5-report.md` `faultmidbody` row in §15. 4 mid-body
drops injected, 4 `mid_body_resumes` counted, exact bytes preserved.
Re-run command:
`SLICE35_FAULT_MIDBODY=1 PROXY_PORT=3508 ... && node
scratch/proofs/slice3.5/validate-faultmin.mjs http://127.0.0.1:3508 faultmidbody`.

---

## Behavior 5 — Capability reuse without `requestdl` amplification

**CAUSAL FILES / FUNCTIONS**
- `manager.rs::CapabilityManager::acquire_for_read` — single-flight cache hit
- `manager.rs::Slot::caps` — the minted-capability vec (reuse on hit)
- `manager.rs::CapabilityManager::evictions` — counted separately from reuses
- `metrics.rs::Metrics::capability_reuses` / `capability_acquisitions` —
  the reuse/amplification counter pair

**REQUIRED DEPENDENCIES**
- The single-flight key (`Slot::sf_key`) must include every dimension that
  uniquely identifies a capability, so a second concurrent read can share the
  same mint
- A cap must be considered alive (Throttled or Degraded) for reuse even
  immediately after a 429 (no expire on throttle — see `capability.rs::throttle`)
- Negative cache must be `is_hard_failure` only — `RateLimited` and `Transient`
  never enter the negative cache, so a cooldowned cap is still the right thing
  to wait on (see `manager.rs::is_hard_failure`)

**PRODUCTION ANALOG / TARGET SEAM**
A `DeliverySession` object in `media-search/src/lib/delivery/` keyed on the
same `(provider, accountScope, torrentFile, resourceId, fileId)` tuple. The
`acquire_for_read` becomes a `await session.acquire()` that returns the
existing live session if any (reuse), or mints a new one (acquire, then
single-flight). Counters: `session.acquisitions`, `session.reuses`,
`session.reacquisitions`, `session.evictions`.

**DOES NOT REQUIRE**
- A separate `LRU` for the session cache (the per-Slot `caps` vec + the
  bounded negative cache together are sufficient)
- Provider ranking (the first `Slot` is always preferred; failover only on
  exhaustion)

**PROOF ARTIFACT**
`frankenstein/docs/slice3.5-report.md` §3 (capability cache) and §2 (network
path). Clean run: `acquisitions=1, reuses=21, evictions=0, other_api=0`.
Post-fix real TorBox run: `acquisitions=1, reuses=18, evictions=0` despite
1 live CDN 429.

---

## Behavior 6 — Exact-byte preservation across all fault paths

**CAUSAL FILES / FUNCTIONS**
- `transport.rs::ResilientRangeReader::open_at` — `Content-Range` validation
  before trusting a body
- `transport.rs::parse_content_range` — strict header parser
- `capability.rs::DeliveryCapability::runtime_url` — never re-resolved after
  mint
- `provider.rs::acquire_torbox` — emits the final CDN URL once
- `metrics.rs::Metrics::bytes_streamed` — total bytes delivered, asserted ==
  `reqEnd - pos + 1` per request

**REQUIRED DEPENDENCIES**
- The `Content-Range` validation MUST run before any byte is delivered
- A `416` (or any other rejection) is `OpenError::Client416` and surfaces
  to the HTTP handler as `416` — the read does not fall through to a retry
- A `Content-Range` mismatch is `OpenError::Client502` (the provider lied
  about the size)

**PRODUCTION ANALOG / TARGET SEAM**
In the Node `getFileStream` path, the equivalent of the `Content-Range`
validation is the "byte-identity check": after the 206 response, the read
stream's first byte must equal the requested offset, the last byte must
equal `Math.min(reqEnd, totalSize-1)`, and the `Content-Range` header (or
the equivalent `Range: bytes a-b/total` line) must agree with the file's
authoritative size from the control plane.

**DOES NOT REQUIRE**
- Pre-buffering the first 1 MiB (the validation is per-request, not
  byte-streamed)
- Trust of the `Content-Length` alone (the Rust code validates
  `Content-Range`, not `Content-Length`)

**PROOF ARTIFACT**
`frankenstein/docs/slice3.5-report.md` §15 (coldHash table). All 7 modes —
clean, legacy, fault429once, fault429always, faultmidbody, concurrent,
faultdead — produce the identical `coldHash =
78d174f22f6cd3f8fddfe51c9ef72556198d7564bdf103021e9c15e1999c5801`.
The cleanest reproduction: `validate-slice35.mjs` over `run-slice35.sh`.

---

## Cross-cutting invariants (re-verified by every proof)

- `requestdl` is acquired **at most once per slot** for the lifetime of a
  session. (Verified by `metrics.layer_A_api.requests == 1` in every mode.)
- No metadata/search endpoint (`mylist`, `checkcached`, `search`) is ever
  called on the Range path. (Verified by `metrics.other_api_calls == 0` in
  every mode.)
- Client-visible 503 only fires after bounded internal recovery is
  exhausted. (Verified by `metrics.recovery.client_503 == 0` for every
  recovered case; only `fault429always` with zero cooldown lets the
  budget exhaust.)
- Recovery is bounded. (`MAX_SAME_CAP_RETRIES=3`, `MAX_REACQUIRES=1`,
  `RECOVERY_BACKOFF_DEFAULT=30s`, `pool_growths` requires an explicit
  operator decision.)
- The capability is the only thing that gets reused. (Verified by
  `capability.reuses == N-1` for N reads on the same cap.)
- The transport connection is throwaway. (Verified by `mid_body_resumes`
  in the faultmidbody proof: the connection died, the capability did not.)

---

## Files NOT in the causal set (cleaned into `scratch/proofs/slice3.5/`)

| File | Why it was moved |
|---|---|
| `validate-slice35.mjs` | proof harness, not implementation |
| `validate-faultmin.mjs` | focused 4-GET variant for live-TorBox runs |
| `run-slice35.sh` | driver for the 7-mode sweep |
| `validate-slice3.js` | Slice 3 byte-exactness harness (predecessor invariant) |
| `soak-reacquire.js`, `soak-reacquire2.js` | Slice 3 soak tests for the TTL re-acquire fix |
| `contract-proxy429.mjs` | proxy→client 429 contract test |
| `probes/probe-requestdl-noredirect.js` | §1 evidence: `requestdl` without `redirect=true` |
| `probes/probe429.js` | §5 evidence: live 429 path with `Retry-After` |
| `probes/probe_range.mjs` | diagnostic for `Range` header wire shape |
| `probes/smoke.mjs` | ad-hoc smoke |
| `probes/fetch-rd-url.mjs` | one-shot RD URL resolver |
| `scratch/proofs/slice3.5/README.md` | the proof set's self-describing index |

`src/` is now strictly causal: every `.rs` file participates in the
data path. Nothing in `src/` is validation scaffold.

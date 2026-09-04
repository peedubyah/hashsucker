# P6 — Legacy South Deletion + Accounting/Telemetry Reconciliation

**Branch:** `m3-north-db`
**Date:** 2026-09-04
**Precedes:** P5 (closed, remote tip `3a6a28b`)
**Stack under test:** `media-search:local` (rebuilt with P6 Node changes) + `hy4-data-plane:local` (Rust unchanged) + real `control-plane.db` / `discovery-cache.db`.

## Scope (frozen)

`torrentFileId != null` → Rust-only byte authority; `torrentFileId == null` → legacy Node
compat path retained temporarily. Node must NOT regain provider byte-delivery authority.
Provider API execution, DeliveryCapability lifecycle, retries/cooldowns/breakers, Range
serving, cache/coalescing, byte motion, and provider-facing accounting belong to **Rust**.
VFS durable identity, SQLite truth, discovery/ranking/persisted candidates, VFS/Plex
namespace, fallback lifecycle, and request/fallback telemetry belong to **Node**.

---

## 1. Caller classification table (Step 1 audit — by actual call sites)

| # | Component | Classification | Exact call sites | Verdict |
|---|-----------|----------------|------------------|---------|
| 1 | `openValidatedProviderRead` (movie/tv) | **KEEP — LEGACY NO-tfId COMPAT** | movie: `loadMetadata:783` (size disc.), `streamFile` legacy block `:1072`; tv: `loadMetadata:835`, `streamFile` legacy `:1130`. Reached **only** when `state.entry.torrentFileId === null`. | Retained |
| 2 | `range-response-validator.js` | **KEEP** | `validateRangeResponseHeaders/Body` in both `streamFile` legacy blocks; `classifyReadFailure` in `openValidatedProviderRead` (movie:646 / tv:686); `RANGE_VALIDATION_REASONS` internal. No non-legacy caller. | Retained |
| 3 | `invalidateTorBoxCapability` | **KEEP — LEGACY NO-tfId COMPAT** | `openValidatedProviderRead` body/protocol-invalid branch (movie:657/1114, tv:699/1165). Legacy-only. | Retained |
| 4 | VFS RD imports `attemptRdResolution`/`getRdPlaybackUrl` | **KEEP — NON-VFS CALLER + LEGACY NO-tfId** | `resolveBacking` (movie:324/333, tv:355/364) for legacy no-tfId RD; `app.js:1796/1810` server RD route (non-VFS). | Retained |
| 5 | `attemptRdResolution` | **KEEP — NON-VFS CALLER + LEGACY NO-tfId** | `app.js:1796`, `resolveBacking`, `alternate-fallback.js:265/538`. | Retained |
| 6 | `getRdPlaybackUrl` | **KEEP — NON-VFS CALLER + LEGACY NO-tfId** | `app.js:1810`, `resolveBacking`, `alternate-fallback.js:298`. | Retained |
| 7 | `resolveTorBoxDeliverySeam` | **KEEP — NORTH OF BYTE DELIVERY** | Non-VFS server route `app.js:1241/1912`; legacy `resolveBacking` (movie:356 / tv:398); **modern** `attemptPersistedAlternateFallback` seam (movie:928 / tv:985). Shared infra used by the modern path. | Retained |
| 8 | `torBoxDownloadUrlCache` | **KEEP — NORTH OF BYTE DELIVERY** | Resolver `torbox-delivery.js`; legacy read backoff in `openValidatedProviderRead`; `app.js:1510` wrap-with-accounting. Resolver-side = Node-owned. | Retained |
| 9 | `providerAccounting` | **KEEP — ownership documented** | See §4. | Retained |
| 10 | Legacy VFS provider read blocks (`resolveBacking`, `fetchProvider`, `deliveryCapabilityFor`, `gate/mark/clearReadRateLimited`, `parseReadRetryAfter`, `validate*`) | **KEEP — LEGACY NO-tfId COMPAT** | All contained within `openValidatedProviderRead` (torrentFileId === null only). | Retained |

**Audit finding:** *No zero-caller dead code exists in the inventory.* Every component has a
live caller on the no-tfId / resolver / non-VFS path. The genuine P6 "deletion" is therefore
the **permanent removal of Node's byte authority for `torrentFileId != null` entries** (Step 2),
not the removal of live code "just in case".

---

## 2. Exact legacy components deleted

- **No zero-caller code deleted** (per Step 2: delete only what P5 made unreachable; P5 made the
  legacy path unreachable *for tfId-present*, but the code itself remains reachable for no-tfId).
- **Authority deletion (the real P6 deletion):** a hard guard added at the top of
  `openValidatedProviderRead` in both `movie-webdav.js` and `tv-webdav.js`:

  ```js
  if (state?.entry?.torrentFileId) {
    throw new VfsError(
      'Legacy Node byte path invoked for a durable (torrentFileId-present) entry; byte authority is Rust-only',
      500, 'LEGACY_PATH_AUTHORITY_VIOLATION');
  }
  ```

  This makes Node's legacy byte path **regression-proof**: any future code path that routes a
  tfId-present entry into `openValidatedProviderRead` fails loud (HTTP 500) instead of silently
  serving bytes and masking a 200/206. P5's `streamFile` discriminator already routes
  tfId-present to Rust; this guard is the durable backstop.

---

## 3. Retained compatibility components + reason

- `openValidatedProviderRead` + helpers, `range-response-validator.js`, `invalidateTorBoxCapability`,
  legacy `streamFile` block — **legacy no-tfId compat** until those entries are migrated to durable
  TorrentFiles. Reachable only when `torrentFileId === null`.
- `attemptRdResolution` / `getRdPlaybackUrl` — **non-VFS server RD route** (`app.js`) plus legacy
  no-tfId VFS RD resolution. North of byte delivery.
- `resolveTorBoxDeliverySeam` / `torBoxDownloadUrlCache` — **north of byte delivery** (resolver /
  delivery-URL cache). `resolveTorBoxDeliverySeam` is also the seam used by the *modern* persisted-
  candidate fallback (`attemptPersistedAlternateFallback`), so it must stay; it issues provider work
  that Rust does **not** do (TorBox placement/availability), correctly Node-owned.

---

## 4. Accounting before / after (Step 4)

**Before (P5):** Node `providerAccounting` incremented `delivery_*` counters
(`delivery_range_request`, `delivery_429`, `delivery_retry_after_ms`, `delivery_backoff_enter`,
`delivery_backoff_short_circuit`, `delivery_post_backoff_retry`, `delivery_success_after_backoff`)
inside `openValidatedProviderRead`. These describe provider *byte* mechanics. They only fired for
no-tfId entries in practice (P5's `streamFile` guard routed tfId-present to Rust), but there was
**no runtime enforcement** preventing a tfId-present entry from entering the legacy path.

**After (P6):**
- `openValidatedProviderRead` is hard-guarded (§2). The `delivery_*` Node counters **can never fire
  for a tfId-present entry** — only for genuine no-tfId legacy entries where Node *is* the byte
  authority. No double-claim of provider work.
- An ownership block in `provider-accounting.js` documents the split:
  - **Rust-owned** (data plane, surfaced at `/metrics`, not duplicated here): provider API request
    count, link acquisition, retries, Retry-After, breaker/cooldown, provider bytes fetched,
    cache-fill upstream bytes, capability acquisition/reacquisition — all for tfId-present entries.
  - **Node-owned** (never duplicated by Rust): `availability_*`, `placement_*`, `requestdl_*`,
    `background_*`, `realdebrid_*` (resolver / non-VFS / durability), and `delivery_*` (legacy no-tfId
    byte path only, guarded).

---

## 5. Telemetry fields (Step 5)

| Field | Status | Note |
|-------|--------|------|
| `fallbackUsed` | **RETAINED** | via `buildFallbackTelemetry` (alternate-fallback.js:567) |
| `originalReleaseKey` | **RETAINED** | set in `attemptPersistedAlternateFallback` (movie:989 / tv:~1000) |
| `selectedReleaseKey` | **RETAINED** | " |
| `fallbackRank` | **RETAINED** | " |
| `reason` (`PRIMARY_PROVIDER_EXHAUSTED`) | **RETAINED** | " |
| (any field) | **REMOVED / REDEFINED** | **none** |

The P5 fallback envelope is preserved exactly. It is emitted **only** on class-D fallback through
the modern Rust re-forward path — Node never duplicates Rust's provider timings/counts. Rust does
not emit these Node-side lifecycle fields, so there is no double-emission.

---

## 6. Proof ladder (small / focused)

| Proof | What it shows | Result |
|-------|---------------|--------|
| **A** — modern durable entry | `tf_5de34a78` (Movie) → `206` from Rust; legacy `open path=… provider=` log **absent**; no `LEGACY_PATH_AUTHORITY_VIOLATION`. | ✅ `206`, bytes 0–65535/34319716114; no legacy-path log. |
| **B** — class-D → alt (happy) | Gate `tf_c09f21b6` (Ted Lasso E01) → `502 PROVIDER_EXHAUSTED` (verified direct) → class-D fallback → distinct cached alt `tf_00f25ade` → `206`. | ✅ E01 durable `torrent_file_id` now `tf_00f25ade…` (read from `vfs_tv_entries`, not a log string); response size `5808263018` = known alt size. |
| **B.1** — class-D → same gated tfId (terminal) | Gate `tf_5de34a78` (Movie, only alt = same gated tfId) → fallback logs `persisted-alternate fallback used … newTfId=tf_5de34a78…` → re-forward still gated → terminal `502`. | ✅ `502`; fallback logged; **no** `LEGACY_PATH_AUTHORITY_VIOLATION` (500) and **no** legacy `open path=` line → no legacy escape. |
| **C** — 416, no fallback | E01 (`tf_00f25ade`) `Range: bytes=99999999999999-` → `416`. | ✅ `416 Range Not Satisfiable`; no fallback, no legacy. |
| **D / E** — structural (unchanged from P5) | Guard + explicit split are new invariants; Rust path, class taxonomy, sibling safety unchanged. Re-validated transitively via A/B/B.1/C. | ✅ |

**Guard-integrity note:** the B.1 result is the key guard proof — a tfId-present entry that
reaches the legacy path would have thrown `LEGACY_PATH_AUTHORITY_VIOLATION` (HTTP 500). It returned
`502` (Rust exhaustion) instead, proving the legacy path was never entered for the tfId-present
entry.

---

## 7. Remaining legacy debt

- The `torrentFileId === null` compat byte path (`openValidatedProviderRead` + helpers) is retained
  intentionally. It should be deleted once every durable VFS entry carries a `torrentFileId`
  (migration tracked separately — out of P6 scope).
- `delivery_*` Node counters remain (legacy no-tfId only, now guarded). They are correct for that
  path and should be removed together with the legacy path above.

---

## 8. Blockers / recommendation

- **No blockers.** Rust data plane unchanged; only `media-search` rebuilt.
- **Recommendation:** when the no-tfId migration completes, delete `openValidatedProviderRead` and
  its helper cluster in one commit, and drop the `delivery_*` Node counters + the guard (no longer
  needed). Until then the guard keeps the invariant enforceable.

---

## 9. P6 stop-condition check (10 points)

1. ✅ Legacy south machinery made unreachable for tfId-present (guard).
2. ✅ Accounting ownership reconciled (Rust vs Node documented; `delivery_*` can't fire for tfId-present).
3. ✅ Telemetry envelope retained, no double-emission.
4. ✅ Rust recovery semantics untouched (data plane unchanged).
5. ✅ No `DeliveryCapability` persistence introduced (none in Node).
6. ✅ Modern/legacy split explicit (guard + comments; `streamFile` discriminator).
7. ✅ Proof ladder A–E executed (B.1 added for terminal case).
8. ✅ Deletion discipline: no dead code kept "just in case"; deletions = authority guard only.
9. ✅ Compose/runtime: `media-search` rebuilt + restarted; data-plane left in **clean (no-gate)** state.
10. ✅ No Plex API / Seerr / discovery end-to-end / graduation / unrelated cleanup performed.

**Stop. Awaiting next tranche.**

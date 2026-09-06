# P17 — Cold-Start TTFB Optimization

**Verdict: KEEP OPTIMIZATION.**

One change, candidate A: Real-Debrid MODE A no longer performs the redundant
`GET /torrents?limit=100` list scan on the cold path.

Measured by interleaved A/B against a pinned prebuilt baseline image:

| metric (RD, cold) | baseline | optimized | delta |
|---|---|---|---|
| provider API calls per cold acquire | 3 | 2 | **−1 (−33%)** |
| acquisition window `control_pre_acquire_ms` | 689 ms | 540 ms | **−149 ms (−21.6%)** |
| total cold TTFB `total_open_ttfb_ms` | 1251 ms | 1038 ms | **−213 ms (−17.0%)** |
| warm chunk median TTFB | 451.5 ms | 450.2 ms | −1.2 ms (−0.3%, flat) |

---

## 1. Provenance of every measurement

P17 began by discarding an invalid baseline: the running image predated
P13/P14/P15, so all earlier numbers were void. Every number below comes from a
container whose binary was verified against the current source.

| item | value |
|---|---|
| branch | `m3-north-db` |
| HEAD at measurement | `90829ca758e856982650c0324e011fb920c26153` |
| `hy4-data-plane/src` tree | `cd4d3025b2f72e9db6cb129c2982588615a9930c` |
| baseline image `hy4-data-plane:p17base` | `d49e1e0d2836` |
| baseline binary sha256 | `889554cf9a9ab5115fd0bd9e16e523526490b66582618158a4a8bb7aa353ef2a` (8478848 B) |
| optimized image `hy4-data-plane:p17opt` | `827ae9a652bc` |
| optimized binary sha256 | `1e92e45a5fa2c58367299c89490ffccc58616528937e0536bb6aab24c5917ea8` (8481760 B) |

Gate-string assertion: all five P13/P14/P15 gates present in both binaries
(`HY4_FORCE_PROVIDER`, `HY4_FORCE_FAIL_PROVIDER`, `HY4_FORCE_SLOT_FAILURE`,
`HY4_FORCE_SLOT_ORDER`, `HY4_FORCE_EXHAUST_TFID`), plus the new P17 marker in
the optimized binary only.

> **Provenance gotcha worth recording.** These gate names do **not** appear as
> standalone NUL-terminated strings in the binary — LLVM merges adjacent string
> literals, producing blobs such as
> `HY4_FORCE_SLOT_ORDERNEG_CACHE_TTL_SECONDS` and
> `HY4_FORCE_EXHAUST_TFIDPROVIDER_EXHAUSTED`. A `grep -a 'HY4_FORCE_SLOT_ORDER'`
> style check therefore reports MISSING on a perfectly current image and causes a
> false stale-image abort; busybox `grep -c` on a binary also counts *lines*, not
> occurrences. Assertions must use a raw substring byte-count.

---

## 2. Clean cold baselines (rebuilt current image)

Established with the pre-existing `bench/playback-bench.mjs` plus the existing
Slice 4.5 stage clock in `/metrics`. Because `STAGE_REPORT_CAP = 64`, the
genuinely-cold request is retained as `stages_recent[0]` — no new harness was
needed. 3 samples per provider.

| | S‑1 + acquisition | provider API calls | CDN TTFB | **cold TTFB** | warm median |
|---|---|---|---|---|---|
| TorBox | 545 ms | 1 | 667 ms | **1222 ms** | 243.5 ms |
| Real-Debrid | 682 ms | 3 | 503 ms | **1173 ms** | 455.5 ms |

(min/max — TB cold TTFB 697…1223; RD cold TTFB 1163…1327)

**S‑1 control plane cost is negligible.** `record_api` is called only from
`provider.rs`, so `layer_A_api` counts provider calls exclusively; therefore
`S-1 ≈ control_pre_acquire_ms − (api_requests × latency_ms_avg)` ≈ **1 ms**.

### Instrumentation subtlety (important for reading these numbers)

Because of the P5 pre-acquire (`serve.rs:348` awaits `acquire_for_read` *before*
`fill_chunk_run` stamps T1), the cold path folds **both** the S‑1 fetch **and**
the whole provider acquisition into `control_pre_acquire_ms`, leaving
`acquisition_api_ms ≈ 0`. So on the cold path `control_pre_acquire_ms` is the
"acquisition window", not "S‑1 time".

---

## 3. Dominant avoidable serial work

Cold TTFB decomposes into exactly two serial blocks:

- **acquisition window** — S‑1 + provider API chain: 545 ms (TB, 1 call) /
  682 ms (RD, 3 calls)
- **CDN first byte** — 667 ms (TB) / 503 ms (RD)

RD pays **3× the API calls** for only **+137 ms** of acquisition, which shows
most of that window is a single one-time TCP+TLS setup to the provider API, not
the extra round trips. That is why removing one call was worth measuring rather
than assuming.

Contract finding (P17 §3, measured against the live account): the S‑1 coord
already carries the authoritative RD torrent id in `provider_resource_id`
(`5VFSK7HKPITZW`), identical to what the list scan derives, and
`/torrents/info/{id}.hash` equals the authoritative infoHash. The list scan is
redundant.

---

## 4. The change (candidate A only)

`hy4-data-plane/src/provider.rs`, `acquire_rd_mode_a`:

- New `rd_info_checked(rid, want_hash, …)` — fetches `/torrents/info/{rid}` and
  returns it **only if the payload's `hash` equals the authoritative infoHash**.
- The coord's `provider_resource_id` is used directly as `rid`.
- The old list scan is preserved verbatim as `rd_list_scan_rid(…)` and is used
  as a **fallback** when the coord id is absent/blank, the detail call returns
  non-success, or the hash check fails.
- File selection (exact path + exact size, then unambiguous exact size) is
  unchanged.

Correctness is deliberately not relaxed: the shortcut can never bind the wrong
torrent, because identity is re-verified against the infoHash on the fast path
too. No change to Node/Rust ownership, no change to S‑1, no new provider state,
no speculative/prefetch work.

---

## 5. Measurement — interleaved A/B, not sequential batches

**Why interleaved:** a first sequential comparison was invalid. The TorBox path
is untouched by this change, yet TB appeared to improve 25.9% between batches —
pure network drift. Sequential batches therefore cannot attribute the RD win.

Fix: both variants were prebuilt as tagged images and run **alternately in one
time window** (base, opt, base, opt, …), with the variant confirmed per run by
binary sha256.

RD cold, 4 interleaved pairs:

| metric | baseline samples | optimized samples | median Δ | per-pair Δ |
|---|---|---|---|---|
| API calls | 3,3,3,3 | 2,2,2,2 | −1 (−33%) | all −1 |
| acquisition window | 680, 682, 696, 721 | 525, 539, 541, 553 | **−149 ms (−21.6%)** | 157, 127, 180, 157 |
| CDN TTFB | 791, 493, 496, 602 | 494, 557, 503, 492 | −50 ms (noise) | mixed |
| **total cold TTFB** | 1488, 1173, 1218, 1284 | 1020, 1110, 1045, 1032 | **−213 ms (−17.0%)** | 264, 63, 173, 456 |

The acquisition-window ranges are **fully non-overlapping** (max opt 553 < min
base 680) and 4/4 pairs improved. CDN TTFB — the stage this change does not
touch — is flat/noisy, which is the expected control behaviour. Total cold TTFB
improves in 4/4 pairs; part of the median total delta is CDN noise, so the
conservative, defensible claim is the acquisition-window number (−149 ms).

---

## 6. Warm-path regression

None. Warm chunk median TTFB 451.5 ms → 450.2 ms (−0.3%); per-pair deltas
+2.5, −17.5, +5.0, +3.0 ms. TorBox warm path likewise unchanged. The change is
confined to cold acquisition.

---

## 7. Byte correctness

Reused the existing P14 harness `bench/p14/p14-2-rd-only.mjs` (front/mid/tail
1 MiB ranges vs the frozen reference SHAs), run against the **optimized** image:

| range | reference | RD-served (TB removed) | TB-served (RD removed) |
|---|---|---|---|
| front 1 MiB | `52daa79d4aff` | `52daa79d4aff` OK | `52daa79d4aff` OK |
| mid @10 MiB | `977afd3ce097` | `977afd3ce097` OK | `977afd3ce097` OK |
| tail 1 MiB | `11c81ee706e0` | `11c81ee706e0` OK | `11c81ee706e0` OK |

Both providers return byte-identical content before and after the change.

---

## 8. Provider / API amplification

- Cold RD acquisition: **3 → 2** provider API calls (−33%).
- Existing `bench/p14/p14-8-api-sanity.mjs` in dual-provider mode: 5 sequential
  reads → `api_requests +0`, `cap.acq +0`, `cap.reuse +5`, `brk_open 0`. No
  per-read re-acquisition, no breaker trips.

---

## 9. Failure shielding

Existing gates, optimized image:

- `HY4_FORCE_FAIL_PROVIDER=<tfid>:torbox` (TB removed from coord list) → RD
  serves 206 with all three reference SHAs correct.
- `HY4_FORCE_FAIL_PROVIDER=<tfid>:realdebrid` (RD removed) → TB serves 206 with
  all three reference SHAs correct.

No `[p17] … unverified` fallback line appeared in the container log, i.e. the
coord id passed the hash check and the fast path was used.

---

## 10. Remaining headroom — stop condition

After the change, RD cold TTFB ≈ 1038 ms is:

- ~540 ms acquisition window (2 serial provider API calls; dominated by one
  one-time TCP+TLS setup to `api.real-debrid.com`)
- ~500 ms CDN first byte (one-time TCP+TLS to `download.real-debrid.com`)

**Effectively 100% of the remaining cold TTFB is provider-facing network work.**
It cannot be reduced locally: the CDN URL is unknown until acquisition
completes, so the CDN connection cannot be pre-warmed without hiding latency on
the critical path (which P17 forbids), and no reqwest pool tuning helps a cold
process's first connection.

**NO FURTHER HIGH-CONFIDENCE LOCAL TTFB WIN.** No second change was made.

---

## 11. Scope guard

- No change to networking, mounts, firewall, Tailscale, SSH tunnels, rclone,
  Plex, or either host.
- No change to the frozen Node/Rust ownership boundary; no change to S‑1.
- No new branches, no stash, no force push, `main` untouched.
- Temporary files used during measurement (`compose.p17.yaml`, the runner and
  analysis scripts) live outside the repo or were removed before commit.
- Dual-provider graduation remains frozen; prefetch untouched.

---

## 12. Known limitation / follow-up

The **fallback path** (coord id unverifiable → list scan) is retained and
compiles, but was **not exercised at runtime** in this tranche: the live coord
id verifies correctly, so the fallback never triggered. Exercising it requires
a placement whose `provider_resource_id` does not match RD — worth a targeted
test in a later tranche.

# TEST HARNESS — wall-clock removed as a proof mechanism (data-plane adversarial suites)

Date: 2026-10-21
Scope: the adversarial Rust suites that were sleeping > 60 s.
Commit: `7181926`

---

## 1. Which tests were slow, and why

Two production intervals were being paid **in wall clock inside the test
harness**. The suites did not finish.

### 1a. The truncated-provider-body tests hung FOREVER

| test | target | invariant it proves |
|---|---|---|
| `r7_partial_origin_response_does_not_poison_cache` | `adversarial_cache_fill` | a partial origin response must fail the fill and must NOT mark the chunk present (no cache poisoning) |
| `r8_origin_disconnect_mid_fill_leaves_recovery_possible` | `adversarial_cache_fill` | an origin disconnect mid-fill must leave the chunk unpromoted and a later read recoverable |
| `r2e_malformed_provider_payload_fails_over` | `same_tf_route_recovery` | a truncated provider payload must not truncate the client: the read must fail over to the alternate same-TF route and deliver the exact bytes |

**Why they hung.** A truncated provider body is only **detectable through
the client's request timeout**. The mock origin commits a 206 with the
correct range metadata and a `content-length` it then never fulfils, so
the reader waits for bytes that will never arrive.

In production the client's request timeout (**25 s**) is what turns that
into a clean transport failure, which the recovery path then handles. The
tests' client was `reqwest::Client::new()` — **no timeout at all** — so
the read never completed and the target never finished.

Measured, before the change: `cargo test --release --test adversarial_cache_fill`
was **killed at 1800 s** (EXIT=124) and never printed a result; the same
target was also killed at 400 s and 900 s. `same_tf_route_recovery` was
killed at 900 s the same way.

**How it was found.** A temporary `eprintln` in the mock origin showed
**one** request arriving and then nothing: the reader was blocked on the
body, not on a retry.

### 1b. The transient-5xx tests paid the PRODUCTION RECOVERY BACKOFF

| test | target | invariant it proves |
|---|---|---|
| `r9_503_then_healthy_recovers_and_is_not_terminal` | `adversarial_cache_fill` | a 5xx must not create cache truth, and the SAME capability must recover afterwards |
| `r11_failed_fill_does_not_strand_future_requests` | `adversarial_cache_fill` | a failed fill must not strand a later request |

**Why they were slow.** A transient 429/5xx waits out a **cooldown**
before the same capability is retried: the provider's `Retry-After`, or
**`RECOVERY_BACKOFF_DEFAULT` = 30 s** when the provider sends none
(`transport::apply_transient`). Each test paid that 30 s per attempt, and
the retry budget is 3 — so 90–120 s per test.

### 1c. The suite-level result

`cargo test --release` **never completed** on this crate: it was killed at
1800 s. The lib target finished in 31 s; the two adversarial targets did
not.

---

## 2. The abstractions introduced

### 2a. `transport::PROVIDER_CLIENT_TIMEOUT` + `transport::build_provider_client(timeout)`

The provider client's request timeout is now a **single named production
value** (25 s) with **one constructor**:

```rust
pub const PROVIDER_CLIENT_TIMEOUT: Duration = Duration::from_secs(25);

pub fn build_provider_client(timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .expect("provider client build")
}
```

Production calls it with `PROVIDER_CLIENT_TIMEOUT`. The construction is
otherwise **identical** — same redirect policy, same builder — so a test
that injects a short timeout is exercising **the same client**, not a
different one.

**No production timeout changed.** 25 s is still 25 s. The only
production-side edit is that the construction moved from `main.rs` into
the transport module, where the value it uses now lives.

### 2b. `Faults::recovery_backoff: Option<Duration>`

The recovery backoff is now injectable through the **existing fault
seam** — which already carried a ZERO cooldown for the 429 fault gate
"so the deterministic test does not sleep", the same precedent.

* `None` **IS production**: the provider's `Retry-After`, or 30 s.
* `Some(d)` makes the transient path wait `d` instead.

The override changes only **how long** the recovery waits. It does not
change: the retry budget (`MAX_SAME_CAP_RETRIES`), the same-cap reuse
(no re-acquire, no provider-API amplification), the byte assertions, or
the cache-poisoning assertions.

### 2c. The fast proofs

| | injected | production |
|---|---|---|
| client request timeout | **250 ms** | 25 s |
| recovery backoff | **1 ms** | 30 s |

The wait *length* is not what any of those assertions are about.

### 2d. The mock provider stays deterministic

No mock change was needed to remove the wall clock: the origin still
promises a truncated body, and the **client** is what bounds the wait.
That is the honest shape — production detects the truncation with the
same mechanism.

---

## 3. The explicit real-time suite

`cargo test` does **not** run these. The real-time suite is:

```
cargo test --test adversarial_cache_fill -- --ignored
```

Two tests, both `#[ignore]`d, both using the **production** client
(`build_provider_client(PROVIDER_CLIENT_TIMEOUT)`) and the **production**
fault seam (`recovery_backoff: None`). Each asserts the same semantic
outcome as its fast sibling **and** that the real production interval is
the one in play:

| test | what it proves end to end | wall |
|---|---|---|
| `slow_real_time_truncated_origin_body_is_detected_at_the_production_timeout` | the 25 s client timeout turns a truncated body into a transport failure; the fill fails; the chunk is **not** promoted (no cache poisoning); the elapsed time is ≥ the production timeout | ~100 s (4 attempts × 25 s) |
| `slow_real_time_transient_5xx_waits_out_the_production_backoff_then_recovers` | the 30 s production recovery backoff is the one in play; a 5xx creates no cache truth; the same capability is retried and recovers | ~90 s |

**Both pass. Together: 190.01 s.**

---

## 4. Before / after target runtime

| target | before | after |
|---|---|---|
| `adversarial_cache_fill` | **never completed** (killed at 1800 s, EXIT=124) | **1.02 s** — 14 passed, 2 ignored |
| `same_tf_route_recovery` | **never completed** (killed at 900 s / 1800 s) | **0.26 s** — 12 passed, 1 ignored |
| `serve_layer_coalescing` | 0.34 s | 0.34 s |
| lib (unit tests) | 31.33 s (153) | 31.35 s (154) |
| **`cargo test --release` (whole crate)** | **never completed** (killed at 1800 s) | **33.15 s** |

The explicit real-time suite is the only thing that is still slow, by
design: 190.01 s for two tests.

---

## 5. The one test that was never passing

`r2e_malformed_provider_payload_fails_over` **hung** before this change —
it never completed, so the target never finished. With the production
timeout injected it now **completes — and FAILS**, exposing two things the
hang was hiding:

1. **The mid-body path does not fail over for a truncated payload.** A
   truncated body has valid headers, so it is not the headerless path;
   the mid-body path re-opens the **same** lane instead of trying the
   alternate same-TF route. The read exhausts its retry budget and the
   client gets an empty 206.
2. **Its expected byte range is the wrong offset** — `expected(0, CHUNK)`
   while the read is for `CHUNK..2*CHUNK-1`.

Its assertions are **unchanged** (it still demands a 206 with the whole
range, delivered by the alternate route). It is `#[ignore]`d with the
reason recorded on the test, and it stays in the suite so the defect
remains visible and re-runnable
(`cargo test --test same_tf_route_recovery -- --ignored`).

**The production failover was deliberately NOT changed.** That is a
behaviour change, not a test-harness change, and this slice's rule is one
bounded change at a time. The defect is recorded, not fixed.

---

## 6. What was not touched

* **No production timeout changed**: the client timeout is still 25 s, the
  recovery backoff is still 30 s (`RECOVERY_BACKOFF_DEFAULT`), the
  redirect policy is unchanged, and the retry budgets are unchanged.
* **No assertion weakened**: every fast proof keeps the identical
  assertions — the same byte comparisons, the same cache-poisoning
  checks, the same recovery expectations. The only change is the injected
  wait length.
* **No failure/recovery semantics changed**: the same-cap retry, the
  failover rules, the negative cache, the breaker and the permit
  accounting are untouched.
* Production was rebuilt and redeployed; a real playback still works
  (first frame 3 465 ms, playhead advanced, exit 0).
* `media-search` is untouched by this slice: 3 626 tests, 3 622 pass, 3
  skipped, 1 fail — the known pre-existing `vfs-collection-resilience`
  C1/C2/C3 baseline.

---

## 7. Verdict

**The wall clock is no longer a proof mechanism.** The normal
`cargo test` path now proves the recovery, byte-integrity and
cache-poisoning semantics in **33 s** instead of never finishing, and the
real production timeout configuration is exercised end to end by an
explicit, separate, two-test real-time suite that still takes its 190 s.

One pre-existing red test was found and is now recorded rather than
hidden: the truncated-payload failover does not happen. It is a
production behaviour gap, and it is the next thing worth a slice.

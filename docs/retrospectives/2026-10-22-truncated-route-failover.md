# Retrospective — truncated same-TF route failover (2026-10-22)

- Expected: fix the r2e oracle, add request-local exclusion for one
  truncated-body shape, extend the matrix.
- Actual: the oracle fix exposed that the mock itself never produced a
  truncation (hyper panics on a claimed-but-unsent content-length); the
  same broken mock shape had also silently voided the ignored real-time
  truncated test (failing on the clean tree while docs claimed a 190 s
  proof). Three arms fixed (premature-EOF, body-error, wrong-range 206),
  not one. Full matrix T1–T8 green; full `cargo test` 196 passed.
- Surprises: (1) pre-fix `r2e` "passed" for two wrong reasons at once
  (panicking mock + 8192 % 256 == 0 hiding the oracle offset); (2) `r2f`
  passed partly incidentally via pooled-connection reuse, with no
  failover call on its path; (3) the premature-EOF arm consumed no retry
  budget — a zero-byte truncator would loop forever (liveness hole, now
  bounded); (4) post-fix `r2e` runs 0.01 s vs 2.41 s pre-fix (1+1 provider
  hits vs 8192).
- Disproved assumptions: "a short body is detected via the client timeout"
  — clean-EOF truncation is detected immediately; only a STALL needs the
  25 s timeout. The harness docs conflated the two shapes.
- Wasted effort + cause: none significant; the clean-tree verification run
  (~seconds, fast-fail) was the cheapest possible disproof of "did I break
  the slow test".
- Most useful test: corrected `r2e` with lane-delta eprintln — it printed
  the causal baseline (`loser_delta=8192, winner_delta=0`) that the code
  trace predicted.
- Lying/overconstraining test: the old `r2e` (wrong offset + panic mock,
  then `#[ignore]`d with the defect described but the mock unexamined);
  the old slow truncated test (asserted a 25 s wait a panicking mock could
  never produce). Both fixed, not weakened.
- Automation that should disappear: none — the fast/real-time split is
  kept; the real-time suite now genuinely proves the wiring (100.01 s =
  4 attempts × 25 s).
- Guidance change: truncation mocks must be chunked-early-EOF or stall,
  never header/body-mismatch. Recorded in this slice's build-log entry.
- Complexity to remove: none taken; noted that the two mid-body same-lane
  retry tails now mirror `apply_transient`'s failover-first shape and
  could unify later.

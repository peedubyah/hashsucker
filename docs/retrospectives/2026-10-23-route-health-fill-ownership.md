# Retrospective — route health + fill ownership (2026-10-23)

Template: expected vs actual, surprises, disproved assumptions, wasted
effort + cause, most useful test, lying/overconstraining test, automation
that should disappear, guidance change, complexity to remove.

- Expected: reproduce the ~540 ms RD-first tax, exclude-or-reorder via
  existing evidence, measure fill holds, fix what is earned.
- Actual: tax reproduced live at ~963 ms (RD info 398 + unrestrict 403
  565, then TorBox 325). Fixed with usable-first ordering + S-1 slot
  order + the missing playback-path evidence producer. Fill ownership
  investigated end-to-end and left unchanged (HEALTHY).
- Surprises:
  1. Rust slot order was HashMap nondeterminism — the "RD first" story
     was ~50% luck per process. The Node-only fix would have been
     theater; the second half was found by reading `new`, not by testing.
  2. Usable evidence had NO producer on the direct-play path the product
     is pivoting to. Only VFS/WebDAV recorded it. Found by asking why a
     fresh play left no evidence row.
  3. Client disconnect deliberately does not stop fills ("Keep filling"
     comment) — the 100 s hold is active transfer + intentional
     post-demand completion, not a leak. Production mean hold is 1.6 s.
  4. `pool_attribution`, `stages_recent`, and per-acquisition
     `api_detail` already answer live "who attempted what" — no new
     tracing was needed (slice Phase 1's timeline exists: the waterfall).
- Disproved assumptions: "slot order follows S-1 order" (it was
  nondeterministic); "evidence is recorded on every serving path" (only
  VFS); "long holds are idle" (they track transfers); "the tax needs
  403-evidence recording" (prefer-known-good suffices; 403 recording
  rejected as riskier and unnecessary).
- Wasted effort + cause: none significant. One mutation-check cycle
  (stash app.js → test fails → pop) was the cheapest possible pin proof.
- Most useful test: `playback-evidence` (app-level, real store + real
  handler + fake data plane) — it failed with exactly `retryable` vs
  `serviceable` when the one-line wiring was removed. Second:
  `route-coordinate-order` negative control (no-evidence order byte-
  identical to before).
- Lying/overconstraining test: none found. The pre-existing
  `vfs-collection-resilience` C1/C2/C3 still fails on baseline;
  untouched, still classified, not normalized away.
- Automation that should disappear: none. The P15/DATA_PLANE_FORCE_SLOT_ORDER
  bench gate is now redundant for order control but kept (still forces a
  lane in benches; harmless).
- Guidance change: (1) evidence loops need producer audits per serving
  path, not just consumer audits; (2) when Node computes an order Rust
  must preserve it — check grouping code, not just acquisition loops.
  Both recorded in the build log.
- Complexity to remove: none taken. Rejected additions: acquisition-403
  evidence recording (new channel + risky semantics), fill cancellation
  tokens (would break waiter resolution), S-1 evidence-rank field
  (order already carries the signal).

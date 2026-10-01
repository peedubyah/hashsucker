# Strategic research — open questions

Unresolved questions that must be answered by evidence before
implementation. Each states what evidence would answer it. Guesses are
not answers.

## Top-level value question (kill criterion across phases)

> Which candidate capability measurably saves the household time or
> interaction?

Evidence: fewer selections, fewer retries, less waiting, fewer repair
actions, less re-curation. Any phase or mechanism that cannot pass this
becomes research or dies — elegance, sophistication, and predictive
cleverness are not substitutes.

## Questions

1. **What consumer state truly belongs in HashSucker?**
   Evidence: a real consumer loss/migration where reconstructing from
   HashSucker truth demonstrably restores the household vs. what had to
   be re-curated by hand.
2. **What is the minimal continuity state?**
   Evidence: subtractive trials — remove a candidate state class and show
   replacement still needs no re-curation.
3. **How much compatibility data is consumer/device-specific?**
   Evidence: same representation played across distinct client classes
   with divergent outcomes logged per class.
4. **How do representation preferences survive codec/client changes?**
   Evidence: a real client or codec transition where old acceptance
   knowledge either transferred or provably expired.
5. **Does predictive preparation measurably improve time-to-play?**
   Evidence: bounded experiments on real household traces with control
   arms; kill on no measured win.
6. **Can provider-independent route knowledge remain useful under
   correlated filtering?**
   Evidence: a real correlated-filtering event where alternate routes
   covered demand vs. where they failed together.
7. **How much preservation policy must the user ever express explicitly?**
   Evidence: behavioral, not survey-based — how often users must express
   policy for correct outcomes, whether defaults/automation handle most
   cases without intervention, and the specific cases where explicit
   override proved necessary. If automation decides reliably, buttons
   are clutter; if it decides wrongly in ways users notice, find exactly
   where and only there add expression.
8. **At what point is a local preserved object more valuable than remote
   reacquisition?**
   Evidence: measured latency/durability deltas on real replays vs.
   local retention cost.
9. **Can consumer reconstruction work without becoming a media-server
replacement?**
   Evidence: a full rebuild from HashSucker truth that stays inside
   consumer contracts (filesystem expectations quarantined in adapters).
10. **What are the current baseline re-request, retry, repair, and
    re-curation rates?**
    Evidence: measured household-trace baselines before any memory,
    healing, or preservation work lands. Without baselines, no kill
    metric can fire and no phase can prove it mattered. This is the
    highest-priority measurement gap in the strategy.
    Partially observed 2026-10-01 (production snapshot, not a trace
    study): 63 repeat groups / 482 requests, top groups converging to
    1–2 hashes over ~50-candidate rankings with zero handoffs; 3 lifetime
    upgrade-watch firings / 95 rows; 125 anticipation executions across
    41 intents with no pre-explicit-demand fulfillment observed.
    Per-decision instrumentation (discovery invoked? ranking invoked?
    exact reuse? wall-clock? failure class?) still missing.
    Partially observed 2026-10-01 (production snapshot, not a trace
    study): 63 repeat groups / 482 requests; 3 lifetime upgrade-watch
    firings / 95 rows; anticipation-sourced 125 requests with no attached
    win measurement. Per-decision instrumentation (discovery invoked?
    ranking invoked? exact reuse? wall-clock? failure class?) still
    missing — see proof-of-need §3 baseline.

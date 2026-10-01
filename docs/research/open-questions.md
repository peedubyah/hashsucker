# Strategic research — open questions

Unresolved questions that must be answered by evidence before
implementation. Each states what evidence would answer it. Guesses are
not answers.

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
7. **What storage policy is understandable to a household?**
   Evidence: comprehension tests — users predict what keep/remove does
   correctly, or the policy is wrong regardless of elegance.
8. **At what point is a local preserved object more valuable than remote
   reacquisition?**
   Evidence: measured latency/durability deltas on real replays vs.
   local retention cost.
9. **Can consumer reconstruction work without becoming a media-server
   replacement?**
   Evidence: a full rebuild from HashSucker truth that stays inside
   consumer contracts (filesystem expectations quarantined in adapters).

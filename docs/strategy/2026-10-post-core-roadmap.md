# Post-Core Roadmap (2026-10)

Engineering artifact. Strategy rationale lives in
`2026-10-post-core-product-strategy.md` ( identities, scenarios, vetoes)
and `2026-10-capability-proof-of-need.md` (re-scoring, slice queue).
Corrections in this revision are marked **[CORRECTED]**.

## Executive direction

Optimize for eliminated household effort — fewer selections, fewer
retries, less waiting, fewer repairs, zero re-curation. Differentiation
comes from durable exact-object memory plus route independence, not from
breadth, onboarding, or prediction cleverness. Near term: make repeats
cheap and failures informative (memory + negative evidence + readiness).
Medium term: survive route loss and rebuild consumers from truth.
Research stays research until a measurement earns it.

## Current earned capabilities (do not rebuild)

- Exact reuse fast path (`tryReuseHealthyPublication`, `reuseMode`
  noop/republish) + fail-closed `/api/library/republish` republication
  route (E01 proof: VFS removed → recreated, canary passed).
- Same-object TorBox↔RD failover with byte proofs; TorBox budgets, RD
  cooldowns, breaker/half-open limiters.
- Bounded anticipation scheduler (15m→1h→4h→24h backoff, MAX_ATTEMPTS=6,
  7-day park) driving prepare/publish/prewarm through production seams.
- Demand-narrowed idle enrichment; hourly upgrade-watch with durability
  veto; consumer reconcile; promotion/download workers (both at zero
  rows in prod — paths exist, demand does not yet).

## Current real deficiencies (observed, not theorized)

1. Repeats re-run full discovery + ~50-candidate ranking to select the
   identical hash (tt10986410: 10 episodes × 9–10 repeats, same top hash,
   zero handoffs). Exact reuse exists but the residue — redundant ranking
   work and zero near-repeat preference — is unaddressed.
2. Failures leave no durable trace: transcode traps and stallers are
   re-derived every request; no negative memory exists anywhere.
3. Readiness is claimed without a fail-closed pre-playback check in the
   serving path; availability revalidation exists adjacent, not gating.
4. Route health is runtime-only (budgets, cooldowns); no per-route
   history survives process lifetime, so no decision can use it.
5. Preservation has machinery (promotion workers) with zero prod rows —
   no evidence whether any household wants explicit keep or correct
   automation.
6. Upgrade sensing fires ~3 times lifetime across 95 watched rows —
   either working perfectly or never firing usefully; undistinguished.

## Near-term slices (maximum 4)

### S1 — Acceptance write path
- Hypothesis: persisting (TF, outcome, reason, context) on successful
  playback lets later decisions skip work and explain preference.
- Why now: repeats are OBSERVED normal operation; write path is additive
  and tiny.
- User problem: re-selection labor + repeat ranking latency on every
  re-request. Value: choosing, waiting.
- Seam: playback-completion hook → new small table. No selection changes.
- Proof: rows with stated reasons, zero synthetic entries; later read by
  a real decision or deleted.
- Kill: never read within N slices, or re-request outcomes identical
  with memory on/off.
- Dependency: none (telemetry exists). Blast: LOW.
- NOT building: selection use, scoring, client taxonomy beyond observed
  divergence (client-class excluded from slice 1 unless baseline
  divergence is observed).

### S2 — Known-bad record + avoidance
- Hypothesis: typed negative memory prevents repeat Laplacian-of-failures
  (same trap, every request).
- Why now: same write path as S1; failure classes already typed in code.
- User problem: retrying known failures (transcode traps, stallers).
  Value: retrying, waiting.
- Seam: failure paths → table → selection filter. Persistence requires
  ≥2 independent representation-specific failures; provider/runtime/
  transient/unknown failures NEVER become representation reputation
  (route-health TTL or forgotten outright).
- Proof: a past failure explained without rediscovery; zero misfires on
  transient-caused rows.
- Kill: misfire on a transient, or avoidance never fires.
- Dependency: S1 machinery. Blast: LOW.
- NOT building: elaborate failure taxonomy beyond the six attribution
  classes; universal vetoes (veto only ≥2 independent failures).

### S3 — Pre-validation readiness probe
- Hypothesis: a cheap fail-closed readiness check before playback claims
  prevents more failure than latency it adds.
- Why now: availability revalidation paths already exist adjacent to the
  serving path; productizing is small.
- User problem: first-play failures that a milliseconds-cheap check
  would have caught. Value: retrying, waiting.
- Seam: availability revalidation → gating position. No new probe
  machinery invented.
- Proof: prevented failures exceed added probe latency on measured plays.
- Kill: probe cost ≥ failure cost, or no observed first-play problem it
  moves off-path.
- Dependency: none. Blast: LOW.
- NOT building: new probing infrastructure; predictive skipping.

### S4 — Typed route-health persistence
- Hypothesis: per-route (last-ok / last-fail / failure-class) history
  enables a future decision current runtime state cannot make.
- Why now: update-on-change writes are cheap; budgets/cooldowns prove
  the signals exist.
- User problem (future): dead-link picks, throttling self-harm. Value
  today: none directly — this slice buys an option, priced as such.
- Seam: placement observation writers. Update-on-change only.
- Proof: consulted by a real named decision within N slices.
- Kill: unread after N slices → delete the table (runtime state was
  sufficient all along).
- Dependency: none. Blast: LOW.
- NOT building: a knowledge layer, dashboards, or healing actions.

## Why these four beat alternatives

- *Single-route reacquisition demo* loses: needs a real loss event first;
  without one it manufactures drama. Parked behind observed loss.
- *Keep/remove expression* loses: zero prod demand signal (promotions:
  0 rows); building UI for unobserved desire is theater. Automation
  posture says wait.
- *Whole-library rebuild demo* loses now: republication (level 1)
  already landed; levels 2–3 demos belong to Codex's reconstruction
  sequencing, not a parallel docs-driven slice.
- *Predictive prewarming expansion* loses: anticipation volume analysis
  shows execution working as designed; no measured win exists to scale.
- *Watched-state ownership* loses: zero migration-loss evidence;
  server-scope creep for a hypothetical.
- *Compatibility taxonomy* loses to S1+S2 with context recorded:
  taxonomize on observed divergence, not upfront.

## Capability dependencies (actual, not narrative)

- S1/S2 need only playback telemetry (exists). Independent of each other
  except shared write machinery.
- S3 needs revalidation paths (exist). Independent.
- S4 needs observation writers (exist). Independent.
- Re-request preference (later): HARD on S1+S2 landed.
- Preservation automation: USEFUL on S4 fragility + S1 demand; HARD on
  neither — can start from demand alone, but shouldn't start at all
  without keep-intent or observed-wrongness evidence.
- Consumer rebuild levels 2–3: HARD on republication route (landed).
- Predictive spend anywhere: HYPOTHESIS until a controlled trace delta;
  never a dependency of anything above.

## Phase candidates (only where coherent)

- **Representation intelligence** (candidate doc exists): survives on
  S1+S2 + measurement slice; kill conditions stand.
- **Consumer reconstruction to level 3**: survives on landed
  republication + bounded next demos; levels 4–6 stay research-gated.
  Codex owns sequencing.
- **Preservation**: expression-first research only; no phase file until
  a wrongness observation or keep-demand evidence earns one.
- **Route health as durable knowledge**: stays a slice (S4), never a
  phase — promotion requires a consuming decision that doesn't exist yet.
- **Predictive preparation**: mechanism-only, measurement-gated; deleted
  as a phase with no restoration path except a controlled win.

## Measurement gates (per slice, not per phase)

- S1: rows read by a decision within N slices; re-request outcome delta
  vs memory-off control.
- S2: avoidance fires with stated reason; zero transient misfires.
- S3: prevented-failures × failure cost > probe count × probe latency.
- S4: named consuming decision identified, or table deleted.
- Phase-level: re-request time-to-playable down OR re-selection failure
  rate down, with hit rate reported alongside (a win at 2% hit rate is
  noise).

## Kill criteria (binding)

- Memory never read / outcomes identical → delete selection use; keep
  or drop tables on storage cost alone.
- Negative memory misfires once on a transient → tighten attribution,
  twice → delete negative use.
- Probe cost ≥ failure cost → remove gating, keep adjacent paths.
- Route-health unread → delete table.
- Any predictive spend without controlled-trace delta → stop spend,
  keep demand-driven behavior.

## Deferred research (not phases, not slices)

- Preservation automation (needs keep-demand or observed-wrongness).
- Compatibility-per-client exploitation (needs observed divergence).
- Whole-library rebuild demo (needs Codex sequencing + scratch env).
- Taste/profile inference (needs lift over recency+explicit baselines;
  none observed).
- Availability map as project (byproduct only).
- Watched-state ownership (needs demonstrated migration loss).

## Explicit vetoes (reaffirmed)

Taste engine as product; native player; watched-state sync; social
reputation; edge cache network; unified governor; generic RouteSet;
availability-map project; predictive expansion; tracker identity as UX.
Each reopens only on the evidence stated in the strategy memo §18 —
none of which has appeared.

## What would change the roadmap

- A real single-route loss event → activates reacquisition demo.
- Measured re-request delta → activates selection-use slice.
- A wrongness observation on retention → activates preservation work.
- A migration loss → activates continuity-state ownership per class.
- A controlled predictive win → activates bounded predictive spend.
- Plex contract breakage on rebuild fidelity → pauses reconstruction,
  reopens adapter strategy.
In the absence of all six, the four slices above plus Codex's
reconstruction sequencing are the entire near-term program.

## Decision log

- 2026-10-01: anticipation volume (125 rows) corrected — scheduler
  executions across 41 intents/21 largely-proof media, bounded retries
  by design, zero pre-explicit-demand fulfillments observed; volume is
  not waste evidence, win is unmeasured not disproven.
- 2026-10-01: repeat analysis — top groups converge to 1–2 hashes over
  ~50-candidate rankings with zero handoffs; exact reuse covers
  byte-identical repeats, memory must earn via near-repeats.
- 2026-10-01: P6 deleted as phase; prediction kept as gated mechanism.
- 2026-10-01: route health demoted to slice-with-deletion-timer;
  availability map demoted to byproduct.

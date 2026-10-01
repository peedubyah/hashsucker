# Engineering Roadmap (2026-10) — Decision-Ready

Canonical engineering program. Strategy rationale:
`2026-10-post-core-product-strategy.md`. Proof-of-need analysis:
`2026-10-capability-proof-of-need.md` (including the 2026-10-01
anticipation-volume correction — scheduler execution counts are normal
scheduled probing, not waste evidence). Sequencing authority stays
`PLANS.md`; Codex owns activation. This document recommends; it does
not sequence.

## 1. Current state (compact, concrete)

| Subsystem | Works | Partial | Unproven / do-not-touch-without-evidence |
|---|---|---|---|
| Request/intent intake | Seerr/API/prepare routes, idempotent intents, fan-out | — | — |
| Discovery | Live seam + corpus merge, exact-key dedup | Live-source flakiness handling | New sources without coverage gap |
| Ranking | Deterministic comparator, tiered eligibility, typed rejections | — | Ranker rewrite (vetoed) |
| Exact identity | infoHash + canonicalInternalPath + size; enforced in binding | — | Any identity change (forbidden) |
| Bindings | Authoritative TF binding, materialize, supersede rules | — | — |
| Placements | TorBox/RD adapters, budgets, cooldowns, breaker | RD playback evidence (122/122 handoffs TorBox-only) | Storm-inducing acquisition |
| Publication/VFS | Idempotent publish, canonical paths, STRM/WebDAV | — | Path semantics changes |
| Plex playback | Real-client canary, session/seek/EOF proofs | Scheduled cadence, outage continuity | PMS-lifecycle mutation without plan |
| Rust byte delivery | Ranges, grid cache, coalescing, retry/Retry-After, failover | — | Cross-TF decisions (forbidden to Rust) |
| Lifecycle recovery | Restart self-heal, stale-inventory throttle | Long-run churn repro | Generic suppression |
| Republication | `/api/library/republish` fail-closed reuse (E01 proof) | Levels 2–3 rebuild demos | Consumer-state ownership |
| Anticipation | Bounded scheduler (backoff, MAX_ATTEMPTS=6, 7d park) | Measured win | Expansion, cadence changes |
| Upgrade watch | Hourly ticker, durability veto | Firing→watch correlation (3 lifetime firings) | Aggressive re-probing |
| Enrichment | Demand-narrowed idle enrichment | Later-use attribution | Broad scavenging |
| Provider observation | Observations tables, budgets, cooldowns | Durable history use | New subsystems before a named decision |
| Reuse paths | Healthy-publication fast path (noop/republish) | Firing rate unmeasured | Weakening health conditions |

## 2. Actual pain map

**Observed** (production DB / logs / proofs): repeat requests re-run
full discovery + ~50-candidate ranking to select the identical hash
(9–14× per group, zero handoffs on the heaviest groups); failures leave
no durable trace so traps re-fire; first-play has no fail-closed
readiness gate in the serving path; route health dies with the process.
**Inferred** (code paths + reason, uncounted): multi-client outcome
divergence; single-route loss frequency; keep-demand existence.
**Hypothetical** (no evidence): migration loss, predictive wins,
taste-lift, availability-map consumers. Inferred and hypothetical items
do not gate near-term work; they gate research.

## 3. Opportunity-cost comparison

Four near-term bets compete for the same engineering weeks. Acceptance
memory (S1+S2) vs pre-validation (S3): memory pays on every repeat
forever, validation pays per prevented failure — memory first because
63 repeat groups are observed and first-play failures are uncounted.
Route health (S4) vs healing actions: knowledge is cheap and deletable,
actions need loss events not yet observed — knowledge now, actions on
event. Preservation/rebuild/taste all cost more and prove less today;
each week spent there is a week the observed repeat waste continues.

## 4. NOW — maximum 4 slices, code-ready

### N1 — Acceptance write path
Hypothesis: persisting (TF, outcome, reason, context) on successful
playback lets later decisions skip work and explain preference. Seam:
playback-completion hook → new small table (TF id, client-class *only
if baseline divergence observed*, outcome, reason, timestamp,
route-used). Proof: rows with stated reasons, zero synthetic entries,
read by a real decision within N slices. Kill: never read, or
re-request outcomes identical with memory on/off. Blast: LOW. Scope
guard: write-only; no selection changes, no scoring, no taxonomy.

### N2 — Known-bad record + avoidance
Hypothesis: typed negative memory stops repeat failures. Seam: failure
paths → table → selection filter. Persistence requires ≥2 independent
representation-specific failures; provider/transient/unknown failures
never become representation reputation (route-health TTL or forgotten).
Proof: past failure explained without rediscovery; zero transient
misfires. Kill: one transient misfire (tighten) / two (delete use).
Blast: LOW. Scope guard: six attribution classes only, no veto below
the repeat threshold.

### N3 — Pre-validation readiness probe
Hypothesis: a cheap fail-closed check before playback claims prevents
more failure than latency it adds. Seam: existing availability
revalidation moved to gating position. Proof: prevented-failures × cost
> probes × latency on measured plays. Kill: probe cost ≥ failure cost.
Blast: LOW. Scope guard: no new probe machinery, no predictive skipping.

### N4 — Typed route-health persistence
Hypothesis: per-route (last-ok / last-fail / failure-class) history will
serve a future decision runtime state cannot. Seam: observation
writers, update-on-change only. Proof: consulted by a named decision
within N slices. Kill: unread → delete the table (runtime was enough).
Blast: LOW. Scope guard: no layer, no dashboards, no healing actions.

### Branch conditions
- If N1+N2 measurement shows no re-request delta → delete selection
  use; keep tables only if republication/debugging reads them. Roadmap
  falls back to N3 + reconstruction demos.
- If N3 probe cost exceeds failure cost → remove gating; keep adjacent
  paths. Effort shifts to N4's consuming decision or healing-on-event.
- If a real single-route loss event occurs → activate reacquisition
  demo ahead of schedule (pre-designed, not pre-built).
- If N1–N4 all succeed → P1 phase exit is earned; open preservation
  expression (keep/remove) as the next bounded slice.

## 5. NEXT — maximum 4 conditional bets

1. **Re-request prefers accepted** (needs N1+N2 landed): selection
   integration with explanations; A/B re-request outcomes; kill on no
   delta; MEDIUM blast (touches selection).
2. **Single-route reacquisition demo** (needs a real loss event):
   same-TF recovery, Binding unchanged; kill if loss never observed.
3. **Keep/remove expression, no automation** (needs keep-demand signal):
   minimal intent surface + usage logging; kill if unused.
4. **Whole-library rebuild demo, scratch only** (needs Codex sequencing):
   timed rebuild, zero drift; kill on Plex-contract infidelity.

## 6. LATER — research only

Compatibility-per-client exploitation, preservation automation,
predictive spend with controls, availability-map consumers,
watched-state ownership, migration tooling. Each gated per
`open-questions.md`; none scheduled.

## 7. NO — explicit vetoes (reaffirmed with cause)

Taste engine as product; native player; watched-state sync; social
reputation; edge cache network; unified governor; generic RouteSet;
availability-map project; predictive prewarming expansion;
tracker-identity UX. Reopen evidence is stated per item in the strategy
memo §18 — unchanged by this pass.

## 8. Prediction stance (final)

Three separate things: (1) **Resource triage** — ordinary scheduler
policy over boring metrics; not a moonshot; the per-queue due-time +
backoff ordering already exists and suffices at current volumes; a
shared signal earns existence only if queues demonstrably misallocate
shared provider budget (not observed). (2) **Near-term demand
prediction** — allowed as bounded proactive work where measured
(next-episode, post-release intent, hot repeats); each use needs hit
metric + false-positive cost + kill (see §10). (3) **Taste inference** —
vetoed as product; permitted only as ranking-tiebreak heuristic with
measured lift over recency+explicit-demand (no such lift observed).

## 9. Anticipation stance (final)

Known future intent with published dates is ordinary automation, not a
fault. Rule: before release time, no source/provider spend; after
release, bounded availability probing is normal. Volume is not waste
evidence (corrected 2026-10-01: 125 execution rows, bounded retries,
stop conditions working). Evaluate only on: cadence sanity, retry
bounds, rate-limit behavior, duplicate expensive work, post-release
time-to-fulfillment, stop conditions, failure attribution. Current
verdict on all seven: healthy — **leave anticipation alone**. Reopen
only on a concrete defect in that list.

## 10. Action ladder for predictive spend (cheap heuristic baseline first)

metadata-only < discovery < enrichment < validation < route readiness <
cache warming < local preservation. Higher cost requires stronger
signal (explicit demand > active-series continuation > post-release
intent > popularity) **and** a measured win. ML enters no rung without
beating its heuristic baseline on traces first.

## 11. Measurement gates

Per slice: N1 read-by-decision + outcome delta; N2 fires with reasons +
zero misfires; N3 prevented-cost > probe-cost; N4 named-consumer or
delete. Phase-level: re-request time-to-playable down or re-selection
failure rate down, hit rate reported alongside. Baselines (Q10) are the
prerequisite instrument, not a slice.

## 12. Kill decisions executed this pass

- Unified governor/background-unification: killed (queues order by
  due-time + backoff adequately at observed volumes; no shared-budget
  contention demonstrated).
- Compatibility taxonomy: killed as upfront work (record context, no
  taxonomy).
- P6-as-phase: already dead; reaffirmed.
- Whole-library rebuild as near-term: killed (Codex sequencing + scratch
  env required; research-only).
- Taste/profile inference product: killed again, explicitly.
- 8-slice READY list from prior pass: cut to 4 (single-route demo,
  keep/remove, rebuild demo, enrichment audit moved to NEXT/research
  on evidence grounds).

## 13. What would force a rewrite

A real single-route loss event; measured re-request delta (either
direction kills or confirms P1); a migration loss; a controlled
predictive win; Plex-contract breakage on rebuild fidelity; provider
budget contention between queues. Absent all six, this document stands.

## 14. Decision log

- 2026-10-0x: near-term cut to N1–N4; alternatives parked with named
  triggers (this document).
- 2026-10-01: anticipation volume corrected (proof-of-need doc).
- 2026-10-01: P6 deleted as phase; prediction = gated mechanism.
- Graduation READY + republication route landed (Codex; PLANS.md).

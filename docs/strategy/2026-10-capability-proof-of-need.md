# Capability Proof-of-Need (2026-10)

Companion to `2026-10-post-core-product-strategy.md`. This document
re-scores every retained candidate on observed frequency × pain, strips
roadmap inflation by separating what exists from what is new, and leaves
each survivor with an experiment design or a kill condition. No new
vocabulary is introduced.

Evidence-quality labels: **OBSERVED** (production DB, logs, or recorded
proofs), **INFERRED** (reasoned from code paths without usage counts),
**HYPOTHETICAL** (no evidence yet). Production snapshot cited below:
482 requests, 63 repeat groups, 122 handoffs (all TorBox), 132 library
items, 105 bindings, 1937 torrent files, 95 upgrade-watch rows with 3
lifetime `upgraded` outcomes, 61 playable + 23 anticipated future intents.
Request sources: seerr 190, anticipation 125, api 77.

## 1. Re-scored portfolio

**Accepted representation memory** — Frequency: OBSERVED high (63 repeat
groups on 482 requests; re-request is normal operation, and the reuse
fast path already fires on it). Pain: moderate per event (full
discovery + ranking + provider checks on every repeat), high in
aggregate. Partially solved today: YES — `tryReuseHealthyPublication`
short-circuits exact repeats with zero discovery. Unique advantage:
YES — no competitor persists per-household acceptance. Simpler incumbent:
reuse predicate alone handles byte-identical repeats; memory's marginal
value is specifically *near*-repeats (same media, changed market) and
explained preference. Verdict: earn by slice 4 measurement.

**Known-bad representation memory** — Frequency: INFERRED low-moderate
(transcode traps and stallers recur per client class, but no counted
failure taxonomy exists yet). Pain: high per event (a 10-minute
transcode trap dwarfs ranking cost). Partially solved: NO. Unique
advantage: YES. Simpler incumbent: none (ranker re-derives every time).
Verdict: earn by requiring repeated independent failures before
negative persistence; kill on misfire.

**Scoped compatibility knowledge** — Frequency: INFERRED (multi-client
divergence assumed, not yet logged per class). Pain: moderate. Partially
solved: NO. Unique advantage: partial (TRaSH profiles cover generic
cases). Simpler incumbent: static profiles suffice until divergence is
observed. Verdict: record context from day one (cheap), exploit only
when divergence is OBSERVED.

**Route-health knowledge** — Frequency: OBSERVED (provider 429s,
cooldowns, stale placements, and the RD filter era are all recorded
phenomena; budgets and cooldowns already react at runtime). Pain:
moderate-high (throttling self-harm, dead-link picks). Partially solved:
YES at runtime (TorBox budgets, RD cooldown, breaker/half-open);
missing as *durable* knowledge. Unique advantage: partial (proxies do
this ephemerally). Simpler incumbent: runtime-only state suffices until
a decision needs history older than a process lifetime. Verdict: persist
only what a named future decision consumes; delete anything unread
after N slices.

**Pre-validation** — Frequency: OBSERVED (every playback pays readiness
uncertainty today). Pain: low-moderate per play. Partially solved: YES
(availability revalidation paths exist). Unique advantage: weak (it's
good engineering, not differentiation). Simpler incumbent: none needed.
Verdict: build where the check is cheaper than the failure it prevents;
measure, don't assume.

**Exact-object reacquisition** — Frequency: OBSERVED in tests and
failover proofs; single-route loss in the wild is INFERRED (rare but
real, e.g. filtering events). Pain: total (unplayable library item).
Partially solved: YES (same-object failover proven). Unique advantage:
YES (exactness preserved across providers). Verdict: productize the
single-route case narrowly; kill autonomous healing actions that cost
more quota than observed saves.

**Preservation/locality policy** — Frequency: HYPOTHETICAL for explicit
demand (no household has asked to keep anything through product
surface); INFERRED for implicit need (rare content, fragile routes).
Pain: currently zero observed (nothing lost that retention would have
saved — no such incident recorded). Partially solved: NO. Unique
advantage: unclear (Arr download-everything covers the crude version).
Verdict: expression surface first (keep/remove), automation only on
observed wrongness. The weakest BUILD-adjacent item; one negative
household trial kills the automation half.

**Consumer reconstruction** — Frequency: INFERRED rare (server migrations
and DB losses happen yearly-or-less per household). Pain: catastrophic
(full re-curation). Partially solved: republication route LANDED
(single-item rebuild without rediscovery, canary-passed). Unique
advantage: YES. Simpler incumbent: backups (work until they don't).
Verdict: KEEP — rare × catastrophic with a tiny slice cost is the exact
profile worth building. Whole-library rebuild and Plex→Jellyfin remain
unproven demonstrations, not claims.

**Continuity-state classes** — Frequency: HYPOTHETICAL per class (no
migration loss ever recorded here). Pain: varies by class (intent =
total; favorites = mild). Partially solved: NO. Verdict: RESEARCH ONLY,
per-class re-curation test. Import-on-migration beats continuous sync
in every class until proven otherwise.

**Predictive preparation** — Frequency of *successful* prediction:
HYPOTHETICAL. [CORRECTED 2026-10-01: the "125 anticipation requests"
figure previously cited here is scheduler executions (113
future-intent prepare + 12 publish rows) across 41 intents / 21 media,
dominated by proof/drill traffic — not household demand volume and not
waste evidence. Retries are bounded by design (15m→1h→4h→24h backoff,
MAX_ATTEMPTS=6, 7-day park; 87 intents resolved in 1 attempt). Zero
cases observed where anticipation preceded an explicit request, so
time-to-fulfillment benefit is unmeasured — not disproven.] Pain
addressed: startup waiting. Partially solved: anticipation scheduler +
reuse fast path already capture the repeat case without prediction.
Unique advantage: none demonstrated. Verdict: measure existing
machinery with controls before any expansion; kill on no delta.

**Enrichment/background intelligence** — already narrowed to unresolved
demand. Frequency of payoff: INFERRED (no later-use attribution
recorded). Verdict: audit sufficiency, expand never without numbers.

## 2. Existing vs new capability (inflation removed)

| Candidate | Already exists | Actually missing | New outcome only if |
|---|---|---|---|
| Reuse on repeat | `tryReuseHealthyPublication`, noop/republish modes, `/api/library/republish` | acceptance *across* market changes | memory fires on near-repeats |
| Failover | same-object provider recovery, proven | typed durable route health; single-route reacquisition | zero-healthy-route recovery demonstrated |
| Provider observation | observations.js, budgets, cooldowns, breaker | durable per-route history consulted by decisions | a decision reads history older than uptime |
| Binding reuse | exact reuse predicate, republication route | whole-library rebuild demo | rebuild timed with zero drift |
| Pre-validation | availability revalidation paths | fail-closed readiness as product guarantee | prevented failures exceed probe cost |
| Anticipation | scheduler, quality gates, prewarm; 125 execution rows across 41 intents (mostly proof media), bounded retries by design | measured win | controlled trace delta |
| Upgrade sensing | hourly watch, durability veto | firing→watch correlation | watched upgrades beat static profiles |
| Promotion/local path | promotion/download workers, materialize+verify | policy deciding *what* deserves locality | retained bytes watched more than cost |

Rule applied throughout: no renaming of existing behavior into phases.
Anything whose "new outcome" column is weak was demoted above.

## 3. Acceptance-memory proof-of-value design

**Baseline (measure first, all OBSERVED-collectible):** on the 63 repeat
groups, per re-request: was discovery invoked? ranking invoked? was the
exact representation reused (reuseMode)? wall-clock time? any
user-visible failure or retry? any bad-representation reselection
(same media, worse outcome than a prior success)? The reuse fast path
already answers the byte-identical case — the experiment measures the
residue it does *not* cover.

**Minimal remembered fact:** `(torrent_file_id, outcome, reason,
observed_at)` plus client-class **only if** outcomes diverge by class
in the baseline. Challenge accepted: client-class is excluded from
slice 1 unless baseline divergence is observed. Route-dependent facts
(provider speed, cache warmth) are never acceptance facts.

**Future-decision use (exact):** prefer previously accepted exact TF on
re-request with stated reason; reject TFs with ≥2 independent
representation-specific failures; skip full ranking only when memory
hits with fresh-enough context; choose among equivalents by acceptance
recency, never by invented score.

**Success metric:** re-request time-to-playable down OR re-selection
failure rate down on measured traces, with memory-hit rate reported
alongside (a win with 2% hit rate is noise).

**Kill condition:** outcomes identical with memory on/off over ≥4 weeks
of re-request traffic, or hit rate below the noise floor — then delete
selection use; keep or drop the table on storage cost alone.

## 4. Negative-evidence rules

Attribution classes, in order of persistence-worthiness: (1)
**representation failure** (same failure across routes/providers/clients
— persist after 2 independent occurrences); (2) **consumer
compatibility failure** (fails on one client class, plays on another —
persist scoped to that class only); (3) **provider/runtime failure**
(429s, cooldowns, dead links — never representation reputation; belongs
to route health with short TTL); (4) **transient network/CDN failure**
(never persist; retry-budget domain only); (5) **publication failure**
(binding/VFS/materialization defects — persist as defect reports, not
as representation judgments); (6) **unknown failure** (never persist;
the product forgets rather than becoming confidently wrong).

Strength rule: one failure is an anecdote; two independent failures are
evidence; contradictory success demotes immediately. Negative memory
expires on obsolescence signals (client fleet change, provider regime
change) rather than timers where possible.

## 5. Consumer-reconstruction capability levels

1. **Publication artifact recreated** (single VFS row rebuilt from
   truth, no rediscovery). Effort removed: manual re-request +
   re-wait. Frequency: rare. Value: proves the mechanism. Creep: none.
   Owner: HashSucker, natural. **LANDED.**
2. **Consumer sees item again** (Plex/Jellyfin presence confirmed).
   Effort: re-scan babysitting. Frequency: rare. Value: closes the loop
   level 1 leaves open. Creep: low. **Next bounded demo.**
3. **Consumer can play it** (byte-verified playback post-rebuild).
   Effort: verification labor. Frequency: rare. Value: turns rebuild
   from claim into proof. Creep: low. **Gate with canary.**
4. **Whole consumer library reconstructed.** Effort: full re-curation
   (catastrophic). Frequency: very rare. Value: existential. Creep:
   medium (batch tooling). **Bounded demo only, on synthetic wipe.**
5. **Consumer replacement/migration succeeds** (Plex→Jellyfin with zero
   re-curation). Effort: migration project. Frequency: very rare.
   Value: category-defining if demonstrated. Creep: HIGH (contract
   divergence, dual-consumer testing). **Research-gated.**
6. **Consumer-specific state survives** (watched/resume/favorites).
   Effort: re-curation of personal state. Frequency: per migration.
   Value: real but server-shaped. Creep: SEVERE (becoming a media
   server). **Not levels of independence — call them what they are:
   migration tooling, owned only on demonstrated loss.**

Levels 1–3 are reconstruction. Levels 4–6 are migration capabilities
requiring separate evidence each. Never auto-commit upward.

## 6. Preservation decision model (automatic first)

Act on automatically measurable inputs only; each must clear
measurable/trustworthy/useful with bounded failure cost:

- **Reacquisition latency** (measured per route): slow → retain bias.
  Wrong-cost: disk held unnecessarily (cheap, evictable).
- **Provider diversity** (route count per TF): single-route → retain
  bias. Wrong-cost: same as above.
- **Representation rarity** (candidate/result depth): rare → retain
  bias. Wrong-cost: same.
- **Demand frequency** (replay counts): repeated → retain bias.
  Wrong-cost: same.
- **Object size** (bytes): large → evict bias (carrying cost concrete).
  Wrong-cost: re-download on surprise replay.
- **Route fragility** (failure class history): flapping → retain bias.
  Wrong-cost: same as latency row.
- **Explicit user intent** (keep/remove): overrides everything when
  present. Wrong-cost: user-visible (hence keep the surface minimal).
- **Local storage pressure** (free bytes): evict bias under pressure
  only, never eagerly.

Explicit human input is required **only** where automation is observed
wrong in ways users notice. Default posture: no policy UI beyond
keep/remove; every additional control must cite an observed wrong
decision it prevents. Goal restated: minimize explicit preservation
policy, not design prettier storage management.

## 7. Prediction framework (heuristic-first, per use)

| Use | Heuristic baseline | ML/profile alternative | Hit metric | False-positive cost | Effort saved | Verdict |
|---|---|---|---|---|---|---|
| Pre-enrichment | recency + unresolved-demand queue (exists) | learned priority | future-discovery latency | wasted provider calls | waiting | heuristic wins today; measure |
| Pre-validation | check-before-claim on every playback path | predicted-failure skipping | prevented failures | probe latency added | retrying | heuristic; ML never needed |
| Ranking | acceptance memory + recency | taste/profile scores | re-request outcomes | wrong picks cost plays | choosing | heuristic; ML on kill-gated trial only |
| Route readiness | verify on use + cooldowns (exists) | predicted availability | avoided dead picks | stale predictions mislead | waiting | heuristic wins; predictions rot |
| Preservation | replay + rarity + fragility rules (§6) | demand forecasting | retained-and-watched rate | disk held pointlessly | managing storage | heuristic first, always |
| Browsing/selection reduction | none (explicit intent suffices) | recommendations | clicks saved | attention cost + wrongness | choosing (claimed) | VETO — no fulfillment benefit |

Privacy/state note: heuristics use already-owned operational facts
(requests, plays, routes). ML alternatives would demand profiling stores
with retention/explanation burdens — an additional cost booked against
any trial, not assumed away.

## 8. Phase candidates surviving this pass

- **Representation intelligence** (candidate doc exists): survives on
  §3 experiment + §4 rules. Slices 1–2 (persist accept/known-bad) are
  READY-grade; slices 3–4 gated on measurement.
- **Consumer reconstruction to level 3**: survives on republication
  landing + bounded next demos. Levels 4–6 stay research-gated.
- **Preservation**: survives as expression-first + automatic-rules
  research (no phase file until a wrongness observation earns one).
- **Route health as durable knowledge**: survives only with a named
  consuming decision; otherwise runtime state stays runtime.
- **Predictive preparation**: stays mechanism-only, measurement-gated.
- **Continuity state**: stays per-class research with re-curation test.
Demoted to non-phase status: availability map (byproduct), unified
governor (vetoed), taste engine (vetoed), watched-state sync (deferred).

## 9. Engineering slice queue (unsequenced — Codex owns activation)

1. **Acceptance write path** — persist (TF, outcome, reason, context)
   on successful playback. Proof: rows with stated reasons, zero
   synthetic entries. Kill: never read by a decision in N slices.
   Blast: LOW. Deps: playback-completion hook. No Codex conflict
   (additive table + hook). → READY AFTER CURRENT CODEX SLICE.
2. **Known-bad record + avoidance** — §4 rules into selection filter.
   Proof: past failure explained without rediscovery. Kill: misfires.
   Blast: LOW. → READY AFTER CURRENT CODEX SLICE.
3. **Re-request prefers accepted** — selection integration with
   explanations. Proof: A/B re-request outcomes. Kill: no delta.
   Blast: MEDIUM (touches selection). → NEEDS EVIDENCE (slices 1–2
   landed first).
4. **Typed route-health persistence** — per-route last-ok/last-fail/
   class, update-on-change. Proof: consulted by a real decision.
   Kill: unread after N slices. Blast: LOW. → READY AFTER CURRENT
   CODEX SLICE.
5. **Pre-validation readiness probe** — fail-closed check before
   playback claims. Proof: prevented failures > added latency. Kill:
   probe cost exceeds failure cost. Blast: LOW. → READY AFTER CURRENT
   CODEX SLICE.
6. **Single-route reacquisition demo** — same-TF recovery with zero
   healthy routes, Binding unchanged. Proof: demonstrated recovery.
   Kill: no observed single-route loss in the wild. Blast: MEDIUM
   (acquisition paths). → NEEDS EVIDENCE (needs a real or faithfully
   reproduced loss event).
7. **Keep/remove expression (no automation)** — minimal intent surface
   + usage logging. Proof: comprehension + logged usage. Kill: unused
   or misunderstood. Blast: LOW. → NEEDS EVIDENCE (demand for explicit
   control unobserved; automation-first posture says wait).
8. **Whole-library rebuild demo (synthetic wipe, scratch)** —
   reconstruction level 4 bounded proof. Proof: timed rebuild, zero
   drift. Kill: Plex contracts block fidelity. Blast: LOW (scratch
   only). → RESEARCH ONLY (needs Codex sequencing + scratch env).

## 10. Explicit next-step vetoes (do not follow the republication slice)

1. **Predictive prewarming expansion** — unmeasured provider spend and
   no controlled win measurement; note this is about the *expansion*,
   not the existing scheduler, whose execution volume is normal
   scheduled probing (bounded retries, stop conditions work) and is
   not waste evidence. Reopen on controlled trace delta.
2. **Watched-state ownership/sync** — server-scope creep with zero
   recorded migration loss. Reopen on demonstrated loss only.
3. **Preservation UI beyond keep/remove** — automation-first posture;
   extra controls need observed-wrongness citations.
4. **Route-health knowledge layer as project** — runtime state suffices
   until a named decision needs history; slice 4 covers the narrow need.
5. **Compatibility taxonomy expansion** — record context first; taxonomize
   only on observed divergence.
6. **Generic consumer adapter framework** — one consumer integration at
   a time, each on demonstrated need; frameworks precede second use.
7. **Availability-map project** — byproduct of route-health work or
   nothing.
8. **Taste/profile inference** — no lift over recency+explicit demand;
   veto stands.

## 11. What changed in canonical docs (minimal)

- `docs/ROADMAP.md`: P4 status reflects landed republication slice;
  candidate phase ordering notes P1 slices 1–2 as next-ready per this
  analysis (sequencing still Codex-owned).
- `docs/phases/candidate-representation-intelligence.md`: status notes
  experiment design (§3) and slice-queue position; no activation.
- `docs/research/open-questions.md`: baseline-measurement question
  answered in part (repeat groups, upgrade firings, anticipation volume
  now observed); remaining gap is per-decision instrumentation.
- `PLANS.md`: untouched (Codex sequencing active).
- No product code touched. No new skills, frameworks, or vocabulary.

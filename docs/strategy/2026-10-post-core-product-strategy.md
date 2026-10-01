# Post-Core Product Strategy (2026-10)

Where HashSucker goes now that request → publication → playback → recovery
is boringly reliable. Evidence-gated throughout: every capability below
names what would prove it worthless. Companion docs: `GOALS.md` (north
star), `docs/ROADMAP.md` (sequenced ladder), `docs/research/open-questions.md`
(unanswered questions). This memo is analysis; the ladder is the plan.

## 1. Executive strategic conclusion

Optimize for **eliminated household effort**: fewer selections, fewer
retries, less waiting, fewer repairs, zero re-curation. The durable
advantage over the ecosystem is not discovery, ranking cleverness, or
prediction — it is **durable exact-object memory plus route independence**:
what played well is remembered, and playback survives route loss without
representation drift. No incumbent can bolt that on, because every
incumbent stores state inside the thing that gets replaced (provider
cache, disk layout, media-server database, per-play search with no memory).

Sequencing thesis: memory first (representation acceptance from proven
playback), then independence behaviors that consume memory (healing,
preservation, reconstruction), with prediction only as a measured tool
inside those phases — never as a phase, never as identity.

## 2. Where we stand (ground truth, not aspiration)

Per `docs/BUILD-LOG.md` and `PLANS.md`: core graduation READY. Proven —
request/publication/playback with byte evidence, exact TorrentFile identity
across providers/restarts/refactors, same-object TorBox↔RD failover,
host-only canary rotation (E01/E05/MobLand), stale-inventory retry bound.
Explicitly unproven — scheduled cadence, lifecycle recovery, PMS outage
continuity, long-run churn reproduction. Active: Codex's
consumer-neutral republication slice (`/api/library/republish`
delegating to the exact-reuse predicate, fail-closed).

Already implemented and relevant: reuse fast path (`reuseMode`
noop/republish), anticipation scheduler (future intents → prepare/publish/
prewarm with quality gates), upgrade-watch (below-terminal re-probe with
durability veto), demand-narrowed idle enrichment, consumer reconcile,
promotion/download workers, TorBox call budgets + RD cooldowns.

## 3. Ecosystem comparison (no caricatures)

**Plex + Arrs + rdt-client.** Manual effort remaining: curation, download
management, storage management, provider juggling, repair when links die.
Waits: acquisition latency on every new want. Breakage: total on provider
loss, disk loss, or Plex DB loss (re-curation each time). Good enough:
mature clients, music/photos, sharing, skip-intro. HashSucker advantage:
zero acquisition management, survival of provider/disk/server replacement.
Do not compete: clients, music, social/discovery UX.

**Stremio-style (Stremio + Torrentio/Comet + debrid).** Manual effort:
near-zero for single plays; real effort appears as repeated selection
friction (dead links, re-picking every episode) and zero memory.
Waits: per-play discovery + link-generation latency, every time. Breakage:
provider filtering kills cached links silently; no library to lose because
there is no library. Good enough: casual single-user watching, breadth of
sources. Advantage: everything Stremio throws away — acceptance memory,
route redundancy, no re-selection, library survival. Do not compete:
source breadth, addon ecosystem, zero-setup onboarding.

**Jellyfin-centric stacks.** Manual effort: full Arr-equivalent ops plus
self-hosted server care. Breakage: same file-ownership fragility as
Plex+Arrs. Good enough: open, no paywall, pluginable. Advantage: same as
vs Plex+Arrs, plus Jellyfin's openness makes it the better long-term
consumer surface. Do not compete: server implementation itself.

**Direct-debrid / mounted-media (zurg/rclone mounts, Infuse+WebDAV).**
Manual effort: mount care, scanner babysitting, no lifecycle. Breakage:
single-provider dependence with no failover intelligence. Good enough:
simple households with one provider. Advantage: failover, memory,
lifecycle. Do not compete: mount simplicity for single-provider users.

**Conventional local-library ownership.** Manual effort: everything
(acquire, organize, repair, migrate). Breakage: disk death. Good enough:
full control, no accounts. Advantage: only where ownership removes effort
(preservation policy) — never chase local-everything.

## 4. User-effort model

Capabilities must reduce at least one category or be challenged out:

| Effort | What removes it | Current coverage |
|---|---|---|
| choosing (which link/version) | acceptance memory + selection | Partial (ranker exists, memory missing) |
| waiting (time-to-play) | pre-validation, readiness, memory-shortened discovery | Partial (reuse fast path exists) |
| repairing (dead links/entries) | route healing, republication | Started (failover proven; republication active) |
| retrying (failed plays) | known-bad memory, route health | Missing |
| re-curating (after loss/migration) | reconstruction from truth | Active (republication slice) |
| managing storage | keep/remove policy + automation | Missing (intent exists, policy doesn't) |
| managing providers | multi-route + failover + health | Partial (two providers, budgets) |
| managing clients | per-client compatibility memory | Missing |
| maintaining library state | reconcile (exists) + reconstruction | Partial |
| deciding what to preserve | preservation policy | Missing |
| responding to failures | typed errors + autonomous recovery | Partial (typed errors exist) |

## 5. Capability matrix

**Accepted representation memory** — Problem: re-deriving quality every
request; re-picking known-good. Effort: choosing, waiting. Status:
missing (outcomes observed in telemetry, not persisted as knowledge).
Fit: native — TorrentFile identity is the key. Depends on: playback
telemetry (exists). Evidence have: repeated successful plays in logs.
Missing: persistence + selection use. Cost: LOW (small table, write path
on success). Failure: stale compatibility (clients change). Alternative:
Stremio (none — re-resolves always); Arrs (static profiles). Differentiator:
memory no competitor stores. Kill: re-request outcomes unchanged over
measured traces. **→ BUILD SOON.**

**Known-bad representation memory** — Problem: retrying known failures
(transcode traps, stallers). Effort: retrying, waiting. Status: missing.
Fit: same table family as accepted memory. Depends on: failure telemetry
(exists). Cost: LOW. Failure: false-bad from transient provider faults
(mitigate: require repeated/independent failures). Alternative: none
competitors persist this. Kill: avoidance never fires or misfires.
**→ BUILD SOON** (same slice family as accepted memory).

**Compatibility knowledge (per client-class)** — Problem: one success
isn't universal; Shield vs tablet diverge. Effort: choosing, retrying.
Status: missing. Fit: extends acceptance memory with context key. Depends
on: client identification at playback (exists in paths). Missing:
multi-client outcome dataset. Cost: LOW-MEDIUM. Failure: sparse data per
class. Alternative: TRaSH static profiles (generic, not household).
Kill: outcomes don't diverge by client in practice. **→ BUILD SOON**
(scoped: record context from day one, exploit when data suffices).

**Route-independent exact-object recovery** — exists as failover; gap is
proactive healing + single-route reacquisition. Effort: repairing.
Status: partially implemented. Depends on: placements, budgets (exist).
Missing: standing route-health knowledge. Cost: MEDIUM. Failure: healing
loops burning quota (bound it). Alternative: Stremio re-pick (manual);
Arrs re-download (heavy). Kill: route-loss events rare enough that
on-demand failover covers all observed cases. **→ BUILD SOON** (narrow:
typed route-health knowledge first; autonomous healing actions only on
measured saves).

**Provider-route health knowledge** — typed per-route last-ok/last-fail/
failure-class. Effort: repairing, managing providers. Status: missing as
durable knowledge (budgets/cooldowns are runtime-only). Cost: LOW.
Kill: never consulted by a decision within N slices. **→ BUILD SOON.**

**Preservation/locality policy** — keep/remove expression + automatic
rules on exact objects. Effort: managing storage, deciding preservation.
Status: intent exists; policy missing. Fit: policy attaches to
intent/object, not download jobs. Depends on: demand signals + rarity +
route health (all obtainable). Missing: behavioral evidence on what
households actually keep. Cost: MEDIUM (policy + migration + eviction
safety). Failure: disk-full modes; incomprehensible automation.
Alternative: Arr download-everything (the opposite). Kill: households
never express keep-intent AND automation decides wrongly where noticed.
**→ RESEARCH with defined slices** (expression surface first, automation
only where wrongness is unobserved).

**Automatic preserve/cache decisions** — same as above, automation half.
**→ RESEARCH** (gated on preservation-expression evidence).

**Consumer reconstruction** — rebuild projections from truth without
rediscovery. Effort: re-curating. Status: ACTIVE (Codex republication
route). Fit: exact reuse predicate already exists. Kill: rebuilds never
fire in practice. **→ BUILD SOON** (already selected; docs lane does not
duplicate).

**Consumer-neutral state** — per-class ownership verdicts. Effort:
re-curating. Status: unanswered per class. **→ RESEARCH** (migration-loss
experiments only).

**Watched/resume/favorites/collections** — Effort: re-curating after
migration. Status: Plex/Jellyfin own them today. Fit: poor — owning them
means media-server scope creep. **→ DEFER** (import-on-migration only,
and only when a real migration demonstrates the loss).

**Predictive preparation** — Effort: waiting. Status: anticipation
scheduler exists (future intents, quality gates, prewarm). Missing:
measurement of whether it beats on-demand + reuse. Cost: provider/API
spend per prewarm. Failure: wasted preparation, throttling self-harm.
Alternative: Stremio (none — always cold); reuse fast path (already
captures the repeat case). Kill: no time-to-play or API-cost win on
household traces with controls. **→ RESEARCH** (measure existing
machinery first; expand nothing until then).

**Taste/profile inference** — Effort claimed: browsing/selection.
Status: absent. Fit: poor — demand in this product is explicit intent +
active-series continuation, both observable without inference. Cost:
modeling + profiling state + explanations owed. Failure: wrong guesses
that cost provider calls. Alternative: recency + continuation heuristics
(free). Kill (pre-applied): show lift over recency+explicit-demand
baseline first — no such evidence exists. **→ VETO as product;
DEFER as ranking-tiebreak heuristic only with measured lift.**

**Pre-validation** — fail-closed readiness check before playback claims.
Effort: retrying, waiting. Status: partially present (availability
revalidation paths). Cost: LOW (read-only checks). Kill: checks cost
more latency than the failures they prevent. **→ BUILD SOON.**

**Demand-weighted enrichment** — exists, narrowed to unresolved demand.
Effort: waiting (faster future discovery). **→ KEEP + measure** (does
current narrowing suffice?). Expansion: **DEFER**.

**Availability map** — longitudinal route/playability truth. Effort:
repairing, managing providers. Status: fragments in telemetry/budgets.
Fit: infrastructure, not product. Kill: never consulted by healing,
preservation, or selection within N slices. **→ RESEARCH** (build as
byproduct of route-health work, never as standalone project).

**Provider correlation/failure diversity** — Effort: repairing under
correlated events (e.g. keyword filtering). Status: unmeasured. Depends
on: real correlated event observed. Kill: providers fail independently
in all observed events. **→ RESEARCH** (opportunistic: instrument now,
analyze on next real event).

**Representation upgrade/downgrade** — upgrade-watch exists (below-
terminal re-probe + durability veto). Effort: choosing (better version
appears). Missing: evidence that firings correlate with watch outcomes.
**→ RESEARCH** (measure firing→watch correlation; expand/contract on
that number).

**Consumer-specific representation selection** — serve per-client best
from multi-representation knowledge. Effort: choosing, retrying. Depends
on: acceptance memory + client-class outcomes (both nascent).
Kill: single representation direct-plays everywhere in practice.
**→ RESEARCH** (downstream of P1 slices 1–3).

**Storage reconstruction** — reconstitute local bytes after loss.
Effort: repairing, managing storage. Depends on: preservation policy +
route health. **→ RESEARCH** (tied to P3; no independent standing).

**Cross-provider exact-object reacquisition** — same bytes via another
provider when a route dies. Effort: repairing. Status: pattern proven
(failover); productized single-route case missing. Kill: single-route
loss never observed outside tests. **→ BUILD SOON** (narrow).

## 6. Why HashSucker Might Not Need This

- *Representation memory may not move outcomes.* If households mostly
  play once and move on, acceptance rows accumulate but never fire; the
  ranker was already good enough. Defense retained: known-bad avoidance
  pays even at low replay rates (one avoided 10-minute transcode trap
  beats a thousand unused rows), and measurement (P1 slice 4) kills it
  cleanly if wrong.
- *Stremio is good enough.* For casual single-user watching, true — and
  conceded: do not chase breadth, onboarding, or source count. The
  retained bet is narrow: memory + survival + no re-selection, which
  Stremio structurally cannot add without becoming a different product.
- *Consumer reconstruction solves a rare event.* Possibly. Defense: the
  slice is tiny (one fail-closed route over an existing predicate) and
  the payoff is total (migration without re-curation). Rare × catastrophic
  beats frequent × trivial — but if rebuilds never fire in two years, the
  maintenance cost must be re-examined.
- *Local preservation reintroduces storage management.* Real risk;
  retained only with the keep/remove comprehension test as gate and
  automation-first posture. If the UI grows beyond keep/remove, the phase
  has failed its own premise.
- *Predictive preparation wastes provider resources.* Agreed in advance —
  hence RESEARCH-only with pre-registered kill criteria, and a standing
  ban on expansion before measurement.
- *Taste inference is harder than waiting for explicit demand.* Agreed —
  vetoed as product for exactly this reason; the only surviving sliver is
  tiebreak heuristics with measured lift, which will probably also die.
- *Watched-state ownership duplicates Plex badly.* Agreed — deferred to
  migration-loss evidence that may never arrive.
- *Continuity may be story without daily value.* The strongest attack.
  Retained defense: continuity decomposes into daily-value pieces
  (no re-selection, instant replays, surviving provider death), each
  independently measurable. If none measures out, the category dies and
  HashSucker is "reliable fulfillment" — still a complete, honest product.

## 7. Alternative product identities

1. **Playable Media Control Plane** — foregrounds: exact routing of
   intent to bytes. Encourages: execution excellence, budgets, failover.
   Creep risk: becomes infrastructure plumbing with no household-visible
   wins. Serves: operators. Competes: rdt-client/zurg-style plumbing.
   Success: boring reliability metrics.
2. **Household Media Continuity** — foregrounds: survival of the media
   life across replacements. Encourages: memory, healing, preservation,
   reconstruction. Creep risk: owning everything (watched state, social,
   recommendations) in continuity's name. Serves: households with
   libraries worth keeping. Competes: nothing directly — that is both
   the opportunity and the warning. Success: replacement without
   re-curation, demonstrated.
3. **Provider-Independent Media Library** — foregrounds: debrid freedom.
   Encourages: multi-provider machinery, failover features. Creep risk:
   defined by providers; dies if providers converge or disappear.
   Serves: debrid power users. Competes: Stremio+multi-debrid setups
   head-on (their home turf). Success: plays through provider death.
4. **Exact Representation Memory** — foregrounds: knowing what plays
   well. Encourages: outcome logging, compatibility knowledge.
   Creep risk: telemetry hoarding without selection use. Serves:
   multi-device households. Competes: TRaSH-style static profiles.
   Success: re-requests measurably better.
5. **Zero-Babysitting Media Fulfillment** — foregrounds: autonomy.
   Encourages: removing every manual step. Creep risk: autonomy theater
   (hidden work mistaken for absent work). Serves: everyone. Competes:
   Arrs on convenience. Success: interventions-per-N-requests near zero.
6. **Consumer-Independent Media State** — foregrounds: server freedom.
   Encourages: state ownership maximalism. Creep risk: reimplementing
   Plex feature-by-feature. Serves: migrators. Competes: media servers
   themselves (unwinnable). Success: migration without loss.

North star: **(2) Household Media Continuity**, constrained by (5) as the
daily discipline (every capability must reduce babysitting measurably).
External positioning: (5) first (understandable, provable), (2) as the
reason to stay. Architecture guide: (1) Control Plane (routes, identity,
budgets) with (4) as its memory subsystem. (3) is a milestone inside (2),
not an identity. (6) is a means, never the thesis.

## 8. Capability graph → phases

Nodes with dependency types (HARD / USEFUL / HYPOTHESIS):

- exact identity (exists) — root.
- acceptance memory —HARD→ identity; nothing else hard-required.
- known-bad memory —HARD→ failure telemetry (exists).
- route-health knowledge —HARD→ placement/budget observations (exist).
- republication —HARD→ reuse predicate (exists); USEFUL→ acceptance memory.
- self-healing actions —HARD→ route health; USEFUL→ acceptance memory;
  HYPOTHESIS→ that autonomous action beats on-demand failover.
- preservation expression —HARD→ intent model (exists); USEFUL→ demand +
  rarity + route health.
- preservation automation —HARD→ expression semantics; HYPOTHESIS→ that
  automation decides correctly unnoticed.
- consumer reconstruction —HARD→ bindings + truth (exist).
- continuity state —HYPOTHESIS on each class (see research Q1/Q2).
- predictive preparation —HYPOTHESIS everywhere it appears; gated tool only.
- compatibility-per-client —USEFUL→ acceptance memory volume.

Derived phases (graph, not ladder — independent branches proceed in any
order once entry gates pass): **P1 memory** (acceptance + known-bad +
context, slices 1–4 in candidate doc); **P2 healing** (route health
knowledge first, actions only on measured saves); **P3 preservation**
(expression surface first, automation gated on unnoticed-correctness);
**P4 reconstruction** (republication route active; rebuild demo;
migration evidence); **P5 continuity research** (per-class verdicts);
**P6 predictive** dissolved as phase — measurement-gated tool available
to P1–P4. P4 does not require P1–P3 (bindings suffice for a meaningful
rebuild); P2 does not require P1 (Binding states what to save); P3 wants
P2's fragility costs but can start from demand alone.

## 9. Near-term slice portfolio

1. **Acceptance write path** — persist (TorrentFile, client-class,
   outcome, reason) on successful playback. Seam: playback-completion
   hook → new small table. Proof: rows with stated reasons, zero
   synthetic entries. Value: choosing/waiting (future). Risk: schema
   churn. Blast: LOW. **Best first slice.**
2. **Known-bad record + avoidance** — typed failure reasons consulted
   at selection. Seam: failure paths → table → selection filter.
   Proof: past failure explained without rediscovery. Risk: transient
   misclassification (require repeats). Blast: LOW.
3. **Re-request prefers accepted** — selection integration with
   explanations. Seam: `selectBindableCandidate` + reuse predicate.
   Proof: A/B re-request outcomes. Risk: stale compatibility. Blast:
   MEDIUM (touches selection).
4. **Typed route-health knowledge** — per-route last-ok/last-fail/class.
   Seam: placement observation writers. Proof: consulted by a real
   decision within N slices or deleted. Risk: write amplification
   (mitigate: update-on-change only). Blast: LOW.
5. **Keep/remove expression (no automation)** — minimal intent surface.
   Seam: library intent model. Proof: comprehension + usage logging.
   Risk: UI nobody uses. Blast: LOW.
6. **Pre-validation readiness probe** — fail-closed check before playback
   claims. Seam: availability revalidation path. Proof: prevented
   failures > added latency. Risk: probe cost. Blast: LOW. **Best
   fallback if slice 1 blocked.**
7. **Single-route reacquisition** — same-TorrentFile recovery with no
   healthy route at failure. Seam: failover + acquisition paths. Proof:
   demonstrated recovery with Binding unchanged. Risk: quota burn
   (bound it). Blast: MEDIUM.
8. **Demand-weighted enrichment audit** — measure current narrowing;
   expand only on numbers. Seam: existing worker + metrics. Proof:
   sufficiency or gap. Risk: none (read-only). Blast: LOW.

**Explicitly NOT yet:** predictive prewarming (no measurement), watched-
state ownership (no migration loss evidenced), taste/profile inference
(no lift over baselines), availability-map project (byproduct only),
unified governor (vetoed).

## 10. Representation-intelligence deep dive

Remember: `(TorrentFile id, client-class, outcome, reason/evidence,
timestamp, route-used)`. Success granularity is per (TF, client-class)
with a global default for thin data; route-dependent facts live in
route-health, never in acceptance. One success is not universal truth:
require repeats or multi-context before preference strengthens; any
contradictory outcome demotes immediately; client-fleet changes expire
affected rows (explicit invalidation beats silent timers, but timers are
acceptable as backstop with stated horizons). Selection influence:
prefer + explain; veto only known-bad with ≥2 independent failures.
Discovery/ranking work drops when re-requests hit memory instead of
full pipeline; user-visible failure drops when known-bad is avoided.
Minimal schema: one table, ~7 columns, keyed by (tf_id, client_class).
Smallest first slice: write path only (slice 1 above). No-value proof:
re-request outcomes identical with memory on/off over measured traces —
then delete selection use, keep or drop the table on storage cost alone.

## 11. Predictive/taste deep dive

Per use, benefit/cost/false-positive/data/privacy/heuristic-vs-ML/kill:
- *Likely-demand estimation:* benefit = earlier readiness; cost = wasted
  provider calls; FP cost = throttling self-harm + noise; data = recency
  + active series + calendar (already owned); heuristics almost surely
  win (demand here is explicit + sequential, not latent). Kill: no lift
  over recency+explicit-demand baseline.
- *Enrichment prioritization:* exists narrowed; benefit = fresher future
  discovery; measure current sufficiency first. Kill: no discovery-latency
  delta.
- *Preservation choices:* benefit = right bytes local; needs demand +
  rarity + fragility signals; heuristics first (keep rules from observed
  replay), ML never justified at household N. Kill: automation wrong
  where noticed.
- *Pre-validation:* deterministic, not predictive — BUILD.
- *Ranking:* acceptance memory dominates predicted taste; kill taste
  features that don't beat memory+recency.
- *Browsing/selection reduction:* VETO — recommendation UX without
  fulfillment benefit.
- *Route prewarming:* benefit = shaved startup; cost = provider spend +
  cache churn; FP = warming unwatched content; needs real traces;
  heuristics (active-series next episode) first. Kill: no startup-latency
  delta with controls.
Conclusion: **heuristics first everywhere; ML nowhere currently
justified; pre-validation builds now.**

## 12. Continuity-state deep dive (per class)

- *User intent:* own (canonical). Loss forces full re-curation. No creep:
  already owned.
- *Exact chosen representation (Binding):* own. Loss = re-curation of
  every choice. Core product.
- *Accepted history:* own (new; P1). Loss degrades selection silently —
  own it once it drives decisions.
- *Preservation intent:* own **iff expressed** (keep/remove); unexpressed
  policy stays derived. Canonical only for expressed rows.
- *Watched/resume/favorites/collections:* DEFER to Plex/Jellyfin.
  Re-curation pain is real but ownership means server-scope creep;
  revisit only on demonstrated migration loss. Import-on-migration, never
  continuous sync.
- *Subtitle/audio prefs:* client owns; ignore (read at playback if free).
- *Consumer settings/library metadata:* ignore (reconstructible or
  cosmetic).
No bundled continuity DB — each class earns ownership separately or not
at all.

## 13. Preservation deep dive

Remote→local when: repeated playback AND (fragile routes OR slow
reacquisition) AND keep-intent or auto-rule fires; evict when: policy
removed AND demand decayed AND healthy routes exist; reacquisition wins
when: single likely play + multi-route health + large size. KEEP =
durable intent with reconstitution duty surviving route/storage loss.
AUTO starts with **zero explicit policy**: derive from demand, rarity,
provider diversity, size, reacquisition latency, expressed intent; add
expression surfaces only where automation is observed wrong. Anti-
download-manager guards: no queues, no progress UI, no manual fetch
buttons, no staging concepts in product surface; retention actions are
route operations, never downloads. Policy hypotheses + kills: keep-rule
fires on replay+fragility (kill: retained bytes unwatched for N months);
evict-on-decay (kill: evicted items re-requested within window);
remote-wins-large-single-play (kill: latency complaints on those plays).

## 14. Consumer-reconstruction deep dive

Codex's republication route exists in worktree: fail-closed delegation
to the exact-reuse predicate. Distinguish: (a) republish VFS artifact
(single item, no rediscovery — built); (b) reconstruct Plex projection
(library entries from truth); (c) rebuild whole library (bounded demo);
(d) migrate Plex→Jellyfin (research — contract differences untested);
(e) preserve watched/resume (deferred — see §12). Smallest valuable
capability: (a), already underway — docs lane claims nothing here.
(b) is the natural next bounded demo. Proof reconstruction matters: timed
rebuild vs manual re-curation with zero representation drift; one real
migration-loss story beats ten synthetic demos. An API seam is not
independence — independence is demonstrated loss survival.

## 15. Means vs ends

ENDS (user outcomes): no re-curation; faster time-to-play; no manual
recovery; replaceable providers/consumers/storage. MEANS: taste models,
prediction, representation memory, availability map, prewarming,
preservation policy, compatibility profiling. Rule: every roadmap item
must name its end; means without a measured end are deleted on sight.
Prediction/taste are means, permanently ineligible for promotion to ends.

## 16. Metrics (each tied to a kill)

- p50/p95/p99 request-to-play (kills preparation phases that don't move it).
- Manual interventions per 1k requests (kills autonomy theater).
- Re-selection/retry rate (kills memory phases that don't reduce it).
- % fulfilled via remembered representation (kills P1 selection use).
- % route failures recovered without drift (kills healing actions).
- Consumer-rebuild time + drift count (kills reconstruction).
- Local bytes per user-hour-saved (kills preservation automation).
- Prework hit rate + false-positive provider cost (kills prediction spend).
No dashboard mandate — measure per-slice, keep what kills or confirms.

## 17. Three roadmap scenarios + recommendation

**Conservative:** reliability + republication + pre-validation + enrichment
audit. Risks: under-differentiation (a very reliable Stremio-alternative
without memory moat). Switch away if: re-request/retry metrics show
memory would move them (then memory work starts).
**Differentiated:** conservative + P1 memory slices 1–4 + route health +
keep/remove expression. Risks: schema/volume without payoff; mitigated by
per-slice kills. Differentiator: the only system that remembers.
Switch away if: slice-4 measurement fails (fall back to conservative).
**Aggressive:** differentiated + preservation automation + predictive
prewarming + continuity-state ownership. Risks: scope explosion, provider
spend, server-creep; needs migration-loss and trace evidence that does
not currently exist. Switch away if: any two kill gates fire.
**Recommended: differentiated with conservative fallback pre-armed.**
Memory slices are cheap, bounded, and deletable; preservation automation
and prediction stay gated. If P1 slice 4 fails, the persisted tables
alone still serve republication and debugging — the work is rarely wasted.

## 18. Veto list (10 explicit no-gos)

1. Taste/recommendation engine as product — no lift over explicit demand;
   reopen on measured lift that survives controls. Tempting because
   "personalization" sounds like progress.
2. Native player — decade treadmill; clients exist. Reopen: never (adapters win).
3. Watched-state continuous sync — server-scope creep; reopen on demonstrated migration loss.
4. Social reputation network — coordination cost at household N is absurd; reopen: never at this scale.
5. Distributed friend/family edge cache — legal gray + ops cost for a problem routes solve. Reopen: provider collapse scenario.
6. Unified governor/desired-state framework — reflex architecture; reopen: three concrete scheduling conflicts attributable to its absence.
7. Generic RouteSet abstraction — roadmap already refuses; reopen: a second provider-integration pattern that actually needs it.
8. Availability map as standalone project — byproduct only; reopen: a decision that needs longitudinal truth and can't get it cheaper.
9. Predictive prewarming expansion — unmeasured spend; reopen: trace-measured startup win with controls.
10. Tracker/search-site identity as UX — site slang is not identity; reopen: never (architectural principle, not measurement).

## 19. Wiki projection notes (not a rewrite)

Strategy docs are written projection-ready: phases carry why/outcome/
gates/kills; vetoes carry reopen conditions; research questions carry
evidence requirements. A future wiki pass can lift sections verbatim
under Product-Direction/Roadmap without restructuring.

## 20. Open strategic questions that genuinely matter

1. Does acceptance memory move re-request outcomes on real traces? (P1 slice 4 answers.)
2. Is single-route loss frequent enough to justify healing actions? (Failure census answers.)
3. Will any household express keep-intent, or must automation be right silently? (Behavioral evidence answers.)
4. Does a real migration loss ever materialize to justify continuity-state ownership? (Only events answer.)
5. Does predictive spend beat on-demand + reuse on measured traces? (Controls answer.)

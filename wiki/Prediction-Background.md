# Predictive and Demand-Weighted Work

Three different things travel under "prediction" here. They have
different evidence bars, different costs, and different fates. Do not
merge them.

## 1. Resource triage (ordinary policy, exists)

Deciding where bounded background work goes using boring metrics:
explicit intent, recent household activity, release timing, repeat
demand, route fragility, unresolved state, saved-latency estimates,
work cost. This is scheduler policy, not a moonshot. Current per-queue
ordering (due-time + backoff) suffices at current volumes; a shared
triage signal earns existence only if queues demonstrably misallocate
shared provider budget. No unified governor exists and none is planned.

## 2. Near-term demand preparation (bounded, measured)

The anticipation scheduler drives known future intents through the
*existing* production seams — prepare, publish from prepared truth via
reuse, byte-probe, prewarm — never a second pipeline. Semantics that
matter:

- **No speculative probing before published release time.** Expected
  dates gate preparation windows (movies ~30d, TV episodes ~3d;
  publish windows 7d/1d). Unaired/unreleased media costs nothing.
- **Bounded retries with backoff:** 15m → 1h → 4h → 24h
  (`intentBackoffMs`), `MAX_ATTEMPTS = 6`, then parked — retried volume
  is designed, not waste.
- **Stop conditions are real:** terminal prepare failures, attempt
  exhaustion (parked 7 days), quality-gate rejection, uncached
  revalidation → withdrawal via safe-unpublish with history preserved.
- **After eligibility, bounded availability retries are normal.** This
  is what Sonarr/Radarr-style systems do: release time ≠ source
  availability, caches propagate asynchronously, one miss says nothing
  about the next check.

Legitimate criticisms of anticipation are specific and checkable:
pathological cadence, duplicate expensive work, rate-limit harm, poor
post-release fulfillment latency, stuck retries, unattributed failures.
"Scheduler retry volume exists" is not one of them.

## 3. Taste/recommendation inference (vetoed as product)

Allowed only as an implementation tool when it measurably reduces user
interaction, waiting, failed selection, or preparation latency — never
as product identity. No taste engine, no recommendation UX, no social
graphs. The stance is "prediction must earn measurable value," not
anti-prediction. Current status: no such tool has earned its cost;
heuristics (recency + explicit demand + active-series continuation win
every comparison so far.

## Background workers at a glance

| Worker | Trigger / cadence | Cost | Stop conditions |
|---|---|---|---|
| Anticipation scheduler | 15-min tick, one intent per tick | Prepare/publish/prewarm calls | Windows, backoff, MAX_ATTEMPTS, quality gate, withdrawal |
| Upgrade watch | Hourly, one row per tick | One market re-probe | Terminal tier reached, durability veto, parked |
| Idle enrichment | Hourly quiet tick, human-demand-gated sources | One bounded live query | Backoff 1h→24h, daily budget, zero-yield skip |
| Corpus maintenance | 6h tick | DMM sync reads | Bounded sessions, lifecycle persistence |
| Reconcile / hygiene / promotion / download | Per-timer | Scoped to their seams | Documented in Background-Jobs |

## Source references

- `media-search/src/lib/anticipation/scheduler.js`,
  `future-intents.js`, `prewarm.js`, `quality-gate.js`
- `media-search/src/lib/lifecycle/upgrade-watch.js`,
  `media-search/src/lib/discovery/idle-enrichment.js`
- `GOALS.md` (prediction stance), `docs/strategy/*` (kill criteria)

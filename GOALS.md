# HashSucker goals (north star, not tasks)

## Goal hierarchy

### Immediate product goal
Boring, autonomous playable-media fulfillment: request → publication →
real playback → recovery, with no human babysitting.

### Strategic product goal
Persistent exact representation knowledge and route-independent
fulfillment: what played well is remembered, and playback survives
route loss without representation drift.

### Long-term category goal
Household media continuity: replace providers, disks, media servers,
and clients without re-curating household media life.

## Durable product goals

1. Any household media intent becomes reliably playable bytes with no
   human babysitting: request → publication → real playback → recovery.
2. Exact-object identity is never regressed: the same bytes are the same
   object across providers, restarts, and refactors.
3. Provider/runtime failure should not change media identity or user
   intent; handle it as route/reconstruction state whenever possible.
4. No human decision required → no human interface required (product
   principle; operator tooling is separate from product UX).
5. Reduce household effort and time-to-play: prefer remembered decisions,
   automatic preparation, and invisible recovery wherever they reliably
   remove interaction or waiting.

## Core reliability exit condition (met — graduation READY per PLANS.md)

Core hardening is done when: deterministic canary proves request →
publication → real Plex playback → provider/restart recovery end to end,
with bytes verified (ranges/hashes), failure attribution preserved in
telemetry, and no manual repair step in the loop. That bar is recorded
as met; product evolution is unblocked. The non-goals below stand
independently and still require per-slice justification to lift.

## Open product/architecture research question (not an implementation requirement)

> What is the minimum durable state HashSucker must own so that a
> household can replace every provider, every disk, and the entire media
> server/client ecosystem without re-curating its media life?

Track candidate answers in retrospectives and phase context, not in code.

## Non-goals (standing unless a slice proves otherwise)

- Speculative acquisition/prefetch without measured demand evidence.
- Second implementations of identity, ranking, or reuse paths.
- Rewriting working subsystems without a failing acceptance proof.
- Dashboards, predictions, or automation that substitute for end-to-end
  playable evidence. (Prediction, profiling, and taste-like inference
  are allowed as implementation tools when they measurably reduce user
  interaction, waiting, failed selection, or preparation latency — never
  as product identity. The stance is "prediction must earn measurable
  value," not anti-prediction.)
- Retired 2026-10-01: blanket "no new product surface before the exit
  condition" (condition met; product surface now needs per-slice
  justification instead).

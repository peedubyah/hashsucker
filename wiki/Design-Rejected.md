# Rejected Abstractions

Things the project tried or considered and refused, with the reason on
record. A refusal lifts only on new evidence that directly invalidates
the reason — never on enthusiasm. Canonical log: `docs/BUILD-LOG.md`,
`docs/retrospectives/`.

| Refused | Reason |
|---|---|
| Second identity/ranking/reuse implementations | One model, enforced; duplicates rot into disagreement |
| Speculative background acquisition | Provider state without measured demand burns quota and trust |
| Predictive scheduler / unified work governor | Unearned by evidence; timers stay dumb and bounded |
| Show-identity resolver integration | Measured recall/precision didn't justify it; parked |
| Contextual-memory schema | Existing request/result/handoff state already expresses it |
| Tier-D reuse stage | Provenance ambiguity; keep the fast path single |
| Scheduler throughput tuning (shared-cap two-lane) | A/B showed no production win (A3, 2026-09-12); default OFF |
| Download-manager UX, Arr "monitored means acquire" | Download-era verbs; intent is the product, files are not |
| Recommendation engine, native player, ceremonial Emby | Out of scope for a fulfillment layer |
| Generic route abstraction without need | Routes earn existence per provider adapter |
| AI theater, tracker identity as core product | Identity is bytes+path+size, not site slang |
| Chaos/lifecycle behavior inside the canary | Canary is a playback probe; fault injection is separately approved |
| Unbounded retry/suppression of failures | Throttles are failure-specific and bounded, or defects hide |

## Source references

- `docs/ROADMAP.md` (Phase A outcome, deferrals), `GOALS.md` (non-goals),
  `handoff/CURRENT.md` (parked verdicts with measurements)

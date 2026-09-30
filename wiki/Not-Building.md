# Decisions — Things We Deliberately Are Not Building

Each refusal is load-bearing: it protects reliability work from scope creep.

- **Speculative acquisition** — no background provider state without
  measured demand evidence. (Enrichment narrowed to unresolved demand.)
- **Second implementations** — one identity model, one ranker, one reuse
  path. Duplicates refused, not refactored.
- **Predictive scheduler / unified work governor** — not earned by evidence.
- **Show-identity resolver integration** — parked after measurement.
- **Contextual-memory schema** — parked; existing request/result/handoff
  state already expresses it.
- **Tier-D reuse stage** — parked on provenance ambiguity.
- **Download-manager UX, Arr assumption imports** ("monitored means
  acquire"), native player, recommendation engine.
- **Scheduler throughput tuning** beyond the decided A3 gate.

> Refusals lift only on new evidence that directly invalidates the reason
> recorded in `docs/BUILD-LOG.md` or retrospectives — never by enthusiasm.

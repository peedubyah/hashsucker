# Project History

Compressed. Evidence lives in `docs/BUILD-LOG.md` and
`docs/retrospectives/`; releases in `docs/releases/`.

- **v0.1–v0.4** — appliance UI + operator API, diagnostics probe cache,
  housekeeping utility, deploy pins; production re-pinned on published
  images with byte-identical range proofs.
- **Scheduler A/B (2026-09-12)** — shared-cap two-lane: functional, no
  production win. Default OFF, work stealing deferred. The template for
  "correct implementation is not a reason to enable it."
- **Enrichment triage (2026-09-27/28)** — background enrichment narrowed
  to unresolved human demand; marginal-gain measured, not assumed.
- **Failover proofs (2026-09-26–28)** — same-TorrentFile TorBox↔RD byte
  proofs, Plex-part failover, route-failure behavior with zero discovery,
  ranking, or representation change.
- **Fulfillment hardening (2026-09-29)** — fulfillment truth +
  recent-release recovery.
- **PMS lifecycle (2026-09-30)** — partial/stopped by instruction; idle
  replay observed, active continuity unproven.
- **Canary scope correction (2026-09-30)** — playback probe, not chaos
  harness; sentinel rotation 3/3 fit for modest-cadence regression use.
- **Repo operating system (2026-09-30)** — AGENTS.md loop, GOALS.md,
  PLANS.md, build log, phase files, retrospectives, slice-runner skill;
  wiki as one-way projection.
- **HY4 lineage** — historical handoffs under `docs/archive/hy4/` and
  the `hy4-*` volume/container names. Do not trust old containers or
  HY4-era assumptions; names survive, semantics moved on.

## Source references

- `docs/BUILD-LOG.md`, `docs/releases/`, `handoff/CURRENT.md`

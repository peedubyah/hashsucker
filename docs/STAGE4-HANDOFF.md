# Stage 4 foundation handoff

**Baseline:** `59ae063` (`feat(acquisition): add Stage 4 decision foundation`)  
**Scope:** Provider reality and explainable acquisition decisions downstream of Stage 3.

## Current foundation

- `media-search/src/lib/providers/observations.js` — provider-neutral cache observations: provider/account, scope and exact subject, authority kind, `cached|uncached|unknown|error`, timestamps/expiry, source/evidence, and typed retry/error metadata.
- `media-search/src/lib/providers/errors.js` — provider error categories and retry/rate-limit normalization.
- `media-search/src/lib/providers/capabilities.js` — independently implemented provider capabilities; unsupported behavior is absent rather than represented by misleading flags.
- `media-search/src/lib/discovery/cache.js` — append-only `provider_observation_events`, newest-current `provider_observation_current`, and exact-identity current/history reads.
- `media-search/src/lib/acquisition/policy.js` — version-1 ordered provider/account targets.
- `media-search/src/lib/acquisition/decision.js` — pure `decideAcquisition()` evaluator.
- `media-search/test/provider-contracts.test.js`, `media-search/test/cache.test.js`, and `media-search/test/acquisition-decision.test.js` — executable contract coverage.

## Decision flow

```text
unchanged Stage 3 ranked candidates
  + current provider observations
  + ordered provider/account policy
  → selected | deferred | unavailable
```

Candidate rank remains primary. A fresh authoritative `cached` observation selects the first resolvable ranked candidate. A lower rank may be considered only when every configured target authoritatively reports the higher rank `uncached`. Missing, unknown, error, stale, unbounded, inferred, or predicted evidence must defer rather than masquerade as unavailability. Provider preference applies only among targets for the same candidate. The result includes exact identity, rank, provider/account, decisive observation, reason code, and per-target evaluations.

## Invariants

1. The accepted boundary is that Stage 3 ends at a ranked candidate set derived from static evidence. Do not add new provider reality to Stage 3 retrieval/ranking or modify `ranking.js`/`search-engine.js` for acquisition selection.
2. Preserve Stage 3 order. Stage 4 may fall through after authoritative unavailability; it must not re-rank or mutate candidates.
3. Exact identity is `(infoHash,fileIndex)`/`releaseKey`; `null` is distinct from `0`. Never project torrent-level authority onto a file-level candidate without an explicit validated contract.
4. Keep provider and account scopes isolated. No observation may leak across either boundary.
5. Only fresh authoritative evidence is decisive. Unknown/error/stale/non-authoritative evidence is not `uncached`.
6. Keep append-only observation history separate from the newest-current projection and keep priors/predictions separate from provider authority.
7. Decision evaluation stays pure: no provider calls, persistence, placement, request publication, or fulfillment side effects.
8. Keep provider capabilities independent; do not imply that one supported operation means another is supported.

**Existing divergence:** The unchanged legacy Stage 3 runtime still computes a weighted `providerAvailability` component from fresh authoritative observations in `ranking.js`/`search-engine.js`. Stage 4 did not introduce or modify this coupling. Treat provider-independent ranking as the accepted boundary and separate implementation debt; do not conceal it or redesign Stage 3 while implementing the Stage 4 adapter.

## Intentionally unimplemented

- Active API/search/request-path wiring and policy persistence/configuration.
- Probe scheduling, batching orchestration, budgets, stopping rules, and refresh workers.
- A validated adapter from provider cache responses/current storage rows into exact candidate-decision observations.
- Real-Debrid cache checks and live provider credentialed integration.
- Placement selection/create/reuse, provider-file mapping, exposure, fulfillment, or importer dispatch from the decision result.
- Provider-specific production TTL/rate-limit policy.

The foundation also needs hardening before runtime wiring: require deterministic explicit observation time, preserve separate authoritative/inferred/predicted lanes, reject non-candidate scopes, validate candidate aliases and explicit `fileIndex`, fail closed on future/impossible timestamps, and define empty-candidate semantics.

## First implementation slice checklist

- [ ] **Provider observation adapter:** Normalize current provider/storage observations for configured provider/account targets while preserving scope, subject, authority kind, state, and error metadata.
- [ ] **Exact candidate projection:** Emit decision-ready evidence only for an exact `(infoHash,fileIndex)`/`releaseKey` match. Never project torrent-scoped evidence onto a file candidate.
- [ ] **Freshness validation:** Require explicit evaluation, observation, and expiry times; fail closed for stale, future, unbounded, malformed, or internally inconsistent evidence.
- [ ] **Fixtures:** Cover mixed authority kinds, provider/account isolation, `null` versus `0`, candidate versus torrent scope, stale/future/unbounded evidence, unknown/error preservation, and authoritative-uncached fallback.

Exit: deterministic fixture coverage for exact-candidate observations, with no I/O, live provider wiring, Stage 3 changes, or acquisition execution.

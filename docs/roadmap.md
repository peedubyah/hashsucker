# Roadmap

**Source:** [`audit/8-21-audit.md`](audit/8-21-audit.md), verified 2026-08-21.
**Current stage:** Stage 0 — security and deployability.

This roadmap is staged to be reversible. Target behavior below is not implemented unless explicitly stated elsewhere.

## Stage 0 — Security and deployability

- Rotate/remove committed credentials.
- Authenticate mutation routes or document/enforce a trusted network boundary.
- Install production dependencies in the backend image and include required runtime configuration.
- Choose one UI topology: built into `media-search` or a separate deployed service.
- Persist `DISCOVERY_DB` on a mounted volume.
- Add clean-image startup and restart-persistence coverage.

**Exit:** A clean deployment serves the intended UI/API topology and retains discovery state across restart.

## Stage 1 — Executable API contract

- Convert the current code-verified Markdown contract into executable schemas or contract tests.
- Synchronize UI/JSDoc types with the selected active normalized metadata fields.
- Correct known runtime contract defects, including swallowed validation details and corpus confidence mapping.
- Introduce exact `releaseKey` and propagate `fileIndex` through API, UI keys, request JSON, importer DB, status, and logs.
- Continue documenting only implemented routes and lifecycle states.

**Exit:** Backend contract tests and frontend type/build checks fail on DTO drift; two files from one hash remain distinguishable end to end.

## Stage 2 — Exact identity and identity-safe retrieval

- Require selected-media association for local eligibility.
- Scope identity confidence to that association.
- Add explicit episode coverage for singles, ranges, and packs.
- Apply hard rejection before preference scoring.
- Audit merge/upsert semantics and add cross-title, multi-file, null-index, and multi-association fixtures.

**Exit:** Unrelated corpus rows cannot enter a selected-media result; exact candidates survive all boundaries.

## Stage 3 — Canonical normalization and global ranking

- Normalize local/live candidates into one evidence shape.
- Deduplicate by `releaseKey` only.
- Apply one provider-independent desirability score and deterministic tie-breakers.
- Return hard rejection reasons and score explanations.
- Remove pre-ranking limits that hide stronger eligible candidates, or make bounded retrieval behavior explicit and measured.

**Exit:** Source order does not determine final order; live and corpus versions of an exact candidate merge without losing evidence.

## Stage 4 — Provider capability and fresh observations

- Define provider-neutral cache, placement, resource, file-inventory, exposure, and removal capabilities without erasing provider differences.
- Add observation state, scope, TTL, error category, retry/rate-limit/auth semantics, and current/history separation.
- Connect TorBox batching/failure behavior to the active path; add Real-Debrid checks.
- Keep priors separate from authoritative observations.

**Exit:** The same exact candidate can be checked against either provider with no cross-provider leakage and with unknown/error behavior visible.

## Stage 5 — Canonical library contract and shadow reconciliation

- Define library item, stable path, placement, provider file, binding version, health, and typed event concepts.
- Add provider/mount inventory interfaces.
- Implement a read-only shadow reconciler: compute desired mappings and failures without mutating providers or visible paths.
- Test duplicate basenames, multi-file torrents, missing/stale mounts, collisions, and failover choices.

**Exit:** Shadow reconciliation is deterministic and exposes typed failures without side effects.

## Stage 6 — Real-Debrid/Zurg vertical slice

- Add/reuse one Real-Debrid placement.
- Inventory provider files authoritatively.
- Expose through Zurg and a hidden read-only rclone mount.
- Atomically project one exact movie/episode to a stable canonical path.
- Trigger catalog refresh and observe visibility/playability separately.

**Exit:** One item reaches a stable provider-independent path without routing bytes through HashSucker.

## Stage 7 — TorBox WebDAV parity and physical fallback hardening

- Validate current TorBox WebDAV authentication, layout, file selection, refresh, consistency, Range/seeking, and mount behavior.
- Add it behind the same capability/binding contracts if validation passes.
- Preserve physical TorBox import if it fails.
- Add importer backoff/fair scheduling/dead-letter handling and review legacy deletion.
- Propagate exact release provenance and typed outcomes through physical mode.

**Exit:** A canonical item can use either validated provider without identity/path churn, and one blocked physical request cannot starve others.

## Stage 8 — Resilient virtual-library cutover and telemetry

- Reconcile placement, provider file, WebDAV, mount, target, binding, catalog, and optional open/playback state.
- Add bounded recovery, ownership-aware repair/removal, atomic rebinding, and complete binding history.
- Surface actual lifecycle milestones to UI/operators.
- Test provider lag, mount loss, stale directory caches, target disappearance, restart, rebinding, catalog failure, and cleanup refusal.

**Exit:** The UI never reports `cached` or `placed` as `playable`; controlled failures recover or fail closed without identity churn.

## Stage 9 — Transactional, resumable DMM ingestion

- Route a CLI/one-shot command through the verified iframe/hash extractor and shared parser path.
- Persist run/source revision/fragment checkpoints, lock one writer, use bounded transactions/retries, and define WAL checkpoint/backup behavior.
- Run a reproducible whole-corpus benchmark before storage migration decisions.

**Exit:** Interrupted and incremental runs resume safely; measured query latency remains acceptable during ingestion.

Decoder replacement is not prerequisite work: the shared decoder works on sampled current payloads; the reachable runner’s extractor is the immediate incompatibility.

## Stage 10 — Correctable enrichment and parser experiments

- Add hard media type/title/year/episode validation.
- Support retraction/supersession and versioned parser/enricher evidence.
- Expand fixtures for numeric titles, leading years, alternate language, collections, ranges, and packs.
- Evaluate Sonarr/Radarr parsing behavior as an oracle where practical.

**Exit:** Weak false positives can be corrected and no longer become permanently equivalent identity.

## Stage 11 — Conservative release families

- Derive versioned family relationships from high-confidence evidence.
- Support ambiguity, edition/quality roles, split/merge corrections, and family-aware aggregates.
- Never use family membership for exact candidate deduplication.

**Exit:** Families improve explanation/aggregation without changing exact identity or silently merging unrelated media.

## Stage 12 — Explainable cache-prior probe policy

- Train only after unbiased authoritative labels and typed outcomes exist.
- Build provider-specific, time-aware priors from pre-decision features.
- Preserve exploration, calibration, source holdouts, feature/model versions, and deterministic fallback.
- Optimize calls/time to a desirable usable item—not raw cache-hit rate.

**Exit:** Shadow/A-B evaluation shows fewer provider calls or lower latency at equal/better usable-item quality, with no provider-state conflation.

## Permanent non-goals/guardrails

- No database replacement without measurement.
- No premature microservice or graph-database split.
- No fuzzy/hash/family candidate deduplication.
- No provider paths or rclone union as canonical identity.
- No conflation of desirability, cache prior, confirmed cache, placement, exposure, binding, cataloging, or playback.
- No elimination of exploration after a model appears useful.
- No broadening episode intent from release contents.
- No trust in browser file selection over provider inventory.
- No custom HashSucker byte proxy while mature transports satisfy requirements.
- No mandatory Arr import in virtual mode.
- No weakening of physical importer identity, ownership, or cleanup checks.

Do not create LongCat implementation contracts as part of this roadmap document. Create durable implementation contracts only in the next planning pass, once the canonical state and selected stage scope are stable.

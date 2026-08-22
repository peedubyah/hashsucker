# Known gaps

**Verified baseline:** 2026-08-21. This is the current defect/risk register, not an implementation plan. Ordering and exit criteria live in [`roadmap.md`](roadmap.md).

## Critical current defects

| Gap | Impact | Required direction |
|---|---|---|
| Local retrieval is not selected-media scoped | Cross-title/series recommendations can appear eligible | Require exact selected-media association before local eligibility |
| Local and live results are not globally ranked | Source origin determines order; live score is `0` | Normalize both pools and run one final deterministic rank |
| Historically exposed TorBox credential requires rotation | Removing current tracked configuration does not revoke a credential present in Git history | Owner must rotate the TorBox credential; history was deliberately not rewritten |
| Mutation routes lack application authentication | Untrusted callers can ingest, mutate, or submit resource-consuming work if deployment is published beyond its default loopback boundary | Keep loopback-only publication or add an authenticated trusted reverse proxy before non-loopback exposure |

## High current defects

### DMM runtime path divergence

`POST /api/ingest/dmm` only recognizes a script-call wrapper, while sampled current fragments use iframe/hash. The compatible importer is unwired. Neither path has run checkpoints, locks, resumability, source revision state, bounded transactions, or bounded-memory decoding. Existing corpus/database size claims are unverified and contradictory.

### Incomplete provider observation integration

The provider-neutral contract, typed errors, explicit scope/authority/freshness model, append-only history/current projection, and TorBox cache capability now exist. Only fresh authoritative observations can affect the legacy ranking component. The active combined server path does not yet use the capability adapter, Real-Debrid has no direct adapter, public DTOs are not fully migrated, and runtime TTL/rate-limit policy still requires provider validation.

### Weak identity/enrichment correction

Media associations can be accepted through permissive title relationships without hard media-type/year/episode validation. Associations are additive with no retraction/correction lifecycle, and ranking can use the strongest association rather than the selected one.

### Importer head-of-line blocking

The worker resumes the first `processing` request each loop. A persistent blocked/manual-selection request can prevent later valid work. Needed: attempt count, `nextAttemptAt`, typed errors, backoff, fair eligible selection, terminal blocked/dead-letter state, and operator requeue.

### Legacy cleanup ambiguity

A no-request legacy movie path may choose `delete-legacy`. Default cleanup should retain unless request ownership, provider ID, and expected hash prove ownership.

## Missing target capabilities

These are absent, not partially implemented:

- Direct Real-Debrid cache/placement/file adapter.
- Validated TorBox native WebDAV contract.
- Zurg/provider WebDAV/rclone deployment and health inventory.
- Provider-neutral capability contract.
- Provider-authoritative file mapping persisted end to end.
- Canonical library item/path/binding model and binding history.
- Shadow/active reconciler for provider, mount, projection, and catalog state.
- Provider failover without canonical path or media-identity churn.
- Distinct catalog/playback health and user-visible lifecycle states.
- Append-only observation/library/fulfillment telemetry.
- Conservative release-family graph and family-level reputation evidence.
- Provider-specific cache-prior model with exploration and unbiased labels.

## Target architecture risks

| Risk | Required guardrail |
|---|---|
| Placement reported as usable before exposure/binding/catalog/playback | Model each lifecycle boundary and timestamp separately |
| Provider paths or rclone union become canonical namespace | Keep mounts hidden; publish stable HashSucker-owned exact bindings |
| Standard Arr import copies remote bytes in virtual mode | Keep Arr optional/advisory until tested no-copy behavior exists |
| Eventual consistency or stale mount caches cause deletion/replacement | Bounded retries, freshness-aware inventories, fail-closed rebinding |
| Broad writable mounts or credentials permit destructive access | Isolate credentials, prefer read-only mounts, restrict control APIs |
| Retry creates duplicate provider resources | Persist placement ownership/idempotency; reuse before create |
| Learned cache prior reinforces source bias | Preserve exploration, authoritative negatives, model/feature versions, and temporal validation |
| Release families merge unrelated candidates | Conservative evidence, ambiguity support, versioned corrections; never use family as exact identity |
| A custom byte proxy becomes premature scope | Use mature transports; require measured failure evidence before reconsideration |

## Benchmark and operational unknowns

- Whole-corpus unique candidate count, duplicate ratio, and file-index distribution.
- Transactional ingest throughput and peak RSS on pinned source revisions.
- FTS/query p50/p95/p99 during ingestion.
- Database/WAL/backup/checkpoint growth and restart behavior.
- TorBox WebDAV authentication, file-selection, refresh, consistency, and seeking behavior.
- Zurg/rclone/Plex behavior under mount loss, stale caches, rebinding, and concurrent playback.
- Whether Arr can add value in virtual mode without copying or renaming provider-backed bytes.
- Whether provider check cost/rate limits leave enough headroom for a useful learned cache prior.

## Lower-priority product gaps

- Parser edge cases: numeric titles, title-leading years, alternate languages, collections, episode ranges, and packs.
- Metadata providers beyond Cinemeta.
- Artwork caching/proxying, if measured necessary.
- Durable user/operator progress reporting after lifecycle states are modeled.

The [enrichment evaluation](evaluation/ENRICHMENT-EVALUATION-2026-08-21.md) is bounded evidence from 62 samples, not proof of whole-corpus or runtime correctness.

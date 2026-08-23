# Acquisition Boundary Contract

**Date:** 2026-08-23  
**Scope:** Stable contracts for the acquisition seam between Stage 3 discovery and provider placement  
**Complements:** `ACQUISITION-ARCHITECTURE.md` (architecture), `../media-search/docs/architecture/ARCHITECTURE-BOUNDARIES.md` (system boundaries)  
**Constraints:** No code; no schema; no implementation slices; contract documentation only

---

## 1. Ownership Boundary

### Acquisition owns

- Deciding whether to act on a ranked candidate set
- Selecting from ranked candidates (first fresh authoritative cache hit wins)
- Selecting provider/account according to explicit policy
- Producing provider-neutral execution requests
- Preserving evidence history across attempts

### Acquisition does NOT own

| Not owned | Owner |
|-----------|-------|
| Ranking | Stage 3 (`ranking.js`, `search-engine.js`) |
| Filename parsing | Upstream ingestion pipeline |
| Metadata extraction | Cinemeta adapter |
| Provider APIs | Provider capability adapters (`torbox.js`, `realdebrid.js`) |
| Playback / Plex paths | Control-plane canonical projection |
| Exposure / bindings / catalog | Control-plane store (`store.js`) |
| Resolver behavior | `locator.js` |
| Corpus evidence tables | Discovery SQLite (`cache.js`) |

---

## 2. Input Contracts

### 2.1 AcquisitionCandidate

A ranked candidate from Stage 3, already scored and ordered. Acquisition consumes this as-is — it never re-ranks or mutates scores.

```
AcquisitionCandidate (from Stage 3 ranked output)
  ├── infoHash: string          # 40-char lowercase hex
  ├── fileIndex: number | null  # null = torrent-level; never 0
  ├── releaseKey: string        # `${infoHash}:${fileIndex | 'torrent'}`
  ├── score: number             # composite 0–1 from ranking.js
  └── rank: number              # 0-indexed position in ranked set
```

**Source:** `media-search/src/lib/acquisition/decision.js` — `rankedCandidates` array elements

### 2.2 ProviderObservation

A normalized, provider-neutral cache observation produced by a capability adapter. Only `torrent` and `candidate` scopes are admissible for acquisition decisions.

```
ProviderObservation (from createCacheObservation)
  ├── provider: string          # 'torbox' | 'realdebrid'
  ├── accountScope: string      # account identifier (default: 'default')
  ├── scope: 'torrent' | 'candidate'
  ├── kind: 'authoritative' | 'inferred' | 'predicted'
  ├── state: 'cached' | 'uncached' | 'unknown' | 'error'
  ├── observedAt: number        # ms timestamp
  ├── expiresAt: number | null  # ms timestamp; null = unbounded
  ├── source: string
  ├── evidence: object | null
  ├── errorCategory: string | null
  ├── retryable: boolean | null
  ├── retryAfterMs: number | null
  ├── latencyMs: number | null
  └── correlationId: string | null
```

**Freshness:** Derived via `evaluateObservationFreshness()` — `fresh`, `stale`, or `unbounded`.

**Source:** `media-search/src/lib/providers/observations.js` — `createCacheObservation()`, `evaluateObservationFreshness()`

### 2.3 AcquisitionPolicy

An explicit, versioned ordered list of provider/account targets. Position in the list indicates preference; no provider-specific behavior is implied.

```
AcquisitionPolicy (from createAcquisitionPolicy)
  ├── version: 1
  └── targets: Array<{ provider: string, accountScope: string }>
```

**Constraints:**
- At least one target required
- Duplicate `provider`/`accountScope` pairs rejected
- Provider and account identifiers must match `/^[a-z0-9][a-z0-9._-]{0,127}$/i`

**Source:** `media-search/src/lib/acquisition/policy.js`

---

## 3. Output Contracts

### 3.1 AcquisitionDecision

The result of combining ranked candidates, observations, and policy. Deeply frozen.

```
AcquisitionDecision (from decideAcquisition / composeAcquisitionDecision)
  ├── status: 'selected' | 'deferred' | 'unavailable'
  ├── selected: null | {
  │     candidate: object,      // original candidate
  │     identity: { infoHash, fileIndex, releaseKey },
  │     rank: number,
  │     provider: string,       // winning provider
  │     accountScope: string,   // winning account scope
  │     observation: ProviderObservation
  │   }
  ├── decisiveObservation: ProviderObservation | null
  ├── candidateEvaluations: Array<CandidateEvaluation>
  └── reasonCodes: string[]      // explainable trail
```

**Decision logic:**
- `selected` — first candidate with a fresh authoritative `cached` observation at any policy target
- `deferred` — higher-ranked candidates have unresolved evidence (`unknown`, `error`, stale, missing); lower ranks not yet considered
- `unavailable` — every candidate is authoritatively `uncached` at every policy target

**Source:** `media-search/src/lib/acquisition/decision.js`, `media-search/src/lib/acquisition/decision-composition.js`

### 3.2 AcquisitionIntent

A command-like object describing what the system would do and why. Consumed by the execution boundary.

```
AcquisitionIntent (from createAcquisitionIntent)
  ├── intentStatus: 'ready' | 'deferred' | 'unavailable'
  ├── action: 'place' | null
  ├── candidateIdentity: null | { infoHash, fileIndex, releaseKey }
  ├── provider: string | null
  ├── accountScope: string | null
  ├── evidence: ProviderObservation | null
  ├── reasonCodes: string[]
  └── createdAt: number          # ms timestamp
```

**Source:** `media-search/src/lib/acquisition/intent.js`

### 3.3 ExecutionRequest

A provider-neutral placement request. This is the boundary that provider-specific adapters consume.

```
ExecutionRequest (from createExecutionRequest)
  ├── executionStatus: 'ready' | 'deferred' | 'unavailable'
  ├── action: 'place'
  ├── candidateIdentity: { infoHash, fileIndex, releaseKey }
  ├── provider: string           # target provider
  ├── accountScope: string       # target account scope
  ├── reasonCodes: string[]
  ├── evidence: ProviderObservation | null
  └── createdAt: number
```

**Constraints:**
- No provider-specific fields (no magnets, torrent files, hashes, API endpoints)
- No lifecycle state (no download state, progress, files)
- Deeply frozen

**Source:** `media-search/src/lib/acquisition/execution.js`

---

## 4. Provider Boundary

Acquisition does **not** call provider APIs. The flow is strictly layered:

```
Decision
  ↓
Intent
  ↓
ExecutionRequest (provider-neutral)
  ↓
Provider Execution Adapter (torbox-execution.js, realdebrid/placement.js)
  ↓
Provider Capability (torbox.js PLACEMENT_CREATE, realdebrid.js PLACEMENT_CREATE)
  ↓
Control-Plane Store (store.js: recordPlacement, recordReadinessObservation)
```

**Adapter contract:**
- `createTorBoxExecutionAdapter.submit({ executionRequest, providerCapability })` — consumes generic `ExecutionRequest`, resolves magnet, calls `providerCapability.require('placement-create')`
- `createRealDebridPlacementAdapter` — same pattern for Real-Debrid

**Source:** `media-search/src/lib/providers/torbox-execution.js`, `media-search/src/lib/providers/realdebrid/placement.js`

---

## 5. Idempotency Expectations

| Expectation | Enforcement |
|-------------|-------------|
| Identity survives every boundary | `(infoHash, fileIndex)` / `releaseKey` is preserved from Stage 3 through `ExecutionRequest` to control-plane store |
| Duplicate placement attempts reuse existing placement | `idempotency_key` (derived from candidate identity) is a unique index in `provider_placements`; `ON CONFLICT` updates instead of inserting |
| Provider resource IDs are not canonical identity | `provider_resource_id` is opaque; `info_hash` + `file_index` remain canonical |
| Placement failures preserve observation history | `provider_observation_events` is append-only; errors never delete prior evidence |
| Cached state is never overwritten by placement failure | `provider_observations` and `provider_placements` are independent tables; a placement error does not rewrite an authoritative `cached` observation to `uncached` |

**Source:** `media-search/src/lib/control-plane/store.js` — `UNIQUE (provider, account_scope, idempotency_key)`, `recordPlacement()` conflict handling

---

## 6. Failure Semantics

### 6.1 Decision-layer failures (pure, no side effects)

| Condition | Observation state | Decision result |
|-----------|-------------------|-----------------|
| No observation for candidate at policy target | missing | `deferred` (higher-ranked candidate blocks lower ranks) |
| Observation expired | stale | `deferred` |
| Observation unbounded (no `expiresAt`) | unbounded | `deferred` |
| Observation non-authoritative | `kind: 'inferred'` or `kind: 'predicted'` | `deferred` |
| Observation error | `state: 'error'` | `deferred` |
| All candidates authoritatively `uncached` | `state: 'uncached'` at every target | `unavailable` |
| Fresh authoritative `cached` hit | `state: 'cached'`, `kind: 'authoritative'`, `freshness: 'fresh'` | `selected` |

### 6.2 Execution-layer failures (provider-specific)

| Error category | Retryable | Result |
|----------------|-----------|--------|
| `authentication` | No | Operator-visible fault; no retry without new credentials |
| `authorization` | No | Operator-visible fault |
| `rate-limit` | Yes | Retry after `retryAfterMs`; respects `Retry-After` |
| `timeout` | Yes | Retry with backoff |
| `network` | Yes | Retry with backoff |
| `conflict` | Yes | Re-observe; may be idempotent replay |
| `temporarily-unavailable` | Yes | Retry with backoff |
| `not-found` | No | Permanent; provider does not have content |
| `invalid-request` | No | Provider rejected request format |
| `invalid-response` | No | Provider returned malformed data |
| `unsupported` | No | Provider does not implement capability |
| `unsafe-operation` | No | Provider refused destructive operation |
| `unknown` | No | Unclassified; manual investigation required |

**Source:** `media-search/src/lib/providers/errors.js` — `PROVIDER_ERROR_CATEGORIES`, `RETRYABLE_CATEGORIES`, `classifyProviderError()`

---

## 7. Invariants

These invariants are already enforced by the existing code. Future wiring must not violate them.

1. **Acquisition never re-ranks.** The ranked candidate order from Stage 3 is preserved. Lower-ranked candidates are considered only after all policy targets for higher-ranked candidates authoritatively report `uncached`.

2. **Acquisition never mutates corpus evidence.** The `candidates`, `release_attributes`, and `provider_observation_events` tables are never written by the acquisition layer. Acquisition reads evidence and writes placement records.

3. **Provider observations do not become identity.** Observations live in `provider_observation_events` / `provider_observation_current`. Candidate identity lives in `candidates` with `(info_hash, file_index_key)`. These are never conflated.

4. **Placement is not readiness.** A `provider_placements` row with `state: 'pending'` is not ready for playback. Readiness is a separate observation in `provider_readiness_observations`.

5. **Readiness is not exposure.** A ready placement is not visible on a mount. Exposure is a separate record in `exposures`.

6. **Exposure is not binding.** An exposed file is not yet a canonical library binding. Bindings live in `bindings` with a versioned `library_item_id → placement_id` mapping.

7. **Binding is not playback.** A bound library item is not yet cataloged or playable. Catalog and playback are future milestones beyond the acquisition boundary.

8. **Only fresh authoritative evidence is decisive.** `unknown`, `error`, `stale`, `unbounded`, `inferred`, and `predicted` observations defer the decision rather than masquerading as unavailability.

9. **Provider and account scopes are isolated.** Observations and placements never leak across `provider` or `accountScope` boundaries.

---

## 8. Implementation References

These modules implement the contracts above. No future implementation is prescribed.

| Module | Role |
|--------|------|
| `media-search/src/lib/acquisition/decision.js` | Pure decision evaluator |
| `media-search/src/lib/acquisition/decision-composition.js` | Decision composition with projection validation |
| `media-search/src/lib/acquisition/intent.js` | Decision → intent boundary |
| `media-search/src/lib/acquisition/execution.js` | Intent → execution request boundary |
| `media-search/src/lib/acquisition/policy.js` | Acquisition policy normalization |
| `media-search/src/lib/acquisition/exact-candidate-projection.js` | Observation-to-candidate projection gate |
| `media-search/src/lib/acquisition/observation-collection.js` | Stage 3 → observation orchestration |
| `media-search/src/lib/acquisition/locator.js` | Magnet resolver boundary |
| `media-search/src/lib/providers/observations.js` | Provider observation model |
| `media-search/src/lib/providers/errors.js` | Provider error categories and classification |
| `media-search/src/lib/providers/capabilities.js` | Provider capability adapter |
| `media-search/src/lib/providers/torbox-execution.js` | TorBox execution adapter |
| `media-search/src/lib/providers/realdebrid/placement.js` | Real-Debrid placement adapter |
| `media-search/src/lib/control-plane/store.js` | Control-plane SQLite store |
| `media-search/src/lib/control-plane/lifecycle.js` | Lifecycle event model |
| `media-search/src/lib/discovery/ranking.js` | Pure ranking module (upstream) |
| `media-search/src/lib/discovery/corpus-evidence-bundle.js` | Corpus evidence projection (upstream) |

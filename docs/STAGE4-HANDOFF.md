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

- [x] **Exact candidate projection:** Pure function validating identity, scope, and freshness. See `media-search/src/lib/acquisition/exact-candidate-projection.js`.
- [x] **Freshness validation:** Explicit `now` required (no wall-clock fallback); stale/future/unbounded/malformed evidence fails closed.
- [x] **Fixtures:** 30 projection tests covering identity, scope, freshness, provider/account preservation.
- [x] **TorBox observation mapping:** Documented in `docs/evaluation/TORBOX-OBSERVATION-MAPPING.md` with fixtures in `media-search/test/fixtures/torbox-response-fixtures.js`.
- [x] **Candidate granularity policy:** Documented in `docs/evaluation/CANDIDATE-GRANULARITY-POLICY.md`.
- [x] **TorBox adapter alignment:** Existing `createTorBoxProvider` and `createTorBoxInventoryProvider` already satisfy the adapter boundary. Verified by `media-search/test/torbox-adapter-contract.test.js` — no new adapter code required.
- [x] **TorBox cache observation hardening:** Transport evaluation (GET retained), bounded batching, partial failure isolation, latency measurement. See `media-search/test/torbox-cache-hardening.test.js`.
- [x] **TorBox placement creation:** `PLACEMENT_CREATE` capability with magnet/cached-only creation, typed errors, provider/account scope preservation. See `media-search/test/torbox-placement-create.test.js`.
- [x] **Observation collection boundary:** Pure orchestration helper with candidate windowing, hash batching, exact projection mapping. See `media-search/test/observation-collection.test.js`.

### Adapter alignment note (Slice 1D)

The existing TorBox capability modules already produce Stage 4-compatible observations:

- `createTorBoxProvider.observeCache` maps `checkcached` responses to `createCacheObservation({ scope: 'torrent', fileIndex: null, kind: 'authoritative' })` — never file-level candidate observations.
- `createTorBoxInventoryProvider.getFileInventory` maps `mylist` responses to `createProviderFileInventory({ ..., corpusFileIndex: null })` — opaque provider file IDs preserved, no mapping to `(infoHash, fileIndex)`.

No parallel adapter, no duplicated response handling, no identity guessing was introduced. The adapter boundary is satisfied by existing code; only contract tests and documentation were added.

### Slice 2A — TorBox cache observation capability hardening

The existing TorBox adapter is hardened to support future acquisition decisions without changing Stage 4 boundaries:

- **Transport evaluation (GET kept):** `checkcached` is documented as GET with repeated `hash` query params. GET is retained over POST batch semantics because: (1) GET is the documented method; (2) GET is idempotent/cacheable/proxy-friendly; (3) `BATCH_SIZE = 10` keeps each URL ~600 chars, well under the ~2000 char proxy limit.
- **Bounded batching:** Hashes are chunked into batches of `BATCH_SIZE`. Each batch is an independent HTTP request.
- **Partial failure isolation:** A batch-level failure marks only that batch's hashes as failed (`→ unknown`, `retryable: true`) rather than failing the entire observation.
- **Global auth failures:** 401/403/BAD_TOKEN abort the entire observation since retrying without new credentials is futile.
- **Latency measurement:** Per-batch round-trip time is measured and attached to each observation as `latencyMs` for Stage 4 decision diagnostics.
- **No file-level observations:** Every emitted observation remains `scope: 'torrent'`, `fileIndex: null`. No projection or identity expansion is added.

See: `media-search/src/lib/providers/torbox.js`, `media-search/test/torbox-cache-hardening.test.js`.

Exit: TorBox cache observation capability is a clean provider implementation boundary capable of feeding Stage 4 decisions. No acquisition execution, no provider workflow expansion, no API client redesign.

### Slice 2B — TorBox placement creation capability

Added the smallest provider capability required to turn an accepted acquisition decision into a TorBox-owned resource:

- **Capability:** `PLACEMENT_CREATE` backed by `POST /v1/api/torrents/createtorrent`.
- **Input:** Magnet link or torrent file (base64), with optional `add_only_if_cached` safety option.
- **Output:** Provider placement result with `provider`, `accountScope`, `providerResourceId` (torrent ID), `infoHash`, and evidence.
- **Authentication:** Reuses existing TorBox bearer token handling.
- **Error behavior:** Typed errors for authentication, rate limit, provider rejection, network failure, malformed response. Failures are NOT converted to cache observations.
- **No status polling, file inventory, file selection, exposure, or fulfillment.**

See: `media-search/src/lib/providers/torbox.js`, `media-search/test/torbox-placement-create.test.js`.

Exit: A deterministic TorBox placement creation capability exists. No acquisition execution, no provider workflow expansion, no API client redesign.

### Slice 2C — Batched provider cache observation collection

Created the smallest orchestration boundary between Stage 3 ranked candidates and Stage 4 acquisition decisions:

- **Pure orchestration:** Consumes provider capability, produces evidence. No persistence, fulfillment, scheduling, or provider mutation.
- **Candidate windowing:** Preserves Stage 3 order, bounded by `maxCandidates`, never re-ranks or mutates scores.
- **Hash batching:** Extracts unique `infoHashes`, deduplicates, preserves all candidate identities sharing the same hash.
- **Observation mapping:** Uses `projectExactCandidateObservation()` to maintain torrent-level vs file-level distinction. Torrent-level evidence does not authorize file-level candidates.
- **Failure behavior:** Provider errors become observation states. Missing evidence does not become `uncached`. Empty candidate lists are deterministic.

See: `media-search/src/lib/acquisition/observation-collection.js`, `media-search/test/observation-collection.test.js`.

Exit: A deterministic bounded Stage 3 → provider observation collection boundary exists. No acquisition execution, provider mutation, runtime wiring, or scheduling.

### Slice 2D — Pure observation-backed decision composition

Created the smallest pure boundary that combines Stage 3 ranked candidates, decision-ready provider observations, and explicit acquisition policy to produce an explainable acquisition decision:

- **Pure composition:** Wraps `decideAcquisition()` with explicit projection validation via `projectExactCandidateObservation()`. No provider calls, persistence, fulfillment, or scheduling.
- **Candidate authority:** Preserves Stage 3 order, never re-ranks or mutates scores. Lower-ranked candidates selected only when all policy targets for higher-ranked candidates have fresh authoritative `uncached` evidence.
- **Evidence semantics:** `cached` → selected; `uncached` → fall through to next rank; `unknown`/`error`/`stale`/`expired`/`future`/`non-authoritative` → deferred.
- **Identity preservation:** Exact `(infoHash, fileIndex)`/`releaseKey`. `null` distinct from `0`. Torrent-level evidence cannot authorize file-level candidates.
- **Provider/account isolation:** Observations never leak across provider, account, scope, or identity boundaries.
- **Projection validation:** The decisive observation is explicitly validated against the selected candidate via `projectExactCandidateObservation()`. Rejection fails closed as deferred.
- **Observation admission boundary:** `currentObservationProjection` in `decision.js` admits only `torrent` and `candidate` scopes — all other scopes (`provider-resource`, `exposure`, `mount`, `provider-file`) are rejected with `TypeError` at the admission boundary. `projectExactCandidateObservation()` remains the identity/scope authority gate.
- **Explainability:** Result includes selected candidate identity, rank, decisive observation, reason codes, and per-candidate evaluation results.
- **Frozen output:** Deeply frozen result prevents downstream mutation.
- **Input validation:** `evaluationTime` is required (no wall-clock fallback); explicit rejection of missing/invalid inputs.

See: `media-search/src/lib/acquisition/decision-composition.js`, `media-search/test/decision-composition.test.js`.

Exit: A deterministic pure Stage 4 decision boundary exists. No acquisition execution, placement creation, provider mutation, runtime wiring, or fulfillment. The next slice may consume this decision result and perform provider execution. This slice stops before that boundary.

### Slice 2E — Acquisition Intent Boundary

Created the smallest pure boundary between a completed acquisition decision and future provider execution:

- **Pure intent factory:** `createAcquisitionIntent()` accepts a completed decision, `evaluationTime`, and `executionPolicy` and produces a command-like intent object. No provider calls, downloads, placements, or provider state mutation.
- **Selected → ready:** A selected decision with valid candidate, decisive evidence, identity, and provider/account scope produces `{ intentStatus: "ready", action: "place" }`.
- **Deferred → deferred:** A deferred decision produces `{ intentStatus: "deferred", action: null }` preserving reason codes and evaluations. No fallback action invented.
- **Unavailable → unavailable:** An unavailable decision remains `{ intentStatus: "unavailable", action: null }`. No automatic recovery.
- **Identity preservation:** Preserves `infoHash`, `fileIndex`, `releaseKey`, `provider`, `accountScope`. No conversion to magnet/torrent/download — that belongs to execution.
- **Explainability:** Every intent answers "Why would the system do this?" via decision status, decisive observation, reason codes, and evaluation timestamp. No guessed confidence, predicted cache state, or inferred provider success.
- **Explicit rejection:** Selected decisions without candidate/evidence/provider/accountScope throw `TypeError`. Unknown decision statuses throw.
- **Frozen output:** Deeply frozen intent, candidateIdentity, evidence, and reasonCodes.
- **Validation order:** decision → evaluationTime → executionPolicy → status-specific rules.

See: `media-search/src/lib/acquisition/intent.js`, `media-search/test/intent.test.js`.

Exit: A deterministic decision → intent boundary exists. No provider execution, acquisition mutation, runtime wiring, scheduling, or fulfillment. The output is a command-like object that a future execution slice may consume.

### Slice 2F — Generic Execution Placement Contract (Boundary Only)

Created the first generic execution boundary between a completed acquisition intent
and future provider-specific execution:

- **Pure generic boundary:** `createExecutionRequest()` accepts a completed acquisition
  intent and `evaluationTime` and produces a generic execution request. No provider
  calls, downloads, placements, or provider state mutation.
- **Ready → ready:** A ready intent with valid candidate identity, provider, and account
  scope produces `{ executionStatus: "ready", action: "place" }`.
- **Deferred → deferred:** A deferred intent produces `{ executionStatus: "deferred", action: null }`.
  No execution request is created.
- **Unavailable → unavailable:** An unavailable intent remains `{ executionStatus: "unavailable", action: null }`.
- **Identity preservation:** Preserves `infoHash`, `fileIndex`, `releaseKey`, `provider`,
  `accountScope`. No conversion to magnet/torrent/download — that belongs to provider adapters.
- **Provider separation:** The contract does not know about magnets, torrent files, hashes,
  provider API endpoints, torrent IDs, download IDs, or provider-specific state machines.
  Future adapters (TorBox, Real-Debrid, etc.) consume this generic contract without
  changing the core.
- **Explainability:** Every execution request answers "What would an execution adapter receive?"
  via execution status, action, candidate identity, provider, account scope, reason codes,
  evidence, and timestamp.
- **Explicit rejection:** Ready intents without candidate identity, provider, or account scope
  throw `TypeError`. Unknown intent statuses throw. Missing/invalid inputs throw.
- **Frozen output:** Deeply frozen execution request, candidateIdentity, and reasonCodes.
- **Validation order:** intent → evaluationTime → status-specific rules.

See: `media-search/src/lib/acquisition/execution.js`, `media-search/test/execution.test.js`.

Exit: A generic intent → execution boundary exists. This slice creates the contract future
provider adapters will consume. No provider execution, acquisition mutation, lifecycle
tracking, polling, fulfillment, or runtime wiring. Future slices will add provider-specific
execution and lifecycle adapters on top of this boundary.

### Slice 2G — TorBox Execution Adapter Submission Boundary

Implemented the first provider-specific execution adapter consuming the generic Stage 4 execution request contract:

- **TorBox-specific adapter:** `createTorBoxExecutionAdapter()` accepts a generic execution request and provider capability, delegates to existing `createPlacement()` capability. No provider execution logic duplicated.
- **Ready intent → placement:** A ready execution request with `provider: "torbox"` submits placement via existing TorBox capability.
- **Magnet resolution:** Adapter requires a `getMagnetForIdentity` resolver — an external data source mapping candidate identities to magnets. The adapter never invents missing acquisition data.
- **Provider rejection:** Deferred, unavailable, wrong provider, missing identity, or missing account scope requests throw `TypeError`.
- **Error preservation:** Provider `ProviderOperationError` (authentication, rejection, malformed response, network) propagates unchanged. No conversion to success.
- **No lifecycle handling:** Result contains only `submitted` status — no download state, progress, files, or completion tracking.
- **No polling:** Exactly one API call per submission. No status polling or retry loops.
- **No generic contract mutation:** The execution request is not modified during submission.
- **Frozen output:** Deeply frozen submission result.
- **Provider separation:** The adapter is purely TorBox-specific. Future providers (Real-Debrid) implement the same boundary independently.

See: `media-search/src/lib/providers/torbox-execution.js`, `media-search/test/torbox-execution.test.js`.

Exit: A provider-specific TorBox submission adapter exists. The architecture becomes:

```
Acquisition Intent
        |
        v
Generic Execution Request
        |
        v
TorBox Execution Adapter
        |
        v
TorBox Placement Submission
```

No lifecycle tracking, polling, completion, exposure, scheduling, or runtime wiring. Future slices will add provider lifecycle observation separately.

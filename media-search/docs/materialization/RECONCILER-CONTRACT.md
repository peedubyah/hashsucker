# Reconciler Contract

**Date:** 2026-08-23
**Status:** Contract — normative constraints on routine reconciliation
**Grounded in:** `BINDING-STATE-CONTRACT.md`, `REPAIR-PLANNER-CONTRACT.md`, `REPAIR-EXECUTOR-CONTRACT.md`, `REPAIR-RECONCILIATION-BOUNDARY-ANALYSIS.md`, `MATERIALIZATION-ARCHITECTURE.md`, `CONTRACTS.md`
**Cross-checked against:** `media-search/src/lib/control-plane/reconciler.js`, `media-search/src/lib/control-plane/store.js`, `media-search/src/lib/control-plane/repair-planner.js`, `media-search/src/lib/control-plane/repair-executor.js`
**Constraints:** No code; no schema changes; no implementation; contract only

---

## 1. Purpose

This document defines the **normative contract for the reconciler**. It answers fourteen questions:

1. What is the reconciler's role in the materialization architecture?
2. Who owns routine reconciliation, binding actions, and degraded declaration?
3. What inputs may the reconciler consume?
4. What are the ten reconciliation actions and their semantics?
5. How do binding actions (`bind`/`rebind`/`mark-degraded`) work?
6. What is the boundary between routine reconciliation and repair?
7. What determinism requirements must the reconciler satisfy?
8. How does the reconciler interact with providers?
9. What postconditions does the reconciler declare?
10. What are the failure semantics?
11. What is the reconciler forbidden from doing?
12. How does the reconciler relate to the repair planner?
13. How does the reconciler relate to the repair executor?
14. How does the reconciler relate to the binding state contract?

Each answer is stated as a MUST / MUST NOT / MAY constraint. Violations break the contract.

### 1.1 Architectural Position

The reconciler is the **routine control plane** for materialization. It handles the "happy path" — when placements are healthy, inventory is fresh, and exposures are visible:

```
observations + binding state + lifecycle
              |
              v
          reconciler
              |
              v
    reconciliation plan
    (bind/rebind/mark-degraded)
              |
              v
      store.activateBinding()
              |
              v
        active binding
```

When the reconciler detects unhealthy state, it emits `mark-degraded` and **hands off to repair**:

```
unhealthy observations
      |
      v
  reconciler (mark-degraded)
      |
      v
  repair planner (repair-required)
      |
      v
  repair executor (transactional repair)
      |
      v
  new active binding (old superseded)
```

**Key insight:** The reconciler is **authoritative for routine state**. Repair is **authoritative for degraded/failed state**. The reconciler does not repair; it declares degradation and hands off.

---

## 2. Ownership

### 2.1 Reconciler Ownership

| ID | Constraint |
|----|------------|
| **RECONCILER-OWN-1** | The reconciler **MUST** own **routine reconciliation** — evaluating current state and producing a deterministic reconciliation plan. |
| **RECONCILER-OWN-2** | The reconciler **MUST** own **binding actions** — emitting `bind`, `rebind`, and `mark-degraded` actions based on observation freshness. |
| **RECONCILER-OWN-3** | The reconciler **MUST** own **degraded declaration** — detecting unhealthy state and emitting `mark-degraded` to trigger repair. |
| **RECONCILER-OWN-4** | The reconciler **MUST** own **provider preference ordering** — selecting placements based on `providerPreferences`. |
| **RECONCILER-OWN-5** | The reconciler **MUST** own **exact file mapping selection** — choosing the canonical provider file via `chooseExactProviderFile()`. |
| **RECONCILER-OWN-6** | The reconciler **MUST** own **freshness evaluation** — determining whether observations are `fresh`, `stale`, `unbounded`, or `missing`. |

### 2.2 Reconciler Does NOT Own

| Aspect | Actual Owner | Mechanism |
|--------|--------------|-----------|
| Executing repair actions | Repair executor | `executeAction()` runs authorized steps |
| Repair transaction lifecycle | Repair executor | `persistPlan()` → `authorize()` → `execute()` |
| Trigger detection for repair | Repair planner | `detectTriggers()` classifies observation signals |
| Postcondition verification | Repair executor | `assertPostconditions()` re-plans and confirms health |
| Consumer behavior | Media gateway / Adapters | Gateway reads bindings; adapters consume exposures |
| Binding state machine | Binding state contract | `BINDING-STATE-CONTRACT.md` defines valid transitions |
| Provider mutations | Repair executor (via slice) | `observePlacement()`, `selectKnownFiles()`, `requestRepair()` |

**Key insight:** The reconciler is a **pure function** of its inputs. It produces intent (actions), not side effects. All mutations are the store's responsibility via `activateBinding()`.

---

## 3. Input Contract

### 3.1 Allowed Inputs

| Input | Type | Purpose |
|-------|------|---------|
| **desired** | Object | The desired content identity and library item |
| **placements** | Array | All known provider placements for the identity |
| **readinessObservations** | Array | Provider readiness observations |
| **providerFiles** | Array | Observed provider files per placement |
| **inventorySnapshots** | Array | Inventory freshness metadata per placement |
| **mappings** | Array | Candidate file mappings (authoritative and non-authoritative) |
| **exposures** | Array | Filesystem exposure observations |
| **currentBinding** | Object | The currently active binding (if any) |
| **options.now** | Timestamp | Explicit evaluation time for freshness calculations |
| **options.maxObservationAttempts** | Integer | Max retries before marking degraded |
| **options.reobserveAfterMs** | Integer | Delay between observation retries |
| **options.destructive** | Boolean | Whether destructive actions (resource removal) are permitted |

### 3.2 Input Semantics

**Desired** MUST contain:
- `libraryItemId` — the library item being reconciled
- `releaseKey` — content identity (`info_hash:file_index`)
- `infoHash` — 40-char hex SHA-1
- `fileIndex` — integer or null
- `desiredState` — `'present'` or `'absent'`
- `providerPreferences` — ordered list of preferred providers
- `libraryPathId` — the canonical path for binding

**Placements** MUST contain:
- `id` — placement UUID
- `provider` — provider name
- `accountScope` — account scope
- `infoHash` — content hash
- `providerResourceId` — opaque provider resource ID
- `state` — `'pending'`, `'ready'`, `'degraded'`, `'error'`, `'removed'`, `'unknown'`
- `observedAt` — timestamp
- `expiresAt` — timestamp (nullable)
- `ownership` — `'owned'`, `'reused'`, `'external'`, `'unknown'`
- `ownerKey` — library item ID if owned
- `dependentBindingCount` — number of active bindings using this placement

### 3.3 Input Constraints

| ID | Constraint |
|----|------------|
| **RECONCILER-INPUT-1** | The reconciler **MUST NOT** create any evidence. It consumes evidence produced by the observation layer. |
| **RECONCILER-INPUT-2** | The reconciler **MUST NOT** mutate any input. All inputs are read-only. |
| **RECONCILER-INPUT-3** | The reconciler **MUST NOT** access the database directly. All state arrives via inputs. |
| **RECONCILER-INPUT-4** | The reconciler **MUST NOT** access provider APIs. All provider state arrives via observations. |
| **RECONCILER-INPUT-5** | The reconciler **MUST** treat `options.now` as the sole source of time. No internal `Date.now()` calls except via explicit option. |
| **RECONCILER-INPUT-6** | The reconciler **MUST** reject inputs with missing `desired`. |

---

## 4. Reconciliation Actions

### 4.1 Action Catalog

The reconciler recognizes exactly ten reconciliation actions:

| Action | Meaning |
|--------|---------|
| `no-op` | Active binding is current; no action needed |
| `observe-again` | Re-observe placement, readiness, inventory, or exposure |
| `create-or-reuse-placement` | Create a new placement or reuse an existing one |
| `wait-provider-readiness` | Wait for provider to report ready state |
| `map-exact-file` | Create an authoritative exact file mapping |
| `observe-exposure` | Re-observe filesystem exposure |
| `bind` | Create a new active binding |
| `rebind` | Create a new active binding, superseding the old one |
| `mark-degraded` | Declare binding degraded; hand off to repair |
| `remove-stale-owned-resource` | Remove an owned placement with no dependents (destructive) |

### 4.2 Action Semantics

#### `no-op`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Active binding is current; placement is fresh and ready; exposure is visible |
| **Conditions** | `bindingSatisfies(currentBinding, desired)` AND `isFreshReadyPlacement(boundPlacement, now)` AND `isFreshVisibleExposure(boundExposure, now)` |
| **Implication** | No state change. Reconciliation is complete. |

#### `observe-again`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Re-observe a stale or unbounded observation |
| **Targets** | `placement`, `readiness`, `provider-file-inventory`, `exposure` |
| **Conditions** | Observation is `stale` or `unbounded`; retry attempts not exhausted |
| **Implication** | Observation layer refreshes the observation. Reconciliation re-runs. |

#### `create-or-reuse-placement`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Create a new placement or reuse an existing one for the desired release |
| **Conditions** | No placements exist for the desired `infoHash` |
| **Implication** | Acquisition intent layer creates a placement. Reconciliation re-runs. |

#### `wait-provider-readiness`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Wait for provider to report ready state |
| **Conditions** | Placement state is `pending`, `unknown`, or `degraded` |
| **Implication** | Provider is not ready. Reconciliation re-runs after delay. |

#### `map-exact-file`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Create an authoritative exact file mapping |
| **Conditions** | No authoritative mapping exists for the release/placement |
| **Implication** | `chooseExactProviderFile()` selects the canonical provider file. Mapping is created. |

#### `observe-exposure`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Re-observe filesystem exposure |
| **Conditions** | Exposure is stale, unbounded, or not observed |
| **Implication** | Observation layer refreshes the exposure. Reconciliation re-runs. |

#### `bind`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Create a new active binding |
| **Conditions** | No current binding; placement is ready; inventory is fresh; mapping is authoritative; exposure is visible and read-only |
| **Implication** | `store.activateBinding()` creates a new binding with `version = 1`. |

#### `rebind`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Create a new active binding, superseding the old one |
| **Conditions** | Current binding exists but preferred usable placement changed |
| **Implication** | `store.activateBinding()` supersedes the old binding and creates a new binding with `version = old.version + 1`. |

#### `mark-degraded`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Declare binding degraded; hand off to repair |
| **Conditions** | No usable placement; mapping failed; exposure not visible/read-only; inventory not fresh; readiness not ready |
| **Implication** | Binding status transitions to `degraded`. Repair planner produces a repair plan. |

#### `remove-stale-owned-resource`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Remove an owned placement with no dependents |
| **Conditions** | `destructive === true`; placement is owned by this library item; observation is fresh; no dependent bindings |
| **Implication** | Provider resource is removed. Placement state transitions to `removed`. |

### 4.3 Action Constraints

| ID | Constraint |
|----|------------|
| **RECONCILER-ACTION-1** | The reconciler **MUST** use only the ten actions defined in §4.1. |
| **RECONCILER-ACTION-2** | The reconciler **MUST** emit actions in canonical order (defined by `ACTION_ORDER`). |
| **RECONCILER-ACTION-3** | The reconciler **MUST** deduplicate actions before returning. |
| **RECONCILER-ACTION-4** | The reconciler **MUST** emit `mark-degraded` when no actions can resolve the unhealthy state. |
| **RECONCILER-ACTION-5** | The reconciler **MUST** emit `mark-degraded` when observation attempts are exhausted. |

---

## 5. Binding Actions

### 5.1 `bind` Action

| ID | Constraint |
|----|------------|
| **RECONCILER-BIND-1** | The reconciler **MUST** emit `bind` only when `currentBinding` is `null`. |
| **RECONCILER-BIND-2** | The reconciler **MUST** include `expectedBindingVersion: 0` for `bind` (no existing binding). |
| **RECONCILER-BIND-3** | The reconciler **MUST** validate that the placement is `ready`, inventory is `fresh`, mapping is `authoritative`, and exposure is `visible` and `read-only`. |

### 5.2 `rebind` Action

| ID | Constraint |
|----|------------|
| **RECONCILER-BIND-4** | The reconciler **MUST** emit `rebind` only when `currentBinding` exists but the preferred usable placement changed. |
| **RECONCILER-BIND-5** | The reconciler **MUST** include `expectedBindingVersion: currentBinding.version` for `rebind`. |
| **RECONCILER-BIND-6** | The reconciler **MUST** validate that the new placement is `ready`, inventory is `fresh`, mapping is `authoritative`, and exposure is `visible` and `read-only`. |

### 5.3 `mark-degraded` Action

| ID | Constraint |
|----|------------|
| **RECONCILER-BIND-7** | The reconciler **MUST** emit `mark-degraded` when no placement is usable. |
| **RECONCILER-BIND-8** | The reconciler **MUST** emit `mark-degraded` when the mapping fails (`provider-file-missing`, `provider-file-ambiguous`). |
| **RECONCILER-BIND-9** | The reconciler **MUST** emit `mark-degraded` when the exposure is not `visible` or not `read-only`. |
| **RECONCILER-BIND-10** | The reconciler **MUST** emit `mark-degraded` when the inventory is not `fresh`. |
| **RECONCILER-BIND-11** | The reconciler **MUST** emit `mark-degraded` when readiness is not `ready`. |
| **RECONCILER-BIND-12** | The reconciler **MUST** include `libraryItemId` and `bindingId` (if exists) in `mark-degraded`. |

---

## 6. Routine vs Degraded Boundary

### 6.1 The Critical Boundary

The boundary between routine reconciliation and repair is the **most critical boundary** in the materialization layer. The reconciler handles routine state; repair handles degraded/failed state.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        ROUTINE (Reconciler)                             │
│                                                                         │
│  - Placement is ready                                                   │
│  - Inventory is fresh, authoritative, complete                          │
│  - Mapping is authoritative                                             │
│  - Exposure is visible, read-only, fresh                                │
│  - Binding is active                                                    │
│                                                                         │
│  Actions: no-op, observe-again, create-or-reuse-placement,             │
│           wait-provider-readiness, map-exact-file, observe-exposure,    │
│           bind, rebind                                                  │
└─────────────────────────────────────────────────────────────────────────┘
                              │
                              │ mark-degraded
                              ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        DEGRADED (Repair)                                │
│                                                                         │
│  - Placement is missing or broken                                       │
│  - Inventory is stale or not authoritative                              │
│  - Mapping is degraded                                                  │
│  - Exposure is missing, not visible, or expired                         │
│  - Binding is degraded                                                  │
│                                                                         │
│  Actions: REOBSERVE_PROVIDER, REPLACE_PLACEMENT_OBSERVATION,            │
│           RESELECT_KNOWN_FILES, REQUEST_PROVIDER_REPAIR,                │
│           REOBSERVE_ZURG_METADATA, REOBSERVE_FILESYSTEM_EXPOSURE,       │
│           RECONCILE_BINDING                                             │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.2 Handoff Rules

| ID | Constraint |
|----|------------|
| **RECONCILER-BOUNDARY-1** | The reconciler **MUST** emit `mark-degraded` when it cannot resolve unhealthy state through routine actions. |
| **RECONCILER-BOUNDARY-2** | The reconciler **MUST NOT** attempt repair. Repair is exclusively the repair planner's responsibility. |
| **RECONCILER-BOUNDARY-3** | The reconciler **MUST** be idempotent. If repair succeeds concurrently, the reconciler's next run produces `no-op`. |
| **RECONCILER-BOUNDARY-4** | The reconciler **MUST** respect optimistic concurrency. If the binding changes during reconciliation, the reconciler's `bind`/`rebind` fails (but next run succeeds with fresh state). |

### 6.3 Concurrent Activity

| Scenario | Reconciler Behavior | Repair Behavior |
|----------|---------------------|-----------------|
| Reconciler runs first | `bind`/`rebind` succeeds; binding version increments | Repair's `expectedBindingVersion` is stale; repair fails with `repair-version-conflict` |
| Repair runs first | `expectedBindingVersion` is stale; `bind`/`rebind` fails | Repair succeeds; new binding created |
| Both detect degradation | Emits `mark-degraded` | Planner produces repair plan |

**Key insight:** The reconciler and repair are **serialized by binding version**. Only one can succeed per version. The one that executes first wins; the other retries against fresh state.

---

## 7. Determinism Requirements

### 7.1 Deterministic Outputs

| ID | Constraint |
|----|------------|
| **RECONCILER-DETERM-1** | Given identical inputs, the reconciler **MUST** produce the same set of actions. |
| **RECONCILER-DETERM-2** | Given identical inputs, the reconciler **MUST** produce the same action ordering. |
| **RECONCILER-DETERM-3** | Given identical inputs, the reconciler **MUST** produce the same `planKey`. |
| **RECONCILER-DETERM-4** | The reconciler **MUST** produce the same output regardless of when evaluation occurs (wall-clock time is irrelevant except via `options.now`). |

### 7.2 Forbidden Dependencies

| ID | Constraint |
|----|------------|
| **RECONCILER-DETERM-5** | The reconciler **MUST NOT** depend on `Math.random()` or any non-deterministic value. |
| **RECONCILER-DETERM-6** | The reconciler **MUST NOT** depend on system clock except via the explicit `options.now` parameter. |
| **RECONCILER-DETERM-7** | The reconciler **MUST NOT** depend on provider API responses. |
| **RECONCILER-DETERM-8** | The reconciler **MUST NOT** depend on filesystem state. |
| **RECONCILER-DETERM-9** | The reconciler **MUST NOT** depend on external side effects (network, I/O, environment variables). |
| **RECONCILER-DETERM-10** | The reconciler **MUST NOT** depend on insertion order of input arrays. The reconciler MUST sort inputs deterministically before processing. |

### 7.3 Implementation Mechanism

Determinism is achieved by:

1. **Canonical action ordering** — `ACTION_ORDER` defines a fixed order for all actions.
2. **Deterministic placement ordering** — `comparePlacements()` sorts by `(provider, id)`.
3. **Provider preference ordering** — `orderByProviderPreference()` sorts by preference rank.
4. **Action deduplication** — `deduplicateActions()` removes duplicate actions.
5. **Stable plan key** — `planKey = "{libraryItemId}:{releaseKey}:{desiredState}"`.

---

## 8. Provider Interaction Boundary

### 8.1 Permitted Provider Interactions

The reconciler does **not** directly interact with providers. It consumes observations produced by the observation layer.

| ID | Constraint |
|----|------------|
| **RECONCILER-PROVIDER-1** | The reconciler **MUST** consume placement observations produced by `observePlacement()`. |
| **RECONCILER-PROVIDER-2** | The reconciler **MUST** consume readiness observations produced by `observeReadiness()`. |
| **RECONCILER-PROVIDER-3** | The reconciler **MUST** consume inventory observations produced by `observeInventory()`. |
| **RECONCILER-PROVIDER-4** | The reconciler **MUST** consume exposure observations produced by `observeExposure()`. |
| **RECONCILER-PROVIDER-5** | The reconciler **MUST** consume mapping evidence produced by `mapExactFile()`. |

### 8.2 Forbidden Provider Interactions

| ID | Constraint |
|----|------------|
| **RECONCILER-PROVIDER-6** | The reconciler **MUST NOT** call provider APIs directly. |
| **RECONCILER-PROVIDER-7** | The reconciler **MUST NOT** create torrents. |
| **RECONCILER-PROVIDER-8** | The reconciler **MUST NOT** delete torrents. |
| **RECONCILER-PROVIDER-9** | The reconciler **MUST NOT** select provider files directly. |
| **RECONCILER-PROVIDER-10** | The reconciler **MUST NOT** refresh provider inventory directly. |

---

## 9. Postcondition Declaration

### 9.1 Reconciler Postconditions

The reconciler does **not** verify postconditions. It declares actions; the store verifies preconditions before binding.

| ID | Constraint |
|----|------------|
| **RECONCILER-POST-1** | The reconciler **MUST** declare `bind`/`rebind` only when preconditions are met (ready placement, fresh inventory, authoritative mapping, visible read-only exposure). |
| **RECONCILER-POST-2** | The reconciler **MUST NOT** verify postconditions. Postcondition verification is the repair executor's responsibility. |
| **RECONCILER-POST-3** | The reconciler **MUST** rely on `store.activateBinding()` to validate preconditions before INSERT. |

### 9.2 Expected Postconditions for `bind`/`rebind`

| Field | Expected Value | Meaning |
|-------|---------------|---------|
| `placement` | `"ready"` | Provider placement must be ready |
| `readiness` | `"ready"` | Provider readiness must be ready |
| `inventory` | `"present-fresh-authoritative-complete"` | Inventory must be present, fresh, authoritative, and complete |
| `exposure` | `"visible-fresh-read-only"` | Filesystem exposure must be visible, fresh, and read-only |
| `exactFileMapping` | `"mapped-authoritative"` | Exact file mapping must be authoritative |
| `binding` | `"active-for-canonical-identity"` | Binding must be active for the canonical identity |

---

## 10. Failure Semantics

### 10.1 Failure Categories

| Category | Meaning | Reconciler Response |
|----------|---------|---------------------|
| `placement-observation-stale` | Placement observation is stale | Emit `observe-again` (placement) |
| `placement-freshness-unbounded` | Placement observation has no expiry | Emit `observe-again` (placement) |
| `placement-observation-exhausted` | Max observation attempts exceeded | Emit `mark-degraded` |
| `readiness-observation-stale` | Readiness observation is stale | Emit `observe-again` (readiness) |
| `readiness-freshness-unbounded` | Readiness observation has no expiry | Emit `observe-again` (readiness) |
| `placement-not-ready` | Placement is not ready (error/removed) | Emit `mark-degraded` |
| `provider-inventory-missing` | No provider files observed | Emit `observe-again` (provider-file-inventory) |
| `provider-inventory-not-authoritative-complete` | Inventory is not authoritative/complete | Emit `observe-again` (provider-file-inventory) |
| `provider-inventory-stale` | Inventory is stale | Emit `observe-again` (provider-file-inventory) |
| `provider-inventory-observation-exhausted` | Max inventory observation attempts exceeded | Emit `mark-degraded` |
| `provider-file-mapped` | Mapping exists but is not authoritative | Emit `map-exact-file` |
| `provider-file-missing` | No provider file matches the desired file | Emit `mark-degraded` |
| `provider-file-ambiguous` | Multiple provider files match the desired file | Emit `mark-degraded` |
| `mapped-provider-file-missing` | Mapped provider file no longer exists in inventory | Emit `mark-degraded` |
| `exposure-not-observed` | Exposure has not been observed | Emit `observe-exposure` |
| `exposure-observation-stale` | Exposure observation is stale | Emit `observe-exposure` |
| `exposure-not-visible` | Exposure is not visible | Emit `mark-degraded` |
| `exposure-not-read-only` | Exposure is not read-only | Emit `mark-degraded` |
| `resource-removal-not-proven-safe` | Resource removal is not safe (not owned, not fresh, or has dependents) | No action (destructive disabled or unsafe) |
| `destructive-actions-disabled` | Destructive actions are disabled | No action |

### 10.2 Failure Constraints

| ID | Constraint |
|----|------------|
| **RECONCILER-FAIL-1** | The reconciler **MUST** record all failures in the `failures` array of the reconciliation plan. |
| **RECONCILER-FAIL-2** | The reconciler **MUST** emit `mark-degraded` when `actions` is empty and `failures` is non-empty. |
| **RECONCILER-FAIL-3** | The reconciler **MUST NOT** swallow errors. All failures propagate to the plan output. |

---

## 11. Forbidden Responsibilities

### 11.1 Repair

| ID | Constraint |
|----|------------|
| **RECONCILER-FORBID-1** | The reconciler **MUST NOT** generate repair plans. |
| **RECONCILER-FORBID-2** | The reconciler **MUST NOT** execute repair actions. |
| **RECONCILER-FORBID-3** | The reconciler **MUST NOT** create repair transactions. |
| **RECONCILER-FORBID-4** | The reconciler **MUST NOT** verify repair postconditions. |

### 11.2 Consumer Interaction

| ID | Constraint |
|----|------------|
| **RECONCILER-FORBID-5** | The reconciler **MUST NOT** know Plex behavior. |
| **RECONCILER-FORBID-6** | The reconciler **MUST NOT** react to playback failures. |
| **RECONCILER-FORBID-7** | The reconciler **MUST NOT** modify consumer artifacts (`.strm`, WebDAV, FUSE). |
| **RECONCILER-FORBID-8** | The reconciler **MUST NOT** interact with the media gateway. |

### 11.3 Direct Mutation

| ID | Constraint |
|----|------------|
| **RECONCILER-FORBID-9** | The reconciler **MUST NOT** directly mutate `bindings` rows via SQL. |
| **RECONCILER-FORBID-10** | The reconciler **MUST NOT** directly mutate `repair_transactions` rows via SQL. |
| **RECONCILER-FORBID-11** | The reconciler **MUST NOT** bypass the store's `activateBinding()` function. |

### 11.4 Side Effects

| ID | Constraint |
|----|------------|
| **RECONCILER-FORBID-12** | The reconciler **MUST NOT** perform any I/O. |
| **RECONCILER-FORBID-13** | The reconciler **MUST NOT** access the filesystem. |
| **RECONCILER-FORBID-14** | The reconciler **MUST NOT** access the network. |
| **RECONCILER-FORBID-15** | The reconciler **MUST NOT** read environment variables except via injected `options`. |

---

## 12. Relationship to Planner

### 12.1 Boundary Definition

| Reconciler | Planner |
|------------|---------|
| **ROUTINE** state | **DEGRADED** state |
| Handles healthy placements, fresh inventory, visible exposures | Handles missing placements, stale inventory, missing emissions |
| Emits `bind`/`rebind`/`mark-degraded` | Emits `repair-required` with permitted actions |
| Creates bindings via `activateBinding()` | Creates repair plans (no bindings) |
| Is idempotent | Is deterministic |
| Runs on every control-plane cycle | Runs only when binding is degraded |

### 12.2 Reconciler Provides to Planner

| Artifact | Purpose |
|----------|---------|
| `mark-degraded` action | Triggers the planner to evaluate repair |
| Current binding state | Planner evaluates binding against desired identity |
| Current observations | Planner consumes observations to detect triggers |

### 12.3 Planner Provides to Reconciler

| Artifact | Purpose |
|----------|---------|
| Nothing direct | The planner does not feed the reconciler. The reconciler runs first; if it marks degraded, the planner runs. |

### 12.4 Mutual Exclusion

| ID | Constraint |
|----|------------|
| **RECONCILER-PLANNER-1** | The reconciler **MUST NOT** absorb the planner's responsibilities. |
| **RECONCILER-PLANNER-2** | The planner **MUST NOT** absorb the reconciler's responsibilities. |
| **RECONCILER-PLANNER-3** | The reconciler and planner **MUST NOT** be the same component. |

---

## 13. Relationship to Executor

### 13.1 Boundary Definition

| Reconciler | Executor |
|------------|---------|
| **ROUTINE** binding actions | **REPAIR** transaction execution |
| Creates bindings via `activateBinding()` | Creates repair transactions via `createRepairTransaction()` |
| Emits `bind`/`rebind` | Executes `RECONCILE_BINDING` (which calls `activateBinding()`) |
| Emits `mark-degraded` | Consumes `repair-required` plans |
| Is idempotent | Is transactional |

### 13.2 Reconciler Provides to Executor

| Artifact | Purpose |
|----------|---------|
| `mark-degraded` action | Triggers repair planner; executor consumes repair plan |
| Current binding state | Executor validates `expectedBindingVersion` |

### 13.3 Executor Provides to Reconciler

| Artifact | Purpose |
|----------|---------|
| New active binding | Reconciler's next run produces `no-op` (binding is current) |
| Superseded old binding | Reconciler does not touch superseded bindings |

### 13.4 Concurrent Activity

| ID | Constraint |
|----|------------|
| **RECONCILER-EXECUTOR-1** | The reconciler **MUST** respect optimistic concurrency. If the binding changes during reconciliation, the reconciler's `bind`/`rebind` fails. |
| **RECONCILER-EXECUTOR-2** | The reconciler **MUST** be idempotent. If repair succeeds concurrently, the reconciler's next run produces `no-op`. |
| **RECONCILER-EXECUTOR-3** | The reconciler **MUST NOT** execute repair actions. Execution is exclusively the executor's responsibility. |

---

## 14. Relationship to Binding Contract

### 14.1 Binding Contract Defines

- Valid binding states (`active`, `degraded`, `superseded`, `failed`) — see `BINDING-STATE-CONTRACT.md` §4
- Versioning rules (one-active rule, monotonicity, optimistic concurrency) — see `BINDING-STATE-CONTRACT.md` §5
- Atomicity guarantees — see `BINDING-STATE-CONTRACT.md` §6
- Failure semantics — see `BINDING-STATE-CONTRACT.md` §7
- Forbidden transitions — see `BINDING-STATE-CONTRACT.md` §4.4

### 14.2 Reconciler MUST Respect Binding Constraints

| ID | Constraint |
|----|------------|
| **RECONCILER-BC-1** | The reconciler **MUST** respect the **one-active-binding rule**. The reconciler never creates bindings except through `activateBinding()`, which enforces uniqueness. |
| **RECONCILER-BC-2** | The reconciler **MUST** respect **optimistic concurrency**. `expectedBindingVersion` is passed to `activateBinding()`. |
| **RECONCILER-BC-3** | The reconciler **MUST** respect **terminal states**. The reconciler does not attempt to bind `superseded` or `failed` bindings. |
| **RECONCILER-BC-4** | The reconciler **MUST** respect **version monotonicity**. New bindings have `version = MAX(version) + 1`. |
| **RECONCILER-BC-5** | The reconciler **MUST** respect **atomicity**. Old binding supersession and new binding creation happen in a single transaction. |
| **RECONCILER-BC-6** | The reconciler **MUST** respect **validation**. `activateBinding()` validates readiness, inventory, exposure, mapping, and visibility before INSERT. |

### 14.3 Binding State Machine Relevance

- `active` → `active` (no-op): Reconciler detects current binding is healthy; emits `no-op`.
- `active` → `degraded`: Reconciler detects unhealthy state; emits `mark-degraded`.
- `degraded` → `superseded`: Repair executor's `reconcileExactBinding()` calls `activateBinding()`, which supersedes the old binding.
- `degraded` → `failed`: Repair fails postconditions; binding remains `degraded` or is marked `failed`.
- `superseded` / `failed`: Terminal. Reconciler does not touch these.

---

## 15. Future Contract Dependencies

### 15.1 Contracts This Document Feeds

| Dependent Contract | How This Contract Feeds It |
|--------------------|---------------------------|
| `REPAIR-TRANSACTION-CONTRACT` | Defines the boundary between routine reconciliation and repair. Reconciler handles `bind`/`rebind`/`mark-degraded`; executor handles degraded → superseded/active transitions. |
| `REPAIR-PLANNER-CONTRACT` | Defines the `mark-degraded` handoff. Reconciler emits `mark-degraded`; planner produces repair plan. |

### 15.2 Contract Dependency Graph

```
BINDING-STATE-CONTRACT
        │
        ├──▶ REPAIR-PLANNER-CONTRACT
        │      - Plan key binding version
        │      - Expected postconditions
        │      - Stale plan rejection
        │
        ├──▶ REPAIR-EXECUTOR-CONTRACT
        │      - Supersession semantics
        │      - Postcondition verification
        │      - Failure categories
        │
        └──▶ RECONCILER-CONTRACT (this document)
               - Binding actions (bind/rebind/mark-degraded)
               - Satisfies check
               - Optimistic concurrency
               - Routine vs degraded boundary
```

### 15.3 Constraints on Future Contracts

| ID | Constraint |
|----|------------|
| **RECONCILER-FUTURE-1** | Future contracts **MUST NOT** expand the reconciliation action catalog without updating this document. |
| **RECONCILER-FUTURE-2** | Future contracts **MUST NOT** relax determinism requirements without updating §7. |
| **RECONCILER-FUTURE-3** | Future contracts **MUST** preserve the reconciler's pure-function semantics. The reconciler remains side-effect-free. |
| **RECONCILER-FUTURE-4** | Future contracts **MUST** preserve the routine vs degraded boundary. The reconciler handles routine; repair handles degraded. |

---

## 16. Compliance Verification

A reconciler implementation **complies** with this contract if:

1. It produces deterministic outputs from identical inputs (§7).
2. It consumes only the inputs defined in §3.
3. It uses only the ten actions defined in §4.1.
4. It emits `bind`/`rebind`/`mark-degraded` according to the rules in §5.
5. It respects the routine vs degraded boundary in §6.
6. It does not directly interact with providers (§8).
7. It does not verify postconditions (§9).
8. It maps failures to the categories in §10.
9. It does not generate repair plans, interact with consumers, or directly mutate tables (§11).
10. It respects the boundary with the planner (§12) and executor (§13).
11. It respects the binding contract's constraints (§14).

An implementation that violates any **MUST** constraint is non-compliant.

---

## 17. Relationship to Prior Documents

| Prior Document | Relationship |
|----------------|--------------|
| `BINDING-STATE-CONTRACT.md` | Defines binding lifecycle; this contract defines routine reconciliation within that lifecycle |
| `REPAIR-PLANNER-CONTRACT.md` | Defines planner boundary; this contract defines the `mark-degraded` handoff to the planner |
| `REPAIR-EXECUTOR-CONTRACT.md` | Defines executor boundary; this contract defines the concurrent activity rules |
| `REPAIR-RECONCILIATION-BOUNDARY-ANALYSIS.md` | Analysis of repair boundary; this contract formalizes the reconciler's role within it |
| `MATERIALIZATION-ARCHITECTURE.md` | Defines materialization layer; this contract defines routine reconciliation within it |
| `CONTRACTS.md` | Upstream contract patterns; this contract follows the same MUST/MUST NOT/MAY pattern |

---

End of contract.

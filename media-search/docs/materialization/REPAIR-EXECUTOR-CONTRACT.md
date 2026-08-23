# Repair Executor Contract

**Date:** 2026-08-23
**Status:** Contract — normative constraints on repair execution
**Grounded in:** `BINDING-STATE-CONTRACT.md`, `REPAIR-PLANNER-CONTRACT.md`, `REPAIR-RECONCILIATION-BOUNDARY-ANALYSIS.md`, `MATERIALIZATION-ARCHITECTURE.md`, `CONTRACTS.md`
**Cross-checked against:** `media-search/src/lib/control-plane/repair-executor.js`, `media-search/src/lib/control-plane/store.js`, `media-search/src/lib/control-plane/reconciler.js`, `media-search/src/lib/control-plane/repair-planner.js`
**Constraints:** No code; no schema changes; no implementation; contract only

---

## 1. Purpose

This document defines the **normative contract for the repair executor**. It answers thirteen questions:

1. What is the executor's role in the repair pipeline?
2. Who owns transaction lifecycle, authorization, step execution, auditing, postcondition verification, and success/failure classification?
3. What inputs may the executor consume?
4. How does the transaction lifecycle flow from `planned` to terminal states?
5. What authorization rules must the executor enforce?
6. How are individual repair steps executed?
7. How are binding mutations safely performed?
8. How does the executor interact with providers?
9. How are postconditions verified?
10. What are the failure semantics?
11. What is the executor forbidden from doing?
12. How does the executor relate to the planner?
13. How does the executor relate to the binding state contract?

Each answer is stated as a MUST / MUST NOT / MAY constraint. Violations break the contract.

### 1.1 Architectural Position

The repair executor is the **sole materialization boundary** between repair plans and state mutations:

```
authorized repair plan
        │
        v
  repair executor
        │
        v
transactional execution
        │
        v
verified healthy state
```

The executor does **not decide** what repair should happen. The planner decides; the executor safely materializes. The executor is a **state machine** that transitions repair transactions through audited, transactional state changes.

**Key insight:** The executor is the **only component that writes** to `repair_transactions`, `repair_steps`, and `bindings` during repair. No other component may write these tables.

---

## 2. Ownership

### 2.1 Executor Ownership

| ID | Constraint |
|----|------------|
| **EXECUTOR-OWN-1** | The repair executor **MUST** own **repair transaction lifecycle** — creating, authorizing, executing, and transitioning repair transactions through `planned → authorized → executing → succeeded/failed`. |
| **EXECUTOR-OWN-2** | The repair executor **MUST** own **authorization validation** — verifying that plan identity, binding version, permitted actions, and expected postconditions are consistent before execution begins. |
| **EXECUTOR-OWN-3** | The repair executor **MUST** own **step execution** — running each auditable repair action in the authorized sequence. |
| **EXECUTOR-OWN-4** | The repair executor **MUST** own **step auditing** — recording every step attempt in `repair_steps` with request/result metadata. |
| **EXECUTOR-OWN-5** | The repair executor **MUST** own **postcondition verification** — re-running the planner after execution to confirm the binding is healthy. |
| **EXECUTOR-OWN-6** | The repair executor **MUST** own **success/failure classification** — mapping execution outcomes to transaction status and `failure_category`. |

### 2.2 Executor Does NOT Own

| Aspect | Actual Owner | Mechanism |
|--------|--------------|-----------|
| Trigger detection | Repair planner | `detectTriggers()` classifies observation signals |
| Plan generation | Repair planner | `planRdZurgRepair()` produces deterministic plans |
| Permitted action selection | Repair planner | `permittedActionsFor()` maps triggers to actions |
| Provider selection | Repair planner / Reconciler | Planner declares `RECONCILE_BINDING`; executor uses `newestUsablePlacement()` |
| Consumer behavior | Media gateway / Adapters | Gateway reads bindings; adapters consume exposures |
| Gateway behavior | Media gateway | Gateway serves bytes; never triggers repair |
| Binding state machine | Binding state contract | `BINDING-STATE-CONTRACT.md` defines valid transitions |
| Routine reconciliation | Reconciler | `planReconciliation()` handles `bind`/`rebind`/`mark-degraded` |

**Key insight:** The executor is a **pure consumer of plans**. It does not invent, modify, or optimize repair strategies. It executes exactly what the planner authorized.

---

## 3. Input Contract

### 3.1 Allowed Inputs

| Input | Type | Purpose |
|-------|------|---------|
| **repairPlan** | Frozen repair plan object | The planner's authorized repair intent |
| **expectedBindingVersion** | Integer | The binding version the plan was computed against |
| **permittedActions** | Array of action strings | The set of actions the executor may perform |
| **actionSequence** | Array of action strings | The canonical execution order |
| **scope** | Object | Provider, account, instance, and mount scope constraints |
| **desiredIdentity** | Object | The target content identity (`infoHash`, `fileIndex`) |
| **context** | Object | Execution context (signal, observedAt, expiresAt, metadataPath, relativePath, now) |

### 3.2 Input Semantics

**Repair Plan** MUST contain:
- `planKey` — deterministic plan identity
- `status: "repair-required"` — only repair-required plans may become transactions
- `binding` — reference to the binding being repaired (id, version, placementId, providerFileId, exposureId)
- `triggers` — sorted trigger categories with sanitized evidence
- `permittedActions` — set of permitted repair actions
- `actionSequence` — canonical execution order
- `expectedPostconditions` — what success looks like
- `currentObservations` — baseline observation state for audit

**Expected Binding Version** MUST:
- Match the current active binding's version at transaction creation
- Be validated against the current binding before each step execution
- Trigger stale plan rejection if the binding changes

### 3.3 Stale Plan Rejection

| ID | Constraint |
|----|------------|
| **EXECUTOR-INPUT-1** | The executor **MUST** reject plans where `binding.version !== expectedBindingVersion`. |
| **EXECUTOR-INPUT-2** | The executor **MUST** reject plans where the current active binding's identity does not match the plan's binding identity. |
| **EXECUTOR-INPUT-3** | The executor **MUST** reject plans where `planKey` does not match a freshly computed plan from current evidence. |
| **EXECUTOR-INPUT-4** | The executor **MUST** reject plans where `status !== 'repair-required'`. |
| **EXECUTOR-INPUT-5** | The executor **MUST** reject plans where `permittedActions` does not match `actionSequence` as a set. |

**Rationale:** Stale plans are rejected to prevent concurrent repair and reconciler activity from corrupting binding state. If the binding changed between plan and execute, the plan is invalid.

---

## 4. Transaction Lifecycle

### 4.1 State Machine

```
planned
  │
  │ authorize()
  ▼
authorized
  │
  │ execute()
  ▼
executing
  │
  ├── postconditions met ──▶ succeeded
  │
  └── postconditions failed OR step failed ──▶ failed
```

### 4.2 State Definitions

| State | Meaning | Terminal? |
|-------|---------|-----------|
| `planned` | Transaction created; plan persisted; awaiting authorization | No |
| `authorized` | Action sequence approved; ready to execute | No |
| `executing` | Steps running in authorized order | No |
| `succeeded` | All steps succeeded; postconditions verified; binding healthy | Yes |
| `failed` | Postcondition failure; step failure; authorization failure; stale binding | Yes |

### 4.3 State Transitions

| From | To | Trigger | Owner |
|------|----|---------|-------|
| *(none)* | `planned` | `createRepairTransaction()` with valid plan | Executor |
| `planned` | `authorized` | `authorizeRepairTransaction()` with authorized actions | Executor (human or automated) |
| `authorized` | `executing` | `execute()` begins; `startRepairStep()` transitions status | Executor |
| `executing` | `succeeded` | All steps succeed; `assertPostconditions()` passes; `completeRepairTransaction()` | Executor |
| `executing` | `failed` | Any step fails; postcondition failure; binding version change; authorization failure | Executor |
| `planned` | `failed` | Stale plan rejection; binding version mismatch | Executor |

### 4.4 Terminal States

| ID | Constraint |
|----|------------|
| **EXECUTOR-LIFECYCLE-1** | `succeeded` is terminal. No further transitions are permitted. |
| **EXECUTOR-LIFECYCLE-2** | `failed` is terminal. No further transitions are permitted. |
| **EXECUTOR-LIFECYCLE-3** | The executor **MUST NOT** transition from `failed` to `authorized` or `executing` without creating a new transaction. |

### 4.5 Audit Requirements

| ID | Constraint |
|----|------------|
| **EXECUTOR-LIFECYCLE-4** | Every state transition **MUST** be recorded in `repair_transactions.updated_at`. |
| **EXECUTOR-LIFECYCLE-5** | Every step execution **MUST** be recorded in `repair_steps` with `request` and `result` metadata. |
| **EXECUTOR-LIFECYCLE-6** | Terminal transitions **MUST** record `completed_at` and `failure_category` (if failed). |

---

## 5. Authorization Rules

### 5.1 Executor MUST Verify

| ID | Constraint |
|----|------------|
| **EXECUTOR-AUTH-1** | The executor **MUST** verify **plan identity** — `planKey` MUST match a freshly computed plan from current evidence (`assertTrustedPlan()`). |
| **EXECUTOR-AUTH-2** | The executor **MUST** verify **binding version** — `expectedBindingVersion` MUST match the current active binding's version. |
| **EXECUTOR-AUTH-3** | The executor **MUST** verify **action list** — `authorizedActions` MUST be a subset of `permittedActions` and MUST preserve `actionSequence` ordering. |
| **EXECUTOR-AUTH-4** | The executor **MUST** verify **expected state** — the binding's identity (`id`, `placementId`, `providerFileId`, `exposureId`) MUST match the plan's binding reference. |

### 5.2 Executor MUST Reject

| ID | Constraint |
|----|------------|
| **EXECUTOR-AUTH-5** | The executor **MUST** reject **stale plans** — if the binding version changed between plan and execute. |
| **EXECUTOR-AUTH-6** | The executor **MUST** reject **modified plans** — if the persisted plan does not match trusted control-plane evidence. |
| **EXECUTOR-AUTH-7** | The executor **MUST** reject **unauthorized actions** — if `authorizedActions` includes actions not in `permittedActions`. |
| **EXECUTOR-AUTH-8** | The executor **MUST** reject **missing evidence** — if the snapshot lacks the binding, placement, provider file, or exposure referenced by the plan. |
| **EXECUTOR-AUTH-9** | The executor **MUST** reject **out-of-order actions** — if `authorizedActions` does not preserve the canonical `actionSequence` ordering. |

### 5.3 Authorization Constraints

| ID | Constraint |
|----|------------|
| **EXECUTOR-AUTH-10** | `REQUEST_PROVIDER_REPAIR` authorization **MUST** include `REOBSERVE_PROVIDER`. Provider repair requires post-repair observation. |
| **EXECUTOR-AUTH-11** | `RESELECT_KNOWN_FILES` authorization **MUST** include `REOBSERVE_PROVIDER`. File selection requires prior observation. |
| **EXECUTOR-AUTH-12** | Authorization **MUST** be performed by a human or an automated control-plane process. The executor does not self-authorize without explicit approval. |

---

## 6. Step Execution Contract

### 6.1 Step Execution Semantics

Each permitted action becomes an audited step in `repair_steps`. Steps are executed in the canonical `actionSequence` order.

| ID | Constraint |
|----|------------|
| **EXECUTOR-STEP-1** | The executor **MUST** execute steps in the order defined by `actionSequence`. |
| **EXECUTOR-STEP-2** | The executor **MUST** record each step attempt in `repair_steps` with `request` metadata. |
| **EXECUTOR-STEP-3** | The executor **MUST** record step results in `repair_steps` with `result` metadata. |
| **EXECUTOR-STEP-4** | The executor **MUST** ensure only one `running` step exists per action per transaction. |

### 6.2 Step Idempotency

| ID | Constraint |
|----|------------|
| **EXECUTOR-STEP-5** | Steps **MUST** be idempotent. If a step has already `succeeded`, the executor **MUST NOT** re-execute it. |
| **EXECUTOR-STEP-6** | Steps **MUST** use `idempotencyKey` based on `{repairId}:{action}:{attempt}` to prevent duplicate provider mutations. |
| **EXECUTOR-STEP-7** | Provider mutations (`RESELECT_KNOWN_FILES`, `REQUEST_PROVIDER_REPAIR`) **MUST** be idempotent — calling twice with the same `idempotencyKey` produces the same result. |

### 6.3 Step Failure Handling

| ID | Constraint |
|----|------------|
| **EXECUTOR-STEP-8** | If a step fails, the executor **MUST** call `failRepairStep()` with the `failureCategory`. |
| **EXECUTOR-STEP-9** | If a step fails, the executor **MUST** transition the transaction to `failed`. |
| **EXECUTOR-STEP-10** | The executor **MUST NOT** retry failed steps automatically. Retry requires manual intervention or a new transaction. |
| **EXECUTOR-STEP-11** | If a provider mutation outcome is unknown (not `temporarily-unavailable`, `rate-limit`, `authentication`, `authorization`, `invalid-request`, `unsupported`, or `unsafe-operation`), the executor **MUST** fail with `repair-operation-outcome-unknown`. |

### 6.4 Step Execution by Action

#### `REOBSERVE_PROVIDER`

| Aspect | Definition |
|--------|------------|
| **Executor calls** | `slice.observePlacement()`, `slice.observeReadiness()`, `slice.observeInventory()` |
| **Idempotency** | Observations are content-addressed by `(provider, accountScope, infoHash)`. Re-observation updates the canonical observation. |
| **Failure handling** | If observation fails, step fails with provider error category. Transaction fails. |

#### `REPLACE_PLACEMENT_OBSERVATION`

| Aspect | Definition |
|--------|------------|
| **Executor calls** | `slice.observePlacement()` with replacement semantics |
| **Idempotency** | Same as `REOBSERVE_PROVIDER`. Re-observation replaces the existing observation. |
| **Failure handling** | If replacement fails, step fails with provider error category. Transaction fails. |

#### `RESELECT_KNOWN_FILES`

| Aspect | Definition |
|--------|------------|
| **Executor calls** | `realDebrid.require(FILE_SELECTION).selectKnownFiles()` |
| **Idempotency** | Uses `idempotencyKey: {repairId}:{action}:{attempt}`. Same key returns the same result. |
| **Safety** | Executor **MUST** verify that shared placement selection does not omit any active exact binding (`unsafe-operation`). |
| **Failure handling** | If selection fails, step fails with provider error category. Transaction fails. |

#### `REQUEST_PROVIDER_REPAIR`

| Aspect | Definition |
|--------|------------|
| **Executor calls** | `realDebrid.require(REPAIR_REQUEST).requestRepair()` |
| **Idempotency** | Uses `idempotencyKey: {repairId}:{action}:{attempt}`. Same key returns the same result. |
| **Failure handling** | If repair request fails, step fails with provider error category. Transaction fails. |

#### `REOBSERVE_ZURG_METADATA`

| Aspect | Definition |
|--------|------------|
| **Executor calls** | `slice.observeZurgMetadata()` with `metadataPath` from context |
| **Idempotency** | Observations are content-addressed by `(provider, accountScope, instanceScope, infoHash, metadataPath)`. Re-observation updates the canonical observation. |
| **Failure handling** | If observation fails, step fails with provider error category. Transaction fails. |

#### `REOBSERVE_FILESYSTEM_EXPOSURE`

| Aspect | Definition |
|--------|------------|
| **Executor calls** | `slice.observeExposure()` with `relativePath` from context |
| **Idempotency** | Observations are content-addressed by `(transport, exposureKey, placementId, providerFileId)`. Re-observation updates the canonical observation. |
| **Failure handling** | If observation fails, step fails with provider error category. Transaction fails. |

#### `RECONCILE_BINDING`

| Aspect | Definition |
|--------|------------|
| **Executor calls** | `reconcileExactBinding()` → `slice.activateBinding()` |
| **Preconditions** | Fresh placement observation; exact file mapping; visible read-only exposure; authoritative complete inventory; ready readiness |
| **Idempotency** | `activateBinding()` uses `expectedBindingVersion` for optimistic concurrency. If binding changed, activation fails. |
| **Failure handling** | If no usable placement exists, step fails with `no-usable-placement`. If binding version changed, step fails with `repair-version-conflict`. |

---

## 7. Binding Mutation Boundary

### 7.1 Critical Section

The binding mutation boundary is the **most critical section** of the executor. Bindings are the cut point between the read-only projection (gateway) and the write path (repair). All binding mutations MUST go through validated store operations.

### 7.2 Permitted Binding Operations

| ID | Constraint |
|----|------------|
| **EXECUTOR-BINDING-1** | The executor **MAY** mutate bindings **only** through `store.activateBinding()`. |
| **EXECUTOR-BINDING-2** | The executor **MUST** pass `expectedBindingVersion` to `activateBinding()` to enforce optimistic concurrency. |
| **EXECUTOR-BINDING-3** | The executor **MUST** validate that `activateBinding()` succeeded — the new binding MUST have `status = 'active'` and `version = expectedBindingVersion + 1`. |
| **EXECUTOR-BINDING-4** | The executor **MUST** verify that the old binding was superseded — `old_binding.status = 'superseded'` and `old_binding.superseded_at` is set. |

### 7.3 Forbidden Binding Operations

| ID | Constraint |
|----|------------|
| **EXECUTOR-BINDING-5** | The executor **MUST NOT** manually SQL mutate `bindings` rows. All mutations go through `activateBinding()`. |
| **EXECUTOR-BINDING-6** | The executor **MUST NOT** bypass `activateBinding()` validation. The store validates readiness, inventory, exposure, mapping, and visibility. |
| **EXECUTOR-BINDING-7** | The executor **MUST NOT** create multiple active bindings for the same `library_item_id`. The partial unique index `idx_bindings_one_active` enforces this. |
| **EXECUTOR-BINDING-8** | The executor **MUST NOT** directly UPDATE `bindings.status`, `bindings.version`, or `bindings.superseded_at`. |
| **EXECUTOR-BINDING-9** | The executor **MUST NOT** delete binding rows. |

### 7.4 Atomic Replacement

| ID | Constraint |
|----|------------|
| **EXECUTOR-BINDING-10** | Binding replacement **MUST** be atomic — the old binding is superseded and the new binding is created in a single transaction. |
| **EXECUTOR-BINDING-11** | The executor **MUST NOT** observe a partial binding state. Consumers see either the old binding or the new binding, never both, never neither. |

---

## 8. Provider Interaction Boundary

### 8.1 Permitted Provider Interactions

The executor MAY invoke provider APIs **only** for explicitly authorized capability actions:

| ID | Constraint |
|----|------------|
| **EXECUTOR-PROVIDER-1** | The executor **MAY** call `slice.observePlacement()` for `REOBSERVE_PROVIDER` and `REPLACE_PLACEMENT_OBSERVATION`. |
| **EXECUTOR-PROVIDER-2** | The executor **MAY** call `slice.observeReadiness()` for `REOBSERVE_PROVIDER`. |
| **EXECUTOR-PROVIDER-3** | The executor **MAY** call `slice.observeInventory()` for `REOBSERVE_PROVIDER`. |
| **EXECUTOR-PROVIDER-4** | The executor **MAY** call `realDebrid.require(FILE_SELECTION).selectKnownFiles()` for `RESELECT_KNOWN_FILES`. |
| **EXECUTOR-PROVIDER-5** | The executor **MAY** call `realDebrid.require(REPAIR_REQUEST).requestRepair()` for `REQUEST_PROVIDER_REPAIR`. |
| **EXECUTOR-PROVIDER-6** | The executor **MAY** call `slice.observeZurgMetadata()` for `REOBSERVE_ZURG_METADATA`. |
| **EXECUTOR-PROVIDER-7** | The executor **MAY** call `slice.observeExposure()` for `REOBSERVE_FILESYSTEM_EXPOSURE` and `RECONCILE_BINDING`. |

### 8.2 Forbidden Provider Interactions

| ID | Constraint |
|----|------------|
| **EXECUTOR-PROVIDER-8** | The executor **MUST NOT** invent provider actions. Only the seven actions in `REPAIR_ACTIONS` are permitted. |
| **EXECUTOR-PROVIDER-9** | The executor **MUST NOT** bypass the planner. The executor may only perform actions in `authorizedActions`. |
| **EXECUTOR-PROVIDER-10** | The executor **MUST NOT** call providers outside the authorized action list. |
| **EXECUTOR-PROVIDER-11** | The executor **MUST NOT** call provider APIs that are not exposed by the injected `slice` or `realDebrid` seams. |

---

## 9. Postcondition Verification

### 9.1 Postcondition Semantics

**Repair is not successful because steps complete.** Repair succeeds only when the binding is healthy.

| ID | Constraint |
|----|------------|
| **EXECUTOR-POST-1** | The executor **MUST** call `assertPostconditions()` after all steps succeed. |
| **EXECUTOR-POST-2** | `assertPostconditions()` **MUST** re-run the planner against current evidence. |
| **EXECUTOR-POST-3** | The re-planned plan **MUST** have `status: "healthy"`. |
| **EXECUTOR-POST-4** | The re-planned plan **MUST** have an active binding with `status: "active"`. |
| **EXECUTOR-POST-5** | The re-planned plan **MUST** have an authoritative exact file mapping. |
| **EXECUTOR-POST-6** | The re-planned plan **MUST** have a visible read-only exposure. |

### 9.2 Postcondition Failure

| ID | Constraint |
|----|------------|
| **EXECUTOR-POST-7** | If `assertPostconditions()` fails, the transaction **MUST** transition to `failed` with `failure_category: 'repair-postcondition-failed'`. |
| **EXECUTOR-POST-8** | If postconditions fail, the binding **MUST NOT** be mutated. The binding remains in its pre-repair state (or superseded if a concurrent reconciler succeeded). |
| **EXECUTOR-POST-9** | The executor **MUST** throw an error with `category: 'repair-postcondition-failed'` when postconditions fail. |

### 9.3 Why Postconditions Are Necessary

Steps may complete without achieving health. Examples:
- Provider re-observation reports the file is still missing
- Exposure re-observation still reports `state: 'error'`
- Binding activation fails because the exposure expired between observation and activation

**Key insight:** Postcondition verification is the **only** mechanism that confirms repair succeeded. Step completion is necessary but not sufficient.

---

## 10. Failure Semantics

### 10.1 Failure Categories

| Category | Meaning | Mapping |
|----------|---------|---------|
| `repair-postcondition-failed` | Steps completed but binding is not healthy | Transaction: `failed`; Binding: unchanged or superseded |
| `repair-version-conflict` | Binding version changed during execution | Transaction: `failed`; Binding: superseded by concurrent reconciler |
| `repair-plan-invalid` | Persisted plan does not match trusted evidence | Transaction: `failed`; Binding: unchanged |
| `repair-operation-outcome-unknown` | Provider mutation outcome is ambiguous | Transaction: `failed`; Binding: unchanged |
| `repair-operation-failed` | Generic step failure | Transaction: `failed`; Binding: unchanged |
| `no-usable-placement` | No placement ready for reconciliation | Transaction: `failed`; Binding: `degraded` or `failed` |
| `unsafe-operation` | Shared placement selection would omit an active binding | Transaction: `failed`; Binding: unchanged |

### 10.2 Failure Mapping Table

| Repair Transaction State | Binding State | Gateway-Visible Result |
|--------------------------|---------------|------------------------|
| `succeeded` | New `active` binding (old `superseded`) | 200/206 — bytes served |
| `failed` (postcondition) | Old binding `degraded` or `superseded` | 503 or 410 — depends on binding state |
| `failed` (version conflict) | New `active` binding (old `superseded`) | 200/206 — concurrent reconciler succeeded |
| `failed` (plan invalid) | Binding unchanged | 503 or 410 — depends on binding state |
| `failed` (operation failed) | Binding unchanged | 503 or 410 — depends on binding state |
| `failed` (no usable placement) | Binding `degraded` | 503 — repair needed |
| `failed` (no usable placement, no alternate) | Binding `failed` | 410 — permanent failure |

### 10.3 Failure Constraints

| ID | Constraint |
|----|------------|
| **EXECUTOR-FAIL-1** | The executor **MUST** record `failure_category` on every failure. |
| **EXECUTOR-FAIL-2** | The executor **MUST NOT** swallow errors. All errors propagate to the transaction state. |
| **EXECUTOR-FAIL-3** | The executor **MUST NOT** leave a transaction in `executing` state on failure. It MUST transition to `failed`. |
| **EXECUTOR-FAIL-4** | The executor **MUST NOT** leave a step in `running` state on failure. It MUST transition to `failed`. |

---

## 11. Forbidden Responsibilities

### 11.1 Plan Generation

| ID | Constraint |
|----|------------|
| **EXECUTOR-FORBID-1** | The executor **MUST NOT** generate new repair plans. |
| **EXECUTOR-FORBID-2** | The executor **MUST NOT** modify existing repair plans. |
| **EXECUTOR-FORBID-3** | The executor **MUST NOT** change plan scope, triggers, or permitted actions. |

### 11.2 Consumer Interaction

| ID | Constraint |
|----|------------|
| **EXECUTOR-FORBID-4** | The executor **MUST NOT** trigger repair from consumer requests. |
| **EXECUTOR-FORBID-5** | The executor **MUST NOT** know Plex behavior. |
| **EXECUTOR-FORBID-6** | The executor **MUST NOT** react to playback failures. |
| **EXECUTOR-FORBID-7** | The executor **MUST NOT** modify consumer artifacts (`.strm`, WebDAV, FUSE). |
| **EXECUTOR-FORBID-8** | The executor **MUST NOT** interact with the media gateway. |

### 11.3 Lifecycle Bypass

| ID | Constraint |
|----|------------|
| **EXECUTOR-FORBID-9** | The executor **MUST NOT** bypass the planner. Execution without planning is forbidden. |
| **EXECUTOR-FORBID-10** | The executor **MUST NOT** skip postcondition verification. |
| **EXECUTOR-FORBID-11** | The executor **MUST NOT** mark transactions as `succeeded` without verified postconditions. |
| **EXECUTOR-FORBID-12** | The executor **MUST NOT** mark steps as `succeeded` without verified results. |

### 11.4 Direct Mutation

| ID | Constraint |
|----|------------|
| **EXECUTOR-FORBID-13** | The executor **MUST NOT** directly mutate `bindings` rows via SQL. |
| **EXECUTOR-FORBID-14** | The executor **MUST NOT** directly mutate `repair_transactions` rows via SQL. |
| **EXECUTOR-FORBID-15** | The executor **MUST NOT** directly mutate `repair_steps` rows via SQL. |
| **EXECUTOR-FORBID-16** | The executor **MUST NOT** bypass the store's transaction mechanism. |
| **EXECUTOR-FORBID-17** | The executor **MUST NOT** write to tables not owned by the control plane. |

### 11.5 Retry and Recovery

| ID | Constraint |
|----|------------|
| **EXECUTOR-FORBID-18** | The executor **MUST NOT** automatically retry failed transactions. |
| **EXECUTOR-FORBID-19** | The executor **MUST NOT** resume failed transactions without explicit authorization. |
| **EXECUTOR-FORBID-20** | The executor **MUST NOT** merge partial repairs from multiple transactions. |

---

## 12. Relationship to Planner

### 12.1 Boundary Definition

| Planner | Executor |
|---------|----------|
| **WHAT** should happen | **HOW** it happens safely |
| Produces repair plan | Consumes and executes repair plan |
| Declares permitted actions | Executes permitted actions only |
| Declares expected postconditions | Verifies postconditions after execution |
| Computes plan identity | Persists plan as repair transaction |
| Classifies triggers | Maps triggers to action implementations |
| Is a pure function | Is a state machine |

### 12.2 Planner Provides to Executor

| Artifact | Purpose |
|----------|---------|
| `planKey` | Durable, deterministic plan identity |
| `binding` reference | The binding to repair (id, version, placementId, providerFileId, exposureId) |
| `permittedActions` | The set of actions the executor may perform |
| `actionSequence` | The canonical execution order |
| `expectedPostconditions` | The success criteria the executor must verify |
| `scope` | Provider, account, instance, and mount scope for execution |
| `currentObservations` | Baseline observation state for audit |

### 12.3 Executor Provides to Planner

| Artifact | Purpose |
|----------|---------|
| Fresh snapshot | Executor provides current state for postcondition re-planning |
| Re-planned plan | Executor invokes planner to verify repair achieved health |

### 12.4 Mutual Exclusion

| ID | Constraint |
|----|------------|
| **EXECUTOR-PLANNER-1** | The executor **MUST NOT** absorb the planner's responsibilities. |
| **EXECUTOR-PLANNER-2** | The planner **MUST NOT** absorb the executor's responsibilities. |
| **EXECUTOR-PLANNER-3** | The executor and planner **MUST NOT** be the same component. |
| **EXECUTOR-PLANNER-4** | The executor **MUST NOT** invoke the planner except for postcondition verification. |

---

## 13. Relationship to Binding Contract

### 13.1 Binding Contract Defines

- Valid binding states (`active`, `degraded`, `superseded`, `failed`) — see `BINDING-STATE-CONTRACT.md` §4
- Versioning rules (one-active rule, monotonicity, optimistic concurrency) — see `BINDING-STATE-CONTRACT.md` §5
- Atomicity guarantees — see `BINDING-STATE-CONTRACT.md` §6
- Failure semantics — see `BINDING-STATE-CONTRACT.md` §7
- Forbidden transitions — see `BINDING-STATE-CONTRACT.md` §4.4

### 13.2 Executor MUST Respect Binding Constraints

| ID | Constraint |
|----|------------|
| **EXECUTOR-BC-1** | The executor **MUST** respect the **one-active-binding rule**. The executor never creates bindings except through `activateBinding()`, which enforces uniqueness. |
| **EXECUTOR-BC-2** | The executor **MUST** respect **optimistic concurrency**. `expectedBindingVersion` is passed to `activateBinding()`. |
| **EXECUTOR-BC-3** | The executor **MUST** respect **terminal states**. The executor does not attempt to repair `superseded` or `failed` bindings. |
| **EXECUTOR-BC-4** | The executor **MUST** respect **version monotonicity**. New bindings have `version = MAX(version) + 1`. |
| **EXECUTOR-BC-5** | The executor **MUST** respect **atomicity**. Old binding supersession and new binding creation happen in a single transaction. |
| **EXECUTOR-BC-6** | The executor **MUST** respect **validation**. `activateBinding()` validates readiness, inventory, exposure, mapping, and visibility before INSERT. |

### 13.3 Binding State Machine Relevance

- `active` → `degraded`: Reconciler detects degradation. Planner produces plan. Executor creates transaction.
- `degraded` → `superseded`: Executor's `reconcileExactBinding()` calls `activateBinding()`, which supersedes the old binding and creates a new active binding.
- `degraded` → `failed`: Executor fails postconditions; binding remains `degraded` or is marked `failed` if no repair is possible.
- `superseded` / `failed`: Terminal. Executor does not touch these.

---

## 14. Future Contract Dependencies

### 14.1 Contracts This Document Feeds

| Dependent Contract | How This Contract Feeds It |
|--------------------|---------------------------|
| `REPAIR-TRANSACTION-CONTRACT` | Defines the `repair_transactions` row structure (`planKey`, `expectedBindingVersion`, `authorizedActions`, `status`). Defines the `planned → authorized → executing → succeeded/failed` lifecycle. Defines step auditing in `repair_steps`. |
| `RECONCILER-CONTRACT` | Defines the boundary between routine reconciliation and repair. Reconciler handles `bind`/`rebind`/`mark-degraded`; executor handles degraded → superseded/active transitions. Defines the concurrent activity boundary. |

### 14.2 Contract Dependency Graph

```
BINDING-STATE-CONTRACT
        │
        ▼
REPAIR-PLANNER-CONTRACT
        │
        ▼
REPAIR-EXECUTOR-CONTRACT (this document)
        │
        ├──▶ REPAIR-TRANSACTION-CONTRACT
        │      - Transaction row structure
        │      - Step auditing schema
        │      - Terminal state semantics
        │
        └──▶ RECONCILER-CONTRACT
               - Routine vs degraded boundary
               - Concurrent activity rules
               - mark-degraded handoff
```

### 14.3 Constraints on Future Contracts

| ID | Constraint |
|----|------------|
| **EXECUTOR-FUTURE-1** | Future contracts **MUST NOT** expand the repair action catalog without updating `REPAIR-PLANNER-CONTRACT.md` and this document. |
| **EXECUTOR-FUTURE-2** | Future contracts **MUST NOT** relax authorization requirements without updating this document. |
| **EXECUTOR-FUTURE-3** | Future contracts **MUST NOT** bypass postcondition verification. |
| **EXECUTOR-FUTURE-4** | Future contracts **MUST** preserve the executor's transactional execution model. |

---

## 15. Compliance Verification

A repair executor implementation **complies** with this contract if:

1. It consumes only authorized repair plans (§3).
2. It transitions transactions exclusively through the state machine in §4.
3. It enforces authorization rules in §5 before execution.
4. It executes steps in the canonical `actionSequence` order (§6).
5. It performs binding mutations only through `activateBinding()` (§7).
6. It invokes provider APIs only for explicitly authorized actions (§8).
7. It verifies postconditions after execution (§9).
8. It maps failures to the categories in §10.
9. It does not generate plans, interact with consumers, bypass lifecycle rules, or directly mutate tables (§11).
10. It respects the boundary with the planner (§12) and the binding contract (§13).

An implementation that violates any **MUST** constraint is non-compliant.

---

## 16. Relationship to Prior Documents

| Prior Document | Relationship |
|----------------|--------------|
| `BINDING-STATE-CONTRACT.md` | Defines binding lifecycle; this contract defines how repair transitions bindings safely |
| `REPAIR-PLANNER-CONTRACT.md` | Defines planner boundary; this contract defines the executor that consumes planner output |
| `REPAIR-RECONCILIATION-BOUNDARY-ANALYSIS.md` | Analysis of repair boundary; this contract formalizes the executor's role within it |
| `MATERIALIZATION-ARCHITECTURE.md` | Defines materialization layer; this contract defines repair execution within it |
| `CONTRACTS.md` | Upstream contract patterns; this contract follows the same MUST/MUST NOT/MAY pattern |

---

End of contract.

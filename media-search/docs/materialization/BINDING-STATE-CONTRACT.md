# Binding State Contract

**Date:** 2026-08-23
**Status:** Contract — normative constraints on binding lifecycle
**Grounded in:** `MATERIALIZATION-ARCHITECTURE.md`, `MATERIALIZATION-REGISTRY-SCHEMA.md`, `RESOLVER-DESIGN.md`, `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md`, `REPAIR-RECONCILIATION-BOUNDARY-ANALYSIS.md`, `STATE-MACHINE-REFERENCE.md`, `CONTRACTS.md`
**Cross-checked against:** `media-search/src/lib/control-plane/store.js`, `media-search/src/lib/control-plane/reconciler.js`, `media-search/src/lib/control-plane/repair-planner.js`, `media-search/src/lib/control-plane/repair-executor.js`
**Constraints:** No code; no schema changes; no implementation; contract only

---

## 1. Purpose

This document defines the **normative lifecycle contract for bindings**. It answers eight questions:

1. Who may create, activate, supersede, degrade, or fail bindings?
2. How is content identity distinguished from materialization identity?
3. What are the allowed states and their meanings?
4. What versioning rules guarantee consistency?
5. What atomicity guarantees can consumers observe?
6. What are the failure semantics?
7. What behavior is explicitly forbidden?
8. How does this contract feed future repair and reconciler contracts?

Each answer is stated as a MUST / MUST NOT / MAY constraint. Violations break the contract.

---

## 2. Ownership

### 2.1 Who May Mutate Bindings

| Action | Owner | Mechanism |
|--------|-------|-----------|
| **Create binding** | Reconciler (routine) | `planReconciliation()` → `bind` action → `store.activateBinding()` |
| **Activate binding** | Reconciler (routine) | `planReconciliation()` → `bind`/`rebind` action → `store.activateBinding()` |
| **Supersede binding** | Reconciler (routine) | `activateBinding()` sets old binding `status = 'superseded'` when new binding created |
| **Degrade binding** | Reconciler | `planReconciliation()` → `mark-degraded` action |
| **Fail binding** | Reconciler or Repair executor | `mark-degraded` then terminal failure; or repair transaction `failed` |
| **Replace binding** | Repair executor | `reconcileExactBinding()` → `slice.activateBinding()` with new placement/exposure |

**Key insight:** Binding mutation is **exclusively a control-plane responsibility**. No consumer-facing component may mutate bindings. The binding is the cut point between the read-only projection (gateway) and the write path (reconciler/repair).

### 2.2 Who May NEVER Mutate Bindings

| Actor | Constraint |
|-------|------------|
| **Media gateway** | MUST NOT create, update, or delete any binding. Gateway reads only `status = 'active'` bindings. (GW-FORBID-10) |
| **Plex adapter** | MUST NOT create, update, or delete any binding. Plex consumes `.strm` files or WebDAV paths that resolve through the gateway. |
| **Consumer adapters** (.strm, WebDAV, FUSE) | MUST NOT create, update, or delete any binding. Adapters are consumer-layer projections. |
| **Provider observers** | MUST NOT directly mutate bindings. Observers refresh `placements`, `exposures`, `provider_files`, and `inventory_snapshots`. The reconciler consumes observations and decides on binding mutations. |
| **Resolver** | MUST NOT create, update, or delete any binding. Resolver reads `bindings` for byte delivery. (GW-FORBID-10) |
| **Acquisition intent layer** | MUST NOT create, update, or delete any binding. Acquisition produces placements; reconciler produces bindings. |

**Key insight:** The binding is a **derived state** — it is the output of reconciliation and repair, never the output of observation or consumption. Observation feeds reconciliation; reconciliation produces bindings.

---

## 3. Binding Identity

### 3.1 Identity Layers

Bindings have **two distinct identity concepts** that must not be conflated:

| Concept | Fields | Nature | Lifetime |
|---------|--------|--------|----------|
| **Content identity** | `(info_hash, file_index)` | Portable, provider-agnostic, stable | Survives provider changes, survives repair |
| **Materialization identity** | `binding_id` | Provider-specific, versioned, mutable | One per binding version; new on each activation |

**Content identity** (`info_hash`, `file_index`):
- Maps to corpus identity (`candidates(info_hash, file_index_key)`)
- Stable across provider failures, mount losses, and repair cycles
- The identity the gateway receives in `GET /media/{info_hash}/{file_index}`
- Never changes for a given playable file

**Materialization identity** (`binding_id`):
- Surrogate UUID primary key for a specific binding row
- Created fresh on every `activateBinding()` call
- Represents **one specific version** of the binding
- Changes on every supersession

### 3.2 Binding Row Fields

| Field | Role | Relationship |
|-------|------|--------------|
| `binding_id` | Surrogate PK | Unique per binding version |
| `library_item_id` | FK → `library_items` | The library item this binding serves |
| `library_path_id` | FK → `library_paths` | The canonical path for this binding |
| `release_key` | `info_hash[:file_index]` | Content identity (denormalized for integrity) |
| `info_hash` | Content identity | Part of corpus FK |
| `file_index` | Content identity | Part of corpus FK |
| `file_index_key` | Content identity | `-1` when `file_index` is NULL (SQLite convention) |
| `version` | Monotonic counter | Per `library_item_id`; increments on each activation |
| `placement_id` | FK → `placements` | Which placement this binding uses |
| `provider_file_id` | FK → `provider_files` | Which provider file is bound |
| `exposure_id` | FK → `exposures` | Which filesystem exposure is bound |
| `status` | State machine | `active`, `superseded`, `degraded`, `failed` |
| `valid_from` | Timestamp | When this binding became active |
| `superseded_at` | Timestamp | When this binding was superseded (terminal state marker) |

### 3.3 Why Content Identity and Materialization Identity Are Separate

**Problem:** If `binding_id` were the canonical identity for content, then:
- Supersession would require deleting the old binding and creating a new one — breaking foreign keys
- Content would need a new identity every time the provider changed
- Repair would be indistinguishable from "new content"

**Solution:** Content identity (`info_hash`, `file_index`) is **stable**. Materialization identity (`binding_id`) is **versioned**. The binding row is a **versioned pointer** from content identity to current placement/exposure.

**Analogy:** Content identity is the book title. Materialization identity is the specific library copy (with barcode). When the library switches to a new copy (different provider), the binding_id changes but the title does not.

**Gateway implication:** Gateway queries by content identity (`info_hash`, `file_index_key`, `status = 'active'`), never by `binding_id`. The gateway does not need to know which binding version it serves — only that one is active and playable.

**Repair implication:** Repair transactions reference `expected_binding_version` — they repair **a specific version** of the binding. If the binding changes between plan and execute, the repair is rejected as stale.

---

## 4. Allowed States

### 4.1 State Machine

```
              ┌─────────────────────────────────────────────────────────────┐
              │ createBinding()                                             │
              │ activateBinding()                                           │
              │ (with supersession of prior active binding)                  │
              ▼                                                             │
       ┌──────────────┐                                                    │
       │    active    │◄───────────────────────────────────────────────────┘
       └──────┬───────┘
              │
              │ exposure stale OR placement degrades OR inventory stale
              │ (reconciler: mark-degraded)
              ▼
       ┌──────────────┐
       │   degraded   │  Binding exists but evidence is unhealthy
       └──────┬───────┘
              │
              ├── repair initiated ──▶ ┌──────────────────┐
              │                       │ repair executing  │
              │                       │ (repair_transactions)
              │                       └────────┬─────────┘
              │                                │
              │                                ├── postconditions met ──▶ new active binding
              │                                │   (old binding → superseded)
              │                                │
              │                                └── postconditions failed ──▶ failed
              │
              └── no repair possible ──▶ ┌─────────┐
                                         │ failed  │
                                         └─────────┘
```

### 4.2 State Definitions

#### `active`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Current playable binding with fresh exposure, ready placement, authoritative complete inventory |
| **Entry conditions** | `activateBinding()` succeeds; placement is `ready` or has fresh `readiness_observations`; exposure is `visible` and `read_only = 1`; inventory snapshot is authoritative, complete, and fresh; exposure freshness is bounded and not stale |
| **Exit conditions** | Exposure expires (`expires_at <= now`); placement degrades; inventory stale; binding superseded by newer version; binding degraded by reconciler |
| **Gateway behavior** | Serve bytes (200/206) if exposure is `visible` and `relative_path` is valid. Return 423 if exposure not visible, 503 if exposure stale, 502 if mount unreachable |
| **Repair behavior** | No repair triggered while active. Repair triggers only after `mark-degraded` |

#### `degraded`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Binding exists but evidence is unhealthy (exposure stale/missing, placement not ready, inventory stale, or binding state changed) |
| **Entry conditions** | Reconciler emits `mark-degraded` action; OR repair planner detects triggers and binding was active |
| **Exit conditions** | Repair succeeds → new active binding (old becomes superseded); Repair fails → failed; No repair possible → failed |
| **Gateway behavior** | Return 503 (degraded binding) or 423 (non-visible exposure). MUST NOT serve bytes. |
| **Repair behavior** | Repair planner correlates triggers, produces repair plan. Repair executor creates `repair_transactions` row, authorizes actions, executes steps, verifies postconditions |

#### `superseded`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Replaced by a newer binding version. Terminal state — no return possible. |
| **Entry conditions** | `activateBinding()` creates a new binding for same `library_item_id`; old binding `status` set to `superseded`, `superseded_at = now()` |
| **Exit conditions** | None. Superseded is terminal. |
| **Gateway behavior** | Gateway queries `status = 'active'` only. Superseded bindings are invisible to the gateway. If queried by old identity, returns 410 (no longer active). |
| **Repair behavior** | Superseded bindings are not repaired. They are historical records. |

#### `failed`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Permanently failed — no usable placement, no repair possible, or repair exhausted |
| **Entry conditions** | Repair transaction fails postconditions; no alternate placement exists; auth error prevents re-observation |
| **Exit conditions** | None. Failed is terminal. New placement creates new binding (different version chain). |
| **Gateway behavior** | Return 410 Gone. Identity was previously known but no active binding remains. |
| **Repair behavior** | No further repair attempts on failed binding. New placement required to create a new binding. |

### 4.3 Allowed Transitions

| From | To | Trigger | Owner |
|------|----|---------|-------|
| *(none)* | `active` | `activateBinding()` with valid placement, exposure, mapping | Reconciler / Repair executor |
| `active` | `degraded` | `mark-degraded` action from reconciler | Reconciler |
| `active` | `superseded` | `activateBinding()` creates new binding for same `library_item_id` | Reconciler / Repair executor |
| `degraded` | `superseded` | Repair succeeds → new binding created (old becomes superseded) | Repair executor |
| `degraded` | `failed` | No repair possible, or repair exhausted, or auth error | Reconciler / Repair executor |
| `superseded` | *(none)* | Terminal | — |
| `failed` | *(none)* | Terminal | — |

### 4.4 Forbidden Transitions

| From | To | Why Forbidden |
|------|----|---------------|
| `active` | `failed` | Must go through `degraded` first (unless permanent auth error during initial binding) |
| `degraded` | `active` | Must go through repair → new binding version (not same version) |
| `superseded` | `active` | Superseded is terminal; new binding is a different version with new `binding_id` |
| `failed` | `active` | Failed is terminal; new placement creates new binding |
| `failed` | `degraded` | Failed is terminal; no regression |
| `active` | `superseded` (directly) | Supersession only happens when new binding is created |
| Any state | `active` (same `binding_id`) | A binding row, once superseded or failed, is never reactivated |

---

## 5. Versioning Rules

### 5.1 One Active Binding Rule

**Constraint (BINDING-VERSION-1):** For each `library_item_id`, at most ONE binding row may have `status = 'active'` at any time.

**Enforcement:** Partial unique index `idx_bindings_one_active` on `bindings(library_item_id) WHERE status = 'active'`.

**Implication:** The gateway query `SELECT * FROM bindings WHERE info_hash = ? AND file_index_key = ? AND status = 'active' LIMIT 1` always returns zero or one row. No ambiguity.

### 5.2 Version Monotonicity

**Constraint (BINDING-VERSION-2):** Within a `library_item_id`, `version` MUST monotonically increase. Each new binding version = `MAX(version) + 1`.

**Enforcement:** `activateBinding()` computes `version = (SELECT COALESCE(MAX(version), 0) FROM bindings WHERE library_item_id = ?) + 1`.

**Implication:** Versions form a strictly increasing sequence: 1, 2, 3, ... No gaps, no duplicates, no reuse.

### 5.3 Optimistic Concurrency

**Constraint (BINDING-VERSION-3):** `activateBinding()` MUST validate `expectedBindingVersion` against the current active binding's version before superseding or creating.

**Enforcement:**
```javascript
if (input.expectedBindingVersion != null
    && input.expectedBindingVersion !== (active?.version ?? 0)) {
  throw new Error('Active binding version changed during reconciliation');
}
```

**Implication:** If the binding changes between plan and execute, the mutation is rejected. This prevents stale repairs from superseding current bindings.

### 5.4 Supersession Semantics

**Constraint (BINDING-VERSION-4):** When a new binding is created for a `library_item_id` that already has an active binding:
1. Old binding `status` MUST be set to `superseded`
2. Old binding `superseded_at` MUST be set to current timestamp
3. New binding `version` MUST be old version + 1
4. Both operations MUST be in a single transaction

**Enforcement:** `activateBinding()` runs in `transaction()` — UPDATE old binding, then INSERT new binding.

**Implication:** A consumer may observe the old active binding or the new active binding, but never a state where neither is active, nor a state where both are active. The transition is atomic at the database level.

### 5.5 Repair Transaction Binding Reference

**Constraint (BINDING-VERSION-5):** Repair transactions MUST reference `expected_binding_version` — the binding version the plan was computed against.

**Enforcement:** `createRepairTransaction()` validates that the current active binding's version matches `expected_binding_version`. `execute()` passes `expectedBindingVersion` to `reconcileExactBinding()` → `activateBinding()`.

**Implication:** If the binding is repaired by a concurrent reconciler between plan and execute, the repair transaction fails because `expectedBindingVersion` no longer matches. No silent corruption.

---

## 6. Atomicity Guarantees

### 6.1 What Consumers May Observe

**Allowed observations:**

| Scenario | Consumer Sees | Meaning |
|----------|---------------|---------|
| Old active binding | 200/206 from gateway | Repair not yet started |
| New active binding (after repair) | 200/206 from gateway | Repair succeeded; new binding serves bytes |
| No active binding (degraded) | 503 from gateway | Repair in progress or pending |
| No active binding (superseded/failed) | 410 from gateway | No playable binding exists |

**Key insight:** Consumers observe a **single active binding** at any time — either the old one or the new one, never both, never neither.

### 6.2 What Consumers Must NEVER Observe

**Forbidden observations:**

| Forbidden | Why | Contract |
|-----------|-----|----------|
| **Partial binding** (binding row partially written) | `activateBinding()` is atomic; the INSERT either completes or rolls back | BINDING-ATOMIC-1 |
| **Active binding with missing exposure** | `activateBinding()` validates `exposure.state = 'visible'` before INSERT | BINDING-ATOMIC-2 |
| **Active binding with invalid `provider_file_id`** | `activateBinding()` validates `requireProviderFile(placementId, providerFileId)` before INSERT | BINDING-ATOMIC-3 |
| **Active binding with stale exposure** | `activateBinding()` validates `exposure.expires_at > now` before INSERT | BINDING-ATOMIC-4 |
| **Active binding with stale inventory** | `activateBinding()` validates `inventorySnapshot.expires_at > now` AND `file.inventoryExpiresAt > now` before INSERT | BINDING-ATOMIC-5 |
| **Two active bindings for same `library_item_id`** | Partial unique index `idx_bindings_one_active` prevents this | BINDING-ATOMIC-6 |
| **Active binding without authoritative mapping** | `activateBinding()` validates `mapping.state = 'mapped' AND authoritative = 1` before INSERT | BINDING-ATOMIC-7 |
| **Active binding without `read_only` exposure** | `activateBinding()` validates `exposure.read_only === 1` before INSERT | BINDING-ATOMIC-8 |

### 6.3 Atomicity at the Gateway

**Constraint (BINDING-ATOMIC-9):** The gateway MUST NOT observe a binding in an intermediate state. The gateway reads committed rows only.

**Enforcement:** Gateway reads from the same SQLite store. SQLite transactions are atomic. The gateway's `SELECT ... WHERE status = 'active'` sees only committed `active` rows.

**Implication:** No dirty reads. No "active binding with NULL exposure_id" or "active binding with invalid placement_id" — these are validated by `activateBinding()` before INSERT.

---

## 7. Failure Semantics

### 7.1 Provider Loss

**Symptom:** Provider API reports torrent deleted, content no longer available.

**Detection:** `observePlacement()` finds placement state = `error` or `removed`. `observeReadiness()` finds readiness not `ready`.

**Binding transition:** Reconciler emits `mark-degraded` → binding `status = 'degraded'`.

**Repair behavior:**
1. Trigger: `broken-provider-observation` or `missing-provider-placement`
2. Permitted actions: `REOBSERVE_PROVIDER`, `REPLACE_PLACEMENT_OBSERVATION`, `REQUEST_PROVIDER_REPAIR`, `RECONCILE_BINDING`
3. If provider confirms deletion: no usable placement → binding `status = 'failed'`
4. If alternate provider exists: `reconcileExactBinding()` → new binding (old superseded)
5. If no alternate: binding `status = 'failed'`

**Gateway behavior:** Returns 503 during degraded, 410 after failed.

### 7.2 Mount Loss

**Symptom:** Filesystem mount unreachable (ENOENT, EIO on read).

**Detection:** Observation layer cannot read `exposure.relative_path` → `exposure.state = 'error'`.

**Binding transition:** Reconciler emits `mark-degraded` (exposure stale/missing).

**Repair behavior:**
1. Trigger: `missing-filesystem-exposure` (exposure.state = 'error')
2. Permitted actions: `REOBSERVE_FILESYSTEM_EXPOSURE` only
3. Repair planner conservatively avoids provider mutations for a mount miss
4. If mount returns: new observation → exposure visible → reconcile binding
5. If mount permanently gone: binding degraded → failed, exposure must be re-created from new placement

**Gateway behavior:** Returns 502 (filesystem read error) or 423 (non-visible exposure).

### 7.3 Repair Race

**Symptom:** Two repair transactions attempt to repair the same binding version concurrently.

**Detection:** `expectedBindingVersion` mismatch in `activateBinding()`.

**Enforcement:** Optimistic concurrency in `activateBinding()` — if `active.version !== expectedBindingVersion`, throw.

**Outcome:**
- First repair to execute: succeeds, creates new binding version
- Second repair to execute: fails with "Active binding version changed during reconciliation"
- Second repair transaction: `status = 'failed'`, `failure_category = 'repair-version-conflict'`

**Key insight:** Repair transactions are **serialized by binding version**. Only one repair can succeed per version. Concurrent repairs are rejected, not merged.

### 7.4 Stale Repair Plan

**Symptom:** Repair plan was computed against binding version N, but binding is now version N+1 (reconciler superseded it).

**Detection:** `createRepairTransaction()` validates current binding version matches `expected_binding_version`.

**Enforcement:**
```javascript
if (!binding || binding.version !== input.expected_binding_version
    || binding.id !== input.plan.binding.id
    || binding.placement_id !== input.plan.binding.placementId
    || binding.provider_file_id !== input.plan.binding.providerFileId
    || binding.exposure_id !== input.plan.binding.exposure_id) {
  throw new Error('Repair plan binding version is no longer current');
}
```

**Outcome:** Repair transaction rejected at creation time. No repair executed. The reconciler's supersession "wins" — the binding is already healthy.

### 7.5 Concurrent Reconciler Activity

**Symptom:** Reconciler runs `planReconciliation()` → `bind`/`rebind` while repair executor is executing.

**Detection:** Optimistic concurrency in `activateBinding()`.

**Outcome:**
- If reconciler runs first: binding version increments, repair executor's `expectedBindingVersion` is stale → repair fails
- If repair runs first: binding version increments, reconciler's `expectedBindingVersion` is stale → reconciler's `bind` fails (but reconciler is idempotent; next run will succeed with fresh state)

**Key insight:** The reconciler is **authoritative for routine state**. Repair is **authoritative for degraded/failed state**. Both are serialized by the same optimistic concurrency mechanism. The one that executes first wins; the other retries against fresh state.

---

## 8. Forbidden Behavior

### 8.1 Gateway

| ID | Constraint |
|----|------------|
| **BINDING-FORBID-1** | The media gateway **MUST NOT** create, update, or delete any binding row. (GW-FORBID-10) |
| **BINDING-FORBID-2** | The media gateway **MUST NOT** read binding rows where `status != 'active'`. The gateway serves only active bindings. |
| **BINDING-FORBID-3** | The media gateway **MUST NOT** infer binding state from observations. The binding is the projection of observation state — the gateway reads the binding, not the observations. |
| **BINDING-FORBID-4** | The media gateway **MUST NOT** trigger repair. Repair is owned by the repair control plane. (GW-FORBID-9) |

### 8.2 Playback / Consumers

| ID | Constraint |
|----|------------|
| **BINDING-FORBID-5** | Playback success/failure **MUST NOT** trigger binding creation. Bindings are created by the reconciler, not by consumer requests. |
| **BINDING-FORBID-6** | Playback errors **MUST NOT** degrade bindings. Binding degradation is the reconciler's decision based on observation freshness, not consumer-facing errors. |
| **BINDING-FORBID-7** | Consumer adapters (Plex, `.strm`, WebDAV, FUSE) **MUST NOT** create or modify bindings. Adapters consume the gateway's HTTP endpoint. |

### 8.3 Provider Observers

| ID | Constraint |
|----|------------|
| **BINDING-FORBID-8** | Provider observers **MUST NOT** directly mutate bindings. Observers refresh `placements`, `exposures`, `provider_files`, and `inventory_snapshots`. The reconciler consumes observations and decides on binding mutations. |
| **BINDING-FORBID-9** | Observers **MUST NOT** set `bindings.status`. Only the reconciler and repair executor set binding status. |
| **BINDING-FORBID-10** | Observers **MUST NOT** create binding rows. Only `activateBinding()` creates bindings. |

### 8.4 Historical Data

| ID | Constraint |
|----|------------|
| **BINDING-FORBID-11** | Historical bindings (superseded, failed) **MUST NOT** be deleted. They are an audit trail for repair history and lifecycle analysis. |
| **BINDING-FORBID-12** | Historical bindings **MUST NOT** be reactivated. Once superseded or failed, a binding row is terminal. New versions require new rows. |
| **BINDING-FORBID-13** | `version` values **MUST NOT** be reused within a `library_item_id`. Each new binding gets a strictly higher version. |

### 8.5 Direct Mutation

| ID | Constraint |
|----|------------|
| **BINDING-FORBID-14** | Binding rows **MUST NOT** be created or modified outside `store.activateBinding()`, `store.createRepairTransaction()` (which references but does not create bindings), and the reconciler's `mark-degraded` action. All binding mutations MUST go through validated store functions. |
| **BINDING-FORBID-15** | Raw SQL INSERT/UPDATE on `bindings` **MUST NOT** be performed by any code path other than the store module. |

---

## 9. Future Contract Relationship

### 9.1 REPAIR-PLANNER-CONTRACT

This binding state contract feeds the repair planner contract by:

1. **Defining the degraded trigger:** The repair planner detects `canonical-binding-degraded` when `facts.binding.state !== 'active'`. This contract defines what `active`, `degraded`, `superseded`, and `failed` mean.
2. **Defining the plan key binding:** The repair planner's `planKey` includes `bindingVersion` — the version of the binding the plan was computed against. This contract defines version monotonicity and the one-active-binding rule.
3. **Defining expected postconditions:** The repair planner's `expectedPostconditions` include `binding.status === 'active'` with fresh exposure. This contract defines what "healthy" means for a binding.
4. **Defining stale plan rejection:** If the binding version changes between plan and execute, the plan is stale. This contract defines how version changes happen (supersession, repair).

### 9.2 REPAIR-EXECUTOR-CONTRACT

This binding state contract feeds the repair executor contract by:

1. **Defining supersession semantics:** The repair executor's `reconcileExactBinding()` calls `activateBinding()` with `expectedBindingVersion`. This contract defines how supersession works (old binding superseded, new binding created, atomic transaction).
2. **Defining postcondition verification:** The repair executor's `assertPostconditions()` re-plans and confirms `plan.status === 'healthy'`. This contract defines what "healthy" means (active binding, fresh exposure, authoritative mapping).
3. **Defining failure categories:** Repair transaction `failure_category` values (`no-usable-placement`, `repair-version-conflict`, `repair-postcondition-failed`) are grounded in this contract's state transitions.
4. **Defining the one-active-binding rule:** The repair executor must never create a second active binding. This contract's partial unique index enforces this.

### 9.3 RECONCILER-CONTRACT

This binding state contract feeds the reconciler contract by:

1. **Defining binding actions:** The reconciler's `planReconciliation()` returns `bind`, `rebind`, and `mark-degraded` actions. This contract defines when each action is appropriate and what state transitions result.
2. **Defining the binding satisfies check:** The reconciler's `bindingSatisfies(binding, desired)` checks `binding.status === 'active'`, same `libraryItemId`, `libraryPathId`, `releaseKey`. This contract defines what "satisfies" means.
3. **Defining supersession triggers:** The reconciler's `rebind` action is emitted when `preferred-usable-placement-changed`. This contract defines how supersession happens (version increment, old binding superseded).
4. **Defining `expectedBindingVersion`:** The reconciler passes `currentBinding?.version ?? 0` as `expectedBindingVersion`. This contract defines how optimistic concurrency prevents stale mutations.

### 9.4 Contract Dependency Graph

```
BINDING-STATE-CONTRACT (this document)
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
        └──▶ RECONCILER-CONTRACT
               - Binding actions (bind/rebind/mark-degraded)
               - Satisfies check
               - Optimistic concurrency
```

---

## 10. Compliance Verification

A binding implementation **complies** with this contract if:

1. It creates bindings only through `store.activateBinding()` (or equivalent validated function).
2. It never creates a binding without validating exposure state (`visible`, `read_only`, fresh), placement readiness, inventory freshness, and authoritative mapping.
3. It enforces one active binding per `library_item_id` via partial unique index.
4. It increments `version` monotonically within each `library_item_id`.
5. It validates `expectedBindingVersion` before every supersession.
6. It never exposes partial or stale bindings to the gateway.
7. It never deletes historical (superseded/failed) bindings.
8. It never mutates bindings from the gateway, consumer adapters, or provider observers.
9. It produces only the state transitions listed in §4.3.
10. It forbids all behavior listed in §8.

An implementation that violates any **MUST** constraint is non-compliant.

---

## 11. Relationship to Prior Documents

| Prior Document | Relationship |
|----------------|--------------|
| `MATERIALIZATION-ARCHITECTURE.md` | Defines materialization layer; this contract defines the binding state machine within it |
| `MATERIALIZATION-REGISTRY-SCHEMA.md` | Defines binding schema; this contract adds normative lifecycle constraints |
| `RESOLVER-DESIGN.md` | Defines resolver behavior; this contract defines the binding state the resolver reads |
| `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md` | Defines gateway read-only boundary; this contract defines what the gateway reads (active bindings only) |
| `REPAIR-RECONCILIATION-BOUNDARY-ANALYSIS.md` | Analysis of repair boundary; this contract formalizes the binding state machine that repair operates on |
| `STATE-MACHINE-REFERENCE.md` | Defines state machines; this contract refines the binding state machine with normative constraints |
| `CONTRACTS.md` | Upstream contract patterns; this contract follows the same MUST/MUST NOT/MAY pattern |

---

**End of contract.**

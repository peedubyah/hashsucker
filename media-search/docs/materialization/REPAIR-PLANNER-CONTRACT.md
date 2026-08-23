# Repair Planner Contract

**Date:** 2026-08-23
**Status:** Contract — normative constraints on repair planning
**Grounded in:** `BINDING-STATE-CONTRACT.md`, `REPAIR-RECONCILIATION-BOUNDARY-ANALYSIS.md`, `MATERIALIZATION-ARCHITECTURE.md`, `RESOLVER-DESIGN.md`, `CONTRACTS.md`
**Cross-checked against:** `media-search/src/lib/control-plane/repair-planner.js`, `media-search/src/lib/control-plane/repair-executor.js`, `media-search/src/lib/control-plane/store.js`, `media-search/src/lib/control-plane/reconciler.js`
**Constraints:** No code; no schema; no implementation; contract only

---

## 1. Purpose

This document defines the **normative contract for the repair planner**. It answers seven questions:

1. What is the planner's role in the materialization architecture?
2. Who owns trigger interpretation, plan generation, permitted action selection, and postcondition declaration?
3. What inputs may the planner consume?
4. What determinism requirements must the planner satisfy?
5. What triggers produce which permitted repair actions?
6. What is the planner's output contract?
7. What is the planner forbidden from doing?

Each answer is stated as a MUST / MUST NOT / MAY constraint. Violations break the contract.

### 1.1 Architectural Position

The repair planner sits between observation/reconciliation and repair execution:

```
observations + binding state + lifecycle
              |
              v
        repair planner
              |
              v
        repair plan
              |
              v
        repair executor
```

The planner converts **evidence** into **authorized repair intent**. It does **not execute repairs**. The planner's sole consumer is the repair executor, which materializes the plan safely.

**Key insight:** The planner is the **authorization boundary** for repair. The executor may only perform actions the planner has declared permitted. The planner may permit actions but cannot execute them.

---

## 2. Ownership

### 2.1 Planner Ownership

| ID | Constraint |
|----|------------|
| **PLANNER-OWN-1** | The repair planner **MUST** own **trigger interpretation** — converting observation signals into categorized repair triggers. |
| **PLANNER-OWN-2** | The repair planner **MUST** own **plan generation** — producing a deterministic repair plan from a snapshot, lifecycle state, and scope. |
| **PLANNER-OWN-3** | The repair planner **MUST** own **plan identity** — the `planKey` MUST be a deterministic function of the input fingerprint. |
| **PLANNER-OWN-4** | The repair planner **MUST** own **permitted action selection** — mapping triggers to a set of authorized repair actions. |
| **PLANNER-OWN-5** | The repair planner **MUST** own **postcondition declaration** — the `expectedPostconditions` define what success means for a given repair. |
| **PLANNER-OWN-6** | The repair planner **MUST** own **scope projection** — the planner resolves the effective provider, account, instance, and mount scope from the snapshot and lifecycle. |
| **PLANNER-OWN-7** | The repair planner **MUST** own **action ordering** — the `actionSequence` defines the canonical execution order for permitted actions. |

### 2.2 Planner Does NOT Own

| Aspect | Actual Owner | Mechanism |
|--------|--------------|-----------|
| Executing repair actions | Repair executor | `executeAction()` runs authorized steps |
| Provider mutations | Repair executor (via slice) | `observePlacement()`, `selectKnownFiles()`, `requestRepair()` |
| Database writes | Store / Repair executor | `createRepairTransaction()`, `startRepairStep()` |
| Filesystem changes | Repair executor (via slice) | `observeExposure()` reads filesystem; no planner involvement |
| Binding mutations | Repair executor (via slice) | `reconcileExactBinding()` calls `activateBinding()` |
| Lifecycle event creation | Control plane / Store | `recordLifecycleEvent()` appends to `lifecycle_events` |
| Postcondition verification | Repair executor | `assertPostconditions()` re-plans and confirms health |
| Transaction lifecycle | Repair executor | `persistPlan()` → `authorize()` → `execute()` |

**Key insight:** The planner is a **pure function** of its inputs. It produces intent, not side effects. All mutations are the executor's responsibility.

---

## 3. Planner Input Contract

### 3.1 Allowed Inputs

The repair planner consumes three inputs:

| Input | Type | Purpose |
|-------|------|---------|
| **snapshot** | Read-only observation state | Current state of placements, readiness, inventory, mappings, exposures, Zurg metadata, and bindings |
| **lifecycle** | Read-only lifecycle state | Current lifecycle projection for the library item |
| **scope** | Read-only scope definition | Provider, account, instance, and mount scope constraints |
| **now** | Timestamp (integer) | Explicit evaluation time for freshness calculations |

### 3.2 Input Semantics

**Snapshot** MUST contain:

- `placements` — all known provider placements for the identity
- `readinessObservations` — provider readiness observations
- `providerFiles` — observed provider files per placement
- `inventorySnapshots` — inventory freshness metadata per placement
- `mappings` — candidate file mappings (authoritative and non-authoritative)
- `exposures` — filesystem exposure observations
- `zurgMetadata` — Zurg metadata observation state
- `currentBinding` — the currently active binding (if any)
- `desired` — the desired identity and library path
- `placementObservations` — placement lookup observations

**Lifecycle** MUST contain:

- Projected lifecycle state (`projectRdZurgLifecycle`)
- Facts derived from snapshot (placement, readiness, inventory, exposure, Zurg metadata, binding, catalog, playback)

**Scope** MUST contain:

- `provider` — provider name (e.g., `real-debrid`)
- `accountScope` — account scope identifier
- `instanceScope` — instance scope identifier
- `mountScope` — mount scope identifier

### 3.3 Input Constraints

| ID | Constraint |
|----|------------|
| **PLANNER-INPUT-1** | The planner **MUST NOT** create any evidence. It consumes evidence produced by the observation layer and reconciler. |
| **PLANNER-INPUT-2** | The planner **MUST NOT** mutate any input. All inputs are read-only. |
| **PLANNER-INPUT-3** | The planner **MUST NOT** access the database directly. All state arrives via the snapshot. |
| **PLANNER-INPUT-4** | The planner **MUST NOT** access provider APIs. All provider state arrives via observations. |
| **PLANNER-INPUT-5** | The planner **MUST** treat `now` as the sole source of time. No internal `Date.now()` calls except for explicit freshness evaluation. |
| **PLANNER-INPUT-6** | The planner **MUST** reject inputs with missing snapshot, lifecycle, or scope. (`throw new TypeError('Repair planning requires snapshot, lifecycle, and explicit scope')`) |

---

## 4. Determinism Requirements

### 4.1 Deterministic Outputs

| ID | Constraint |
|----|------------|
| **PLANNER-DETERM-1** | Given identical **snapshot**, **lifecycle**, **scope**, and **now**, the planner **MUST** produce the same `planKey`. |
| **PLANNER-DETERM-2** | Given identical inputs, the planner **MUST** produce the same **trigger classification** (same categories, same ordering). |
| **PLANNER-DETERM-3** | Given identical inputs, the planner **MUST** produce the same **permitted action list** (same set, same canonical order). |
| **PLANNER-DETERM-4** | Given identical inputs, the planner **MUST** produce the same **expected postconditions**. |
| **PLANNER-DETERM-5** | Given identical inputs, the planner **MUST** produce the same **fingerprint digest** (`sha256` of stable-canonical input encoding). |
| **PLANNER-DETERM-6** | The planner **MUST** produce the same output regardless of when evaluation occurs (wall-clock time is irrelevant except via `now`). |

### 4.2 Forbidden Dependencies

| ID | Constraint |
|----|------------|
| **PLANNER-DETERM-7** | The planner **MUST NOT** depend on `Math.random()` or any non-deterministic value. |
| **PLANNER-DETERM-8** | The planner **MUST NOT** depend on system clock except via the explicit `now` parameter. |
| **PLANNER-DETERM-9** | The planner **MUST NOT** depend on provider API responses. |
| **PLANNER-DETERM-10** | The planner **MUST NOT** depend on filesystem state. |
| **PLANNER-DETERM-11** | The planner **MUST NOT** depend on external side effects (network, I/O, environment variables). |
| **PLANNER-DETERM-12** | The planner **MUST NOT** depend on insertion order of input arrays. The planner MUST sort inputs deterministically before processing. |

### 4.3 Implementation Mechanism

Determinism is achieved by:

1. **Stable canonical encoding** — `stableStringify()` sorts all object keys recursively before hashing.
2. **Deterministic trigger ordering** — triggers are sorted by `category` before output.
3. **Deterministic action ordering** — `orderedActions()` filters a fixed canonical order.
4. **Content-addressed plan key** — `planKey = "repair:{releaseKey}:{sha256(fingerprint)}"`.

**Implication:** Re-planning with identical inputs produces the same `planKey`. This enables:
- **Replay detection** — duplicate plans are rejected by `UNIQUE(plan_key, expected_binding_version)`.
- **Auditability** — plan identity is a function of evidence, not time.
- **Stale plan rejection** — if the binding changes, the fingerprint changes, and the plan key changes.

---

## 5. Repair Trigger Contract

### 5.1 Trigger/Action Matrix

Each trigger maps to a set of permitted actions. The planner MUST use this matrix exclusively.

| Trigger | Meaning | Evidence Required | Allowed Actions | Forbidden Actions |
|---------|---------|-------------------|-----------------|-------------------|
| `missing-provider-placement` | Provider placement no longer exists | `facts.placement.state === 'missing'` | `REOBSERVE_PROVIDER`, `REPLACE_PLACEMENT_OBSERVATION`, `REQUEST_PROVIDER_REPAIR`, `RECONCILE_BINDING` | `REOBSERVE_FILESYSTEM_EXPOSURE`, `REOBSERVE_ZURG_METADATA`, `RESELECT_KNOWN_FILES` |
| `broken-provider-observation` | Placement exists but provider reports unhealthy state | `facts.placement.state !== 'present'` OR `facts.readiness.state !== 'ready'` | `REOBSERVE_PROVIDER`, `REPLACE_PLACEMENT_OBSERVATION`, `REQUEST_PROVIDER_REPAIR`, `RECONCILE_BINDING` | `REOBSERVE_FILESYSTEM_EXPOSURE`, `REOBSERVE_ZURG_METADATA`, `RESELECT_KNOWN_FILES` |
| `provider-inventory-degraded` | Bound file missing or inventory not authoritative/complete/fresh | `!boundFile` OR `!boundInventoryIsHealthy` | `REOBSERVE_PROVIDER`, `RECONCILE_BINDING` | `REOBSERVE_FILESYSTEM_EXPOSURE`, `REOBSERVE_ZURG_METADATA`, `REPLACE_PLACEMENT_OBSERVATION`, `RESELECT_KNOWN_FILES`, `REQUEST_PROVIDER_REPAIR` |
| `known-file-selection-lost` | Bound file exists but is no longer selected | `boundFile.selected === false` | `RESELECT_KNOWN_FILES`, `REOBSERVE_PROVIDER`, `RECONCILE_BINDING` (if other triggers also present) | `REOBSERVE_FILESYSTEM_EXPOSURE`, `REOBSERVE_ZURG_METADATA`, `REQUEST_PROVIDER_REPAIR`, `REPLACE_PLACEMENT_OBSERVATION` |
| `exact-file-mapping-degraded` | Authoritative mapping not present for bound file | `boundMapping.state !== 'mapped'` OR `boundMapping.authoritative !== true` | `RECONCILE_BINDING` | `REOBSERVE_FILESYSTEM_EXPOSURE`, `REOBSERVE_ZURG_METADATA`, `REQUEST_PROVIDER_REPAIR`, `REPLACE_PLACEMENT_OBSERVATION`, `RESELECT_KNOWN_FILES` |
| `missing-filesystem-exposure` | Exposure not visible, not read-only, or expired | `boundExposure.state !== 'visible'` OR `boundExposure.readOnly !== true` OR `boundExposure.expiresAt <= now` | `REOBSERVE_FILESYSTEM_EXPOSURE` | `REOBSERVE_PROVIDER`, `REPLACE_PLACEMENT_OBSERVATION`, `REQUEST_PROVIDER_REPAIR`, `RESELECT_KNOWN_FILES`, `REOBSERVE_ZURG_METADATA` |
| `stale-zurg-metadata-state` | Zurg metadata missing, stale, or broken | `facts.zurgMetadata.state !== 'present'` OR `zurgIsStale` OR `zurgIsBroken` | `REOBSERVE_ZURG_METADATA` | `REOBSERVE_FILESYSTEM_EXPOSURE`, `REOBSERVE_PROVIDER`, `REQUEST_PROVIDER_REPAIR`, `REPLACE_PLACEMENT_OBSERVATION`, `RESELECT_KNOWN_FILES` |
| `canonical-binding-degraded` | Active binding no longer exists or state is not `active` | `facts.binding.state !== 'active'` | `RECONCILE_BINDING` (plus any provider-side triggers above) | — |

### 5.2 Trigger Constraints

| ID | Constraint |
|----|------------|
| **PLANNER-TRIGGER-1** | The planner **MUST** classify triggers exclusively from the categories defined in §5.1. |
| **PLANNER-TRIGGER-2** | The planner **MUST** emit triggers in **sorted category order** (alphabetical). |
| **PLANNER-TRIGGER-3** | The planner **MUST NOT** emit triggers for conditions not listed in §5.1. |
| **PLANNER-TRIGGER-4** | The planner **MUST** require all evidence conditions for a trigger. Partial matches do not produce the trigger. |
| **PLANNER-TRIGGER-5** | The planner **MUST** evaluate triggers against the **bound** placement/provider-file/exposure, not arbitrary observations. |
| **PLANNER-TRIGGER-6** | The planner **MUST** evaluate `missing-filesystem-exposure` conservatively — a mount miss does not imply provider loss. Only `REOBSERVE_FILESYSTEM_EXPOSURE` is permitted for a pure exposure miss. |

### 5.3 Trigger-to-Action Mapping Rules

The planner MUST apply these rules when computing permitted actions:

1. **Provider-side triggers** (`missing-provider-placement`, `broken-provider-observation`) permit provider re-observation, placement replacement, and provider repair request.
2. **Inventory trigger** (`provider-inventory-degraded`) permits provider re-observation only — not placement replacement or provider repair.
3. **File selection trigger** (`known-file-selection-lost`) permits file selection only if the known file still exists in the snapshot inventory.
4. **Exposure trigger** (`missing-filesystem-exposure`) permits **only** filesystem exposure re-observation — never provider mutations for a mount miss.
5. **Zurg trigger** (`stale-zurg-metadata-state`) permits **only** Zurg metadata re-observation.
6. **Reconciliation action** (`RECONCILE_BINDING`) is permitted whenever any provider-side, inventory, mapping, or binding trigger is present.

---

## 6. Permitted Repair Actions

### 6.1 Action Catalog

The planner recognizes exactly these seven repair actions:

| Action | Meaning |
|--------|---------|
| `REOBSERVE_PROVIDER` | Re-observe provider placement, readiness, and inventory state. Replaces stale observation evidence with fresh evidence. |
| `REPLACE_PLACEMENT_OBSERVATION` | Replace the provider placement observation record. Used when the placement identity has changed or the observation is fundamentally invalid. |
| `RESELECT_KNOWN_FILES` | Re-select known provider files in the placement. Used when file selection was lost but the provider resource still exists. |
| `REQUEST_PROVIDER_REPAIR` | Request the provider to repair the resource (e.g., re-download a torrent). Used when provider-side state is broken but the resource identity is still valid. |
| `REOBSERVE_ZURG_METADATA` | Re-observe Zurg metadata state. Used when Zurg reports stale or broken torrent state. |
| `REOBSERVE_FILESYSTEM_EXPOSURE` | Re-observe filesystem exposure. Used when exposure is missing, not visible, not read-only, or expired. |
| `RECONCILE_BINDING` | Create a new binding version if a valid replacement materialization exists. Used when the binding is degraded and a replacement is available. |

### 6.2 Action Semantics

#### `REOBSERVE_PROVIDER`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Refresh provider placement, readiness, and inventory observations |
| **Allows executor to** | Call `slice.observePlacement()`, `slice.observeReadiness()`, `slice.observeInventory()` |
| **Does NOT imply** | Provider resource is gone; binding is degraded; placement should be replaced |

#### `REPLACE_PLACEMENT_OBSERVATION`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Replace the provider placement observation record |
| **Allows executor to** | Call `slice.observePlacement()` and replace the existing observation |
| **Does NOT imply** | Provider resource is gone; binding is degraded; inventory is stale |

#### `RESELECT_KNOWN_FILES`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Re-select known provider files in the placement |
| **Allows executor to** | Call `realDebrid.require(FILE_SELECTION).selectKnownFiles()` |
| **Does NOT imply** | Provider resource is gone; inventory is stale; binding is degraded |

#### `REQUEST_PROVIDER_REPAIR`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Request provider to repair the resource |
| **Allows executor to** | Call `realDebrid.require(REPAIR_REQUEST).requestRepair()` |
| **Does NOT imply** | Provider resource is gone; binding is degraded; placement should be replaced |

#### `REOBSERVE_ZURG_METADATA`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Re-observe Zurg metadata state |
| **Allows executor to** | Call `slice.observeZurgMetadata()` |
| **Does NOT imply** | Filesystem exposure is missing; provider resource is gone |

#### `REOBSERVE_FILESYSTEM_EXPOSURE`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Re-observe filesystem exposure |
| **Allows executor to** | Call `slice.observeExposure()` |
| **Does NOT imply** | Provider resource is gone; provider state is broken |

#### `RECONCILE_BINDING`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Create a new binding version if a valid replacement materialization exists |
| **Allows executor to** | Call `reconcileExactBinding()` → `slice.activateBinding()` |
| **Does NOT imply** | Planner has selected a provider; planner has executed replacement; replacement will succeed |

### 6.3 Action Constraints

| ID | Constraint |
|----|------------|
| **PLANNER-ACTION-1** | The planner **MUST NOT** define actions beyond the seven listed in §6.1. |
| **PLANNER-ACTION-2** | The planner **MUST** compute permitted actions exclusively via the trigger/action matrix in §5.1. |
| **PLANNER-ACTION-3** | The planner **MUST** order permitted actions in the canonical execution sequence: `REPLACE_PLACEMENT_OBSERVATION` → `REQUEST_PROVIDER_REPAIR` → `RESELECT_KNOWN_FILES` → `REOBSERVE_PROVIDER` → `REOBSERVE_ZURG_METADATA` → `REOBSERVE_FILESYSTEM_EXPOSURE` → `RECONCILE_BINDING`. |
| **PLANNER-ACTION-4** | The planner **MUST NOT** imply that `RECONCILE_BINDING` guarantees success. The executor must verify a usable placement exists before binding. |
| **PLANNER-ACTION-5** | The planner **MUST NOT** permit `REOBSERVE_FILESYSTEM_EXPOSURE` for provider-side failures. Mount miss is not provider loss. |

---

## 7. Plan Identity

### 7.1 Plan Key Structure

| Component | Format | Purpose |
|-----------|--------|---------|
| Prefix | `"repair:"` | Namespace for repair plans |
| Release key | `{info_hash}:{file_index_or_torrent}` | Canonical content identity |
| Fingerprint | `sha256(stableStringify(fingerprint))` (hex, 64 chars) | Deterministic evidence digest |

**Format:** `planKey = "repair:{releaseKey}:{sha256(fingerprint)}"`

**Fingerprint contents (sorted, stable-canonical):**

- `desiredIdentity` — the target content identity
- `scope` — provider, account, instance, mount scope
- `bindingVersion` — the binding version the plan was computed against
- `triggers` — sorted trigger categories with sanitized evidence
- `permittedActions` — sorted permitted action list
- `actionSequence` — canonical action order
- `currentObservations` — sanitized observation summary

### 7.2 Why Plan Identity Exists

| Purpose | Mechanism |
|---------|-----------|
| **Replay detection** | `UNIQUE(plan_key, expected_binding_version)` in `repair_transactions` prevents duplicate execution of the same plan against the same binding version |
| **Auditability** | Plan key is a content address of the evidence — any inspector can recompute it and verify the plan was generated from the claimed evidence |
| **Stale plan rejection** | If the binding version changes between plan and execute, the `plan_key` no longer matches the current binding state — `createRepairTransaction()` rejects the plan |
| **Deterministic execution** | Same evidence → same plan key → same authorized actions → same execution path |

### 7.3 Plan Identity Constraints

| ID | Constraint |
|----|------------|
| **PLANNER-PLANID-1** | The `planKey` **MUST** be a deterministic function of the fingerprint. No randomness, no timestamps. |
| **PLANNER-PLANID-2** | The `planKey` **MUST** include `bindingVersion`. Different binding versions produce different plan keys even with identical observation evidence. |
| **PLANNER-PLANID-3** | The `planKey` **MUST** include `scope`. Different scopes produce different plan keys even with identical evidence. |
| **PLANNER-PLANID-4** | The planner **MUST NOT** include filesystem paths, provider resource IDs, or provider file IDs in the fingerprint. These are sanitized to prevent information leakage and ensure portability. |
| **PLANNER-PLANID-5** | The planner **MUST** freeze the plan object. The returned plan is immutable (`Object.freeze()`). |

---

## 8. Planner Output Contract

### 8.1 Repair Plan Object

The planner produces a frozen repair plan object with these fields:

| Field | Type | Present When | Purpose |
|-------|------|--------------|---------|
| `status` | `"healthy"` \| `"repair-required"` \| `"not-applicable"` | Always | Whether repair is needed |
| `reason` | string | Always | Human-readable status reason |
| `planKey` | string | `repair-required` | Deterministic plan identity |
| `evaluatedAt` | integer | Always | Timestamp of evaluation |
| `desiredIdentity` | object | Always | Target content identity |
| `scope` | object | Always | Effective scope |
| `binding` | object | `repair-required` | Reference to the binding being repaired (id, version, placementId, providerFileId, exposureId) |
| `triggers` | array | Always | Sorted trigger list with sanitized evidence |
| `permittedActions` | array | Always | Set of permitted repair actions |
| `actionSequence` | array | Always | Canonical execution order |
| `currentObservations` | object | Always | Sanitized observation summary |
| `expectedPostconditions` | object | Always | What success looks like |

### 8.2 Plan Status Values

#### `healthy`

| Aspect | Definition |
|--------|------------|
| **Meaning** | No repair required. Binding evidence is current. |
| **Triggers** | Empty array |
| **Permitted actions** | Empty array |
| **Action sequence** | Empty array |
| **Binding reference** | Absent |

#### `repair-required`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Repair is required. At least one trigger is present. |
| **Triggers** | One or more trigger categories with evidence |
| **Permitted actions** | Non-empty set of authorized actions |
| **Action sequence** | Canonical ordering of permitted actions |
| **Binding reference** | Present — the binding to repair |

#### `not-applicable`

| Aspect | Definition |
|--------|------------|
| **Meaning** | Planner has no canonical binding to evaluate. |
| **Reason** | `"no-active-canonical-binding"` |
| **Triggers** | Empty array |
| **Permitted actions** | Empty array |
| **Binding reference** | Absent |

### 8.3 Expected Postconditions

The `expectedPostconditions` define what the repair must achieve:

| Field | Expected Value | Meaning |
|-------|---------------|---------|
| `canonicalIdentity` | `{ infoHash, fileIndex, fileIndexKey }` | The target identity must remain unchanged |
| `placement` | `"present"` | Provider placement must be observed present |
| `readiness` | `"ready"` | Provider readiness must be ready |
| `inventory` | `"present-fresh-authoritative-complete"` | Inventory must be present, fresh, authoritative, and complete |
| `zurgMetadata` | `"present-fresh-not-broken"` | Zurg metadata must be present, fresh, and not broken |
| `exposure` | `"visible-fresh-read-only"` | Filesystem exposure must be visible, fresh, and read-only |
| `exactFileMapping` | `"mapped-authoritative"` | Exact file mapping must be authoritative |
| `binding` | `"active-for-canonical-identity"` | Binding must be active for the canonical identity |
| `catalogAndPlaybackMutationPermitted` | `false` | Repair MUST NOT mutate catalog or playback state |

**Key insight:** The postconditions are the **success criteria** for the repair. The executor re-plans after execution and verifies the plan status is `healthy`.

### 8.4 Failure Conditions

| Condition | Meaning |
|-----------|---------|
| `no-active-canonical-binding` | No active binding exists for the canonical identity. Repair cannot proceed. |
| `binding-version-mismatch` | The binding version changed between plan and execute. Plan is stale. |
| `no-usable-placement` | No placement is ready for binding reconciliation. |
| `repair-postcondition-failed` | Post-execution re-planning shows repair did not achieve health. |
| `repair-plan-invalid` | Persisted plan does not match trusted control-plane evidence. |

### 8.5 Output Constraints

| ID | Constraint |
|----|------------|
| **PLANNER-OUTPUT-1** | The planner **MUST** return a frozen (immutable) plan object. |
| **PLANNER-OUTPUT-2** | The planner **MUST NOT** include raw provider resource IDs, filesystem paths, or internal identifiers in the plan output. These are sanitized. |
| **PLANNER-OUTPUT-3** | The planner **MUST** include `expectedPostconditions` in every plan (healthy, repair-required, not-applicable). |
| **PLANNER-OUTPUT-4** | The planner **MUST** include `currentObservations` in every plan for auditability. |
| **PLANNER-OUTPUT-5** | The planner **MUST** set `executed: false` on every plan. The planner never marks plans as executed. |

---

## 9. Planner Forbidden Responsibilities

### 9.1 Provider Interaction

| ID | Constraint |
|----|------------|
| **PLANNER-FORBID-1** | The repair planner **MUST NOT** call provider APIs. |
| **PLANNER-FORBID-2** | The repair planner **MUST NOT** create torrents. |
| **PLANNER-FORBID-3** | The repair planner **MUST NOT** delete torrents. |
| **PLANNER-FORBID-4** | The repair planner **MUST NOT** request provider repair directly. |
| **PLANNER-FORBID-5** | The repair planner **MUST NOT** select provider files directly. |
| **PLANNER-FORBID-6** | The repair planner **MUST NOT** refresh provider inventory directly. |

### 9.2 Mutation

| ID | Constraint |
|----|------------|
| **PLANNER-FORBID-7** | The repair planner **MUST NOT** write bindings. |
| **PLANNER-FORBID-8** | The repair planner **MUST NOT** write exposures. |
| **PLANNER-FORBID-9** | The repair planner **MUST NOT** write placements. |
| **PLANNER-FORBID-10** | The repair planner **MUST NOT** create repair transactions. |
| **PLANNER-FORBID-11** | The repair planner **MUST NOT** modify lifecycle events. |
| **PLANNER-FORBID-12** | The repair planner **MUST NOT** supersede or degrade bindings. |
| **PLANNER-FORBID-13** | The repair planner **MUST NOT** write to any database table. |

### 9.3 Execution

| ID | Constraint |
|----|------------|
| **PLANNER-FORBID-14** | The repair planner **MUST NOT** execute repair actions. |
| **PLANNER-FORBID-15** | The repair planner **MUST NOT** retry failed actions. |
| **PLANNER-FORBID-16** | The repair planner **MUST NOT** perform rollback of partial repairs. |
| **PLANNER-FORBID-17** | The repair planner **MUST NOT** mark repair transactions as succeeded. |
| **PLANNER-FORBID-18** | The repair planner **MUST NOT** mark repair steps as succeeded. |
| **PLANNER-FORBID-19** | The repair planner **MUST NOT** verify postconditions. |

### 9.4 Consumer Interaction

| ID | Constraint |
|----|------------|
| **PLANNER-FORBID-20** | The repair planner **MUST NOT** know Plex behavior. |
| **PLANNER-FORBID-21** | The repair planner **MUST NOT** react to playback failures. |
| **PLANNER-FORBID-22** | The repair planner **MUST NOT** modify consumer artifacts (`.strm`, WebDAV, FUSE). |
| **PLANNER-FORBID-23** | The repair planner **MUST NOT** read consumer-facing state. |
| **PLANNER-FORBID-24** | The repair planner **MUST NOT** know gateway behavior. |

### 9.5 Side Effects

| ID | Constraint |
|----|------------|
| **PLANNER-FORBID-25** | The repair planner **MUST NOT** perform any I/O. |
| **PLANNER-FORBID-26** | The repair planner **MUST NOT** access the filesystem. |
| **PLANNER-FORBID-27** | The repair planner **MUST NOT** access the network. |
| **PLANNER-FORBID-28** | The repair planner **MUST NOT** read environment variables except via injected `now`. |
| **PLANNER-FORBID-29** | The repair planner **MUST NOT** log. Logging is the executor's responsibility. |

---

## 10. Relationship With Repair Executor

### 10.1 Boundary Definition

| Planner | Executor |
|---------|----------|
| **WHAT** should happen | **HOW** it happens safely |
| Produces repair plan | Consumes and executes repair plan |
| Declares permitted actions | Executes permitted actions only |
| Declares expected postconditions | Verifies postconditions after execution |
| Computes plan identity | Persists plan as repair transaction |
| Classifies triggers | Maps triggers to action implementations |

### 10.2 Planner Provides to Executor

| Artifact | Purpose |
|----------|---------|
| `planKey` | Durable, deterministic plan identity |
| `binding` reference | The binding to repair (id, version, placementId, providerFileId, exposureId) |
| `permittedActions` | The set of actions the executor may perform |
| `actionSequence` | The canonical execution order |
| `expectedPostconditions` | The success criteria the executor must verify |
| `scope` | Provider, account, instance, and mount scope for execution |
| `currentObservations` | Baseline observation state for audit |

### 10.3 Executor Provides to Planner

| Artifact | Purpose |
|----------|---------|
| Re-planning on postcondition failure | Executor re-invokes planner to verify repair achieved health |
| Trusted plan assertion | Executor re-plans before execution to verify persisted plan matches current evidence |
| Current snapshot | Executor provides fresh snapshot for re-planning |

### 10.4 Constraint

| ID | Constraint |
|----|------------|
| **PLANNER-EXEC-1** | The repair executor **MUST NOT** execute actions not declared in the planner's `permittedActions`. |
| **PLANNER-EXEC-2** | The repair executor **MUST** verify the planner's `expectedPostconditions` after execution. |
| **PLANNER-EXEC-3** | The repair executor **MUST** re-plan before execution and reject plans where `trusted.planKey !== repair.planKey`. |
| **PLANNER-EXEC-4** | The repair planner **MUST NOT** execute any action. Execution is exclusively the executor's responsibility. |

---

## 11. Relationship With Binding State Contract

### 11.1 Binding Contract Defines

- Valid binding states (`active`, `degraded`, `superseded`, `failed`) — see `BINDING-STATE-CONTRACT.md` §4
- Versioning rules (one-active rule, monotonicity, optimistic concurrency) — see `BINDING-STATE-CONTRACT.md` §5
- Atomicity guarantees — see `BINDING-STATE-CONTRACT.md` §6
- Failure semantics — see `BINDING-STATE-CONTRACT.md` §7
- Forbidden transitions — see `BINDING-STATE-CONTRACT.md` §4.4

### 11.2 Planner Contract Defines

- How unhealthy states become repair plans — see §5
- What triggers produce which permitted actions — see §5.1
- What `RECONCILE_BINDING` means — see §6.2
- How plan identity relates to binding version — see §7

### 11.3 Planner MUST Respect Binding Constraints

| ID | Constraint |
|----|------------|
| **PLANNER-BINDING-1** | The planner **MUST** respect the **one-active-binding rule**. The planner never creates bindings; it only permits `RECONCILE_BINDING` for the executor to execute. |
| **PLANNER-BINDING-2** | The planner **MUST** respect **optimistic concurrency**. The `planKey` includes `bindingVersion`. If the binding version changes, the plan is stale. |
| **PLANNER-BINDING-3** | The planner **MUST** respect **terminal states**. The planner does not produce repair plans for `superseded` or `failed` bindings — these are terminal. |
| **PLANNER-BINDING-4** | The planner **MUST** respect **version monotonicity**. The planner's `expected_binding_version` is a specific version, not a range. |
| **PLANNER-BINDING-5** | The planner **MUST** set `catalogAndPlaybackMutationPermitted: false` in expected postconditions. Repair MUST NOT mutate catalog or playback state. |
| **PLANNER-BINDING-6** | The planner **MUST** detect `canonical-binding-degraded` when `binding.state !== 'active'`. The binding state machine defines when this trigger fires. |

### 11.4 Binding State Machine Relevance

The planner's trigger detection is grounded in the binding state machine:

- `active` → `degraded` trigger fires when evidence no longer supports `active` state.
- `degraded` → repair plan is produced when evidence supports a repair path.
- `degraded` → `superseded` is NOT the planner's responsibility — the executor's `reconcileExactBinding()` triggers supersession via `activateBinding()`.
- `degraded` → `failed` is NOT the planner's responsibility — the executor determines no usable placement exists.
- `superseded` / `failed` → planner produces `not-applicable` (no active binding to repair).

---

## 12. Future Contract Dependencies

### 12.1 Contracts This Document Feeds

| Dependent Contract | How This Contract Feeds It |
|--------------------|---------------------------|
| `REPAIR-EXECUTOR-CONTRACT` | Defines the `permittedActions` the executor must enforce. Defines `expectedPostconditions` the executor must verify. Defines `actionSequence` the executor must follow. Defines `planKey` identity the executor must persist. |
| `RECONCILER-CONTRACT` | Defines the boundary between routine reconciliation and repair. Reconciler handles `bind`/`rebind`/`mark-degraded`; repair handles degraded/failed. Planner's `canonical-binding-degraded` trigger defines when reconciler transitions to repair. |
| `REPAIR-TRANSACTION-CONTRACT` | Defines the `repair_transactions` row structure (`planKey`, `expectedBindingVersion`, `authorizedActions`, `status`). Defines the `planned` → `authorized` → `executing` → `succeeded`/`failed` lifecycle. |

### 12.2 Contract Dependency Graph

```
BINDING-STATE-CONTRACT
        │
        ▼
REPAIR-PLANNER-CONTRACT (this document)
        │
        ├──▶ REPAIR-EXECUTOR-CONTRACT
        │      - Permitted action enforcement
        │      - Postcondition verification
        │      - Action sequence execution
        │
        ├──▶ RECONCILER-CONTRACT
        │      - Routine vs degraded boundary
        │      - mark-degraded trigger handoff
        │
        └──▶ REPAIR-TRANSACTION-CONTRACT
               - Plan identity persistence
               - Expected binding version
               - Action authorization
```

### 12.3 Constraints on Future Contracts

| ID | Constraint |
|----|------------|
| **PLANNER-FUTURE-1** | Future contracts **MUST NOT** expand the trigger/action matrix without updating this document. |
| **PLANNER-FUTURE-2** | Future contracts **MUST NOT** add repair actions without adding them to this document's §6.1 catalog. |
| **PLANNER-FUTURE-3** | Future contracts **MUST NOT** relax determinism requirements without updating §4. |
| **PLANNER-FUTURE-4** | Future contracts **MUST** preserve the planner's pure-function semantics. The planner remains side-effect-free. |

---

## 13. Compliance Verification

A repair planner implementation **complies** with this contract if:

1. It produces a deterministic plan key from identical inputs (§4).
2. It consumes only snapshot, lifecycle, scope, and `now` as inputs (§3).
3. It maps triggers to permitted actions exclusively via the matrix in §5.1.
5. It declares expected postconditions for every plan (§8.3).
6. It sanitizes all outputs — no raw paths, provider resource IDs, or internal identifiers (§7.3).
7. It produces frozen (immutable) plan objects (§8.5).
8. It performs no I/O, no provider calls, no database writes (§9).
9. It does not execute, retry, or verify repairs (§9).
10. It respects the binding state contract's constraints (§11).

An implementation that violates any **MUST** constraint is non-compliant.

---

## 14. Relationship to Prior Documents

| Prior Document | Relationship |
|----------------|--------------|
| `BINDING-STATE-CONTRACT.md` | Defines binding lifecycle; this contract defines how unhealthy bindings become repair plans |
| `REPAIR-RECONCILIATION-BOUNDARY-ANALYSIS.md` | Analysis of repair boundary; this contract formalizes the planner's role within it |
| `MATERIALIZATION-ARCHITECTURE.md` | Defines materialization layer; this contract defines repair planning within it |
| `RESOLVER-DESIGN.md` | Defines resolver behavior; this contract defines the repair that resolver state triggers |
| `MATERIALIZATION-REGISTRY-SCHEMA.md` | Defines binding schema; this contract adds normative repair planning constraints |
| `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md` | Defines gateway read-only boundary; this contract defines the write-path repair the gateway cannot perform |
| `CONTRACTS.md` | Upstream contract patterns; this contract follows the same MUST/MUST NOT/MAY pattern |

---

End of contract.

# Repair & Reconciliation Boundary Analysis — HashSucker

**Date:** 2026-08-23
**Status:** Analysis — defines repair and reconciliation seams before implementation
**Grounded in:** `MATERIALIZATION-ARCHITECTURE.md`, `RESOLVER-DESIGN.md`, `MATERIALIZATION-REGISTRY-SCHEMA.md`, `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md`, `PLEX-CONSUMER-BOUNDARY-ANALYSIS.md`, `STATE-MACHINE-REFERENCE.md`, `CONTRACTS.md`
**Cross-checked against:** `media-search/src/lib/control-plane/repair-planner.js`, `media-search/src/lib/control-plane/repair-executor.js`, `media-search/src/lib/control-plane/reconciler.js`, `media-search/src/lib/control-plane/store.js`
**Constraints:** No code; no schema changes; no implementation; architecture analysis only

---

## 1. Purpose

This document defines the **repair and reconciliation boundary** for HashSucker. It answers seven questions:

1. Who owns stale detection, degraded declaration, repair transactions, binding replacement, superseding, and health restoration?
2. What is the read-path vs write-path split between gateway and repair/reconciler?
3. What are the canonical state transitions for degraded → repairing → active and degraded → failed?
4. What happens in each failure scenario (mount loss, provider removal, exposure missing, provider file change, replacement found, replacement absent)?
5. How does repair interact with Plex?
6. What are the forbidden anti-patterns?
7. What should become a normative contract?

Each answer is grounded in existing contracts and the current control-plane implementation. No implementation is performed.

---

## 2. Ownership Matrix

### 2.1 Stale Materialization Detection

| Aspect | Owner | Mechanism |
|--------|-------|-----------|
| **Detecting stale exposure** | Observation layer | `exposures.expires_at <= now` triggers `exposure.state = 'missing'` or `'degraded'` |
| **Detecting stale placement** | Observation layer | `provider_placements.observed_at` freshness check |
| **Detecting stale inventory** | Observation layer | `provider_files.inventory_expires_at` check |
| **Detecting broken Zurg state** | Observation layer | `zurg-metadata.js` detects `broken_torrent` or `under_repair_torrent` |
| **Detecting binding degradation** | Repair planner | `planRdZurgRepair()` evaluates binding state against observation freshness |
| **Detecting lifecycle stall** | Repair planner | `lifecycle_events.milestone` stuck without progression |

**Key insight:** Detection is **distributed** across observers. Each observer detects staleness within its own scope (placement, readiness, inventory, exposure, Zurg metadata). The repair planner **correlates** these signals into a coherent repair plan — it does not re-observe.

### 2.2 Degraded State Declaration

| Aspect | Owner | Mechanism |
|--------|-------|-----------|
| **Binding status → degraded** | Reconciler | `planReconciliation()` returns `mark-degraded` action when placement/inventory/exposure is unhealthy |
| **Repair transaction → executing** | Repair executor | `createRdZurgRepairExecutor()` transitions `repair_transactions.status` to `executing` |
| **Materialization state → repairing** | Control plane (derived) | Composite projection: `repair_transactions: executing` OR `binding: degraded` |

**Key insight:** The control plane **declares** degraded state. The media gateway **observes** it (GW-FAIL-5, GW-FAIL-6) but never declares it.

### 2.3 Repair Transaction Creation

| Aspect | Owner | Mechanism |
|--------|-------|-----------|
| **Plan generation** | Repair planner | `planRdZurgRepair()` produces deterministic, side-effect-free repair proposal |
| **Plan persistence** | Repair executor | `persistPlan()` writes `repair_transactions` row with status `planned` |
| **Plan authorization** | Repair executor | `authorize()` transitions to `authorized` with explicit action sequence |
| **Plan execution** | Repair executor | `execute()` runs authorized steps in order |

**Key insight:** Repair transactions are **durable** and **audited**. Every step is recorded in `repair_steps`. The plan is a deterministic function of snapshot + lifecycle + scope — re-planning with identical inputs produces the same plan key.

### 2.4 Binding Replacement

| Aspect | Owner | Mechanism |
|--------|-------|-----------|
| **New binding creation** | Repair executor (via slice) | `reconcileExactBinding()` calls `slice.activateBinding()` |
| **Old binding supersession** | Control plane | `activateBinding` sets `old_binding.status = 'superseded'` and creates new `bindings` row with incremented `version` |
| **New exposure observation** | Repair executor (via slice) | `slice.observeExposure()` before binding activation |
| **New mapping creation** | Repair executor (via slice) | `slice.mapExactFile()` before binding activation |

**Key insight:** Binding replacement is **atomic at the control-plane level** — the old binding is superseded and a new one is created in a single transaction. The gateway sees either the old binding or the new one, never a partial state.

### 2.5 Superseding Old Bindings

| Aspect | Owner | Mechanism |
|--------|-------|-----------|
| **Supersession trigger** | Reconciler / Repair executor | `activateBinding` with `expectedBindingVersion` ensures optimistic concurrency |
| **Supersession semantics** | Store (SQL) | `bindings.status = 'superseded'`, `superseded_at = now()` |
| **One active binding** | Store (SQL) | Partial unique index: `idx_bindings_one_active` on `library_item_id WHERE status = 'active'` |
| **Version chain** | Store (SQL) | `bindings.version` monotonically increments per `library_item_id` |

**Key insight:** Supersession is **versioned**. Repair transactions reference `expected_binding_version` — if the binding changes between plan and execute, the repair is rejected as stale.

### 2.6 Health Restoration

| Aspect | Owner | Mechanism |
|--------|-------|-----------|
| **Postcondition verification** | Repair executor | `assertPostconditions()` re-plans and confirms `plan.status === 'healthy'` |
| **Materialization available** | Control plane (derived) | New active binding + fresh visible exposure → `materialization_state = available` |
| **Binding active** | Store (SQL) | New `bindings` row with `status = 'active'` |
| **Exposure visible** | Observation layer | `exposures.state = 'visible'`, `readOnly = true`, `expires_at > now` |

**Key insight:** Health restoration is **verified**, not assumed. The repair executor re-runs the planner against current state and confirms the repair achieved its goal. If not, the transaction fails.

---

## 3. Read Path vs Write Path

### 3.1 Media Gateway (Read Path)

| Responsibility | Constraint |
|----------------|------------|
| **Read bindings** | `SELECT * FROM bindings WHERE info_hash = ? AND file_index_key = ? AND status = 'active'` (GW-READ-1) |
| **Read exposures** | `SELECT * FROM exposures WHERE id = ?` (GW-READ-2) |
| **Read provider_files** | `size`, `name` for Content-Length and Content-Type (GW-READ-3) |
| **Serve bytes** | Stream from filesystem mount via `fs.createReadStream` (GW-TRANS-7) |
| **Never mutate** | GW-READ-17: gateway writes nothing to any table |

**Read-path invariants:**
- Gateway reads only `bindings`, `exposures`, `provider_files` (GW-READ-1, 2, 3)
- Gateway does NOT read `lifecycle_events`, `repair_transactions`, `repair_steps` (GW-READ-6, 7)
- Gateway does NOT read `library_items`, `library_paths` (GW-READ-8)
- Gateway does NOT write to any table (GW-READ-17)

### 3.2 Repair/Reconciler (Write Path)

| Responsibility | Mechanism |
|----------------|-----------|
| **Mutate bindings** | `createBinding()`, `activateBinding()`, `markBindingDegraded()`, `supersedeBinding()` |
| **Create replacements** | `reconcileExactBinding()` creates new binding with new placement/exposure |
| **Own lifecycle transitions** | `repair_transactions.status` flows: `planned → authorized → executing → succeeded/failed` |
| **Mutate exposures** | `observeExposure()` updates `exposures.state`, `observed_at`, `expires_at` |
| **Mutate provider_files** | `observeInventory()` refreshes `provider_files` rows |
| **Mutate placements** | `observePlacement()` updates `provider_placements.state` |
| **Append lifecycle events** | `recordLifecycleEvent()` appends to `lifecycle_events` |
| **Create repair steps** | `createRepairStep()` records each action attempt in `repair_steps` |

**Write-path invariants:**
- All binding mutations go through `store.activateBinding()` with optimistic concurrency (`expectedBindingVersion`)
- Repair plans are deterministic functions of snapshot + lifecycle + scope
- Repair execution is audited: every step recorded in `repair_steps`
- Postconditions are verified before marking `succeeded`

### 3.3 Boundary Enforcement

```
                    ┌─────────────────────────────────────────────┐
                    │            TRUSTED ZONE                      │
                    │                                             │
   Edge Proxy ───▶  │  Media Gateway (read-only)                   │
                    │      │                                       │
                    │      │ reads bindings, exposures, files       │
                    │      │ never writes                          │
                    │      ▼                                       │
                    │  Control Plane DB                            │
                    │      │                                       │
                    │      │ written by                             │
                    │      ▼                                       │
                    │  Repair/Reconciler (write-only semantics)    │
                    │      │                                       │
                    │      │ observes, plans, executes, audits      │
                    │      │ owns lifecycle transitions             │
                    └─────────────────────────────────────────────┘
```

**Key insight:** The media gateway is a **read-only projection**. The repair/reconciler is the **sole writer** of binding state. There is no path from gateway request to binding mutation — the gateway cannot trigger repair (GW-FORBIDDEN-9).

---

## 4. State Transitions

### 4.1 Binding State Machine

```
┌─────────┐
│ active  │  Current playable binding, fresh exposure, ready placement
└────┬────┘
     │
     │ exposure expires OR placement degrades OR inventory stale
     ▼
┌─────────────┐
│ degraded    │  Binding exists but exposure/placement/inventory unhealthy
└──────┬──────┘
       │
       ├── repair initiated (repair_transactions: executing) ──▶ ┌───────────┐
       │                                                         │ repairing │
       │                                                         └─────┬─────┘
       │                                                               │
       │                                                               ├── postconditions met ──▶ (new active binding)
       │                                                               │   old binding → superseded
       │                                                               │
       │                                                               └── postconditions failed ──▶ ┌─────────┐
       │                                                                                             │ failed  │
       │                                                                                             └─────────┘
       │
       └── no repair possible (max retries, auth error, no alternate placement) ──▶ ┌─────────┐
                                                                                    │ failed  │
                                                                                    └─────────┘
```

### 4.2 Binding State Definitions

| State | Meaning | Gateway HTTP Response |
|-------|---------|----------------------|
| `active` | Fresh binding with visible exposure and ready placement | 200 / 206 (success) |
| `degraded` | Binding exists but exposure/placement/inventory is unhealthy | 503 (degraded binding) or 423 (non-visible exposure) |
| `superseded` | Replaced by a newer binding version | 410 (no longer active) |
| `failed` | Permanently failed, no repair possible | 410 (permanent failure) |

### 4.3 Repair Transaction State Machine

```
┌─────────┐
│ planned │  Repair plan generated and persisted
└────┬────┘
     │
     │ human or automated authorization
     ▼
┌───────────┐
│ authorized│  Action sequence approved, ready to execute
└─────┬─────┘
      │
      │ executor begins
      ▼
┌───────────┐
│ executing │  Steps running in authorized order
└─────┬─────┘
      │
      ├── all steps succeed AND postconditions met ──▶ ┌───────────┐
      │                                                │ succeeded │
      │                                                └───────────┘
      │
      └── any step fails AND max retries exceeded ──▶ ┌─────────┐
                                                      │ failed  │
                                                      └─────────┘
```

### 4.4 Repair Step State Machine

```
┌─────────┐
│ running │  Step in progress
└────┬────┘
     │
     ├── success ──▶ ┌───────────┐
     │                │ succeeded │
     │                └───────────┘
     │
     └── failure ──▶ ┌─────────┐
                     │ failed  │
                     └─────────┘
```

### 4.5 Expected Transition Flows

#### Flow 1: Active → Degraded → Repairing → Active

```
1. exposure.expires_at <= now
   → observation layer marks exposure.state = 'missing' or 'degraded'

2. repair planner correlates: exposure stale + binding active
   → triggers: 'missing-filesystem-exposure', 'canonical-binding-degraded'
   → permitted actions: REOBSERVE_FILESYSTEM_EXPOSURE, RECONCILE_BINDING

3. repair executor creates repair_transactions row (status: planned)
   → plan_key = hash(snapshot + lifecycle + scope)
   → expected_binding_version = binding.version

4. authorization: status → authorized
   → authorized_actions = [REOBSERVE_FILESYSTEM_EXPOSURE, RECONCILE_BINDING]

5. execution: status → executing
   → step 1: reobserve exposure → exposure.state = 'visible', fresh expires_at
   → step 2: reconcile binding → activateBinding with new exposure
   → old binding: status = 'superseded', superseded_at = now()
   → new binding: status = 'active', version = old.version + 1

6. postconditions: assertPostconditions()
   → re-plan → plan.status = 'healthy'
   → transaction status → succeeded
```

#### Flow 2: Active → Degraded → Repairing → Failed

```
1. placement.state = 'error' (provider removed content)
   → triggers: 'broken-provider-observation'
   → permitted actions: REOBSERVE_PROVIDER, REPLACE_PLACEMENT_OBSERVATION, RECONCILE_BINDING

2. repair planned, authorized, executing

3. execution:
   → reobserve placement → still error
   → reconcile binding → no usable placement (no alternate provider)
   → assertion: newestUsablePlacement() returns null
   → step fails with 'no-usable-placement'

4. postconditions fail → transaction status → failed
   → binding.status = 'failed'
   → gateway returns 410
```

#### Flow 3: Active → Degraded → Failed (No Repair)

1. exposure expires, no alternate placement, auth error on re-observe
2. Repair planner determines: no permitted actions can restore health
3. Binding marked `failed` directly (no repair transaction created)
4. Gateway returns 410

### 4.6 Forbidden Transitions

| From | To | Why Forbidden |
|------|----|---------------|
| `active` | `failed` | Must go through `degraded` first (unless permanent auth error) |
| `degraded` | `active` | Must go through repair (new binding version) |
| `superseded` | `active` | Superseded is terminal; new binding is a different version |
| `failed` | `degraded` | Failed is terminal; new placement creates new binding |
| `repairing` | `degraded` | Already repairing; no regression |
| `executing` | `planned` | Authorization is one-way |

---

## 5. Failure Scenarios

### 5.1 Mount Disappears

**Symptom:** Filesystem mount unreachable (ENOENT, EIO on read).

**Detection:** Observation layer cannot read `exposure.relative_path` → `exposure.state = 'error'`.

**Gateway behavior:** Returns `502 Bad Gateway` (GW-FAIL-7).

**Repair flow:**
1. Trigger: `missing-filesystem-exposure` (exposure.state = 'error')
2. Permitted actions: `REOBSERVE_FILESYSTEM_EXPOSURE` only
3. Repair planner conservatively avoids provider mutations for a mount miss
4. If mount returns: new observation → exposure visible → reconcile binding
5. If mount permanently gone: binding degraded → failed, exposure must be re-created from a new placement

**Plex impact:** Plex sees 502 (transient). On retry, sees 423 or 410 if repair fails.

### 5.2 Provider Removes Cached Content

**Symptom:** Provider API reports torrent deleted, content no longer available.

**Detection:** `observePlacement()` finds placement state = `error` or `removed`.

**Trigger:** `broken-provider-observation`.

**Gateway behavior:** Binding exists but placement not ready → 503.

**Repair flow:**
1. Permitted actions: `REOBSERVE_PROVIDER`, `REPLACE_PLACEMENT_OBSERVATION`, `REQUEST_PROVIDER_REPAIR`, `RECONCILE_BINDING`
2. If provider confirms deletion: no usable placement → binding failed
3. If alternate provider exists: reconcile binding to alternate placement
4. If no alternate: binding failed, 410 to gateway

**Plex impact:** 503 during detection, then 410 if no replacement. .strm still points to resolver URL; resolver returns 410.

### 5.3 Exposure Missing

**Symptom:** `exposure.state = 'missing'` or `exposure.expires_at <= now`.

**Detection:** Observation layer freshness check.

**Trigger:** `missing-filesystem-exposure`.

**Gateway behavior:** Returns `423 Locked` (GW-FAIL-6) or `503` (GW-FAIL-5).

**Repair flow:**
1. Permitted actions: `REOBSERVE_FILESYSTEM_EXPOSURE`
2. May also trigger `RECONCILE_BINDING` if exposure cannot be refreshed
3. Reobserve: check if file still exists on mount
4. If file returned: new exposure observation → binding reactivated
5. If file permanently gone: need new placement (full re-placement flow)

**Plex impact:** 423 (repair in progress) or 503 (stale). Plex retries.

### 5.4 Provider File Changes

**Symptom:** Inventory observation finds different file set (files added, removed, renamed).

**Detection:** `observeInventory()` compares new inventory snapshot to existing `provider_files`.

**Trigger:** `provider-inventory-degraded` or `known-file-selection-lost`.

**Repair flow:**
1. Permitted actions: `REOBSERVE_PROVIDER`, `RESELECT_KNOWN_FILES`
2. If exact file still exists: re-map exact file, reobserve exposure
3. If exact file gone: mark degraded, attempt re-placement
4. If selection lost: `RESELECT_KNOWN_FILES` re-selects files via provider API

**Plex impact:** None if repair succeeds before playback. 503 during repair.

### 5.5 Replacement Placement Found

**Symptom:** Active binding degraded, but alternate placement exists for same identity.

**Detection:** `planReconciliation()` finds another placement with `state = 'ready'` and matching `info_hash`.

**Trigger:** `canonical-binding-degraded` + available alternate placement.

**Repair flow:**
1. Permitted actions: `RECONCILE_BINDING`
2. `newestUsablePlacement()` selects freshest ready placement
3. `mapExactFile()` creates new mapping for alternate placement's provider file
4. `observeExposure()` for new placement
5. `activateBinding()` supersedes old binding, creates new active binding

**Plex impact:** Resolver URL unchanged. New binding serves bytes from new exposure/provider. Plex does not observe the switch.

### 5.6 No Replacement Found

**Symptom:** Active binding degraded, no alternate placement, provider confirms deletion.

**Detection:** All placements in `error` or `removed` state; no `ready` placement for identity.

**Trigger:** `broken-provider-observation` + no alternate placement.

**Repair flow:**
1. No permitted actions can restore health
2. Binding marked `failed`
3. Repair transaction (if created) marked `failed` with `failure_category = 'no-usable-placement'`
4. Lifecycle event recorded: `milestone = 'binding-failed'`

**Plex impact:** Resolver URL returns `410 Gone`. Plex marks item unavailable. .strm file remains but resolver returns 410 on access.

---

## 6. Plex Interaction

### 6.1 Does Plex Ever Know Repair Occurred?

**No.**

Plex interacts with the **resolver URL** (`GET /media/{info_hash}/{file_index}`), which is stable forever. Repair operates on bindings, exposures, and placements — all behind the resolver.

- Before repair: resolver returns 200/206 (active binding)
- During repair: resolver returns 503 or 423 (degraded binding)
- After repair: resolver returns 200/206 (new active binding)

Plex sees only HTTP status codes. It does not know why 503 became 200. It does not know bindings were superseded.

**Grounding:** PLEX-CONSUMER-BOUNDARY-ANALYSIS.md §4.1, 4.2, 6.7 — Plex must not know repair state, binding state, or exposure state.

### 6.2 Should .strm URLs Change?

**No.**

The resolver URL `GET /media/{info_hash}/{file_index}` is **content-identity-based**, not placement-based. Repair changes the placement behind the binding, but the URL stays the same.

- `.strm` file contains: `http://hashsucker:port/media/{info_hash}/{file_index}`
- Repair supersedes old binding with new binding
- Resolver URL unchanged
- `.strm` file never needs updating

**Grounding:** PLEX-CONSUMER-BOUNDARY-ANALYSIS.md §6.6 — Resolver URL is stable forever.

### 6.3 Can Repair Happen While Plex Plays?

**Yes, with caveats.**

Repair is **non-blocking** for the control plane but affects the gateway as follows:

1. **If repair succeeds quickly:** Plex may experience a single 503/423 response, then 200 on retry. Plex's retry logic handles this transparently.
2. **If repair takes longer:** Plex sees sustained 503/423. Playback may stall or fail. Plex retries.
3. **Mid-playback binding switch:** The gateway reads the binding at request time. If a new binding is activated mid-stream:
   - **Same exposure:** No interruption (bytes continue from same file).
   - **Different exposure:** Gateway reads from new path. If the new file is identical content, no interruption. If different path, same bytes (content-identity preserved).

**Critical constraint:** The resolver URL is stable, but **byte continuity across binding changes is not guaranteed** unless the new exposure points to the same file content. This is a repair implementation concern: prefer re-observe-exposure over reconcile-binding when possible to maintain byte continuity.

### 6.4 What HTTP Behavior Occurs During Repair?

| Repair Phase | Binding State | Gateway Response | Plex Behavior |
|-------------|---------------|------------------|---------------|
| **Detection** | active → degraded | 503 (GW-FAIL-5) | May retry |
| **Planning** | degraded | 503 or 423 | Will retry |
| **Execution** | degraded → repairing | 503 or 423 | Will retry |
| **Supersession** | superseded + new active | 200/206 (new binding) | Resumes |
| **Failure** | failed | 410 (GW-OWN-13) | Marks unavailable |

**No mid-stream failures:** Once playback starts on a binding, the gateway streams bytes until completion or client disconnect. Repair does not interrupt an active stream — it affects the next request.

---

## 7. Anti-Patterns

### 7.1 Media Gateway Repair on Playback

**Forbidden.** The media gateway MUST NOT trigger repair (GW-FORBIDDEN-9).

| Anti-pattern | Why Forbidden |
|--------------|---------------|
| Gateway calls provider APIs | Violates GW-FORBIDDEN-5 |
| Gateway writes to `repair_transactions` | Violates GW-READ-17 |
| Gateway writes to `lifecycle_events` | Violates GW-FORBIDDEN-7 |
| Gateway marks binding degraded | Violates GW-FORBIDDEN-10 |
| Gateway refreshes stale exposure | Violates GW-FORBIDDEN-8 |

**Correct behavior:** Gateway returns 503 on stale observation, 423 on missing exposure. Observation layer and repair planner detect the failure independently.

### 7.2 Plex-Triggered Repair

**Forbidden.** Plex MUST NOT trigger repair (PLEX-CONSUMER-BOUNDARY-ANALYSIS.md §4.2).

| Anti-pattern | Why Forbidden |
|--------------|---------------|
| Plex writes to `repair_transactions` | Plex has no control-plane access |
| Plex calls provider APIs | Plex has no provider credentials |
| Plex modifies bindings | Plex has no control-plane write access |
| .strm file triggers repair | .strm contains URL only, no control-plane semantics |

**Correct behavior:** Repair is triggered by observation layer staleness detection or manual operator action. Plex playback failure does not create repair transactions.

### 7.3 Provider Calls from Resolver

**Forbidden.** The media gateway MUST NOT call provider APIs (GW-FORBIDDEN-5).

| Anti-pattern | Why Forbidden |
|--------------|---------------|
| Gateway refreshes expired URL | No CDN-redirect model (GW-TRANS-2) |
| Gateway checks provider status | Provider state is in bindings |
| Gateway re-selects files | File selection is control-plane concern |
| Gateway requests provider repair | Repair is control-plane concern |

**Correct behavior:** Provider calls happen only in capability adapters (observation layer) and repair executor (with explicit authorization).

### 7.4 Automatic Binding Mutation from Consumer Requests

**Forbidden.** Consumer requests MUST NOT mutate bindings.

| Anti-pattern | Why Forbidden |
|--------------|---------------|
| Plex playback triggers binding refresh | Playback is read-only |
| WebDAV PROPFIND triggers exposure refresh | Observation is scheduled, not consumer-triggered |
| .strm access triggers re-placement | .strm access is playback, not acquisition |
| 404 triggers automatic re-placement | Re-placement is control-plane decision |

**Correct behavior:** Bindings are mutated only by reconciler (routine) or repair executor (degraded/failed state). Consumer traffic never writes to the control plane.

### 7.5 Summary of Forbidden Cross-Boundary Calls

```
Consumer (Plex) ──X──▶ Control Plane (no writes)
Consumer (Plex) ──X──▶ Provider APIs (no direct access)
Gateway (resolver) ──X──▶ Control Plane writes (read-only)
Gateway (resolver) ──X──▶ Provider APIs (no calls)
Observation layer ──X──▶ Gateway internal state (no coupling)
Repair executor ──X──▶ Gateway runtime (no live gateway construction)
```

---

## 8. Future Contract Candidates

### 8.1 Repair Planner Contract

**File:** `REPAIR-PLANNER-CONTRACT.md`

**Scope:** Normative constraints on `planRdZurgRepair()` behavior.

**Candidate constraints:**
- Plan MUST be deterministic function of (snapshot, lifecycle, scope)
- Plan MUST NOT perform side effects (no provider calls, no db writes)
- Plan MUST produce stable `plan_key` for identical inputs
- Plan MUST declare permitted actions from trigger categories
- Plan MUST include expected postconditions for verification
- Plan MUST sanitize evidence (no provider resource IDs, no file paths)

### 8.2 Repair Executor Contract

**File:** `REPAIR-EXECUTOR-CONTRACT.md`

**Scope:** Normative constraints on repair transaction execution.

**Candidate constraints:**
- Executor MUST verify binding version before each action
- Executor MUST run steps in authorized order
- Executor MUST verify postconditions before marking succeeded
- Executor MUST NOT construct a live gateway instance
- Executor MUST persist every step to `repair_steps`
- Executor MUST fail transaction on first non-retryable step failure

### 8.3 Reconciler Contract

**File:** `RECONCILER-CONTRACT.md`

**Scope:** Normative constraints on routine reconciliation (non-repair).

**Candidate constraints:**
- Reconciler MUST only create bindings from fresh observations
- Reconciler MUST respect provider preference order
- Reconciler MUST use optimistic concurrency (`expectedBindingVersion`)
- Reconciler MUST NOT trigger provider mutations beyond observation
- Reconciler MUST append lifecycle events for every state transition

### 8.4 Binding State Contract

**File:** `BINDING-STATE-CONTRACT.md`

**Scope:** Normative constraints on binding lifecycle.

**Candidate constraints:**
- One active binding per library_item_id (enforced by partial unique index)
- Superseded and failed are terminal states
- New binding version MUST be monotonically increasing
- Binding MUST reference valid exposure_id, placement_id, provider_file_id

### 8.5 Repair Transaction Contract

**File:** `REPAIR-TRANSACTION-CONTRACT.md`

**Scope:** Normative constraints on repair transaction lifecycle.

**Candidate constraints:**
- Plan key MUST be unique per binding version
- Authorization MUST preserve plan action order
- Postconditions MUST be verified before success
- Failed transactions MUST record canonical failure category

### 8.6 Priority Order

| Priority | Contract | Depends On |
|----------|----------|------------|
| 1 | `BINDING-STATE-CONTRACT.md` | None (foundation) |
| 2 | `REPAIR-PLANNER-CONTRACT.md` | BINDING-STATE |
| 3 | `REPAIR-EXECUTOR-CONTRACT.md` | BINDING-STATE, REPAIR-PLANNER |
| 4 | `RECONCILER-CONTRACT.md` | BINDING-STATE |
| 5 | `REPAIR-TRANSACTION-CONTRACT.md` | REPAIR-PLANNER, REPAIR-EXECUTOR |

---

## 9. Decision Record

| Decision | Rationale |
|----------|-----------|
| Repair planner is side-effect-free | Determinism enables verification and replay |
| Repair executor verifies postconditions | Ensures repair actually restored health |
| Binding supersession is versioned | Optimistic concurrency prevents stale repairs |
| One active binding per library item | Gateway query is unambiguous |
| Gateway is strictly read-only | Separation of read and write paths |
| Plex never observes repair | Consumer boundary is clean |
| Repair does not interrupt active streams | Binding switch affects next request only |
| Mount miss is not provider miss | Conservative repair avoids unnecessary provider mutations |

---

## 10. Relationship to Prior Documents

| Prior Document | Relationship |
|----------------|--------------|
| `MATERIALIZATION-ARCHITECTURE.md` | Defines materialization layer; this analysis defines repair within it |
| `RESOLVER-DESIGN.md` | Defines resolver states; this analysis maps repair transitions to resolver behavior |
| `MATERIALIZATION-REGISTRY-SCHEMA.md` | Defines schema; this analysis defines how repair uses the schema |
| `MEDIA-GATEWAY-BOUNDARY-CONTRACT.md` | Defines gateway read-only boundary; this analysis enforces it for repair |
| `PLEX-CONSUMER-BOUNDARY-ANALYSIS.md` | Defines Plex boundary; this analysis ensures repair respects it |
| `STATE-MACHINE-REFERENCE.md` | Defines state machines; this analysis adds repair transaction lifecycle |
| `CONTRACTS.md` | Defines contracts; this analysis identifies future repair contracts |

---

**End of analysis.**

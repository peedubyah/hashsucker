# Observation Contract

**Date:** 2026-08-23
**Status:** Contract — normative constraints on observation lifecycle and consumption
**Grounded in:** `MATERIALIZATION-ARCHITECTURE-V2.md`, `MATERIALIZATION-REGISTRY-SCHEMA.md`, `RECONCILER-CONTRACT.md`, `REPAIR-PLANNER-CONTRACT.md`, `BINDING-STATE-CONTRACT.md`, `CONTRACTS.md`
**Cross-checked against:** `media-search/src/lib/control-plane/rd-zurg-slice.js`, `media-search/src/lib/control-plane/store.js`, `media-search/src/lib/control-plane/reconciler.js`, `media-search/src/lib/control-plane/repair-planner.js`, `media-search/src/lib/providers/realdebrid.js`, `media-search/src/lib/providers/zurg-metadata.js`, `media-search/src/lib/providers/filesystem-exposure.js`, `media-search/src/lib/providers/resources.js`
**Constraints:** No code; no schema changes; no implementation; contract only

---

## 1. Purpose

This document defines the **normative contract for observations** — the evidence layer that feeds reconciliation and repair. It answers nine questions:

1. Who owns observations and who may produce them?
2. What is the observation lifecycle from production to consumption?
3. What freshness semantics govern observation validity?
4. How are stale, missing, and invalid observations distinguished?
5. What are the provider observer boundaries?
6. What are the filesystem observer boundaries?
7. What may consumers (reconciler, repair planner) see?
8. What may the reconciler assume about observations?
9. What is the observation layer forbidden from doing?

Each answer is stated as a MUST / MUST NOT / MAY constraint. Violations break the contract.

### 1.1 Architectural Position

Observations are the **evidence layer** between external reality and the control plane:

```
External Reality
(provider APIs, filesystem, Zurg metadata)
        │
        v
   Observers
(provider adapters, filesystem exposure, Zurg metadata)
        │
        v
  Observation Store
(placement, readiness, inventory, exposure, zurg metadata)
        │
        v
   Control Plane Projection
(rd-zurg-slice.js: projectPlacement, projectReadiness, projectInventory, projectExposure, projectZurgMetadata, projectExactMapping, projectBinding)
        │
        v
   Consumers
(reconciler, repair planner, repair executor)
```

**Key insight:** Observations are **evidence, not authority**. The control plane is authoritative for materialization state. Observations are inputs that the control plane projects into facts. Observers never directly mutate bindings, lifecycle, or repair state.

---

## 2. Ownership

### 2.1 Observation Ownership

| ID | Constraint |
|----|------------|
| **OBS-OWN-1** | Observers **MUST** own **evidence production** — reading external reality and producing scoped, timestamped, expiring observations. |
| **OBS-OWN-2** | Observers **MUST** own **observation scope** — each observation carries explicit `provider`, `accountScope`, and where applicable `instanceScope` and `mountScope`. |
| **OBS-OWN-3** | Observers **MUST** own **freshness metadata** — every observation carries `observedAt` and `expiresAt` (or `ttlMs`). |
| **OBS-OWN-4** | Observers **MUST** own **failure classification** — when observation fails, the observer assigns a structured `failureCategory` and `retryable` flag. |
| **OBS-OWN-5** | The control plane store **MUST** own **observation persistence** — observers produce observations; the store appends them to the appropriate table. |
| **OBS-OWN-6** | The control plane slice (`rd-zurg-slice.js`) **MUST** own **observation projection** — converting raw observations into projected facts with effective state and freshness. |

### 2.2 Observation Does NOT Own

| Aspect | Actual Owner | Mechanism |
|--------|--------------|-----------|
| Binding lifecycle | Reconciler / Repair executor | `planReconciliation()` → `store.activateBinding()` |
| Lifecycle events | Control plane / Store | `recordLifecycleEvent()` appends to `lifecycle_events` |
| Repair decisions | Repair planner | `planRdZurgRepair()` interprets observation signals |
| Placement state machine | Provider adapters / Store | `recordPlacement()` updates `provider_placements` |
| Content identity | Corpus / Release contract | `createReleaseIdentity()` validates `(infoHash, fileIndex)` |
| Consumer behavior | Media gateway / Adapters | Gateway reads bindings; adapters consume exposures |

**Key insight:** Observers are **passive evidence collectors**. They read external reality and produce observations. They never decide what observations mean for materialization. Interpretation is the control plane's responsibility.

---

## 3. Observation Types

### 3.1 Observation Catalog

The system recognizes exactly five observation types:

| Observation Type | Table | Authority | Question Answered |
|-----------------|-------|-----------|-------------------|
| **Placement lookup** | `provider_placement_observations` | Provider adapter | "Does this provider have a placement for this hash?" |
| **Readiness** | `provider_readiness_observations` | Provider adapter | "Is this placement ready to serve bytes?" |
| **Inventory** | `provider_inventory_snapshots` | Provider adapter | "What files does this placement contain?" |
| **Exposure** | `exposures` | Filesystem observer | "Is this provider file visible on the transport?" |
| **Zurg metadata** | `zurg_metadata_observations` | Zurg metadata observer | "What does Zurg's .zurgtorrent say about this torrent?" |

### 3.2 Placement Lookup Observations

| Aspect | Definition |
|--------|------------|
| **States** | `present`, `missing`, `error` |
| **Scope** | `(provider, accountScope, infoHash)` |
| **Uniqueness** | One observation per `(provider, accountScope, infoHash)` |
| **Semantics** | `present` = provider has a placement; `missing` = provider has no placement; `error` = provider lookup failed |
| **Linkage** | `placement_id` references `provider_placements` when `present` |

### 3.3 Readiness Observations

| Aspect | Definition |
|--------|------------|
| **States** | `pending`, `ready`, `degraded`, `error`, `removed`, `unknown` |
| **Scope** | `placement_id` (one per placement) |
| **Uniqueness** | One observation per `placement_id` |
| **Semantics** | `ready` = placement can serve bytes; `pending` = provider processing; `degraded` = placement degraded; `error` = provider error; `removed` = placement removed |

### 3.4 Inventory Snapshots

| Aspect | Definition |
|--------|------------|
| **Scope** | `placement_id` (one per placement) |
| **Uniqueness** | One snapshot per `placement_id` |
| **Authority** | `authoritative` (boolean), `complete` (boolean) |
| **Semantics** | `authoritative=true` AND `complete=true` means the snapshot is a trusted complete inventory |
| **File count** | `file_count` records the number of files in the snapshot |

### 3.5 Exposure Observations

| Aspect | Definition |
|--------|------------|
| **States** | `pending`, `visible`, `missing`, `degraded`, `error`, `unknown` |
| **Scope** | `(transport, exposureKey, placementId, providerFileId)` |
| **Uniqueness** | One observation per `(transport, exposureKey, placementId, providerFileId)` |
| **Semantics** | `visible` = file is visible on transport; `missing` = file not visible; `error` = observation failed |
| **Constraints** | `readOnly` must be `true` for binding |

### 3.6 Zurg Metadata Observations

| Aspect | Definition |
|--------|------------|
| **States** | `present`, `missing`, `error` |
| **Scope** | `(provider, accountScope, instanceScope, infoHash, metadataPath)` |
| **Uniqueness** | One observation per `(provider, accountScope, instanceScope, infoHash, metadataPath)` |
| **Semantics** | `present` = .zurgtorrent file exists and was parsed; `missing` = file not found; `error` = parse/read failed |
| **Metadata** | `zurgState`, `zurgStateWhen` capture Zurg's torrent-level state |

---

## 4. Observation Lifecycle

### 4.1 Production

| ID | Constraint |
|----|------------|
| **OBS-PROD-1** | Observers **MUST** produce observations with explicit `observedAt` (timestamp when the observation was made). |
| **OBS-PROD-2** | Observers **MUST** produce observations with explicit `expiresAt` (timestamp when the observation becomes stale) or `ttlMs` (relative TTL from `observedAt`). |
| **OBS-PROD-3** | Observers **MUST** produce observations with explicit `source` (identifier for what produced the observation). |
| **OBS-PROD-4** | Observers **MUST** produce observations with explicit scope (`provider`, `accountScope`, and where applicable `instanceScope`, `mountScope`). |
| **OBS-PROD-5** | Observers **MUST** classify failures with a structured `failureCategory` and `retryable` boolean. |
| **OBS-PROD-6** | Observers **MUST NOT** infer one observation type from another. Each observation is independently produced. |
| **OBS-PROD-7** | Observers **MUST NOT** mutate placement records, bindings, or lifecycle events. |

### 4.2 Persistence

| ID | Constraint |
|----|------------|
| **OBS-PERSIST-1** | The store **MUST** append observations using `INSERT ... ON CONFLICT ... DO UPDATE WHERE new.observedAt >= old.observedAt`. |
| **OBS-PERSIST-2** | The store **MUST NOT** delete observations. Observations are append-only history. |
| **OBS-PERSIST-3** | The store **MUST** reject observations with `observedAt` older than the current observation for the same scope. |
| **OBS-PERSIST-4** | The store **MUST** enforce scope constraints (e.g., exposure `accountScope` must match placement `accountScope`). |

### 4.3 Projection

| ID | Constraint |
|----|------------|
| **OBS-PROJ-1** | The control plane slice **MUST** project observations into facts using `newest()` (latest by `observedAt`). |
| **OBS-PROJ-2** | The control plane slice **MUST** compute `freshness` as `fresh`, `stale`, `unbounded`, or `missing`. |
| **OBS-PROJ-3** | The control plane slice **MUST** compute `effectiveState` as the observed state when `fresh`, otherwise `unknown`. |
| **OBS-PROJ-4** | The control plane slice **MUST** preserve `observedAt`, `expiresAt`, `failureCategory`, `retryable`, and `sourceId` in projected facts. |
| **OBS-PROJ-5** | The control plane slice **MUST** filter observations by scope before projection. |

### 4.4 Consumption

| ID | Constraint |
|----|------------|
| **OBS-CONSUME-1** | Consumers **MUST** treat projected facts as read-only evidence. |
| **OBS-CONSUME-2** | Consumers **MUST** respect `freshness` when deciding actions. |
| **OBS-CONSUME-3** | Consumers **MUST** treat `stale` or `unbounded` observations as triggering re-observation. |
| **OBS-CONSUME-4** | Consumers **MUST** treat `missing` observations as triggering placement creation or repair. |
| **OBS-CONSUME-5** | Consumers **MUST** treat `error` observations with `retryable=true` as candidates for re-observation. |

---

## 5. Freshness Semantics

### 5.1 Freshness Values

| Value | Condition | Meaning |
|-------|-----------|---------|
| `fresh` | `expiresAt > now` | Observation is valid and trusted |
| `stale` | `expiresAt <= now` | Observation has expired; effective state degrades to `unknown` |
| `unbounded` | `expiresAt` is not a safe integer | Observation has no explicit expiry; freshness cannot be determined |
| `missing` | `observedAt` is not a safe integer | Observation was never made or is malformed |

### 5.2 Freshness Rules

| ID | Constraint |
|----|------------|
| **OBS-FRESH-1** | Freshness **MUST** be computed as a pure function of `expiresAt` and `now`. |
| **OBS-FRESH-2** | Freshness **MUST NOT** depend on the observed state. A `ready` observation can be stale; a `degraded` observation can be fresh. |
| **OBS-FRESH-3** | When `freshness = stale`, the effective state **MUST** degrade to `unknown` regardless of the observed state. |
| **OBS-FRESH-4** | When `freshness = unbounded`, consumers **MUST** treat the observation as potentially stale and may trigger re-observation. |
| **OBS-FRESH-5** | When `freshness = missing`, consumers **MUST** treat the observation as never having been made. |
| **OBS-FRESH-6** | The `now` timestamp **MUST** be explicitly passed to consumers; observers **MUST NOT** use internal `Date.now()` for freshness computation. |

### 5.3 Effective State

The effective state is the state after applying freshness:

```
effectiveState(observedState, observation, now) =
  freshness(observation, now) == 'fresh' ? observedState : 'unknown'
```

| Observed State | Freshness | Effective State |
|---------------|-----------|-----------------|
| `ready` | `fresh` | `ready` |
| `ready` | `stale` | `unknown` |
| `visible` | `fresh` | `visible` |
| `visible` | `stale` | `unknown` |
| `present` | `fresh` | `present` |
| `present` | `stale` | `unknown` |
| `missing` | `fresh` | `missing` |
| `error` | `fresh` | `error` |

**Key insight:** Staleness degrades all states to `unknown` except `error` and `missing` which are themselves terminal signals. An `error` observation that is fresh is still an error; a `missing` observation that is fresh is still missing.

---

## 6. Stale vs Missing vs Invalid

### 6.1 Distinction

| Condition | Freshness | Observed State | Meaning |
|-----------|-----------|----------------|---------|
| **Stale** | `stale` | Any (except `missing`/`error`) | Observation was valid but has expired. Reality may have changed. |
| **Missing** | `missing` | N/A | No observation exists for this scope. Reality is unknown. |
| **Invalid** | `fresh` | `error` | Observation was attempted but failed. Reality is unreachable. |

### 6.2 Semantic Rules

| ID | Constraint |
|----|------------|
| **OBS-DISTINCT-1** | Stale observations **MUST NOT** be treated as evidence of current state. They indicate "I once saw this, but I don't know if it's still true." |
| **OBS-DISTINCT-2** | Missing observations **MUST NOT** be treated as evidence of absence. They indicate "I have no information about this." |
| **OBS-DISTINCT-3** | Invalid observations (fresh `error`) **MUST** be treated as evidence of reachability failure. The external system could not be queried. |
| **OBS-DISTINCT-4** | Stale observations **MAY** be used as hints for re-observation targeting (e.g., "re-observe the placement I saw before"). |
| **OBS-DISTINCT-5** | Missing observations **MUST** trigger creation flows (create placement, observe exposure) rather than repair flows. |
| **OBS-DISTINCT-6** | Invalid observations with `retryable=true` **MUST** trigger re-observation. Invalid observations with `retryable=false` **MUST** trigger failure classification. |

### 6.3 Consumer Interpretation

| Observation Condition | Reconciler Interpretation | Repair Planner Interpretation |
|----------------------|---------------------------|------------------------------|
| Fresh `ready` | Placement is usable | No trigger |
| Stale `ready` | Re-observe placement | `broken-provider-observation` if persistent |
| Missing placement | Create placement | `missing-provider-placement` |
| Fresh `error` (retryable) | Re-observe after delay | `broken-provider-observation` |
| Fresh `error` (not retryable) | Mark degraded | `broken-provider-observation` |
| Fresh `visible` exposure | Exposure is usable | No trigger |
| Stale `visible` exposure | Re-observe exposure | `missing-filesystem-exposure` if persistent |
| Missing exposure | Observe exposure | `missing-filesystem-exposure` |
| Fresh `broken_torrent` Zurg | N/A (not a placement authority) | `stale-zurg-metadata-state` |

---

## 7. Provider Observer Boundaries

### 7.1 Real-Debrid Observer

| Aspect | Definition |
|--------|------------|
| **Capabilities** | `placement-lookup`, `resource-readiness`, `file-inventory`, `file-selection`, `repair-request` |
| **Scope** | `(provider=realdebrid, accountScope)` |
| **TTL** | Default 60 seconds (`observationTtlMs = 60_000`) |
| **Identity** | Operates on `infoHash` (torrent-level); does not map `fileIndex` |
| **Authority** | Provider-authoritative for placement, readiness, inventory, file selection |

| ID | Constraint |
|----|------------|
| **OBS-RD-1** | The Real-Debrid observer **MUST** produce placement lookup observations with `observationState` = `present`, `missing`, or `error`. |
| **OBS-RD-2** | The Real-Debrid observer **MUST** produce readiness observations with `state` = `pending`, `ready`, `degraded`, `error`, `removed`, `unknown`. |
| **OBS-RD-3** | The Real-Debrid observer **MUST** produce inventory snapshots with `authoritative` and `complete` flags. |
| **OBS-RD-4** | The Real-Debrid observer **MUST** classify provider errors using `classifyProviderError()` with structured `failureCategory` and `retryable`. |
| **OBS-RD-5** | The Real-Debrid observer **MUST NOT** observe filesystem exposures. Exposure observation is the filesystem observer's responsibility. |
| **OBS-RD-6** | The Real-Debrid observer **MUST NOT** observe Zurg metadata. Zurg metadata observation is the Zurg metadata observer's responsibility. |
| **OBS-RD-7** | The Real-Debrid observer **MUST NOT** mutate bindings or lifecycle events. |

### 7.2 TorBox Observer

| Aspect | Definition |
|--------|------------|
| **Capabilities** | `resource-readiness`, `file-inventory` |
| **Scope** | `(provider=torbox, accountScope)` |
| **TTL** | Default 60 seconds |
| **Authority** | Provider-authoritative for readiness and inventory |

| ID | Constraint |
|----|------------|
| **OBS-TB-1** | The TorBox observer **MUST** produce readiness observations with the same state vocabulary as Real-Debrid. |
| **OBS-TB-2** | The TorBox observer **MUST** produce inventory snapshots with `authoritative` and `complete` flags. |
| **OBS-TB-3** | The TorBox observer **MUST NOT** observe filesystem exposures or Zurg metadata. |

### 7.3 Provider Observer Isolation

| ID | Constraint |
|----|------------|
| **OBS-PROV-ISOL-1** | Provider observers **MUST** be scoped to a single `provider` and `accountScope`. |
| **OBS-PROV-ISOL-2** | Provider observers **MUST NOT** observe across provider boundaries. A Real-Debrid observer must not produce TorBox observations. |
| **OBS-PROV-ISOL-3** | Provider observers **MUST NOT** depend on each other. Real-Debrid and TorBox observers are independent. |
| **OBS-PROV-ISOL-4** | Provider observers **MUST** validate resource identity (`infoHash`) and scope (`provider`, `accountScope`) before producing observations. |

---

## 8. Filesystem Observer Boundaries

### 8.1 Filesystem Exposure Observer

| Aspect | Definition |
|--------|------------|
| **Capability** | `exposure` |
| **Scope** | `(provider, accountScope, mountScope, transport)` |
| **TTL** | Default 30 seconds (`exposureTtlMs = 30_000`) |
| **Transport** | Read-only filesystem (e.g., Zurg WebDAV mount, rclone mount) |
| **Authority** | Filesystem-authoritative for path visibility only |

| ID | Constraint |
|----|------------|
| **OBS-FS-1** | The filesystem exposure observer **MUST** produce exposure observations with `state` = `visible`, `missing`, or `error`. |
| **OBS-FS-2** | The filesystem exposure observer **MUST** require `readOnly = true` for the transport. |
| **OBS-FS-3** | The filesystem exposure observer **MUST** validate that `relativePath` remains under `rootPath` (no path traversal). |
| **OBS-FS-4** | The filesystem exposure observer **MUST** classify filesystem errors using `classifyFilesystemError()` with structured `failureCategory` and `retryable`. |
| **OBS-FS-5** | The filesystem exposure observer **MUST NOT** claim provider placement authority. A missing exposure does not mean the provider deleted the resource. |
| **OBS-FS-6** | The filesystem exposure observer **MUST NOT** claim Zurg metadata authority. Exposure observation is path visibility only. |
| **OBS-FS-7** | The filesystem exposure observer **MUST NOT** observe Zurg `.zurgtorrent` files. Zurg metadata observation is the Zurg metadata observer's responsibility. |

### 8.2 Zurg Metadata Observer

| Aspect | Definition |
|--------|------------|
| **Capability** | `observe-zurg-metadata` |
| **Scope** | `(provider=realdebrid, accountScope, instanceScope)` |
| **TTL** | Default 30 seconds (`observationTtlMs = 30_000`) |
| **Data path** | Read-only view of Zurg's data directory |
| **Authority** | Zurg-authoritative for torrent-level metadata only |

| ID | Constraint |
|----|------------|
| **OBS-ZURG-1** | The Zurg metadata observer **MUST** produce metadata observations with `observationState` = `present`, `missing`, or `error`. |
| **OBS-ZURG-2** | The Zurg metadata observer **MUST** require `readOnly = true` for the data path. |
| **OBS-ZURG-3** | The Zurg metadata observer **MUST** validate that `metadataPath` remains under `dataPath` (no path traversal). |
| **OBS-ZURG-4** | The Zurg metadata observer **MUST** reject symbolic links, non-files, and files exceeding `maxMetadataBytes`. |
| **OBS-ZURG-5** | The Zurg metadata observer **MUST** sanitize output: raw links and Zurg's provider-resource tracking sets are never returned. |
| **OBS-ZURG-6** | The Zurg metadata observer **MUST NOT** claim Real-Debrid placement authority. Zurg state is evidence, not authoritative provider state. |
| **OBS-ZURG-7** | The Zurg metadata observer **MUST NOT** claim filesystem exposure authority. Zurg metadata does not prove path visibility. |
| **OBS-ZURG-8** | The Zurg metadata observer **MUST NOT** observe provider readiness, inventory, or exposures. |

### 8.3 Filesystem Observer Isolation

| ID | Constraint |
|----|------------|
| **OBS-FS-ISOL-1** | Filesystem observers **MUST** be scoped to a single `transport` and `mountScope`. |
| **OBS-FS-ISOL-2** | Filesystem observers **MUST NOT** observe across transport boundaries. A Zurg mount observer must not produce WebDAV observations. |
| **OBS-FS-ISOL-3** | The filesystem exposure observer and Zurg metadata observer **MUST** be independent. One observes path visibility; the other observes torrent metadata. |
| **OBS-FS-ISOL-4** | Filesystem observers **MUST** validate path containment before any filesystem operation. |

---

## 9. What Consumers May See

### 9.1 Reconciler View

The reconciler consumes projected facts via the control plane slice:

| Fact | Source | Freshness-Aware |
|------|--------|-----------------|
| `placement` | `projectPlacement()` | Yes |
| `readiness` | `projectReadiness()` | Yes |
| `inventory` | `projectInventory()` | Yes |
| `zurgMetadata` | `projectZurgMetadata()` | Yes |
| `exposure` | `projectExposure()` | Yes |
| `exactFileMapping` | `projectExactMapping()` | No (uses `mappedAt`) |
| `binding` | `projectBinding()` | No (binding has its own freshness) |
| `cataloging` | `projectItemMilestone()` | No |
| `playback` | `projectItemMilestone()` | No |

| ID | Constraint |
|----|------------|
| **OBS-RECON-VIEW-1** | The reconciler **MUST** consume observations exclusively through the control plane slice projection. |
| **OBS-RECON-VIEW-2** | The reconciler **MUST** treat projected facts as read-only. |
| **OBS-RECON-VIEW-3** | The reconciler **MUST** respect `freshness` when evaluating placement, readiness, inventory, and exposure. |
| **OBS-RECON-VIEW-4** | The reconciler **MUST** treat `stale` or `unbounded` observations as triggering `observe-again`. |
| **OBS-RECON-VIEW-5** | The reconciler **MUST** treat `missing` observations as triggering `create-or-reuse-placement` or `observe-exposure`. |
| **OBS-RECON-VIEW-6** | The reconciler **MUST** treat `error` observations with `retryable=true` as candidates for `observe-again` after delay. |

### 9.2 Repair Planner View

The repair planner consumes the same projected facts plus lifecycle state:

| Input | Source | Purpose |
|-------|--------|---------|
| `snapshot.facts` | Control plane slice | Current observation state |
| `snapshot.currentBinding` | Store | Active binding (if any) |
| `lifecycle` | Store | Lifecycle milestone state |
| `scope` | Caller | Provider, account, instance, mount scope |
| `now` | Caller | Explicit evaluation time |

| ID | Constraint |
|----|------------|
| **OBS-PLAN-VIEW-1** | The repair planner **MUST** consume observations exclusively through the control plane slice projection. |
| **OBS-PLAN-VIEW-2** | The repair planner **MUST** interpret observation signals into triggers (e.g., `missing-provider-placement`, `broken-provider-observation`). |
| **OBS-PLAN-VIEW-3** | The repair planner **MUST** treat `stale` observations as potential triggers only when persistent (not transient). |
| **OBS-PLAN-VIEW-4** | The repair planner **MUST** treat `missing` exposures as `missing-filesystem-exposure` trigger, not as provider deletion. |
| **OBS-PLAN-VIEW-5** | The repair planner **MUST** treat `broken_torrent` Zurg state as `stale-zurg-metadata-state` trigger. |

### 9.3 Repair Executor View

The repair executor consumes observations via the same slice interface:

| ID | Constraint |
|----|------------|
| **OBS-EXEC-VIEW-1** | The repair executor **MUST** consume observations exclusively through the control plane slice. |
| **OBS-EXEC-VIEW-2** | The repair executor **MUST** re-project observations after each repair step to verify progress. |
| **OBS-EXEC-VIEW-3** | The repair executor **MUST** use `slice.getState()` to obtain fresh snapshots for postcondition verification. |

---

## 10. What the Reconciler May Assume

### 10.1 Assumptions

| ID | Constraint |
|----|------------|
| **OBS-RECON-ASSUME-1** | The reconciler **MAY** assume that `fresh` observations accurately reflect external reality at the time of observation. |
| **OBS-RECON-ASSUME-2** | The reconciler **MAY** assume that `stale` observations are not evidence of current state. |
| **OBS-RECON-ASSUME-3** | The reconciler **MAY** assume that `missing` observations indicate no evidence exists, not that the resource is absent. |
| **OBS-RECON-ASSUME-4** | The reconciler **MAY** assume that `error` observations with `retryable=true` are transient and may succeed on retry. |
| **OBS-RECON-ASSUME-5** | The reconciler **MAY** assume that `error` observations with `retryable=false` indicate permanent failure. |
| **OBS-RECON-ASSUME-6** | The reconciler **MAY** assume that observations are scoped correctly by the observer (provider, accountScope, instanceScope, mountScope). |
| **OBS-RECON-ASSUME-7** | The reconciler **MAY** assume that the control plane slice returns the newest observation for each scope. |
| **OBS-RECON-ASSUME-8** | The reconciler **MAY** assume that `effectiveState` correctly degrades stale observations to `unknown`. |

### 10.2 Non-Assumptions

| ID | Constraint |
|----|------------|
| **OBS-RECON-NO-ASSUME-1** | The reconciler **MUST NOT** assume that a `missing` exposure means the provider deleted the resource. (MATERIALIZATION-ARCHITECTURE-V2 §10.4) |
| **OBS-RECON-NO-ASSUME-2** | The reconciler **MUST NOT** assume that Zurg metadata state is authoritative for provider placement state. |
| **OBS-RECON-NO-ASSUME-3** | The reconciler **MUST NOT** assume that a `fresh` `ready` observation means the exposure is visible. Readiness and exposure are orthogonal. |
| **OBS-RECON-NO-ASSUME-4** | The reconciler **MUST NOT** assume that a `present` placement lookup means the placement is ready. Placement existence and readiness are orthogonal. |
| **OBS-RECON-NO-ASSUME-5** | The reconciler **MUST NOT** assume that observations from different scopes can be combined. Each scope is independent. |

---

## 11. Forbidden Responsibilities

### 11.1 Observer Prohibitions

| ID | Constraint |
|----|------------|
| **OBS-FORBID-1** | Observers **MUST NOT** create, update, or delete bindings. |
| **OBS-FORBID-2** | Observers **MUST NOT** create, update, or delete lifecycle events. |
| **OBS-FORBID-3** | Observers **MUST NOT** create, update, or delete repair transactions. |
| **OBS-FORBID-4** | Observers **MUST NOT** create, update, or delete placements. (Observers produce placement *observations*; the store creates placements.) |
| **OBS-FORBID-5** | Observers **MUST NOT** infer one observation type from another. Each observation is independently produced. |
| **OBS-FORBID-6** | Observers **MUST NOT** observe across provider boundaries. |
| **OBS-FORBID-7** | Observers **MUST NOT** observe across scope boundaries. |
| **OBS-FORBID-8** | Observers **MUST NOT** use internal `Date.now()` for freshness computation. Time must be explicitly injected. |
| **OBS-FORBID-9** | Observers **MUST NOT** return raw provider-internal data (e.g., raw links, provider resource tracking sets). |
| **OBS-FORBID-10** | Observers **MUST NOT** claim authority they do not possess. Filesystem observers do not claim provider authority; Zurg observers do not claim exposure authority. |
| **OBS-FORBID-11** | Observers **MUST NOT** traverse path boundaries. All paths must be contained within the configured root. |
| **OBS-FORBID-12** | Observers **MUST NOT** write to the filesystem. All filesystem access is read-only. |
| **OBS-FORBID-13** | Observers **MUST NOT** cache observations. Caching is the store's responsibility. |
| **OBS-FORBID-14** | Observers **MUST NOT** delete observations. Observations are append-only. |
| **OBS-FORBID-15** | Observers **MUST NOT** mutate their inputs. All inputs are read-only. |

### 11.2 Consumer Prohibitions

| ID | Constraint |
|----|------------|
| **OBS-CONSUMER-FORBID-1** | Consumers **MUST NOT** treat observations as authoritative for materialization state. The control plane is authoritative. |
| **OBS-CONSUMER-FORBID-2** | Consumers **MUST NOT** treat `stale` observations as evidence of current state. |
| **OBS-CONSUMER-FORBID-3** | Consumers **MUST NOT** treat `missing` observations as evidence of absence. |
| **OBS-CONSUMER-FORBID-4** | Consumers **MUST NOT** bypass the control plane slice to read raw observations. |
| **OBS-CONSUMER-FORBID-5** | Consumers **MUST NOT** produce observations. Only observers produce observations. |

---

## 12. Relationships to Other Contracts

### 12.1 Reconciler Contract

| ID | Constraint |
|----|------------|
| **OBS-REL-RECON-1** | The observation contract **MUST** provide the evidence layer that the reconciler consumes. |
| **OBS-REL-RECON-2** | The reconciler's `observe-again` action **MUST** trigger re-observation by the appropriate observer. |
| **OBS-REL-RECON-3** | The reconciler's `mark-degraded` action **MUST** be triggered when observations indicate unhealthy state that cannot be resolved by re-observation. |
| **OBS-REL-RECON-4** | The reconciler's freshness evaluation (`evaluateExpiry`) **MUST** be consistent with the observation contract's freshness semantics. |

### 12.2 Repair Planner Contract

| ID | Constraint |
|----|------------|
| **OBS-REL-PLAN-1** | The observation contract **MUST** provide the evidence layer that the repair planner interprets into triggers. |
| **OBS-REL-PLAN-2** | The repair planner's trigger detection **MUST** be a pure function of projected observation facts. |
| **OBS-REL-PLAN-3** | The repair planner's `expectedPostconditions` **MUST** define what observations should look like after successful repair. |

### 12.3 Repair Executor Contract

| ID | Constraint |
|----|------------|
| **OBS-REL-EXEC-1** | The repair executor **MUST** re-observe after each repair step to verify progress. |
| **OBS-REL-EXEC-2** | The repair executor's postcondition verification **MUST** use fresh observations to confirm healthy state. |
| **OBS-REL-EXEC-3** | The repair executor's `reobserve-provider-state` action **MUST** trigger the appropriate provider observer. |
| **OBS-REL-EXEC-4** | The repair executor's `reobserve-filesystem-exposure` action **MUST** trigger the filesystem exposure observer. |
| **OBS-REL-EXEC-5** | The repair executor's `reobserve-zurg-metadata` action **MUST** trigger the Zurg metadata observer. |

### 12.4 Binding State Contract

| ID | Constraint |
|----|------------|
| **OBS-REL-BIND-1** | Observations **MUST NOT** directly mutate bindings. Bindings are mutated only by `store.activateBinding()`. |
| **OBS-REL-BIND-2** | The binding state contract's `activateBinding()` **MUST** validate that observations (readiness, exposure, mapping) are fresh before creating a binding. |
| **OBS-REL-BIND-3** | The control plane slice's `projectBinding()` **MUST** detect binding degradation by comparing binding target against newest observations. |

### 12.5 Materialization Architecture V2

| ID | Constraint |
|----|------------|
| **OBS-REL-ARCH-1** | The observation contract **MUST** respect the architecture's ownership boundaries (§3). |
| **OBS-REL-ARCH-2** | The observation contract **MUST** respect the architecture's separation invariants (§10.2): placement is not exposure, exposure is not binding. |
| **OBS-REL-ARCH-3** | The observation contract **MUST** respect the architecture's observation invariants (§10.4): observations are scoped and expiring, append-only, missing exposure is not provider deletion, Zurg metadata is not provider authority. |

---

## 13. Future Dependencies

### 13.1 Multi-Provider Observation

Future work may introduce multi-provider observation coordination:

- **Cross-provider deduplication**: Avoid re-observing the same hash on multiple providers simultaneously.
- **Provider preference ordering**: Observe preferred providers first.
- **Rate limit awareness**: Coordinate observation timing across providers to respect rate limits.

### 13.2 Observation Caching

Future work may introduce observation caching at the observer level:

- **Negative caching**: Cache `missing` observations to avoid repeated lookups.
- **Positive caching**: Cache `present` observations with shorter TTLs for frequently accessed content.
- **Cache invalidation**: Explicit invalidation on repair actions that modify provider state.

### 13.3 Observation History

Future work may expose observation history to consumers:

- **Trend analysis**: Detect flapping (alternating `ready`/`degraded`) over time.
- **Freshness histograms**: Track observation freshness distribution for reliability metrics.
- **Failure correlation**: Correlate failures across observation types to identify root causes.

---

## 14. Compliance Verification

### 14.1 Observer Compliance

To verify observer compliance with this contract:

1. **Scope validation**: Confirm every observation carries explicit `provider`, `accountScope`, and where applicable `instanceScope`, `mountScope`.
2. **Freshness validation**: Confirm every observation carries `observedAt` and `expiresAt` (or `ttlMs`).
3. **Failure classification**: Confirm every error observation carries structured `failureCategory` and `retryable`.
4. **Authority isolation**: Confirm filesystem observers do not claim provider authority; Zurg observers do not claim exposure authority.
5. **Path containment**: Confirm all filesystem paths are validated to remain under the configured root.
6. **Read-only enforcement**: Confirm observers never write to the filesystem or mutate control plane state.

### 14.2 Consumer Compliance

To verify consumer compliance with this contract:

1. **Slice mediation**: Confirm all consumers access observations exclusively through the control plane slice.
2. **Freshness respect**: Confirm consumers respect `freshness` when evaluating observations.
3. **No observation production**: Confirm consumers never produce observations.
4. **No stale evidence**: Confirm consumers never treat `stale` observations as current state.
5. **No missing-as-absence**: Confirm consumers never treat `missing` observations as evidence of absence.

### 14.3 Store Compliance

To verify store compliance with this contract:

1. **Append-only**: Confirm observations are never deleted.
2. **Monotonic `observedAt`**: Confirm newer observations always have `observedAt >=` older observations for the same scope.
3. **Scope enforcement**: Confirm scope constraints are validated on insert.
4. **Freshness computation**: Confirm `expiresAt` is computed correctly from `observedAt + ttlMs` when only `ttlMs` is provided.

---

## 15. Relationship to Prior Documents

### 15.1 Documents This Contract Complements

| Document | Relationship |
|----------|--------------|
| `MATERIALIZATION-ARCHITECTURE-V2.md` | Defines materialization layer; this contract defines the observation layer within it |
| `MATERIALIZATION-REGISTRY-SCHEMA.md` | Defines schema; this contract defines observation lifecycle constraints on that schema |
| `RECONCILER-CONTRACT.md` | Defines routine reconciliation; this contract defines the evidence layer reconciler consumes |
| `REPAIR-PLANNER-CONTRACT.md` | Defines repair planning; this contract defines the evidence layer planner interprets |
| `BINDING-STATE-CONTRACT.md` | Defines binding lifecycle; this contract defines the observations that feed binding creation |
| `CONTRACTS.md` | Defines layer interfaces; this contract defines the observation interface specifically |

### 15.2 Documents This Contract Supersedes

This contract does not supersede any existing documents. It formalizes observation semantics that were previously implicit in the codebase.

### 15.3 Documents This Contract Depends On

| Document | Dependency |
|----------|------------|
| `MATERIALIZATION-ARCHITECTURE-V2.md` | §3 ownership boundaries, §10.4 observation invariants |
| `MATERIALIZATION-REGISTRY-SCHEMA.md` | §3.2 placement layer, §3.3 materialization registry |
| `RECONCILER-CONTRACT.md` | §3 input contract, §4 reconciliation actions |
| `REPAIR-PLANNER-CONTRACT.md` | §3 planner input contract, §5 triggers |
| `BINDING-STATE-CONTRACT.md` | §2.1 who may mutate bindings, §3 binding identity |

---

## Appendix A: Observation State Vocabulary

### A.1 Placement Lookup States

| State | Meaning |
|-------|---------|
| `present` | Provider has a placement for this hash |
| `missing` | Provider has no placement for this hash |
| `error` | Provider lookup failed |

### A.2 Readiness States

| State | Meaning |
|-------|---------|
| `pending` | Provider processing placement |
| `ready` | Placement can serve bytes |
| `degraded` | Placement degraded but not failed |
| `error` | Provider reports error |
| `removed` | Placement removed by provider |
| `unknown` | Readiness unknown |

### A.3 Exposure States

| State | Meaning |
|-------|---------|
| `pending` | Exposure observed but not confirmed |
| `visible` | File is visible on transport |
| `missing` | File not visible on transport |
| `degraded` | Exposure degraded |
| `error` | Observation failed |
| `unknown` | Exposure state unknown |

### A.4 Zurg Metadata States

| State | Meaning |
|-------|---------|
| `present` | .zurgtorrent file exists and was parsed |
| `missing` | .zurgtorrent file not found |
| `error` | .zurgtorrent read/parse failed |

### A.5 Inventory Authority

| authoritative | complete | Meaning |
|--------------|----------|---------|
| `true` | `true` | Trusted complete inventory |
| `true` | `false` | Trusted incomplete inventory |
| `false` | `true` | Untrusted complete inventory |
| `false` | `false` | Untrusted incomplete inventory |

---

## Appendix B: Freshness Computation Reference

```
freshness(observation, now):
  if !isSafeInteger(observation.expiresAt):
    return 'unbounded'
  if observation.expiresAt > now:
    return 'fresh'
  else:
    return 'stale'

effectiveState(observedState, observation, now):
  if freshness(observation, now) == 'fresh':
    return observedState
  else:
    return 'unknown'

evaluateExpiry(observedAt, expiresAt, now):
  if !isSafeInteger(observedAt):
    return 'missing'
  if !isSafeInteger(expiresAt):
    return 'unbounded'
  if expiresAt > now:
    return 'fresh'
  else:
    return 'stale'
```

---

## Appendix C: Scope Isolation Matrix

| Observer | provider | accountScope | instanceScope | mountScope | transport |
|----------|----------|--------------|---------------|------------|-----------|
| Real-Debrid | ✓ | ✓ | — | — | — |
| TorBox | ✓ | ✓ | — | — | — |
| Filesystem Exposure | ✓ | ✓ | — | ✓ | ✓ |
| Zurg Metadata | ✓ | ✓ | ✓ | — | — |

Key: ✓ = scoped by this dimension; — = not applicable to this observer.

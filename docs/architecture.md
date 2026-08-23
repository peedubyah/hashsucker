# Architecture

**Verified baseline:** 2026-08-21. This document deliberately separates current implementation from target architecture.

## System purpose

HashSucker is evolving from a discovery-plus-local-import prototype into a control plane that turns a large hash corpus into provider-backed, stable virtual-library items. It should decide what media and release are wanted, minimize costly provider checks, own placements and canonical bindings, and observe fulfillment health. Mature external systems should transport bytes.

## Current implementation

```mermaid
flowchart LR
    UI["React/Vite UI\nbuilt into media-search image"]
    API["media-search Node API\nloopback default, no application auth"]
    META["Cinemeta metadata"]
    LOCAL["SQLite FTS retrieval\nnot selected-media scoped"]
    SCORE["Local six-part rank"]
    LIVE["Torrentio / Comet / Torznab"]
    MERGE["Exact releaseKey merge\nlive score = 0"]
    DB[("Discovery SQLite\npersistent Compose volume")]
    DMM["DMM fragments"]
    INGEST["HTTP ingestion\nwrapper mismatch"]
    QUEUE["Filesystem queue"]
    IMPORTER["torbox-importer"]
    TORBOX["TorBox"]
    ARR["Sonarr / Radarr"]

    UI --> API
    API --> META
    API --> LOCAL --> SCORE --> MERGE
    LOCAL --> DB
    API --> LIVE --> MERGE
    DMM --> INGEST --> DB
    API --> QUEUE --> IMPORTER --> TORBOX
    IMPORTER --> ARR
```

### Current components

- **`media-search`** owns metadata lookup, discovery storage, local retrieval/ranking, live-source normalization, request publication, operator-triggered ingestion/attribute work, and same-origin static UI serving in production.
- **Discovery SQLite** separates exact candidates, parsed release evidence, media associations, append-only provider observation history/current projection, and FTS data. Root deployment persists it at `/data/discovery-cache.db` on the `discovery-data` volume.
- **Provider capability foundation** exposes cache observation, placement lookup/create, readiness, file inventory, explicit known-file selection, explicit repair requests, exposure, and removal as independent optional capabilities with typed errors. TorBox currently implements authoritative cache observation plus a fixture-verified account inventory boundary; Real-Debrid has injected observation and controlled-mutation boundaries but no fabricated direct HTTP implementation.
- **Read-only transport observation foundations** include exact filesystem-path observers for externally managed Zurg/rclone and TorBox WebDAV/rclone mounts. A separate explicit-path Zurg `.zurgtorrent` observer exposes sanitized torrent/file repair metadata without claiming Real-Debrid placement authority or mount visibility. Neither observer is wired to a live deployment.
- **Stage 6 repair control plane** detects degraded exact bindings from scoped evidence, creates durable deterministic ordered repair plans, requires separate action authorization, records durable step attempts/results, and invokes only injected mockable capabilities. Successful steps resume after restart; an in-flight operation with unknown outcome fails closed for manual resolution rather than being replayed. It does not automatically delete provider resources, mutate catalog/playback state, or construct a live credentialed gateway.
- **`ui`** is a React/Vite prototype built into the production `media-search` image; Vite remains separate for local development.
- **`torbox-importer`** starts its worker by default and owns physical TorBox acquisition, staging, provider/hash reconciliation, file selection, Arr validation/import, settlement, and conservative cleanup.
- **Filesystem queue** is the authority for physical-acquisition ownership and terminal movement.

### Current strengths

- Candidate storage and public request flow use exact `(infoHash, fileIndex)` identity with canonical `releaseKey`; null file index remains distinct from zero.
- Release evidence, media associations, and provider observations are separate tables.
- FTS synchronization is trigger-driven.
- Live source failures are isolated.
- Queue publication and claiming are atomic filesystem operations.
- The importer persists exact release provenance while retaining provider-authoritative file mapping, and validates explicit intent, provider identity, file size, Arr identity, and post-import state.

### Current divergence

- Selected media identity reaches live discovery but not local corpus filtering.
- SQL limits local candidates before composite ranking.
- Only local candidates receive the six-component score; there is no global rerank after merging.
- Provider observations now carry scope, authority kind, TTL/freshness, source, typed error/retry metadata, append-only history, and a current projection. Only fresh authoritative observations can affect the legacy provider ranking component; the active API path does not yet expose the full model consistently.
- The legacy active search path still calls the direct TorBox checker instead of the new capability adapter; no fixture-verified direct Real-Debrid HTTP gateway exists.
- Zurg static evidence confirms mutable repair resource IDs, durable `.zurgtorrent` state, restart cleanup, and rename side effects, but no pinned live Zurg/rclone deployment or controlled provider experiment exists. See [`evaluation/ZURG-REPAIR-EVIDENCE-2026-08-22.md`](evaluation/ZURG-REPAIR-EVIDENCE-2026-08-22.md).
- DMM source compatibility exists in an unwired module, not in the API-reachable ingestion runner.
- No current component models virtual placement through playable catalog state.

## Target architecture

```mermaid
flowchart LR
    INTENT["Canonical movie/episode intent"]
    CORPUS["Large persistent hash corpus"]
    INTEL["Release/media intelligence\ndesirability + evidence"]
    PROBE["Provider-specific cache prior\nminimal authoritative probes"]
    CONTROL["HashSucker control plane\nplacement + file map + binding + reconcile"]
    RD["Real-Debrid placement"]
    TB["TorBox placement"]
    ZURG["Zurg WebDAV"]
    TBWEB["TorBox WebDAV\nafter validation"]
    MOUNTS["Hidden read-only rclone VFS mounts"]
    LIB["Stable provider-independent\ncanonical library"]
    CATALOG["Plex / players"]
    PHYSICAL["Local download + Arr import\nsecondary policy"]

    INTENT --> INTEL
    CORPUS --> INTEL --> PROBE --> CONTROL
    CONTROL --> RD --> ZURG --> MOUNTS
    CONTROL --> TB --> TBWEB --> MOUNTS
    MOUNTS --> LIB --> CATALOG
    CONTROL --> LIB
    CONTROL -. explicit fallback .-> PHYSICAL
```

### Control plane

HashSucker should own:

- canonical media intent and exact release identity;
- release parsing, desirability, evidence, and conservative release-family relationships;
- provider-specific cache priors and authoritative observation policy;
- placement lookup/creation and ownership provenance;
- provider-authoritative file inventories and exact candidate mapping;
- canonical library items, paths, binding versions, and reconciliation;
- catalog/playback milestones and typed outcome telemetry;
- explicit dispatch to physical acquisition when that policy is chosen.

Keep these logical capabilities in `media-search` initially. Run DMM synchronization as a one-shot command from the same image. Split reconciliation into a worker only when mount namespace, independent scheduling, fault isolation, or privilege separation requires it.

### Data plane

- Real-Debrid placement → Zurg WebDAV → rclone VFS.
- TorBox placement → native TorBox WebDAV → rclone VFS, only after its current contract is validated.
- Provider mounts remain hidden implementation details.
- HashSucker publishes a deterministic read-only canonical projection above those mounts.
- Plex or other players consume stable canonical paths.

Zurg, provider WebDAV, and rclone own byte delivery, seeking, buffering, and transport caching. `media-search` should not become a routine media relay.

### Canonical projection

The first implementation may use atomic symlink projection if filesystem/container/catalog tests prove it safe. A custom virtual filesystem is justified only if simple projection cannot provide atomic rebinding, stable paths, correct metadata, and acceptable scanner behavior.

Do not use rclone union as semantic identity. Union conflict and path-selection policies cannot enforce exact release choice, edition handling, placement preference, or provider failover.

### Lifecycle semantics

```text
requested → checked → placed → provider-ready → exposed
          → exact-file-mapped → bound → cataloged → playable
```

Each state needs its own status, timestamp, and failure category. Temporary provider or mount absence triggers bounded re-observation, not immediate deletion or an `uncached` label.

### Observation, repair, and reconciliation boundaries

1. **Observation** records scoped, expiring facts without side effects: placement lookup/readiness, authoritative file inventory, sanitized Zurg metadata, and exact read-only exposure.
2. **Repair planning** deterministically explains which evidence degraded an existing exact binding, which action types are permitted, and the required postconditions. Producing or persisting a plan performs no provider mutation.
3. **Repair execution** is a separate durable transaction. An operator/controller explicitly authorizes an order-preserving subset of permitted actions; each injected provider mutation must return a durable-idempotency guarantee and is followed by a separately ordered re-observation action. Failed attempts retain prior evidence and binding history; unknown in-flight outcomes require manual resolution.
4. **Reconciliation** validates fresh authoritative postconditions and may version the logical exact binding. It cannot rewrite `(infoHash,fileIndex)`, infer provider deletion from mount absence, or mutate catalog/playback milestones.

The Stage 6 executor is a controlled dependency-injected boundary, not active automation. No current server route or startup worker invokes it, and no live credentials are consumed by it.

## Stable boundaries

- Exact candidate identity survives every control-plane boundary.
- Provider state never becomes candidate identity.
- Desirability and cache likelihood are predictions/decisions; confirmed cache is an observation.
- A placement is not exposure; exposure is not a canonical binding; a binding is not catalog or playback success.
- Provider file inventory is authoritative for physical mapping after placement.
- HashSucker owns canonical virtual identity. Sonarr/Radarr own final identity in physical-import mode.
- Cleanup is disabled for unowned or ambiguously owned resources.
- Virtual state is transactional control-plane data, not shell queue state.

## External boundaries

| System | Boundary |
|---|---|
| Cinemeta | Current metadata provider behind an adapter |
| DMM | Corpus source; synchronization must become resumable and revision-aware |
| Torrentio/Comet/Torznab | Discovery evidence, not placement/file authority |
| TorBox/Real-Debrid | Provider-specific cache, placement, resource, and file capabilities |
| Zurg/provider WebDAV/rclone | Data-plane exposure and transport with explicit health/config contracts |
| Sonarr/Radarr | Physical-import authority; optional parsing/advice in virtual mode |
| Plex/players | Consumers of stable canonical paths; catalog/playback state remains observable |

## Explicit non-goals

- Database replacement before measurement.
- A graph database merely because relationships form a graph.
- Premature microservices.
- Hash/family-level candidate deduplication.
- Provider paths as library identity.
- Sonarr/Radarr completed-download import as a mandatory virtual path.
- A custom HTTP byte proxy as the default data plane.

See [`pipeline.md`](pipeline.md), [`data-model.md`](data-model.md), and [`roadmap.md`](roadmap.md) for flow, state, and implementation order.

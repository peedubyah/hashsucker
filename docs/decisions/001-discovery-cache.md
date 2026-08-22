# ADR 001: SQLite discovery cache with separate provider state

## Status

Accepted; partially operational. Originally implemented 2026-08-20, current consequences verified 2026-08-21.

## Context

HashSucker needs a local corpus for background ingestion, release parsing, media associations, retrieval/ranking, and independent provider observations. Provider cache state changes over time and differs by provider; it must not be embedded into release identity.

## Decision

Use Node.js `node:sqlite` in WAL mode for single-host discovery state.

- Exact candidate identity is `(info_hash, file_index_key)`; `-1` represents a null raw file index.
- Store candidates, parsed release attributes, media associations, provider observations, and FTS data separately.
- Key provider observations by exact candidate plus provider.
- Keep SQLite as the default until a reproducible corpus benchmark demonstrates an operational reason to change.

## Rationale

- Single-file persistence fits the intended single-host deployment and is straightforward to mount, inspect, and back up.
- Node 24 provides `node:sqlite` without a third-party native module.
- WAL permits concurrent reads while a single writer updates the corpus.
- Separating provider observations prevents one provider’s mutable state from corrupting candidate identity or leaking into another provider.

## Current reality

The read path, FTS retrieval, ranking, additional evidence tables, persistent root-Compose volume, and exact release identity through public/request/importer boundaries are implemented.

- Direct local execution uses an in-memory database when `DISCOVERY_DB` is unset; root Compose sets it to the persistent discovery volume.
- Observation `checked_at` is stored, but active ranking does not enforce freshness or expiry.
- There is no discovery schema-version/migration runner, busy timeout, explicit checkpoint lifecycle, run lock, or transaction API.

“SQLite discovery cache” describes the chosen storage architecture; it is not proof of provider freshness, media-scoped retrieval, or whole-corpus capacity.

## Consequences

### Positive

- Candidate, evidence, media identity, and provider state remain distinct.
- New providers do not require fields on candidate rows.
- FTS and relational queries can support a large local corpus without a separate database service.
- The model can grow toward placements/bindings/events while remaining single-host.

### Required follow-up

- Add schema versions/migrations and a bounded ingestion lifecycle.
- Define provider observation state, scope, TTL, error category, current projection, and event history.
- Benchmark measured whole-corpus ingestion/query/maintenance behavior before reconsidering storage.

## Rejected alternatives

| Alternative | Reason |
|---|---|
| Provider state embedded in candidates | Couples mutable, provider-specific observations to exact release identity |
| JSON files | Weak query/index/concurrency behavior |
| Redis | Adds an external service without durable relational evidence modeling |
| `better-sqlite3` | Unnecessary native dependency for the Node 24 target |
| Immediate Postgres/database migration | No measured workload demonstrates that SQLite is the limiting factor |

See [`../data-model.md`](../data-model.md) for current and target state and [`../roadmap.md`](../roadmap.md) for remediation order.

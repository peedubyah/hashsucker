# Materialization Registry Schema Specification

**Date:** 2026-08-23  
**Scope:** Persistence model between content identity and playback consumption  
**Complements:** `RESOLVER-DESIGN.md` (resolver endpoint), `PROVIDER-INTERFACE.md` (provider adapter contract)  
**Constraints:** No code; no SQL migrations; no providers; no WebDAV/FUSE/UI; schema design only

---

## 1. Problem Statement

The materialization layer needs its own registry — distinct from corpus tables, provider state, and consumer paths — because each of those layers has different ownership, stability, and lifecycle semantics.

### 1.1 Why Corpus Tables Cannot Hold Provider State

The corpus layer (defined in `corpus-db.js`) stores **discovery and identity**:

- `info_hash` + `file_index_key` — stable, provider-agnostic identity
- `release_attributes` — parsed metadata (title, year, resolution, codec, etc.)
- `release_search` — FTS5 index for text search
- `sources` — persistence evidence across corpus versions

**Problem:** Provider state is ephemeral, mutable, and provider-specific. Corpus tables are immutable snapshots of discovery evidence. Writing provider status into corpus tables would:

- Couple discovery to playback availability
- Mix stable identity with volatile placement state
- Break when providers fail, expire, or are replaced

**Conclusion:** Provider state lives in the registry, not the corpus.

### 1.2 Why Provider Resource IDs Cannot Be Canonical Identity

Real-Debrid uses opaque resource IDs (`ABC123DEF456`) that are:

- Provider-specific (different format for TorBox, Premiumize, etc.)
- Not portable across providers
- Not meaningful without provider context

**Problem:** If `resource_id` were canonical, switching providers would require re-identifying content. The corpus identity `(info_hash, file_index)` is content-derived and portable — it survives provider changes.

**Conclusion:** Provider resource IDs are **foreign keys** in the registry, not primary identity.

### 1.3 Why Playback URLs Cannot Be Permanent Records

Real-Debrid CDN URLs are ephemeral:

- TTL: ~24 hours
- Token-bound (cannot be reused after expiry)
- Provider-specific (different CDN per provider)

**Problem:** Storing playback URLs as permanent records would create a "stale URL" failure mode. The resolver must resolve URLs on-demand, not cache them indefinitely.

**Conclusion:** Playback URLs are **resolved on demand**, not stored long-term. The registry stores placement state and provider linkage, not URLs.

### 1.4 Why Placement State and Materialization State Are Different Concepts

**Placement state:** "I asked provider X to hold this content." (Provider's perspective)

**Materialization state:** "This content can currently become bytes." (Resolver's perspective)

These are orthogonal:

- Placement can be `complete` but materialization `failed` (URL expired, auth error)
- Placement can be `failed` but materialization `available` (cached URL still valid)
- Multiple placements can exist for one identity (multi-provider)

**Conclusion:** The registry tracks both placement and materialization state, but as distinct entities with distinct lifecycles.

---

## 2. Ownership Boundary

The materialization registry sits between four layers:

```
Corpus Identity
(info_hash + file_index)
          │
          ▼
Materialization Registry
          │
          +----------------+
          |                |
          v                v
Provider Placement     Resolver State
(resource_id)          (availability/lifecycle)
          │
          ▼
Playback Target
(ephemeral URL)
```

### 2.1 Corpus Layer

**Owns:**
- Hash identity (`info_hash`, `file_index`, `file_index_key`)
- Release metadata (title, year, resolution, codec, audio)
- Evidence (sources, persistence history)
- Search index (FTS5)

**Does NOT own:**
- Provider state
- Playback URLs
- Lifecycle state
- Repair history

### 2.2 Placement Layer

**Owns:**
- Acquisition intent (what content should be placed)
- Provider chosen (which provider to use)
- Placement request (when and how placement was initiated)
- Provider resource ID (opaque identifier from provider)

**Does NOT own:**
- Playback URLs
- Lifecycle state
- Repair decisions
- Consumer paths

### 2.3 Materialization Registry

**Owns:**
- Current playable state (`acquiring`, `available`, `expired`, `repairing`, `failed`)
- Provider linkage (which placement is active)
- URL freshness (when URL was last resolved, when it expires)
- Lifecycle state (current state machine position)
- Repair history (event log of state transitions)

**Does NOT own:**
- Corpus identity (referenced, not stored)
- Provider resource IDs (foreign keys only)
- Playback URLs (resolved on demand)
- Consumer paths (Plex, WebDAV, .strm are consumer layer)

### 2.4 Consumer Layer

**Owns:**
- Plex paths (folder structure, naming conventions)
- `.strm` files (file content with resolver URL)
- WebDAV views (directory listings, virtual paths)
- FUSE mounts (filesystem interface)

**Does NOT own:**
- Placement decisions
- Lifecycle state
- Provider state
- Resolver behavior

---

## 3. Core Entities

### 3.1 Media Identity

**Question:** Should this be a table or reference existing corpus tables?

**Answer:** Reference existing corpus tables. Do not duplicate identity.

**Rationale:**
- Corpus tables already define `(info_hash, file_index_key)` as stable identity
- Creating a surrogate ID would introduce a third identity layer
- Surrogate IDs add indirection without value in a single-resolver system

**Reference pattern:**

```sql
-- No media_identity table needed
-- Use FOREIGN KEY to corpus tables:
FOREIGN KEY (info_hash, file_index_key)
  REFERENCES candidates(info_hash, file_index_key)
```

**When surrogate IDs become valuable:**
- Multi-resolver federation (different registries, same content)
- Content-addressable storage (identity independent of info_hash)
- Cross-system synchronization

**Phase 1 verdict:** No surrogate ID. Reference corpus identity directly.

---

### 3.2 Placement Record

Represents: "I asked provider X to hold this content."

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `placement_id` | UUID | Surrogate primary key |
| `info_hash` | TEXT | Corpus identity (part of FK) |
| `file_index_key` | INTEGER | Corpus identity (part of FK); -1 for NULL |
| `provider` | TEXT | Provider name (`real-debrid`, `torbox`, etc.) |
| `provider_resource_id` | TEXT | Opaque resource ID from provider |
| `status` | TEXT | Provider's view: `pending`, `complete`, `failed` |
| `created_at` | TEXT | ISO8601 timestamp |
| `updated_at` | TEXT | ISO8601 timestamp |

**Key design decisions:**

1. **Multiple placements per identity:** Yes. One `(info_hash, file_index_key)` can have multiple placements across providers. This is the foundation for multi-provider failover.

2. **Active placement:** One placement is marked `active` at a time. The resolver uses the active placement for playback. If the active placement fails, the resolver can select an alternate placement.

3. **Provider resource ID is opaque:** The registry does not parse or interpret provider resource IDs. They are stored as strings and passed to the provider adapter as-is.

4. **Status is provider-facing:** `pending` = placement in progress, `complete` = provider confirmed holding content, `failed` = provider reports permanent failure.

**Schema:**

```sql
CREATE TABLE placements (
  placement_id TEXT PRIMARY KEY,  -- UUID
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  provider TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|complete|failed
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY (info_hash, file_index_key)
    REFERENCES candidates(info_hash, file_index_key)
);

-- Fast lookup by identity
CREATE INDEX idx_placements_identity
  ON placements(info_hash, file_index_key);

-- Fast lookup by provider resource (for provider adapter queries)
CREATE INDEX idx_placements_provider_resource
  ON placements(provider, provider_resource_id);
```

---

### 3.3 Materialization State

Represents: "This content can currently become bytes."

**Fields:**

| Field | Type | Description |
|-------|------|-------------|
| `info_hash` | TEXT | Corpus identity (PK, part of FK) |
| `file_index_key` | INTEGER | Corpus identity (PK, part of FK); -1 for NULL |
| `active_placement_id` | UUID | Which placement is currently used for playback |
| `state` | TEXT | Current lifecycle state |
| `resolved_at` | TEXT | ISO8601; when URL was last resolved (nullable) |
| `expires_at` | TEXT | ISO8601; when URL expires (nullable) |
| `failure_reason` | TEXT | Canonical failure reason (nullable) |
| `retry_count` | INTEGER | Number of refresh attempts |
| `max_retries` | INTEGER | Max refresh attempts before `failed` |
| `created_at` | TEXT | ISO8601 |
| `updated_at` | TEXT | ISO8601 |

**Key design decisions:**

1. **State is attached to identity, not placement.** If RD fails but TorBox succeeds, the identity's state is `available` (because one placement works). Placement-specific state is tracked via the placement record.

2. **State values:**
   - `acquiring` — placement in progress, not yet playable
   - `available` — has a valid URL, can become bytes
   - `expired` — URL expired, refresh needed
   - `repairing` — refresh/retry in progress
   - `failed` — no placement can produce bytes

3. **Resolved/expires timestamps track URL freshness.** The resolver checks freshness before each request. If `expires_at < now + buffer`, refresh is triggered.

4. **Failure reason is canonical:** Values like `no_seeders`, `auth_error`, `rate_limited`, `provider_error`, `not_found`. Provider-specific error codes are translated by the adapter.

**Schema:**

```sql
CREATE TABLE materialization_state (
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  active_placement_id TEXT,  -- nullable; NULL = no active placement
  state TEXT NOT NULL DEFAULT 'acquiring',
  resolved_at TEXT,
  expires_at TEXT,
  failure_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  PRIMARY KEY (info_hash, file_index_key),
  FOREIGN KEY (info_hash, file_index_key)
    REFERENCES candidates(info_hash, file_index_key),
  FOREIGN KEY (active_placement_id)
    REFERENCES placements(placement_id)
);

-- Fast lookup by state (for repair queries)
CREATE INDEX idx_mat_state
  ON materialization_state(state);
```

---

### 3.4 Playback Target Cache

**Question:** Should URLs be cached temporarily?

**Evaluation of options:**

| Option | Pros | Cons |
|--------|------|------|
| **A: Do not store URLs** | Simple; always fresh | Extra provider API call on every request |
| **B: Cache URLs temporarily** | Faster; fewer provider calls | Stale URL risk; extra storage |

**Tradeoff analysis:**

- RD URLs have ~24h TTL. Buffer of 2h means effective cache window is ~22h.
- Each cache hit avoids one `POST /unrestrict/link` call (rate-limited to 250 req/min).
- Cache invalidation is simple: TTL-based, no external events.
- Storage cost: ~200 bytes per URL (negligible).

**Decision:** **Option B — cache URLs temporarily.**

**Rationale:**
- Resolver performance matters: Plex seeks generate many small requests
- Rate limit is real: 250 req/min is easy to hit during library scans
- TTL-based invalidation is well-understood and low-risk

**Schema:**

```sql
CREATE TABLE resolved_urls (
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  placement_id TEXT NOT NULL,
  resolved_url TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  bytes INTEGER,
  content_type TEXT,
  
  PRIMARY KEY (info_hash, file_index_key),
  FOREIGN KEY (info_hash, file_index_key)
    REFERENCES candidates(info_hash, file_index_key),
  FOREIGN KEY (placement_id)
    REFERENCES placements(placement_id)
);

-- Fast expiry check
CREATE INDEX idx_resolved_urls_expires
  ON resolved_urls(expires_at);
```

**Note:** The `resolved_urls` table is a **performance cache**, not authoritative state. If the cache is empty or stale, the resolver calls the provider adapter to get a fresh URL. The resolver always checks `expires_at` before using a cached URL.

---

## 4. Identity Relationships

### 4.1 Relationship Model

```
One corpus identity (info_hash, file_index_key)
        │
        ├── placement A (Real-Debrid, resource_id=ABC123)
        │     status: complete
        │
        ├── placement B (TorBox, resource_id=XYZ789)
        │     status: complete
        │
        └── placement C (Premiumize, resource_id=DEF456)
              status: failed
```

### 4.2 Answers to Design Questions

**Is identity one-to-many with placements?**
Yes. One `(info_hash, file_index_key)` can have zero or more placements. Zero placements = no provider holds the content. Multiple placements = multi-provider redundancy.

**Can placements coexist?**
Yes. Placements are independent records. The registry does not enforce mutual exclusivity. This allows:
- Simultaneous multi-provider placement (belt-and-suspenders)
- Gradual migration (place on new provider before removing old)
- A/B testing provider quality

**How is preferred placement selected?**
1. Resolver queries `materialization_state.active_placement_id`
2. If active placement's state is `available`, use it
3. If active placement fails, resolver queries for other placements with `status=complete`
4. First working placement becomes the new active placement
5. If no placement works, state → `failed`

**Active placement is stored in `materialization_state.active_placement_id`.**

### 4.3 Selection Ownership

**Question:** Does resolver pick, or does placement layer pick?

**Answer:** Placement layer picks. Resolver executes.

- **Placement layer** decides which provider to use based on cost, speed, reliability, user preference
- **Resolver** decides which placement to use based on current availability (failover)
- If active placement is `available`, resolver does not switch
- If active placement fails, resolver picks the next available placement

---

## 5. Lifecycle Storage

### 5.1 Current State

The `materialization_state` table stores the current state machine position:

```
unknown → acquiring → available → expired → repairing → failed
```

### 5.2 Append-Only History

**Question:** Why maintain an event log?

**Answer:** Event history matters because:

1. **Repair orchestration:** A future repair process needs to know: how many times has this failed? What was the failure pattern? Has the same provider failed repeatedly?

2. **Observability:** Operators (and future debugging) need to see the sequence of state transitions, not just the current state.

3. **Audit trail:** For multi-provider failover, understanding why the resolver switched providers requires historical context.

4. **Rate limit analysis:** Tracking refresh frequency helps detect rate limit exhaustion before it becomes a failure.

### 5.3 Event Schema

| Field | Type | Description |
|-------|------|-------------|
| `event_id` | TEXT | UUID primary key |
| `event_type` | TEXT | `state_transition`, `refresh_attempt`, `repair_attempt`, `placement_switch` |
| `info_hash` | TEXT | Corpus identity |
| `file_index_key` | INTEGER | Corpus identity |
| `from_state` | TEXT | Previous lifecycle state (nullable) |
| `to_state` | TEXT | New lifecycle state |
| `trigger` | TEXT | What caused the transition: `resolver_request`, `refresh_timer`, `provider_error`, `manual_repair` |
| `provider` | TEXT | Provider name |
| `resource_id` | TEXT | Provider resource ID |
| `placement_id` | TEXT | Placement UUID |
| `failure_reason` | TEXT | Canonical failure reason (if applicable) |
| `timestamp` | TEXT | ISO8601 |

**Schema:**

```sql
CREATE TABLE materialization_events (
  event_id TEXT PRIMARY KEY,  -- UUID
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  
  from_state TEXT,
  to_state TEXT,
  trigger TEXT,
  
  provider TEXT,
  resource_id TEXT,
  placement_id TEXT,
  
  failure_reason TEXT,
  
  FOREIGN KEY (info_hash, file_index_key)
    REFERENCES candidates(info_hash, file_index_key),
  FOREIGN KEY (placement_id)
    REFERENCES placements(placement_id)
);

-- Fast query by identity and time range
CREATE INDEX idx_events_identity_time
  ON materialization_events(info_hash, file_index_key, timestamp);

-- Fast query by state transition type
CREATE INDEX idx_events_type
  ON materialization_events(event_type, timestamp);
```

### 5.4 Why Append-Only?

- Immutable history: no updates, no deletes
- Time-range queries: "show all failures in the last 24h"
- Pattern detection: "same provider failing repeatedly"
- Performance: append-only writes are fast (no lock contention)

---

## 6. Resolver Query Patterns

### 6.1 Request Playback

**Input:** `(info_hash, file_index)` from `GET /media/{info_hash}/{file_index}`

**Steps:**

```sql
-- 1. Find active placement and current state
SELECT
  ms.state,
  ms.active_placement_id,
  ms.resolved_at,
  ms.expires_at,
  p.provider,
  p.provider_resource_id
FROM materialization_state ms
LEFT JOIN placements p ON p.placement_id = ms.active_placement_id
WHERE ms.info_hash = ?
  AND ms.file_index_key = ?;

-- 2. Check URL freshness (if available state)
SELECT resolved_url, expires_at
FROM resolved_urls
WHERE info_hash = ?
  AND file_index_key = ?
  AND expires_at > datetime('now', '+2 hours');
```

**Logic:**
1. If state = `available` and URL is fresh → return cached URL (302 redirect)
2. If state = `available` and URL is stale → call `provider.refresh()`, update cache
3. If state = `acquiring` → return 503 with `Retry-After`
4. If state = `expired` → call `provider.refresh()`, transition to `available`
5. If state = `repairing` → return 423 with `Retry-After`
6. If state = `failed` → return 410 with failure reason
7. If no state record → return 404

---

### 6.2 URL Refresh

**Trigger:** `expires_at < now + buffer_seconds` (default buffer = 7200s)

**Steps:**

```sql
-- 1. Find active placement
SELECT
  ms.active_placement_id,
  p.provider,
  p.provider_resource_id
FROM materialization_state ms
LEFT JOIN placements p ON p.placement_id = ms.active_placement_id
WHERE ms.info_hash = ?
  AND ms.file_index_key = ?;

-- 2. (Application) Call provider adapter:
--    provider.refresh(identity, current_url) → PlayableSource

-- 3. Update cache (upsert)
INSERT INTO resolved_urls (info_hash, file_index_key, placement_id,
                           resolved_url, expires_at, bytes, content_type)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(info_hash, file_index_key)
DO UPDATE SET
  resolved_url = excluded.resolved_url,
  resolved_at = datetime('now'),
  expires_at = excluded.expires_at,
  bytes = excluded.bytes,
  content_type = excluded.content_type;

-- 4. Update state
UPDATE materialization_state
SET state = 'available',
    resolved_at = datetime('now'),
    expires_at = ?,
    retry_count = 0,
    updated_at = datetime('now')
WHERE info_hash = ? AND file_index_key = ?;

-- 5. Log event
INSERT INTO materialization_events
  (event_id, event_type, info_hash, file_index_key,
   from_state, to_state, trigger, provider, resource_id, placement_id)
VALUES (?, 'refresh_attempt', ?, ?, 'expired', 'available',
        'refresh_timer', ?, ?, ?);
```

---

### 6.3 Provider Failure

**Trigger:** Provider adapter throws `ProviderError`, `NotFoundError`, or `AuthError`

**Steps:**

```sql
-- 1. Mark placement failed
UPDATE placements
SET status = 'failed',
    updated_at = datetime('now')
WHERE placement_id = ?;

-- 2. Log event
INSERT INTO materialization_events
  (event_id, event_type, info_hash, file_index_key,
   from_state, to_state, trigger, provider, resource_id,
   placement_id, failure_reason)
VALUES (?, 'state_transition', ?, ?, 'available', 'failed',
        'provider_error', ?, ?, ?, ?);

-- 3. Check for alternate placements
SELECT placement_id, provider, provider_resource_id
FROM placements
WHERE info_hash = ?
  AND file_index_key = ?
  AND status = 'complete'
  AND placement_id != ?
ORDER BY created_at ASC
LIMIT 1;

-- 4. If alternate found: switch active placement, set state = 'acquiring'
UPDATE materialization_state
SET active_placement_id = ?,
    state = 'acquiring',
    retry_count = 0,
    updated_at = datetime('now')
WHERE info_hash = ? AND file_index_key = ?;

-- 5. If no alternate: set state = 'failed'
UPDATE materialization_state
SET state = 'failed',
    active_placement_id = NULL,
    updated_at = datetime('now')
WHERE info_hash = ? AND file_index_key = ?;
```

---

### 6.4 Repair

**Trigger:** Manual repair request or automated repair orchestrator

**Steps:**

```sql
-- 1. Find failed content
SELECT
  ms.info_hash,
  ms.file_index_key,
  ms.failure_reason,
  ms.active_placement_id,
  p.provider
FROM materialization_state ms
LEFT JOIN placements p ON p.placement_id = ms.active_placement_id
WHERE ms.state = 'failed';

-- 2. For each failed content:
--    a. Try re-refresh existing placement
--    b. If that fails, try alternate placements
--    c. If all fail, mark for re-placement

-- 3. Log repair attempt
INSERT INTO materialization_events
  (event_id, event_type, info_hash, file_index_key,
   from_state, to_state, trigger, provider, resource_id, placement_id)
VALUES (?, 'repair_attempt', ?, ?, 'failed', 'repairing',
        'manual_repair', ?, ?, ?);

-- 4. If repair succeeds:
UPDATE materialization_state
SET state = 'available',
    retry_count = 0,
    updated_at = datetime('now')
WHERE info_hash = ? AND file_index_key = ?;
```

---

## 7. Multi-Provider Model

### 7.1 Scenario

```
Movie A (hash: abc123, file_index: 0)
  RD:     available
  TorBox: available
  Premiumize: failed
```

### 7.2 Ownership

**Question:** Does resolver pick provider, or placement layer pick?

**Answer:** Placement layer picks. Resolver executes.

- **Placement layer** decides which providers to use based on:
  - User preference (configured priority)
  - Cost (RD is cheaper than Premiumize)
  - Speed (provider response time)
  - Reliability (historical success rate)

- **Resolver** decides which placement to use based on:
  - Current availability (`available` > `acquiring` > `failed`)
  - Active placement preference (don't switch if current works)
  - Failover order (try alternate placements on failure)

### 7.3 Priority and Selection

**Priority is a placement-layer concern**, not a registry concern.

The registry tracks:
- Which placements exist (one row per placement)
- Which placement is active (`active_placement_id`)
- Current materialization state

The placement layer (future) would maintain a separate priority table or configuration:

```sql
-- Placement layer table (future, not part of materialization registry)
CREATE TABLE provider_priority (
  provider TEXT PRIMARY KEY,
  priority INTEGER NOT NULL,  -- lower = higher priority
  enabled INTEGER DEFAULT 1
);
```

**Phase 1 simplification:** No priority table. Placement order is implicit (first created = active). Manual failover only.

### 7.4 Active Placement Semantics

- `active_placement_id` in `materialization_state` points to the placement currently used for playback
- Only one active placement at a time per identity
- Switching active placement requires:
  1. Current placement fails (`state = 'failed'`)
  2. Alternate placement has `status = 'complete'`
  3. Resolver tests alternate placement (calls `provider.resolve()`)
  4. If successful, update `active_placement_id`, log `placement_switch` event

---

## 8. Things NOT Worth Storing

### 8.1 Explicit Rejections

| Item | Why Not Store |
|------|---------------|
| **Permanent CDN URLs** | URLs are ephemeral (~24h TTL). Storing them as permanent records creates stale URL failures. Resolved on demand, cached temporarily only. |
| **Plex paths** | Consumer-layer concern. Plex paths depend on library structure, naming conventions, user configuration. Not materialization state. |
| **.strm contents** | Consumer-layer concern. `.strm` files contain resolver URLs, not provider URLs. Generated on demand, not stored in registry. |
| **WebDAV paths** | Consumer-layer concern. WebDAV is a virtual filesystem view, not materialization state. |
| **Provider-specific metadata** | The registry stores canonical state only. Provider-specific data (e.g., RD's `filename`, `host`, `streaming`) lives in the provider adapter, not the registry. |
| **Quality scores** | Corpus-layer concern. Quality scores are derived from release attributes (resolution, codec, source type). Storing them in the registry duplicates corpus data. |
| **Filenames** | Corpus-layer concern. Filenames are part of release metadata, stored in `candidates` and `release_attributes`. |
| **Parsed release attributes** | Corpus-layer concern. Already stored in `release_attributes` and indexed in `release_search`. Duplicating in the registry would create sync issues. |

### 8.2 Rationale

The materialization registry stores only what the resolver needs to answer:

1. **What content is this?** → `(info_hash, file_index_key)` — references corpus identity
2. **Which provider currently has it?** → `active_placement_id` → `placements.provider`
3. **Is it playable?** → `materialization_state.state = 'available'`
4. **How do I refresh it?** → `placements.provider_resource_id` + provider adapter
5. **How do I recover if it fails?** → alternate placements + event history

Everything else is owned by another layer.

---

## 9. Minimal Phase 1 Schema

### 9.1 Required Tables

| Table | Purpose | Phase |
|-------|---------|-------|
| `placements` | Track provider placements per identity | 1 |
| `materialization_state` | Current lifecycle state per identity | 1 |
| `resolved_urls` | Temporary URL cache for performance | 1 |
| `materialization_events` | Append-only lifecycle history | 1 |

### 9.2 Schema

```sql
-- Phase 1: Minimal Materialization Registry

-- 1. Placement Records
CREATE TABLE placements (
  placement_id TEXT PRIMARY KEY,
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  provider TEXT NOT NULL,
  provider_resource_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  FOREIGN KEY (info_hash, file_index_key)
    REFERENCES candidates(info_hash, file_index_key)
);

CREATE INDEX idx_placements_identity
  ON placements(info_hash, file_index_key);

CREATE INDEX idx_placements_provider_resource
  ON placements(provider, provider_resource_id);

-- 2. Materialization State
CREATE TABLE materialization_state (
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  active_placement_id TEXT,
  state TEXT NOT NULL DEFAULT 'acquiring',
  resolved_at TEXT,
  expires_at TEXT,
  failure_reason TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  
  PRIMARY KEY (info_hash, file_index_key),
  FOREIGN KEY (info_hash, file_index_key)
    REFERENCES candidates(info_hash, file_index_key),
  FOREIGN KEY (active_placement_id)
    REFERENCES placements(placement_id)
);

CREATE INDEX idx_mat_state
  ON materialization_state(state);

-- 3. Resolved URL Cache (temporary)
CREATE TABLE resolved_urls (
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  placement_id TEXT NOT NULL,
  resolved_url TEXT NOT NULL,
  resolved_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  bytes INTEGER,
  content_type TEXT,
  
  PRIMARY KEY (info_hash, file_index_key),
  FOREIGN KEY (info_hash, file_index_key)
    REFERENCES candidates(info_hash, file_index_key),
  FOREIGN KEY (placement_id)
    REFERENCES placements(placement_id)
);

CREATE INDEX idx_resolved_urls_expires
  ON resolved_urls(expires_at);

-- 4. Lifecycle Event History (append-only)
CREATE TABLE materialization_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  from_state TEXT,
  to_state TEXT,
  trigger TEXT,
  provider TEXT,
  resource_id TEXT,
  placement_id TEXT,
  failure_reason TEXT,
  
  FOREIGN KEY (info_hash, file_index_key)
    REFERENCES candidates(info_hash, file_index_key),
  FOREIGN KEY (placement_id)
    REFERENCES placements(placement_id)
);

CREATE INDEX idx_events_identity_time
  ON materialization_events(info_hash, file_index_key, timestamp);

CREATE INDEX idx_events_type
  ON materialization_events(event_type, timestamp);
```

### 9.3 Relationships

```
candidates(info_hash, file_index_key)
        │
        ├─1:N→ placements(info_hash, file_index_key)
        │
        ├─1:1→ materialization_state(info_hash, file_index_key)
        │         │
        │         └─N:1→ placements(active_placement_id)
        │
        ├─1:1→ resolved_urls(info_hash, file_index_key)
        │         │
        │         └─N:1→ placements(placement_id)
        │
        └─1:N→ materialization_events(info_hash, file_index_key)
                  │
                  └─N:1→ placements(placement_id)
```

### 9.4 What Can Wait

| Feature | Phase | Reason |
|---------|-------|--------|
| `provider_priority` table | 2+ | Multi-provider selection logic is not needed for single-provider Phase 1 |
| `repair_jobs` table | 4 | Automated repair orchestrator is Phase 4 |
| `cdn_metadata` cache | 2+ | CDN Range support caching is an optimization, not core requirement |
| `playback_sessions` table | 2+ | Session tracking is observability, not materialization |
| `rate_limit_tracking` | 2+ | Rate limit state is transient, can be in-memory |
| `content_hash` identity layer | 3+ | Cross-torrent duplicate detection is future work |

---

## 10. Implementation Readiness Checklist

After this schema exists, the resolver implementation can answer:

### 10.1 What content is this?

```sql
SELECT
  c.info_hash,
  c.file_index,
  c.title,
  c.filename,
  c.size
FROM candidates c
WHERE c.info_hash = ? AND c.file_index_key = ?;
```

The registry does not duplicate corpus identity. It references `(info_hash, file_index_key)` via foreign key.

### 10.2 Which provider currently has it?

```sql
SELECT
  p.provider,
  p.provider_resource_id,
  p.status
FROM materialization_state ms
JOIN placements p ON p.placement_id = ms.active_placement_id
WHERE ms.info_hash = ? AND ms.file_index_key = ?;
```

Returns the active placement's provider and resource ID. If `active_placement_id` is NULL, no provider currently holds this content.

### 10.3 Is it playable?

```sql
SELECT
  ms.state,
  ms.resolved_at,
  ms.expires_at,
  ms.failure_reason,
  ru.resolved_url
FROM materialization_state ms
LEFT JOIN resolved_urls ru ON ru.info_hash = ms.info_hash
  AND ru.file_index_key = ms.file_index_key
WHERE ms.info_hash = ? AND ms.file_index_key = ?;
```

- `state = 'available'` → yes, playable now
- `state = 'acquiring'` → not yet, placement in progress
- `state = 'expired'` → was playable, refresh needed
- `state = 'repairing'` → refresh in progress
- `state = 'failed'` → not playable, no valid placement

### 10.4 How do I refresh it?

```sql
-- 1. Get placement info
SELECT
  p.provider,
  p.provider_resource_id,
  ru.resolved_url AS current_url
FROM materialization_state ms
JOIN placements p ON p.placement_id = ms.active_placement_id
LEFT JOIN resolved_urls ru ON ru.info_hash = ms.info_hash
  AND ru.file_index_key = ms.file_index_key
WHERE ms.info_hash = ? AND ms.file_index_key = ?;

-- 2. Call provider adapter (application layer):
--    provider.refresh(identity, current_url) → PlayableSource

-- 3. Update cache (upsert resolved_urls)
-- 4. Update state (state = 'available', reset retry_count)
-- 5. Log event (event_type = 'refresh_attempt')
```

### 10.5 How do I recover if it fails?

```sql
-- 1. Check for alternate placements
SELECT
  placement_id,
  provider,
  provider_resource_id
FROM placements
WHERE info_hash = ?
  AND file_index_key = ?
  AND status = 'complete'
  AND placement_id != ?
ORDER BY created_at ASC;

-- 2. For each alternate, test with provider adapter:
--    provider.resolve(identity) → PlayableSource

-- 3. If successful: switch active placement
UPDATE materialization_state
SET active_placement_id = ?,
    state = 'acquiring',
    retry_count = 0
WHERE info_hash = ? AND file_index_key = ?;

-- 4. Log placement_switch event

-- 5. If all fail: state remains 'failed', log repair_needed event
```

---

## 11. Summary

### 11.1 Design Principles

1. **Reference, don't duplicate.** Corpus identity is referenced via foreign key, not stored.
2. **Separate placement from materialization.** Placement is provider's view; materialization is resolver's view.
3. **Cache URLs temporarily, not permanently.** Ephemeral data gets ephemeral storage.
4. **Append-only event history.** State changes are logged immutably for future repair and observability.
5. **One active placement, many possible.** Multi-provider support via placements table with active pointer.

### 11.2 Four Tables, Four Jobs

| Table | Job |
|-------|-----|
| `placements` | "Who holds this content?" |
| `materialization_state` | "Can it become bytes right now?" |
| `resolved_urls` | "Where are the bytes right now?" (temporary) |
| `materialization_events` | "What happened over time?" (append-only) |

### 11.3 Boundary Recap

- **Corpus owns:** identity, metadata, evidence
- **Placement layer owns:** acquisition intent, provider selection, resource IDs
- **Registry owns:** lifecycle state, active placement pointer, URL cache, event history
- **Consumer layer owns:** paths, views, file content

### 11.4 Phase 1 Scope

- 4 tables
- 1 provider (Real-Debrid)
- Manual failover only
- Synchronous refresh on demand
- No background repair orchestrator
- No priority selection logic

### 11.5 Future Extensions

| Extension | What Changes |
|-----------|--------------|
| Multi-provider | Add placements, active placement switches automatically |
| Repair orchestrator | Consume `materialization_events`, trigger re-placement |
| Background refresh | Scheduled refresh at 80% TTL |
| CDN preflight | Cache CDN Range support status |
| Rate limit awareness | Track refresh frequency, back off before 429 |

---

## 12. References

- **Resolver endpoint:** `RESOLVER-DESIGN.md` §2 (endpoint contract), §6 (state transitions)
- **Provider adapter:** `PROVIDER-INTERFACE.md` §3 (Phase 1 interface)
- **Architecture:** `MATERIALIZATION-ARCHITECTURE.md` §7 (resolver endpoint), §8 (implementation scope)
- **Corpus schema:** `src/corpus-db.js` (candidates, release_attributes, release_search)
- **Identity semantics:** `HANDOFF.md` §1 (`(info_hash, file_index_key)` with `-1` for NULL)

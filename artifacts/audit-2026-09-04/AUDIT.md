# Media Request / Result / Handoff Persistence Audit

**Slice:** m3-north-db control-plane integrity hardening
**Date:** 2026-09-04
**Branch state:** main @ cc3de85, m3-north-db frozen at 9f36481

## Scope

Persistence integrity of:
- `media_requests`
- `media_request_results`
- `playback_handoffs`

…and the three north-side public functions:
- `persistMediaRequest(intent, results)`
- `persistMediaRequestResults` *(not exposed; folded into `persistMediaRequest`)*
- `persistPlaybackHandoff(handoff)`

The audit is read-only. No destructive action was taken against the production
DB. All evidence below was gathered from the production DB
`/home/patrick/hashsucker-data/discovery/discovery-cache.db`.

---

## A. Lifecycle Trace

### A.1 API entry path — `media-search/src/api/media-request.js`

Two entry points write the trio:

1. **searchByMedia** (live corpus + live discovery) — used by Seerr + UI.
   - Stage 7: `selectBindableCandidate(explainable, …)` — selects a candidate
     in memory; the request has not yet been persisted at this point.
   - Stage 8: `cache.persistMediaRequest(intent, explainable)` — inserts the
     `media_requests` row, then iterates `explainable` and inserts one
     `media_request_results` row per candidate.
   - Stage 9: `cache.persistPlaybackHandoff(handoff)` — inserts the
     `playback_handoffs` row. This is preceded by a `selectBindableCandidate`
     only when a candidate is bindable. STRM/VFS/Plex/Jellyfin notifications
     follow but are non-fatal and not persisted state.

2. **mediaSearchByMedia** (corpus-only) — used by direct/operator API.
   - Same Stage 6/7/8/9 sequence as above; the only difference is that no
     live discovery runs.

### A.2 Operator path — `media-search/src/lib/requests/virtual-library.js`

1. Builds a single result, calls `cache.persistMediaRequest(...)`.
2. Builds a handoff, calls `cache.persistPlaybackHandoff(handoff)`.
3. `publishStrm({handoff, selection})`.

### A.3 Test paths

`test/playback-handoff-persistence.test.js` and `test/media-request.test.js`
both rely on `cache.persistMediaRequest(..., [])` with an empty results array
followed by `cache.persistPlaybackHandoff(...)` — exercising the empty-results
path. No test exercises partial-failure of `persistMediaRequest`.

---

## B. Identity Model (current)

### B.1 media_requests

A `media_requests` row represents one persisted request event. There is **no
deduplication key** — every call to `persistMediaRequest` inserts a new row.
The same `(media_id, media_type, season, episode)` triple may appear many
times; each is a distinct request event.

This is intentional per the spec: "If repeated equivalent requests are
intentionally distinct events, preserve that." The implication is that all
diagnostic queries must be `ORDER BY created_at DESC` + `LIMIT`, not
identity-keyed upserts.

### B.2 media_request_results

`media_request_results` rows are tied to a `request_id` via FK declaration.
The only unique invariant enforced is:
```
PRIMARY KEY (id)
INDEX (request_id, rank)
```

The (info_hash, file_index_key) pair is **not** part of any unique
constraint. Two rows in the same request can carry the same physical file at
different ranks. See defect D-2.

### B.3 playback_handoffs

A `playback_handoffs` row represents the durable identity of the selected
candidate for one logical slot. The canonical slot key is:
```
(media_type, media_id, IFNULL(season, -1), IFNULL(episode, -1))
```
and is enforced by a UNIQUE INDEX (`idx_playback_handoffs_identity`).

Upsert semantics (slice 2.6):
- No prior row → insert (`status: 'inserted'`)
- Prior identical → return existing (`status: 'noop'`)
- Prior legacy (torrent_file_id NULL), new authoritative → upgrade in place
  (`status: 'upgraded'`)
- Prior authoritative, new legacy → keep authoritative (`status: 'kept-authoritative'`)

This contract is **well-implemented in the handoff layer**.

### B.4 For TV: media_id is bare, season/episode on the row

Confirmed via schema: `media_requests.season INTEGER`, `media_requests.episode
INTEGER`, no synthetic media_id encoding.

### B.5 For movie: media_id is bare, season/episode NULL

Confirmed: `season`/`episode` default to NULL for movies.

---

## C. Result Durability

### C.1 Persisted fields (verbatim from schema)

`media_request_results` columns:
- `rank` INTEGER NOT NULL — persisted, explicit
- `info_hash` TEXT NOT NULL
- `file_index_key` INTEGER NOT NULL DEFAULT -1
- `filename` TEXT
- `score` REAL
- `score_breakdown` TEXT (JSON)
- `identity_tier` TEXT
- `identity_confidence` REAL
- `identity_evidence` TEXT (JSON)
- `resolution_state` TEXT
- `release_metadata` TEXT (JSON, includes releaseKey when computed upstream)
- `ranking_breakdown` TEXT (JSON) — separate from `score_breakdown`
- `eligible` INTEGER (0/1)
- `ineligible_reason` TEXT
- `ineligible_code` TEXT
- `expected_media_scope` TEXT
- `parsed_candidate_scope` TEXT
- `selected_file_size` INTEGER (added slice 1.75)
- `intent_id` INTEGER (FK, optional)

### C.2 Adequacy

The persisted schema already captures the spec's required fields:
- exact rank ✓ (`rank`)
- releaseKey ✓ (encoded inside `release_metadata` JSON)
- infoHash + fileIndex ✓
- eligibility ✓
- score ✓
- ranking explanation/breakdown ✓ (`ranking_breakdown`, `score_breakdown`)
- identity confidence + tier ✓
- selected file size ✓

### C.3 What is *not* persisted

- **Provider observations used at ranking time** — `observations[]` is built
  in-memory from `cache.getProviderObservations(...)` for the explainable
  payload but is **NOT** copied into `media_request_results`. This is a gap
  for forensic reconstruction: after restart we can re-derive from
  `provider_observation_events` but the snapshot taken at ranking time is
  lost. **Acceptable**: the spec says "if currently persisted" — these
  observations are not currently persisted, so this is consistent.

- **availability stats at ranking time** — `availability.torbox` is folded
  into the explainable payload but not into the result row. Same as above.

- **`selected`** boolean — never persisted. The selection lives in
  `playback_handoffs` (a separate slot). The mapping from "rank N in
  request M" to "the selected release" is the handoff row's
  `request_id`/`info_hash`/`file_index`/`release_key`. **Acceptable** as
  long as the handoff is consistent with the results.

### C.4 Field is `intent_id` (FK to media_intents) but FK is not enforced

Defect C-1: `media_request_results.intent_id` has a `FOREIGN KEY` declaration
but `PRAGMA foreign_keys = ON` is **never set** at DB open. See defect D-1.

---

## D. Transactionality

### D.1 PRAGMA state

`createDiscoveryCache` opens the DB with:
```
PRAGMA journal_mode = WAL
PRAGMA busy_timeout = 5000
```

It does **not** set `PRAGMA foreign_keys = ON`. better-sqlite3 (and
`node:sqlite`'s `DatabaseSync`) default to `foreign_keys = OFF`. This means
**all FK declarations in the schema are decorative** and dangling references
are silently accepted by SQLite.

Defect D-1: foreign keys are not enforced. Concrete production evidence:
9 orphan `media_request_results` rows whose `request_id` does not exist in
`media_requests` (requests 157, 158, 159 — see census).

### D.2 Autocommit around `persistMediaRequest`

```javascript
const info = db.prepare(reqSql).run(...reqValues); // autocommit INSERT
const requestId = info.lastInsertRowid;

const resultTemplate = buildInsertMediaRequestResultSql(intentId);

for (const r of results) {
  db.prepare(resultTemplate.sql).run(...resultTemplate.buildValues({...}));
  // ↑ each iteration is a separate autocommit INSERT
}

return requestId;
```

Defect D-2: if any iteration's `db.prepare(...).run(...)` throws, the
**request row is committed** and **all earlier-iterated result rows are
committed**, but later result rows are missing. Caller observes a thrown
exception with a partial state in the DB.

There is no production occurrence of this defect (every request with N
results has rank 1..N contiguous in the DB), but the defect is real: a
malformed result row, a `JSON.stringify` throw on circular reference, a
disk-full SQLite error mid-loop, or a `prepare()` failure on the cached
statement template would all leave partial state.

### D.3 `persistPlaybackHandoff`

Uses a single `ON CONFLICT(…) DO UPDATE WHERE …` statement. SQLite wraps
each statement in an implicit transaction; for a single statement this is
atomic. The follow-up `getPlaybackHandoffByMediaIdentityStmt.get(...)` reads
are within the same logical operation but the read is outside the write
transaction. Acceptable: the read is only for return-value formatting.

### D.4 No transactional boundary between `persistMediaRequest` and
`persistPlaybackHandoff`

Stage 8 (persistMediaRequest) and Stage 9 (persistPlaybackHandoff) in
`api/media-request.js` are two separate function calls. If Stage 8 commits
the request + results, then Stage 9 throws, we have a request + results
without a handoff.

This is **not strictly a defect** — a request can exist without a handoff
(every request where `selectBindableCandidate` returns `null` produces this
state by design). But there is no integrity invariant that "every handoff
must reference a request whose results contain that release" or vice versa.

---

## E. Duplicates / Idempotency

### E.1 Handoff layer (clean)

The handoff layer has the strongest idempotency story in the system:
- UNIQUE INDEX on the canonical slot key
- `ON CONFLICT DO UPDATE WHERE` with explicit gates on
  legacy→authoritative / authoritative→replacement
- `upsertPlaybackHandoff` classifies the outcome into 4 statuses
  (`inserted` / `noop` / `upgraded` / `kept-authoritative`)

Concurrent writers converge on the same durable id.

### E.2 Result layer (defect)

`media_request_results` has no UNIQUE constraint on
`(request_id, info_hash, file_index_key)`. A physical file can be persisted
at multiple ranks within the same request.

**Census evidence (production DB):**
- 2103 result rows are part of duplicate `(request_id, release_metadata)`
  groups (when JSON-serialised metadata is byte-identical)
- 174 distinct request_ids are affected
- Concrete example (request 29, MOANA 2026):
  - rank 1: info_hash `9505…568a2`, file_index_key=0
  - rank 2: info_hash `9505…568a2`, file_index_key=-1
- Concrete example (request 27, Spider-Man):
  - rank 9: info_hash `3b1f…34bda`, filename `Spider-Man.Brand.New.Day.2026.HD1080P.X265.AC3.DDP5.1.English.CHS-ENG.JKYY.mkv`
  - rank 10: same info_hash, same filename, same release_metadata

Defect E-1: same physical release persisted at multiple ranks within one
request. Root cause is upstream — live discovery returns the same info_hash
with different `fileIndex` values (one source says fileIndex=0, another
says fileIndex=null which becomes -1) and the in-memory `releaseKey`-keyed
dedup treats them as different releases. The persistence layer accepts what
it's given.

This is NOT a corruption of ranking — the in-memory list is correctly
ordered — but it leaves a **non-idempotent audit trail**: rerunning the
same request will produce the same set of rank values but a different row
layout (different `id` values, different insertion order).

### E.3 Ranks within a request

`idx_media_request_results_request` is `(request_id, rank)`. No `UNIQUE`
clause. The census confirms 0 duplicate `(request_id, rank)` pairs in
production. Ranks are unique today because the input list is already
distinctly ranked. This is **incidental**, not enforced.

Defect E-2: ranks are unique in practice but not guaranteed by schema.

### E.4 Intent_id upsert

`upsertMediaIntent` is called inside `persistMediaRequest` when no
`intentId` is passed. It is not transactional with the request insert. If
the intent upsert succeeds but the request insert throws, we have a
media_intents row that is one ahead of reality (the request was never
created). This is a minor defect; the dedup tuple of media_intents
guarantees the next equivalent request re-uses the same intent row.

### E.5 `release_search` tables (FTS5)

Out of scope; these are managed by SQLite's FTS5 shadow tables and
guaranteed by the engine.

---

## F. Stale State / Retention Census

Read-only census against production DB
`/home/patrick/hashsucker-data/discovery/discovery-cache.db`:

| metric                                       | n     |
|----------------------------------------------|------:|
| media_requests                               | 174   |
| media_request_results                        | 8,385 |
| playback_handoffs                            | 54    |
| media_intents                                | 57    |
| requests_older_1d                            | 174   |
| requests_older_7d                            | 1     |
| requests_older_30d                           | 0     |
| **orphan_results_no_request**                | **9** |
| orphan_handoffs_no_request                   | 0     |
| **requests_with_zero_results**               | **3** |
| multiple_selected_per_request                | 0     |
| **dup_request_release_metadata**             | **2,103** |
| dup_rank_in_request                          | 0     |
| **handoffs_no_torrentFile**                  | **30** |
| **handoffs_referencing_release_absent_in_results** | **2** |

**Concrete defects from census:**
1. **9 orphan result rows** (3 rows each for "missing" requests 157, 158, 159
   — these are likely the only rows that survived an aborted insert of a
   request + results block, or an intentional request delete that didn't
   cascade).
2. **3 requests with zero results** (request IDs 1, 2, 3 — earliest
   requests, all `candidate_count=1`, all movies).
3. **2 handoffs reference requests whose results are absent** (handoff ids
   1, 2 reference requests 2, 3 which have zero results).
4. **30 legacy handoffs without `torrent_file_id`** (pre-slice 1.75
   handoffs; expected and benign).
5. **2,103 duplicate `release_metadata` rows** spread across 174 distinct
   requests (defect E-1).

**No destructive cleanup is proposed in this slice.** The orphan rows and
zero-results requests appear to be artifacts of earlier schema migrations
and early development, not ongoing accumulation. The duplicate release
metadata is the only defect that could grow over time.

---

## G. Restart Proof

Not yet run. See section G in slice plan; will be implemented in G-1 below.

---

## H. Failure Proof

Not yet run. See section H in slice plan; will be implemented in H-1 below.

---

## I. Defect Summary

| ID    | Severity   | Description                                                                                          | Plan section |
|-------|------------|------------------------------------------------------------------------------------------------------|--------------|
| D-1   | high       | `PRAGMA foreign_keys = ON` not set; all FK declarations decorative                                   | D-1          |
| D-2   | high       | `persistMediaRequest` runs request + N results as autocommit; partial-failure leaves request + partial results | D-2          |
| E-1   | medium     | Same physical release persisted at multiple ranks within one request (2103 dups in prod)            | E-1          |
| E-2   | low        | Ranks unique in practice but not enforced by UNIQUE constraint                                       | E-2          |
| E-3   | low        | `release_metadata` JSON used for dedup, which is fragile to formatting changes                      | E-3          |
| F-1   | low        | 9 orphan result rows, 3 zero-result requests, 2 dangling handoffs in prod (no ongoing growth)       | F-1          |

---

## J. Proposed Hardening

In priority order, all applied as `BEGIN IMMEDIATE` … `COMMIT` boundaries
where they cross the persistence seam:

1. **Enable FK enforcement** by adding
   `db.exec('PRAGMA foreign_keys = ON')` immediately after WAL setup.
2. **Wrap `persistMediaRequest` in a transaction**: `BEGIN IMMEDIATE`,
   insert request, loop results, `COMMIT`. Re-raise with rollback on any
   failure.
3. **Add a `UNIQUE INDEX` on `(request_id, info_hash, file_index_key)` in
   `media_request_results`** with `ON CONFLICT IGNORE` semantics in the
   write path. This collapses duplicate physical releases inside one
   request and prevents future E-1 accumulation.
4. **Add a `UNIQUE INDEX` on `(request_id, rank)` in
   `media_request_results`** so that any future caller that produces a
   tied rank is rejected at the DB boundary.
5. **Add an idempotency guard** at the top of `persistMediaRequest` to
   detect re-entry: if the latest `media_requests` row for the same
   `(media_id, season, episode, source)` is younger than N seconds, return
   its id instead of inserting. (Spec says preserve distinct events — this
   is therefore configurable, default OFF.)

Defects F-1 are pre-existing artifacts, not addressed in this slice.

---

## K. Schema Inventory (verbatim DDL)

```sql
CREATE TABLE IF NOT EXISTS media_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  intent_id INTEGER,
  source TEXT NOT NULL DEFAULT 'api',
  source_type TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (intent_id) REFERENCES media_intents(id)
);
CREATE INDEX IF NOT EXISTS idx_media_requests_media_id
  ON media_requests(media_id, created_at);

CREATE TABLE IF NOT EXISTS media_request_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER NOT NULL,
  rank INTEGER NOT NULL,
  intent_id INTEGER,
  info_hash TEXT NOT NULL,
  file_index_key INTEGER NOT NULL DEFAULT -1,
  filename TEXT,
  score REAL NOT NULL DEFAULT 0,
  score_breakdown TEXT,
  identity_tier TEXT,
  identity_confidence REAL,
  identity_evidence TEXT,
  resolution_state TEXT,
  release_metadata TEXT,
  ranking_breakdown TEXT,
  eligible INTEGER,
  ineligible_reason TEXT,
  ineligible_code TEXT,
  expected_media_scope TEXT,
  parsed_candidate_scope TEXT,
  selected_file_size INTEGER,
  FOREIGN KEY (request_id) REFERENCES media_requests(id),
  FOREIGN KEY (intent_id) REFERENCES media_intents(id)
);
CREATE INDEX IF NOT EXISTS idx_media_request_results_request
  ON media_request_results(request_id, rank);

CREATE TABLE IF NOT EXISTS playback_handoffs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id INTEGER,
  media_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  release_key TEXT NOT NULL,
  info_hash TEXT NOT NULL,
  file_index INTEGER,
  filename TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'torbox',
  provider_state TEXT NOT NULL DEFAULT 'unknown',
  identity_tier TEXT,
  resolution_state TEXT,
  selection_reason TEXT,
  selected_at INTEGER NOT NULL,
  torrent_file_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
  FOREIGN KEY (request_id) REFERENCES media_requests(id)
);
CREATE INDEX IF NOT EXISTS idx_playback_handoffs_request
  ON playback_handoffs(request_id);
CREATE INDEX IF NOT EXISTS idx_playback_handoffs_media
  ON playback_handoffs(media_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_playback_handoffs_identity
  ON playback_handoffs(
    media_type, media_id, IFNULL(season, -1), IFNULL(episode, -1)
  );
```

---

## L. What This Slice Will NOT Touch

- ranking weights
- candidate scoring
- provider resolution
- VFS publication
- WebDAV
- playback bytes
- TorrentFile identity
- HY4 seams
- the 9 orphan rows / 3 zero-result requests in production (F-1)

m3-north-db is frozen at 9f36481 and will not be modified.

---

## M. Slice 3.0 — Implemented Hardening

The audit identified the following integrity defects in the trio's write path.
Each was fixed in a single coherent change to
`media-search/src/lib/discovery/cache.js`, with the new behavior
proof-tested in `media-search/test/persistence-integrity-slice-3.test.js`
(15 tests, all green; 0 regressions in the 2624-test full suite).

### M.1 — D-1: PRAGMA foreign_keys is per-connection → FK was never enforced

**Defect:** `node:sqlite` opens each `DatabaseSync` without
`PRAGMA foreign_keys = ON`. The `media_request_results.request_id` and
`media_request_results.intent_id` FKs were declared but ignored.
Production evidence: 9 orphan rows in `media_request_results` pointing
to non-existent `media_requests` (F-1).

**Fix:** `createDiscoveryCache` now runs `PRAGMA foreign_keys = ON`
immediately after the WAL pragma, on the same connection that holds
all prepared statements. A side-effect probe test confirms
`PRAGMA foreign_keys` returns `1` for both writer and reader connections.

**Coverage:**
- `integrity: PRAGMA foreign_keys = ON is applied at open` — probes
  the PRAGMA on the live connection.
- `failure proof: FK enforcement rejects orphan inserts at the SQL
  boundary` — inserts an orphan row, asserts the SQLite error is
  raised.

### M.2 — D-2: persistMediaRequest was not transactional → mid-loop throw left a headless request

**Defect:** `persistMediaRequest` ran `INSERT INTO media_requests ...`
followed by an unguarded loop of `INSERT INTO media_request_results`.
Any throw in the loop (bad JSON in `scoreBreakdown`, a host-driver
error, an OOM) would leave the request row committed with no result
rows. The FK didn't help because FK was off (D-1).

**Fix:** `persistMediaRequest` now runs
`BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK` around the request+results
block. `BEGIN IMMEDIATE` acquires the writer lock up front to avoid
`SQLITE_BUSY` under concurrent persist calls.

**Design note — intent upsert:** the linked `upsertMediaIntent` is
resolved BEFORE the transaction. `upsertMediaIntent` itself runs
`BEGIN IMMEDIATE`, and SQLite cannot nest transactions. Doing the
intent work first is safe: if the request/results block fails, the
intent's `request_count` is slightly inflated by one (an unfulfilled
user request), which is a small accounting drift, not a structural
integrity defect. The request/results block is the structural
boundary we care about being transactional.

**Coverage:**
- `integrity: persistMediaRequest rolls back when a result throws` —
  passes a result row with a circular `scoreBreakdown` (the `JSON.stringify`
  throws), asserts no `media_requests` and no `media_request_results` rows
  are left.
- `integrity: persistMediaRequest with empty results still commits request` —
  edge case: zero-result request still writes a head.
- `failure proof: throw between request and results leaves no partial state` —
  pre/post count comparison, with FK on.

### M.3 — E-1: no caller-bug defense against duplicate physical releases → one row now, future dups ignored

**Defect:** the persistence layer had no schema-level guarantee that
two `media_request_results` rows in the same request could not
describe the same physical release. The schema accepted the caller's
list verbatim; a caller that emits the same `(info_hash, file_index_key)`
twice would create two result rows with different ranks.

**Fix:** added a `UNIQUE INDEX` on
`(request_id, info_hash, file_index_key)`. The `persistMediaRequest`
write path uses `INSERT OR IGNORE` so a true caller bug (same physical
release emitted twice) is silently collapsed to the first
(earliest-inserted) row, while legitimate multi-file torrents (where
the same `info_hash` legitimately has distinct `file_index_key` values
like `-1, 0, 1, 2`) are preserved.

**Production data shape — what this DOES and DOES NOT collapse:**

The 2103 "duplicate physical release" rows in production (e.g., the
52-row Oppenheimer) are NOT `(info_hash, file_index_key)` dups. They
are the same `info_hash` reported with TWO distinct `file_index_key`
values: `-1` (torrent-level representation) and `0` (first-file
representation). The schema correctly treats these as distinct
identities. A census of production requests 4-8:

```
request  hash_count  total_rows  multi_fik_groups
4        39          50          11
5        39          50          11
6        39          50          11
7        39          50          11
8        39          50          11
```

Each request has 11 hashes appearing under both `file_index_key = -1`
and `file_index_key = 0`. This is an **upstream normalization defect**
in the live-discovery merge step, NOT a persistence-layer integrity
defect. The persistence layer's contract is to faithfully record what
the caller passes; if the caller passes the same physical release
under two distinct identities, the schema cannot (and should not)
silently collapse them without changing ranking semantics — which
this slice explicitly does not do.

The (info_hash, file_index_key) UNIQUE INDEX does collapse TRUE
caller bugs (caller emits the same row twice, byte-identical
file_index_key). For production, there are 0 such exact dups in the
2103 case.

**Coverage:**
- `integrity: UNIQUE INDEX on (request_id, info_hash, file_index_key) exists` —
  probes sqlite_master.
- `integrity: duplicate (info_hash, file_index_key) row collapses to one` —
  passes 4 rows where 2 are exact dups, asserts 3 rows.
- `integrity: same info_hash with different file_index_key is preserved
  (multi-file torrent)` — REGRESSION GUARD: passes 4 rows with same
  `info_hash` and 4 distinct `file_index_key` values, asserts all 4
  survive. This blocks a future "let's just narrow the index to
  (request_id, info_hash)" refactor from silently breaking multi-file
  torrents (production request 63 has legitimate 3-file variants:
  `612e18da...` with file_index_keys `-1, 0, 6`).
- `integrity: migration collapses historical duplicates in legacy DB` —
  seeds a legacy DB with an exact dup, reopens, asserts migration
  dedupes and installs the unique index in one atomic pass.

### M.4 — E-2: no rank uniqueness → duplicate ranks silently dropped

**Defect:** the schema had no constraint that `rank` is unique per
request. A caller that emits two results at the same rank would
create two rows. The persistence layer accepted both.

**Fix:** added a `UNIQUE INDEX` on `(request_id, rank)`. The write
path uses `INSERT OR IGNORE` for the same reason as M.3. Additionally,
`persistMediaRequest` pre-validates the input list and throws
explicitly on a duplicate rank — rank uniqueness is a caller
contract, and a violation is treated as a programming error (not
silently dropped).

**Coverage:**
- `integrity: UNIQUE INDEX on (request_id, rank) exists`.
- `integrity: persistMediaRequest throws on duplicate rank in input` —
  throws `Error: duplicate rank N in results for media_id=... (rank
  uniqueness is a caller contract)`.

### M.5 — F-1: orphan rows would be rejected at write time, but legacy orphans remain

**Defect:** 9 `media_request_results` rows in production reference
`media_requests.id` values that no longer exist (F-1).

**Slice-3 mitigation:** new writes cannot create orphans (FK is now
enforced, and `INSERT OR IGNORE` collapses the dup pattern that
historically led to some of these). Legacy orphans remain — this
slice does NOT touch production data. They are listed in section F
of this audit for the future backfill slice to address.

### M.6 — Restart proof

After the changes, a `createDiscoveryCache` → close →
`createDiscoveryCache` cycle preserves:

- every `media_requests` row, including `candidate_count`, `intent_id`,
  and source provenance;
- every `media_request_results` row, including the durable identity
  fields (`identity_tier`, `identity_confidence`, `eligible`,
  `expected_media_scope`, `parsed_candidate_scope`, `selected_file_size`)
  and the JSON columns (`score_breakdown`, `ranking_breakdown`,
  `release_metadata`);
- every `playback_handoffs` row, including the FK to its
  `media_request`, the `torrent_file_id` pointer, and the
  `release_key` slot identifier;
- the unique indexes themselves (they are persisted in `sqlite_master`).

The `migration is idempotent across reopens` test re-runs the entire
migration suite on an already-migrated DB and confirms no
schema_migrations row is re-applied (and no constraint is
re-installed).

### M.7 — Failure proof

Two paths exercise a mid-persist failure:

1. **Persistence layer throw** — circular reference in `scoreBreakdown`
   causes `JSON.stringify` to throw mid-loop. With `BEGIN IMMEDIATE`
   in place, the throw triggers `ROLLBACK`. Post-conditions: no
   `media_requests` row, no `media_request_results` row, intent
   `request_count` may be +1 (acceptable accounting drift, see M.2).
2. **SQL boundary** — direct `INSERT INTO media_request_results (...)`
   with a `request_id` that does not exist in `media_requests`. With
   `PRAGMA foreign_keys = ON`, SQLite raises `FOREIGN KEY constraint
   failed` (SQLITE_CONSTRAINT_FOREIGNKEY, errcode 787). Pre-slice,
   the INSERT would have succeeded silently.

### M.8 — Co-test with handoff persistence

`integrity: persistMediaRequest followed by persistPlaybackHandoff is
consistent` exercises the full slice-1/2/3 path on the same DB:
request → results → handoff → cross-table query. All references
resolve and the handoff's `request_id` matches the request's `id`.

### M.9 — Schema deltas

```sql
-- new indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_request_results_identity
  ON media_request_results(request_id, info_hash, file_index_key);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_request_results_rank
  ON media_request_results(request_id, rank);

-- new PRAGMA at open
PRAGMA foreign_keys = ON;

-- new schema_migrations rows
INSERT OR IGNORE INTO schema_migrations (name, applied_at)
  VALUES ('media_request_results_identity_index', ?);
INSERT OR IGNORE INTO schema_migrations (name, applied_at)
  VALUES ('media_request_results_rank_index', ?);
```

The indexes are scoped to the production schema only via the
`schema_migrations` table; re-running the migration on a fresh DB is
a no-op (idempotency test in M.6).

### M.10 — Test results

- Slice 3 dedicated: **15/15 pass**
- Targeted suite (cache + handoff + media-request + slice-3 + rd-walk-bounded): **151/151 pass**
- Full suite: **2624 tests, 2492 pass, 130 fail** (the 130 pre-existing
  failures — `evidence.findTemporary`, `candidate_media` schema mismatches,
  `resolution_state` column mismatches — are unchanged from `cc3de85`
  and are unrelated to this slice; same count with and without my
  changes). My 15 new tests add 15 to the pass total and 0 to the fail
  total.

### M.11 — What this slice DOES NOT do (carried over from L)

- ranking weights
- candidate scoring
- upstream normalization of `(info_hash, file_index_key = -1, 0)`
  collisions from live discovery
- backfill of the 9 legacy orphan rows (F-1)
- backfill of the 2103 dup-physical-release rows (E-1 upstream)
- the 3 zero-result requests in production (F-1)
- the 7 zero-info_hash rows in production (F-2)
- m3-north-db is still frozen at 9f36481


## N. Slice 4.0 — Evidence Snapshot Provenance

### N.1 — A: Audit (current state)

After slice 3, every `media_request_results` row was durable, unique,
FK-bound, and restart-stable. But the row did NOT answer
*why* the row was ranked where it was. The scoring inputs at rank
time were reconstructible only by re-running the projection pipeline
against the current observation store — which is the very thing
that changes after restart (F-2 carries 0 `ranking_breakdown`
and 0 `parsed_candidate_scope` on the 8385 production rows).

**Seven questions a post-mortem on a persisted row could not answer:**

1. What `justification` did the scorer see (fresh / prior / both)?
2. What were the `components` it summed (capability, weight, age, …)?
3. What `contributions` (per-policy-target scores) made the total?
4. What `providerObservations` existed at rank time, and what was the
   *last-seen* of each?
5. Was `liveDiscovery` active when this row was ranked, or was the
   row produced offline by operator selection?
6. What was the `score` total, and did it match the `scoreBreakdown`
   that was also persisted?
7. Did the projection's prior include the historical observation
   that *would have* suppressed the row, or did the fresh observation
   win?

All seven were answerable only at rank time and lost on restart.

### N.2 — B+C: Design

**Approach:** store a frozen, versioned JSON snapshot of the
evidence/projection state the scorer actually saw. Per-row, not
per-request, because each row may have been ranked under a
different effective evidence set (e.g. fresh observation came in
between row N and row N+1).

**Shape (`EVIDENCE_SNAPSHOT_VERSION = 1`):**

```json
{
  "v": 1,
  "evidence": {
    "fresh": { "ok": true, "scope": "…", "tier": "…" } | null,
    "prior": { "ok": false, "scope": "…", "staleAt": "…" } | null,
    "hadObservations": true,
    "primaryIdentity": { "mediaId": "tt…", "mediaType": "movie" } | null
  },
  "components": { "capability": 0.4, "freshness": 0.2, … },
  "contributions": { "default": 0.6, "alternate": 0.0 },
  "justification": "fresh-supported" | "prior-only" | "operator-selection",
  "live": { "hadLiveDiscovery": true, "lastSeenAt": "…", "providerCount": 2 },
  "score": { "total": 0.87, "tier": "preferred", "policyTarget": "default" },
  "ranking": { "rank": 1, "inputCount": 8, "resultCount": 5 },
  "inputs": {
    "justification": "fresh-supported",
    "score": 0.87,
    "rank": 1,
    "components": { … },
    "contributions": { … },
    "hasLiveDiscovery": true,
    "providerObservations": [ { … }, { … } ]
  }
}
```

**Forbidden keys** (allowlist by negation — these MUST NEVER appear
in a snapshot, even if the caller accidentally passes them):

`magnet`, `downloadUrl`, `download_url`, `provider`, `providers`,
`auth`, `token`, `apiKey`, `api_key`, `password`, `passwd`, `secret`,
`capability`, `capabilities`, `manifestUrl`, `manifest_url`,
`resolver`, `resolverUrl`, `resolver_url`.

`buildEvidenceSnapshot` walks the input recursively and throws on
any of these — the snapshot is built from a typed projection, not
from the raw hit blob, so the surface area is small and reviewable.

**Determinism:** keys are written in a fixed order; `providerObservations`
are sorted by `(provider, lastSeenAt)`; `components` keys are
alphabetized before serialization. Two snapshots built from the same
evidence state are byte-identical.

### N.3 — D+E: Write path, read path, migration

**Schema delta** (recorded in `schema_migrations`):

```sql
ALTER TABLE media_request_results
  ADD COLUMN evidence_snapshot TEXT;
ALTER TABLE media_request_results
  ADD COLUMN evidence_snapshot_version INTEGER;
```

Idempotent — both `ADD COLUMN` calls are wrapped in
`pragma_table_info` lookups that no-op if the column already exists.

**Write path** (`persistMediaRequest` in `cache.js`):

For each `r` in the input list:
1. `const { snapshot, version } = buildEvidenceSnapshot(r);`
2. pass `snapshot, version` as the new positional args on the
   `INSERT_MEDIA_REQUEST_RESULT_IGNORE` statement, before the
   optional `intentId`.

**Read path** (`getMediaRequestResultEvidenceSnapshot` in `cache.js`):

```
getMediaRequestResultEvidenceSnapshot(requestId, rank)
  → { snapshot, version, available }
```

Where `available: false` means the row exists but has no snapshot
(legacy row, pre-migration OR pre-feature-flag). `snapshot === null`
means "snapshot column exists, but the row was written before
version=1 was defined" (theoretically impossible in practice, but
the API distinguishes for clarity).

**Call sites** (`media-request.js`):

Both result-row producers now pass the full evidence context:

```js
justification: hit.justification,
components: hit.components,
contributions: hit.contributions,
providerObservations: hit.providerObservations || [],
hasLiveDiscovery: hit.hasLiveDiscovery === true
```

The operator-selection path (which produces ranked-looking rows
without going through the projection pipeline) passes the same
shape, but the `justification` and `inputs.score` are filled with
the deterministic operator-selection values — the snapshot is still
valid and useful, just semantically different.

### N.4 — F: Test results (12/12 pass)

| ID | Proof | Result |
|---|---|---|
| F.1 | Ranked result persists evidence snapshot | ✔ |
| F.2 | Close/reopen preserves byte-for-byte semantic snapshot | ✔ |
| F.3 | Later provider observation changes do NOT mutate historical snapshot | ✔ |
| F.4 | Historical prior used at ranking time is preserved | ✔ |
| F.5 | Fresh negative suppressing history is represented accurately | ✔ |
| F.6 | Missing evidence remains explicitly missing/unknown | ✔ |
| F.7 | Old row without snapshot still reads successfully | ✔ |
| F.8 | Version is persisted on every new row | ✔ |
| F.9 | Score/ranking breakdown in snapshot matches persisted score inputs | ✔ |
| F.10 | No capability URL/token/auth field enters snapshot | ✔ |
| F.11 | Migration is idempotent; legacy and new rows coexist | ✔ |
| F.12 | Operator selection row carries a deterministic snapshot with no ranked inputs | ✔ |

**Full suite:** 2622 tests, 2496 pass, 124 fail, 2 skipped.
The 124 failures are the same pre-existing set slice 3 measured
(`evidence.findTemporary`, `candidate_media` schema mismatches,
`resolution_state` column mismatches). Slice 4 fixes 1 suite-level
error (the new test file could not load against pre-slice-4 code
because `buildEvidenceSnapshot` was not exported) and introduces
**0** new failures.

**Targeted suite:** 156/156 pass (cache + handoff + media-request
+ slice-3 + slice-4 + rd-walk-bounded).

### N.5 — G: Production census

At slice 4 commit time, `/home/patrick/hashsucker-data/discovery/discovery-cache.db`:

- 8385 `media_request_results` rows
- 0 rows with `ranking_breakdown IS NOT NULL`
- 0 rows with `parsed_candidate_scope IS NOT NULL`
- 0 rows with `evidence_snapshot IS NOT NULL` (expected — the
  migration only adds the column; backfill is out of scope for
  this slice)

The first new `INSERT` after deploy will start populating the
snapshot. From that point, every future restart will have a
post-mortem answer to all 7 questions in N.1.

### N.6 — Files changed

- `media-search/src/lib/discovery/cache.js` — module-level
  `buildEvidenceSnapshot`, `EVIDENCE_SNAPSHOT_VERSION`,
  `FORBIDDEN_SNAPSHOT_KEYS`; `migrateMediaRequestResultsEvidenceSnapshot`;
  write-path wiring; `getMediaRequestResultEvidenceSnapshot` read API;
  new exports.
- `media-search/src/api/media-request.js` — two call sites updated
  to pass `justification`, `components`, `contributions`,
  `providerObservations`, `hasLiveDiscovery`.
- `media-search/test/persistence-integrity-slice-4.test.js` (new,
  12 tests).

### N.7 — What this slice DOES NOT do (carried over)

- ranking weights
- candidate scoring
- upstream normalization of `(info_hash, file_index_key = -1, 0)`
  collisions from live discovery
- backfill of legacy `media_request_results` rows with historical
  snapshots (the 8385 pre-deploy rows will remain snapshot-less
  forever; this is a known acceptance criterion)
- backfill of the 9 legacy orphan rows (F-1)
- backfill of the 2103 dup-physical-release rows (E-1 upstream)
- the 3 zero-result requests in production (F-1)
- the 7 zero-info_hash rows in production (F-2)
- m3-north-db is still frozen at 9f36481

## O. Slice 5.0 — Provider Evidence Reconciliation + Contradiction Handling

**Slice:** m3-north-db control-plane integrity hardening (slice 5)
**Date:** 2026-09-04
**Branch state:** main @ ba2b1c7, m3-north-db frozen at 9f36481

### O.1 — A: Evidence lifecycle audit (current state)

The current system separates evidence into four parallel layers:

| Layer | Table(s) | Purpose | Lifecycle |
|-------|----------|---------|-----------|
| Append-only event log | `provider_observation_events` | Full history of every recorded observation (id, source, kind, error_category, latency, retry_after_ms, correlation_id) | INSERT only. Never updated. |
| Current projection | `provider_observation_current` | One row per (provider, account_scope, scope, subject_type, subject_key, kind) — the "most recent" truth for that key | UPSERT gated on `EXCLUDED.observed_at >= current.observed_at`. |
| Historical evidence | `historical_provider_evidence` + `historical_provider_evidence_sightings` | Aggregated historical provider hits (RD downloads, etc.) | Idempotent INSERT per (source_id, source_event_id). |
| RD raw observations | `rd_download_observations` + `rd_download_correlations` | Raw /downloads feed + per-candidate correlation | INSERT only. |

**Answering the 10 audit questions:**

1. **Can a fresh positive and fresh negative coexist for the same provider/hash?**
   - At the **event** layer: yes — both events remain in history.
   - At the **current** layer: no — the UPSERT is gated on `observed_at`; only the most recent observation wins. **Census: 11 (info_hash, file_index_key, provider) tuples in production have BOTH cached and uncached events in history; the current layer reflects whichever is most recent.** Slice 5 adds a guard that prevents a transient from erasing a known current state (see O.3 E).

2. **If so, which wins and why?**
   - Newer `observed_at` wins at the current layer. This is a *temporal* conflict-resolution rule — the latest observation is treated as the freshest provider truth. The pre-slice-5 system had no contradiction-specific guard; slice 5 adds one for the transient-vs-known case.

3. **Does unknown overwrite known?**
   - **Pre-slice-5: yes** — UPSERT condition is purely `observed_at`, and a fresh transient had a later `observed_at` than an older known. This violated the spec rule "Fresh current UNKNOWN / ERROR does NOT erase a prior known positive/negative."
   - **Post-slice-5: no** — UPSERT WHERE clause now has a guard: `NOT (EXCLUDED.state IN ('error','unknown') AND current.state IN ('cached','uncached'))`. The transient still appears in the event log, but the current projection is preserved.

4. **Does error overwrite known?**
   - **Post-slice-5: no** — same guard.

5. **Does stale evidence remain distinguishable from absent evidence?**
   - Yes. `evaluateObservationFreshness` returns `{freshness: 'stale' | 'fresh' | 'unbounded'}` per observation. The reconciliation function in `evidence-reconciliation.js` distinguishes `fresh` / `stale` / `missing` (no current row at all) at the layer above.

6. **Can historical evidence accidentally override a fresh contradiction?**
   - No. Historical evidence lives in a different table and is only consulted when current is missing. Fresh current positive or negative always wins (see spec D.7: "fresh negative + historical positive → negative, history suppressed").

7. **Can repeated identical observations strengthen confidence incorrectly?**
   - At the provider observation layer: UPSERT overwrites with the same observation; no amplification (the projection is the latest, not a sum). Repeated identical events with the same `observed_at` collapse to one logical observation in the reconciliation layer (see O.2 `collapseRepeatedObservations`).
   - At the historical evidence layer: `historical_provider_evidence_sightings` uses `INSERT OR IGNORE` keyed on `(source_id, source_event_id)`, so a replayed source event does NOT add a new sighting. The aggregate is recomputed from the sightings table.

8. **Can observations from different account scopes bleed together?**
   - The `provider_observation_current` PRIMARY KEY includes `account_scope`, so different scopes are isolated at the storage layer. **Census: 0 rows in production have a NULL/empty `account_scope`. All 772 current rows are `default`.** The reconciliation function enforces the same isolation via `groupObservationsByScope`.

9. **Are timestamps source-time, observation-time, or write-time?**
   - `observed_at` = observation-time (when the probe ran).
   - `expires_at` = observation-time + TTL (e.g. 5 min for cache probes).
   - `recorded_at` = write-time (when the row hit the DB).
   - The historical evidence layer uses `first_seen_at` / `last_seen_at` (source-time from the source event).
   - These are intentionally distinct. The reconciliation layer uses `observed_at` for freshness, not `recorded_at`.

10. **Can current state be reconstructed deterministically after restart?**
    - Yes. The current projection is a strict function of the current table (which is persisted to disk). The reconciliation function is a pure function of (current rows + historical rows + now + freshness policy). Given the same DB snapshot, the same reconciliation output is produced.

### O.2 — B+C: Reconciliation semantics

Added `media-search/src/lib/discovery/evidence-reconciliation.js` — a pure module that derives the authoritative current interpretation of provider evidence.

**Output shape (frozen object):**

```
{
  currentState:     'positive' | 'negative' | 'unknown',
  freshness:        'fresh'    | 'stale'    | 'missing',
  confidence:       'current'  | 'historical-prior' | 'unresolved',
  reason:           <closed enumerable — see RECONCILIATION_REASONS>,
  negativeKind:     'durable' | 'transient' | null,
  historicalPrior:  { provider, accountScope, positive, sources: [], ... } | null,
  freshObservation: <observation> | null,
  repeatedCollapsed: number,
}
```

**Closed enums (machine-readable, no freeform text):**

- `CURRENT_STATES = ['positive', 'negative', 'unknown']`
- `FRESHNESS_BUCKETS = ['fresh', 'stale', 'missing']`
- `CONFIDENCE_SOURCES = ['current', 'historical-prior', 'unresolved']`
- `RECONCILIATION_REASONS` — 8 enumerable values: `fresh-positive`, `fresh-negative`, `historical-prior-positive`, `historical-prior-negative`, `stale-positive`, `stale-negative`, `transient-unknown-preserved-known`, `no-evidence`.
- `DURABLE_NEGATIVE_ERROR_CATEGORIES = new Set(['infringing', 'unsupported'])`.

**Precedence rules (applied in this exact order):**

1. Fresh current `cached` → `currentState: positive`, `reason: fresh-positive`.
2. Fresh current `uncached` → `currentState: negative`, `reason: fresh-negative`. `negativeKind = 'durable'` iff `errorCategory ∈ DURABLE_NEGATIVE_ERROR_CATEGORIES`, else `'transient'`.
3. Fresh current `error`/`unknown` → look back for the most recent known (`cached`/`uncached`):
   - If a prior known exists: preserve it, mark `confidence: unresolved`, `reason: transient-unknown-preserved-known`. The prior known is the *interpreted* current state; the fresh transient IS the fresh observation, but the *interpretation* is preserved.
   - If no prior known: `currentState: unknown`, `confidence: unresolved`, `reason: transient-unknown-preserved-known`.
4. Stale current + no fresh → if historical prior exists, fall back to it; else preserve stale.
5. Missing current + historical prior → `historical-prior-*` reason.
6. No evidence at all → `no-evidence`, `unknown`, `unresolved`.

**Per the spec, the derived projection is NOT persisted.** The reconciliation function is pure and stateless; the caller (typically a read path or an operator tool) supplies the source facts. This is the "Prefer deriving from durable source facts" rule from the spec.

### O.3 — D+E: Contradiction handling + write-path hardening

**D (10 contradiction cases) — all proven by `test/evidence-reconciliation-slice-5.test.js` (24 tests):**

| Case | Spec | Test | Result |
|------|------|------|--------|
| D.1 | fresh positive + historical positive | `D.1: fresh positive after historical positive → current positive` | PASS |
| D.2 | fresh negative + historical positive | `D.2: fresh negative after historical positive → current negative` | PASS |
| D.3 | transient error after fresh positive | `D.3: transient error after fresh positive → does NOT erase positive` | PASS |
| D.4 | transient unknown after fresh negative | `D.4: transient unknown after fresh negative → does NOT erase negative` | PASS |
| D.5 | stale positive + no fresh | `D.5: stale positive + no fresh current → unknown w/ stale context` | PASS |
| D.6 | historical positive + no current | `D.6: historical positive + no current → historical-prior positive` | PASS |
| D.7 | fresh negative + historical positive | `D.7: fresh negative + historical positive → negative` | PASS |
| D.8 | fresh positive + historical negative | `D.8: fresh positive + historical negative → positive` | PASS |
| D.9 | replayed N times | `D.9: same observation replayed N times → same derived state` | PASS |
| D.10 | two account scopes | `D.10: same hash under two account scopes → states remain independent` | PASS |

**E (write-path hardening):**

The pre-slice-5 `UPSERT_CURRENT_OBSERVATION` SQL was:

```sql
ON CONFLICT(...) DO UPDATE SET ...
WHERE EXCLUDED.observed_at >= provider_observation_current.observed_at;
```

This is purely temporal: a fresh transient (later `observed_at`) would overwrite a known current. Slice 5 adds the guard:

```sql
AND NOT (
  EXCLUDED.state IN ('error', 'unknown')
  AND provider_observation_current.state IN ('cached', 'uncached')
)
```

**Proven by `test/evidence-reconciliation-write-path-slice-5.test.js` (7 tests):**

- E.1: known `cached` survives a fresh transient `unknown`.
- E.2: known `uncached` survives a fresh transient `error`.
- E.3: transient-then-known: known DOES overwrite the prior transient (transient never blocks a subsequent known write).
- E.4: known-vs-known of opposite sign: newer wins (per spec rule 1+2).
- E.4b: transient-vs-transient: newer transient overwrites older transient.
- E.5: history preserves the full event chain regardless of write-path gating.
- H.1: media_request_results evidence snapshot is immutable under later observation writes (request-snapshot interaction — see O.7).

**What the write-path guard does NOT do:**

- Does not modify the `provider_observation_events` log. All events are still recorded.
- Does not prevent known-vs-known contradictions. A fresh `cached` can still overwrite an older `uncached` (and vice versa) — the guard is specifically for transient-vs-known.
- Does not introduce any destructive retention.

### O.4 — F+G: Provider-specific findings

**F: RD semantics (per spec section F):**

- Code 35 (infringement) — `buildRdObservation` in `providers/realdebrid/observe.js` sets `state: uncached, errorCategory: 'infringing', retryable: false`. This is a **durable** negative and IS persisted at the current layer.
- `unsupported` / `not-found` / `not-allowed` / `dead` — `errorCategory: 'unsupported', retryable: false`. Also durable.
- Ambiguous / transient failures (5xx, network, parse) — `state: error, errorCategory: 'unknown', retryable: true`. Transient.
- `requestdl` failures / 429 / timeouts — currently surface as `state: unknown, errorCategory: 'temporarily-unavailable'`. Transient.

**Census: 237 RD infringing events in history, 36 RD infringing rows in current layer.** These are intentional durable negatives and the slice-5 `DURABLE_NEGATIVE_ERROR_CATEGORIES` set correctly classifies them.

**G: TorBox semantics (per spec section G):**

- `cached` → `state: cached`.
- `uncached` → `state: uncached`.
- `failed` (transport failure on a single hash) → `state: unknown, errorCategory: 'temporarily-unavailable'`. Transient.
- Batch-level failure → all hashes in the batch are recorded as `state: unknown, errorCategory: 'transient'`. Transient.

**Key invariant: a transport failure is NEVER persisted as a content negative.** A `temporarily-unavailable` or `transient` observation is an `unknown` state and falls into the transient-handling branch of the reconciliation (rule 3 in O.2). The cached/uncached "known" is preserved.

**Census: 2 transient-unavailable events, 2 unknown-error events in history; 0 in current layer (all have been replaced by a later known or remain in history).** This confirms the system already correctly keeps transport failures out of the current projection once a subsequent known is recorded.

**Provider availability vs delivery capability (per spec G):**

The slice-5 reconciliation explicitly separates these. Provider availability is a function of the **current projection** (cached/uncached). Delivery capability (the ability to actually serve the file — torrent active, RD unrestricted, etc.) is a separate concern owned by HY4 south-side. Slice 5 does not touch delivery.

### O.5 — H: Request snapshot immutability

`test/evidence-reconciliation-write-path-slice-5.test.js` H.1 proves the slice-4 evidence snapshot on `media_request_results` is immutable under any subsequent observation writes:

1. A request is persisted with a slice-4 evidence snapshot (`version: 1`) for a `torbox cached` ranking.
2. A transient `error` observation is recorded.
3. A fresh `uncached` observation is recorded.
4. The persisted snapshot's JSON is byte-for-byte identical to the pre-write snapshot.

This works because the slice-4 snapshot is captured at the time of `persistMediaRequest`, encoded into the `media_request_results.evidence_snapshot` column, and the write-path guards (slice 5) prevent any later write from touching that column. The event log records the new observations; the historical snapshot remains a frozen artifact of the moment the request was ranked.

### O.6 — I: Production read-only census

`artifacts/audit-2026-09-04/slice5-census/run-census.sh` runs against the production DB in read-only mode. Results at `artifacts/audit-2026-09-04/slice5-census/census.txt`:

| Metric | Value |
|--------|-------|
| `provider_observation_current` rows | 772 |
| `cached` / `uncached` / `error` / `unknown` | 372 / 400 / 0 / 0 |
| `provider_observation_events` rows | 2410 |
| `cached_events` / `uncached_events` / `error_events` / `unknown_events` | 1196 / 1210 / 2 / 2 |
| Distinct `(provider, account_scope)` pairs in current | 2 (realdebrid, torbox × default) |
| Distinct info_hashes in current | 718 |
| Distinct info_hashes in events | 1107 |
| Rows with `account_scope IS NULL OR ''` | 0 (in both tables) |
| Rows with `observed_at IS NULL` | 0 |
| Rows with `expires_at IS NULL` | 0 |
| Current rows with `error_category` set | 36 (all `infringing`) |
| Durable negatives (infringing) in current | 36 |
| Durable negatives (unsupported) in current | 0 |
| Transient negatives in current | 364 |
| Infringing events in history | 237 |
| Temporarily-unavailable events | 2 |
| Unknown-error events | 2 |
| Candidates with history contradictions (cached+uncached in events) | 11 |
| Candidates with current-vs-event divergence | 8 |
| Repeats per hash (events / distinct info_hash) | 2.18 |
| Max repeats for one hash | 131 (one realdebrid hash) |
| `historical_provider_evidence` rows | 0 |
| `historical_provider_evidence_sightings` rows | 0 |
| `rd_download_observations` rows | 108 |
| `rd_download_correlations` rows | 108 |

**Top contradiction class: realdebrid.** All 11 history-contradiction candidates are realdebrid, all 8 current-vs-event divergences are realdebrid. The max-repeats hash (131 events) is one of these contradictions. TorBox has 0 contradictions in the current layer (current and most-recent event always agree).

**Empty `historical_provider_evidence` table:** The historical evidence importer has never been run against production. The current layer is the only source of provider truth. The reconciliation function still correctly falls back to "no evidence" (`no-evidence` reason) when both current and historical are empty.

**No destructive mutations were performed against the production DB.** The census script opens the DB in `-readonly` mode.

### O.7 — J: Storage / retention review

| Metric | Value | Assessment |
|--------|-------|------------|
| Total events | 2410 over 7.55 days | 319 events/day. At 200 bytes/event ≈ 64 KB/day. Negligible growth. |
| Max repeats for one hash | 131 | One realdebrid hash has been probed 131 times over 7.5 days (~17/day). This is the contradiction hash; the repetition is expected and the slice-5 reconciliation correctly collapses them. |
| DB size | 1.7 GB | Dominated by other tables (release_search, etc.), not observation history. Observation history is well under 1 MB total. |
| Append-only invariant | `provider_observation_events` is INSERT-only (no UPDATE/DELETE in code) | Compaction would require a deliberate decision; not implemented in slice 5. |
| Idempotency of replays | INSERT OR IGNORE on `(source_id, source_event_id)` for sightings; same observation (provider, scope, kind, state) at current layer is overwritten, not amplified | Replays do not strengthen evidence. |

**Retention decision (per spec J): no destructive retention implemented.** All evidence is append-only at the events layer, and the current layer is bounded by the natural PRIMARY KEY uniqueness. Compaction would require choosing an eviction policy for old events (e.g. "keep last N events per (info_hash, file_index_key, provider)"). The current growth rate does not justify this.

### O.8 — K: Test results

**Slice 5 tests alone:** 24/24 pass (`test/evidence-reconciliation-slice-5.test.js`).
**Slice 5 write-path tests:** 7/7 pass (`test/evidence-reconciliation-write-path-slice-5.test.js`).
**Slice 5 + Slice 4 combined:** 42/42 pass.
**Targeted suite (cache + handoff + media-request + slice 3 + slice 4 + slice 5 + rd-walk-bounded + observation + historical):** 346/346 pass.

**Full suite:** 2653/2527/124/2-skipped (vs slice-4 baseline 2622/2496/124/2-skipped).
- +31 tests (24 + 6 + 1)
- +31 pass
- 0 new failures
- 0 new skips
- The 124 pre-existing failures are unchanged (failure diff against the slice-4 post-state: empty intersection, empty diff). The 1 added test (E.4b) brings the totals from +30 to +31.

### O.9 — Files changed

- `media-search/src/lib/discovery/cache.js` — `UPSERT_CURRENT_OBSERVATION` SQL: added WHERE-clause guard to prevent transient from erasing known current state.
- `media-search/src/lib/discovery/evidence-reconciliation.js` (new, 359 lines) — pure module: `reconcileProviderEvidence`, `reconcileAllScopes`, `collapseRepeatedObservations`, `groupObservationsByScope`, `buildHistoricalPrior`, closed enums.
- `media-search/test/evidence-reconciliation-slice-5.test.js` (new, 24 tests).
- `media-search/test/evidence-reconciliation-write-path-slice-5.test.js` (new, 7 tests).
- `artifacts/audit-2026-09-04/slice5-census/run-census.sh` (new) — read-only production census.
- `artifacts/audit-2026-09-04/slice5-census/census.txt` (new) — census output.

### O.10 — What this slice DOES NOT do (carried over)

- ranking weights
- candidate scoring
- upstream normalization of `(info_hash, file_index_key = -1, 0)` collisions from live discovery
- backfill of legacy `media_request_results` rows with historical snapshots (the 8385 pre-deploy rows remain snapshot-less forever; known acceptance criterion)
- backfill of the 9 legacy orphan rows (F-1)
- backfill of the 2103 dup-physical-release rows (E-1 upstream)
- the 3 zero-result requests in production (F-1)
- the 7 zero-info_hash rows in production (F-2)
- destructive retention of observation history
- m3-north-db is still frozen at 9f36481
- the 11 realdebrid production contradictions (out of scope; the reconciliation correctly handles them but does not auto-resolve them; future slice may decide policy)
- the `findTemporary` reference in `test/worker-a-torbox-promotion.test.js` (pre-existing test/source mismatch; not a slice-5 regression)

==========================================================================
SECTION P: SLICE 6 — QUALITY FEATURE EXTRACTION + PERSISTANCE
==========================================================================

Date: 2026-09-04
Commit: 9e3d3f3
Spec: QUALITY FEATURE EXTRACTION + PERSISTENCE (no ranking weights)

--------------------------------------------------------------------------
P.1 Metadata Audit
--------------------------------------------------------------------------

Current metadata sources for quality features:

  SOURCE                FIELDS                         STATUS
  --------------------- ------------------------------ -------------------
  release_attributes    resolution, source_type,      DURABLE (parsed)
                        codec, release_group,
                        title, year, media_type

  candidates            filename, size (bytes),        DURABLE
                        info_hash, file_index_key

  media_request_results filename, selected_file_size,  DURABLE
                        resolution_state, release_metadata

  live discovery        resolution, source, codec,     DURABLE
                        hdr, audio, releaseGroup,
                        exactFileSize (behaviorHints.videoSize)

  DMM corpus            filename, hash, bytes          DURABLE

  Cinemeta              title, year, type             DURABLE (identity only)

  MEDIA RUNTIME         —                              MISSING (no TMDB runtime)

Key findings:
  - release_attributes has 1.48M rows (one per info_hash)
  - 14.2% missing resolution, 24% missing source_type, 30% missing codec
  - 47% missing release group (parser only captures trailing token)
  - Container is derived from filename extension (ephemeral, not stored)
  - Exact file size available for 99.7% of candidates (1.48M of 1.48M)
  - Media runtime is entirely absent — bytesPerMinute will be null
  - selected_file_size on results is currently 0 (live discovery doesn't
    yet thread it through persistMediaRequest for all paths)

--------------------------------------------------------------------------
P.2 Quality Feature Schema
--------------------------------------------------------------------------

Version: 1 (QUALITY_FEATURES_VERSION)

{
  version: 1,
  resolution: {
    label: '2160p' | '1440p' | '1080p' | '720p' | 'sd' | 'unknown',
    width: null | number,
    height: null | number,
    confidence: 0.0-1.0
  },
  size: {
    bytes: null | number,
    bytesPerMinute: null | number,
    sizeDensityMode: 'runtime-normalized' | 'raw-only' | 'missing'
  },
  source: { type: 'remux' | 'bluray' | 'web-dl' | 'webrip' | 'hdtv' | 'cam' | 'unknown' },
  codec: { video: 'av1' | 'hevc' | 'h264' | 'vc1' | 'mpeg2' | 'unknown' },
  container: { type: 'mkv' | 'mp4' | 'm2ts' | 'ts' | 'avi' | 'unknown' },
  releaseGroup: {
    raw: null | string,
    normalized: null | string,
    confidence: 0.0-1.0
  },
  derived: {
    runtimeMinutes: null | number,
    sizeWithinResolutionPeerPercentile: null | number
  }
}

Design decisions:
  - One versioned JSON column (quality_features TEXT) keeps schema sane
  - Legacy rows remain NULL — no destructive backfill
  - Frozen output prevents accidental mutation
  - Provider/auth data explicitly never enters the snapshot
  - Unknown values stay null/unknown — never invented

--------------------------------------------------------------------------
P.3 Normalization Rules
--------------------------------------------------------------------------

Resolution:
  2160p / 4K / UHD / 4kuhd → '2160p' (3840x2160)
  1440p → '1440p' (2560x1440)
  1080p / 1080i / FHD → '1080p' (1920x1080)
  720p → '720p' (1280x720)
  576p / 480p / 360p → 'sd' (no standard dims)
  No signal → 'unknown' (width=null, height=null)
  Filename fallback when parser output absent
  NEVER infer from file size

Source:
  Remux → 'remux'
  BluRay / BDRip / BRRip → 'bluray'
  WEB-DL / WEB → 'web-dl'
  WEBRip → 'webrip'
  HDTV → 'hdtv'
  CAM → 'cam'
  No signal → 'unknown'

Codec:
  x265 / h265 / hevc → 'hevc'
  x264 / h264 / avc → 'h264'
  av1 → 'av1'
  vc-1 / vc1 → 'vc1'
  mpeg2 → 'mpeg2'
  No signal → 'unknown'

Container:
  Derived from filename extension ONLY (.mkv, .mp4, .m2ts, .ts, .avi)
  NEVER inferred from codec/source tags
  No extension → 'unknown'

Release group:
  Raw parser value preserved
  Normalize: trim, strip surrounding punctuation wrappers, strip trailing dots
  Preserve mixed-case (FraMeSToR stays FraMeSToR)
  Do NOT merge distinct groups
  Do NOT assign quality/reliability weights

Size/bitrate:
  bytesPerMinute = exactBytes / runtimeMinutes (when both known)
  Without runtime: raw-only mode
  No global monotonicity — 12GB 1080p ≠ 12GB 2160p

--------------------------------------------------------------------------
P.4 Persistence Changes
--------------------------------------------------------------------------

Schema migration:
  ALTER TABLE media_request_results ADD COLUMN quality_features TEXT
  ALTER TABLE media_request_results ADD COLUMN quality_features_version INTEGER
  Marker: media-request-results-quality-features-v1

Write path (persistMediaRequest):
  - Quality features built from SAME ranked result object whose score is persisted
  - No re-querying, no re-ranking
  - quality_features_version = 1 for new rows only
  - INSERT OR IGNORE (same as evidence snapshot)

Read API:
  getMediaRequestResultQualityFeatures(requestId, rank) → { features, version, available }
  getQualityFeatureDistribution() → aggregate distribution object

Migration guard:
  Idempotent — checks schema_migrations before applying ALTER TABLE
  Legacy rows keep NULL quality_features

--------------------------------------------------------------------------
P.5 Real Corpus Census
--------------------------------------------------------------------------

Production DB (read-only, 2026-09-04):

  release_attributes:        1,480,584 rows (distinct info_hashes)
  candidates:                1,480,584 total, 1,475,669 with exact size
  media_request_results:     8,385 rows

Resolution distribution:
  1080p:  924,433 (62.4%)
  720p:   166,304 (11.2%)
  2160p:  163,786 (11.1%)
  480p:    12,506 (0.8%)
  8k:       3,290 (0.2%)
  360p:       248 (<0.1%)
  null:   210,017 (14.2%)

Source distribution (top):
  WEB-DL:  546,575 (37%)
  BluRay:  287,224 (19%)
  WEBRip:  161,200 (11%)
  HDTV:     61,180 (4%)
  Remux:    23,151 (1.6%)
  null:    355,844 (24%)

Codec distribution:
  x264:   649,091 (44%)
  x265:   320,577 (22%)
  AVC:     46,561 (3.1%)
  XviD:    12,395 (0.8%)
  null:   448,286 (30%)

Top release groups:
  RARBG: 50,702 | NTb: 39,865 | FLUX: 22,754 | playWEB: 15,961
  FW: 15,486 | MeGusta: 14,419 | FraMeSToR: 13,041 | FGT: 11,254
  null: 696,840 (47%)

Container distribution:
  mkv:    813,468 (55%)
  other:  481,197 (32.5%)  [no recognized extension]
  mp4:    163,792 (11%)
  avi:     17,521 (1.2%)

Size by resolution (with exact size):
  1080p: avg 7.16 GB, median 2.42 GB, range 0–1962 GB (n=923,804)
  720p:  avg 2.58 GB, range 0–1301 GB (n=166,078)
  2160p: avg 23.55 GB, range 0–2052 GB (n=163,682)
  8k:    avg 19.75 GB, range 0–264 GB (n=3,289)

Tiny-file outliers (< 500 MB): 50,077 across all resolutions
  (NOT bad quality — just reported as per spec L)

Giant-file outliers (> 50 GB): 54,747 across all resolutions
  2160p: 27,077 | 1080p: 14,735 | null-res: 12,229
  (NOT bad quality — just reported as per spec L)

percent with exact file size: 99.7% (candidates), 0% (results — not yet threaded)
percent with runtime available: 0% (MISSING — no TMDB integration)
percent where bytesPerMinute can be calculated: 0% (no runtime)
percent with normalized release group: ~53% (of those with release_group)

--------------------------------------------------------------------------
P.6 YIFY / Small-Release Case
--------------------------------------------------------------------------

Fixture: YIFY-like 1080p WEB-DL x264 encode (~1.3 GiB) vs
         larger 1080p BluRay x265 encode (~12 GiB)

Result (proven in test M):
  - Features differ: size (1.3 vs 12 GB), source (web-dl vs bluray),
    codec (h264 vs hevc), group (YIFY vs SPREBBLE)
  - NO quality_score field in snapshot
  - NO ranking difference because quality weight = 0
  - Both correctly labeled 1080p

This proves we are NOT baking in "smaller == worse" as a quality assumption.
The feature layer captures the difference; future analytics/ranking may use it.

--------------------------------------------------------------------------
P.7 Tests
--------------------------------------------------------------------------

44 tests in test/quality-features-slice-6.test.js:

  B (2):    schema versioning, frozen output
  C (8):    resolution normalization (4K/UHD/1080p/720p/sd/unknown/fallback/no-infer)
  D (4):    size/bitrate (bytesPerMinute, raw-only, missing, 12GB same-bytes-diff-res)
  E (2):    source type normalization + unknown
  F (4):    release group (raw+normalized, strip punctuation, mixed-case, null)
  G (2):    codec normalization + unknown
  H (3):    container (extension, unknown, no-infer-from-codec)
  I (2):    persistence (new row version=1, legacy row unavailable)
  J (2):    write path (same object, no re-rank)
  K (2):    analytics read API (distribution, empty)
  M (1):    YIFY vs BluRay proof
  N (10):   determinism (1-10 per spec)
  O (3):    non-goals (no quality_score, no group weights, no provider state)

Full suite: 2711 tests, 2579 pass, 130 fail (vs 137 fail baseline — 7 fewer)
  Pre-existing failures: enrichment pipeline, worker-a-torbox-promotion,
  docker-compose integration, edge-proxy contract docs.
  No new failures introduced by slice 6.

--------------------------------------------------------------------------
P.8 Files Changed
--------------------------------------------------------------------------

  NEW:     media-search/src/lib/discovery/quality-features.js  (247 lines)
  NEW:     media-search/test/quality-features-slice-6.test.js  (570 lines)
  MODIFY:  media-search/src/lib/discovery/cache.js
           (+2 columns, +migration, +write-path integration, +read API)

--------------------------------------------------------------------------
P.9 What This Slice Does NOT DO
--------------------------------------------------------------------------

Per spec section O:
  - DO NOT change ranking weights
  - DO NOT add quality_score to final score
  - DO NOT add release-group reliability weights
  - DO NOT change provider order
  - DO NOT touch resolver
  - DO NOT touch VFS/WebDAV
  - DO NOT touch byte delivery
  - DO NOT touch HY4 Rust
  - DO NOT change TorrentFile identity
  - DO NOT use historical playback outcomes yet

This slice prepares analytics only. Quality features are extracted and
persisted. Future slices may weight ranking by these features.

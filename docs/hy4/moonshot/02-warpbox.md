# `mainlink0435/warpbox` — capability cache, negative cache, circuit breaker, API accounting

**Repo:** `research/moonshot-refs/warpbox` · **Language:** Go 1.26.2 · **Shape:** single-provider
(TorBox) WebDAV proxy in front of rclone → Plex/Jellyfin. ~15,100 lines (≈6,400 prod, rest tests).

**Why it matters here:** warpbox is the most *deliberately engineered* resilience layer in the
corpus, and it ships a decision log (`docs/decision-log.md`, D-001…D-030) justifying each choice.
Its failure taxonomy — **what kind of claim a failure licenses you to make about durable state** —
is the single best idea any of the six references contributed.

---

## 1. Architecture and the two request paths

**Browse path — ZERO provider API calls:**

```
rclone PROPFIND /webdav/movies/
  → handleWebDAV (server.go:835) → handlePropfind (propfind.go:92)
      → store.ListDir(prefix)          propfind.go:112   (SQLite only)
      → filter.Apply(records)          propfind.go:120
      → 207 Multi-Status               propfind.go:226-229
  NO torbox.Client call. NO queue. NO throttle. NO negative cache consulted.

rclone HEAD /webdav/movies/x.mkv
  → handleHead (get.go:1079) → store.GetFileByPath → Content-Length + Accept-Ranges
  NO API call. Size/MIME come purely from SQLite.
```

**Materialization path — the only place provider work happens:**

```
GET /webdav/.../x.mkv (Range: bytes=0-33554431)
  → handleGet (get.go:29)
      → store.GetFileByPath                              get.go:46
      → no Range AND cached CDN URL? → 302 to CDN        get.go:73-82
      → else streamFileContent (get.go:92)
          → store.GetCDNURL(file.ID)                     get.go:94
          → MISS: fetchCDNURL (get.go:103)
              1. negative cache lookup (memory, 30 s)    get.go:670-686
              2. circuit breaker check (per itemID)      get.go:689-691
              3. getCDNURLWithRetry → queue.Enqueue      get.go:575-662
              4. on fail → negative cache write          get.go:698-704
              5. on success → clearTorrentFailure        get.go:710
          → store.SetCDNURL(file.ID, url, now+TTL)       get.go:126-131
          → parseRange → AcquireCDNConn → proxy to CDN   get.go:135-177
          → io.Copy(w, proxyResp.Body)                   get.go:378
```

> **Critical structural caveat.** warpbox's zero-API browse path is achieved by a **periodic eager
> sync** (default every 5 min) that flattens the whole provider library into SQLite — *not* by lazy
> materialization on first browse. Browsing is cheap because the catalog is pre-populated, not
> because it is lazy. **This is the sharpest divergence from HashSucker's model and is an
> anti-pattern for us (X8).** We already own the durable catalog; we should not re-fetch it.

## 2. Capability / CDN URL caching

Durable, in SQLite, as columns on the `files` row (`internal/metadata/store.go:106-124`):

```sql
cdn_url         TEXT NOT NULL DEFAULT '',
cdn_url_expires TEXT NOT NULL DEFAULT '',
...
UNIQUE(source, item_id, file_id)
```

| Constant | Default | Range |
|---|---|---|
| `cache.cdn_url_ttl_minutes` | **120** | 1–1440 |
| `cache.cdn_proxy_timeout_seconds` | 30 | 5–600 |
| `cache.cdn_url_429_backoff_seconds` | 30 | 1–300 |
| `max_cdn_connections` | 4 | 1–64 |
| `cdn_url_auto_repair` | true | |
| `cdn_url_repair_retries` | 2 | 0–10 |

Lazy expiry on read (`store.go:377-407`) — an expired entry reads as `""` and the caller blocks and
re-fetches synchronously.

**Two genuinely good details:**

1. **`UpsertFile`'s `ON CONFLICT DO UPDATE` deliberately omits `cdn_url` / `cdn_url_expires`**
   (`store.go:193-205`). A catalog sync therefore does **not** invalidate cached delivery URLs —
   a sync storm cannot become a re-materialization storm.
2. **Auto-repair on stale URL** (`get.go:187-227`): CDN 403/404 → re-fetch → update → retry.

**Port? Yes, with changes.** The durable-TTL-in-catalog shape maps directly onto a delivery column
on `ProviderPlacement`. But:

- **Do not copy lazy-only expiry.** Add stale-while-revalidate (a warm entry should be refreshed in
  the background, not force the next playback to eat a synchronous round-trip).
- **Add TTL jitter** so a large catalog's entries don't all expire in the same minute.
- TTL is a flat guess against an undocumented provider expiry; derive it from the provider's actual
  `Expires` where available and keep auto-repair as the safety net.

## 3. Negative caching — the key design that matters

Memory-only, `map[string]*negativeCacheEntry` (`server.go:131-133`):

```go
type negativeCacheEntry struct {
	err       error
	expiresAt time.Time
}
```

Key (`get.go:402-409`):

```go
func cdnCacheKey(source metadata.FileSource, itemID, fileID int64) string {
	src := "torrent"
	if source == metadata.SourceUsenet { src = "usenet" }
	return fmt.Sprintf("%s:%d:%d", src, itemID, fileID)
}
```

| Constant | Default |
|---|---|
| `negative_cache_ttl_seconds` | **30** |
| `negative_cache_max_entries` | 5000 |
| `cleanup_interval_seconds` | 60 |

### M7 — the split key space is the whole point

- **Positive** cache key = the **internal row id** (durable, path-derived).
- **Negative** cache key = the **provider tuple** `(source, itemID, fileID)` (ephemeral).
- **Breaker** key = **`itemID` only**, and the code states the rule outright (`server.go:59-61`):

```go
// IMPORTANT: trackers are keyed by item id only — never by hash or path — so
// that removing and re-adding a torrent at TorBox (which yields a new item id)
// produces a fresh tracker with no inherited quarantine.
```

**This makes "failure cannot poison identity" true by construction rather than by discipline.**
Adopt as an invariant. In HashSucker terms: negative state is keyed on the **Placement**, never on
`infoHash` and never on the canonical path.

### X6 — the flat 30 s TTL is wrong

All four write sites use the same undifferentiated TTL (`get.go:280, 305, 698, 948`), so these
share a cache entry:

- **429 rate-limit exhaustion** (transient, throttle-shaped)
- **403/404 content-gone**
- **5xx / network / timeout / HTML error page**
- **Auth (`BAD_TOKEN`)** — negative-cached per file even though the breaker deliberately refuses to
  quarantine on it (`get.go:618-628`)
- **416 size mismatch**

**Do not port this.** Split by failure class:

| Class | Correct treatment |
|---|---|
| content-absent | long TTL; should arguably demote a **Placement** |
| throttle / 429 | **should not be negative-cached at all** — it is a global signal; per-file caching hides it from the rate limiter |
| auth | global flag, not per-file entries |

### Eviction and pruning

`sweepNegativeCache` (`server.go:510-543`) — time expiry plus a soft cap (earliest-expiry-first).
The cap is **soft**: insertion never checks size, so burst growth between 60 s sweeps is unbounded.

`PruneBreakerForMissingItems` (`server.go:785-807`) purges negative entries whose item vanished from
the catalog; wired post-sync at `main.go:226-232`. **Cheap self-healing of ephemeral failure state
against durable truth — port this.**

### The one durable write from a transient probe

`get.go:263-290` — a CDN 416 whose `Content-Range: bytes */<size>` disagrees with the catalog size
writes `SetFileSize(file.ID, n)`. Self-heals on next sync, but it is a probe result mutating the
catalog. **Make this a deliberate, audited action in our port, never an accident.**

## 4. Circuit breaker

Per **TorBox item id** (`server.go:55-73`), not per account, not per file:

```go
type torrentFailureTracker struct {
	failures   []time.Time
	staleUntil time.Time
	errKind            failureKind
	lastErr            string
	errorCode          string
	escalations        int  // how many times the stale window has been doubled
	quarantineNotified bool
}
```

| Constant | Default | Notes |
|---|---|---|
| `circuit_breaker_failures` | 5 | |
| `circuit_breaker_window_seconds` | 600 | changed 60 → 600 in D-028 |
| `circuit_breaker_stale_minutes` | 5 | |
| `circuit_breaker_max_stale_minutes` | 60 | |
| `circuit_breaker_max_entries` | 2000 | |
| `breakerProbeInterval` | 15 s | hardcoded half-open window |

### M6 — the failure-kind taxonomy (best idea in the repo)

`classifyTorboxError` (`get.go:415-451`) produces `failureKindAuth` / `failureKindTransient` /
`failureKindDatabaseError`, and the taxonomy gates **what claim you are allowed to make about
durable state**:

```go
	if kind == failureKindDatabaseError && s.globalDegraded() {
		kind = failureKindTransient
	}
```

> A transient provider-wide outage is not evidence that this item is dead — downgrade so it is never
> labelled "remove and re-add". (`get.go:508-510`)

HashSucker equivalent, and this is the port target:

| Class | Meaning | Allowed effect |
|---|---|---|
| `auth` | account-level | invalidate **nothing** durable; raise a global flag |
| `transient` | provider blip / network / 5xx | fixed short cooldown; never touch `ProviderPlacement` |
| `structural` | item-scoped, provider healthy | escalate; **only here** may a **Placement** be demoted — never the Release or `TorrentFile` |

### Escalation and half-open

Escalation (`get.go:529-554`): `5 → 10 → 20 → 40 → 60 → 60 …` minutes, only for
`failureKindDatabaseError` while globally healthy.

Half-open (`get.go:453-481`): on stale expiry, re-arm a 15 s probe lock under the mutex so
concurrent callers skip while exactly one probe runs.

Success clears the **whole tracker** (`server.go:727-733`), losing failure history entirely.

**Port? Yes — re-scoped.** Key the breaker on the **Placement** (`release × provider account`),
which is the thing that can actually be dead; leave Release/`TorrentFile` untouched.

### Two real bugs to not reproduce

**(a) The escalation ladder is largely defeated by its own sweeper.**
`sweepCircuitBreaker` (`server.go:546-579`) deletes any tracker whose `staleUntil` has passed. But a
failed half-open probe returns early at `if len(active) < CircuitBreakerFailures { return }`
(`get.go:525-527`), leaving only the 15 s probe lock. Probes are paced by the 30 s negative cache,
so `staleUntil` sits in the past ~15 s out of every ~30 s, against a 60 s sweep ticker. The
tracker — and with it `escalations` and `failures` — is likely deleted before the ladder can climb.
**Fix: a failed probe must re-arm a real window; sweep on `staleUntil + grace`.**

**(b) `base << escalations`** with unbounded `escalations` collapses an overflowed shift back to the
*base* window (`get.go:538-540`) — a fail-open reset rather than a clamp. Remote (needs
`escalations ≈ 61`) but wrong-shaped.

## 5. Request suppression

No single-flight, no dedup, no coalescing, no jitter anywhere (grep-verified). What exists:

| Layer | Mechanism | Cite |
|---|---|---|
| 1 | Blocking throttle queue, min-interval pacer, **shared across sync + playback queues** | `queue.go:22-62`, `main.go:112-117` |
| 2 | Queue split (anti-starvation): sync's slow pagination must not hold playback hostage | D-030, `queue_split_test.go:18` |
| 3 | Hang/poll instead of error (200/206 then hold open) | `get.go:757-768` |
| 4 | CDN connection semaphore (4) acquired **before** `client.Do` | `server.go:354-362`, `get.go:175` |
| 5 | Sync in-flight CAS guard (the **only** dedup in the codebase) | `sync.go:259-269` |
| 6 | `globalDegraded()` health gate | `server.go:615-638` |
| 7 | 429 callback → counter | `client.go:476-480`, `main.go:121-124` |

`Limiter` (`queue.go:22-62`) is a **start-pacing min-interval**, not a token bucket: at 250 RPM that
is 240 ms start-to-start. It never accumulates credit and does not bound in-flight calls.

**Port, selectively:**

- **Yes:** shared `Limiter` + split queues. Generalizes to **one limiter per provider account**.
- **Yes:** the CDN connection semaphore — 8 lines, bounds the thing provider CDNs actually throttle.
- **Yes:** `syncOnce` in-flight CAS guard, if we run any reconciliation loop.
- **No (X9):** `Enqueue` is unbounded-blocking with no deadline, drop, shed or priority
  (`queue.go:136-138`). We *know* probe vs playback at the intent boundary — use it for a priority
  lane.
- **No (X18):** hang/poll. It is rclone-specific (`--max-error-count=10` + Plex trashing), holds a
  goroutine and a connection for up to 5 min, holds a semaphore slot, and has no jitter.
- **Add:** single-flight keyed on in-flight materialization. warpbox's missing single-flight is its
  biggest gap; N concurrent cold plays issue N `requestdl` calls. Trivial for us with a durable
  catalog (lazarr already does it — `05-lazarr.md` §4.1).

### `globalDegraded()` is computed and then barely used

`server.go:615-638`: ≥5 samples in a 5-min window and fail ratio ≥ 0.8. It is exported as a gauge,
shown on the landing page — and used in exactly **one** place, to relabel a `failureKind`
(`get.go:508-510`). It does not suppress a request, slow the limiter, or alter a TTL.

**Port it and actually wire it:** shorten fresh-materialization attempts, raise throttle backoff,
export as a first-class metric.

## 6. API-call accounting

`throttle.requests_per_minute` default **250** (range 10–1000), deliberately under TorBox free
plan's 300. Counters per queue (`queue.go:65-77`), aggregated in `throttleStats`
(`server.go:1069-1089`).

> **A nice piece of accounting honesty:** 429s are **max**'d, not summed, across queues, because
> `HTTP429Callback` fires on both and summing would double-count (`server.go:1078-1085`).

Surfaces: `/stats.json`, a landing page echoing **live config next to live counters**, `/healthz`,
`/openapi.json`, opt-in pprof, `/logs` ring buffer.

**Missing, and needed for the moonshot:** warpbox counts *calls*, but the hypothesis is about *calls
avoided*. There is **no counter for "requests served without a provider call"** — the exact number
we need. Add:

- `probes_served_without_provider_call`
- `materializations`
- `placements_consulted`
- `provider_calls_saved` (ratio)
- a `(provider, account)` dimension on every counter

**Port the landing page pattern wholesale** — live config beside live counters is excellent, cheap
ops design.

## 7. Retry / backoff

One predicate, `IsRetryable(err) bool` (`client.go:524-540`), shared by all call sites (D-021):

```go
	s := err.Error()
	return strings.Contains(s, "unexpected status 429") ||
		strings.Contains(s, "unexpected status 5") || ...
```

| Site | Attempts | Curve | 429 special |
|---|---|---|---|
| CDN URL fetch | 1 retry | `base * 1<<attempt`, base 1 s | fixed **30 s** |
| Sync pagination | 3 | 1 s, 2 s, 4 s | none |
| CDN proxy repair | 2 | none (immediate) | n/a |
| Hang/poll | ∞ | `×2`, 15 s → 5 min cap | doubles |

**`Retry-After` is never read.** (grep: no matches anywhere.)

**Port the single-predicate discipline (X10), not the mechanism.** One `IsRetryable` per provider,
over a **typed** `ProviderError{Status, Code, Class}`, with string matching only as last-resort
fallback. **Add `Retry-After` honoring** — RD in particular is likely to send it. **Add jitter** —
there is none anywhere, and Plex/rclone retries are naturally synchronized.

Also copy the **page-level retry placement** in `client.go:205-222`: retry at the finest granularity
that preserves progress, with `select` on `ctx.Done()` rather than a bare `time.Sleep`.

## 8. Byte serving — M11 is mandatory

```go
func isCDNDisguisedErrorBody(contentType string) bool {
	ct := strings.ToLower(contentType)
	return strings.HasPrefix(ct, "text/") || strings.Contains(ct, "html") || strings.Contains(ct, "json")
}
```
— `get.go:745-751`

The rationale comment (`get.go:328-338`) is worth quoting in full because it is the clearest
statement of the hazard in the entire corpus:

> TorBox's CDN sometimes returns HTTP 200/206 with a TEXT error body (e.g. "Too many requests" or an
> HTML page) instead of a proper 429/5xx status when it is rate-limiting or erroring. The status
> checks above treat that as success, so io.Copy below streams the error text to the client. Under
> rclone's vfs-cache (cache-mode full) that error text gets written to the cache AS THE FILE'S DATA,
> permanently corrupting the file until the cache entry is purged: ffprobe then reports
> duration=N/A / mis-detects the format, Plex playback fails, and *arrs flag good remuxes as
> "Sample".

**M11 is non-negotiable for HashSucker.** Generalize it: we know each `TorrentFile`'s expected MIME
from the catalog, so we can compare against that rather than just sniffing for `text/`.

Also port:

- **302-redirect out of the data path for no-Range requests** (`get.go:68-82`) — materialize, hand
  back a URL, leave the path. Directly on-moonshot (M20).
- **Single-range parsing bounded against the catalog size**, and **416 → parse true size → correct →
  invalidate → return 416** (`get.go:997-1010`, `:263-290`). Never 416-as-error, never into a retry
  loop.
- **Stale-URL auto-repair** (`get.go:187-227`).

Do **not** copy: `&http.Client{Timeout: …}` **per request** (`get.go:161`) — no pooling means a
fresh TCP+TLS handshake to the CDN on every range request. And holding a `cdnSem` slot for the
whole stream (`get.go:374`) starves seeks at 4 slots.

## 9. Startup — X8

`main.go:158` → `runLoop` → `syncOnce(ctx)` **immediately at boot**: a full paginated enumeration of
the entire provider library, torrents and usenet concurrently. `sync.list_page_size` 5000,
`sync_timeout_seconds` default **0 = uncapped**. Config docs: "can take ~2-3 minutes on large
libraries".

There is **no readiness gate**: the HTTP server accepts requests while the catalog is still empty,
so a client browsing during the first minutes sees an **empty library**, and `/healthz` reports `ok`
because SQLite is reachable.

Delivery-URL cache is cold on every boot; the first play of every file after restart pays a
synchronous `requestdl`.

**Do not copy.** Our boot should do almost nothing provider-side: open the catalog, start the intent
detector, serve.

**Do copy (M19)** — the per-source prune discipline (`sync.go:422-445`):

> A source is pruned ONLY when that source's fetch succeeded: a failed fetch is not a definitive
> answer (the items are still on TorBox, we just couldn't read the list), so its rows must be kept —
> never delete a source's data on a failed request. Only a successful response counts as "these
> items are gone".

Generalized: **never demote or delete a `ProviderPlacement` because a provider call failed.**

## 10. Surprising findings

1. **"Hang instead of error" is the central design pattern, not an edge case.** It sends `200 OK`
   with a `Content-Length` and holds the connection open for up to 5 minutes, deliberately lying to
   the client because rclone counts errors and Plex trashes after 10. *"This looks like a slow
   spinning disk to Plex."* A profound inversion of fail-fast, and it is load-bearing.
2. **The `requestdl_success_ratio` metric double-counts requestdl and is diluted by sync traffic.**
   `OnOutcome` is wired at the raw HTTP layer *and* called directly per CDN result and per requestdl
   attempt, so one HTTP attempt records two outcomes; meanwhile sync pages and `user/me` land in the
   same window. `globalDegraded()` — the gate preventing false quarantine — can therefore be masked
   by a healthy-but-noisy sync while requestdl is actually dead.
3. **A 429 does not slow the rate limiter down.** `Record429` only increments a counter. No AIMD, no
   adaptive rate.
4. **Two retry implementations, one cancellation-correct and one not**, in the same repo
   (`client.go:206-211` uses `select` on ctx; `get.go:658` uses bare `time.Sleep`).
5. **`isCDNDisguisedErrorBody` blocks `text/plain` and `application/json`** — which means legitimate
   `.json` sidecars and `text/plain` subtitles can never be streamed. Correct for a media proxy,
   but a real limitation.
6. **The v1→v2 migration `os.Remove`s the user's database file** as a normal startup path
   (`store.go:151-177`).
7. **`debug.FreeOSMemory()` was never committed, and why**: `runtime.MemStats.Sys` is cumulative and
   never decreases. A "1,684MB / 20GB" reading chased a phantom; real RSS was 47 MB. Warpbox still
   charts `sys_mb` as a gauge, which it isn't.

## 11. Verdict

warpbox is the **resilience reference**. Take: the key-space split (M7), the failure-kind taxonomy
(M6), escalating cooldown with half-open probe (M8), stale-while-revalidate on the delivery cache,
`isCDNDisguisedErrorBody` (M11), the 302-out-of-data-path (M20), the per-source prune rule (M19),
and the landing-page-with-live-config pattern.

Leave: the eager boot sync (X8), the flat 30 s negative TTL (X6), the unbounded blocking queue (X9),
hang/poll (X18), string-based error taxonomy (X10), and per-request `http.Client`.

Add what it lacks: single-flight, jitter, `Retry-After`, per-account dimensions, and counters for
*calls avoided* rather than only calls made.

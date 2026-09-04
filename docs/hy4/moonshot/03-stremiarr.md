# `xeroxmalf/stremiarr` — RD handoff, validation workers, throttling, delivery reuse

**Repo:** `research/moonshot-refs/stremiarr` · **Language:** Go 1.24.13 · **Shape:** Stremio addon
proxy ("handoff") in front of rclone + Zurg. 6,323 lines across 44 `.go` files, all in one flat
`package main`.

**Why it matters here:** stremiarr is our only reference with **Real-Debrid-specific** throttle
handling, and it is a **cautionary tale**: it contains both the correct implementation of our
invariant I5 and six direct violations of it, roughly 400 lines apart in the same package.
Studying both is more instructive than any clean reference.

---

## 0. Headline — the three named mechanics are largely absent

The directive asked for "RD Handoff lifecycle, stream aliases, validation workers". The reality:

- **There is no RD handoff state machine.** The entire lifecycle is `addMagnet` →
  `selectFiles(files=all)` → done. It never polls `torrents/info/{id}`, never checks download
  status, never enumerates files. The design comment is literally *"will be cached for next
  request"* (`debrid.go:628`).
- **There is no infoHash persisted anywhere.** The durable identity is the raw upstream **URL
  string** (`db.go:144-149`).
- **"Stream aliasing"** (advertised in `README.md:38`) is *addon-URL* aliasing — a short name →
  upstream addon URL map. No stream-level indirection exists.

**And:** the README and ROADMAP substantially misrepresent the code. `ROADMAP.md` has all ~40 boxes
checked `[x]`; several are 7-line log stubs (`failover.go`, `hls.go`, `anime.go`, `dsl.go` are each
~7 lines). `CHANGELOG.md:24` documents `POST /api/rd/notify`, which does not exist.

> **Treat this repo as behavioural evidence, not as documentation.** Its value is in what it does,
> not what it claims.

## 1. Architecture

```
Stremio
  ├─ GET /{alias}/stream/movie/tt1234567.json
  │    → routeHandler (handlers.go:74) → streamHandler (handlers.go:206)   [SWR, 7-day cache]
  │      → fetchAndCacheStreams (proxy.go:99)
  │          ├─ fan out to addon sources, semaphore maxConcurrent=4   proxy.go:146-164
  │          ├─ isSuspiciousURL + blacklist regex                     proxy.go:193-215
  │          ├─ dedupe by URL                                         proxy.go:217-220
  │          ├─ INSERT INTO stream_urls ... ON CONFLICT DO NOTHING    proxy.go:231
  │          ├─ non-blocking enqueue to validateCh                    proxy.go:234-237
  │          └─ SetStreamCache(targetURL, body, 7*24h)                proxy.go:248
  │      → serveStreamsJSON (proxy.go:282)
  │          ├─ strike gate: fail_count>=3 or !isValid → REDACT       proxy.go:339-354
  │          └─ stream["url"] = http(s)://host/{alias}/play?link=<esc> proxy.go:357
  │
  └─ GET /{alias}/play?link=<escaped upstream URL>
       → playHandler (playback.go:70)
```

Note `main.go:31-33`: `if RcloneUrl == "" { log.Fatal("❌ ERROR: RCLONE_URL is missing!") }`.
**Rclone is a hard startup dependency** — the VFS is on the critical path, not an optimization.

## 2. The RD "handoff" — X16, X17

The only three RD API calls in the entire codebase:

| Endpoint | Cite |
|---|---|
| `POST /rest/1.0/torrents/addMagnet` | `debrid.go:572` |
| `POST /rest/1.0/torrents/selectFiles/{id}` | `debrid.go:613` |
| `GET /rest/1.0/torrents/instantAvailability/{hash...}` | `prefetch.go:338` |
| `POST /rest/1.0/unrestrict/link` | `debrid.go:215` |

**No `GET /rest/1.0/torrents/info/{id}`. No status polling. No completion detection. No file
enumeration.**

`rdAddMagnet` (`debrid.go:556-630`) — and note what happens to the torrent's RD identity:

```go
	var addResp struct {
		ID  string `json:"id"`
		URI string `json:"uri"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&addResp); err != nil || addResp.ID == "" {
		return errors.New("addMagnet: could not parse response")
	}
	log.Printf("[RD] ✅ Torrent added to RD queue (id=%s). Selecting all files...", addResp.ID)
```

**`addResp.ID` is logged and then discarded.** Not persisted, not stored, not used again. The
torrent's provider identity dies in that log line. (X16)

And file selection (`debrid.go:611-628`):

```go
	// Select all files so RD starts downloading
	selectReq, err := http.NewRequest("POST",
		"https://api.real-debrid.com/rest/1.0/torrents/selectFiles/"+addResp.ID,
		strings.NewReader("files=all"))
```

**`files=all`, hardcoded, always.** No index list, no name list, no size filter. (X17) A 60 GB
season pack is fully selected to serve one episode.

All three call sites are fire-and-forget (`proxy.go:415-422` is a bare `go func(...)`).

**Port? Only the gates, never the shape.** Transferable:

- Seeder-threshold gates before submitting (`proxy.go:403`: skip if `<5`; `prefetch.go:634`: skip if
  `<2`) so you don't clog the provider queue with dead torrents.
- `instantAvailability` **batch-of-40** pre-filter (`prefetch.go:330`) — maps cleanly onto an "is
  this already placed?" fast path.
- Per-item submission cap of 3 (`prefetch.go:639`).
- `451 → silently skip` (`debrid.go:588-592`).

But HashSucker must replace fire-and-forget with a **persisted `ProviderPlacement` row + poller**.
Not knowing whether a placement reached `ready` is disqualifying for us.

## 3. Validation workers

`validation.go:11-21`:

```go
var validateCh = make(chan string, 1000)

func initValidationPool() {
	// Reduced from 3 to 2 to prevent triggering RD's rate limits
	for i := 0; i < 2; i++ { go validationWorker() }
	go revalidationSweep()
}
```

`validation.go:71-79` — note the sleep is *after* the work:

```go
func validationWorker() {
	for link := range validateCh {
		metricValidationAttempts.Inc()
		validateRDLink(link)
		// THROTTLE: 1.5s between validations to avoid 429s while keeping validation timely
		time.Sleep(1500 * time.Millisecond)
	}
}
```

**2 workers × 1.5 s = a hard global ceiling of ~1.33 validations/second.** The throttling strategy
is literally "have fewer workers" (`validation.go:15`).

| Constant | Value | Cite |
|---|---|---|
| `validateCh` buffer | 1000 | `validation.go:12` |
| worker count | 2 | `validation.go:16` |
| inter-validation sleep | 1500 ms | `validation.go:77` |
| sweep initial delay / interval | 2 min / 30 min | `validation.go:27,29` |
| sweep staleness window / batch | 2 h / 50 | `validation.go:34-35` |
| validate client timeout / redirect hops | 10 s / 5 | `validation.go:117,121` |
| RD error-video threshold (validation) | **25,000,000** | `validation.go:179` |
| RD error-video threshold (playback) | **20,000,000** | `playback.go:167` |
| strike limit | 3 | `proxy.go:343`, `playback.go:87` |

### What validation actually does

Three stages (`validation.go:110-188`): (1) follow up to 5 redirects with HEAD; (2) unrestrict if
needed; (3) `probeFileSize` via `Range: bytes=0-0` + `Content-Range` parse, then a size heuristic.

**There is no byte-level validation at all.** No magic-byte check, no container header parse, no
checksum. Everything rides on a size heuristic.

### Enqueue is non-blocking with silent drop

`proxy.go:234-237`:

```go
			select {
			case validateCh <- urlStr:
			default:
			}
```

An empty `default:` — no metric, no log. A dropped URL keeps `is_valid = TRUE` from its insert
default and is only recovered on the 30-min sweep tick.

**Port? The shape, inverted.** The pool + bounded channel + post-work throttle + periodic sweep
skeleton is cheap and reasonable. But the trigger is wrong for us (X7): stremiarr validates
**eagerly at import** (`proxy.go:228-240`). Our whole thesis is that this work belongs at the
intent boundary.

Genuinely transferable pieces:

- **`405 → inconclusive, don't poison`** (`validation.go:136-142`) — a real ambiguous-negative
  carve-out. Generalize it.
- **Soft score vs hard block**: `success_count - fail_count` for ranking (`proxy.go:365`) alongside
  `fail_count >= 3` for blocking (`proxy.go:343`).
- **Two severities**: `markInvalid` sets `is_valid=FALSE` (`validation.go:206`) while `recordStrike`
  only increments (`playback.go:16`). A single playback failure shouldn't hide a stream.

## 4. RD throttling — the four layers

### Layer 1 — `rdDo`: genuinely good (`debrid.go:34-135`)

```go
func getBackoffDuration(attempt int) time.Duration {
	base := 2 // Start with 2s base
	maxDuration := 60
	backoff := base * (1 << attempt)
	if backoff > maxDuration { backoff = maxDuration }
	maxJitter := float64(backoff) * 0.15
	jitter := rand.Float64() * maxJitter
	return time.Duration(float64(backoff)+jitter) * time.Second
}
```

`maxAttempts = 5`. Body is preserved for replay (`debrid.go:39-49`). `context canceled` fast-fails
(`:59-61`). Per-status-code metric (`:87`).

```go
		isRetryable := apiErr.ErrorCode == 5 || apiErr.ErrorCode == 34 ||
			apiErr.ErrorCode == 36 || apiErr.ErrorCode == -1 ||
			resp.StatusCode == 429 || resp.StatusCode == 503
```

**Port? Yes** (M14) — body-preserving jittered retry with a single predicate. But replace the
`strings.Contains` and the hardcoded codes with a typed `ProviderError` (X10).

### Layer 2 — per-key lockout + round-robin: also good (M12)

```go
type RdKey struct {
	Token          string
	LockedOutUntil time.Time
}
```
— `debrid.go:152-155`

`reportError` (`debrid.go:191-207`) locks a key for **5 minutes** on 429/503. `getActiveToken`
(`debrid.go:171-189`) round-robins, skipping locked keys. `IsRateLimited()` (`debrid.go:260-270`)
is true only when *all* keys are locked.

**This is a correct account-level throttle signal** and maps cleanly onto per-`ProviderAccount`
health. Note the wart: when all keys are locked, the fallback returns a locked key anyway
(`debrid.go:185-188`) rather than failing.

### Layer 3 — the prefetcher's carve-out: the ONLY correct place (M13)

`prefetch.go:645-669`:

```go
			err := rdAddMagnet("magnet:?xt=urn:btih:" + hash)
			if err == nil {
				addPrefetchLog(...)
				SyncArrStack("/links/" + hash)
			} else {
				if strings.Contains(err.Error(), "451") {
					continue // Infringing file, silently skip
				}
				if strings.Contains(err.Error(), "429") {
					addPrefetchLog("⏳ RD Rate Limited (429). Pausing for 5 minutes...")
					select {
					case <-ctx.Done():
						return
					case <-time.After(5 * time.Minute):
					}
					continue
				}
				// Some other error, just skip
				continue
			}
```

**This is our invariant I5, implemented.** On 451 → `continue`, no record. On 429 → pause 5 min,
`continue`, no record. On anything else → `continue`, no record. **Nothing is written to durable
state.**

Encode this as a typed `ProviderNegative{ kind: AccountThrottle | ContentUnavailable | Infringing |
Transient }` instead of `strings.Contains`.

### Layer 4 — inbound rate limit (unrelated, but confusingly named)

`rate_limit.go:15-26`: 15 req/s burst 75 (default), 5 req/s burst 20 (API). This is *inbound client*
throttling, not provider throttling.

## 5. Where throttle is confused with unavailability — six violations of I5

**None of these are in `rdAddMagnet`. They are all in validation and playback.**

| # | Cite | What it confuses | Damage |
|---|---|---|---|
| **C** | `playback.go:254-274` | **Account-wide** throttle → per-URL strike. The code *knows* — it checked `IsRateLimited()` two lines earlier — then `break`s and calls `recordStrike(targetLink)` | 1 of 3 strikes burned on a healthy stream per throttle event |
| **A** | `validation.go:144-149` | `if resp.StatusCode >= 400 { markInvalid(targetLink) }` — **no 429 branch exists in the file** | `is_valid=FALSE` + `fail_count++` |
| **B** | `validation.go:163-173` | `"rate limited"` (`debrid.go:239`) with `"RD unrestrict failed"` (`debrid.go:257`) — both land in the same `else` → `markInvalid` | Indistinguishable at the call site |
| **D** | `validation.go:129-133` | `if err != nil { markInvalid(...) }` — a DNS blip, TLS failure or 10 s timeout | Permanent strike from a transient network event |
| **E** | `validation.go:176-187` | `probeFileSize` returns `0` for unknown, and `0` is then read as dead | Any 200 lacking `Content-Length` is killed |
| **F** | `validation.go:179` vs `playback.go:167` | Two thresholds (25 MB / 20 MB) for one heuristic | A 22 MB file passes validation then dies at playback, and playback writes `is_valid=FALSE` directly (`playback.go:170`) |

**BUG C is the exact inversion of our rule.** It is worth reading in full:

```go
		success := false
		var downloadURL string
		for attempt := 1; attempt <= 3; attempt++ {
			if provider.IsRateLimited() {
				break
			}
			dl, err := provider.Unrestrict(finalURL)
			if err == nil && dl != "" {
				downloadURL = dl
				success = true
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
		if !success {
			log.Printf("[Play] ❌ Exhausted unlock attempts for: %s", targetLink)
			recordStrike(targetLink)
			http.Error(w, "Debrid Unrestrict failed", http.StatusBadGateway)
			return
		}
```

Three users clicking during three separate throttles = a permanently dead, perfectly healthy stream.

**Aggravating:** the strike counter is monotonic with no decay. The only resets are `markValid`
(which rarely runs once redacted) and a manual `POST /api/clean` (`api.go:411`). And `api.go:418`
mass-invalidates everything not validated in 2 h — the same window the sweep uses — so one button
press can empty a healthy catalog.

### Does a throttle ever mark a *hash* bad?

**No — because there is no hash record to mark.** Verified: no infoHash column in any migration
(`db.go:138-153`). Hashes are transient locals.

> **This is a vacuous satisfaction of I5, and it is the most important lesson in this repo.** The
> safety is an artifact of *having no durable layer*, not of *having a good negative-signal
> discipline*. The moment durable `Release(infoHash)` rows are introduced, the same code shape
> violates the rule directly.

## 6. Buffering / read-ahead — the layering idea is the valuable part

Go side: a 128 KiB fixed buffer pool (`config.go:69-92`) used as `ReverseProxy.BufferPool`. This is
a **copy-buffer allocator**, not read-ahead. No adaptive behavior, no `Range` inspection, no
sequential-vs-seek detection anywhere in the Go code.

`config.go:94-106` has the one thoughtful streaming decision:

```go
var customTransport = &http.Transport{
	ForceAttemptHTTP2:     false,   // no HTTP/2 to avoid head-of-line blocking
	MaxIdleConns:          100,
	MaxIdleConnsPerHost:   32,
	ReadBufferSize:        64 * 1024,
	WriteBufferSize:       64 * 1024,
	...
}
```

All real read-ahead is delegated to rclone (`compose/docker-compose.yml:59-84`):
`--vfs-cache-mode full`, `--vfs-cache-max-size 250G`, `--vfs-read-chunk-size 64M`,
`--vfs-read-ahead 512M`, `--buffer-size 128M`, `--dir-cache-time 10s`.

**M15 — the single most valuable idea in this repo.** `playback.go:276-291`:

```go
		parsedURL, _ := url.Parse(downloadURL)
		filename = filepath.Base(parsedURL.Path)
	...
	// 🎯 4. RCLONE VFS PROXY FOR NEWLY UNRESTRICTED LINKS
	rcloneBase := strings.TrimRight(RcloneUrl, "/")
	targetPath := rcloneBase + "/links/" + url.PathEscape(filename)
```

**The unrestricted URL is used for exactly one thing: `filepath.Base(path)`.** The bytes then flow
Rclone → ReverseProxy → client, with Rclone re-resolving from its own remote.

> **Consequence: expiry of the unrestricted URL mid-stream becomes invisible.** The URL's only
> remaining job was to name a file. Once `waitForVFS` returns true, the Go process has handed off.

**This is the moonshot in miniature**: reduce the provider URL to a local name, hand the bytes to a
separate layer, and the provider URL's lifetime stops mattering.

`waitForVFS` (`playback.go:23-68`) is a decent materialization barrier: trigger `vfs/refresh` via
rclone RC, poll a cheap `Range: bytes=0-0` probe, bound the retries (3 or 5), and **degrade instead
of failing** (`playback.go:293-295` logs a warning and proxies anyway).

**Do not port** the static numbers (512 M read-ahead, 250 G cache) — "cache everything" contradicts
lazy materialization. **Do not port** the hardcoded `dir=links` (`playback.go:30`) or the
`/links/<basename>` contract, which is collision-prone and contradicted by the checked-in
`rclone.conf` (`rclone/rclone.conf:5-8` points at RD's own WebDAV, which has no `/links/`).

## 7. Delivery reuse — the unrestrict cache

`debrid.go:137-142`, `:209-258`:

| Property | Value | Cite |
|---|---|---|
| Key | the **restricted link** (not the hash, not the file) | `debrid.go:220` |
| TTL | **4 hours** — `// Cache for 4 hours like Zurg` | `debrid.go:247-250` |
| Store | in-memory `sync.Map` | `debrid.go:142` |
| Revalidation / refresh-ahead | none | |
| Persistence | **none** — lost on restart | |
| Eviction | lazy on read; unbounded | `debrid.go:225` |

**No TTL from the underlying RD download URL is consulted** — 4 h is a hardcoded guess justified
only by a comment.

**Port the structure, not the TTL.** We have a `MediaBinding` to attach TTL to; persist it there and
revalidate lazily.

Also note: `getActiveToken()` is called *before* the cache check (`debrid.go:210` vs `:219`), so a
cache hit still advances the round-robin index.

## 8. Surprising findings

1. **The ROADMAP is fiction** — all ~40 boxes checked, several are 7-line log stubs. The "Jellyfin
   plugin" is a 1-line `Manifest.xml`; the "mobile app" is 3 lines of React.
2. **A phantom documented endpoint**: `CHANGELOG.md:24` documents `POST /api/rd/notify` "to allow
   external tools (like Zurg) to push newly-cached RD torrent IDs back to Handoff." **No such route
   exists** (`api.go:26-74` is the full table). This is exactly the integration hook the
   architecture needs and doesn't have — it would have closed the observation gap in §2.
3. **Someone else's Real-Debrid API key is hardcoded** in a base64 config blob at `config.go:53-54`,
   plus a DMM cast key at `:58`, enabled by default.
4. **Playback does 5 full GETs to follow redirects, then a separate HEAD** (`playback.go:108-150`) —
   worst case 5 GETs + 1 HEAD before a byte reaches the client, with unread bodies. Meanwhile
   `validation.go:122` correctly uses HEAD for the same traversal. Two implementations, one right.
5. **NULL-ordering makes the revalidation sweep starve, backend-dependently.** `validation.go:34`
   is `ORDER BY last_validated ASC LIMIT 50`, and 405s return without writing anything, so those
   rows keep `last_validated = NULL` forever. In **SQLite** NULLs sort first ASC → the same
   unvalidatable URLs occupy all 50 sweep slots forever. In **Postgres** NULLs sort last → the bug
   inverts. Default is SQLite; compose sets Postgres. **Present or absent depending on deploy.**
6. **Provider detection is substring matching** (`debrid.go:531-542`):
   `strings.Contains(link, "real-debrid.com")` matches anywhere in the URL, including query
   strings — `https://evil.example/?r=real-debrid.com` resolves to the RD provider and receives the
   user's token.
7. **OAuth is decorative** — `oauth.go:45-65` sets a hardcoded cookie `authenticated_token` and
   performs no token exchange; it sets `stremiarr_session` while `RequireRole` reads
   `handoff_session`. The two never meet.
8. **`Config.Plugins` is dead** — declared at `config.go:32`, never read.
9. **SQLite serializes every write through one connection** (`db.go:86`: `SetMaxOpenConns(1)`),
   including the hot play path.
10. **The provider-health Prometheus metric is defined and never called** (`metrics.go:62-66`,
    `:122-129`). The one metric that would surface an RD throttle is inert.

## 9. Verdict

stremiarr is the **negative reference**. Its value is:

- **Three things to steal verbatim:** `rdDo` (`debrid.go:34-135`); the `prefetch.go:650-668` carve-out
  discipline; the `playback.go:276-291` handoff (M15).
- **Three things to refuse:** persisting validity as a boolean with a monotonic strike counter and no
  decay; using the provider URL as a primary key; eager validation at import.
- **One meta-lesson that generalizes past this repo:** *a codebase can satisfy "an ambiguous
  negative never poisons durable identity" for the wrong reason — by having no durable identity.*
  The invariant has to be enforced structurally (see warpbox's key-space split, M7), not inherited
  from an accident of schema poverty.

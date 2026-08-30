# Playback Delivery

What happens between "a release was selected" and "a player is receiving bytes". For selection see
[`discovery-ranking.md`](discovery-ranking.md); for the data model and invariants see
[`architecture.md`](architecture.md).

## 1. Two delivery paths, and they are disjoint

This is the single most important thing to understand about delivery.

| | `/stream/:type/:id` | `/media/:infoHash/:fileIndex` |
|---|---|---|
| Answers | "Where should playback redirect?" | "Stream me these bytes" |
| Mechanism | `307` redirect to the provider | Local filesystem proxy (`createReadStream`) |
| Provider calls | Yes — availability revalidation | None — zero provider I/O |
| Requires | A persisted selection, provider `torbox` | A configured mount root |
| Used by | `.strm` files, Plex, Jellyfin | Direct clients, WebDAV/VFS internals |

They do not overlap and neither falls through to the other. The `.strm` file is what binds them:
its contents are a `/stream/` URL.

## 2. `/stream/:type/:id` — the redirect resolver

`:type` is `movie` or `series`. `:id` may be colon-separated (`tt0944947:1:1`) with optional
`?season=` and `?episode=`.

1. Load the persisted selection. The provider must be `torbox`.
2. **Real-Debrid first.** On a resolution-cache hit, `307` immediately. Otherwise one bounded RD
   resolution plus an `isUrlLive` probe, then `307` with `x-url-live-checked`. RD failure never
   blocks the TorBox path.
3. **TorBox fallback.** Revalidate availability, map the outcome to HTTP, resolve the TorBox
   redirect, then `307`.

A successful redirect carries `location`, `cache-control: no-store`, `x-torrent-id`, `x-file-id`,
`x-availability-source`, `x-provider-check-occurred`, `x-url-live-checked`, and
`x-resolver-profile`.

### Availability revalidation

A stored observation is evidence about the past, so it is re-checked before it is trusted.

- Fresh — younger than `STREAM_AVAILABILITY_MAX_AGE_MS` (default 300000 ms) — is used as-is with
  zero provider calls (`STORED_FRESH`).
- Stale or missing triggers exactly one bounded provider check
  (`PLAYBACK_REVALIDATION`), bounded by `STREAM_PROVIDER_CHECK_TIMEOUT_MS` (default 3000 ms).

The outcome maps deterministically:

| Outcome | HTTP | Body code |
|---|---|---|
| `CACHED` | `307` | — |
| `UNCACHED` | `409` | `PROVIDER_NOT_CACHED` |
| `UNKNOWN` | `503` | `PROVIDER_CHECK_FAILED` |

A **failed** check persists `unknown`, never `uncached`. Uncertainty and absence are different
facts and the system refuses to collapse them.

### Liveness probe

`isUrlLive` issues a `GET` with `Range: bytes=0-1023` and a 5-second abort timeout. Live means
`206`, or `200` with a non-zero `content-length` or non-empty body. Everything else — including
network error and timeout — is false. The URL is never logged.

### Alternate fallback

When revalidation says "do not redirect", the resolver tries the next persisted eligible
candidate. It does **not** re-discover and does **not** re-rank: it filters already-persisted
results by eligibility, matching season/episode/media type scope, and deduplicates on release key.

`FALLBACK_REASON` is `PRIMARY_UNAVAILABLE` (uncached) or `PRIMARY_PROVIDER_ERROR` (check failed).
On success the response adds `x-fallback-used`, `x-fallback-rank`,
`x-fallback-original-release-key`, and `x-fallback-selected-release-key`.

### Building the redirect

`torbox-redirect.js` is a pure function: zero provider calls, zero persistence. It maps the
selection to a placement (`provider_resource_id` = TorBox torrent id), then to a
`candidate_file_mappings` row (`provider_file_id`), and emits

```text
{apiBase}/torrents/requestdl?token=…&torrent_id=…&file_id=…&redirect=true
```

It explicitly refuses to assume `fileIndex == provider_file_id`. Those are different numbers from
different systems and the mapping table is the only thing that relates them.

`torbox-delivery.js` is the heavier sibling — it *creates* the placement when one is absent, using
cached-only creation, then resolves the same `requestdl` URL. It is used by the WebDAV/VFS
handlers only, never by `/stream`.

## 3. `/media/:infoHash/:fileIndex` — filesystem proxy

Read-only, three stages, no provider I/O:

```text
resolveProjection   identity → binding → exposure → mount → provider file → readiness
buildMediaSource    frozen { path, contentType }, with path-containment enforcement
createMediaStream   fs.createReadStream, range-clamped
```

Readiness requires an active binding, a `visible` exposure, a configured mount root, and a
non-null `relative_path`. Only the `filesystem` transport exists.

Status is `206` when a `Range` header was supplied, otherwise `200`. A bad range is `416` with
`content-range: bytes */<size>`. Other errors map as: `file-not-found` → `404`,
`permission-denied` → `403`, `no-binding` → `410`, `mount-not-configured` → `503`,
`path-traversal` → `400`, anything else → `502`.

### Mounts

`mount_scope` is a logical identifier, not a persisted configuration. Roots come from environment
variables and are resolved once at startup — there is no mount registry table.

| Scope | Variable |
|---|---|
| `default` | `REALDEBRID_MOUNT_PATH` |
| `torbox` | `TORBOX_MOUNT_PATH` |
| `canonical` | `CANONICAL_LIBRARY_PATH` |

An unconfigured scope means `configured: false`, which surfaces as `503`.

## 4. `.strm` publishing

A `.strm` file contains exactly one line:

```text
{RESOLVER_BASE_URL}/stream/{mediaType}/{mediaId}
```

That is all. It is never a CDN URL, never a mount path, and never a provider link.

- **Atomic** — written to a temp file then renamed.
- **Idempotent** — an existing file is returned as-is.
- **Stable forever** — the URL is derived from content identity, so changing provider, binding,
  exposure, or mount never requires rewriting a `.strm`.

Layout under `STRM_OUTPUT_PATH` (default `/strm`):

```text
/strm/Movies/Title (Year)/Title (Year).strm
/strm/TV Shows/Title (Year)/Season XX/Title (Year) - SXXEXX.strm
```

After publishing, Jellyfin is notified so it can rescan; `JELLYFIN_MEDIA_ROOT` translates the
container path into Jellyfin's view of the filesystem.

## 5. WebDAV virtual filesystem

`/vfs` serves a synthetic WebDAV tree built from canonical paths, not from what happens to be on
disk anywhere:

```text
/vfs/Movies/<Title (Year)>/<Title (Year)>.<ext>
/vfs/TV Shows/<Series>/Season NN/<Series> - S01E01.mkv
```

It answers `PROPFIND` with multistatus XML and serves ranged `GET`/`HEAD` by streaming from
Real-Debrid or TorBox. Ephemeral provider URLs are refreshed on `401`, `403`, `404`, and `410`.

Range support is not optional. Players require `Accept-Ranges: bytes` and `206` responses or
seeking becomes impossible, and Plex in particular fires many small `Range: bytes=N-` probes for
container metadata, seeking, and resume.

## 6. Physical acquisition

The secondary policy: download the bytes locally and let the Arr apps import them.

```text
POST /api/requests
  → validate intent + exact release identity
  → build protocol-v1 handoff (infoHash + fileIndex + releaseKey)
  → atomic write + rename into /requests/incoming/
  → importer claims with `mv -n` into processing/
  → TorBox placement and job reconciliation
  → provider file selection and validation
  → resolve signed URL, download to staging
  → verify bytes and size
  → Radarr/Sonarr ManualImport
  → post-import validation
  → ownership-aware cleanup, settle to done/ or failed/
```

The filesystem spool is authoritative for physical-mode ownership. Claiming is atomic `mv -n`.
Cleanup removes a provider resource only when exactly one `processing` request references the job
or hash **and** that request created the resource itself (`provider IN ('torbox','auto')` and
`provider_created=1`); every other case is retained. `ALLOW_UNLINKED_LEGACY_IMPORTS=1` opts into
the legacy behaviour and is off by default.

The importer polls at `POLL_INTERVAL` seconds (default 10). Each loop resumes the first file in
`/requests/processing/` before claiming any new `incoming` request, so a request that never
completes is retried ahead of new work every loop. Placement runs through TorBox;
`validate-request.sh` also accepts `provider: realdebrid`, but owned-provider cleanup supports only
`torbox` and `auto` and aborts for any other value.

## 7. Pointing a player at HashSucker

- Point Plex at the `.strm` directory. Never point it at mount paths, WebDAV, or a FUSE mount —
  that couples the library to deployment topology.
- One playable file is one `.strm`. Skip samples, subtitles, and extras.
- The player sees only HTTP status codes:

| Code | Meaning to the player |
|---|---|
| `200` / `206` | Playing |
| `404` / `410` | Unavailable |
| `416` | Bad range request |
| `423` / `502` / `503` | Retry later |
| `400` | Invalid identity |

- The player never authenticates, never triggers repair or refresh, and never writes to the control
  plane. It must never learn provider identity, credentials, binding state, mount paths, or corpus
  scores. `X-Resolver-*` and `X-Internal-*` headers are stripped at the edge.
- Jellyfin picks up new files via inotify; Plex polls. Jellyfin reacts faster.
- HashSucker does not own library metadata, artwork, or subtitles — the player's own agents do.

## 8. Observability

One telemetry record per `/stream` attempt, appended to `lifecycle_events` / `request_runs`.
Sanitized, append-only, and it never throws. `RESOLVER_OUTCOME` is `REDIRECTED` or `FAILED`.
Exposed by `GET /api/debug/resolver-telemetry` (limit ≤ 200).

The profiler marks per-stage latency into `x-resolver-profile` and is a no-op unless
`RESOLVER_PROFILE=1`.

`/api/metrics` is plain JSON — counters plus a ranking score distribution. It is not a Prometheus
exporter and carries nothing playback-specific.

## 9. Dead code on this path

Recorded so nobody spends time on it:

- `canTransport` is imported into `app.js` and never called.
- `ensureTorBoxDelivery` is not on the `/stream` path; only the WebDAV handlers use it.
- `src/lib/stream-resolver/index.js` is a stub that returns `{ status: 'not_implemented' }`. It is
  declared as the redirect boundary but is not the implementation; `src/lib/resolver/` is.

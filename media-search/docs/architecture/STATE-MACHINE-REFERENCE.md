# State Machine Reference — HashSucker Lifecycle States

**Date:** 2026-08-23  
**Scope:** Unified lifecycle state documentation  
**Complements:** `ARCHITECTURE-BOUNDARIES.md` (boundaries), `CONTRACTS.md` (contracts), `MATERIALIZATION-REGISTRY-SCHEMA.md` (schema)  
**Constraints:** No code; no schema; reference documentation only

---

## 1. Overview

HashSucker has **three distinct state machines** that must not be confused:

1. **Placement State** — provider's perspective: "Do you hold this content?"
2. **Materialization State** — resolver's perspective: "Can this become bytes right now?"
3. **URL Cache State** — resolver's perspective: "Is the cached URL still valid?"

Each state machine has different triggers, transitions, and ownership.

---

## 2. Placement State Machine

### 2.1 Owner

**Placement Layer** — manages provider-facing placement status.

### 2.2 States

```
┌─────────┐
│ pending │  Placement requested, provider processing
└────┬────┘
     │
     ├── Provider confirms ──────────────▶ ┌──────────┐
     │                                     │ complete │  Provider holds content
     │                                     └────┬─────┘
     │                                          │
     │                                          └── Torrent dies ──▶ ┌─────────┐
     │                                                                │ failed  │
     │                                                                └─────────┘
     │
     └── Provider reports error ──────────▶ ┌─────────┐
                                            │ failed  │
                                            └─────────┘
```

### 2.3 State Definitions

| State | Meaning | Trigger to Enter | Trigger to Exit |
|-------|---------|------------------|-----------------|
| `pending` | Provider processing placement | Placement request sent | Provider confirms or reports error |
| `complete` | Provider holds content, ready for resolution | Provider confirms download | Torrent dies or is deleted |
| `failed` | Provider cannot or will not hold content | Provider reports error | Re-placement (new placement record) |

### 2.4 Allowed Transitions

| From | To | Trigger |
|------|----|---------|
| `pending` | `complete` | Provider API reports downloaded/ready |
| `pending` | `failed` | Provider API reports error |
| `complete` | `failed` | Torrent dies, no seeders, or RD error |
| `failed` | *(none)* | Placement is terminal; create new placement to retry |

### 2.5 Notes

- **No direct pending → failed shortcut:** Providers may report intermediate status before final state.
- **Failed is terminal:** Do not retry same placement; create a new placement record.
- **One identity can have multiple placements:** Different providers or different attempts.

---

## 3. Materialization State Machine

### 3.1 Owner

**Materialization Registry** — manages resolver-facing lifecycle state.

### 3.2 States

```
┌───────────┐
│ acquiring │  Placement complete, URL not yet resolved
└─────┬─────┘
      │
      ├── resolve() succeeds ──────────────▶ ┌───────────┐
      │                                      │ available │  Has valid URL, can play
      │                                      └─────┬─────┘
      │                                            │
      │                                            ├── URL expires ──▶ ┌─────────┐
      │                                            │                   │ expired │
      │                                            │                   └────┬────┘
      │                                            │                        │
      │                                            │                        ├── refresh() succeeds ──▶ (back to available)
      │                                            │                        │
      │                                            │                        └── refresh() fails ─────▶ ┌───────────┐
      │                                            │                                                │ repairing │
      │                                            │                                                └─────┬─────┘
      │                                            │                                                      │
      │                                            │                                                      ├── retry succeeds ──▶ (back to available)
      │                                            │                                                      │
      │                                            │                                                      └── max retries ───▶ ┌─────────┐
      │                                            │                                                                          │ failed  │
      │                                            │                                                                          └─────────┘
      │                                            │
      │                                            └── Provider error ──────────────────────────────────────────────────────────▶ ┌─────────┐
      │                                                                                                                          │ failed  │
      │                                                                                                                          └─────────┘
      │
      └── resolve() fails ─────────────────────────────────────────────────────────────────────────────────────────────────────▶ ┌─────────┐
                                                                                                                                  │ failed  │
                                                                                                                                  └─────────┘
```

### 3.3 State Definitions

| State | Meaning | Trigger to Enter | Trigger to Exit |
|-------|---------|------------------|-----------------|
| `acquiring` | Placement complete, waiting for URL resolution | Active placement set, URL not yet resolved | URL resolved or resolution fails |
| `available` | Has valid URL, can become bytes | URL resolved successfully | URL expires or provider error |
| `expired` | URL expired, refresh needed | TTL check fails (`expires_at < now + buffer`) | Refresh succeeds or fails |
| `repairing` | Refresh/retry in progress | Refresh attempt initiated | Retry succeeds or max retries exceeded |
| `failed` | No valid URL, no placement works | Max retries exceeded or auth error | Manual repair or re-placement |

### 3.4 Allowed Transitions

| From | To | Trigger |
|------|----|---------|
| `acquiring` | `available` | Provider adapter `resolve()` returns valid URL |
| `acquiring` | `failed` | Provider adapter `resolve()` fails permanently (auth error) |
| `available` | `expired` | URL expires (`expires_at < now + buffer`) |
| `available` | `failed` | Provider error (not auth, not rate limit) |
| `expired` | `available` | Provider adapter `refresh()` returns new URL |
| `expired` | `repairing` | Refresh attempt initiated |
| `repairing` | `available` | Retry succeeds, new URL obtained |
| `repairing` | `failed` | Max retries exceeded (`retry_count >= max_retries`) |
| `failed` | `acquiring` | Re-placement or manual repair (future) |

### 3.5 Forbidden Transitions

| From | To | Why Forbidden |
|------|----|---------------|
| `failed` | `available` | Must go through `acquiring` (new placement needed) |
| `available` | `acquiring` | State regression; URL was valid, now need new placement? No. |
| `repairing` | `expired` | Already attempting repair; no regression |
| `expired` | `failed` | Must attempt repair before failing |

### 3.6 Notes

- **State is identity-centric:** If RD fails but TorBox succeeds, state is `available`.
- **Auth error is permanent:** `available → failed` on auth error; no retry.
- **Rate limit is transient:** Back off and retry; do not mark failed immediately.
- **Max retries configurable:** Default `max_retries = 3` in `materialization_state` table.

---

## 4. URL Cache State Machine

### 4.1 Owner

**Materialization Registry** — manages cached URL freshness.

### 4.2 States

```
┌─────────┐
│ missing │  No cached URL (first request or cache cleared)
└────┬────┘
     │
     ├── resolve() or refresh() ──────────▶ ┌───────┐
     │                                      │ fresh │  URL valid, within TTL
     │                                      └───┬───┘
     │                                          │
     │                                          ├── TTL check fails ──▶ ┌───────┐
     │                                          │                       │ stale │  URL exists but expiring soon
     │                                          │                       └───┬───┘
     │                                          │                           │
     │                                          │                           └── Expired ──▶ ┌─────────┐
     │                                          │                                         │ expired │
     │                                          │                                         └────┬────┘
     │                                          │                                              │
     │                                          │                                              └── Refresh ──▶ (back to fresh)
     │                                          │
     │                                          └── Used successfully (served to client)
     │
     └── (no action; wait for request)
```

### 4.3 State Definitions

| State | Meaning | Trigger to Enter | Trigger to Exit |
|-------|---------|------------------|-----------------|
| `missing` | No URL in cache | First request, or cache cleared | Provider adapter resolves URL |
| `fresh` | URL valid and within TTL | URL resolved, `expires_at > now + buffer` | TTL check fails |
| `stale` | URL exists but expiring soon | `now + buffer > expires_at > now` | Refreshed or expires |
| `expired` | URL no longer valid | `expires_at <= now` | Refreshed (new URL) or cache cleared |

### 4.4 TTL and Buffer

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `ttl_seconds` | 86400 (24h) | Provider-reported URL lifetime |
| `buffer_seconds` | 7200 (2h) | Refresh before expiry to prevent mid-playback expiration |
| Effective cache window | 22h | `ttl_seconds - buffer_seconds` |

**Freshness check:**

```sql
SELECT resolved_url, expires_at
FROM resolved_urls
WHERE info_hash = ?
  AND file_index_key = ?
  AND expires_at > datetime('now', '+2 hours');
```

- **Hit:** URL is fresh → serve directly (302 redirect)
- **Miss (stale):** URL exists but expires soon → refresh in background
- **Miss (expired):** URL expired → refresh synchronously, return new URL
- **Miss (missing):** No cached URL → resolve via provider adapter

### 4.5 Allowed Transitions

| From | To | Trigger |
|------|----|---------|
| `missing` | `fresh` | Provider adapter resolves URL |
| `fresh` | `stale` | TTL check approaches buffer threshold |
| `fresh` | `expired` | URL expires (no refresh in time) |
| `stale` | `fresh` | Refresh succeeds, new URL cached |
| `stale` | `expired` | Refresh not triggered in time |
| `expired` | `fresh` | Refresh succeeds, new URL cached |
| `expired` | `missing` | Cache cleared after max retries |

### 4.6 Notes

- **URL cache is not authoritative:** Empty cache means "resolve on demand," not "content unavailable."
- **Stale is predictive:** Refresh before expiry to avoid playback interruption.
- **Cache is per-identity:** One `(info_hash, file_index_key)` = one cached URL.
- **Active placement determines which URL is cached.**

---

## 5. State Machine Interactions

### 5.1 How Placement State Affects Materialization State

| Placement State | Materialization State | Reason |
|-----------------|----------------------|--------|
| `pending` | `acquiring` | Waiting for provider to finish |
| `complete` + no URL resolved | `acquiring` | Provider ready, need to resolve URL |
| `complete` + URL resolved | `available` | Can serve bytes |
| `failed` + alternate placement exists | `acquiring` | Switch to alternate, resolve URL |
| `failed` + no alternate placement | `failed` | No provider can serve content |

### 5.2 How URL Cache State Affects Materialization State

| URL Cache State | Materialization State | Reason |
|-----------------|----------------------|--------|
| `missing` | `acquiring` or `expired` | Need to resolve or refresh |
| `fresh` | `available` | Ready to serve |
| `stale` | `available` (but refresh pending) | Serving while refreshing |
| `expired` | `expired` or `repairing` | Need refresh |

### 5.3 Combined State Matrix

| Placement | URL Cache | Materialization | Meaning |
|-----------|-----------|-----------------|---------|
| `pending` | `missing` | `acquiring` | Placement in progress |
| `complete` | `missing` | `acquiring` | Provider ready, resolving URL |
| `complete` | `fresh` | `available` | Ready to play |
| `complete` | `stale` | `available` | Playing, refresh pending |
| `complete` | `expired` | `expired` | URL expired, refresh needed |
| `complete` | `expired` | `repairing` | Refresh in progress |
| `failed` | `missing` | `failed` | No placement, no URL |
| `failed` (alt exists) | `missing` | `acquiring` | Switching to alternate |
| `failed` (alt exists) | `fresh` | `available` | Alternate has valid URL |

---

## 6. Error-to-State Mapping

| Provider Error | Placement State | Materialization State | URL Cache State |
|----------------|-----------------|----------------------|----------------- |
| Auth error (401) | `complete` → unchanged | `available` → `failed` | `fresh` → `missing` |
| Rate limit (429) | `complete` → unchanged | `available` → `repairing` | `fresh` → `stale` |
| Not found (404) | `complete` → `failed` | `available` → `failed` | `fresh` → `missing` |
| Provider error (500) | `complete` → `failed` | `available` → `failed` | `fresh` → `missing` |
| URL refresh fails | `complete` → unchanged | `expired` → `repairing` | `expired` → `missing` |
| Max retries exceeded | `complete` → unchanged | `repairing` → `failed` | `expired` → `missing` |

---

## 7. State Machine Summary

| State Machine | Owner | States | Purpose |
|---------------|-------|--------|---------|
| Placement | Placement Layer | `pending` → `complete` → `failed` | Track provider-side content holding |
| Materialization | Materialization Registry | `acquiring` → `available` → `expired` → `repairing` → `failed` | Track resolver-side byte availability |
| URL Cache | Materialization Registry | `missing` → `fresh` → `stale` → `expired` | Track cached URL freshness |

---

## 8. References

- **Architecture:** `MATERIALIZATION-ARCHITECTURE.md` §7.4
- **Registry Schema:** `MATERIALIZATION-REGISTRY-SCHEMA.md` §3.3 (state), §3.4 (URL cache)
- **Resolver Design:** `RESOLVER-DESIGN.md` §4 (state machine), §5 (transitions)
- **Provider Interface:** `PROVIDER-INTERFACE.md` §3.3 (errors)

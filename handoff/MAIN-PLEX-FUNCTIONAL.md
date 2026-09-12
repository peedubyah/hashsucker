# MAIN-PLEX-FUNCTIONAL

> **Historical evidence only:** use [`CURRENT.md`](CURRENT.md) for the active
> state and next action.

**FROZEN — 2026-09-06 — CachyOS/main Plex production proof**

## Proof Summary

### Steps Passed

| Step | Description | Result |
|------|-------------|--------|
| 1 | Clean restart, durable truth survives | ✅ PASS |
| 2 | Fresh POST /api/media-request (Oppenheimer tt15398776) | ✅ PASS |
| 3 | Durable publication + Plex indexing | ✅ PASS |
| 4 | Real Plex playback after restart | ✅ PASS |
| 5 | Sustained playback (several minutes) | ✅ PASS |
| 6 | Far seek + ~2s recovery | ✅ PASS |
| 7 | Restart survives without manual repair | ✅ PASS |
| 8 | Playback works after restart without repair | ✅ PASS |
| 9 | No pathology: API storm, breaker, rclone, VFS, duplication | ✅ PASS |

### Items Proven

- **Black Panther (2018)** — tt1825683, tf_5de34a78-0a1a-410b-8de5-76ded2680e7d, 34,319,716,114 bytes
- **Oppenheimer (2023)** — tt15398776, tf_c3c50dea-9282-4762-86e4-2867283b0917, 93,217,547,570 bytes

### Durable State (post-restart)

```
playback_handoffs:  2 (tt1825683, tt15398776)
vfs_movie_entries:  2 (correct paths + sizes)
bindings:            2
library_items:       all desired_state=present
```

### Playback Evidence

**Post-restart cold-start playback (Oppenheimer):**
- chunks_present: 1025 (warm disk cache survived restart)
- chunk_fills: 31 (cold fetches triggered)
- layer_A.2xx: 2
- T5: 5ms (sub-10ms latency)
- breaker_opens: 0
- pool: [] (empty; cold-start confirmed)

**Far seek (Black Panther, pre-restart):**
- +2,480,000 byte offset delta
- +17 chunk_fills, +2 layer_A calls, +3 client_cancellations, +2 seek_reprioritizations
- Internal latency spike 3663ms → recovered to 91ms within 30s

### Stall Events (DEGRADED — self-recovered)

**Two transient stalls observed:**

| Event | Time | Duration | Recovery |
|-------|------|----------|----------|
| Stall 1 | ~00:50 into session | ~10–15s | Auto-resumed |
| Stall 2 | ~02:23 into session | ~10–15s | Auto-resumed |

**Observed during stall:**
- `limiter_wait_ms_total: 244,321ms` (81% of 300s wall time in limiter queue)
- `limiter_waits: 6` (6 dispatch attempts blocked by rate limiter)
- `upstream_errors: 7` (of 12 total requests)
- `recovery.attempts: 9` (4 internal recoveries succeeded)
- `stages_recent[4]`: T4=55,438ms, T5=55,438ms, `provider_ttfb_ms: 55,437ms`
- `cache_decisions` shows `plan: full_miss` (all reads were uncached)
- `pool: []` (capability pool empty; all requests cold-start)
- `breaker_opens: 0` (no breaker pathology)
- `layer_C_cdn.final_cdn_host: nexus.erth.tb-cdn.earth` (CDN reached and responded)

**Corrected diagnosis (evidence-narrow):**
> Recurring transient stalls correlate with severe permit/dispatch contention on cold uncached demand; exact concurrency source and provider-stage decomposition require better instrumentation.

**What is NOT indicated:**
- No VFS corruption, duplication, or stale resurrection
- No API storm or spurious requests
- No circuit breaker pathology (0 breaker opens despite 7 upstream errors)
- No rclone failure (WebDAV returned HTTP 200/206 throughout)
- No publication duplication
- Playback intelligence correctly gated by real `/files/:tfId` Range traffic; `viewOffset` and `lastViewedAt` do not trigger prefetch

**What IS indicated:**
- Rate limiter correctly protecting CDN from overload
- Empty capability pool + empty cache = every request cold-fetches from CDN
- Multiple concurrent cold fetches serialize onto limited permit slots
- Wait time in limiter queue is visible to Plex as buffering

**Verdict: `MAIN PLEX DEGRADED`**

The Plex path is production-functional end-to-end. Both stalls self-recovered without user action, data loss, or publication corruption. The stalls are UX-impacting but not data-threatening. Rate limiter is working as designed; the symptom is permit contention under cold-start load, not a failure mode.

---

## Architecture Notes

- Node.js owns truth; Rust owns motion
- `rclone --vfs-cache-mode minimal` is required (writes mode causes seek failure)
- Playback intelligence is HTTP Range-gated; Plex `viewOffset` does not trigger prefetch
- Provider identity unresolved for captured sessions; do not infer from stale logs

## Next

HY4 Windows baseline using CachyOS/main as the oracle. Do not broaden scope.

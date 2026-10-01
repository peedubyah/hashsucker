# Failure and Recovery Model

Boundaries are drawn where state changes hands. For each: expected
behavior, automatic recovery, what survives, what is unproven, and what
must never need a human.

| Layer | Expected | Auto-recovery | Survives | Unproven / never-manual |
|---|---|---|---|---|
| Request ingestion | Typed 4xx/5xx, fail closed | Re-request idempotent; reuse healthy publication | Intents, requests, handoffs | — / never invent identity to satisfy intake |
| Discovery unavailable | Corpus-backed degraded ranking with stated `hasLiveDiscovery:false` | Next request retries live | Candidates, observations | Live-source outages / never fabricate candidates |
| Corpus stale | Serving continues live-only | 6h lifecycle tick; bounded backoff | Serving corpus (never destroyed by updater) | — |
| Provider inventory stale | `INVENTORY_UNAVAILABLE`, bounded per-route retry throttle | Snapshot invalidation + re-observe; mark-removed + recreate delivery | Placements, TFs, bindings | Forced real-provider dead-link concurrency / — |
| Placement unavailable | Fallback selection / typed `NO_PLACEMENT` | Alternate fallback, availability revalidation | All durable rows | — |
| Capability expired | Reacquire same TF (once), then failover lane | Manager reacquire + cross-provider lane (warm-first, ≤1/read) | TF identity, cache grid | — |
| CDN throttled (429/5xx) | Throttle-until + same-URL reuse, ≤3 retries | Breaker half-open; reactive failover precedes sleeps | Backoff state (process-local) | — / never storm a throttled provider |
| Node restart | Self-heal to playable in seconds | Migrations ledgered; lifecycle persists progress; corpus resumes | Both SQLite DBs | — |
| Rust restart | Zero-TF boot; managers rebuild from fresh S-1 | Chunk store survives (complete chunks + LRU); pools rebuild | Chunk objects + sqlite | In-flight reads (dropped, client retries) |
| Consumer/PMS restart | Replays re-resolve; identity snapshots unchanged (proven across restarts) | Idle replay verified; readiness-gated probes | Library truth | **Active PMS-outage continuity: unproven, explicitly stopped** |
| Stale VFS publication | `rejection-supersede` / legacy supersede preserving path | Race recovery, 30s activation backoff | Canonical path stability | — |
| Invalid representation | Bind refusal with typed reason; continue ranked candidates | Never invent identity | Ranking evidence | — |
| Client seek failure | 416 on out-of-bounds; single-byte probes bypass cache | Coalesced re-fetch of exact ranges | Nothing (stateless per range) | — |

**What should never require manual repair:** route changes, restarts,
stale placements, expired capabilities, VFS rebinds, corpus updates,
staged-file sweeps. Manual repair proves a path exists; only autonomous
recovery counts as recovery (see Reliability).

## Source references

- `docs/BUILD-LOG.md` (per-slice evidence + explicit unproven lists),
  `data-plane/src/{transport,manager,provider,capability}.rs`
- `media-search/src/lib/vfs/materialize.js`,
  `media-search/src/lib/resolver/availability-revalidation.js`

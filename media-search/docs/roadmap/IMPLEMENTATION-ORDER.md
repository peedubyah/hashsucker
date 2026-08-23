# Implementation Order — HashSucker Roadmap

**Date:** 2026-08-23  
**Scope:** Phased implementation roadmap for HashSucker materialization  
**Complements:** `ARCHITECTURE-BOUNDARIES.md` (boundaries), `ANTI-PATTERNS.md` (anti-patterns)  
**Constraints:** No code; no schema migrations; roadmap documentation only

---

## 1. Phase Overview

```
Phase A: Corpus Evidence Projections
  └─ 2O, 2P, 2Q, 2R (corpus evidence enhancements)

Phase B: Materialization Foundation
  └─ Registry + Provider Interface + Resolver

Phase C: Consumers
  └─ .strm + WebDAV + FUSE

Phase D: Reliability
  └─ Repair + Multi-Provider + Background Refresh
```

---

## 2. Phase A — Corpus Evidence Projections

### 2.1 Status

**IMPLEMENTED** — Three of four projections exist in `Docs/corpus docs.js`:
- **2O:** `createCorpusPersistenceFeatures()` — temporal, persistence, lifecycle features
- **2P:** `createCorpusTopologyFeatures()` — file composition, structure, quality heuristics
- **2Q:** `createCorpusConfidenceFeatures()` — weighted confidence from persistence + topology + metadata
- **2R:** Repair projection (future — evidence for repair decisions)

### 2.2 Description

Corpus evidence projections enhance the discovery layer with:
- **2O:** Observation projection — when was this candidate seen, how often, what's its lifecycle?
- **2P:** Persistence projection — file composition, structural patterns, playable target detection
- **2Q:** Quality projection — weighted confidence combining persistence (0.40), topology (0.40), metadata (0.20)
- **2R:** Repair projection — evidence for future repair orchestration (not yet implemented)

### 2.3 Dependencies

None. Phase A is independent of materialization.

### 2.4 Deliverables

| Item | Description | Status | Location |
|------|-------------|--------|----------|
| 2O | Persistence features (temporal, persistence, lifecycle) | **IMPLEMENTED** | `Docs/corpus docs.js` → `createCorpusPersistenceFeatures()` |
| 2P | Topology features (files, structure, quality) | **IMPLEMENTED** | `Docs/corpus docs.js` → `createCorpusTopologyFeatures()` |
| 2Q | Confidence features (weighted combination) | **IMPLEMENTED** | `Docs/corpus docs.js` → `createCorpusConfidenceFeatures()` |
| 2R | Repair evidence projection | Not started | Future |

### 2.5 Phase A Exit Criteria

- All four projection documents approved
- Corpus schema updated (if needed)
- No materialization dependencies

---

## 3. Phase B — Materialization Foundation

### 3.1 Status

**DESIGN COMPLETE** — Implementation not started.

Design documents exist:
- `MATERIALIZATION-ARCHITECTURE.md` (architecture)
- `MATERIALIZATION-REGISTRY-SCHEMA.md` (schema)
- `PROVIDER-INTERFACE.md` (provider adapter contract)
- `RESOLVER-DESIGN.md` (resolver endpoint)
- `ZURG-INTEGRATION-ANALYSIS.md` (zurg reference)
- `ARCHITECTURE-BOUNDARIES.md` (boundaries)
- `CONTRACTS.md` (contracts)
- `STATE-MACHINE-REFERENCE.md` (lifecycle states)
- `ANTI-PATTERNS.md` (anti-patterns)

### 3.2 Description

Build the core materialization layer:
1. Create registry tables in corpus database
2. Implement provider adapter interface
3. Implement Real-Debrid adapter
4. Implement resolver endpoint
5. Wire resolver to registry and adapter

### 3.3 Components to Build

| Component | Description | Phase |
|---------|-------------|-------|
| Registry tables | `placements`, `materialization_state`, `resolved_urls`, `materialization_events` | B |
| Provider adapter interface | `resolve()`, `refresh()`, `getStatus()` | B |
| Real-Debrid adapter | RD-specific implementation of provider interface | B |
| Resolver endpoint | `GET /media/{info_hash}/{file_index}` | B |
| Redirect logic | 302 redirect when CDN supports Range | B |
| Proxy fallback | 200 proxy when CDN lacks Range | B |
| Range handling | RFC 7233 Range request support | B |
| URL freshness | TTL check and refresh trigger | B |
| Event logging | Append-only lifecycle events | B |

### 3.4 Dependencies

- Phase A (corpus identity must exist)
- Real-Debrid account and API token
- `node:sqlite` (built into Node.js 22+)

### 3.5 Phase B Exit Criteria

- Registry tables created in database
- Provider adapter interface implemented
- Real-Debrid adapter functional
- Resolver endpoint responds to requests
- 302 redirect works for RD CDN URLs
- 200 proxy works as fallback
- Range requests handled correctly
- URL refresh works on expiry
- Events logged for all state transitions

---

## 4. Phase C — Consumers

### 4.1 Status

**NOT STARTED**

### 4.2 Description

Build consumer adapters that use the resolver endpoint:
1. `.strm` generator
2. WebDAV server
3. FUSE filesystem mount

### 4.3 Components to Build

| Component | Description | Phase |
|---------|-------------|-------|
| .strm adapter | Generate .strm files with resolver URLs | C |
| WebDAV adapter | WebDAV server wrapping resolver endpoint | C |
| FUSE adapter | FUSE mount wrapping resolver endpoint | C |
| Path configuration | User-configurable directory structure | C |
| Naming configuration | User-configurable file naming | C |

### 4.4 Dependencies

- Phase B (resolver endpoint must exist)
- `rclone` for WebDAV-to-FUSE bridge (optional)
- FUSE library (if building native FUSE adapter)

### 4.5 Phase C Exit Criteria

- .strm files generated with stable resolver URLs
- WebDAV server lists virtual directories
- WebDAV GET streams bytes via resolver
- FUSE mount presents virtual filesystem
- Path templates configurable by user
- Naming templates configurable by user

---

## 5. Phase D — Reliability

### 5.1 Status

**NOT STARTED**

### 5.2 Description

Add reliability features:
1. Repair orchestrator
2. Multi-provider failover
3. Background refresh
4. Rate limit awareness

### 5.3 Components to Build

| Component | Description | Phase |
|---------|-------------|-------|
| Repair orchestrator | Consume events, trigger repair | D |
| Multi-provider failover | Switch providers on failure | D |
| Background refresh | Proactive URL refresh at 80% TTL | D |
| Rate limit tracking | Track request frequency, back off | D |
| Provider priority | Configurable provider selection | D |
| CDN preflight | Cache CDN Range support status | D |
| Metrics/observability | Prometheus metrics, health endpoint | D |

### 5.4 Dependencies

- Phase B (registry and resolver must exist)
- Phase C (consumers must exist for end-to-end testing)
- TorBox/Premiumize accounts (for multi-provider)

### 5.5 Phase D Exit Criteria

- Repair orchestrator detects failed placements
- Repair orchestrator triggers re-placement or refresh
- Multi-provider failover switches on permanent failure
- Background refresh prevents mid-playback expiration
- Rate limit tracking prevents 429 errors
- Provider priority configuration works
- CDN preflight caches Range support status
- Metrics endpoint exposes resolver health

---

## 6. Implementation Sequence

### 6.1 Critical Path

```
Phase A (Corpus Evidence)
    │
    │ (can start in parallel)
    │
    ▼
Phase B (Materialization Foundation)
    │
    ├── Registry tables
    ├── Provider adapter interface
    ├── Real-Debrid adapter
    ├── Resolver endpoint
    ├── Redirect/proxy logic
    ├── Range handling
    ├── URL freshness
    └── Event logging
    │
    ▼
Phase C (Consumers)
    │
    ├── .strm adapter
    ├── WebDAV adapter
    └── FUSE adapter
    │
    ▼
Phase D (Reliability)
    │
    ├── Repair orchestrator
    ├── Multi-provider failover
    ├── Background refresh
    └── Rate limit tracking
```

### 6.2 Parallel Work

- Phase A can proceed in parallel with Phase B
- Phase C components can be built in parallel (.strm, WebDAV, FUSE are independent)
- Phase D components can be built in parallel (repair, failover, refresh are independent)

### 6.3 Milestones

| Milestone | Phase | Description |
|-----------|-------|-------------|
| M1 | A | Corpus evidence projections complete |
| M2 | B | Registry tables created |
| M3 | B | Provider adapter interface implemented |
| M4 | B | Real-Debrid adapter functional |
| M5 | B | Resolver endpoint responds to requests |
| M6 | B | End-to-end playback via resolver |
| M7 | C | .strm files playable in Kodi/Plex |
| M8 | C | WebDAV server lists and streams |
| M9 | C | FUSE mount works |
| M10 | D | Repair orchestrator functional |
| M11 | D | Multi-provider failover works |
| M12 | D | Background refresh prevents expiry |

---

## 7. Risk Areas

### 7.1 Phase B Risks

| Risk | Mitigation |
|------|------------|
| RD API changes | Abstract behind provider adapter interface |
| Rate limit exhaustion | Implement rate limit tracking early |
| CDN Range support varies | Implement proxy fallback |
| URL refresh fails mid-playback | Implement refresh buffer (80% TTL) |

### 7.2 Phase C Risks

| Risk | Mitigation |
|------|------------|
| WebDAV spec complexity | Use established library (e.g., `webdav-server`) |
| FUSE performance | Use rclone mount instead of native FUSE |
| Path template bugs | Test with real Plex/Jellyfin libraries |

### 7.3 Phase D Risks

| Risk | Mitigation |
|------|------------|
| Repair loops | Implement max retries and backoff |
| Provider API differences | Test each provider adapter thoroughly |
| Background refresh overhead | Make refresh interval configurable |

---

## 8. Out of Scope

The following are explicitly out of scope for all phases:

| Item | Reason |
|------|--------|
| Transcoding | Client handles this |
| Local file cache | Defeats debrid purpose |
| Multi-user auth | Single-user assumption |
| UI for configuration | CLI only for now |
| Docker packaging | Nice-to-have, not core |
| RD-specific caching layer | Abstract to multi-provider |
| Pre-built binaries | Source distribution only |

---

## 9. References

- **Architecture:** `MATERIALIZATION-ARCHITECTURE.md` §8
- **Registry Schema:** `MATERIALIZATION-REGISTRY-SCHEMA.md` §9
- **Provider Interface:** `PROVIDER-INTERFACE.md` §4
- **Resolver Design:** `RESOLVER-DESIGN.md` §9
- **Zurg Analysis:** `ZURG-INTEGRATION-ANALYSIS.md` §3
- **Anti-Patterns:** `ANTI-PATTERNS.md`

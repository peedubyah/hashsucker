# Resolver Intelligence — Future Capabilities

**Status:** Design-only. Not implemented. Do not implement until the basic `stable.strm → resolver → stored selection → 307` path is proven end-to-end.

**Verified baseline:** 2026-08-25. Documents future resolver capabilities that extend the Phase 1 read-only projection boundary without violating core architectural invariants.

## Architectural Invariants

These invariants are non-negotiable. Every future capability below preserves them.

### Invariant 1: Resolver = Decision + Redirect

The resolver decides *which* provider-backed byte stream corresponds to the requested `(infoHash, fileIndex)`, then returns an HTTP 307 redirect to a provider-owned URL.

The resolver is **NOT** a media proxy. It does not:
- Stream bytes through HashSucker
- Buffer, transcode, or re-encode media
- Serve partial content on behalf of the provider
- Act as an intermediary in the data path

Rationale: Mature transports (TorBox `requestdl`, Real-Debrid unrestricted link) own byte delivery, seeking, buffering, and transport caching. HashSucker owns canonical virtual identity and the decision of *which* exact file is wanted.

### Invariant 2: Three-Way Separation

These three concerns remain separate in all future capabilities:

| Concern | Owner | Description |
|---|---|---|
| **Provider-independent release desirability** | Stage 3 ranker | Static-evidence ranking of exact candidates. No provider state. |
| **Provider availability** | Observation layer | Scoped, expiring, authoritative facts about provider cache state. |
| **Provider-specific playback resolution** | Resolver | Pure function mapping a selected candidate to a provider-owned URL. |

No future capability may:
- Fold provider availability into release desirability scoring
- Use release desirability to override authoritative provider observations
- Let provider-specific resolution logic leak into provider-independent ranking

## Current State (Phase 1 — Proven)

The resolver today:

1. Receives `GET /stream/:type/:id` with `(infoHash, fileIndex)`
2. Loads the stored selection via `getExistingSelection(mediaId)` — requires `playback_handoffs` + `provider_observations` with usable state (`cached`, `usable`, `available`)
3. Resolves the TorBox redirect via `resolveTorBoxRedirect(selection, controlPlane)` — pure function, zero provider calls
4. Returns HTTP 307 with `Location: https://api.torbox.app/v1/api/torrents/requestdl?token=...&torrent_id=...&file_id=...`

The canary proves this path end-to-end: known release → identity/request → candidate selected → playback state persisted → `.strm` generated → GET local resolver URL → stored selection loaded → TorBox mapping resolved → HTTP 307 returned.

## Future Capabilities

Each capability below is described with:
- **What**: The capability's purpose
- **Why**: When it becomes necessary
- **Design constraints**: How it preserves the invariants
- **Preconditions**: What must be proven before implementation

---

### 1. Availability / Cache Revalidation at Playback Time

**What:** Before returning a 307, verify the provider still reports the torrent/file as cached. Optionally refresh stale observations.

**Why:** A selection made hours/days ago may no longer be cached. The provider may have purged the torrent, or the file mapping may have changed. Serving a 307 to an expired/deleted resource wastes the user's time and produces a confusing player error.

**Design constraints:**
- Revalidation is a *decision input*, not a proxy action. The resolver either has fresh enough evidence or it doesn't.
- Freshness policy is provider-specific and lives in the observation layer, not the resolver.
- If evidence is stale/missing, the resolver returns a deterministic error (e.g., 409 Conflict with `reason: 'stale-evidence'`) — it does not silently probe the provider on the hot path.
- A background refresh worker (separate concern) may proactively maintain freshness for recently-accessed items.

**Preconditions:**
- TTL/freshness policy is established per provider (see Stage 4 remaining work).
- Background refresh worker exists and is bounded (rate limits, budgets, stopping rules).
- Resolver has a typed error contract for stale-evidence failures.

---

### 2. Provider Fallback

**What:** When the primary provider selection is unavailable, redirect to an alternate provider that has the same `(infoHash, fileIndex)` cached.

**Why:** A single-provider architecture has no resilience. If TorBox purges a torrent or experiences an outage, the user gets no playback. Multi-provider cache diversity is a core reliability property.

**Design constraints:**
- Fallback is a *decision* over existing observations, not a live provider probe.
- The resolver consumes a pre-computed ordered list of `(provider, placement, fileMapping)` candidates for the `(infoHash, fileIndex)`.
- Provider preference order is explicit policy (e.g., TorBox primary, Real-Debrid secondary), not inferred from past success.
- Each candidate in the fallback chain must have its own authoritative `cached` observation meeting freshness policy.
- The resolver returns the first candidate with fresh `cached` evidence. No probing, no guessing.

**Preconditions:**
- At least two providers implement the cache observation capability.
- Placement/file mapping records exist for the same `(infoHash, fileIndex)` across providers.
- Explicit provider preference policy is defined and versioned.

---

### 3. Alternate Selected Candidates

**What:** When the originally selected file is unavailable, redirect to a different file from the same torrent that satisfies the same media intent (e.g., different quality, different release group).

**Why:** The exact `(infoHash, fileIndex)` may be uncached while another file in the same torrent (same release, different quality) is cached. Or the user may have requested "any 1080p" and the specific selection is gone.

**Design constraints:**
- Alternate selection is a *re-decision* over the candidate set, not a resolver heuristic.
- The resolver consumes a pre-ranked candidate set (Stage 3 output) filtered by current provider observations.
- The candidate set is provider-independent; the resolver maps the chosen candidate to a provider-specific URL.
- The resolver does not invent candidates. It selects from the same ranked set the acquisition decision used.
- If no candidate has fresh `cached` evidence, the resolver returns a deterministic error.

**Preconditions:**
- Stage 3 ranked candidate set is available at playback time (persisted with the handoff).
- Current provider observations exist for multiple candidates in the set.
- Policy defines acceptable alternates (same release? same quality tier? any file in torrent?).

---

### 4. Live Discovery Fallback

**What:** When no stored selection exists and no placement is found, query live discovery sources for current cache state of the `(infoHash, fileIndex)`.

**Why:** A user may click play on a release that was never formally requested/placed, but which is currently cached somewhere. Live discovery can find it without a full acquisition workflow.

**Design constraints:**
- Live discovery is a *last resort*, not the default path. The resolver only falls here when stored selection + placement + fallback chain all fail.
- The resolver does not call live sources directly. It consumes a pre-fetched observation set from the discovery layer.
- Live discovery results are treated as observations (scoped, expiring, authoritative/inferred), not as permanent selections.
- A successful live discovery result may trigger a background acquisition workflow to create a durable placement — but this is separate from the resolver's 307 response.

**Preconditions:**
- Live discovery adapters (Torrentio, Comet, Torznab) are normalized into the observation model.
- Rate limits and budgets for live queries are established.
- The resolver has a typed contract for "live-discovered" vs "stored-selection" redirect provenance.

---

### 5. Stale Handoff Repair

**What:** Detect and repair `playback_handoffs` rows that reference placements, observations, or file mappings that are no longer valid.

**Why:** Over time, provider state changes (torrent purged, file re-indexed, account rotated). A handoff that was valid at creation time may become stale. Without repair, the resolver returns confusing errors for previously-working items.

**Design constraints:**
- Handoff repair is a *background reconciliation* activity, not a resolver hot-path action.
- The resolver itself does not repair. It reports the specific staleness (e.g., `reason: 'placement-gone'`, `reason: 'mapping-invalid'`) so a repair worker can act.
- Repair follows the Stage 6 pattern: deterministic plan → explicit authorization → durable execution → evidence-gated reconciliation.
- The resolver's error contract must distinguish "stale, repairable" from "permanently unavailable".

**Preconditions:**
- Stage 6 repair primitives are wired to a live worker (currently they exist as mocks only).
- Staleness detection rules are defined per entity type (placement, observation, mapping).
- Repair authorization policy is defined (auto-repair? operator-authorized?).

---

### 6. Failed-Resolution / Playback Feedback

**What:** Record and surface the outcome of resolver attempts — success, failure reason, which candidate was tried, which provider responded.

**Why:** Without feedback, the system cannot learn which selections are reliable, which providers are healthy, or which releases consistently fail. Operators need visibility into resolver health.

**Design constraints:**
- Feedback is *append-only telemetry*, not a mutation of the handoff or selection.
- The resolver emits structured events (attempt, success, failure-with-reason, fallback-used, provider-selected).
- Telemetry is separate from the control plane store — it does not affect future resolver decisions directly.
- Telemetry may feed into cache-prior models (Stage 12) and provider health dashboards.
- No PII or content bytes in telemetry. Only `(infoHash, fileIndex, provider, outcome, timestamps)`.

**Preconditions:**
- Telemetry sink is defined (structured log? separate table? external system?).
- Event schema is versioned and backward-compatible.
- Privacy/safety review confirms no sensitive data in resolver telemetry.

---

### 7. TorBox Link Expiry / TTL Handling

**What:** Handle the case where a TorBox `requestdl` link has expired or has a known TTL, and the resolver needs to return a fresh link.

**Why:** TorBox `requestdl` links may have limited lifetimes. A `.strm` file with a stale link will fail at playback time. The resolver must either return a fresh link or signal that the link needs renewal.

**Design constraints:**
- The resolver does *not* generate new `requestdl` links by calling TorBox on the hot path. The `requestdl` URL is a stable permalink (token + torrent_id + file_id) — if it expires, the *token* is the variable, not the URL structure.
- If the TorBox API key (token) rotates, the resolver reads the current key from configuration at resolution time, not at `.strm` creation time.
- The `.strm` file contains the *resolver URL* (`/stream/:type/:id`), not the final `requestdl` URL. The resolver always resolves fresh.
- If the token is invalid/expired and cannot be resolved locally, the resolver returns a deterministic error (e.g., 503 with `reason: 'provider-token-invalid'`).

**Preconditions:**
- TorBox token rotation policy is defined.
- Resolver has access to current token at resolution time (env var, config reload, or secret store).
- Error contract covers token-failure modes distinctly from cache-missing modes.

---

### 8. Future Real-Debrid Support

**What:** Extend the resolver to support Real-Debrid as a redirect target, using the same `resolveProviderRedirect(selection, controlPlane)` pattern.

**Why:** Multi-provider resilience requires at least two providers. Real-Debrid is the second target after TorBox parity.

**Design constraints:**
- Real-Debrid resolution is a *provider-specific adapter* behind a common interface: `resolveProviderRedirect(selection, controlPlane)`.
- The interface contract is: `selected candidate → provider-owned URL` or typed error.
- Each provider adapter is a pure function over persisted state — zero provider calls at resolution time.
- Provider selection (which adapter to invoke) is determined by the stored selection's `provider` field, not by resolver heuristics.
- Real-Debrid's URL structure, authentication, and file identification are encapsulated in the adapter. The resolver core is provider-agnostic.

**Preconditions:**
- Real-Debrid cache observation adapter is implemented and fixture-verified.
- Real-Debrid placement/file mapping records exist in the control plane.
- Real-Debrid unrestricted link / direct download URL behavior is documented and tested.
- The common `resolveProviderRedirect` interface is defined and tested with both TorBox and Real-Debrid adapters.

---

## Capability Interaction Matrix

| Capability | Can trigger fallback to... | Preserves invariants |
|---|---|---|
| Cache revalidation | Provider fallback, Alternate candidate | Yes — decision over observations |
| Provider fallback | Alternate provider's stored selection | Yes — policy-ordered, observation-gated |
| Alternate candidate | Different `(infoHash, fileIndex)` from same set | Yes — re-decision, not heuristic |
| Live discovery | Background acquisition workflow | Yes — observation, not selection |
| Stale handoff repair | Re-observation, re-selection | Yes — background, not hot-path |
| Playback feedback | Cache-prior model (Stage 12) | Yes — telemetry, not mutation |
| Link expiry | Token refresh, error to user | Yes — local resolution, no proxy |
| Real-Debrid support | Same fallback chain as TorBox | Yes — adapter behind common interface |

## Implementation Order (Recommended)

These capabilities should be implemented in this order, each proven before the next:

1. **Link expiry / TTL handling** — simplest, no new provider logic, just token freshness
2. **Failed-resolution feedback** — telemetry has no hot-path risk, enables all future decisions
3. **Cache revalidation** — requires freshness policy, enables reliable single-provider playback
4. **Provider fallback** — requires two providers, builds on revalidation
5. **Alternate candidates** — requires persisted candidate sets at playback time
6. **Stale handoff repair** — requires Stage 6 worker wiring
7. **Live discovery fallback** — requires live-source normalization, highest complexity
8. **Real-Debrid support** — requires Real-Debrid observation adapter, parallel with #4+

## Relationship to Roadmap Stages

| Capability | Earliest stage | Depends on |
|---|---|---|
| Link expiry | Stage 7 (TorBox parity) | Token rotation policy |
| Playback feedback | Stage 8 (telemetry) | Event schema, sink |
| Cache revalidation | Stage 4 completion | Freshness policy, refresh worker |
| Provider fallback | Stage 6+ (multi-provider) | Two providers with placements |
| Alternate candidates | Stage 5+ (canonical library) | Persisted candidate sets |
| Stale handoff repair | Stage 6 (repair wired) | Live repair worker |
| Live discovery fallback | Stage 4 completion | Live-source observation adapters |
| Real-Debrid support | Stage 6+ (RD vertical slice) | RD observation adapter |

## Explicit Non-Goals

- The resolver will never proxy bytes.
- The resolver will never make provider calls on the hot path.
- The resolver will never invent candidates or placements.
- The resolver will never conflate desirability, availability, and resolution.
- The resolver will never serve a redirect without fresh authoritative evidence (once revalidation is implemented).
- The resolver will never hide failure modes — every failure is a typed, actionable error.

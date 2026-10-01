# Design Rationale — Why HashSucker Looks Like This

Narrative last: read the machinery first (Pipeline-Overview through
Failure-Recovery). This page explains the decisions, not the parts.

## Exact objects, not files

Torrent identity (`infoHash`) tells you which swarm; it says nothing
about which file inside it is the film, and provider filenames lie.
`TorrentFile = infoHash + canonicalInternalPath + exact positive size`
is the smallest tuple that survives a provider rename, a re-listing,
and a cross-provider move. Everything durable keys off it; everything
ephemeral (capabilities, CDN URLs, cache hints, handoff providerState)
is forbidden from becoming identity. The May-2026 Real-Debrid keyword
filter is the reason this matters in practice, not theory: routes died
by regex while objects stayed byte-identical elsewhere.

## Node decides, Rust serves

Durable decisions (which object, which route is authoritative) need
transactions, history, and policy — Node with SQLite. Byte delivery
needs zero-copy ranges, coalescing, and breakers — Rust with no database
at all. The split is enforced in code comments and error semantics, not
just docs: Rust literally cannot name another Release, and its errors
refuse to fall through to legacy Node byte paths.

## Live authoritative, corpus advisory

A stored candidate is a rumor; a live provider observation is a fact.
The pipeline ranks rumors to decide what to verify, then verifies. This
is why corpus health metrics are never fulfillment evidence and why the
service runs live-only when the corpus is absent.

## Fail closed with typed reasons

Every refusal names itself (`EPISODE_AMBIGUOUS`, `INVENTORY_UNAVAILABLE`,
`RdCooldownError`…). Silent gaps become support tickets; typed errors
become routing decisions. The error taxonomy is a feature, not exhaust.

## No human interface for non-decisions

Request, play, keep, remove. Queues, placements, capabilities, retries,
and reconciliations are machine business with read-only observability.
If a state needs no human decision, it gets no human control.

## Source references

- `docs/architecture.md`, `GOALS.md`, `docs/retrospectives/`

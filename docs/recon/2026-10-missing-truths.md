# Missing Truths — HashSucker Capability Constraints (2026-10)

Status: analysis only. No implementation, no seam selection.

Premise: HashSucker's history is external inference becoming durable internal
truth. The next capability jump is blocked not by missing code but by missing
knowledge. For each ambitious behavior below, the exact missing truth is stated,
along with whether it can be observed/proven, whether it can be made durable,
and what authority it would unlock.

## Missing-truth table

| Desired behavior | Exact missing truth | Can it be observed / proven? | Can it be made durable? | Authority unlocked |
|---|---|---|---|---|
| Pre-publication playback | How a directly played item maps back to consumer identity, watch state, and later publication without duplicate items or lost progress. HashSucker needs proof that a play session can be attributed to a media item the consumer does not yet index, and that publication can be attached retroactively. | Partially. Plex requires a ratingKey/Part for a session; Jellyfin can play external URLs but library attribution is unproven. Would require controlled proof per consumer. | Partially. A pending playback intent can be durable, but consumer watch-state ownership remains external, so full reconciliation cannot be made durable inside HashSucker. | Consumer projection becomes optional for first play; HashSucker owns playability independently of indexing. |
| Same-TF route healing | Whether an alternate route serves byte-identical bytes for the exact TorrentFile, and whether the client tolerates a backend switch behind a stable URL. (HashSucker already owns TF identity and byte-health; the remaining truth is route equivalence and client transparency.) | Yes. Byte reads/hashes and byte-health already prove route equivalence; client transparency is proven by serving through a stable `/bytes/:tfId` URL. | Route health is deliberately ephemeral; durable evidence of failure class can be persisted, but capability URLs and cooldowns must not become durable authority. | Provider execution becomes a replaceable backend without representation drift. Mostly already unlocked. |
| Alternate-TF healing | Whether an alternate TorrentFile is semantically/temporally compatible with the current one (same cut, duration, audio/subtitle structure) and whether the user's intent permits substitution. Also whether the alternate is byte-serviceable. | Partially. Duration, codec, and track counts can be probed; cut/intro equivalence and subtitle/audio index mapping cannot be proven from metadata alone. Position mapping across different durations is not well-defined. | Compatibility can be recorded as observed evidence after a successful switch, but cannot be predicted reliably. Negative evidence (known-incompatible pairs) is more durable than positive. | Representation becomes replaceable between sessions; Binding no longer implies a single permanent TF. |
| Mid-session TF switching | Temporal compatibility and position mapping between two representations, plus whether the client can reopen the source without session discontinuity and whether progress can be remapped across durations. | Partially. Metadata probing can establish duration/track similarity; semantic cut equivalence and position mapping remain unprovable without playback. Client reopen tolerance is unproven. | Only observed switch success can be durable; prediction of switch safety is not currently supportable. | Adaptive playback execution; requires either player source control or a clean reopen with position restore. |
| Cross-client continuation | Client B's capabilities (codecs, tracks, bitrate, buffer) and whether it can resume at an arbitrary position; whether progress can be reconciled across two consumers that both own watch state. | Partially. Capabilities can be observed/probed; resume position is consumer-owned and not transferable with proof. | Client-class capability profiles can be durable; session state cannot be owned without violating the consumer-state veto. | Position handoff across clients, but not full session ownership. |
| Client compatibility | Which failures are representation-specific vs client-specific vs provider-specific, keyed by client class. | Yes, if client class and outcome are recorded during playback. Currently accepted-TF evidence lacks client class; Plex session mapping does not record it. | Yes. Scoped compatibility memory is already proposed and is durable by design. | Selection becomes client-aware; fewer transcode traps; known-bad becomes scoped rather than global. |
| Autonomous availability maintenance | A bounded definition of "guarantee" when upstream bytes can vanish; control over acquisition and storage; whether an alternate candidate exists and is serviceable; whether the user wants the item retained; quota and storage limits. | Partially. Availability and acquisition success are observable; "guarantee" is a policy, not an observable fact, unless HashSucker stores bytes itself. | Availability evidence and acquisition results can be durable; the guarantee itself cannot be made a fact without local storage authority. | Availability moves from provider truth to HashSucker truth, but only where HashSucker has storage/acquisition authority; otherwise best-effort survival. |
| Consumer replacement / migration | Consumer contract equivalence: how each consumer identifies media, where it expects files, how it stores watch state, how it refreshes; whether HashSucker truth can reconstruct all consumer-visible semantics; whether a rebuild is complete and byte-verified. | Partially. Filesystem/identity contracts can be observed in controlled tests; watch state, users, playlists, and metadata choices remain consumer-owned and are not reconstructable from HashSucker truth. | Consumer mappings and projection state can be durable; personal state cannot be owned without scope creep. | Consumer becomes a replaceable projection for identity/playability, not for personal state. |

## Which missing truth unlocks the largest family?

If one missing truth must be chosen: **consumer semantic reconciliation** — the exact, provable mapping between a directly played or migrated item and the consumer's later identity, watch state, and projection.

Why this one:

- It is the gate for pre-publication playback, consumer replacement/migration, projection minimization, and cross-client continuation. One truth, four behaviors.
- It is the natural next external dependency after publication: HashSucker already owns publication truth; what remains external is how the consumer attaches meaning and state to that truth.
- It is the missing piece behind the most consequential authority move available: reducing the consumer from "source of truth for playability and identity" to "projection/renderer," while honestly preserving the personal state HashSucker should not own.
- Representation compatibility is the runner-up: it unlocks alternate-TF healing, mid-session switching, and adaptive execution. But that family is confined to playback execution. Consumer semantic reconciliation unlocks a broader product category change.

Representation compatibility remains the largest *playback-execution* missing truth. Consumer semantic reconciliation is the largest *product* missing truth. The distinction matters: the former changes how media plays; the latter changes what HashSucker is.

## What this does not solve

Acquiring consumer semantic reconciliation does not automatically solve:

- Watch-state ownership (explicitly deferred; requires demonstrated migration loss).
- Metadata authority (Cinemeta remains the metadata source).
- Client capability diversity (separate missing truth).
- Provider storage guarantees (requires acquisition/storage policy).

No implementation is proposed. The table identifies the knowledge gaps that
would have to be closed before any of the listed behaviors could be claimed
safe.

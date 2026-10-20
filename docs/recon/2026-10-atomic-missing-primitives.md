# Atomic Missing Primitives — HashSucker Capability Constraints (2026-10)

Status: analysis only. No implementation, no seam selection.

This document splits each compound missing truth from
`docs/recon/2026-10-missing-truths.md` into atomic primitives. Each primitive
has one crisp contract. Blocker classes:

- OBSERVATION GAP — the fact exists but HashSucker does not currently measure it.
- DERIVATION GAP — enough evidence exists but no trustworthy inference is implemented.
- PROTOCOL GAP — HashSucker knows what should happen but the consumer exposes no supported mechanism.
- AUTHORITY GAP — another system intentionally owns the state or action.
- POLICY GAP — behavior depends on a product decision, not missing evidence.
- FUNDAMENTAL AMBIGUITY — there may be no uniquely correct mapping.

Same-TF route healing is treated as solved baseline and is not re-analyzed.

## Atomic primitives by behavior

### Pre-publication playback

| Atomic primitive | Contract | Blocker class | Observable / provable? | Durable? |
|---|---|---|---|---|
| Consumer item identity attachment | Given a directly played byte stream, produce the consumer's later library-item identity (or a deterministic pending attachment) without creating a duplicate. | PROTOCOL GAP + AUTHORITY GAP | Partially. Consumers assign identity only after scan/index; HashSucker cannot mint it. | The pending attachment can be durable; the final identity remains consumer-owned. |
| Playback-progress attribution | Attribute playback progress to a not-yet-indexed item and later reconcile it with consumer watch state. | AUTHORITY GAP + PROTOCOL GAP | No supported mechanism to write progress to a nonexistent consumer item. | Progress can be buffered durably, but acceptance by the consumer is not guaranteed. |
| Consumer projection completeness | Determine whether a published item has fully materialized in the consumer (scan, Part, metadata). | OBSERVATION GAP | Yes, via existing reconcile/ingest-confirm paths, but coverage and freshness are uneven. | Yes. |

### Alternate-TF healing

| Atomic primitive | Contract | Blocker class | Observable / provable? | Durable? |
|---|---|---|---|---|
| Structural representation compatibility | Determine whether two TFs share compatible container, codec, track layout, and duration class. | OBSERVATION GAP (metadata probe) + DERIVATION GAP | Yes, via file probes. | Yes, as a per-pair verdict. |
| Temporal equivalence transform | Produce a bounded, verifiable mapping from position in representation A to the corresponding position in representation B, or prove none exists. | DERIVATION GAP + FUNDAMENTAL AMBIGUITY | Potentially. Sparse decode fingerprints, audio alignment, chapter/cue structure, and duration/track structure can establish or refute a mapping. Some pairs may have no unique mapping. | Yes, as an observed transform or incompatibility verdict. |
| Substitution permission | Decide whether a given intent/profile/edition permits replacing the active TF with an alternate. | POLICY GAP | Yes, from existing profile and edition semantics. | Yes, as policy. |

### Mid-session TF switching

| Atomic primitive | Contract | Blocker class | Observable / provable? | Durable? |
|---|---|---|---|---|
| Temporal equivalence transform | Same as above. | DERIVATION GAP + FUNDAMENTAL AMBIGUITY | Potentially. | Yes. |
| Client reopen tolerance | Determine whether a client can reopen a source at a new URL/TF without session discontinuity. | PROTOCOL GAP + OBSERVATION GAP | Partially, via controlled playback probes. | Yes, as client-class evidence. |
| Progress remapping validity | Determine whether remapping progress across durations is meaningful and acceptable. | FUNDAMENTAL AMBIGUITY + POLICY GAP | No unique correct mapping for differing cuts. | A policy can make it durable, but the semantic correctness remains ambiguous. |

### Cross-client continuation

| Atomic primitive | Contract | Blocker class | Observable / provable? | Durable? |
|---|---|---|---|---|
| Client capability profile | Know what a client class can decode, at what bitrate, and which tracks it can use. | OBSERVATION GAP | Yes, via playback telemetry if client class is recorded. | Yes. |
| Source progress extraction | Read the current playback position from the source consumer. | PROTOCOL GAP + AUTHORITY GAP | Partially; consumers expose session APIs unevenly. | Position can be cached, but authority remains consumer-owned. |
| Target resume acceptance | Determine whether the target client can resume at an arbitrary supplied position. | PROTOCOL GAP | Partially, via controlled probes. | Yes, as client-class evidence. |

### Client compatibility

| Atomic primitive | Contract | Blocker class | Observable / provable? | Durable? |
|---|---|---|---|---|
| Client-class outcome attribution | Record success/failure by client class and representation, distinguishing representation-specific, client-specific, and provider-specific causes. | OBSERVATION GAP | Yes, if client class and outcome reason are recorded. | Yes. |

### Autonomous availability maintenance

| Atomic primitive | Contract | Blocker class | Observable / provable? | Durable? |
|---|---|---|---|---|
| Availability guarantee definition | A bounded, explicit definition of what "guaranteed available" means when upstream bytes can disappear. | POLICY GAP | No; this is a decision, not an observation. | Yes, as policy. |
| Acquisition authority | Authority to acquire and retain bytes when no healthy route exists. | AUTHORITY GAP + POLICY GAP | Acquisition success is observable; authority to spend quota/storage is a policy decision. | Acquisition results can be durable; authority is not an observation. |
| Retention intent | Whether the user wants an item retained. | OBSERVATION GAP + AUTHORITY GAP | Can be observed if expressed; unexpressed intent is ambiguous. | Expressed intent can be durable. |

### Consumer replacement / migration

| Atomic primitive | Contract | Blocker class | Observable / provable? | Durable? |
|---|---|---|---|---|
| Consumer contract equivalence | Map HashSucker truth to a consumer's identity, filesystem, refresh, and indexing expectations. | OBSERVATION GAP + PROTOCOL GAP | Partially, via controlled migration tests. | Yes, as adapter contract. |
| Personal-state boundary | Explicitly determine which consumer-owned state HashSucker will not reconstruct. | POLICY GAP + AUTHORITY GAP | Yes, as a declared boundary. | Yes. |

## Exploding "consumer semantic reconciliation"

The previous compound phrase contains four atomic primitives, not one:

1. Consumer item identity attachment.
2. Playback-progress attribution.
3. Consumer projection completeness.
4. Consumer contract equivalence.

Proof that these are not one primitive:

- Identity attachment can be solved for a consumer even if progress attribution remains impossible, because identity mapping does not require writing watch state.
- Projection completeness can be observed without either identity attachment or progress attribution, because scan/Part presence is independent of semantic mapping.
- Consumer contract equivalence can be established in controlled tests without solving identity attachment for live, unindexed items.
- Progress attribution is the only primitive that touches consumer-owned watch state; the other three can be advanced without seizing that authority.

Therefore "consumer semantic reconciliation" is a family of four primitives. The most constraining member for pre-publication playback is consumer item identity attachment, not progress attribution.

## Exploding "representation compatibility"

The previous compound phrase contains five atomic primitives:

1. Structural representation compatibility.
2. Temporal equivalence transform.
3. Substitution permission.
4. Client reopen tolerance.
5. Progress remapping validity.

Proof that these are not one primitive:

- Structural compatibility can be established by probes even when no temporal mapping exists.
- A temporal equivalence transform can exist between structurally different containers if the timeline aligns.
- Substitution permission is a policy decision independent of whether a transform exists.
- Client reopen tolerance is a client capability, independent of representation equivalence.
- Progress remapping validity is a semantic/policy question even when a transform exists.

The central and hardest primitive is the temporal equivalence transform. It is also the one that can be advanced without consumer authority.

## Temporal equivalence as an evidence problem

The temporal equivalence transform should not be dismissed because metadata is
insufficient. Possible evidence mechanisms:

- Sparse decode fingerprints across both files at multiple offsets.
- Audio-track alignment (cross-correlation of decoded audio).
- Chapter or cue structure comparison.
- Duration and track-layout normalization.
- Container timestamp and GOP structure analysis.
- Observed successful switching as positive evidence.
- Observed discontinuity or duration mismatch as negative evidence.

These mechanisms may establish a transform, establish incompatibility, or
leave fundamental ambiguity. All three outcomes are useful and durable.

## Which atomic primitive unlocks the most high-value behaviors without unwanted authority?

Answer: **the temporal equivalence transform between two exact representations**
(or a durable proof that no such transform exists).

Behaviors it directly unlocks:

- Alternate-TF healing.
- Mid-session TF switching.
- Safe adaptive representation substitution.

Why this primitive rather than consumer item identity attachment:

- It requires no consumer authority, no protocol cooperation, and no policy
  concession. It is a pure evidence/derivation problem over bytes HashSucker
  already owns.
- It directly addresses the safety objection that previously parked
  representation switching.
- It does not require HashSucker to own watch state, accounts, metadata, or
  client session control.

Consumer item identity attachment is the runner-up: it unlocks
pre-publication playback, migration, and projection minimization, but it
depends on consumer protocol behavior and identity authority. The temporal
equivalence transform is the atomic primitive that most expands safe
capability while preserving HashSucker's stated authority boundaries.

No implementation is proposed.

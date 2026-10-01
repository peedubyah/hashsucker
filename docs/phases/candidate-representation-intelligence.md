# CANDIDATE NEXT PHASE — Representation Intelligence

**Status: CANDIDATE. Graduation has been declared READY in `PLANS.md`,
so entry conditions are met — but activation is Codex's sequencing call,
not the docs lane's. Republication has since LANDED; proof-of-need
analysis (`docs/strategy/2026-10-capability-proof-of-need.md` §§1–3, 9)
holds slices 1–2 (persist accept/known-bad) as next-ready candidates
behind Codex's queue, with experiment design, negative-evidence rules,
and kill conditions specified there. Not active work. No code implied.**

## Why

Ranking re-derives quality from release names on every request and
relearns nothing from real playback. A household that has successfully
played an object knows something no filename parse can provide — and
currently throws it away. Stremio re-resolves every play from zero and
remembers nothing; this phase is precisely that missing memory.

## Scope

Persist accepted representation history and known-bad reasons from real
playback outcomes; use prior knowledge during re-request selection;
measure whether rediscovery/ranking work drops.

## Non-goals

Taste/recommendation ML; cross-household reputation; ranker rewrite;
any UI beyond what a human decision requires; acting on unused data.

## Entry conditions

Core graduation declared; playback-outcome telemetry exists (request →
TorrentFile → client decision → stall/failure facts).

## Exit conditions

(1) Accepted history persisted from real successful playback.
(2) Known-bad reasons persisted.
(3) Re-request selection demonstrably uses prior knowledge.
(4) Measured reduction in rediscovery/ranking work or time-to-playable.

## Kill criteria

If re-request outcomes do not measurably change, or the knowledge never
fires — stop after persistence slices; do not build selection on unused
data.

## Earned slices (in order, each gated, stop anytime)

### Slice 1 — Persist accepted representations
Record known-good acceptance as (exact representation + observed
context + reason/evidence) from real successful playback only:
TorrentFile + client/client-class where outcomes diverge; route-
dependent facts (e.g. "this provider served it fast") stored as route
knowledge, not representation knowledge. Confidence ages out only on
contradictory evidence, never on a timer. Gate: rows exist with stated
reasons; zero synthetic or inferred acceptances.

### Slice 2 — Persist known-bad reasons
Record rejections/failures with typed reasons (transcode trap,
staller, incompatible encode, route-flap). Gate: reasons queryable
per representation; no duplicate rediscovery needed to explain a past
failure.

### Slice 3 — Re-request selection uses prior knowledge
Selection prefers accepted representations and avoids known-bad ones,
with stated reasons. Gate: A/B or before/after on re-requests shows
prior knowledge firing with correct explanations.

### Slice 4 — Measure the win
Quantify rediscovery/ranking work avoided or time-to-playable improved
on real traces. Gate: measured reduction, or the phase stops here and
persistence stands alone as the deliverable.

## Evidence required

Observed playback outcomes + measurements on real traces. No synthetic
acceptances, no inferred compatibility, no ML models.

# HashSucker agent operating system

This file owns the agent loop. Runtime/discipline specifics live in
`AGENTS.override.md` (read it — it is normative). Durable product model lives
in `docs/architecture.md`. Current execution state lives in `PLANS.md`.

## Required reads before touching a slice

1. `PLANS.md` — active phase/slice, gate, parked items.
2. The active slice's phase file under `docs/phases/` — scope, non-goals,
   evidence required, completion criteria.
3. `AGENTS.override.md` — runtime, cleanup, test, identity invariants.
4. `handoff/CURRENT.md` — live session/production state. Do not trust old
   containers or historical HY4 handoffs.

## The loop

PLAN → EXECUTE → VERIFY → RECORD EVIDENCE → RETROSPECT → UPDATE GUIDANCE →
SELECT NEXT SLICE. Documents participate; see "Completion ritual."

## Progress visibility during long work

Silence is acceptable; opacity is not. Report an interim update when —
and only when — one of these occurs: a major assumption changed, a
contradiction was found, a milestone was reached, the task is blocked.
No heartbeat intervals, no fixed reporting schedule, no status noise.
Useful updates beat both silence and spam.

## Role boundaries

- Engineering work (Codex): follow canonical docs, update directly
  affected truth in-slice, record evidence, run the ritual, stop. Never
  become the repo librarian, redesign process mid-slice, or change
  goals/architecture/sequencing without explicit direction.
- Maintenance review (Muse): inspect coherence, identify stale truth,
  propose improvements to the meta-layer. Never an always-on governance
  process; no new process without an observed failure earning it.

## Rules that have earned permanence

- Observed evidence over claims. A test asserting health is not health;
  production-path proof beats synthetic confidence.
- Product-state test harnesses never repair product state. Harnesses may
  read production; they write only to scratch copies (both DBs) unless the
  slice explicitly requires the live corpus — never mutate/checkpoint live
  discovery for convenience.
- Do not advance phases automatically. A passing gate proposes the next
  slice; a human or explicit instruction disposes.
- Screenshots are diagnostic, not acceptance evidence. Acceptance is bytes,
  ranges, hashes, playback decisions observed end to end.
- Test assertions must pin behavior, not implementation. A test that fails
  on a correct refactor lied; fix the test, record it in the retrospective.
- Telemetry/evidence retention must outlive failure attribution. Do not
  delete or roll up the observations a slice needs to explain its own
  outcome until the build log records the verdict.
- Manual repair proves a repair path exists, not autonomous recovery.
  Say which one was proven.
- Corpus/source health is not fulfillment. Candidate counts, enrichment
  queues, and coverage stats never substitute for an end-to-end playable
  proof.
- Existing abstractions and terminology are not sacred. If a slice shows
  an abstraction earns nothing, record deletion as the outcome.
- Exact-object identity invariants (infoHash; TorrentFile =
  infoHash + canonicalInternalPath + exact positive size; provider state
  ephemeral) — details in `AGENTS.override.md`. Do not regress.

## Completion ritual (every slice)

Answer in the build log (`docs/BUILD-LOG.md`), briefly:
WHAT CHANGED / WHAT WAS PROVEN (tests + production evidence + measurements)
/
WHAT REMAINS UNPROVEN / WHAT WAS LEARNED / WHAT ASSUMPTIONS CHANGED /
WHAT SHOULD BE UPDATED (list files) / WHAT SHOULD BE DELETED OR SIMPLIFIED /
NEXT SMALLEST EARNED SLICE.

Then propagate: lesson about agent behavior → this file; product direction
→ `GOALS.md`/product docs; sequencing → `PLANS.md`; verification method →
phase file/harness. Route each lesson once to its owner file; do not
duplicate one lesson across every file. A retrospective is incomplete while its lessons sit
only in the retrospective. No slice is complete until the ritual is done
and `PLANS.md` reflects reality (advanced or explicitly blocked).
A slice is specifically incomplete while: new evidence contradicts
guidance and the contradiction stands; `PLANS.md` and `CURRENT.md`
disagree on active work; actionable guidance sits unpropagated in a
retrospective; canonical truth was updated but a stale duplicate remains
active elsewhere. Reconcile only touched truth and directly invalidated
truth — never churn untouched files to satisfy the ritual.

## Precedence (which file wins a disagreement)

- Live environment/session facts → `handoff/CURRENT.md`.
- Active sequencing (phase/slice/gate/parked) → `PLANS.md`, over
  `CURRENT.md` session notes and `docs/ROADMAP.md` backlog.
- Runtime/cleanup/test/identity discipline → `AGENTS.override.md`, over
  this file's summaries.
- Durable product/architecture model → `docs/architecture.md`.
- Playback acceptance mechanics → `src/PRODUCTION-PLAYBACK-TESTING.md`.
- Observed evidence outranks contradictory factual claims and
  assumptions — but evidence alone changes nothing structural. Goals,
  sequencing, durable architecture, identity rules, and policy change
  only by explicit reconciliation into their canonical owner files.
  An agent must never observe surprising behavior and silently treat
  GOALS, PLANS, architecture, identity, or phase state as amended.
  Evidence forces reconsideration; the canonical edit performs the change.

## Update triggers & stale-truth removal

- `PLANS.md` changes on slice completion, explicit block, or replan —
  never carries history (that is the build log's job).
- `docs/BUILD-LOG.md` appends evidence per completed slice; never plans,
  never interpretation-as-fact.
- Phase file updates when its scope, gate, or assumptions change.
- `handoff/CURRENT.md` updates when live environment/session facts
  change; session verdicts stay there, evidence goes to the build log.
  CURRENT.md may summarize for resume orientation (names, paths,
  fixtures, session findings); it must point to canonical docs for
  identity definitions, architecture contracts, acceptance rules, and
  process — never maintain them. A retained compact summary is labeled
  non-authoritative with its canonical source named.
- When evidence supersedes guidance: remove, demote, or explicitly mark
  the stale text historical **in the same slice** — the slice is
  incomplete while superseded guidance stands unmarked.
- Blocked work is represented as explicit `BLOCKED` in `PLANS.md` with
  the precise blocker and next check — never by silence.
- No wiki exists. If one ever appears, repo docs are canonical and wiki
  content is never independently authoritative — whether generated or
  hand-published.

## Retrospective cadence

Compact retrospective per meaningful slice/phase in
`docs/retrospectives/`, not per edit. Template: expected vs actual,
surprises, disproved assumptions, wasted effort + cause, most useful test,
lying/overconstraining test, automation that should disappear, guidance
change, complexity to remove. Propagate per above; delete or simplify the
thing the retrospective indicts, or record why not.

# Slice runner

Run exactly one active slice of HashSucker work, then stop.

## Trigger

User asks to work the active slice, or session starts with `PLANS.md`
pointing at one.

## Inputs

- `PLANS.md` (active phase/slice, gate, parked list).
- The slice's phase file under `docs/phases/`.
- `AGENTS.override.md`, `docs/architecture.md`, `handoff/CURRENT.md`.

## Procedure

1. Read all inputs. State back: what the slice is, why, current
   evidence, the gate, explicit non-goals, what is parked.
2. Execute only the scoped slice. Do not broaden scope, restart
   architecture, or touch parked items. Do not invent product work.
   Never repair product state to make a test pass (scratch copies for
   harnesses; both-DBs rule). Never silently advance phases. Never
   update GOALS.md or architecture docs on slice authority alone —
   propose, don't rewrite. Obey `AGENTS.override.md`
   (scratch discipline, both-DBs rule, no secret printing).
3. Verify per the phase file's evidence requirements (observed tests +
   production evidence + measurements; no synthetic-only confidence).
4. Perform the completion ritual from `AGENTS.md`: build-log entry,
   retrospective if meaningful, propagate lessons (AGENTS.md / GOALS.md
   / PLANS.md / phase file / harness), propose next smallest earned
   slice.

## Stop conditions

- Gate passes → record, propose next slice, STOP. Never advance phases.
- Gate blocked/failed → record blocker precisely, STOP.
- Scope proves wrong → record why, propose rescoping, STOP.

## Why not just AGENTS.md

AGENTS.md states the rules; this skill sequences them into a repeatable
per-slice session shape (read → restate → execute → verify → ritual →
stop) so every slice starts and ends the same way without re-deriving
the procedure.

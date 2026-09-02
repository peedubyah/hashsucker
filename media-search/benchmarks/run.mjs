#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { classifyState, makeRecord, validateScenario } from './lib.js';

const [command, scenarioArg, ...flags] = process.argv.slice(2);
const scenariosDir = new URL('./scenarios/', import.meta.url);
if (command === 'list') {
  for (const entry of await fs.readdir(scenariosDir)) if (entry.endsWith('.json')) console.log(entry.slice(0, -5));
  process.exit(0);
}
const scenarioPath = scenarioArg?.includes('/') ? scenarioArg : new URL(`./scenarios/${scenarioArg}.json`, import.meta.url);
const live = flags.includes('--live');
const authorized = flags.includes('--authorize-provider-calls');
if (!scenarioArg) throw new Error('usage: node benchmarks/run.mjs list | inspect|run SCENARIO [--live --authorize-provider-calls]');
const scenario = validateScenario(JSON.parse(await fs.readFile(scenarioPath, 'utf8')));
const snapshot = JSON.parse(process.env.BENCHMARK_STATE_JSON || '{}');
const starting_state = classifyState(snapshot);
const blocked = scenario.tier === 3 && (!process.env.BENCHMARK_TARGET || !live || !authorized);
// Minimal Tier-2 support: when the scenario carries an optional
// `command` array, the runner executes it just like Tier-1. This
// lets operator-selected Tier-2 scenarios (e.g.
// media-search-restart-playback) reuse a deterministic proof as
// the bounded evidence. The runner does not add any framework
// abstractions; it just dispatches a subprocess and records the
// exit code.
const tierOneRun = command === 'run' && scenario.tier === 1 && !blocked;
const tierTwoRun = command === 'run' && scenario.tier === 2 && !blocked && Array.isArray(scenario.command);
const execution = (tierOneRun || tierTwoRun)
  ? spawnSync(scenario.command[0], scenario.command.slice(1), { cwd: process.cwd(), encoding: 'utf8' })
  : null;
const passed = Boolean(execution && execution.status === 0);
const record = makeRecord({
  scenario: scenario.name, target: process.env.BENCHMARK_TARGET || null, starting_state,
  status: blocked ? 'BLOCKED' : (tierOneRun || tierTwoRun) ? (passed ? 'PASS' : 'FAIL') : 'SKIPPED',
  failed_invariant: blocked ? 'Tier 3 requires target plus --live --authorize-provider-calls' : null,
  product: { observers: scenario.observers, budget: scenario.budget },
  engineering: execution ? { command: scenario.command, command_exit: execution.status } : {},
  notes: [
    command === 'inspect' ? 'inspection only'
    : blocked ? 'dry run did not send a media request'
    : tierTwoRun ? 'deterministic Tier 2 command executed (resolver-adversarial-recovery case 7)'
    : tierOneRun ? 'deterministic Tier 1 command executed'
    : 'runner execution intentionally deferred',
  ],
});
const out = path.join(path.dirname(fileURLToPath(scenarioPath)), '..', 'runs', `${record.run_id}.json`);
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ record, path: out }, null, 2));

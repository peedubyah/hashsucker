import crypto from 'node:crypto';

export const STATES = new Set(['cold', 'partial', 'warm', 'degraded', 'unknown']);
export const RESULTS = new Set(['PASS', 'FAIL', 'BLOCKED', 'SKIPPED']);

export function classifyState(snapshot = {}) {
  if (snapshot.runtimeBroken) return 'degraded';
  if (snapshot.authoritative && snapshot.playable) return 'warm';
  if (snapshot.publicationCount > 0) return 'partial';
  // A missing VFS row (or a zero publication count in one observer) is not
  // proof that media was never published.  Cold requires an adapter's joined,
  // authoritative absence result across publication and fulfilment records.
  if (snapshot.authoritativeAbsence === true) return 'cold';
  return 'unknown';
}

export function validateScenario(scenario) {
  for (const key of ['name', 'description', 'tier', 'target', 'required_start_state', 'action', 'observers', 'success', 'budget', 'timeout', 'cleanup_policy', 'operator_authorization_required']) {
    if (!(key in scenario)) throw new Error(`scenario missing ${key}`);
  }
  if (![1, 2, 3].includes(scenario.tier)) throw new Error('tier must be 1, 2, or 3');
  if (scenario.tier === 3 && !scenario.budget) throw new Error('tier 3 requires budget');
  return scenario;
}

export function makeRecord({ scenario, target = null, starting_state, ending_state = null, status = 'BLOCKED', failed_invariant = null, product = {}, engineering = {}, notes = [] }) {
  if (!RESULTS.has(status)) throw new Error(`invalid status: ${status}`);
  return {
    run_id: crypto.randomUUID(), timestamp: new Date().toISOString(), git_head: process.env.GIT_HEAD || null,
    runtime_image: process.env.RUNTIME_IMAGE || null, scenario, target, starting_state, ending_state,
    product, engineering, status, failed_invariant, notes,
  };
}

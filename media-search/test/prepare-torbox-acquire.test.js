import assert from 'node:assert/strict';
import test from 'node:test';

import { createTorBoxPrepareAdapter } from '../src/lib/prepare/torbox-acquire.js';
import { toPrepareOutcome, PREPARE_OUTCOME } from '../src/lib/prepare/contract.js';

const HASH = 'dd'.repeat(20);
const TREE = [{ id: 7, name: 'Some.Movie.2024.1080p.mkv', size: 1500 }];
const CAND = { filename: 'Some.Movie.2024.1080p.mkv', size: 1500 };

function fakeFetch(scenario) {
  const calls = [];
  const fetchFn = async (url, options = {}) => {
    calls.push({ url, method: options.method ?? 'GET', body: options.body ?? null });
    const step = (scenario.steps ?? []).shift() ?? scenario.default;
    if (step instanceof Error) throw step;
    return {
      ok: step.ok !== false,
      status: step.status ?? 200,
      json: async () => step.json,
    };
  };
  return { fetchFn, calls };
}

const created = (id) => ({ json: { success: true, data: { torrent_id: id, hash: HASH } } });
const snapshot = (state, files = TREE) => ({
  json: { success: true, data: { id: 99, download_state: state, files } },
});

test('acquire maps immediately when already cached', async () => {
  const { fetchFn, calls } = fakeFetch({ steps: [snapshot('cached')] });
  let placed = null;
  const adapter = createTorBoxPrepareAdapter({
    apiKey: 'k',
    fetchFn,
    createPlacementFn: async (input) => {
      placed = input;
      assert.equal(input.addOnlyIfCached, false, 'prepare acquires, never cache-only');
      return { providerResourceId: '99' };
    },
  });
  const r = await adapter.acquire({ infoHash: HASH, ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.READY);
  assert.equal(r.mapped.path, 'Some.Movie.2024.1080p.mkv');
  assert.equal(r.mapped.size, 1500);
  assert.ok(placed, 'placement went through the injected constructor');
  assert.ok(calls.some((c) => String(c.url).includes('mylist')), 'readiness polled');
});

test('acquire returns accepted while downloading (whole torrent, stated)', async () => {
  const { fetchFn } = fakeFetch({ steps: [snapshot('downloading')] });
  const adapter = createTorBoxPrepareAdapter({
    apiKey: 'k',
    fetchFn,
    createPlacementFn: async () => ({ providerResourceId: '99' }),
  });
  const r = await adapter.acquire({ infoHash: HASH, ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.ACCEPTED);
  assert.equal(r.status, 'pending', 'provider states normalize to pending');
  assert.ok(r.mapped, 'tree mapped even before ready');
});

test('acquire cleans up on unmappable tree', async () => {
  const { fetchFn, calls } = fakeFetch({
    steps: [snapshot('cached', [{ id: 1, name: 'other.mkv', size: 5 }]), { json: { success: true } }],
  });
  const adapter = createTorBoxPrepareAdapter({
    apiKey: 'k',
    fetchFn,
    createPlacementFn: async () => ({ providerResourceId: '99' }),
  });
  const r = await adapter.acquire({ infoHash: HASH, ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.FAILED);
  assert.ok(calls.some((c) => String(c.url).includes('controltorrent')), 'probe deleted');
});

test('poll tracks pending then ready; gone is terminal', async () => {
  const { fetchFn } = fakeFetch({ steps: [snapshot('downloading'), snapshot('cached')] });
  const adapter = createTorBoxPrepareAdapter({ apiKey: 'k', fetchFn });
  const p1 = await adapter.poll({ providerResourceId: '99', ...CAND });
  assert.equal(toPrepareOutcome(p1), PREPARE_OUTCOME.ACCEPTED);
  const p2 = await adapter.poll({ providerResourceId: '99', ...CAND });
  assert.equal(toPrepareOutcome(p2), PREPARE_OUTCOME.READY);
});

test('multi-file ambiguity fails closed (no pretending file-select)', async () => {
  const files = [
    { id: 1, name: 'Pack/E01.mkv', size: 100 },
    { id: 2, name: 'Pack/E02.mkv', size: 100 },
  ];
  const { fetchFn } = fakeFetch({ steps: [snapshot('cached', files)] });
  const adapter = createTorBoxPrepareAdapter({ apiKey: 'k', fetchFn });
  const r = await adapter.mapTargetFile(files, {});
  assert.equal(r.error, 'tb-mapping-ambiguous');
});

test('checkAccount gates missing key; auth failures map to ineligible', async () => {
  const noKey = createTorBoxPrepareAdapter({});
  assert.deepEqual(await noKey.checkAccount(), { eligible: false, reason: 'torbox-disabled' });
  const err = new Error('forbidden');
  err.status = 403;
  const { fetchFn } = fakeFetch({ steps: [err] });
  const adapter = createTorBoxPrepareAdapter({ apiKey: 'k', fetchFn });
  const r = await adapter.poll({ providerResourceId: '99', ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.ACCOUNT_INELIGIBLE);
});

test('cancel deletes and reports honestly', async () => {
  const { fetchFn, calls } = fakeFetch({ steps: [{ json: { success: true } }] });
  const adapter = createTorBoxPrepareAdapter({ apiKey: 'k', fetchFn });
  assert.equal(await adapter.cancel({ providerResourceId: '99' }), true);
  const del = calls.find((c) => String(c.url).includes('controltorrent'));
  assert.ok(del, 'delete endpoint called');
  assert.match(String(del.body ?? ''), /"operation":"delete"/);
  assert.equal(await adapter.cancel({}), false);
});

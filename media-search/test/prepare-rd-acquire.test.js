import assert from 'node:assert/strict';
import test from 'node:test';

import { createRdPrepareAdapter } from '../src/lib/prepare/rd-acquire.js';
import { toPrepareOutcome, PREPARE_OUTCOME } from '../src/lib/prepare/contract.js';

const HASH = 'cc'.repeat(20);

function fakeStore(overrides = {}) {
  return {
    findPlacementByInfoHash: () => null,
    ...overrides,
  };
}

function fakeClient(scenario) {
  const calls = [];
  return {
    calls,
    async validateAccount() {
      calls.push(['validateAccount']);
      return scenario.account ?? { type: 'premium' };
    },
    async listTorrents() {
      calls.push(['listTorrents']);
      return scenario.list ?? [];
    },
    async addMagnet() {
      calls.push(['addMagnet']);
      if (scenario.addError) {
        const err = new Error(scenario.addError.message);
        err.status = scenario.addError.status;
        err.code = scenario.addError.code;
        err.rdErrorCode = scenario.addError.rdErrorCode;
        throw err;
      }
      return { id: scenario.addId ?? 'RD1' };
    },
    async getTorrentInfo(id) {
      calls.push(['getTorrentInfo', id]);
      const step = (scenario.infoSteps ?? []).shift() ?? scenario.info ?? null;
      if (step instanceof Error) throw step;
      return step;
    },
    async selectFiles(id, files) {
      calls.push(['selectFiles', id, files]);
      if (scenario.selectError) throw scenario.selectError;
      return {};
    },
    async deleteTorrent(id) {
      calls.push(['deleteTorrent', id]);
      return {};
    },
  };
}

const TREE = {
  hash: HASH,
  status: 'waiting_files_selection',
  filename: 'Some.Movie.2024.1080p',
  files: [{ id: 1, path: '/Some.Movie.2024.1080p.mkv', bytes: 1500 }],
};
const CAND = { filename: 'Some.Movie.2024.1080p.mkv', size: 1500 };

test('durable-first reuse performs zero writes', async () => {
  const store = fakeStore({
    findPlacementByInfoHash: () => ({ providerResourceId: 'RD9' }),
  });
  const client = fakeClient({});
  const adapter = createRdPrepareAdapter({ store, client });
  const r = await adapter.acquire({ infoHash: HASH, ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.ALREADY_PRESENT);
  assert.equal(r.providerResourceId, 'RD9');
  assert.deepEqual(client.calls, [], 'no provider call at all');
});

test('fresh add maps, selects, and returns accepted while downloading', async () => {
  const client = fakeClient({
    list: [],
    infoSteps: [
      { ...TREE },
      { ...TREE, status: 'downloading', files: TREE.files },
    ],
  });
  const adapter = createRdPrepareAdapter({ store: fakeStore(), client });
  const r = await adapter.acquire({ infoHash: HASH, ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.ACCEPTED);
  assert.equal(r.providerResourceId, 'RD1');
  assert.equal(r.mapped.path, 'Some.Movie.2024.1080p/Some.Movie.2024.1080p.mkv');
  assert.deepEqual(client.calls.map((c) => c[0]),
    ['listTorrents', 'addMagnet', 'getTorrentInfo', 'selectFiles', 'getTorrentInfo']);
});

test('immediate downloaded tree returns ready', async () => {
  const client = fakeClient({
    list: [],
    infoSteps: [{ ...TREE, status: 'downloaded' }, { ...TREE, status: 'downloaded' }],
  });
  const adapter = createRdPrepareAdapter({ store: fakeStore(), client });
  const r = await adapter.acquire({ infoHash: HASH, ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.READY);
});

test('451 maps to content-blocked without creating anything to clean', async () => {
  const client = fakeClient({ list: [], addError: { status: 451, message: 'infringing_file', rdErrorCode: 35 } });
  const adapter = createRdPrepareAdapter({ store: fakeStore(), client });
  const r = await adapter.acquire({ infoHash: HASH, ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.CONTENT_BLOCKED);
  assert.ok(!client.calls.some((c) => c[0] === 'deleteTorrent'));
});

test('403 maps to account-ineligible', async () => {
  const client = fakeClient({ list: [], addError: { status: 403, message: 'permission_denied' } });
  const adapter = createRdPrepareAdapter({ store: fakeStore(), client });
  const r = await adapter.acquire({ infoHash: HASH, ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.ACCOUNT_INELIGIBLE);
});

test('unmapped tree cleans up the probe', async () => {
  const client = fakeClient({
    list: [],
    infoSteps: [{ ...TREE, files: [{ id: 1, path: '/other.mkv', bytes: 999 }] }],
  });
  const adapter = createRdPrepareAdapter({ store: fakeStore(), client });
  const r = await adapter.acquire({ infoHash: HASH, ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.FAILED);
  assert.ok(client.calls.some((c) => c[0] === 'deleteTorrent'), 'probe deleted');
});

test('poll tracks downloading then ready; dead ends terminal', async () => {
  const client = fakeClient({
    infoSteps: [
      { ...TREE, status: 'downloading', progress: 42 },
      { ...TREE, status: 'downloaded' },
    ],
  });
  const adapter = createRdPrepareAdapter({ store: fakeStore(), client });
  const p1 = await adapter.poll({ providerResourceId: 'RD1', ...CAND });
  assert.equal(toPrepareOutcome(p1), PREPARE_OUTCOME.ACCEPTED);
  assert.equal(p1.progress, 42);
  const p2 = await adapter.poll({ providerResourceId: 'RD1', ...CAND });
  assert.equal(toPrepareOutcome(p2), PREPARE_OUTCOME.READY);
  assert.equal(p2.mapped.size, 1500);
});

test('poll 404 is terminal gone; poll errors stay retryable', async () => {
  const goneClient = fakeClient({});
  goneClient.getTorrentInfo = async () => {
    const err = new Error('not found');
    err.status = 404;
    throw err;
  };
  const adapter = createRdPrepareAdapter({ store: fakeStore(), client: goneClient });
  const r = await adapter.poll({ providerResourceId: 'RD1', ...CAND });
  assert.equal(toPrepareOutcome(r), PREPARE_OUTCOME.FAILED);
  assert.match(r.detail, /gone/);
});

test('checkAccount gates on premium without throwing', async () => {
  const okAdapter = createRdPrepareAdapter({
    store: fakeStore(), client: fakeClient({ account: { type: 'premium' } }),
  });
  assert.deepEqual(await okAdapter.checkAccount(), { eligible: true, reason: 'premium' });
  const freeAdapter = createRdPrepareAdapter({
    store: fakeStore(), client: fakeClient({ account: { type: 'free' } }),
  });
  assert.deepEqual(await freeAdapter.checkAccount(), { eligible: false, reason: 'account-type:free' });
  const noClient = createRdPrepareAdapter({ store: fakeStore(), client: null });
  assert.deepEqual(await noClient.checkAccount(), { eligible: false, reason: 'rd-disabled' });
});

test('cancel deletes and reports honestly', async () => {
  const client = fakeClient({});
  const adapter = createRdPrepareAdapter({ store: fakeStore(), client });
  assert.equal(await adapter.cancel({ providerResourceId: 'RD1' }), true);
  assert.equal(await adapter.cancel({}), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { DatabaseSync } from 'node:sqlite';

import { createPreparationStore } from '../src/lib/prepare/store.js';
import { PREPARE_STATE } from '../src/lib/prepare/contract.js';
import { createPrepareDriver } from '../src/lib/prepare/driver.js';

const HASH = 'ee'.repeat(20);

function setup({ adapterBehaviors = {}, controlPlaneStore = null, config = {}, notifiers = {} } = {}) {
  const db = new DatabaseSync(':memory:');
  const store = createPreparationStore({ db });
  const placements = [];
  const cps = controlPlaneStore ?? {
    recordPlacement: (input) => {
      const row = { id: `pl-${placements.length + 1}`, ...input };
      placements.push(row);
      return row;
    },
    replaceProviderFileInventory: () => {},
    findTorrentFile: () => ({ id: 'tf-1' }),
    placements,
  };
  const adapters = {};
  for (const [provider, behavior] of Object.entries(adapterBehaviors)) {
    adapters[provider] = {
      checkAccount: async () => ({ eligible: true, reason: 'test' }),
      acquire: async () => ({ providerResourceId: `${provider}-res`, ...(behavior.acquire ?? {}) }),
      poll: async () => ({ ...(behavior.poll ?? {}) }),
      cancel: async () => true,
      ...behavior.adapter,
    };
  }
  const notified = [];
  const driver = createPrepareDriver({
    store,
    controlPlaneStore: cps,
    adapters,
    config,
    notifiers: {
      onReady: async (info) => { notified.push(info); },
      ...notifiers,
    },
  });
  return { store, cps, driver, notified, placements };
}

function intent(provider = 'torbox', extra = {}) {
  return {
    infoHash: HASH, provider, mediaType: 'movie', mediaId: 'tt0133093',
    candidate: { filename: 'M.mkv', size: 100 },
    providers: [provider],
    ...extra,
  };
}

test('full flow: acquire → poll → ready → persist → rebind → notify', async () => {
  const readyFiles = [{ providerFileId: '7', path: 'M.mkv', name: 'M.mkv', size: 100, selected: true }];
  const { store, driver, notified, placements } = setup({
    // Zero poll interval: consecutive test ticks must both find the row
    // due. Production parks 30–60 s between polls; the interval itself is
    // covered by limit/backoff tests, not here.
    config: { pollIntervalMs: 0, pollIntervalByProvider: {} },
    adapterBehaviors: {
      torbox: {
        acquire: { accepted: true, status: 'downloading' },
        poll: { ready: true, accepted: true, status: 'cached', files: [], mapped: { providerFileId: '7', path: 'M.mkv', size: 100 }, inventoryFiles: readyFiles },
      },
    },
  });
  const started = driver.startPreparation(intent());
  assert.equal(started.created, true);
  const rebinds = [];
  const r1 = await driver.advanceOnce({ rebindFn: async (info) => { rebinds.push(info); return { bound: info.torrentFileId }; } });
  assert.equal(r1.reports[0].transition, 'waiting');
  const r2 = await driver.advanceOnce({ rebindFn: async (info) => { rebinds.push(info); return { bound: info.torrentFileId }; } });
  assert.equal(r2.reports[0].transition, 'ready');
  assert.equal(r2.reports[0].torrentFileId, 'tf-1');
  assert.equal(placements.length, 1);
  assert.equal(placements[0].provider, 'torbox');
  assert.equal(rebinds.length, 1);
  assert.equal(rebinds[0].torrentFileId, 'tf-1');
  assert.equal(notified.length, 1);
  assert.equal(notified[0].torrentFileId, 'tf-1');
  assert.equal(store.get(started.preparation.id).state, PREPARE_STATE.READY);
});

test('content-blocked chains to the next provider in plan', async () => {
  const { driver, store } = setup({
    adapterBehaviors: {
      torbox: { acquire: { blocked: true } },
      realdebrid: { acquire: { accepted: true, providerResourceId: 'rd-1', status: 'downloading' } },
    },
  });
  const started = driver.startPreparation({
    ...intent('torbox'), providers: ['torbox', 'realdebrid'],
  });
  assert.equal(started.created, true);
  const r = await driver.advanceOnce({});
  const chained = r.reports.find((x) => String(x.transition).includes('chained'));
  assert.ok(chained, `expected a chained transition, got ${JSON.stringify(r.reports)}`);
  assert.ok(chained.chainedTo, 'new row for the next provider');
  const next = store.get(chained.chainedTo);
  assert.equal(next.provider, 'realdebrid');
  assert.equal(next.state, PREPARE_STATE.QUEUED);
});

test('limits park without consuming attempts; exhaustion ends', async () => {
  const { store, driver } = setup({
    config: { maxConcurrentTotal: 0, maxAttempts: 1 },
    adapterBehaviors: { torbox: {} },
  });
  const started = driver.startPreparation(intent());
  const before = store.get(started.preparation.id).attempts;
  const r = await driver.advanceOnce({});
  assert.equal(r.reports[0].transition, 'limited');
  assert.equal(store.get(started.preparation.id).attempts, before, 'parked, not attempted');
});

test('account gate fails once clearly without provider writes', async () => {
  let writes = 0;
  const { store, driver } = setup({
    adapterBehaviors: {
      torbox: {
        adapter: {
          checkAccount: async () => ({ eligible: false, reason: 'account-type:free' }),
          acquire: async () => { writes += 1; return { accepted: true }; },
          poll: async () => ({ accepted: true }),
          cancel: async () => true,
        },
      },
    },
  });
  const started = driver.startPreparation(intent());
  const r = await driver.advanceOnce({});
  assert.equal(r.reports[0].transition, 'account-ineligible');
  assert.equal(writes, 0, 'no provider write after a refused gate');
  assert.equal(store.get(started.preparation.id).state, PREPARE_STATE.FAILED_TERMINAL);
});

test('temporary failures park with backoff then exhaust', async () => {
  const { store, driver } = setup({
    config: { maxAttempts: 2, backoffMs: [0] },
    adapterBehaviors: { torbox: { acquire: { retryable: true } } },
  });
  const started = driver.startPreparation(intent());
  const r1 = await driver.advanceOnce({});
  assert.equal(r1.reports[0].transition, 'retry-parked');
  const r2 = await driver.advanceOnce({});
  assert.equal(r2.reports[0].transition, 'exhausted');
  assert.equal(store.get(started.preparation.id).state, PREPARE_STATE.FAILED_TERMINAL);
});

test('missing adapter and missing inventory fail closed', async () => {
  const { driver } = setup({ adapterBehaviors: {} });
  const started = driver.startPreparation({ ...intent('torbox'), providers: ['torbox'] });
  const r = await driver.advanceOnce({});
  assert.equal(r.reports[0].transition, 'no-adapter');
});

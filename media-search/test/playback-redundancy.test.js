import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createSecondPlacementEnsurer } from '../src/lib/control-plane/second-placement.js';
import { createPrewarmCaller } from '../src/lib/control-plane/prewarm.js';
import { createPlaybackRedundancy } from '../src/lib/control-plane/playback-redundancy.js';

// ---------------------------------------------------------------------------
// T9 — playback redundancy activation coordinator (deterministic,
// in-memory DB, fake provider surfaces and fake Rust endpoint; zero live
// HTTP). Real transplanted T7 ensurer + T6 caller throughout, except the
// bounded-terminal proofs which stub the seam inputs directly.
// ---------------------------------------------------------------------------

const HASH = '06bfe49fdc99ad0c6fef1f761382a8181490e456';
const PATH = 'Black.Panther.2018/Black.Panther.2018.mkv';
const SIZE = 34319716114;

function seedPlacement(store, { provider, rid, fileId, hash, path, size }) {
  const placement = store.recordPlacement({
    provider, accountScope: 'default', infoHash: hash,
    providerResourceId: rid, state: 'ready', ownership: 'external',
    ownerKey: null, provenance: 'test-seed',
    observedAt: 1000, expiresAt: 2000,
  });
  const inv = store.replaceProviderFileInventory(placement.id, [{
    providerFileId: fileId, path, name: path.split('/').pop(),
    size, selected: true, corpusFileIndex: 1,
  }], { authoritative: true, complete: false, expiresAt: 2000, evidence: { source: 'test-seed' } });
  const mapped = inv.find((r) => r.mappingState === 'mapped');
  assert.ok(mapped, 'seed must map the exact TorrentFile');
  return { placement, tfId: mapped.torrentFileId };
}

function seedDual(store) {
  const tb = seedPlacement(store, { provider: 'torbox', rid: 'TB1', fileId: '1', hash: HASH, path: PATH, size: SIZE });
  const rd = seedPlacement(store, { provider: 'realdebrid', rid: 'RD1', fileId: '7', hash: HASH, path: PATH, size: SIZE });
  assert.equal(tb.tfId, rd.tfId, 'both placements map the same exact TorrentFile');
  return { tfId: tb.tfId, tbPl: tb.placement, rdPl: rd.placement };
}

function throwingTB() {
  const boom = () => { throw new Error('TB must not be called'); };
  return { createPlacement: boom, checkCached: boom, lookupPlacement: boom, getFileInventory: boom };
}

function throwingRD() {
  const boom = () => { throw new Error('RD must not be called'); };
  return { listTorrents: boom, getTorrentInfo: boom, addMagnet: boom, selectFiles: boom };
}

function fakeRdCreator(calls) {
  return {
    async listTorrents() { calls.list += 1; return []; },
    async getTorrentInfo() {
      calls.info += 1;
      return {
        hash: HASH, status: 'downloaded', original_filename: 'Black.Panther.2018',
        files: [{ id: 7, path: '/Black.Panther.2018.mkv', bytes: SIZE, selected: 1 }],
      };
    },
    async addMagnet(magnet) { calls.add += 1; calls.magnets.push(magnet); return { id: 'RD9' }; },
    async selectFiles() { calls.select += 1; return {}; },
  };
}

function fakePrewarmFetch(calls, { status = 'warmed', apiDelta = 1, capId = 'cap-9' } = {}) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      async json() {
        return {
          status, torrentFileId: 'tf', tfDurableKey: 'tfkv-unit',
          provider: JSON.parse(init.body).provider,
          providerResourceId: JSON.parse(init.body).providerResourceId,
          capId, apiDelta, elapsedMs: 5,
        };
      },
    };
  };
}

// ---- T1: created target -> prewarm known target, never waits for primary ----
test('T1 created placement prewarms immediately with zero attribution wait', async () => {
  const store = createControlPlaneStore();
  const tb = seedPlacement(store, { provider: 'torbox', rid: 'TB1', fileId: '1', hash: HASH, path: PATH, size: SIZE });
  const tfId = tb.tfId;
  const calls = { list: 0, info: 0, add: 0, select: 0, magnets: [] };
  const ensurer = createSecondPlacementEnsurer({
    store, torbox: throwingTB(), realdebrid: fakeRdCreator(calls),
    rdPoll: { maxAttempts: 3, delayMs: 0, sleep: async () => {} },
  });
  const http = [];
  const prewarmCaller = createPrewarmCaller({
    store, dataPlaneBaseUrl: 'http://dp:3001', fetchFn: fakePrewarmFetch(http),
  });
  const ctl = createPlaybackRedundancy({ store, ensurer, prewarmCaller, enabled: true });
  const r = ctl.notifyForegroundDemand({ torrentFileId: tfId });
  assert.equal(r.scheduled, true);
  const t = await r.flight;
  assert.equal(t.t7.status, 'created');
  assert.equal(t.t7.targetProvider, 'realdebrid');
  // No attribution was ever reported, yet prewarm ran exactly once on
  // the known created target.
  assert.equal(t.primary.source, 'none');
  assert.equal(t.primary.reason, 'not-required-created');
  assert.equal(t.standbyProvider, 'realdebrid');
  assert.equal(http.length, 1, 'exactly one prewarm call');
  assert.equal(http[0].body.provider, 'realdebrid');
  assert.equal(http[0].body.providerResourceId, 'RD9');
  assert.equal(t.prewarm.status, 'warmed');
  assert.equal(t.activationStatus, 'ready');
  assert.equal(t.waitedOnActivation, false);
  console.log('T1 ok: created fast path, prewarm without attribution');
});

// ---- T2: already_ready parks until a fresh serving attribution arrives ----
test('T2 already_ready performs no prewarm until fresh primary attribution', async () => {
  const store = createControlPlaneStore();
  const { tfId, tbPl, rdPl } = seedDual(store);
  const ensurer = createSecondPlacementEnsurer({ store, torbox: throwingTB(), realdebrid: throwingRD() });
  const http = [];
  const prewarmCaller = createPrewarmCaller({
    store, dataPlaneBaseUrl: 'http://dp:3001', fetchFn: fakePrewarmFetch(http),
  });
  const ctl = createPlaybackRedundancy({ store, ensurer, prewarmCaller, enabled: true });
  const r = ctl.notifyForegroundDemand({ torrentFileId: tfId });
  assert.equal(r.scheduled, true);
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(http.length, 0, 'T2: no prewarm before the serving primary is known');
  assert.ok(ctl.getFlight(tfId) !== null, 'T2: flight usefully pending');
  ctl.reportServingPrimary({ torrentFileId: tfId, provider: 'torbox', providerResourceId: tbPl.providerResourceId });
  const t = await r.flight;
  assert.equal(t.t7.status, 'already_ready');
  assert.equal(t.t7.apiCalls, 0);
  assert.equal(t.primary.source, 'attributed');
  assert.equal(t.standbyProvider, 'realdebrid');
  assert.equal(t.standbyPlacementId, rdPl.id);
  assert.equal(http.length, 1, 'exactly one prewarm after attribution');
  assert.equal(http[0].body.providerResourceId, 'RD1');
  assert.equal(t.activationStatus, 'ready');
  // Repeat demands cause zero duplicate work (ready is sticky).
  const r2 = ctl.notifyForegroundDemand({ torrentFileId: tfId });
  assert.equal(r2.scheduled, false);
  assert.equal(r2.reason, 'already-ready');
  assert.equal(http.length, 1);
  console.log('T2 ok: parked, then attributed-other standby warmed once');
});

// ---- T3: fresh attribution both directions selects the bound alternate ----
test('T3 RD primary warms validated TB alternate, and inverse', async () => {
  const mk = () => {
    const store = createControlPlaneStore();
    const { tfId, tbPl, rdPl } = seedDual(store);
    const ensurer = createSecondPlacementEnsurer({ store, torbox: throwingTB(), realdebrid: throwingRD() });
    const http = [];
    const prewarmCaller = createPrewarmCaller({
      store, dataPlaneBaseUrl: 'http://dp:3001', fetchFn: fakePrewarmFetch(http),
    });
    const ctl = createPlaybackRedundancy({ store, ensurer, prewarmCaller, enabled: true });
    return { store, tfId, tbPl, rdPl, ctl, http };
  };
  // RD serves: standby must be the validated TB placement.
  {
    const { tfId, tbPl, ctl, http } = mk();
    const r = ctl.notifyForegroundDemand({ torrentFileId: tfId });
    ctl.reportServingPrimary({ torrentFileId: tfId, provider: 'realdebrid', providerResourceId: 'RD1' });
    const t = await r.flight;
    assert.equal(t.standbyProvider, 'torbox');
    assert.equal(t.standbyPlacementId, tbPl.id);
    assert.equal(http[0].body.provider, 'torbox');
    assert.equal(http[0].body.providerResourceId, 'TB1');
    assert.equal(t.activationStatus, 'ready');
  }
  // TB serves: standby must be the validated RD placement.
  {
    const { tfId, rdPl, ctl, http } = mk();
    const r = ctl.notifyForegroundDemand({ torrentFileId: tfId });
    ctl.reportServingPrimary({ torrentFileId: tfId, provider: 'torbox', providerResourceId: 'TB1' });
    const t = await r.flight;
    assert.equal(t.standbyProvider, 'realdebrid');
    assert.equal(t.standbyPlacementId, rdPl.id);
    assert.equal(http[0].body.provider, 'realdebrid');
    assert.equal(t.activationStatus, 'ready');
  }
  console.log('T3 ok: exclusion both directions, validated placements only');
});

// ---- T4: cache-only leaves activation parked; one flight; no guessed provider ----
test('T4 cache-only reports park the flight; one flight, zero prewarm, no guess', async () => {
  const store = createControlPlaneStore();
  const { tfId } = seedDual(store);
  const ensurer = createSecondPlacementEnsurer({ store, torbox: throwingTB(), realdebrid: throwingRD() });
  const http = [];
  const prewarmCaller = createPrewarmCaller({
    store, dataPlaneBaseUrl: 'http://dp:3001', fetchFn: fakePrewarmFetch(http),
  });
  const ctl = createPlaybackRedundancy({ store, ensurer, prewarmCaller, enabled: true });
  const r1 = ctl.notifyForegroundDemand({ torrentFileId: tfId });
  const r2 = ctl.notifyForegroundDemand({ torrentFileId: tfId });
  const r3 = ctl.notifyForegroundDemand({ torrentFileId: tfId });
  assert.equal(r1.scheduled, true);
  assert.equal(r2.reason, 'already-activating');
  assert.equal(r3.reason, 'already-activating');
  assert.equal(r2.flight, r1.flight, 'T4: one shared flight');
  // Cache-only demand reports null: recorded, but resolves nothing.
  const rep = ctl.reportServingPrimary({ torrentFileId: tfId });
  assert.equal(rep.recorded, true);
  assert.equal(rep.valid, false);
  await new Promise((res) => setTimeout(res, 20));
  assert.ok(ctl.getFlight(tfId) !== null, 'T4: still parked after cache-only');
  assert.equal(http.length, 0, 'T4: no prewarm, no guessed provider');
  // A later provider-backed report settles the SAME flight exactly once.
  ctl.reportServingPrimary({ torrentFileId: tfId, provider: 'torbox', providerResourceId: 'TB1' });
  const t = await r1.flight;
  assert.equal(t.activationStatus, 'ready');
  assert.equal(t.standbyProvider, 'realdebrid');
  assert.equal(http.length, 1, 'T4: exactly one prewarm total');
  console.log('T4 ok: parked through cache-only, single flight, one prewarm');
});

// ---- T5: pending/unavailable/failed stay bounded, cooldown stops storms ----
test('T5 terminal outcomes never storm ensure/prewarm calls', async () => {
  const mk = (ensurerImpl) => {
    const store = createControlPlaneStore();
    const { tfId } = seedDual(store);
    let prewarmCalls = 0;
    const ctl = createPlaybackRedundancy({
      store,
      ensurer: ensurerImpl,
      prewarmCaller: { async prewarmPlacement() { prewarmCalls += 1; throw new Error('must not be called'); } },
      now: () => nowVal,
      cooldownMs: 60_000,
      enabled: true,
    });
    return { tfId, ctl, getPrewarmCalls: () => prewarmCalls };
  };
  let nowVal = 1000;
  // Pending: recorded honestly, no prewarm, cooldown holds.
  {
    let p2fCalls = 0;
    const { tfId, ctl, getPrewarmCalls } = mk({
      async ensureSecondPlacement() { p2fCalls += 1; return { status: 'pending', reason: 'not-downloaded-within-bound', apiCalls: 5 }; },
    });
    const t = await ctl.notifyForegroundDemand({ torrentFileId: tfId }).flight;
    assert.equal(t.activationStatus, 'pending');
    assert.equal(getPrewarmCalls(), 0);
    assert.equal(t.waitedOnActivation, false);
    nowVal = 2000;
    const r2 = ctl.notifyForegroundDemand({ torrentFileId: tfId });
    assert.equal(r2.scheduled, false);
    assert.equal(r2.reason, 'cooldown');
    assert.equal(p2fCalls, 1, 'T5: no spin on pending');
  }
  // Unavailable + throw paths: failed/unavailable, zero prewarm, one retry after cooldown.
  {
    nowVal = 10000;
    let p2fCalls = 0;
    const { tfId, ctl, getPrewarmCalls } = mk({
      async ensureSecondPlacement() { p2fCalls += 1; return { status: 'unavailable', reason: 'not-cached', apiCalls: 2 }; },
    });
    const t = await ctl.notifyForegroundDemand({ torrentFileId: tfId }).flight;
    assert.equal(t.activationStatus, 'unavailable');
    assert.equal(getPrewarmCalls(), 0);
    const r2 = ctl.notifyForegroundDemand({ torrentFileId: tfId });
    assert.equal(r2.reason, 'cooldown');
    nowVal = 10000 + 60_001;
    const r3 = ctl.notifyForegroundDemand({ torrentFileId: tfId });
    assert.equal(r3.scheduled, true, 'T5: exactly one bounded retry after cooldown');
    await r3.flight;
    assert.equal(p2fCalls, 2);
    assert.equal(getPrewarmCalls(), 0, 'T5: still zero prewarm without a usable placement');
  }
  console.log('T5 ok: bounded terminal states, cooldown, single retry');
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createSecondPlacementEnsurer } from '../src/lib/control-plane/second-placement.js';

// ---------------------------------------------------------------------------
// T7 — proactive second-placement readiness (deterministic, in-memory DB,
// fake provider surfaces; zero live API calls).
//
// TF identity: (infoHash, canonical path, exact positive size). Routing
// UUIDs differ per row and must never affect placement eligibility.
// ---------------------------------------------------------------------------

const HASH_HOME = '06bfe49fdc99ad0c6fef1f761382a8181490e456';
const HASH_OTHER = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PATH_HOME = 'Black.Panther.2018/Black.Panther.2018.mkv';
const SIZE_HOME = 34319716114;

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

function throwingTB() {
  const boom = () => { throw new Error('TB must not be called'); };
  return { createPlacement: boom, checkCached: boom, lookupPlacement: boom, getFileInventory: boom };
}

function throwingRD() {
  const boom = () => { throw new Error('RD must not be called'); };
  return { listTorrents: boom, getTorrentInfo: boom, addMagnet: boom, selectFiles: boom };
}

function refsFor(store, tfId) {
  return store.listProviderRefsForTorrentFile(tfId);
}

function rdInfo(status, files) {
  return {
    hash: HASH_HOME, status, original_filename: 'Black.Panther.2018', files,
  };
}

function homeFile(id = 7) {
  return [{ id, path: '/Black.Panther.2018.mkv', bytes: SIZE_HOME, selected: 1 }];
}

// ---- T1: already dual-placed -> already_ready, zero provider calls ----
test('T1 already dual-placed returns already_ready with zero provider calls', async () => {
  const store = createControlPlaneStore();
  const tb = seedPlacement(store, { provider: 'torbox', rid: 'TB1', fileId: '1', hash: HASH_HOME, path: PATH_HOME, size: SIZE_HOME });
  const rdSeed = seedPlacement(store, { provider: 'realdebrid', rid: 'RD1', fileId: '7', hash: HASH_HOME, path: PATH_HOME, size: SIZE_HOME });
  assert.equal(tb.tfId, rdSeed.tfId, 'both placements map the same exact TorrentFile');
  const tfId = tb.tfId;
  const tfBefore = store.getTorrentFile(tfId);

  const ensurer = createSecondPlacementEnsurer({ store, torbox: throwingTB(), realdebrid: throwingRD() });
  const r1 = await ensurer.ensureSecondPlacement({ torrentFileId: tfId });
  assert.equal(r1.status, 'already_ready');
  assert.equal(r1.apiCalls, 0);
  assert.deepEqual(r1.providers, ['realdebrid', 'torbox']);
  assert.deepEqual(store.getTorrentFile(tfId), tfBefore, 'T1: TorrentFile identity untouched');
  assert.equal(refsFor(store, tfId).length, 2);
  assert.ok(store.findPlacementByInfoHash('torbox', HASH_HOME), 'T1: TB placement durable');
  assert.ok(store.findPlacementByInfoHash('realdebrid', HASH_HOME), 'T1: RD placement durable');

  const r2 = await ensurer.ensureSecondPlacement({ torrentFileId: tfId });
  assert.equal(r2.status, 'already_ready');
  assert.equal(r2.apiCalls, 0);
  console.log('T1 ok: already_ready apiCalls=0 refs=2 idempotent');
});

// ---- T2: TB exists, RD missing and uncached -> bounded unavailable ----
test('T2 TorBox uncached returns unavailable with zero creation', async () => {
  const store = createControlPlaneStore();
  // Home TF known via RD only, so the missing side is TorBox.
  const rd = seedPlacement(store, { provider: 'realdebrid', rid: 'RD1', fileId: '7', hash: HASH_HOME, path: PATH_HOME, size: SIZE_HOME });
  const tfId = rd.tfId;
  const calls = { lookup: 0, check: 0, create: 0 };
  const tb = {
    async lookupPlacement() { calls.lookup += 1; return null; },
    async checkCached() { calls.check += 1; return { cached: new Set(), failed: new Set(), details: new Map(), latencyMs: new Map() }; },
    async createPlacement() { calls.create += 1; return { providerResourceId: 'TB77' }; },
  };
  const ensurer = createSecondPlacementEnsurer({ store, torbox: tb, realdebrid: throwingRD() });
  const r = await ensurer.ensureSecondPlacement({ torrentFileId: tfId });
  assert.equal(r.status, 'unavailable');
  assert.equal(r.reason, 'not-cached');
  assert.equal(calls.create, 0, 'T2: no creation attempted');
  assert.equal(store.findPlacementByInfoHash('torbox', HASH_HOME), null, 'T2: zero TB rows');
  assert.equal(refsFor(store, tfId).length, 1, 'T2: RD file row intact, no fake durable placement');
  console.log('T2 ok: unavailable, zero creation, RD intact');
});

// ---- T3: RD exact-file creation writes truth; pending when not ready ----
test('T3 Real-Debrid exact-file path creates truth, pending when not downloaded', async () => {
  const store = createControlPlaneStore();
  const tb = seedPlacement(store, { provider: 'torbox', rid: 'TB1', fileId: '1', hash: HASH_HOME, path: PATH_HOME, size: SIZE_HOME });
  const tfId = tb.tfId;
  const tfBefore = store.getTorrentFile(tfId);

  const calls = { list: 0, info: 0, add: 0, select: 0, magnets: [] };
  const rd = {
    async listTorrents() { calls.list += 1; return []; },
    async getTorrentInfo() {
      calls.info += 1;
      return rdInfo('downloaded', homeFile());
    },
    async addMagnet(magnet) { calls.add += 1; calls.magnets.push(magnet); return { id: 'RD9' }; },
    async selectFiles(id, ids) { calls.select += 1; assert.deepEqual(ids, [7], 'T3: only the exact file selected'); return {}; },
  };
  const ensurer = createSecondPlacementEnsurer({
    store, torbox: throwingTB(), realdebrid: rd, rdPoll: { maxAttempts: 3, delayMs: 0, sleep: async () => {} },
  });

  const r1 = await ensurer.ensureSecondPlacement({ torrentFileId: tfId, preferredProvider: 'realdebrid' });
  assert.equal(r1.status, 'created', JSON.stringify(r1));
  assert.equal(r1.targetProvider, 'realdebrid');
  assert.equal(r1.idSource, 'added');
  assert.ok(calls.magnets[0].includes(HASH_HOME), 'T3: lineage magnet carries the exact infoHash');
  assert.ok(r1.apiCalls <= 5, `T3: bounded api calls, got ${r1.apiCalls}`);
  const rdPl = store.findPlacementByInfoHash('realdebrid', HASH_HOME);
  assert.ok(rdPl, 'T3: RD placement row written');
  assert.equal(rdPl.providerResourceId, 'RD9');
  assert.equal(rdPl.state, 'ready');
  const refs = refsFor(store, tfId);
  assert.equal(refs.length, 2, 'T3: no duplicate file rows');
  const rdRef = refs.find((r) => r.placementId === rdPl.id);
  assert.ok(rdRef && rdRef.mappingState === 'mapped', 'T3: RD file row mapped to home TF');
  assert.equal(rdRef.providerFileId, '7');
  assert.deepEqual(store.getTorrentFile(tfId), tfBefore, 'T3: TorrentFile identity untouched');

  const r2 = await ensurer.ensureSecondPlacement({ torrentFileId: tfId });
  assert.equal(calls.add, 1, 'T3: repeat performs no duplicate addMagnet');
  assert.equal(r2.status, 'already_ready', 'T3: repeat short-circuits on durable state');
  assert.equal(r2.apiCalls, 0);

  // Pending variant: same path, torrent never downloads within the bound.
  const store2 = createControlPlaneStore();
  const tb2 = seedPlacement(store2, { provider: 'torbox', rid: 'TB1', fileId: '1', hash: HASH_HOME, path: PATH_HOME, size: SIZE_HOME });
  const rdSlow = {
    async listTorrents() { return []; },
    async getTorrentInfo() { return rdInfo('downloading', homeFile()); },
    async addMagnet() { return { id: 'RD8' }; },
    async selectFiles() { return {}; },
  };
  const ensurer2 = createSecondPlacementEnsurer({
    store: store2, torbox: throwingTB(), realdebrid: rdSlow,
    rdPoll: { maxAttempts: 2, delayMs: 0, sleep: async () => {} },
  });
  const rp = await ensurer2.ensureSecondPlacement({ torrentFileId: tb2.tfId });
  assert.equal(rp.status, 'pending', JSON.stringify(rp));
  assert.equal(rp.reason, 'not-downloaded-within-bound');
  const anchor = store2.findPlacementByInfoHash('realdebrid', HASH_HOME);
  assert.ok(anchor, 'T3: truthful pending anchor persisted for resume');
  assert.equal(anchor.state, 'pending');
  console.log(`T3 ok: created apiCalls=${r1.apiCalls} idempotent; pending anchored`);
});

// ---- T4: wrong-file / wrong-TF mappings rejected, never persisted ----
test('T4 wrong-file and wrong-TF mappings are rejected without persisting bindings', async () => {
  const store = createControlPlaneStore();
  const home = seedPlacement(store, { provider: 'torbox', rid: 'TB1', fileId: '1', hash: HASH_HOME, path: PATH_HOME, size: SIZE_HOME });
  const homeId = home.tfId;
  const refsBefore = refsFor(store, homeId).length;

  // Wrong file: info hash matches home but no file matches path+size.
  const rdWrongFile = {
    async listTorrents() { return []; },
    async addMagnet() { return { id: 'RD9' }; },
    async getTorrentInfo() {
      return rdInfo('downloaded', [{ id: 3, path: '/Something.Else.mkv', bytes: 111, selected: 1 }]);
    },
    async selectFiles() { throw new Error('must not select a wrong file'); },
  };
  const ensurer = createSecondPlacementEnsurer({
    store, torbox: throwingTB(), realdebrid: rdWrongFile,
    rdPoll: { maxAttempts: 2, delayMs: 0, sleep: async () => {} },
  });
  const r1 = await ensurer.ensureSecondPlacement({ torrentFileId: homeId });
  assert.equal(r1.status, 'failed', JSON.stringify(r1));
  assert.equal(r1.reason, 'no-exact-match');
  assert.equal(refsFor(store, homeId).length, refsBefore, 'T4: no file row bound for home');
  assert.ok(
    !refsFor(store, homeId).some((r) => String(r.path ?? '').includes('Something.Else')),
    'T4: wrong path never persisted against home',
  );

  // Wrong TorrentFile: provider info reports another hash entirely.
  const store2 = createControlPlaneStore();
  const home2 = seedPlacement(store2, { provider: 'torbox', rid: 'TB1', fileId: '1', hash: HASH_HOME, path: PATH_HOME, size: SIZE_HOME });
  const rdWrongHash = {
    async listTorrents() { return []; },
    async addMagnet() { return { id: 'RD9' }; },
    async getTorrentInfo() {
      return {
        hash: HASH_OTHER, status: 'downloaded', original_filename: 'Other',
        files: [{ id: 9, path: '/Other.mkv', bytes: 999, selected: 1 }],
      };
    },
    async selectFiles() { throw new Error('must not select for another hash'); },
  };
  const ensurer2 = createSecondPlacementEnsurer({
    store: store2, torbox: throwingTB(), realdebrid: rdWrongHash,
    rdPoll: { maxAttempts: 2, delayMs: 0, sleep: async () => {} },
  });
  const r2 = await ensurer2.ensureSecondPlacement({ torrentFileId: home2.tfId });
  // Proven semantic: hash-mismatch anchors a truthful pending placement
  // (resume point) but binds zero files — the wrong-TF mapping itself is
  // rejected and never persisted.
  assert.equal(r2.status, 'pending', JSON.stringify(r2));
  assert.equal(r2.reason, 'hash-mismatch');
  assert.equal(refsFor(store2, home2.tfId).length, 1, 'T4: home bindings untouched');
  assert.ok(
    !refsFor(store2, home2.tfId).some((r) => r.providerFileId === '9'),
    'T4: wrong-TF file never bound to home',
  );
  console.log('T4 ok: wrong-file and wrong-TF rejected, bindings never persisted');
});

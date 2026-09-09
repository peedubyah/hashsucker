import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createPrewarmCaller } from '../src/lib/control-plane/prewarm.js';

// ---------------------------------------------------------------------------
// T6 — explicit runtime prewarm caller (deterministic, in-memory DB, fake
// Rust endpoint; zero live HTTP).
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

test('lineage-ok maps to the Rust prewarm contract verbatim', async () => {
  const store = createControlPlaneStore();
  const { tfId, rdPl } = seedDual(store);
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    assert.equal(init.method, 'POST');
    return {
      async json() {
        return {
          status: 'warmed', torrentFileId: tfId,
          tfDurableKey: 'tfkv-unit', provider: 'realdebrid',
          providerResourceId: 'RD1', capId: 'realdebrid-7-0', apiDelta: 1, elapsedMs: 120,
        };
      },
    };
  };
  const caller = createPrewarmCaller({ store, dataPlaneBaseUrl: 'http://dp:3001/', fetchFn });
  const r = await caller.prewarmPlacement({ torrentFileId: tfId, providerPlacementId: rdPl.id });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith(`/files/${tfId}/prewarm`), `URL carries routing tfId, got ${calls[0].url}`);
  assert.deepEqual(calls[0].body, {
    provider: 'realdebrid', providerResourceId: 'RD1', providerFileId: '7', accountScope: 'default',
  });
  assert.equal(r.status, 'warmed');
  assert.equal(r.placementId, rdPl.id);
  assert.equal(r.capId, 'realdebrid-7-0');
  assert.equal(r.apiDelta, 1);
  assert.equal(r.elapsedMs, 120);
  assert.equal(r.tfDurableKey, 'tfkv-unit');
  console.log('T1 ok: lineage validated, contract mapped, placement echoed');
});

test('wrong placement rejected with zero HTTP', async () => {
  const store = createControlPlaneStore();
  const { tfId } = seedDual(store);
  let calls = 0;
  const fetchFn = async () => { calls += 1; throw new Error('must not be called'); };
  const caller = createPrewarmCaller({ store, dataPlaneBaseUrl: 'http://dp:3001', fetchFn });
  // Unknown placement id.
  const r1 = await caller.prewarmPlacement({ torrentFileId: tfId, providerPlacementId: 'pl_nope' });
  assert.equal(r1.status, 'invalid-identity');
  // Unknown TorrentFile.
  const r2 = await caller.prewarmPlacement({ torrentFileId: 'tf_nope', providerPlacementId: 'pl_nope' });
  assert.equal(r2.status, 'unknown-torrent-file');
  // Malformed input (no throw).
  const r3 = await caller.prewarmPlacement({});
  assert.equal(r3.status, 'invalid-input');
  assert.equal(calls, 0, 'zero HTTP on all rejections');
  console.log('T2 ok: rejections without HTTP');
});

test('other-Release placement never satisfies the request', async () => {
  const store = createControlPlaneStore();
  const home = seedDual(store);
  const other = seedPlacement(store, {
    provider: 'realdebrid', rid: 'RDX', fileId: '9',
    hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    path: 'Other/Other.mkv', size: 999,
  });
  let calls = 0;
  const fetchFn = async () => { calls += 1; throw new Error('must not be called'); };
  const caller = createPrewarmCaller({ store, dataPlaneBaseUrl: 'http://dp:3001', fetchFn });
  const r = await caller.prewarmPlacement({ torrentFileId: home.tfId, providerPlacementId: other.placement.id });
  assert.equal(r.status, 'invalid-identity');
  assert.equal(calls, 0);
  console.log('T3 ok: other-Release placement rejected');
});

test('Rust result states map through; transport failure never throws', async () => {
  const store = createControlPlaneStore();
  const { tfId, rdPl } = seedDual(store);
  for (const rustStatus of ['already_warm', 'warmed', 'in_flight', 'unavailable', 'failed', 'invalid']) {
    const caller = createPrewarmCaller({
      store,
      dataPlaneBaseUrl: 'http://dp:3001',
      fetchFn: async () => ({ async json() { return { status: rustStatus, reason: 'r' }; } }),
    });
    const r = await caller.prewarmPlacement({ torrentFileId: tfId, providerPlacementId: rdPl.id });
    assert.equal(r.status, rustStatus);
    assert.equal(r.placementId, rdPl.id);
    // Runtime truth is never rewritten by Node: no placement fields invented.
    assert.equal(r.provider, 'realdebrid');
    assert.equal(r.providerResourceId, 'RD1');
  }
  const down = createPrewarmCaller({
    store,
    dataPlaneBaseUrl: 'http://dp:3001',
    fetchFn: async () => { throw new Error('connection refused'); },
  });
  const r = await down.prewarmPlacement({ torrentFileId: tfId, providerPlacementId: rdPl.id });
  assert.equal(r.status, 'request-failed');
  console.log('T4 ok: result mapping + transport failure contained');
});

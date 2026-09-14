/**
 * Real-Debrid request-time ensure tests (RD-only fulfillment tranche).
 *
 * Pure-ish: in-memory control-plane store + stub RD client (no network).
 * Covers the safe-ensure contract:
 *  - durable placement reuse (zero account writes)
 *  - cached probe binds (add/select/verify/persist, duplicate cleaned never)
 *  - uncached probe cleans up (no leaked RD resource)
 *  - mapping failure cleans up (ambiguous multi-file)
 *  - exception after creation cleans up
 *  - TV requires exact S/E tokens on the mapped path
 *  - memoization within the ensure lifetime
 *
 * Run:
 *   node --test test/rd-ensure.test.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRdEnsure } from '../src/lib/providers/realdebrid/ensure.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

const HASH = 'a'.repeat(40);
const HASH2 = 'b'.repeat(40);

function stubClient(scenario) {
  const calls = [];
  const db = { torrents: new Map(), next: 1, deleted: [] };
  // Seed durable-known torrent for reuse scenarios.
  if (scenario.seeded) {
    for (const t of scenario.seeded) db.torrents.set(t.id, { ...t });
  }
  // Seed account-present (user-added, no placement row) torrents.
  if (scenario.account) {
    for (const t of scenario.account) db.torrents.set(t.id, { ...t });
  }
  return {
    calls,
    db,
    async listTorrents() {
      calls.push('list');
      return [...db.torrents.values()].map((t) => ({ id: t.id, hash: t.hash, status: t.status }));
    },
    async addMagnet(magnet) {
      calls.push('add');
      const m = /btih:([a-f0-9]{40})/i.exec(String(magnet));
      const hash = (m?.[1] || '').toLowerCase();
      const id = `RD${db.next++}`;
      const preset = (scenario.adds || {})[hash];
      if (preset === 'fail') throw Object.assign(new Error('boom'), { code: 'NET' });
      const files = preset?.files ?? (preset === 'uncached' ? [] : null);
      db.torrents.set(id, {
        id, hash, status: preset === 'uncached' ? 'magnet_conversion' : 'waiting_files_selection',
        filename: 'Root', original_filename: 'Root',
        files: files ?? [{ id: 1, path: '/Movie.2024.1080p.mkv', bytes: 1000, selected: 0 }],
      });
      return { id, uri: `https://x/${id}` };
    },
    async getTorrentInfo(id) {
      calls.push('info');
      const t = db.torrents.get(String(id));
      if (!t) throw Object.assign(new Error('gone'), { status: 404 });
      return { ...t, files: t.files.map((f) => ({ ...f })) };
    },
    async selectFiles(id, fileIds) {
      calls.push('select');
      const t = db.torrents.get(String(id));
      const want = new Set((Array.isArray(fileIds) ? fileIds : [fileIds]).map(String));
      for (const f of t.files) f.selected = want.has(String(f.id)) ? 1 : 0;
      // Cached content flips to downloaded on select; uncached stays put.
      if (t.status === 'waiting_files_selection' && t.files.length > 0 && scenario.cached !== false) {
        t.status = 'downloaded';
      }
      return {};
    },
    async deleteTorrent(id) {
      calls.push('delete');
      db.deleted.push(String(id));
      db.torrents.delete(String(id));
      return {};
    },
  };
}

function memStore() {
  return createControlPlaneStore();
}

test('ensure: durable placement reuses with zero account writes', async () => {
  const store = memStore();
  const placement = store.recordPlacement({
    infoHash: HASH, provider: 'realdebrid', accountScope: 'default',
    providerResourceId: 'RD9', state: 'ready', provenance: 'test',
  });
  const client = stubClient({ seeded: [{ id: 'RD9', hash: HASH, status: 'downloaded', filename: 'Root', original_filename: 'Root', files: [{ id: 7, path: '/Movie.2024.1080p.mkv', bytes: 4242, selected: 1 }] }] });
  const { ensure } = createRdEnsure({ store, client });
  // Pre-create the TorrentFile row the durable path should find.
  store.replaceProviderFileInventory(placement.id, [
    { providerFileId: '7', path: 'Root/Movie.2024.1080p.mkv', name: 'Movie.2024.1080p.mkv', size: 4242, selected: true },
  ]);
  const r = await ensure({ infoHash: HASH, filename: 'Movie.2024.1080p.mkv', size: 4242 });
  assert.equal(r.status, 'ready');
  assert.equal(r.source, 'durable');
  assert.ok(r.torrentFileId, 'existing TorrentFile reused');
  assert.ok(!client.calls.includes('add'), 'no account writes on durable path');
  assert.ok(!client.calls.includes('delete'), 'no cleanup of foreign resources');
});

test('ensure: cached probe binds and persists truth', async () => {
  const store = memStore();
  const client = stubClient({});
  const { ensure } = createRdEnsure({ store, client });
  const r = await ensure({ infoHash: HASH, filename: 'Movie.2024.1080p.mkv', size: 1000 });
  assert.equal(r.status, 'ready');
  assert.equal(r.source, 'probe');
  assert.ok(r.torrentFileId);
  assert.ok(r.placementId);
  assert.equal(r.size, 1000);
  assert.ok(!client.db.deleted.length, 'bound resources are kept, never cleaned');
  // Placement + inventory + TorrentFile durable.
  const pl = store.findPlacementByInfoHash('realdebrid', HASH);
  assert.ok(pl, 'placement persisted');
  assert.equal(pl.providerResourceId, client.db.torrents.keys().next().value ?? pl.providerResourceId);
  const tf = store.findTorrentFile(HASH, 'Root/Movie.2024.1080p.mkv');
  assert.ok(tf, 'TorrentFile row persisted');
});

test('ensure: uncached probe cleans up (no leak)', async () => {
  const store = memStore();
  const client = stubClient({ adds: { [HASH]: 'uncached' } });
  const { ensure } = createRdEnsure({ store, client });
  const r = await ensure({ infoHash: HASH, filename: 'Movie.2024.1080p.mkv' });
  assert.equal(r.status, 'not-cached');
  assert.equal(r.cleaned, true);
  assert.equal(client.db.torrents.size, 0, 'probe resource deleted');
  assert.equal(store.findPlacementByInfoHash('realdebrid', HASH), null, 'no durable placement for uncached');
});

test('ensure: ambiguous multi-file mapping cleans up', async () => {
  const store = memStore();
  const client = stubClient({
    adds: {
      [HASH]: {
        files: [
          { id: 1, path: '/a.mkv', bytes: 100 },
          { id: 2, path: '/b.mkv', bytes: 200 },
        ],
      },
    },
  });
  const { ensure } = createRdEnsure({ store, client });
  const r = await ensure({ infoHash: HASH, filename: 'Something.Else.2024.mkv' });
  assert.equal(r.status, 'not-cached');
  assert.match(r.reason, /mapping-failed/);
  assert.equal(client.db.torrents.size, 0, 'ambiguous probe cleaned');
});

test('ensure: exception after creation still cleans up', async () => {
  const store = memStore();
  const base = stubClient({});
  const origInfo = base.getTorrentInfo.bind(base);
  let n = 0;
  base.getTorrentInfo = async (id, opts) => {
    n++;
    if (n === 2) throw new Error('mid-flight explosion');
    return origInfo(id, opts);
  };
  const { ensure } = createRdEnsure({ store, client: base });
  const r = await ensure({ infoHash: HASH, filename: 'Movie.2024.1080p.mkv' });
  assert.equal(r.status, 'transient');
  assert.equal(r.cleaned, true);
  assert.equal(base.db.torrents.size, 0, 'no leak on exception');
});

test('ensure: TV requires exact S/E tokens on the mapped path', async () => {
  const store = memStore();
  const client = stubClient({
    adds: {
      [HASH2]: {
        files: [{ id: 1, path: '/Show.S02E05.1080p.mkv', bytes: 500, selected: 0 }],
      },
    },
  });
  const { ensure } = createRdEnsure({ store, client });
  // Wrong episode for S01E02 query: size-only match must not bind.
  const r = await ensure({ infoHash: HASH2, filename: 'Show.S01E02.1080p.mkv', size: 500, season: 1, episode: 2 });
  assert.equal(r.status, 'not-cached');
  assert.match(r.reason, /episode-unverifiable/);
  assert.equal(client.db.torrents.size, 0, 'unverifiable TV probe cleaned');
});

test('ensure: TV binds when mapped path carries exact S/E', async () => {
  const store = memStore();
  const client = stubClient({
    adds: {
      [HASH2]: {
        files: [{ id: 1, path: '/Show.S01E02.1080p.mkv', bytes: 500, selected: 0 }],
      },
    },
  });
  const { ensure } = createRdEnsure({ store, client });
  const r = await ensure({ infoHash: HASH2, filename: 'Show.S01E02.1080p.mkv', size: 500, season: 1, episode: 2 });
  assert.equal(r.status, 'ready');
  assert.ok(r.torrentFileId);
});

test('ensure: memoizes terminal answers within the lifetime', async () => {
  const store = memStore();
  const client = stubClient({ adds: { [HASH]: 'uncached' } });
  const { ensure } = createRdEnsure({ store, client });
  const r1 = await ensure({ infoHash: HASH });
  const calls1 = client.calls.length;
  const r2 = await ensure({ infoHash: HASH });
  assert.equal(r2.status, 'not-cached');
  assert.equal(client.calls.length, calls1, 'second call served from memo');
});

test('ensure: account-present content binds without creating duplicates', async () => {
  const store = memStore();
  const client = stubClient({
    account: [{
      id: 'RDUSER1', hash: HASH, status: 'downloaded', filename: 'Root', original_filename: 'Root',
      files: [{ id: 1, path: '/Movie.2024.1080p.mkv', bytes: 4242, selected: 0 }],
    }],
  });
  const { ensure } = createRdEnsure({ store, client });
  const r = await ensure({ infoHash: HASH, filename: 'Movie.2024.1080p.mkv', size: 4242 });
  assert.equal(r.status, 'ready');
  assert.equal(r.source, 'durable', 'account discovery counts as durable (no probe resource)');
  assert.ok(r.torrentFileId);
  assert.ok(!client.calls.includes('add'), 'no duplicate resource created for account content');
  assert.ok(!client.calls.includes('delete'), 'foreign resources never cleaned');
});

test('ensure: infringing re-add fails hard without leaking', async () => {
  const store = memStore();
  const client = stubClient({});
  const origAdd = client.addMagnet.bind(client);
  client.addMagnet = async () => { throw new Error('infringing_file'); };
  const { ensure } = createRdEnsure({ store, client });
  const r = await ensure({ infoHash: HASH, filename: 'Movie.2024.1080p.mkv' });
  assert.equal(r.status, 'hard', 'infringing never retries');
});

test('selection PATH C binds via RD ensure when TorBox seam absent', async () => {
  const { selectBindableCandidate } = await import('../src/lib/discovery/selection.js');
  const calls = [];
  const rdEnsure = async ({ infoHash }) => {
    calls.push(infoHash);
    if (infoHash === HASH) return { status: 'ready', torrentFileId: 'tf_rd1', placementId: 'pl1', providerFileId: '9', size: 100, source: 'probe' };
    return { status: 'not-cached', reason: 'rd-no-files' };
  };
  const rows = [
    { infoHash: 'c'.repeat(40), fileIndex: 0, filename: 'Other.mkv', rank: 1, score: 0.9, identity: { tier: 'Probable', eligible: true }, availability: { torbox: { state: 'unknown' } }, release: {}, sources: [] },
    { infoHash: HASH, fileIndex: 0, filename: 'Movie.2024.1080p.mkv', rank: 2, score: 0.5, identity: { tier: 'Probable', eligible: true }, availability: { torbox: { state: 'unknown' } }, release: {}, sources: [] },
  ];
  const sel = await selectBindableCandidate(rows, {
    ensureTorBoxFileIdentityFn: null,
    ensureRealDebridFileIdentityFn: rdEnsure,
  });
  assert.ok(sel.selected, 'RD binds in rank order without TorBox');
  assert.equal(sel.selected.infoHash, HASH, 'rank 1 fails clean, rank 2 binds');
  assert.equal(sel.selected._torrentFileId, 'tf_rd1');
  assert.deepEqual(calls, ['c'.repeat(40), HASH], 'rank order preserved');
});

test('selection PATH C skipped entirely without RD seam (legacy behavior)', async () => {
  const { selectBindableCandidate } = await import('../src/lib/discovery/selection.js');
  const rows = [
    { infoHash: HASH, fileIndex: 0, filename: 'Movie.2024.1080p.mkv', rank: 1, score: 0.5, identity: { tier: 'Probable', eligible: true }, availability: { torbox: { state: 'unknown' } }, release: {}, sources: [] },
  ];
  const sel = await selectBindableCandidate(rows, { ensureTorBoxFileIdentityFn: null });
  assert.equal(sel.selected, null);
  assert.equal(sel.reason, 'no-bindable-candidate');
});

/**
 * RD placement realizer — bounded account reads.
 *
 * The Real-Debrid account list is the ONLY hash index the provider
 * offers, so a miss costs a full account download. The realizer is kicked
 * from every materialization — including the READ path (the WebDAV
 * catalog sweep converges every handoff) — so an unremembered miss means
 * the account is re-downloaded about once per sweep, forever, for every
 * release that is not in the RD account.
 *
 * These tests pin that a known-absent hash is remembered for a bounded
 * window and that a hash that later becomes present is still realized.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { createRdPlacementRealizer } from '../src/lib/control-plane/rd-placement-realizer.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f9011223344';

function storeStub() {
  return {
    findPlacementByInfoHash: () => null,
    listDataPlaneCoordinates: () => [],
    recordPlacement: () => { throw new Error('must not record a placement'); },
    replaceProviderFileInventory: () => { throw new Error('must not write inventory'); },
  };
}

test('a hash the RD account does not hold is remembered instead of re-downloading the account', async () => {
  const previous = process.env.RD_REALIZE_ABSENT_MEMORY_MS;
  process.env.RD_REALIZE_ABSENT_MEMORY_MS = '60000';
  try {
    let listCalls = 0;
    const client = {
      async listTorrents() { listCalls += 1; return []; },
      async getTorrentInfo() { throw new Error('not expected'); },
    };
    const realizer = createRdPlacementRealizer({
      store: storeStub(), client, now: () => 1_000, logger: () => {},
    });
    const torrentFile = { id: 'tf-1', infoHash: HASH, internalPath: 'Movie/movie.mkv', size: 1000 };

    const first = await realizer.ensureRealization(torrentFile);
    assert.equal(first.status, 'absent');
    assert.equal(first.apiCalls, 1);

    for (let i = 0; i < 5; i += 1) {
      const again = await realizer.ensureRealization(torrentFile);
      assert.equal(again.apiCalls, 0, 'a remembered absence must not call the provider');
    }
    assert.equal(listCalls, 1, 'the RD account must be listed once, not once per materialization');
  } finally {
    if (previous === undefined) delete process.env.RD_REALIZE_ABSENT_MEMORY_MS;
    else process.env.RD_REALIZE_ABSENT_MEMORY_MS = previous;
  }
});

test('one catalog pass over many releases downloads the RD account once', async () => {
  const previousMemory = process.env.RD_REALIZE_ABSENT_MEMORY_MS;
  const previousSnapshot = process.env.RD_REALIZE_SNAPSHOT_MS;
  process.env.RD_REALIZE_ABSENT_MEMORY_MS = '0';
  process.env.RD_REALIZE_SNAPSHOT_MS = '60000';
  try {
    let listCalls = 0;
    const client = {
      async listTorrents() { listCalls += 1; return []; },
      async getTorrentInfo() { throw new Error('not expected'); },
    };
    const realizer = createRdPlacementRealizer({
      store: storeStub(), client, now: () => 1_000, logger: () => {},
    });
    // The catalog sweep materializes every handoff in one pass. Each
    // release is a different hash, so per-hash memory cannot help the
    // first pass — the shared account snapshot must.
    for (let i = 0; i < 25; i += 1) {
      const hash = ('0'.repeat(36) + i.toString(16).padStart(4, '0'));
      await realizer.ensureRealization({
        id: `tf-${i}`, infoHash: hash, internalPath: `Movie/movie-${i}.mkv`, size: 1000,
      });
    }
    assert.equal(listCalls, 1, 'one catalog pass must download the RD account once');
  } finally {
    if (previousMemory === undefined) delete process.env.RD_REALIZE_ABSENT_MEMORY_MS;
    else process.env.RD_REALIZE_ABSENT_MEMORY_MS = previousMemory;
    if (previousSnapshot === undefined) delete process.env.RD_REALIZE_SNAPSHOT_MS;
    else process.env.RD_REALIZE_SNAPSHOT_MS = previousSnapshot;
  }
});

test('a remembered absence expires, so a release that later appears is still realized', async () => {
  const previous = process.env.RD_REALIZE_ABSENT_MEMORY_MS;
  const previousSnapshot = process.env.RD_REALIZE_SNAPSHOT_MS;
  process.env.RD_REALIZE_ABSENT_MEMORY_MS = '0';
  process.env.RD_REALIZE_SNAPSHOT_MS = '0';
  try {
    let listCalls = 0;
    const client = {
      async listTorrents() {
        listCalls += 1;
        return listCalls === 1 ? [] : [{ id: 'rd-1', hash: HASH }];
      },
      async getTorrentInfo() { throw new Error('not expected'); },
    };
    const realizer = createRdPlacementRealizer({
      store: storeStub(), client, now: () => 1_000, logger: () => {},
    });
    const torrentFile = { id: 'tf-2', infoHash: HASH, internalPath: 'Movie/movie.mkv', size: 1000 };

    const first = await realizer.ensureRealization(torrentFile);
    assert.equal(first.status, 'absent');
    const second = await realizer.ensureRealization(torrentFile);
    assert.equal(listCalls, 2, 'with no memory the provider is consulted again');
    assert.notEqual(second.status, 'absent');
  } finally {
    if (previous === undefined) delete process.env.RD_REALIZE_ABSENT_MEMORY_MS;
    else process.env.RD_REALIZE_ABSENT_MEMORY_MS = previous;
  }
});

test('the RD realizer never writes a placement for a hash the account does not hold', async () => {
  const store = createControlPlaneStore();
  let listCalls = 0;
  const client = {
    async listTorrents() { listCalls += 1; return []; },
    async getTorrentInfo() { throw new Error('not expected'); },
  };
  const realizer = createRdPlacementRealizer({ store, client, now: () => 1_000, logger: () => {} });
  const result = await realizer.ensureRealization({
    id: 'tf-3', infoHash: HASH, internalPath: 'Movie/movie.mkv', size: 1000,
  });
  assert.equal(result.status, 'absent');
  assert.equal(result.apiCalls, 1);
  const placements = store.listPlacements?.() ?? [];
  assert.equal(placements.filter((p) => p.infoHash === HASH).length, 0,
    'an absent RD torrent must not create a durable placement');
  assert.equal(listCalls, 1);
  store.close();
});

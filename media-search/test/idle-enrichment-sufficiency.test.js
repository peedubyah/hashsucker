import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createDownloadStore } from '../src/lib/download/store.js';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';
import { createIdleEnrichment } from '../src/lib/discovery/idle-enrichment.js';

function stores() {
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const cps = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  const dl = createDownloadStore({ db: cps.db });
  const intents = createFutureIntentStore({ db: cache.db });
  return { cache, cps, dl, intents };
}
function worker(s, discoverFn) {
  return createIdleEnrichment({
    cache: s.cache,
    controlPlaneStore: s.cps,
    downloadStore: s.dl,
    futureIntentStore: s.intents,
    discoverFn,
    measureLag: async () => 1,
    now: () => 1_000_000,
    env: {},
  });
}
function seedAssociations(cache, mediaId, count) {
  for (let i = 0; i < count; i++) {
    const hash = `${mediaId.replace(/[^a-z0-9]/gi, '').slice(0, 8)}${String(i).padStart(2, '0')}`.repeat(5).slice(0, 40);
    cache.ingestCandidate({ infoHash: hash, fileIndex: null, title: mediaId });
    cache.associateMedia(hash, null, mediaId, { source: 'test' });
  }
}

test('deep recent human demand does not trigger background discovery', async () => {
  const s = stores();
  seedAssociations(s.cache, 'tt-deep-request', 8);
  s.cache.db.prepare(`INSERT INTO media_requests
    (media_id, media_type, source, status, candidate_count, created_at)
    VALUES ('tt-deep-request', 'movie', 'seerr', 'completed', 8, 999999)`).run();
  let calls = 0;
  const w = worker(s, async () => { calls++; return { releases: [], sources: {} }; });
  const result = await w.tickOnce();
  assert.equal(result.acted, false);
  assert.equal(calls, 0);
  assert.ok(['sufficient-diversity', 'not-quiet'].includes(result.reason));
});

test('zero-depth future episode remains eligible', async () => {
  const s = stores();
  s.intents.seed({ mediaType: 'episode', mediaId: 'tt-zero-episode', season: 2, episode: 3 });
  let calls = 0;
  const w = worker(s, async () => { calls++; return { releases: [], sources: {} }; });
  const result = await w.tickOnce();
  assert.equal(result.acted, true);
  assert.equal(calls, 1);
});

test('published fragile representation remains eligible', async () => {
  const s = stores();
  s.cps.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt-fragile', title: 'Fragile', desiredState: 'present' });
  seedAssociations(s.cache, 'tt-fragile', 2);
  let calls = 0;
  const w = worker(s, async () => { calls++; return { releases: [], sources: {} }; });
  const result = await w.tickOnce();
  assert.equal(result.acted, true);
  assert.equal(calls, 1);
});

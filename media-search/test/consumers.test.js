/**
 * Consumer reconciliation + retirement eligibility tests.
 *
 * Covers the fail-closed policy core without network: present / absent /
 * unknown / stale / grace boundary / reappearance / episode isolation /
 * default-disabled, Jellyfin + Plex normalization with stub fetch, and an
 * end-to-end reconcile→(OFF executor) pass plus an enabled-executor
 * retirement against in-memory stores.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { evaluateRetirement, readRetirementPolicy } from '../src/lib/consumers/eligibility.js';
import { runReconcile } from '../src/lib/consumers/reconcile.js';
import { listJellyfinLibrary } from '../src/lib/consumers/jellyfin.js';
import { listPlexLibrary } from '../src/lib/consumers/plex.js';

const NOW = 1_800_000_000_000;
const GRACE = 7 * 24 * 60 * 60 * 1000;

function policy(overrides = {}) {
  return {
    enabled: true,
    requiredConsumers: ['jellyfin'],
    absenceGraceMs: GRACE,
    observationMaxAgeMs: 60 * 60 * 1000,
    ...overrides,
  };
}

function item(overrides = {}) {
  return {
    mediaId: 'tt1', season: null, episode: null, state: 'published', ...overrides,
  };
}

function obs(consumer, present, { ageMs = 0, seenMs = null, firstMs = GRACE + 1000 } = {}) {
  return {
    consumer,
    mediaId: 'tt1',
    season: null,
    episode: null,
    present,
    lastCheckedAt: NOW - ageMs,
    firstCheckedAt: NOW - firstMs,
    lastSeenPresentAt: seenMs == null ? null : NOW - seenMs,
  };
}

test('eligibility: default policy is disabled', () => {
  const p = readRetirementPolicy({});
  assert.equal(p.enabled, false);
  assert.deepEqual(p.requiredConsumers, ['jellyfin']);
  const r = evaluateRetirement(item(), [], p, NOW);
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'POLICY_DISABLED');
});

test('eligibility: present is never eligible', () => {
  const r = evaluateRetirement(item(), [obs('jellyfin', 1)], policy(), NOW);
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'PRESENT_IN_JELLYFIN');
});

test('eligibility: first absence is not eligible (single scan never retires)', () => {
  const r = evaluateRetirement(
    item(), [obs('jellyfin', 0, { firstMs: 1000 })], policy(), NOW,
  );
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'INSUFFICIENT_HISTORY');
});

test('eligibility: sustained absence past grace is eligible', () => {
  const r = evaluateRetirement(
    item(), [obs('jellyfin', 0, { seenMs: GRACE + 5000 })], policy(), NOW,
  );
  assert.equal(r.eligible, true);
  assert.equal(r.reason, 'ELIGIBLE');
  assert.ok(r.absenceAgeMs >= GRACE);
});

test('eligibility: unknown and stale fail closed', () => {
  const unk = evaluateRetirement(item(), [obs('jellyfin', null)], policy(), NOW);
  assert.equal(unk.eligible, false);
  assert.equal(unk.reason, 'CONSUMER_UNKNOWN');
  const stale = evaluateRetirement(
    item(), [obs('jellyfin', 0, { ageMs: 2 * 60 * 60 * 1000, seenMs: GRACE + 1 })],
    policy(), NOW,
  );
  assert.equal(stale.eligible, false);
  assert.equal(stale.reason, 'OBSERVATION_STALE');
  const missing = evaluateRetirement(item(), [], policy(), NOW);
  assert.equal(missing.reason, 'NO_OBSERVATION');
});

test('eligibility: reappearance resets immediately', () => {
  // Was absent for ages, but the latest check sees it present.
  const r = evaluateRetirement(
    item(), [{ ...obs('jellyfin', 1, { seenMs: 0 }), firstCheckedAt: NOW - GRACE - 1 }],
    policy(), NOW,
  );
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'PRESENT_IN_JELLYFIN');
});

test('eligibility: one present consumer blocks retirement', () => {
  const rows = [
    obs('jellyfin', 0, { seenMs: GRACE + 10 }),
    { ...obs('plex', 1), mediaId: 'tt1' },
  ];
  const r = evaluateRetirement(
    item(), rows, policy({ requiredConsumers: ['jellyfin', 'plex'] }), NOW,
  );
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'PRESENT_IN_PLEX');
});

test('eligibility: observations do not cross episode boundaries', () => {
  const ep2 = item({ season: 1, episode: 2 });
  const ep1obs = {
    consumer: 'jellyfin', mediaId: 'tt1', season: 1, episode: 1, present: 0,
    lastCheckedAt: NOW, firstCheckedAt: NOW - GRACE - 1, lastSeenPresentAt: null,
  };
  const r = evaluateRetirement(ep2, [ep1obs], policy(), NOW);
  assert.equal(r.eligible, false);
  assert.equal(r.reason, 'NO_OBSERVATION');
});

test('eligibility: unpublished items are never eligible', () => {
  const r = evaluateRetirement(
    item({ state: 'absent' }),
    [obs('jellyfin', 0, { seenMs: GRACE + 1 })], policy(), NOW,
  );
  assert.equal(r.reason, 'NOT_PUBLISHED');
});

// ---- adapter normalization (stub fetch) ----

test('jellyfin: movies map by IMDb, episodes join series, unmappable skipped', async () => {
  const payloads = {
    Movie: { Items: [{ Id: 'm1', Type: 'Movie', Name: 'M', ProviderIds: { Imdb: 'tt10' } }] },
    Series: { Items: [{ Id: 's1', Type: 'Series', Name: 'S', ProviderIds: { Imdb: 'tt20' } }] },
    Episode: {
      Items: [
        { Id: 'e1', SeriesId: 's1', ParentIndexNumber: 2, IndexNumber: 3 },
        { Id: 'e2', SeriesId: 'nope', ParentIndexNumber: 1, IndexNumber: 1 },
      ],
    },
  };
  const savedUrl = process.env.JELLYFIN_URL;
  const savedKey = process.env.JELLYFIN_API_KEY;
  const savedFetch = globalThis.fetch;
  process.env.JELLYFIN_URL = 'http://jf.test';
  process.env.JELLYFIN_API_KEY = 'k';
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    const kind = u.searchParams.get('IncludeItemTypes');
    const body = payloads[kind] ?? { Items: [] };
    return { ok: true, status: 200, json: async () => body };
  };
  try {
    const rows = await listJellyfinLibrary();
    assert.deepEqual(rows, [
      { mediaId: 'tt10', season: null, episode: null, consumerItemId: 'm1' },
      { mediaId: 'tt20', season: 2, episode: 3, consumerItemId: 'e1' },
    ]);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.JELLYFIN_URL;
    else process.env.JELLYFIN_URL = savedUrl;
    if (savedKey === undefined) delete process.env.JELLYFIN_API_KEY;
    else process.env.JELLYFIN_API_KEY = savedKey;
  }
});

test('plex: movies map by guid, episodes need grandparent series IMDb', async () => {
  const sections = {
    MediaContainer: {
      Directory: [
        { key: '1', type: 'movie' },
        { key: '2', type: 'show' },
      ],
    },
  };
  const movies = {
    MediaContainer: {
      Metadata: [
        { ratingKey: 11, guid: 'plex://movie/x', Guid: [{ id: 'com.plexapp.agents.imdb://tt30?lang=en' }] },
        { ratingKey: 12, guid: 'plex://movie/y', Guid: [{ id: 'com.plexapp.agents.tmdb://123' }] },
      ],
    },
  };
  const episodes = {
    MediaContainer: {
      Metadata: [
        {
          ratingKey: 21, parentIndex: 1, index: 2,
          Guid: [{ id: 'com.plexapp.agents.imdb://tt999?lang=en' }],
          grandparentGuid: 'com.plexapp.agents.imdb://tt31?lang=en',
        },
        {
          ratingKey: 22, parentIndex: 1, index: 3,
          Guid: [{ id: 'com.plexapp.agents.imdb://tt998?lang=en' }],
        },
      ],
    },
  };
  const savedUrl = process.env.PLEX_URL;
  const savedToken = process.env.PLEX_TOKEN;
  const savedFetch = globalThis.fetch;
  process.env.PLEX_URL = 'http://plex.test';
  process.env.PLEX_TOKEN = 't';
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.pathname === '/library/sections') {
      return { ok: true, status: 200, json: async () => sections };
    }
    if (u.pathname === '/library/sections/1/all') {
      return { ok: true, status: 200, json: async () => movies };
    }
    if (u.pathname === '/library/sections/2/all') {
      return { ok: true, status: 200, json: async () => episodes };
    }
    throw new Error(`unexpected fetch ${u}`);
  };
  try {
    const rows = await listPlexLibrary();
    assert.deepEqual(rows, [
      { mediaId: 'tt30', season: null, episode: null, consumerItemId: '11' },
      { mediaId: 'tt31', season: 1, episode: 2, consumerItemId: '21' },
    ]);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedUrl === undefined) delete process.env.PLEX_URL;
    else process.env.PLEX_URL = savedUrl;
    if (savedToken === undefined) delete process.env.PLEX_TOKEN;
    else process.env.PLEX_TOKEN = savedToken;
  }
});

// ---- reconcile pass (stub adapters, real stores) ----

const RHASH = 'aabbccddeeff00112233445566778899aabbccdd';

function seedPublishedMovie(store, cache, mediaId, tfId) {
  const item = store.ensureLibraryItem({
    mediaType: 'movie', mediaId, title: 'Rec Movie', year: 2024, desiredState: 'present',
  });
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'primary', infoHash: RHASH,
    providerResourceId: `res-${mediaId}`, state: 'ready', ownership: 'owned',
    ownerKey: item.id, provenance: 'test',
    idempotencyKey: `placement:torbox:${RHASH}:${mediaId}`,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: 'pf-1', path: `/${mediaId}.mkv`, name: `${mediaId}.mkv`, size: 500,
  }], { authoritative: true, complete: true, observedAt: 0, expiresAt: 9_999_999_999_999 });
  store.db.prepare(
    `INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(tfId, RHASH, `/${mediaId}.mkv`, 500, 1);
  store.db.prepare(
    `UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped'
     WHERE placement_id = ? AND provider_file_id = 'pf-1'`,
  ).run(tfId, placement.id);
  const requestId = cache.persistMediaRequest(
    { mediaId, mediaType: 'movie', season: null, episode: null }, [],
  );
  cache.persistPlaybackHandoff({
    requestId, mediaId, mediaType: 'movie', season: null, episode: null,
    releaseKey: `${RHASH}:torrent`, infoHash: RHASH, fileIndex: null,
    filename: `${mediaId}.mkv`, provider: 'torbox', providerState: 'cached',
    identityTier: 'ProviderConfirmed', resolutionState: 'resolved',
    selectionReason: 'r', selectedAt: 1, torrentFileId: tfId,
  });
  cache.createVfsMovieEntry({
    mediaId, releaseKey: `${RHASH}:torrent`, infoHash: RHASH, fileIndex: null,
    canonicalPath: `Movies/${mediaId}/${mediaId}.mkv`,
    torrentFileId: tfId, size: 500, createdAt: 1, updatedAt: 1,
  });
}

function stubAdapter(name, rowsOrThrow) {
  return {
    name,
    listLibrary: async () => {
      if (rowsOrThrow instanceof Error) throw rowsOrThrow;
      return rowsOrThrow;
    },
  };
}

test('reconcile: present stays, unknown fails closed, executor OFF retires nothing', async () => {
  const cache = createDiscoveryCache();
  const store = createControlPlaneStore();
  seedPublishedMovie(store, cache, 'tt_rec_1', 'tf_rec_1');
  seedPublishedMovie(store, cache, 'tt_rec_2', 'tf_rec_2');

  const adapters = [
    stubAdapter('jellyfin', [{ mediaId: 'tt_rec_1', season: null, episode: null, consumerItemId: 'j1' }]),
    stubAdapter('plex', new Error('plex-http-401')),
  ];
  const summary = await runReconcile({
    cache,
    controlPlaneStore: store,
    adapters,
    policy: policy({ enabled: true }),
    execute: false,
    now: NOW,
  });
  assert.equal(summary.published, 2);
  assert.deepEqual(summary.consumers, ['jellyfin', 'plex']);
  assert.equal(summary.retired, 0);
  const byId = Object.fromEntries(summary.outcomes.map((o) => [o.mediaId, o]));
  assert.equal(byId.tt_rec_1.reason, 'PRESENT_IN_JELLYFIN');
  // Fresh absence never retires on a single scan.
  assert.equal(byId.tt_rec_2.reason, 'INSUFFICIENT_HISTORY');
  // Observations durable with the right shape.
  const rows = store.listConsumerObservations({ mediaId: 'tt_rec_1' });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.consumer === 'jellyfin').present, 1);
  assert.equal(rows.find((r) => r.consumer === 'plex').present, null);
  // With plex required, UNKNOWN fails closed at evaluation time.
  const unk = evaluateRetirement(
    { mediaId: 'tt_rec_1', season: null, episode: null, state: 'published' },
    rows, policy({ enabled: true, requiredConsumers: ['plex'] }), NOW,
  );
  assert.equal(unk.reason, 'CONSUMER_UNKNOWN');
  // Nothing unpublished: VFS rows intact.
  assert.ok(cache.getVfsMovieEntry('tt_rec_1'));
  assert.ok(cache.getVfsMovieEntry('tt_rec_2'));
  cache.close();
  store.close();
});

test('reconcile: enabled executor retires only sustained-absent items', async () => {
  const cache = createDiscoveryCache();
  const store = createControlPlaneStore();
  seedPublishedMovie(store, cache, 'tt_ret_1', 'tf_ret_1');
  // Pre-seed an old absent observation (watched long ago, never seen).
  store.recordConsumerObservation({
    consumer: 'jellyfin', mediaType: 'movie', mediaId: 'tt_ret_1',
    season: null, episode: null, present: 0, source: 'test',
    now: NOW - GRACE - 1000,
  });
  const adapters = [stubAdapter('jellyfin', [])];
  const summary = await runReconcile({
    cache,
    controlPlaneStore: store,
    adapters,
    policy: policy({ enabled: true }),
    now: NOW,
  });
  assert.equal(summary.eligible, 1);
  assert.equal(summary.retired, 1);
  const [outcome] = summary.outcomes;
  assert.equal(outcome.reason, 'ELIGIBLE');
  assert.equal(outcome.retired, true);
  // Presentation gone, durable truth kept.
  assert.equal(cache.getVfsMovieEntry('tt_ret_1'), null);
  assert.equal(
    store.getLibraryItemByIdentityKey('movie:tt_ret_1:default').desiredState, 'absent',
  );
  assert.equal(
    cache.db.prepare('SELECT COUNT(*) AS n FROM playback_handoffs WHERE media_id = ?')
      .get('tt_ret_1').n, 1,
  );
  cache.close();
  store.close();
});

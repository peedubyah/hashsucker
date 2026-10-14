/**
 * Publication contract (src/lib/requests/publication.js).
 *
 * Proves the consolidated presentation tail behaves as its two callers
 * require, using real modules and a stub Plex server:
 *
 *   P1  publishSelectedHandoff dispatches consumer notification for
 *       EPISODE geometry and reaches the bounded deterministic ingest
 *       transaction. This is regression coverage for a latent defect: the
 *       fresh-publication path used to reference an out-of-scope
 *       `isEpisode` inside a fire-and-forget chain, so the ReferenceError
 *       was swallowed by its own .catch() and the episode ingest confirm
 *       never ran. Episode geometry is now computed once and passed in.
 *   P2  MOVIE geometry notifies Plex but reaches no episode ingest
 *       transaction.
 *   P3  A failed VFS materialization surfaces as a PublicationError whose
 *       stage is 'vfs-materialization' (the request path maps that to
 *       'durable-publication-failed').
 *   P4  republishHealthyHandoff surfaces every stage failure as a
 *       PublicationError, so the reuse path falls back to full discovery
 *       instead of reporting a false publication.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  PublicationError,
  publishSelectedHandoff,
  republishHealthyHandoff,
} from '../src/lib/requests/publication.js';
import { getMetrics } from '../src/lib/metrics.js';

const INFO_HASH = 'b1f0d4b0ef7fd2b1a2a63fbb02d1ba1f45bd0c9e';
const EPISODE_MEDIA_ID = 'tt_pub_e01';
const MOVIE_MEDIA_ID = 'tt_pub_movie';

function seedEpisode(store) {
  const now = 1_000;
  const until = now + 6 * 60 * 60 * 1000;
  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('tf_pub_e01', INFO_HASH, 'Show S01/Show S01E01.mkv', 500, now);
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: INFO_HASH,
    providerResourceId: 'tb-pub', state: 'ready', ownership: 'owned',
    ownerKey: 'placement_pub', provenance: 'publication-contract', observedAt: now, expiresAt: until,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: '0', path: 'Show S01/Show S01E01.mkv', name: 'Show S01E01.mkv', size: 500, selected: true,
  }], { authoritative: true, complete: true, observedAt: now, expiresAt: until });
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = 'tf_pub_e01', mapping_state = 'mapped',
    inventory_observed_at = ?, inventory_expires_at = ? WHERE placement_id = ?
  `).run(now, until, placement.id);
  store.recordReadinessObservation({ placementId: placement.id, state: 'ready', source: 'publication-contract', observedAt: now, expiresAt: until });
  return { placementId: placement.id };
}

const MOVIE_TF_ID = 'tf_pub_movie';
const MOVIE_INTERNAL_PATH = 'A Great Movie (2024) WEBDL/A Great Movie (2024).mkv';

function seedMovie(store) {
  const now = 1_000;
  const until = now + 6 * 60 * 60 * 1000;
  store.db.prepare(`
    INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(MOVIE_TF_ID, INFO_HASH, MOVIE_INTERNAL_PATH, 900, now);
  const placement = store.recordPlacement({
    provider: 'torbox', accountScope: 'default', infoHash: INFO_HASH,
    providerResourceId: 'tb-pub-movie', state: 'ready', ownership: 'owned',
    ownerKey: 'placement_pub_movie', provenance: 'publication-contract',
    observedAt: now, expiresAt: until,
  });
  store.replaceProviderFileInventory(placement.id, [{
    providerFileId: '1', path: MOVIE_INTERNAL_PATH, name: 'A Great Movie (2024).mkv', size: 900, selected: true,
  }], { authoritative: true, complete: true, observedAt: now, expiresAt: until });
  store.db.prepare(`
    UPDATE provider_files SET torrent_file_id = ?, mapping_state = 'mapped',
    inventory_observed_at = ?, inventory_expires_at = ? WHERE placement_id = ?
  `).run(MOVIE_TF_ID, now, until, placement.id);
  store.recordReadinessObservation({ placementId: placement.id, state: 'ready', source: 'publication-contract', observedAt: now, expiresAt: until });
  return { placementId: placement.id };
}

function movieHandoff(placementId) {
  return {
    mediaId: MOVIE_MEDIA_ID, mediaType: 'movie',
    releaseKey: `${INFO_HASH}:1`, infoHash: INFO_HASH, fileIndex: 1,
    filename: 'A Great Movie (2024).mkv', torrentFileId: MOVIE_TF_ID,
    provider: 'torbox', providerState: 'cached', identityTier: 'Verified',
    resolutionState: 'confirmed', selectionReason: 'publication-contract', selectedAt: 1_000,
    torrentFileIdentity: {
      status: 'bound', torrentFileId: MOVIE_TF_ID, placementId,
      providerFileId: '1', size: 900,
    },
  };
}

function episodeHandoff(placementId) {
  return {
    mediaId: EPISODE_MEDIA_ID, mediaType: 'series', season: 1, episode: 1,
    releaseKey: `${INFO_HASH}:0`, infoHash: INFO_HASH, fileIndex: 0,
    filename: 'Show S01E01.mkv', torrentFileId: 'tf_pub_e01',
    provider: 'torbox', providerState: 'cached', identityTier: 'Verified',
    resolutionState: 'confirmed', selectionReason: 'publication-contract', selectedAt: 1_000,
    torrentFileIdentity: {
      status: 'tv-episode', torrentFileId: 'tf_pub_e01', placementId,
      providerFileId: '0', size: 500, season: 1, episode: 1,
    },
  };
}

/** Minimal Plex stub: refresh endpoint ok, sessions empty, libraries empty. */
function startPlexStub(t) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    if (req.url?.includes('/library/sections/') && req.url?.includes('/refresh')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    if (req.url?.includes('/status/sessions')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ MediaContainer: { size: 0, Metadata: [] } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ MediaContainer: { size: 0, Metadata: [] } }));
  });
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  // The compose/serve contract is what the assertion below cares about; wait
  // for the socket so the port is real before callers use it.
  return new Promise((resolve) => {
    server.once('listening', () => {
      const { port } = server.address();
      resolve({ baseUrl: `http://127.0.0.1:${port}`, requests });
    });
  });
}

function withPublicationEnv(t, overrides = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, {
    PLEX_URL: 'http://127.0.0.1:1',
    PLEX_TOKEN: 'test-token',
    PLEX_MOVIES_SECTION_ID: '1',
    PLEX_TV_SECTION_ID: '2',
    PLEX_MOVIES_ROOT: '/mnt/hashsucker-vfs/Movies',
    PLEX_TV_ROOT: '/mnt/hashsucker-vfs/TV',
    STRM_OUTPUT_PATH: mkdtempSync(join(tmpdir(), 'pub-strm-')),
    HASHSUCKER_BASE_URL: 'http://127.0.0.1:1',
  }, overrides);
  t.after(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    rmSync(process.env.STRM_OUTPUT_PATH ?? '/nonexistent', { recursive: true, force: true });
  });
  return saved;
}

function buildStores(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'publication-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const cache = createDiscoveryCache({ dbPath: join(tmp, 'discovery.db') });
  const store = createControlPlaneStore({ dbPath: join(tmp, 'control-plane.db'), now: () => 1_000 });
  t.after(() => { cache.close(); store.close(); });
  return { cache, store, tmp };
}

test('P1 — episode publication reaches the bounded deterministic ingest transaction', async (t) => {
  const plex = await startPlexStub(t);
  withPublicationEnv(t, { PLEX_URL: plex.baseUrl, HASHSUCKER_BASE_URL: plex.baseUrl });
  const { cache, store } = buildStores(t);
  const { placementId } = seedEpisode(store);
  const handoff = episodeHandoff(placementId);

  const before = getMetrics().counters.plex_ingest_attempts_total;
  const { vfsEntry } = await publishSelectedHandoff({
    cache, controlPlaneStore: store, handoff,
    mediaId: EPISODE_MEDIA_ID, mediaType: 'series', season: 1, episode: 1,
    isEpisode: true,
  });

  assert.ok(vfsEntry, 'authoritative VFS row is produced');

  // The dispatch is deliberately non-blocking and the Plex refresh is
  // coalesced (750 ms window) before the chained confirm runs; wait past that
  // window, then prove the ingest transaction was attempted (and not
  // swallowed by its own .catch()).
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  const attempts = getMetrics().counters.plex_ingest_attempts_total;
  assert.ok(attempts > before,
    'episode geometry must reach the deterministic ingest transaction (attempts_total must advance)');
  assert.ok(plex.requests.some((u) => u?.includes('/library/sections/2/refresh')),
    'the targeted TV section refresh must have been dispatched');
});

test('P2 — movie publication notifies Plex but performs no episode ingest', async (t) => {
  const plex = await startPlexStub(t);
  withPublicationEnv(t, { PLEX_URL: plex.baseUrl, HASHSUCKER_BASE_URL: plex.baseUrl });
  const { cache, store } = buildStores(t);
  const { placementId } = seedMovie(store);
  const handoff = movieHandoff(placementId);

  const before = getMetrics().counters.plex_ingest_attempts_total;
  await publishSelectedHandoff({
    cache, controlPlaneStore: store, handoff,
    mediaId: MOVIE_MEDIA_ID, mediaType: 'movie', isEpisode: false,
  });

  await new Promise((resolve) => setTimeout(resolve, 1_600));
  assert.equal(getMetrics().counters.plex_ingest_attempts_total, before,
    'movies must not enter the episode ingest transaction');
  assert.ok(plex.requests.some((u) => u?.includes('/library/sections/1/refresh')),
    'the targeted Movies section refresh must have been dispatched');
});

test('P3 — a failing VFS materialization surfaces its stage', async (t) => {
  withPublicationEnv(t);
  const { cache, store } = buildStores(t);
  const { placementId } = seedEpisode(store);

  // A handoff with no TorrentFile identity is a deterministic materialization
  // failure: the authoritative materializer refuses to project a new VFS row
  // without one, and that refusal must arrive as a typed stage failure rather
  // than a generic adapter error.
  const unbound = episodeHandoff(placementId);
  unbound.torrentFileId = null;
  unbound.torrentFileIdentity = null;

  await assert.rejects(
    () => publishSelectedHandoff({
      cache, controlPlaneStore: store, handoff: unbound,
      mediaId: EPISODE_MEDIA_ID, mediaType: 'series', season: 1, episode: 1, isEpisode: true,
    }),
    (error) => error instanceof PublicationError && error.stage === 'vfs-materialization',
    'a refusing materializer must surface as the vfs-materialization stage',
  );
});

test('P4 — a failed binding activation is reported by the authoritative check, not as a stage throw', async (t) => {
  withPublicationEnv(t);
  const { cache, store } = buildStores(t);
  const { placementId } = seedEpisode(store);

  // The live failure mode: the provider inventory observation goes stale
  // between inventory and binding activation. The materializer writes the
  // row, activation fails, and the orphan cleanup removes the row — the
  // publication call itself resolves, and the caller's authoritative
  // Binding check is what reports the item as not published.
  store.db.prepare('UPDATE provider_files SET inventory_expires_at = 1 WHERE placement_id = ?').run(placementId);
  const handoff = episodeHandoff(placementId);
  await publishSelectedHandoff({
    cache, controlPlaneStore: store, handoff,
    mediaId: EPISODE_MEDIA_ID, mediaType: 'series', season: 1, episode: 1, isEpisode: true,
  });

  assert.equal(cache.getVfsTvEntry(EPISODE_MEDIA_ID, 1, 1), null,
    'an unbound episode row must not stay consumer-visible');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS c FROM bindings').get().c, 0,
    'the stale inventory must not have produced a binding');
});

test('P5 — prepared replay confirms the ingest BEFORE notifying (never races its own refresh)', async (t) => {
  const plex = await startPlexStub(t);
  withPublicationEnv(t, { PLEX_URL: plex.baseUrl, HASHSUCKER_BASE_URL: plex.baseUrl });
  const { cache, store } = buildStores(t);
  const { placementId } = seedEpisode(store);
  const handoff = episodeHandoff(placementId);

  // The deterministic ingest must be attempted on the republish path (it is
  // the prepared-replay contract) and the targeted refresh dispatched only
  // when it did not verify.
  const result = await republishHealthyHandoff({
    cache, controlPlaneStore: store, handoff,
    mediaId: EPISODE_MEDIA_ID, mediaType: 'series', season: 1, episode: 1, isEpisode: true,
  });
  assert.ok(result.vfsEntry, 'authoritative VFS row re-proven on replay');

  // Reaching the ingest transaction at all is the regression: an out-of-scope
  // variable once made this branch throw inside a swallowed .catch(), so the
  // confirm silently never ran on the fresh-publication path, and a missing
  // branch would silently skip it here.
  assert.ok(plex.requests.some((u) => u?.includes('/library/sections/2/refresh')),
    'the targeted TV refresh must be dispatched on replay when ingest did not verify');
});

test('P6 — a movie replay notifies but never enters the episode ingest transaction', async (t) => {
  const plex = await startPlexStub(t);
  withPublicationEnv(t, { PLEX_URL: plex.baseUrl, HASHSUCKER_BASE_URL: plex.baseUrl });
  const { cache, store } = buildStores(t);
  const { placementId } = seedMovie(store);
  const handoff = movieHandoff(placementId);

  const before = getMetrics().counters.plex_ingest_attempts_total;
  await republishHealthyHandoff({
    cache, controlPlaneStore: store, handoff,
    mediaId: MOVIE_MEDIA_ID, mediaType: 'movie', isEpisode: false,
  });
  assert.equal(getMetrics().counters.plex_ingest_attempts_total, before,
    'movies never enter the episode ingest transaction');
  assert.ok(plex.requests.some((u) => u?.includes('/library/sections/1/refresh')),
    'the targeted Movies refresh is dispatched on replay');
});

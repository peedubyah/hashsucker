/**
 * Corpus hygiene: contradiction detection, surgical repair, published
 * guard — all against real in-memory stores. No network, no providers.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createCorpusHygiene } from '../src/lib/discovery/corpus-hygiene.js';

const H = (c) => c.repeat(40);

function stores() {
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const cps = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  return { cache, cps };
}

function addCandidate(cache, hash, filename, title) {
  cache.ingestCandidate({ infoHash: hash, fileIndex: null, title, filename });
}

function publishEpisode(s, mediaId, season, episode, internalPath, tfId, hash) {
  s.cps.ensureLibraryItem({
    mediaType: 'episode', mediaId, title: 'Show', season, episode, desiredState: 'present',
  });
  s.cps.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES (?, ?, ?, 100, 1)`).run(tfId, hash, internalPath);
  s.cache.createVfsTvEntry({
    mediaId, season, episode, releaseKey: `${hash}:torrent`, infoHash: hash,
    fileIndex: null, canonicalPath: `TV/X/S01E0${episode}.mkv`,
    torrentFileId: tfId, size: 100, createdAt: 1, updatedAt: 1,
  });
  s.cache.db.prepare(`INSERT INTO playback_handoffs
    (media_id, media_type, season, episode, release_key, info_hash, filename, torrent_file_id, selected_at)
    VALUES (?, 'series', ?, ?, ?, ?, ?, ?, 1)`)
    .run(mediaId, season, episode, `${hash}:torrent`, hash, internalPath, tfId);
}

test('repair: episodic candidate on known movie is removed, bytes survive', async () => {
  const s = stores();
  const h = createCorpusHygiene({ cache: s.cache, controlPlaneStore: s.cps });
  s.cps.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt-mov', title: 'Mov', desiredState: 'present' });
  addCandidate(s.cache, H('a'), 'Mov.S01E02.1080p.WEB-DL.mkv', 'Mov');
  s.cache.associateMedia(H('a'), null, 'tt-mov', { source: 'search', confidence: 0.9 });
  const rows = h.buildAuditBatch(25);
  assert.ok(rows.some((r) => r.media_id === 'tt-mov'));
  const v = h.evaluateAssociation(rows.find((r) => r.media_id === 'tt-mov'));
  assert.equal(v.verdict, 'repair');
  assert.equal(v.reason, 'episode-on-movie');
  const r = await h.tickOnce();
  assert.equal(r.repaired, 1);
  assert.equal(s.cache.db.prepare('SELECT COUNT(*) n FROM candidate_media WHERE media_id=?').get('tt-mov').n, 0);
  // Release row + repair log survive.
  assert.ok(s.cache.db.prepare('SELECT * FROM candidates WHERE info_hash=?').get(H('a')));
  assert.equal(s.cache.db.prepare("SELECT COUNT(*) n FROM hygiene_repairs WHERE decision='repaired'").get().n, 1);
});

test('repair: Mogul/House poisoning removed via published truth', async () => {
  const s = stores();
  const h = createCorpusHygiene({ cache: s.cache, controlPlaneStore: s.cps });
  publishEpisode(s, 'tt-fall', 1, 1, 'The.Fall.of.Diddy.S01E01.1080p.mkv', 'tf-fall', H('e'));
  addCandidate(s.cache, H('f'), 'House.of.Lies.S01E04.1080p.mkv', 'House of Lies');
  s.cache.associateMedia(H('f'), null, 'tt-fall', { source: 'idle-enrichment', confidence: 0.5 });
  const rows = h.buildAuditBatch(25);
  const v = h.evaluateAssociation(rows.find((r) => r.info_hash === H('f')));
  assert.equal(v.verdict, 'repair');
  assert.equal(v.reason, 'show-mismatch');
  await h.tickOnce();
  assert.equal(s.cache.db.prepare('SELECT COUNT(*) n FROM candidate_media WHERE info_hash=?').get(H('f')).n, 0);
  assert.ok(s.cache.db.prepare('SELECT * FROM candidates WHERE info_hash=?').get(H('f')));
  const log = s.cache.db.prepare("SELECT * FROM hygiene_repairs WHERE decision='repaired'").get();
  assert.equal(log.media_id, 'tt-fall');
  assert.match(log.contradicting_evidence, /idle-enrichment/);
});

test('safety: transliteration ambiguity and published bindings only flag', async () => {
  const s = stores();
  const h = createCorpusHygiene({ cache: s.cache, controlPlaneStore: s.cps });
  // Transliterated row, household source, weak dominant (no publication):
  // suspicious at most, never deleted.
  addCandidate(s.cache, H('1'), 'Mstiteli.Sudny.Den.2026.WEB-DL.mkv', 'Mstiteli Sudny Den');
  s.cache.associateMedia(H('1'), null, 'tt-cyr', { source: 'request-outcome', confidence: 1.0 });
  // Published binding for the same hash: guard fires, row survives.
  publishEpisode(s, 'tt-guard', 1, 1, 'Guard.Show.S01E01.1080p.mkv', 'tf-guard', H('2'));
  addCandidate(s.cache, H('2'), 'Other.Show.S01E09.1080p.mkv', 'Other Show');
  s.cache.associateMedia(H('2'), null, 'tt-guard', { source: 'idle-enrichment', confidence: 0.5 });
  const r = await h.tickOnce();
  assert.equal(r.repaired, 0);
  assert.ok(r.flagged >= 1);
  assert.equal(s.cache.db.prepare('SELECT COUNT(*) n FROM candidate_media WHERE info_hash=?').get(H('1')).n, 1);
  assert.equal(s.cache.db.prepare('SELECT COUNT(*) n FROM candidate_media WHERE info_hash=?').get(H('2')).n, 1);
  const guards = s.cache.db.prepare("SELECT COUNT(*) n FROM hygiene_repairs WHERE published_guard=1").get().n;
  assert.equal(guards, 1);
});

test('ok: agreeing associations untouched; status shape sane', async () => {
  const s = stores();
  const h = createCorpusHygiene({ cache: s.cache, controlPlaneStore: s.cps });
  publishEpisode(s, 'tt-ok', 1, 1, 'Harbor.Lights.S01E01.1080p.mkv', 'tf-ok', H('3'));
  addCandidate(s.cache, H('4'), 'Harbor.Lights.S01E02.1080p.mkv', 'Harbor Lights');
  s.cache.associateMedia(H('4'), null, 'tt-ok', { source: 'request-outcome', confidence: 0.9 });
  const r = await h.tickOnce();
  assert.equal(r.repaired, 0);
  assert.equal(s.cache.db.prepare('SELECT COUNT(*) n FROM candidate_media WHERE info_hash=?').get(H('4')).n, 1);
  const st = h.getStatus();
  assert.ok(st.lastTickAt != null && typeof st.checked === 'number');
});

test('gate: foreground activity defers the audit tick', async () => {
  const s = stores();
  const h = createCorpusHygiene({ cache: s.cache, controlPlaneStore: s.cps, now: () => 1_000_000 });
  s.cache.db.prepare(`INSERT INTO media_requests (media_id, media_type, season, episode, source, status, candidate_count, created_at)
    VALUES ('tt-busy', 'movie', NULL, NULL, 'seerr', 'done', 1, 999999)`).run();
  const r = await h.tickOnce();
  assert.equal(r.acted, false);
  assert.equal(r.reason, 'not-quiet');
});

test('hygiene endpoint: status shape over HTTP', async () => {
  const { cache, cps } = stores();
  const { default: http } = await import('node:http');
  const { createRequestHandler } = await import('../src/server/app.js');
  const server = http.createServer(createRequestHandler({
    controlPlaneStore: cps, discoveryCache: cache, searchCache: cache,
    env: {}, clock: () => Date.now(),
    hygieneStatus: () => ({ enabled: true, checked: 7, repaired: 1, flagged: 2 }),
  }));
  await new Promise((r) => server.listen(0, r));
  try {
    const { port } = server.address();
    const body = await new Promise((resolve, reject) => {
      http.get({ port, path: '/api/operator/hygiene', host: '127.0.0.1' }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(b) }));
      }).on('error', reject);
    });
    assert.equal(body.status, 200);
    assert.equal(body.json.checked, 7);
    assert.equal(body.json.repaired, 1);
  } finally {
    server.close();
  }
});

test('never repairs on absent candidate evidence', async () => {
  const s = stores();
  const h = createCorpusHygiene({ cache: s.cache, controlPlaneStore: s.cps });
  s.cps.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt-orph', title: 'Orph', desiredState: 'present' });
  // Association with no candidate row at all (dangling FK from old code).
  s.cache.db.prepare(`INSERT INTO candidate_media (info_hash, file_index_key, media_id, source, confidence, associated_at)
    VALUES (?, -1, 'tt-orph', 'idle-enrichment', 0.5, 1)`).run('e'.repeat(40));
  const rows = h.buildAuditBatch(25);
  const v = h.evaluateAssociation(rows.find((r) => r.media_id === 'tt-orph'));
  assert.equal(v.verdict, 'ok');
  const r = await h.tickOnce();
  assert.equal(r.repaired, 0);
  assert.equal(s.cache.db.prepare("SELECT COUNT(*) n FROM candidate_media WHERE media_id='tt-orph'").get().n, 1);
});

test('pack of the right show survives path-style published truth', async () => {
  const s = stores();
  const h = createCorpusHygiene({ cache: s.cache, controlPlaneStore: s.cps });
  s.cps.ensureLibraryItem({ mediaType: 'episode', mediaId: 'tt-pack', title: 'Harbor Lights', season: 1, episode: 1, desiredState: 'present' });
  s.cps.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
    VALUES ('tf-pack', ?, 'Harbor.Lights.S01.BluRay/Harbor.Lights.S01E01.mkv', 100, 1)`).run('f'.repeat(40));
  s.cache.createVfsTvEntry({ mediaId: 'tt-pack', season: 1, episode: 1, releaseKey: 'f'.repeat(40) + ':torrent',
    infoHash: 'f'.repeat(40), fileIndex: null, canonicalPath: 'TV/Pack/S01E01.mkv',
    torrentFileId: 'tf-pack', size: 100, createdAt: 1, updatedAt: 1 });
  s.cache.db.prepare(`INSERT INTO playback_handoffs
    (media_id, media_type, season, episode, release_key, info_hash, filename, torrent_file_id, selected_at)
    VALUES ('tt-pack', 'series', 1, 1, ?, ?, 'Harbor.Lights.S01E01.mkv', 'tf-pack', 1)`)
    .run('f'.repeat(40) + ':torrent', 'f'.repeat(40));
  // Complete-pack association: same show, no episode conflict.
  s.cache.ingestCandidate({ infoHash: 'a'.repeat(40), fileIndex: null, title: 'Harbor Lights Complete', filename: 'Harbor.Lights.Complete.1080p.mkv' });
  s.cache.associateMedia('a'.repeat(40), null, 'tt-pack', { source: 'request-outcome', confidence: 0.4 });
  const r = await h.tickOnce();
  assert.equal(r.repaired, 0);
  assert.equal(s.cache.db.prepare("SELECT COUNT(*) n FROM candidate_media WHERE media_id='tt-pack'").get().n, 1);
});

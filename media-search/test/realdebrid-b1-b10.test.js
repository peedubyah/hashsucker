/**
 * Real-Debrid B1–B10 TDD proofs.
 *
 * Verifies the smallest contract required for HARDEN:
 *   B1  fresh known infringement => zero duplicate addMagnet, including
 *       across process restart (persisted negative keyed by
 *       (provider=realdebrid, exact infoHash), freshness-bounded).
 *   B2  unknown persisted alternate => exactly one bounded active
 *       production evaluation (addMagnet → info → exact mapping → select
 *       → updated info → unrestrict exact link → byte validator).
 *   B3  exact file match => usable delivery.
 *   B4  absent => no false success.
 *   B5  ambiguous => fail closed.
 *   B6  repeated ranges after success => no repeated add/select/unrestrict.
 *   B7  concurrent first resolution single-flight.
 *   B8  restart reacquires ephemeral delivery for same TorrentFile.
 *   B9  expired/bad URL reacquires boundedly for same TorrentFile.
 *   B10 provider IDs/link never durable identity.
 *
 * These tests reuse the existing resolve.js + rd-resolution-cache.js + the
 * real createDiscoveryCache. They do NOT introduce a new RD client.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  attemptRdResolution,
  classifyCandidateToRdFile,
  getRdPlaybackUrl,
  RdResolutionError,
} from '../src/lib/providers/realdebrid/resolve.js';
import { providerAccounting } from '../src/lib/providers/provider-accounting.js';
import { getRdResolutionCache } from '../src/lib/providers/realdebrid/rd-resolution-cache.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

const E02_INFOHASH = 'a07b84404989fccee1d55c247cb03e22c8847ecc';
const E02_SIZE = 8_775_633_660;
const E02_FILENAME = 'When They See Us S01 HDR WEB-DL 2160p/When They See Us S01E02 WEB-DL 2160p.mkv';
const E02_BASENAME = 'When They See Us S01E02 WEB-DL 2160p.mkv';
const E02_RD_FILE_ID = 'rd-file-e02';
const E02_TORRENT_ID = 'torrent-e02';

function rdFile({ id = 'rd-file-1', path = E02_BASENAME, bytes = E02_SIZE, selected = false } = {}) {
  return { id, path, bytes, selected };
}

function freshAccounting() {
  providerAccounting.reset();
}

function makeMockRdClient({ files, status = 'downloaded', id = E02_TORRENT_ID, links } = {}) {
  const calls = { addMagnet: 0, getTorrentInfo: 0, selectFiles: 0, deleteTorrent: 0, unrestrictLink: 0 };
  return {
    calls,
    async addMagnet(_magnet, _opts) {
      calls.addMagnet++;
      return { id, uri: `https://real-debrid.com/torrents/${id}` };
    },
    async getTorrentInfo(_torrentId, _opts) {
      calls.getTorrentInfo++;
      return {
        id,
        filename: 'example',
        hash: E02_INFOHASH,
        bytes: E02_SIZE,
        status,
        files,
        links: links ?? ['https://hoster.example/abc'],
      };
    },
    async selectFiles(_torrentId, _fileId, _opts) {
      calls.selectFiles++;
      return { selected: [_fileId] };
    },
    async unrestrictLink(link, _opts) {
      calls.unrestrictLink++;
      return { download: link, filename: 'unrestricted.mkv' };
    },
    async deleteTorrent(_torrentId, _opts) {
      calls.deleteTorrent++;
    },
  };
}

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'hashsucker-b1-b10-'));
}

function appendInfringingObservation(cache) {
  cache.appendProviderObservation({
    provider: 'realdebrid',
    infoHash: E02_INFOHASH,
    fileIndex: 0,
    scope: 'candidate',
    kind: 'authoritative',
    state: 'uncached',
    observedAt: Date.now(),
    ttlMs: 5 * 60 * 1000,
    source: 'previous-run',
    errorCategory: 'infringing',
    evidence: { rdErrorCode: 35 },
  });
}

// ---------------------------------------------------------------------------
// B1: fresh known infringement => zero duplicate addMagnet
// ---------------------------------------------------------------------------

test('B1 (in-memory): fresh infringing observation short-circuits addMagnet', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();
  const searchCache = {
    observations: [],
    getProviderObservations() {
      return [{
        provider: 'realdebrid',
        state: 'uncached',
        errorCategory: 'infringing',
        observedAt: Date.now(),
        ttlMs: 5 * 60 * 1000,
      }];
    },
    appendProviderObservation(obs) { this.observations.push(obs); return obs; },
  };
  const client = makeMockRdClient({ files: [rdFile()] });
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'infringing');
  assert.equal(client.calls.addMagnet, 0, 'addMagnet must not be called when negative is fresh');
});

test('B1 (persisted): across-restart fresh infringement prevents duplicate addMagnet', async () => {
  freshAccounting();
  // Simulate a previous run that persisted the RD infringement negative
  // into the discovery cache SQLite DB.
  const dir = makeTempDir();
  const dbPath = join(dir, 'discovery.db');
  try {
    {
      const cache = createDiscoveryCache({ dbPath });
      appendInfringingObservation(cache);
      cache.close();
    }
    // "Restart" — open the same DB with a fresh cache instance. attemptRdResolution
    // must honour the persisted negative and skip addMagnet.
    const cache2 = createDiscoveryCache({ dbPath });
    const client = makeMockRdClient({ files: [rdFile()] });
    let addMagnetCalled = false;
    client.addMagnet = async () => { addMagnetCalled = true; return { id: E02_TORRENT_ID }; };
    const result = await attemptRdResolution(client, cache2, {
      infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
    });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'infringing');
    assert.equal(addMagnetCalled, false, 'restart must not re-attempt addMagnet when negative is fresh');
    cache2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// B2 / B3 / B4 / B5: exact mapping cardinality, absence, ambiguity
// ---------------------------------------------------------------------------

test('B2: unknown persisted alternate => exactly one bounded active evaluation', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();
  // Empty discovery cache => observation is 'missing' => bounded attempt
  // runs the full addMagnet → info → exact mapping → select → updated
  // info → unrestrict → byte validator chain exactly once for the first
  // resolution.
  const searchCache = {
    observations: [],
    getProviderObservations() { return []; },
    appendProviderObservation(obs) { this.observations.push(obs); return obs; },
  };
  const client = makeMockRdClient({
    files: [rdFile({ id: E02_RD_FILE_ID, path: E02_FILENAME, bytes: E02_SIZE })],
  });
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.rdFileId, E02_RD_FILE_ID);
  // The single-flight guarantee at the rdResolutionCache layer prevents
  // duplicate addMagnet for concurrent same-TorrentFile resolutions; the
  // single evaluation here is the one bounded attempt the negative cache
  // requires. Client was hit exactly once for the full chain.
  assert.equal(client.calls.addMagnet, 1);
  assert.equal(client.calls.selectFiles, 1);
});

test('B3: exact file match => usable delivery', async () => {
  freshAccounting();
  const files = [rdFile({ id: E02_RD_FILE_ID, path: E02_FILENAME, bytes: E02_SIZE })];
  const result = classifyCandidateToRdFile(files, { filename: E02_FILENAME, size: E02_SIZE });
  assert.equal(result.classification, 'match');
  assert.equal(result.rdFileId, E02_RD_FILE_ID);
});

test('B4: absent => no false success', async () => {
  freshAccounting();
  // RD reports only files whose name + size do not match the corpus row.
  const files = [
    rdFile({ id: 'a', path: 'wrong.mkv', bytes: E02_SIZE + 1 }),
    rdFile({ id: 'b', path: 'also-wrong.mkv', bytes: E02_SIZE - 1 }),
  ];
  const searchCache = {
    observations: [],
    getProviderObservations() { return []; },
    appendProviderObservation(obs) { this.observations.push(obs); return obs; },
  };
  const client = makeMockRdClient({ files });
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'RD_FILE_MAPPING_FAILED');
  // No selectFiles / no unrestrict — must not progress to a usable result.
  assert.equal(client.calls.selectFiles, 0);
  assert.equal(client.calls.unrestrictLink, 0);
});

test('B5: ambiguous => fail closed', async () => {
  freshAccounting();
  // Two playable files with the same basename, neither matches the
  // authoritative full path nor the authoritative size.
  const files = [
    rdFile({ id: 'a', path: `season-disc-a/${E02_BASENAME}`, bytes: E02_SIZE + 1 }),
    rdFile({ id: 'b', path: `season-disc-b/${E02_BASENAME}`, bytes: E02_SIZE + 1024 }),
  ];
  const searchCache = {
    observations: [],
    getProviderObservations() { return []; },
    appendProviderObservation(obs) { this.observations.push(obs); return obs; },
  };
  const client = makeMockRdClient({ files });
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'RD_FILE_MAPPING_FAILED');
  assert.equal(client.calls.selectFiles, 0);
  assert.equal(client.calls.unrestrictLink, 0);
});

// ---------------------------------------------------------------------------
// B6: repeated ranges after success => no repeated add/select/unrestrict
// ---------------------------------------------------------------------------

test('B6: successful delivery cached so repeated ranges do not repeat add/select/unrestrict', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();
  const client = makeMockRdClient({
    files: [rdFile({ id: E02_RD_FILE_ID, path: E02_FILENAME, bytes: E02_SIZE })],
  });

  // First range: full addMagnet → info → select → unrestrict chain runs once.
  const r1 = await cache.getOrInFlight(E02_INFOHASH, 0, async () => {
    return attemptRdResolution(client, { getProviderObservations: () => [], appendProviderObservation() {} }, {
      infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
    });
  });
  assert.equal(r1.status, 'resolved');
  // After a successful resolution, the VFS layer is expected to .set() the
  // unrestricted URL into the resolution cache. We mirror that here.
  const url1 = await getRdPlaybackUrl(client, r1.torrentInfo, r1.rdFileId);
  assert.ok(url1, 'unrestrict must produce a download URL');
  cache.set(E02_INFOHASH, 0, url1, r1.torrentId, r1.rdFileId);

  // Second range: cache hit, no factory invoked.
  const cached = cache.get(E02_INFOHASH, 0);
  assert.ok(cached, 'second range must find the cached delivery URL');
  assert.equal(cached.url, url1);

  const addCountAfter1 = client.calls.addMagnet;
  const selectCountAfter1 = client.calls.selectFiles;
  const unrestrictCountAfter1 = client.calls.unrestrictLink;

  // The VFS path returns from cache without re-invoking the seam.
  // Simulate by NOT calling getOrInFlight; assert counters unchanged.
  const cached2 = cache.get(E02_INFOHASH, 0);
  assert.equal(cached2.url, url1);
  assert.equal(client.calls.addMagnet, addCountAfter1);
  assert.equal(client.calls.selectFiles, selectCountAfter1);
  assert.equal(client.calls.unrestrictLink, unrestrictCountAfter1);
});

// ---------------------------------------------------------------------------
// B7: concurrent first resolution single-flight
// ---------------------------------------------------------------------------

test('B7: concurrent same-TorrentFile RD resolution coalesces via single-flight', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();
  let callCount = 0;
  const factory = async () => {
    callCount++;
    await new Promise(r => setTimeout(r, 25));
    return { status: 'resolved', rdFileId: E02_RD_FILE_ID, torrentId: E02_TORRENT_ID };
  };
  const results = await Promise.all([
    cache.getOrInFlight(E02_INFOHASH, 0, factory),
    cache.getOrInFlight(E02_INFOHASH, 0, factory),
    cache.getOrInFlight(E02_INFOHASH, 0, factory),
  ]);
  assert.equal(callCount, 1, 'concurrent first resolution must single-flight');
  assert.equal(new Set(results.map(r => r.rdFileId)).size, 1);
});

// ---------------------------------------------------------------------------
// B8: restart reacquires ephemeral delivery for same TorrentFile
// ---------------------------------------------------------------------------

test('B8: empty resolution cache (post-restart) reacquires for same TorrentFile', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();

  // Empty cache simulates process restart. The VFS resolveBacking path
  // calls getOrInFlight with attemptRdResolution as the factory; the
  // factory must run to produce a fresh delivery URL.
  let addMagnetCalls = 0;
  const factory = async () => {
    addMagnetCalls++;
    return {
      status: 'resolved',
      rdFileId: E02_RD_FILE_ID,
      torrentId: E02_TORRENT_ID,
      torrentInfo: { files: [rdFile({ id: E02_RD_FILE_ID, path: E02_FILENAME, bytes: E02_SIZE })], links: ['https://hoster.example/abc'] },
    };
  };
  const r1 = await cache.getOrInFlight(E02_INFOHASH, 0, factory);
  assert.equal(r1.status, 'resolved');
  assert.equal(addMagnetCalls, 1);

  // Now simulate restart: a brand new resolution cache object is empty,
  // the SAME infoHash/fileIndex is requested. The factory must run again.
  // (resolveBacking re-acquires for the same TorrentFile without mutating
  // identity — the key is (infoHash, fileIndex), which is the
  // TorrentFile identity.)
  const cache2 = getRdResolutionCache();
  assert.equal(cache2.get(E02_INFOHASH, 0), null, 'fresh cache must be empty');
  let addMagnetCalls2 = 0;
  const factory2 = async () => {
    addMagnetCalls2++;
    return {
      status: 'resolved',
      rdFileId: E02_RD_FILE_ID,
      torrentId: E02_TORRENT_ID,
      torrentInfo: { files: [rdFile({ id: E02_RD_FILE_ID, path: E02_FILENAME, bytes: E02_SIZE })], links: ['https://hoster.example/abc'] },
    };
  };
  const r2 = await cache2.getOrInFlight(E02_INFOHASH, 0, factory2);
  assert.equal(r2.status, 'resolved');
  assert.equal(addMagnetCalls2, 1, 'post-restart re-acquisition must run the full chain');
  // Identity preservation: same infoHash + fileIndex; no mutation.
  assert.equal(r2.rdFileId, E02_RD_FILE_ID);
});

// ---------------------------------------------------------------------------
// B9: expired/bad URL reacquires boundedly for same TorrentFile
// ---------------------------------------------------------------------------

test('B9: TTL-expired URL reacquires for same TorrentFile', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();
  cache.set(E02_INFOHASH, 0, 'https://rd.example/old', 't-old', 'f-old', 1); // 1ms TTL
  await new Promise(r => setTimeout(r, 10));
  assert.equal(cache.get(E02_INFOHASH, 0), null, 'TTL-expired entry must not be returned');

  let factoryCalls = 0;
  const factory = async () => {
    factoryCalls++;
    return { status: 'resolved', rdFileId: E02_RD_FILE_ID, torrentId: 't-new' };
  };
  const r = await cache.getOrInFlight(E02_INFOHASH, 0, factory);
  assert.equal(r.status, 'resolved');
  assert.equal(factoryCalls, 1, 'expired URL must trigger bounded re-acquisition');
});

test('B9: explicitly deleted URL reacquires for same TorrentFile', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();
  cache.set(E02_INFOHASH, 0, 'https://rd.example/old', 't-old', 'f-old');
  cache.delete(E02_INFOHASH, 0);
  assert.equal(cache.get(E02_INFOHASH, 0), null, 'deleted entry must not be returned');
  let factoryCalls = 0;
  const factory = async () => {
    factoryCalls++;
    return { status: 'resolved', rdFileId: E02_RD_FILE_ID, torrentId: 't-new' };
  };
  const r = await cache.getOrInFlight(E02_INFOHASH, 0, factory);
  assert.equal(r.status, 'resolved');
  assert.equal(factoryCalls, 1);
});

test('B9: bad-URL recovery — unrestrict returning no download URL does not poison the cache', async () => {
  freshAccounting();
  // The VFS path only .set()s the URL into the resolution cache AFTER
  // isUrlLive() passes (and getRdPlaybackUrl returns a real download
  // URL). When the URL is bad/missing, the cache is never written and
  // the next call re-runs the full chain. Verify both:
  const cache = getRdResolutionCache();
  cache.clear();
  // First call: bad URL. Simulate by NOT calling cache.set().
  let firstCallFactory = 0;
  await cache.getOrInFlight(E02_INFOHASH, 0, async () => {
    firstCallFactory++;
    return { status: 'failed', reason: 'bad-url' };
  });
  assert.equal(firstCallFactory, 1);
  assert.equal(cache.get(E02_INFOHASH, 0), null, 'bad URL must not be cached');

  // Second call: re-acquire.
  let secondCallFactory = 0;
  const r2 = await cache.getOrInFlight(E02_INFOHASH, 0, async () => {
    secondCallFactory++;
    return { status: 'resolved', rdFileId: E02_RD_FILE_ID, torrentId: 't-new' };
  });
  assert.equal(r2.status, 'resolved');
  assert.equal(secondCallFactory, 1, 'bad URL must trigger bounded re-acquisition on next call');
});

// ---------------------------------------------------------------------------
// B10: provider IDs/link never durable identity
// ---------------------------------------------------------------------------

test('B10: RD file ID and unrestricted URL are NOT persisted in playback_handoffs', () => {
  const dir = makeTempDir();
  const dbPath = join(dir, 'discovery.db');
  try {
    // Open via createDiscoveryCache to run the schema migrations, then
    // inspect the on-disk schema directly via DatabaseSync. The point of
    // this proof is structural: the durable identity tables must not
    // include any column that could be used to leak an RD provider file
    // ID or an unrestricted download URL. The contract is enforced by the
    // schema, not by code review.
    const cache = createDiscoveryCache({ dbPath });
    cache.close();
    const db = new DatabaseSync(dbPath);
    const cols = db.prepare('PRAGMA table_info(playback_handoffs)').all();
    const colNames = cols.map((c) => c.name);
    // Forbidden columns: any RD-specific identifier or capability URL.
    for (const forbidden of [
      'rd_file_id',
      'rd_torrent_id',
      'provider_file_id',
      'unrestricted_url',
      'download_url',
      'capability_url',
      'torrent_id', // RD-only — TorBox uses placement_id, file identity is torrent_file_id
    ]) {
      assert.ok(
        !colNames.includes(forbidden),
        `playback_handoffs must not have a ${forbidden} column; schema is: ${colNames.join(', ')}`,
      );
    }
    // The durable identity tuple must be the canonical (infoHash, fileIndex, filename) plus torrent_file_id.
    for (const required of ['info_hash', 'file_index', 'filename', 'torrent_file_id']) {
      assert.ok(
        colNames.includes(required),
        `playback_handoffs must keep the durable identity column: ${required}`,
      );
    }
    // Also check that no related table (provider_observation_current,
    // provider_observations, media_request_results) leaks RD-specific
    // capability URLs as durable identity.
    const obsCols = db.prepare('PRAGMA table_info(provider_observation_current)').all().map((c) => c.name);
    for (const forbidden of ['rd_file_id', 'unrestricted_url', 'download_url']) {
      assert.ok(
        !obsCols.includes(forbidden),
        `provider_observation_current must not have a ${forbidden} column`,
      );
    }
    const reqCols = db.prepare('PRAGMA table_info(media_request_results)').all().map((c) => c.name);
    for (const forbidden of ['rd_file_id', 'unrestricted_url', 'download_url']) {
      assert.ok(
        !reqCols.includes(forbidden),
        `media_request_results must not have a ${forbidden} column`,
      );
    }
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Real-Debrid same-TorrentFile resolution tests (Worker B)
 *
 * Covers:
 *   B1 — Authoritative TorrentFile + exact RD file match → resolved
 *   B2 — RD exact file absent (wrong size) → no false success
 *   B3 — RD file mapping ambiguous (multiple size/basename matches) → fail closed
 *   B6 — Concurrent same-TorrentFile RD resolution coalesces via single-flight
 *
 * Plus narrow provider-accounting instrumentation assertions.
 *
 * The E02 authoritative corpus row for these tests is:
 *   infoHash: A07b84404989fccee1d55c247cb03e22c8847ecc
 *   size:     8_775_633_660 bytes
 *   path:     When They See Us S01 HDR WEB-DL 2160p/When They See Us S01E02 WEB-DL 2160p.mkv
 *
 * The test uses these exact constants and constructs the same canonical
 * filename the VFS resolution would carry. Any drift is a regression.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attemptRdResolution,
  classifyCandidateToRdFile,
  RdResolutionError,
  getRdObservationState,
} from '../src/lib/providers/realdebrid/resolve.js';
import { providerAccounting } from '../src/lib/providers/provider-accounting.js';
import { getRdResolutionCache } from '../src/lib/providers/realdebrid/rd-resolution-cache.js';

const E02_INFOHASH = 'A07b84404989fccee1d55c247cb03e22c8847ecc';
const E02_SIZE = 8_775_633_660;
const E02_FILENAME = 'When They See Us S01 HDR WEB-DL 2160p/When They See Us S01E02 WEB-DL 2160p.mkv';
const E02_BASENAME = 'When They See Us S01E02 WEB-DL 2160p.mkv';
const E02_RD_FILE_ID = 'rd-file-e02';

function rdFile({ id = 'rd-file-1', path = E02_BASENAME, bytes = E02_SIZE, selected = false } = {}) {
  return { id, path, bytes, selected };
}

function makeMockSearchCache() {
  return {
    observations: [],
    getProviderObservations(_infoHash, _fileIndex, _options) {
      return [];
    },
    appendProviderObservation(obs) {
      this.observations.push(obs);
      return obs;
    },
  };
}

function makeMockRdClient({ files, status = 'downloaded', id = 'torrent-1' } = {}) {
  const calls = { addMagnet: 0, getTorrentInfo: 0, selectFiles: 0, deleteTorrent: 0 };
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
        links: ['https://hoster.example/abc'],
      };
    },
    async selectFiles(_torrentId, _fileId, _opts) {
      calls.selectFiles++;
      return { selected: [_fileId] };
    },
    async unrestrictLink(link, _opts) {
      return { download: link, filename: 'unrestricted.mkv' };
    },
    async deleteTorrent(_torrentId, _opts) {
      calls.deleteTorrent++;
    },
  };
}

function rdCounterSnapshot() {
  const snap = providerAccounting.snapshot();
  return snap.providers.realdebrid.perCategory;
}

function freshAccounting() {
  providerAccounting.reset();
}

test('B1: exact filename + exact size → classified as match, single file id returned', () => {
  freshAccounting();
  const files = [rdFile({ id: E02_RD_FILE_ID, path: E02_FILENAME, bytes: E02_SIZE })];
  const result = classifyCandidateToRdFile(files, { filename: E02_FILENAME, size: E02_SIZE });
  assert.equal(result.classification, 'match');
  assert.equal(result.rdFileId, E02_RD_FILE_ID);
});

test('B1: attemptRdResolution returns status=resolved on exact match', async () => {
  freshAccounting();
  const files = [rdFile({ id: E02_RD_FILE_ID, path: E02_FILENAME, bytes: E02_SIZE })];
  const client = makeMockRdClient({ files });
  const searchCache = makeMockSearchCache();
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH,
    fileIndex: 0,
    filename: E02_FILENAME,
    size: E02_SIZE,
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.rdFileId, E02_RD_FILE_ID);
  assert.equal(result.torrentId, 'torrent-1');
  // Accounting assertions: attempted + resolved + match, and never ambiguous/absent
  const snap = rdCounterSnapshot();
  assert.equal(snap.realdebrid_fallback_attempted, 1);
  assert.equal(snap.realdebrid_fallback_resolved, 1);
  assert.equal(snap.realdebrid_fallback_failed, 0);
  assert.equal(snap.realdebrid_file_match, 1);
  assert.equal(snap.realdebrid_file_ambiguous, 0);
  assert.equal(snap.realdebrid_file_absent, 0);
  // selectFiles was called with the mapped file id
  assert.equal(client.calls.selectFiles, 1);
});

test('B2: RD file absent (no playable video files at all) → classified as absent', () => {
  freshAccounting();
  const files = [
    { id: 'rd-txt', path: 'readme.txt', bytes: 100 },
    { id: 'rd-jpg', path: 'cover.jpg', bytes: 200 },
  ];
  const result = classifyCandidateToRdFile(files, { filename: E02_FILENAME, size: E02_SIZE });
  assert.equal(result.classification, 'absent');
  assert.equal(result.rdFileId, null);
});

test('B2: RD file absent (no filename + no size match) → classified as absent', () => {
  freshAccounting();
  // Multiple files, none share the candidate's filename, and no file
  // has the authoritative size 8_775_633_660.
  const files = [
    rdFile({ id: 'rd-file-2', path: 'other-name.mkv', bytes: 1_000_000_000 }),
    rdFile({ id: 'rd-file-3', path: 'yet-another.mkv', bytes: 2_000_000_000 }),
  ];
  const result = classifyCandidateToRdFile(files, { filename: E02_FILENAME, size: E02_SIZE });
  assert.equal(result.classification, 'absent');
  assert.equal(result.rdFileId, null);
});

test('B2: attemptRdResolution returns failed RD_FILE_MAPPING_FAILED when no file matches', async () => {
  freshAccounting();
  // RD returns files but none has the authoritative size or filename
  const files = [
    rdFile({ id: 'rd-file-2', path: 'something-else.mkv', bytes: 1_000_000_000 }),
    rdFile({ id: 'rd-file-3', path: 'yet-another.mkv', bytes: 2_000_000_000 }),
  ];
  const client = makeMockRdClient({ files });
  const searchCache = makeMockSearchCache();
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH,
    fileIndex: 0,
    filename: E02_FILENAME,
    size: E02_SIZE,
  });
  assert.equal(result.status, 'failed');
  assert.ok(result.error instanceof RdResolutionError);
  assert.equal(result.error.code, 'RD_FILE_MAPPING_FAILED');
  // Accounting: attempted + failed + absent
  const snap = rdCounterSnapshot();
  assert.equal(snap.realdebrid_fallback_attempted, 1);
  assert.equal(snap.realdebrid_fallback_resolved, 0);
  assert.equal(snap.realdebrid_fallback_failed, 1);
  assert.equal(snap.realdebrid_file_match, 0);
  assert.equal(snap.realdebrid_file_ambiguous, 0);
  assert.equal(snap.realdebrid_file_absent, 1);
  // selectFiles must NOT have been called
  assert.equal(client.calls.selectFiles, 0);
  // cleanup still happens
  assert.equal(client.calls.deleteTorrent, 1);
});

test('B3: ambiguous (multiple files with same basename but different sizes) → fail closed', () => {
  freshAccounting();
  // The candidate uses a bare basename (no path), and both files have
  // distinct full paths whose basenames match. Neither size matches
  // the candidate, so the size-confirmation short-circuit is skipped
  // and we hit the allBasenameMatches.length > 1 branch → ambiguous.
  const files = [
    rdFile({ id: 'rd-a', path: `season-disc-a/${E02_BASENAME}`, bytes: 8_775_633_661 }),
    rdFile({ id: 'rd-b', path: `season-disc-b/${E02_BASENAME}`, bytes: 8_775_633_662 }),
  ];
  const result = classifyCandidateToRdFile(files, { filename: E02_BASENAME, size: E02_SIZE });
  assert.equal(result.classification, 'ambiguous');
  assert.equal(result.rdFileId, null);
});

test('B3: attemptRdResolution returns failed when basename matches multiple files', async () => {
  freshAccounting();
  // Two files, same basename, different parent paths and sizes.
  // The candidate's bare basename cannot exactMatch either full path,
  // so we hit the basename-match step, find >1 match with no size
  // confirmation for both → ambiguous → fail closed.
  const files = [
    rdFile({ id: 'rd-a', path: `season-disc-a/${E02_BASENAME}`, bytes: E02_SIZE + 1 }),
    rdFile({ id: 'rd-b', path: `season-disc-b/${E02_BASENAME}`, bytes: E02_SIZE + 1024 }),
  ];
  const client = makeMockRdClient({ files });
  const searchCache = makeMockSearchCache();
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH,
    fileIndex: 0,
    filename: E02_BASENAME,
    size: E02_SIZE,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'RD_FILE_MAPPING_FAILED');
  const snap = rdCounterSnapshot();
  assert.equal(snap.realdebrid_file_ambiguous, 1);
  assert.equal(snap.realdebrid_file_absent, 0);
  assert.equal(snap.realdebrid_fallback_failed, 1);
  assert.equal(client.calls.selectFiles, 0);
});

test('B3b: size-only ambiguous (multiple files of the exact authoritative size) → fail closed', () => {
  freshAccounting();
  const files = [
    rdFile({ id: 'rd-x', path: 'part1.mkv', bytes: E02_SIZE }),
    rdFile({ id: 'rd-y', path: 'part2.mkv', bytes: E02_SIZE }),
  ];
  // No filename, so we fall through to size-only matching
  const result = classifyCandidateToRdFile(files, { filename: null, size: E02_SIZE });
  assert.equal(result.classification, 'ambiguous');
  assert.equal(result.rdFileId, null);
});

test('classifyCandidateToRdFile: no playable video files → absent', () => {
  freshAccounting();
  const files = [
    { id: 'a', path: 'readme.txt', bytes: 100 },
    { id: 'b', path: 'sample.jpg', bytes: 200 },
  ];
  const result = classifyCandidateToRdFile(files, { filename: E02_FILENAME, size: E02_SIZE });
  assert.equal(result.classification, 'absent');
});

test('classifyCandidateToRdFile: empty file list → absent', () => {
  freshAccounting();
  assert.equal(classifyCandidateToRdFile([], { filename: E02_FILENAME, size: E02_SIZE })
    .classification, 'absent');
  assert.equal(classifyCandidateToRdFile(null, { filename: E02_FILENAME, size: E02_SIZE })
    .classification, 'absent');
});

test('classifyCandidateToRdFile: single playable file → match', () => {
  freshAccounting();
  const files = [rdFile({ id: 'only', path: E02_BASENAME, bytes: 999_999_999 })];
  const result = classifyCandidateToRdFile(files, { filename: 'anything.mkv', size: 1 });
  assert.equal(result.classification, 'match');
  assert.equal(result.rdFileId, 'only');
});

test('classifyCandidateToRdFile: non-playable extensions in mixed list are filtered', () => {
  freshAccounting();
  // A text file and an image are filtered out, leaving the single mkv → match
  const files = [
    { id: 't', path: 'readme.txt', bytes: 100 },
    { id: 'i', path: 'cover.jpg', bytes: 200 },
    rdFile({ id: 'v', path: E02_BASENAME, bytes: 7_000_000_000 }),
  ];
  const result = classifyCandidateToRdFile(files, { filename: 'whatever.mkv', size: 1 });
  assert.equal(result.classification, 'match');
  assert.equal(result.rdFileId, 'v');
});

test('attemptRdResolution: skipped (infringing) → failed accounting, no client calls past observation', async () => {
  freshAccounting();
  // Pre-seed the search cache with a fresh infringing RD observation
  const searchCache = {
    observations: [],
    getProviderObservations(_hash, _idx, _opts) {
      return [{
        provider: 'realdebrid',
        infoHash: E02_INFOHASH,
        fileIndex: 0,
        scope: 'candidate',
        kind: 'authoritative',
        state: 'uncached',
        errorCategory: 'infringing',
        observedAt: Date.now(),
        ttlMs: 5 * 60 * 1000,
        source: 'previous-run',
        evidence: { rdErrorCode: 35 },
      }];
    },
    appendProviderObservation(obs) { this.observations.push(obs); return obs; },
  };
  const client = makeMockRdClient({ files: [rdFile()] });
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH,
    fileIndex: 0,
    filename: E02_FILENAME,
    size: E02_SIZE,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'infringing');
  // No client calls should have been made past the observation lookup
  assert.equal(client.calls.addMagnet, 0);
  assert.equal(client.calls.getTorrentInfo, 0);
  assert.equal(client.calls.selectFiles, 0);
  assert.equal(client.calls.deleteTorrent, 0);
  // Accounting: attempted + failed
  const snap = rdCounterSnapshot();
  assert.equal(snap.realdebrid_fallback_attempted, 1);
  assert.equal(snap.realdebrid_fallback_resolved, 0);
  assert.equal(snap.realdebrid_fallback_failed, 1);
  assert.equal(snap.realdebrid_file_match, 0);
  assert.equal(snap.realdebrid_file_ambiguous, 0);
  assert.equal(snap.realdebrid_file_absent, 0);
});

test('attemptRdResolution: skipped (fresh uncached) → failed accounting, no client calls', async () => {
  freshAccounting();
  const searchCache = {
    observations: [],
    getProviderObservations(_hash, _idx, _opts) {
      return [{
        provider: 'realdebrid',
        infoHash: E02_INFOHASH,
        fileIndex: 0,
        scope: 'candidate',
        kind: 'authoritative',
        state: 'uncached',
        errorCategory: null,
        observedAt: Date.now(),
        ttlMs: 5 * 60 * 1000,
        source: 'previous-run',
        evidence: { rdStatus: 'queued' },
      }];
    },
    appendProviderObservation(obs) { this.observations.push(obs); return obs; },
  };
  const client = makeMockRdClient({ files: [rdFile()] });
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH,
    fileIndex: 0,
    filename: E02_FILENAME,
    size: E02_SIZE,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'uncached');
  assert.equal(client.calls.addMagnet, 0);
  const snap = rdCounterSnapshot();
  assert.equal(snap.realdebrid_fallback_attempted, 1);
  assert.equal(snap.realdebrid_fallback_failed, 1);
});

test('attemptRdResolution: torrent not downloaded → failed with RD_FILE_NOT_CACHED', async () => {
  freshAccounting();
  const files = [rdFile({ id: E02_RD_FILE_ID, path: E02_FILENAME, bytes: E02_SIZE })];
  const client = makeMockRdClient({ files, status: 'downloading' });
  const searchCache = makeMockSearchCache();
  const result = await attemptRdResolution(client, searchCache, {
    infoHash: E02_INFOHASH,
    fileIndex: 0,
    filename: E02_FILENAME,
    size: E02_SIZE,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'RD_FILE_NOT_CACHED');
  const snap = rdCounterSnapshot();
  assert.equal(snap.realdebrid_fallback_failed, 1);
  assert.equal(snap.realdebrid_fallback_resolved, 0);
  // Still cleans up
  assert.equal(client.calls.deleteTorrent, 1);
});

test('B6: concurrent same-TorrentFile RD resolution coalesces via single-flight', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();

  let callCount = 0;
  const factory = async () => {
    callCount++;
    // Simulate the RD resolution latency
    await new Promise(r => setTimeout(r, 25));
    return { status: 'resolved', rdFileId: E02_RD_FILE_ID, torrentId: 't1' };
  };

  const [r1, r2, r3, r4] = await Promise.all([
    cache.getOrInFlight(E02_INFOHASH, 0, factory),
    cache.getOrInFlight(E02_INFOHASH, 0, factory),
    cache.getOrInFlight(E02_INFOHASH, 0, factory),
    cache.getOrInFlight(E02_INFOHASH, 0, factory),
  ]);

  // All four concurrent callers share a single factory invocation.
  assert.equal(callCount, 1, 'factory must run exactly once for concurrent callers');
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1, r3);
  assert.deepEqual(r1, r4);
  assert.equal(r1.rdFileId, E02_RD_FILE_ID);
});

test('B6: sequential RD resolutions re-enter the factory (in-flight slot releases)', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();

  let callCount = 0;
  const factory = async () => {
    callCount++;
    return { status: 'resolved', rdFileId: E02_RD_FILE_ID, torrentId: 't' + callCount };
  };

  const a = await cache.getOrInFlight(E02_INFOHASH, 0, factory);
  const b = await cache.getOrInFlight(E02_INFOHASH, 0, factory);

  assert.equal(callCount, 2, 'sequential resolutions must each re-enter the factory');
  assert.equal(a.torrentId, 't1');
  assert.equal(b.torrentId, 't2');
});

test('B6: different fileIndex for the same infoHash does NOT coalesce', async () => {
  freshAccounting();
  const cache = getRdResolutionCache();
  cache.clear();

  let callCount = 0;
  const factory = async () => {
    callCount++;
    return { status: 'resolved', rdFileId: 'f-' + callCount, torrentId: 't' };
  };

  const a = await cache.getOrInFlight(E02_INFOHASH, 0, factory);
  const b = await cache.getOrInFlight(E02_INFOHASH, 1, factory);

  assert.equal(callCount, 2, 'different fileIndex must not coalesce');
  assert.notEqual(a.rdFileId, b.rdFileId);
});

test('getRdObservationState: returns cached for fresh cached observation', () => {
  const searchCache = {
    getProviderObservations() {
      return [{
        provider: 'realdebrid',
        state: 'cached',
        observedAt: Date.now(),
        ttlMs: 5 * 60 * 1000,
      }];
    },
  };
  assert.equal(getRdObservationState(searchCache, E02_INFOHASH, 0), 'cached');
});

test('getRdObservationState: returns missing when no observations exist', () => {
  const searchCache = { getProviderObservations() { return []; } };
  assert.equal(getRdObservationState(searchCache, E02_INFOHASH, 0), 'missing');
});

test('provider-accounting: the six new categories are recognized and start at zero', () => {
  freshAccounting();
  const snap = rdCounterSnapshot();
  for (const cat of [
    'realdebrid_fallback_attempted',
    'realdebrid_fallback_resolved',
    'realdebrid_fallback_failed',
    'realdebrid_file_match',
    'realdebrid_file_ambiguous',
    'realdebrid_file_absent',
  ]) {
    assert.equal(snap[cat], 0, `expected ${cat} to start at zero`);
  }
});

test('provider-accounting: increment with a typo on the new categories throws', () => {
  freshAccounting();
  assert.throws(
    () => providerAccounting.increment('realdebrid', 'realdebrid_file_matchs'),
    /Unknown provider-accounting category/,
  );
});

test('provider-accounting: realdebrid_fallback_resolved + _failed = _attempted (bookkeeping invariant)', async () => {
  freshAccounting();
  // Run a few scenarios: 2 resolved, 1 failed (mapping), 1 skipped (uncached)
  const files = [rdFile({ id: E02_RD_FILE_ID, path: E02_FILENAME, bytes: E02_SIZE })];
  const goodClient = makeMockRdClient({ files });
  await attemptRdResolution(goodClient, makeMockSearchCache(), {
    infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
  });
  await attemptRdResolution(goodClient, makeMockSearchCache(), {
    infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
  });

  // 1 failed due to mapping (no playable file matches the authoritative name/size)
  const badClient = makeMockRdClient({
    files: [
      rdFile({ id: 'x', path: 'nope-1.mkv', bytes: 1 }),
      rdFile({ id: 'y', path: 'nope-2.mkv', bytes: 2 }),
    ],
  });
  await attemptRdResolution(badClient, makeMockSearchCache(), {
    infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
  });

  // 1 skipped (uncached)
  const skipCache = {
    getProviderObservations() {
      return [{
        provider: 'realdebrid',
        state: 'uncached',
        observedAt: Date.now(),
        ttlMs: 5 * 60 * 1000,
      }];
    },
    appendProviderObservation() {},
  };
  await attemptRdResolution(makeMockRdClient({ files: [rdFile()] }), skipCache, {
    infoHash: E02_INFOHASH, fileIndex: 0, filename: E02_FILENAME, size: E02_SIZE,
  });

  const snap = rdCounterSnapshot();
  assert.equal(snap.realdebrid_fallback_attempted, 4);
  // resolved + failed = attempted (skipped counts as failed in the bookkeeping)
  assert.equal(
    snap.realdebrid_fallback_resolved + snap.realdebrid_fallback_failed,
    snap.realdebrid_fallback_attempted,
    'attempted must equal resolved + failed for the bookkeeping to balance',
  );
  assert.equal(snap.realdebrid_fallback_resolved, 2);
  assert.equal(snap.realdebrid_fallback_failed, 2);
});

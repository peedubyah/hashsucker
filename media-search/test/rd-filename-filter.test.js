/**
 * RD filename-filter predictor — focused table-driven proof.
 *
 * Verifies classifyRdFilenameFilter() and the integration in
 * attemptRdResolution(): blocked filenames short-circuit with zero RD
 * API calls, negative filenames preserve the existing behavior (the
 * resolver proceeds to addMagnet normally), and fresh RD observations
 * always override the local predictor.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  attemptRdResolution,
  classifyRdFilenameFilter,
  getRdObservationState,
} from '../src/lib/providers/realdebrid/resolve.js';
import { providerAccounting } from '../src/lib/providers/provider-accounting.js';

const TEST_INFOHASH = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const TEST_SIZE = 1_000_000_000;

function freshAccounting() {
  providerAccounting.reset();
}

function makeMockRdClient({ status = 'downloaded', files } = {}) {
  const calls = { addMagnet: 0, getTorrentInfo: 0, selectFiles: 0, deleteTorrent: 0, unrestrictLink: 0 };
  const rdFile = files ?? [{ id: 'rd-1', path: 'video.mkv', bytes: TEST_SIZE, selected: false }];
  return {
    calls,
    async addMagnet(_magnet, _opts) {
      calls.addMagnet++;
      return { id: 'torrent-1' };
    },
    async getTorrentInfo(_torrentId, _opts) {
      calls.getTorrentInfo++;
      return {
        id: 'torrent-1',
        status,
        files: rdFile,
        links: ['https://hoster.example/abc'],
      };
    },
    async selectFiles(_torrentId, _fileId, _opts) {
      calls.selectFiles++;
      return { selected: [_fileId] };
    },
    async unrestrictLink(link, _opts) {
      calls.unrestrictLink++;
      return { download: link, filename: 'video.mkv' };
    },
    async deleteTorrent(_torrentId, _opts) {
      calls.deleteTorrent++;
    },
  };
}

// Empty cache — missing observation state — the predictor's active zone
function makeEmptyCache() {
  return {
    observations: [],
    getProviderObservations(_hash, _idx, _opts) {
      return [];
    },
    appendProviderObservation(obs) { this.observations.push(obs); return obs; },
  };
}

// ---------------------------------------------------------------------------
// Pure classifier — table-driven
// ---------------------------------------------------------------------------

const BLOCKED = [
  ['Movie.2026.1080p.AMZN.WEB-DL.DDP5.1.mkv', 'rd_rule_substring_web_dl'],
  ['Show.S01E01.1080p.WEBRip.x265.mkv', 'rd_rule_substring_webrip'],
  ['Movie.1080p.BDRip.x264.avi', 'rd_rule_substring_bdrip'],
  ['Movie.PreDVDRip.x264.avi', 'rd_rule_substring_dvdrip'],
  ['Movie.2026.1080p.BluRay.x264-GROUP', 'rd_rule_dot_bluray_x264'],
  ['Show.S01E01.1080p.HDTV.x264-GROUP', 'rd_rule_dot_hdtv_x264'],
  ['Show.S01E01.1080p.HDTV.XviD-GROUP', 'rd_rule_dot_hdtv_xvid'],
  ['Show.S01E01.1080p.WEB.h264-EDITH', 'rd_rule_dot_web_h264'],
  ['Show.S01E01.1080p.WEB.x264-GROUP', 'rd_rule_dot_web_x264'],
];

const NEGATIVE = [
  'Movie.2026.1080p.Blu-Ray.x264-GROUP',
  'Show.S01E01.1080p.HDTV.h264-GROUP',
  'Movie.2160p.WEB.x265-GROUP',
  'Movie.2160p.WEB.h265-GROUP',
  'Movie.2160p.WEB.HEVC-GROUP',
  'Movie.2160p.REMUX.HEVC-GROUP',
  'Movie.2160p.NF.x264-GROUP',
  null,
  undefined,
  '',
];

test('classifier: blocked filenames match correct rule', () => {
  for (const [filename, expectedRuleId] of BLOCKED) {
    const result = classifyRdFilenameFilter(filename);
    assert.ok(result, `expected match for ${filename}`);
    assert.equal(result.ruleId, expectedRuleId, `rule mismatch for ${filename}`);
  }
});

test('classifier: negative filenames must not match', () => {
  for (const filename of NEGATIVE) {
    const result = classifyRdFilenameFilter(filename);
    assert.equal(result, null, `expected no match for ${String(filename)}`);
  }
});

// ---------------------------------------------------------------------------
// Integration: blocked filename short-circuits with zero RD API calls
// ---------------------------------------------------------------------------

test('integration: blocked filename → skipped, zero addMagnet, accounting fired', async () => {
  freshAccounting();
  const cache = makeEmptyCache();
  const client = makeMockRdClient();

  for (const [filename] of BLOCKED) {
    freshAccounting();
    const result = await attemptRdResolution(client, cache, {
      infoHash: TEST_INFOHASH,
      fileIndex: 0,
      filename,
      size: TEST_SIZE,
    });
    assert.equal(result.status, 'skipped', `status for ${filename}`);
    assert.equal(result.reason, 'rd_filename_filter_match', `reason for ${filename}`);
    assert.ok(result.filter, `filter detail for ${filename}`);
    assert.equal(client.calls.addMagnet, 0, `addMagnet for ${filename}`);
    assert.equal(client.calls.getTorrentInfo, 0, `getTorrentInfo for ${filename}`);
    assert.equal(client.calls.selectFiles, 0, `selectFiles for ${filename}`);
    assert.equal(client.calls.deleteTorrent, 0, `deleteTorrent for ${filename}`);

    const snap = providerAccounting.snapshot();
    assert.equal(snap.providers.realdebrid.perCategory.realdebrid_fallback_failed, 1, `accounting failed for ${filename}`);
    assert.equal(snap.providers.realdebrid.perCategory.realdebrid_filename_filter_short_circuit, 1, `accounting filter for ${filename}`);
  }
});

// ---------------------------------------------------------------------------
// Integration: negative filename preserves existing resolver behavior
// ---------------------------------------------------------------------------

test('integration: negative filename → resolver proceeds (addMagnet called once)', async () => {
  for (const filename of NEGATIVE.filter(f => typeof f === 'string' && f.length > 0)) {
    freshAccounting();
    const cache = makeEmptyCache();
    const client = makeMockRdClient({ status: 'downloaded' });
    const result = await attemptRdResolution(client, cache, {
      infoHash: TEST_INFOHASH,
      fileIndex: 0,
      filename,
      size: TEST_SIZE,
    });
    // The resolver proceeds to addMagnet — it may resolve or fail based on
    // the mock, but it MUST NOT short-circuit with rd_filename_filter_match.
    assert.notEqual(result.reason, 'rd_filename_filter_match', `must not short-circuit for ${filename}`);
    assert.equal(client.calls.addMagnet, 1, `addMagnet must be called for ${filename}`);
    assert.equal(client.calls.getTorrentInfo, 1, `getTorrentInfo must be called for ${filename}`);
  }
});

// ---------------------------------------------------------------------------
// Integration: fresh RD observation overrides the predictor
// ---------------------------------------------------------------------------

test('integration: fresh cached observation → predictor does not fire, resolver proceeds', async () => {
  freshAccounting();
  const cache = {
    getProviderObservations(_hash, _idx, _opts) {
      return [{
        provider: 'realdebrid',
        infoHash: TEST_INFOHASH,
        fileIndex: 0,
        scope: 'candidate',
        kind: 'authoritative',
        state: 'cached',
        errorCategory: null,
        observedAt: Date.now(),
        ttlMs: 5 * 60 * 1000,
        source: 'previous-run',
      }];
    },
    appendProviderObservation() {},
  };
  const client = makeMockRdClient();

  const result = await attemptRdResolution(client, cache, {
    infoHash: TEST_INFOHASH,
    fileIndex: 0,
    filename: 'Movie.1080p.BDRip.x264.avi', // blocked by predictor
    size: TEST_SIZE,
  });
  // Fresh cached observation wins — predictor does NOT fire
  assert.notEqual(result.reason, 'rd_filename_filter_match');
  assert.equal(client.calls.addMagnet, 1, 'addMagnet must be called when cached observation exists');
});

test('integration: fresh infringing observation → predictor does not fire, skipped as infringing', async () => {
  freshAccounting();
  const cache = {
    getProviderObservations(_hash, _idx, _opts) {
      return [{
        provider: 'realdebrid',
        infoHash: TEST_INFOHASH,
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
    appendProviderObservation() {},
  };
  const client = makeMockRdClient();

  const result = await attemptRdResolution(client, cache, {
    infoHash: TEST_INFOHASH,
    fileIndex: 0,
    filename: 'Movie.1080p.BDRip.x264.avi', // blocked by predictor
    size: TEST_SIZE,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'infringing'); // NOT rd_filename_filter_match
  assert.equal(client.calls.addMagnet, 0);
});

// ---------------------------------------------------------------------------
// Integration: predictor does not persist any observation
// ---------------------------------------------------------------------------

test('integration: predictor does NOT persist provider observation', async () => {
  freshAccounting();
  const cache = makeEmptyCache();
  const client = makeMockRdClient();

  await attemptRdResolution(client, cache, {
    infoHash: TEST_INFOHASH,
    fileIndex: 0,
    filename: 'Show.S01E01.1080p.WEB.x264-GROUP',
    size: TEST_SIZE,
  });
  assert.equal(cache.observations.length, 0, 'no observation should be persisted by the predictor');
});

// ---------------------------------------------------------------------------
// Integration: predictor preserves code-35 catch-block semantics
// ---------------------------------------------------------------------------

test('integration: non-blocked filename that RD rejects with code 35 → existing catch block persists infringing observation', async () => {
  freshAccounting();
  const cache = makeEmptyCache();
  const client = {
    calls: { addMagnet: 0, getTorrentInfo: 0, selectFiles: 0, deleteTorrent: 0 },
    async addMagnet(_magnet, _opts) {
      this.calls.addMagnet++;
      throw Object.assign(new Error('Infringing file'), { rdErrorCode: 35, rdError: 'infringing_file' });
    },
    async getTorrentInfo() { this.calls.getTorrentInfo++; return null; },
    async selectFiles() { this.calls.selectFiles++; },
    async deleteTorrent() { this.calls.deleteTorrent++; },
  };

  const result = await attemptRdResolution(client, cache, {
    infoHash: TEST_INFOHASH,
    fileIndex: 0,
    filename: 'Movie.2160p.NF.x264-GROUP', // NOT blocked by predictor
    size: TEST_SIZE,
  });
  // The existing code-35 catch block fires — observation persisted, RD_INFRINGING error
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'RD_INFRINGING');
  assert.equal(cache.observations.length, 1, 'catch block must persist the infringing observation');
  assert.equal(cache.observations[0].errorCategory, 'infringing');
});

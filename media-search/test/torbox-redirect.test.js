/**
 * TorBox Redirect Resolver Tests
 *
 * Tests for the pure-function resolution of selected candidates to
 * TorBox requestdl permalinks. No provider calls, no persistence.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveTorBoxRedirect,
  RedirectResolutionError,
  formatRedirectLog,
} from '../src/lib/resolver/torbox-redirect.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';

/**
 * Create a mock control plane store with placement + file mapping.
 */
function createMockControlPlane(placement, mapping) {
  return {
    findPlacementByInfoHash: (_provider, _infoHash) => placement,
    findFileMapping: (_releaseKey, _placementId) => mapping,
  };
}

test('resolveTorBoxRedirect: resolves valid selection to TorBox permalink', () => {
  const placement = {
    id: 'pl_test',
    provider: 'torbox',
    providerResourceId: '12345',
    infoHash: HASH,
  };
  const mapping = {
    id: 'fm_test',
    releaseKey: `${HASH}:torrent`,
    placementId: 'pl_test',
    providerFileId: '67890',
    state: 'mapped',
    method: 'test',
  };

  const selection = {
    status: 'selected',
    mediaId: 'tt1234567',
    mediaType: 'movie',
    releaseKey: `${HASH}:torrent`,
    selectedHash: HASH,
    fileIndex: null,
    provider: 'torbox',
    providerState: 'cached',
    reason: 'test selection',
  };

  const cp = createMockControlPlane(placement, mapping);
  const result = resolveTorBoxRedirect(selection, cp);

  assert.equal(result.status, 'redirect');
  assert.equal(result.provider, 'torbox');
  assert.equal(result.torrentId, '12345');
  assert.equal(result.providerFileId, '67890');
  assert.match(result.redirectUrl, /torrents\/requestdl/);
  assert.match(result.redirectUrl, /torrent_id=12345/);
  assert.match(result.redirectUrl, /file_id=67890/);
});

test('resolveTorBoxRedirect: uses fileIndex in releaseKey when not null', () => {
  const placement = {
    id: 'pl_test',
    provider: 'torbox',
    providerResourceId: '99999',
    infoHash: HASH,
  };
  const mapping = {
    id: 'fm_test',
    releaseKey: `${HASH}:7`,
    placementId: 'pl_test',
    providerFileId: '42',
    state: 'mapped',
    method: 'test',
  };

  const selection = {
    status: 'selected',
    mediaId: 'tt0944947',
    mediaType: 'series',
    releaseKey: `${HASH}:7`,
    selectedHash: HASH,
    fileIndex: 7,
    provider: 'torbox',
    providerState: 'cached',
    reason: 'test selection',
  };

  const cp = createMockControlPlane(placement, mapping);
  const result = resolveTorBoxRedirect(selection, cp);

  assert.equal(result.releaseKey, `${HASH}:7`);
  assert.equal(result.providerFileId, '42');
  assert.match(result.redirectUrl, /file_id=42/);
  // CRITICAL: fileIndex is never coerced — null stays null, 7 stays 7
  assert.equal(result.fileIndex, 7);
});

test('resolveTorBoxRedirect: null fileIndex is NOT coerced to 0', () => {
  const placement = {
    id: 'pl_test',
    provider: 'torbox',
    providerResourceId: '11111',
    infoHash: HASH,
  };
  // TorBox file_id can be 0 — but fileIndex=null is torrent-level
  // The mapping must use the ACTUAL TorBox file_id, not an assumed 0
  const mapping = {
    id: 'fm_test',
    releaseKey: `${HASH}:torrent`,
    placementId: 'pl_test',
    providerFileId: '0',
    state: 'mapped',
    method: 'test',
  };

  const selection = {
    status: 'selected',
    mediaId: 'tt1234567',
    mediaType: 'movie',
    releaseKey: `${HASH}:torrent`,
    selectedHash: HASH,
    fileIndex: null,
    provider: 'torbox',
    providerState: 'cached',
  };

  const cp = createMockControlPlane(placement, mapping);
  const result = resolveTorBoxRedirect(selection, cp);

  // fileIndex stays null — never coerced to 0
  assert.equal(result.fileIndex, null);
  // The permalink uses the provider's file_id=0 from the mapping
  assert.equal(result.providerFileId, '0');
  assert.match(result.redirectUrl, /file_id=0/);
});

test('resolveTorBoxRedirect: throws NO_SELECTION when status is not selected', () => {
  const cp = createMockControlPlane(null, null);
  assert.throws(
    () => resolveTorBoxRedirect({ status: 'debug' }, cp),
    (err) => {
      assert.ok(err instanceof RedirectResolutionError);
      assert.equal(err.code, 'NO_SELECTION');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('resolveTorBoxRedirect: throws PROVIDER_NOT_TORBOX for non-TorBox provider', () => {
  const selection = {
    status: 'selected',
    mediaId: 'tt1234567',
    mediaType: 'movie',
    releaseKey: `${HASH}:torrent`,
    selectedHash: HASH,
    fileIndex: null,
    provider: 'realdebrid',
    providerState: 'cached',
  };

  const cp = createMockControlPlane(null, null);
  assert.throws(
    () => resolveTorBoxRedirect(selection, cp),
    (err) => {
      assert.ok(err instanceof RedirectResolutionError);
      assert.equal(err.code, 'PROVIDER_NOT_TORBOX');
      assert.equal(err.status, 400);
      return true;
    }
  );
});

test('resolveTorBoxRedirect: throws MISSING_TORRENT_MAPPING when no placement', () => {
  const selection = {
    status: 'selected',
    mediaId: 'tt1234567',
    mediaType: 'movie',
    releaseKey: `${HASH}:torrent`,
    selectedHash: HASH,
    fileIndex: null,
    provider: 'torbox',
    providerState: 'cached',
  };

  const cp = createMockControlPlane(null, null);
  assert.throws(
    () => resolveTorBoxRedirect(selection, cp),
    (err) => {
      assert.ok(err instanceof RedirectResolutionError);
      assert.equal(err.code, 'MISSING_TORRENT_MAPPING');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('resolveTorBoxRedirect: throws MISSING_FILE_MAPPING when no mapping', () => {
  const placement = {
    id: 'pl_test',
    provider: 'torbox',
    providerResourceId: '12345',
    infoHash: HASH,
  };

  const selection = {
    status: 'selected',
    mediaId: 'tt1234567',
    mediaType: 'movie',
    releaseKey: `${HASH}:torrent`,
    selectedHash: HASH,
    fileIndex: null,
    provider: 'torbox',
    providerState: 'cached',
  };

  const cp = createMockControlPlane(placement, null);
  assert.throws(
    () => resolveTorBoxRedirect(selection, cp),
    (err) => {
      assert.ok(err instanceof RedirectResolutionError);
      assert.equal(err.code, 'MISSING_FILE_MAPPING');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('resolveTorBoxRedirect: throws MAPPING_NOT_MAPPED for non-mapped state', () => {
  const placement = {
    id: 'pl_test',
    provider: 'torbox',
    providerResourceId: '12345',
    infoHash: HASH,
  };
  const mapping = {
    id: 'fm_test',
    releaseKey: `${HASH}:torrent`,
    placementId: 'pl_test',
    providerFileId: '67890',
    state: 'stale', // Not 'mapped'
    method: 'test',
  };

  const selection = {
    status: 'selected',
    mediaId: 'tt1234567',
    mediaType: 'movie',
    releaseKey: `${HASH}:torrent`,
    selectedHash: HASH,
    fileIndex: null,
    provider: 'torbox',
    providerState: 'cached',
  };

  const cp = createMockControlPlane(placement, mapping);
  assert.throws(
    () => resolveTorBoxRedirect(selection, cp),
    (err) => {
      assert.ok(err instanceof RedirectResolutionError);
      assert.equal(err.code, 'MAPPING_NOT_MAPPED');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('formatRedirectLog: excludes API key, includes operational fields', () => {
  const result = {
    status: 'redirect',
    redirectUrl: 'https://api.torbox.app/v1/api/torrents/requestdl?token=SECRET&torrent_id=12345&file_id=67890',
    provider: 'torbox',
    torrentId: '12345',
    providerFileId: '67890',
    releaseKey: `${HASH}:torrent`,
    infoHash: HASH,
    fileIndex: null,
    mediaId: 'tt1234567',
    mediaType: 'movie',
  };

  const log = formatRedirectLog(result);
  assert.equal(log.mediaId, 'tt1234567');
  assert.equal(log.releaseKey, `${HASH}:torrent`);
  assert.equal(log.torrentId, '12345');
  assert.equal(log.providerFileId, '67890');
  // No API key in log
  assert.ok(!JSON.stringify(log).includes('SECRET'));
});

test('RedirectResolutionError: has correct name and properties', () => {
  const err = new RedirectResolutionError('test', 'TEST_CODE', 400);
  assert.equal(err.name, 'RedirectResolutionError');
  assert.equal(err.message, 'test');
  assert.equal(err.code, 'TEST_CODE');
  assert.equal(err.status, 400);
});

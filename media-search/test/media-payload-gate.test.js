import assert from 'node:assert/strict';
import test from 'node:test';
import { selectBindableCandidate } from '../src/lib/discovery/selection.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
function candidate(filename, rank = 1) {
  return { infoHash: HASH, fileIndex: null, filename, rank, identity: { eligible: true, tier: 'Verified' }, release: {}, availability: { torbox: { state: 'cached' } } };
}
function store(path) {
  return { getTorrentFile: () => ({ id: 'tf', infoHash: HASH, internalPath: path, size: 100 }) };
}

test('cached non-media payload is rejected before binding', async () => {
  const result = await selectBindableCandidate([candidate('Lanterns.S01E01.exe')], {
    controlPlaneStore: store('Lanterns.S01E01.exe'),
    ensureTorBoxFileIdentityFn: async () => ({ torrentFileId: 'tf', placementId: 'p', providerFileId: 'f', size: 100 }),
  });
  assert.equal(result.selected, null);
});

test('valid video payload remains bindable', async () => {
  const result = await selectBindableCandidate([candidate('Lanterns.S01E01.mkv')], {
    controlPlaneStore: store('Lanterns.S01E01.mkv'),
    tvCoordinates: { season: 1, episode: 1 },
    resolveTvTorrentFileFn: () => ({ torrentFile: { id: 'tf', infoHash: HASH, internalPath: 'Lanterns.S01E01.mkv', size: 100 } }),
    ensureTorBoxFileIdentityFn: async () => ({ torrentFileId: 'tf', placementId: 'p', providerFileId: 'f', size: 100, torrentFiles: [{ id: 'tf', infoHash: HASH, internalPath: 'Lanterns.S01E01.mkv', size: 100 }] }),
  });
  assert.equal(result.selected._torrentFileId, 'tf');
});

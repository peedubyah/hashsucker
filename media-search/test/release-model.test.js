import assert from 'node:assert/strict';
import test from 'node:test';

import { filterReleases, isReleaseSelected, prepareReleases, releaseFilterOptions, releaseUtilityActions, requestPaneView, summarizeReleases } from '../src/ui/release-model.js';

const release = (hash, cached, resolution, size = 1) => ({ infoHash: hash, resolution, size, providers: { torbox: { cached } } });

test('releases dedupe only by exact hash and sort cached then resolution then size', () => {
  const items = prepareReleases([
    release('a', false, '2160p', 100),
    release('b', true, '1080p', 20),
    release('a', true, '1080p', 10),
    release('c', true, '2160p', 30),
    release('d', true, '2160p', 40),
  ]);
  assert.deepEqual(items.map((item) => item.infoHash), ['d', 'c', 'b', 'a']);
  assert.equal(summarizeReleases(items).cached, 3);
  assert.deepEqual(filterReleases(items, { cached: true, resolution: '2160p' }).map((item) => item.infoHash), ['d', 'c']);
});

test('distinct hashes remain even when titles match', () => {
  assert.equal(prepareReleases([{ ...release('a', true), title: 'same' }, { ...release('b', true), title: 'same' }]).length, 2);
});

test('filter options derive from the full normalized dataset in stable order', () => {
  const releases = prepareReleases([
    { ...release('a', true, '1080p'), codec: 'x265' },
    { ...release('b', false, '2160p'), codec: 'AV1' },
    { ...release('c', false, '720p'), codec: 'x264' },
    { ...release('d', false, '1080p'), codec: 'x265' },
  ]);
  assert.deepEqual(releaseFilterOptions(releases), {
    resolutions: [{ value: '2160p', label: '2160p / 4K' }, { value: '1080p', label: '1080p' }, { value: '720p', label: '720p' }],
    codecs: [{ value: 'hevc', label: 'HEVC / x265' }, { value: 'avc', label: 'AVC / x264' }, { value: 'av1', label: 'AV1' }],
    hdr: [],
  });
  assert.equal(filterReleases(releases, { resolution: '2160p' }).length, 1);
  assert.equal(filterReleases(releases, { codec: 'hevc' }).length, 2);
  assert.equal(releaseFilterOptions(releases).codecs.length, 3);
});

test('HDR categories and optional maximum size use normalized metadata without a default cap', () => {
  const gib = 1024 ** 3;
  const releases = [
    { ...release('a', true, '2160p', 10 * gib), hdr: 'HDR10' },
    { ...release('b', true, '2160p', 20 * gib), hdr: 'DV' },
    { ...release('c', true, '1080p', null), hdr: 'HLG' },
  ];
  assert.deepEqual(releaseFilterOptions(releases).hdr.map((option) => option.value), ['hdr', 'dv', 'hlg']);
  assert.equal(filterReleases(releases, { hdr: 'dv', maxSizeGb: null }).length, 1);
  assert.equal(filterReleases(releases, { maxSizeGb: 15 }).length, 1);
  assert.equal(filterReleases(releases, { maxSizeGb: null }).length, 3);
});

test('a row is selected only when populated selection has the same exact hash', () => {
  const row = release('abcdef', true, '2160p');
  assert.equal(isReleaseSelected(row, null), false);
  assert.equal(isReleaseSelected(row, release('other', true, '2160p')), false);
  assert.equal(isReleaseSelected(row, release('ABCDEF', false, '1080p')), true);
});

test('request pane transitions from progress to terminal completion or failure', () => {
  assert.deepEqual(requestPaneView('processing', 'Black Mirror S07E04'), {
    heading: 'Request in progress', message: 'Black Mirror S07E04 is processing.', terminal: false, failed: false,
  });
  assert.equal(requestPaneView('done', 'Black Mirror S07E04').heading, 'Request complete');
  assert.equal(requestPaneView('done', 'Black Mirror S07E04').terminal, true);
  assert.equal(requestPaneView('failed', 'Black Mirror S07E04').failed, true);
});

test('release utilities expose only a validated infoHash and reconstructed magnet', () => {
  const hash = '0123456789abcdef0123456789abcdef01234567';
  assert.deepEqual(releaseUtilityActions({ infoHash: hash, filename: 'Season Pack' }), {
    infoHash: hash,
    magnet: `magnet:?xt=urn:btih:${hash}&dn=Season%20Pack`,
  });
  assert.equal(releaseUtilityActions({ infoHash: 'not-a-hash', url: 'https://provider.example/secret' }), null);
});

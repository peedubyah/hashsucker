import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeStream } from '../src/lib/stremio/normalize.js';

const HASH = '71cb32009732b7361bd85e0566cc4dd8a0a2326f';
const OTHER_HASH = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('extracts Comet TorBox infoHash when bingeGroup and playback URL agree', () => {
  const stream = normalizeStream({
    name: '[TB] Comet 2160p',
    url: `https://comet.example/config/playback/${HASH}/0/0/n/n`,
    behaviorHints: {
      bingeGroup: `comet|torbox|${HASH}`,
      filename: 'Example.Movie.2160p.mkv',
      videoSize: 123456789,
    },
  });

  assert.ok(stream);
  assert.equal(stream.infoHash, HASH);
  assert.equal(stream.key, `ih:${HASH}`);
  assert.equal(stream.url, null);
});

test('refuses Comet TorBox infoHash when bingeGroup and playback URL disagree', () => {
  const stream = normalizeStream({
    name: '[TB] Comet 2160p',
    url: `https://comet.example/config/playback/${OTHER_HASH}/0/0/n/n`,
    behaviorHints: {
      bingeGroup: `comet|torbox|${HASH}`,
      filename: 'Example.Movie.2160p.mkv',
    },
  });

  assert.ok(stream);
  assert.equal(stream.infoHash, null);
  assert.match(stream.key, /^url:/);
});

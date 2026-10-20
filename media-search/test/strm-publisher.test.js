/**
 * STRM Publisher Tests
 *
 * Tests for `publishStrm` URL-building behavior. The STRM file MUST carry
 * exact media identity:
 *   - movies: /stream/movie/<imdb>
 *   - series: /stream/series/<imdb>?season=N&episode=N
 *
 * Series URLs without season/episode land the resolver on the wrong handoff
 * (the latest handoff for the media_id, not the episode-specific row). This
 * test pins that contract.
 *
 * Test strategy: redirect STRM_OUTPUT_PATH to a per-process temp directory so
 * the publisher writes real files without polluting the production tree.
 * Pass the title on the HANDOFF (`canonicalTitle`) — that is the identity
 * authority, and it short-circuits the catalog lookup (which would require
 * a network or stub).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

process.env.STRM_OUTPUT_PATH = fsSync.mkdtempSync(path.join(os.tmpdir(), 'strm-pub-'));

const { publishStrm } = await import('../src/lib/requests/strm-publisher.js');

async function readStrm(filePath) {
  return (await fs.readFile(filePath, 'utf8')).trim();
}

function seriesHandoff({ mediaId, season, episode }) {
  return {
    mediaId,
    mediaType: 'series',
    season,
    episode,
    releaseKey: `0d9b239b02f5fa8c4cdda71f3ccfde93ae918bd9:${episode - 1}`,
    filename: `series.s${season}e${episode}.mkv`,
  };
}

function movieHandoff({ mediaId, canonicalTitle = 'Movie', canonicalYear = 2024 }) {
  return {
    mediaId,
    mediaType: 'movie',
    season: null,
    episode: null,
    releaseKey: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0',
    filename: 'Movie (2024).mkv',
    canonicalTitle,
    canonicalYear,
  };
}

const selectionFor = (title) => ({ selected: { release: { title, year: 2024 } } });

test('publishStrm: series URL carries season and episode query params', async () => {
  const handoff = seriesHandoff({ mediaId: 'tt0903747', season: 1, episode: 3 });
  const result = await publishStrm({
    handoff,
    selection: selectionFor('Breaking Bad'),
  });
  assert.equal(result.published, true);
  const url = await readStrm(result.path);
  assert.equal(
    url,
    'http://localhost:8080/stream/series/tt0903747?season=1&episode=3',
    'series STRM must carry exact season and episode',
  );
});

test('publishStrm: movie URL has no season/episode params', async () => {
  const handoff = movieHandoff({ mediaId: 'tt1234567' });
  const result = await publishStrm({
    handoff,
    selection: selectionFor('Movie Title'),
  });
  assert.equal(result.published, true);
  const url = await readStrm(result.path);
  assert.equal(
    url,
    'http://localhost:8080/stream/movie/tt1234567',
    'movie STRM must NOT carry season/episode query params',
  );
});

test('publishStrm: distinct episodes publish distinct URLs', async () => {
  const urls = [];
  for (const ep of [1, 2, 3]) {
    const handoff = seriesHandoff({ mediaId: 'tt0903747', season: 1, episode: ep });
    const result = await publishStrm({
      handoff,
      selection: selectionFor('Breaking Bad'),
    });
    assert.equal(result.published, true);
    urls.push(await readStrm(result.path));
  }
  assert.deepEqual(urls, [
    'http://localhost:8080/stream/series/tt0903747?season=1&episode=1',
    'http://localhost:8080/stream/series/tt0903747?season=1&episode=2',
    'http://localhost:8080/stream/series/tt0903747?season=1&episode=3',
  ]);
  assert.equal(new Set(urls).size, urls.length, 'URLs must be distinct per episode');
});

test('publishStrm: title uses the canonical presentation rule shared with VFS', async () => {
  const cases = [
    // [input title, year, expected dir base, expected file]
    ['Dune: Part Two', 2024, 'Dune Part Two (2024)', 'Dune Part Two (2024).strm'],
    ['Black Panther', 2018, 'Black Panther (2018)', 'Black Panther (2018).strm'],
    ['A/B: C? "D"', 2020, 'A B C D (2020)', 'A B C D (2020).strm'],
  ];
  for (const [title, year, dirBase, file] of cases) {
    // The title travels on the handoff: the request's canonical title is
    // the identity authority (the release attributes are not).
    const handoff = movieHandoff({ mediaId: `tt_canon_${year}`, canonicalTitle: title, canonicalYear: year });
    const result = await publishStrm({ handoff });
    assert.equal(result.published, true);
    assert.ok(
      result.path.endsWith(path.join('Movies', dirBase, file)),
      `canonical path for ${JSON.stringify(title)}: got ${result.path}`,
    );
    assert.ok(!result.path.includes('_'), `no underscore artifacts: ${result.path}`);
  }
});

test('publishStrm: a legacy publication is ADOPTED where it is, not renamed and not duplicated', async () => {
  const root = process.env.STRM_OUTPUT_PATH;
  const legacyDir = path.join(root, 'Movies', 'Test_ Migration Case (2030)');
  const legacyFile = path.join(legacyDir, 'Test_ Migration Case (2030).strm');
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(legacyFile, 'http://localhost:8080/stream/movie/tt_mig_1\n', 'utf8');

  // The handoff names the media differently from the legacy artifact. A
  // publication must not move the artifact the consumer already has, and
  // must not write a second one beside it: the CONTENT identifies the
  // artifact, so the existing one is adopted where it is.
  const handoff = movieHandoff({
    mediaId: 'tt_mig_1', canonicalTitle: 'Test: Migration Case', canonicalYear: 2030,
  });
  const result = await publishStrm({ handoff });
  assert.equal(result.published, true);
  assert.equal(result.path, legacyFile, 'the existing artifact is adopted where it is');
  assert.equal(await readStrm(result.path), 'http://localhost:8080/stream/movie/tt_mig_1');
  const files = await fs.readdir(legacyDir);
  assert.equal(files.length, 1, 'no duplicate artifact was written');
});
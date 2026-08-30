/**
 * Seerr TV Helpers — Focused Helper Tests (Pass 1)
 *
 * Scope: parseRequestedSeasons + resolveSeerrSeasonEpisodes only.
 * Does NOT touch handleSeerrIngress, searchByMedia, the DB, or production.
 *
 * Run:
 *   node --test test/seerr-tv-helpers.test.js
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  parseRequestedSeasons,
  resolveSeerrSeasonEpisodes,
} from '../src/lib/intents/providers/seerr.js';

// ---------------------------------------------------------------------------
// parseRequestedSeasons
// ---------------------------------------------------------------------------

test('parseRequestedSeasons: comma-joined value → trimmed, deduped, sorted positive integers', () => {
  const r = parseRequestedSeasons([
    { name: 'Requested Seasons', value: '3, 1, 2, 1' },
  ]);
  assert.equal(r.valid, true);
  assert.deepEqual(r.seasons, [1, 2, 3], 'duplicates removed, ascending numeric sort');
});

test('parseRequestedSeasons: trims whitespace around tokens', () => {
  const r = parseRequestedSeasons([
    { name: 'Requested Seasons', value: ' 2 , 1 ' },
  ]);
  assert.equal(r.valid, true);
  assert.deepEqual(r.seasons, [1, 2]);
});

test('parseRequestedSeasons: case-insensitive name match', () => {
  const r = parseRequestedSeasons([
    { name: 'requested seasons', value: '1' },
  ]);
  assert.equal(r.valid, true);
  assert.deepEqual(r.seasons, [1]);
});

test('parseRequestedSeasons: skips empty segments from stray commas', () => {
  const r = parseRequestedSeasons([
    { name: 'Requested Seasons', value: '1,,2,' },
  ]);
  assert.equal(r.valid, true);
  assert.deepEqual(r.seasons, [1, 2]);
});

test('parseRequestedSeasons: no "Requested Seasons" entry → explicit failure (never "all seasons")', () => {
  for (const extra of [[], [{ name: 'Other', value: '1' }]]) {
    const r = parseRequestedSeasons(extra);
    assert.equal(r.valid, false, `expected failure for extra=${JSON.stringify(extra)}`);
    assert.equal(r.reason, 'requested-seasons-missing');
  }
});

test('parseRequestedSeasons: extra is not an array → explicit failure', () => {
  for (const bad of [null, undefined, 'string', 42, { foo: 'bar' }]) {
    const r = parseRequestedSeasons(bad);
    assert.equal(r.valid, false, `expected failure for ${JSON.stringify(bad)}`);
    assert.equal(r.reason, 'extra-not-an-array');
  }
});

test('parseRequestedSeasons: value is not a string → explicit failure', () => {
  for (const bad of [123, ['1', '2'], { nested: true }, true]) {
    const r = parseRequestedSeasons([{ name: 'Requested Seasons', value: bad }]);
    assert.equal(r.valid, false, `expected failure for ${JSON.stringify(bad)}`);
    assert.equal(r.reason, 'extra-season-value-not-a-string');
  }
});

test('parseRequestedSeasons: empty/whitespace value → explicit failure (never "all seasons")', () => {
  for (const empty of ['', '   ', '\t', '\n']) {
    const r = parseRequestedSeasons([{ name: 'Requested Seasons', value: empty }]);
    assert.equal(r.valid, false, `expected failure for value=${JSON.stringify(empty)}`);
    assert.equal(r.reason, 'extra-season-value-empty');
  }
});

test('parseRequestedSeasons: non-numeric token → explicit failure', () => {
  const r = parseRequestedSeasons([
    { name: 'Requested Seasons', value: 'Season 1, 3' },
  ]);
  assert.equal(r.valid, false);
  assert.match(r.reason, /extra-season-value-not-positive-integer:Season 1/);
});

test('parseRequestedSeasons: zero/negative token → explicit failure', () => {
  for (const bad of ['0', '-1', '0, 1', '1, -2']) {
    const r = parseRequestedSeasons([{ name: 'Requested Seasons', value: bad }]);
    assert.equal(r.valid, false, `expected failure for value=${bad}`);
    assert.match(r.reason, /extra-season-value-not-positive-integer/);
  }
});

test('parseRequestedSeasons: float token → explicit failure', () => {
  const r = parseRequestedSeasons([
    { name: 'Requested Seasons', value: '1.5, 2' },
  ]);
  assert.equal(r.valid, false);
  assert.match(r.reason, /extra-season-value-not-positive-integer/);
});

test('parseRequestedSeasons: single value is parsed as a one-element array', () => {
  const r = parseRequestedSeasons([
    { name: 'Requested Seasons', value: '7' },
  ]);
  assert.equal(r.valid, true);
  assert.deepEqual(r.seasons, [7]);
});

// ---------------------------------------------------------------------------
// resolveSeerrSeasonEpisodes
// ---------------------------------------------------------------------------

test('resolveSeerrSeasonEpisodes: hits /api/v1/tv/<id>/season/<n> and maps episode fields', async () => {
  let lastPath = null;
  const seerrStub = http.createServer((req, res) => {
    lastPath = req.url;
    assert.equal(req.method, 'GET');
    assert.equal(req.headers['x-api-key'], 'k');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      seasonNumber: 1,
      name: 'Season 1',
      episodes: [
        { episodeNumber: 1, name: 'Pilot', airDate: '2008-01-20', id: 62085 },
        { episodeNumber: 2, name: "Cat's in the Bag...", airDate: '2008-01-27', id: 62086 },
        { episodeNumber: 7, name: 'Nothing Happens', airDate: '2008-03-09', id: 62091 },
      ],
    }));
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    const eps = await resolveSeerrSeasonEpisodes(
      1396,
      1,
      { SEERR_URL: `http://127.0.0.1:${port}`, SEERR_API_KEY: 'k' },
    );
    assert.equal(lastPath, '/api/v1/tv/1396/season/1');
    assert.equal(eps.length, 3);
    assert.deepEqual(
      eps.map((e) => e.episodeNumber),
      [1, 2, 7],
    );
    assert.equal(eps[0].name, 'Pilot');
    assert.equal(eps[0].airDate, '2008-01-20');
    assert.equal(eps[0].id, 62085);
    assert.equal(eps[2].episodeNumber, 7);
  } finally {
    seerrStub.close();
  }
});

test('resolveSeerrSeasonEpisodes: missing env → throws identity-misconfigured', async () => {
  await assert.rejects(
    resolveSeerrSeasonEpisodes(1396, 1, { SEERR_URL: '', SEERR_API_KEY: '' }),
    (err) => err.code === 'identity-misconfigured',
  );
});

test('resolveSeerrSeasonEpisodes: 404 → throws identity-not-found', async () => {
  const seerrStub = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    await assert.rejects(
      resolveSeerrSeasonEpisodes(9999, 1, {
        SEERR_URL: `http://127.0.0.1:${port}`,
        SEERR_API_KEY: 'k',
      }),
      (err) => err.code === 'identity-not-found' && err.status === 404,
    );
  } finally {
    seerrStub.close();
  }
});

test('resolveSeerrSeasonEpisodes: 500 → throws identity-unavailable', async () => {
  const seerrStub = http.createServer((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    await assert.rejects(
      resolveSeerrSeasonEpisodes(1396, 1, {
        SEERR_URL: `http://127.0.0.1:${port}`,
        SEERR_API_KEY: 'k',
      }),
      (err) => err.code === 'identity-unavailable' && err.status === 500,
    );
  } finally {
    seerrStub.close();
  }
});

test('resolveSeerrSeasonEpisodes: non-JSON body → throws identity-unparseable', async () => {
  const seerrStub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('not json');
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    await assert.rejects(
      resolveSeerrSeasonEpisodes(1396, 1, {
        SEERR_URL: `http://127.0.0.1:${port}`,
        SEERR_API_KEY: 'k',
      }),
      (err) => err.code === 'identity-unparseable',
    );
  } finally {
    seerrStub.close();
  }
});

test('resolveSeerrSeasonEpisodes: body without episodes array → empty list', async () => {
  const seerrStub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ seasonNumber: 1, name: 'Season 1' }));
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    const eps = await resolveSeerrSeasonEpisodes(1396, 1, {
      SEERR_URL: `http://127.0.0.1:${port}`,
      SEERR_API_KEY: 'k',
    });
    assert.deepEqual(eps, []);
  } finally {
    seerrStub.close();
  }
});

test('resolveSeerrSeasonEpisodes: filters out episodes with missing/non-positive episodeNumber', async () => {
  const seerrStub = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      seasonNumber: 1,
      episodes: [
        { episodeNumber: 1, name: 'good', airDate: '2020-01-01', id: 1 },
        { episodeNumber: 0, name: 'zero', airDate: null, id: 2 },
        { episodeNumber: -1, name: 'negative', airDate: null, id: 3 },
        { name: 'no-number', airDate: null, id: 4 },
        { episodeNumber: 2, name: 'also-good', airDate: '2020-01-02', id: 5 },
      ],
    }));
  });
  await new Promise((r) => seerrStub.listen(0, '127.0.0.1', r));
  try {
    const port = seerrStub.address().port;
    const eps = await resolveSeerrSeasonEpisodes(1396, 1, {
      SEERR_URL: `http://127.0.0.1:${port}`,
      SEERR_API_KEY: 'k',
    });
    assert.deepEqual(eps.map((e) => e.episodeNumber), [1, 2]);
  } finally {
    seerrStub.close();
  }
});

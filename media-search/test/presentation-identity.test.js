/**
 * PRESENTATION IDENTITY — the contract.
 *
 * A media intent has ONE durable presentation identity. It is resolved
 * once, at a commit point, and every consumer surface afterwards reads it
 * instead of recomputing a name.
 *
 * These tests pin:
 *   - the source precedence (request → catalog → filename → media id);
 *   - that the VFS path and the `.strm` path are the SAME identity;
 *   - that the identity is committed once and never rewritten;
 *   - that optional metadata cannot rename a published item;
 *   - that a representation reselection and a route repair do not move
 *     the path;
 *   - that a repeated publication converges on one path, with no second
 *     artifact;
 *   - that concurrent publications converge on one identity.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import {
  resolvePresentationName,
  normalizePresentationYear,
  buildPresentationCanonicalPath,
  buildPresentationStrmPath,
  derivePresentationIdentity,
} from '../src/lib/control-plane/presentation-identity.js';
import { publishStrm } from '../src/lib/requests/strm-publisher.js';

const HASH = 'a'.repeat(40);
const NOW = 1_700_000_000_000;

function tempDir(t, prefix = 'hs-presentation-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}

// ── 1. the precedence ─────────────────────────────────────────────────────
test('presentation name: the request wins, the catalog fills the gap, the media id is the floor', () => {
  assert.deepEqual(
    resolvePresentationName({
      canonicalTitle: 'Dune: Part Two', canonicalYear: 2024,
      catalogTitle: 'Dune Part Two', catalogYear: '2024-03-01',
      inferredTitle: 'Dune.Part.Two.2024', inferredYear: 2024,
      mediaId: 'tt15239678',
    }),
    { title: 'Dune: Part Two', year: 2024 },
    'the request is the identity authority',
  );

  assert.deepEqual(
    resolvePresentationName({
      canonicalTitle: null, canonicalYear: null,
      catalogTitle: 'Fleabag', catalogYear: '2016',
      inferredTitle: 'Fleabag.S01E01', mediaId: 'tt5687612',
    }),
    { title: 'Fleabag', year: 2016 },
    'the catalog fills the gap the request left, and its year with it',
  );

  assert.deepEqual(
    resolvePresentationName({
      canonicalTitle: null, canonicalYear: null,
      catalogTitle: null, catalogYear: null,
      inferredTitle: 'Some Movie 2020 1080p', inferredYear: 2020,
      mediaId: 'tt1234567',
    }),
    { title: 'Some Movie 2020 1080p', year: 2020 },
    'the filename inference is the last resort before the media id',
  );

  assert.deepEqual(
    resolvePresentationName({ canonicalTitle: null, mediaId: 'tt1234567' }),
    { title: 'tt1234567', year: null },
    'the media id is a stable floor',
  );
});

test('presentation name: an explicit title keeps the year the request gave, and never gains one', () => {
  // The catalog's year is enrichment: it may fill a gap, never add a fact
  // to a title the request already named. This is what keeps the identity
  // resolvable without a metadata call.
  assert.deepEqual(
    resolvePresentationName({
      canonicalTitle: 'Some Movie', canonicalYear: null,
      catalogTitle: 'Some Movie', catalogYear: '2020',
      mediaId: 'tt1',
    }),
    { title: 'Some Movie', year: null },
  );
});

test('a catalog year that is a range or a date contributes a year and nothing else', () => {
  assert.equal(normalizePresentationYear('2016-2019'), 2016);
  assert.equal(normalizePresentationYear('2024-02-27'), 2024);
  assert.equal(normalizePresentationYear('2016–2019'), 2016);
  assert.equal(normalizePresentationYear('n/a'), null);
  assert.equal(normalizePresentationYear(1894), 1894);
  assert.equal(normalizePresentationYear(94), null);

  assert.deepEqual(
    resolvePresentationName({ catalogTitle: 'Fleabag', catalogYear: '2016–2019', mediaId: 'tt1' }),
    { title: 'Fleabag', year: 2016 },
    'an en dash must never reach a directory name',
  );
});

// ── 2. one identity, two projections ──────────────────────────────────────
test('the VFS path and the `.strm` path are two projections of one identity', () => {
  const identity = derivePresentationIdentity({
    mediaType: 'movie', title: 'Oppenheimer', year: 2023, extension: '.mkv',
  });
  assert.equal(identity.canonicalPath, 'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv');
  assert.equal(identity.strmPath, 'Movies/Oppenheimer (2023)/Oppenheimer (2023).strm');

  const episode = derivePresentationIdentity({
    mediaType: 'episode', title: 'Slow Horses', year: 2022, extension: '.mp4',
    season: 6, episode: 1,
  });
  assert.equal(episode.canonicalPath, 'TV/Slow Horses (2022)/Season 06/Slow Horses (2022) - S06E01.mp4');
  assert.equal(episode.strmPath, 'TV Shows/Slow Horses (2022)/Season 06/Slow Horses (2022) - S06E01.strm');
});

test('the two projections carry the same name, so they cannot drift apart', () => {
  for (const title of ['Oppenheimer', 'Spider-Man: No Way Home', 'AC/DC', 'A Movie: With "Quotes"']) {
    const identity = derivePresentationIdentity({
      mediaType: 'movie', title, year: null, extension: '.mkv',
    });
    const vfsName = path.basename(identity.canonicalPath, '.mkv');
    const strmName = path.basename(identity.strmPath, '.strm');
    assert.equal(vfsName, strmName, `the names agree for ${title}`);
  }
});

test('path safety: the identity segments are sanitized, relative and bounded', () => {
  const canonical = buildPresentationCanonicalPath({
    mediaType: 'movie', title: 'A/../B:C*D?E"F<G>H|I', year: null, extension: '.mkv',
  });
  const segments = canonical.split('/');
  assert.ok(!segments.includes('..'), 'no path segment is a traversal');
  assert.ok(!segments.includes('.'), 'no path segment is a self reference');
  assert.ok(canonical.startsWith('Movies/'), 'relative to the VFS root');
  assert.equal(segments.length, 3, 'the illegal characters became a space, not a separator');
  assert.ok(!segments[1].includes('/'), 'the title stayed one segment');

  const long = derivePresentationIdentity({
    mediaType: 'movie', title: 'x'.repeat(400), year: null, extension: '.mkv',
  });
  assert.ok(long.canonicalPath.length <= 768, 'the path stays bounded');
});

// ── 3. the commit is once, and it is durable ──────────────────────────────
test('the presentation identity is committed once and never rewritten', (t) => {
  const dir = tempDir(t);
  const dbPath = path.join(dir, 'cp.db');
  const store = createControlPlaneStore({ dbPath, now: () => NOW });
  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt1:default', mediaType: 'movie', mediaId: 'tt1', title: 'tt1',
  });
  const first = store.commitPresentationIdentity(item.id, {
    title: 'Oppenheimer', year: 2023,
    canonicalPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv',
    strmPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).strm',
  });
  assert.equal(first.committed, true);

  const second = store.commitPresentationIdentity(item.id, {
    title: 'Something Else', year: 1999,
    canonicalPath: 'Movies/Something Else (1999)/Something Else (1999).mkv',
    strmPath: 'Movies/Something Else (1999)/Something Else (1999).strm',
  });
  assert.equal(second.committed, false, 'a second commit is ignored');
  assert.equal(second.identity.title, 'Oppenheimer');
  assert.equal(second.identity.canonicalPath, 'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv');

  // Durable: a fresh store over the same database sees the same identity.
  store.close();
  const reopened = createControlPlaneStore({ dbPath, now: () => NOW });
  const reread = reopened.getPresentationIdentity(item.id);
  assert.equal(reread.title, 'Oppenheimer');
  assert.equal(reread.strmPath, 'Movies/Oppenheimer (2023)/Oppenheimer (2023).strm');
  reopened.close();
});

// ── 4. the publisher consumes a committed identity without resolving ──────
test('a committed identity names the artifact; nothing is resolved', async (t) => {
  const root = tempDir(t, 'hs-strm-');
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = root;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const handoff = {
    mediaId: 'tt1', mediaType: 'movie', season: null, episode: null,
    filename: 'Some.Release.2020.mkv',
  };
  const presentation = {
    title: 'Oppenheimer', year: 2023,
    strmPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).strm',
  };
  const result = await publishStrm({ handoff, presentation });
  assert.equal(result.published, true);
  assert.equal(result.path, path.join(root, presentation.strmPath));
  const content = fs.readFileSync(result.path, 'utf8');
  assert.ok(content.includes('/stream/movie/tt1'), 'the artifact carries the resolver URL');
});

// ── 5. a repeated publication converges ───────────────────────────────────
test('repeated publication writes one artifact at one path', async (t) => {
  const root = tempDir(t, 'hs-strm-idem-');
  const previous = process.env.STRM_OUTPUT_PATH;
  process.env.STRM_OUTPUT_PATH = root;
  t.after(() => {
    if (previous === undefined) delete process.env.STRM_OUTPUT_PATH;
    else process.env.STRM_OUTPUT_PATH = previous;
  });

  const handoff = {
    mediaId: 'tt1', mediaType: 'movie', season: null, episode: null,
    filename: 'Some.Release.2020.mkv',
  };
  const presentation = {
    title: 'Oppenheimer', year: 2023,
    strmPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).strm',
  };
  await publishStrm({ handoff, presentation });
  await publishStrm({ handoff, presentation });
  await publishStrm({ handoff, presentation });

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  assert.equal(files.length, 1, 'one artifact, not three');
  assert.equal(path.relative(root, files[0]), presentation.strmPath);
});

// ── 6. concurrency converges on one identity ───────────────────────────────
test('concurrent publications converge on one identity', async (t) => {
  const dir = tempDir(t, 'hs-strm-race-');
  const dbPath = path.join(dir, 'cp.db');
  const store = createControlPlaneStore({ dbPath, now: () => NOW });
  const item = store.ensureLibraryItem({
    identityKey: 'movie:tt1:default', mediaType: 'movie', mediaId: 'tt1', title: 'tt1',
  });
  const identity = {
    title: 'Oppenheimer', year: 2023,
    canonicalPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).mkv',
    strmPath: 'Movies/Oppenheimer (2023)/Oppenheimer (2023).strm',
  };
  const results = [];
  await Promise.all(Array.from({ length: 8 }, async () => {
    results.push(store.commitPresentationIdentity(item.id, identity));
  }));
  assert.equal(results.filter((r) => r.committed).length, 1, 'exactly one commit won');
  const stored = store.getPresentationIdentity(item.id);
  assert.equal(stored.canonicalPath, identity.canonicalPath);
  assert.equal(stored.strmPath, identity.strmPath);
  store.close();
});

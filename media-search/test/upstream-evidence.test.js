/**
 * Upstream evidence in the same HashSucker schema.
 *
 * The rule under test: **the addon's reading of a release is source
 * evidence, not schema authority.** It may fill a fact our own parse missed;
 * it may never overwrite one our parse established; it never becomes the
 * identity authority; and its ORDER is a source-local ordinal, never a
 * global rank.
 *
 * Covered here:
 *   - the 4320p/8K ordering gap (a correctly parsed 8K release used to
 *     rank BELOW ordinary 1080p releases);
 *   - the upstream's structured facts (bit depth, seeders) surviving
 *     normalization without exploding the schema;
 *   - the source-local ordinal, and that it only ever breaks a tie WITHIN
 *     one source;
 *   - the cache hint staying scoped (never a universal "cached");
 *   - the local parser still supplying what it can;
 *   - an upstream disagreement never overwriting a stronger local fact;
 *   - a file index still being unable to authorize a TorrentFile.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeStream,
  sortStreams,
  readUpstreamFacts,
} from '../src/lib/stremio/normalize.js';
import { qualityScore } from '../src/lib/discovery/ranking.js';

const SECRET = 'not-used-here';

function upstreamStream(overrides = {}) {
  return {
    name: 'Torrentio\n4k HDR',
    title: 'The Shawshank Redemption 1994 2160p BluRay\n👤 186 💾 6.91 GB ⚙️ YTS',
    infoHash: 'c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6',
    fileIdx: 0,
    behaviorHints: {
      bingeGroup: 'torrentio|4k|BluRay|x265|10bit|HDR',
      filename: 'The.Shawshank.Redemption.1994.2160p.4K.BluRay.x265.10bit.HDR.AAC5.1-[YTS.MX].mkv',
    },
    ...overrides,
  };
}

test('U1 — a correctly parsed 4320p release is no longer ranked below 1080p', () => {
  const eightK = normalizeStream(upstreamStream({
    infoHash: 'a'.repeat(40),
    name: 'Torrentio\n4320p HDR',
    behaviorHints: { bingeGroup: 'torrentio|4320p|WEB-DL|h265|DV', filename: 'Some.Movie.2026.4320p.WEB-DL.DV.H265.mkv' },
  }), { addonId: 'torrentio', sourceOrdinal: 0 });
  const fullHd = normalizeStream(upstreamStream({
    infoHash: 'b'.repeat(40),
    name: 'Torrentio\n1080p',
    behaviorHints: { bingeGroup: 'torrentio|1080p|WEB-DL|h264', filename: 'Some.Movie.2026.1080p.WEB-DL.H264.mkv' },
  }), { addonId: 'torrentio', sourceOrdinal: 1 });

  assert.equal(eightK.resolution, '4320p', 'the parser reads 8K');
  const ordered = sortStreams([fullHd, eightK]);
  assert.equal(ordered[0].infoHash, 'a'.repeat(40), 'the 8K release ranks first');

  // And the corpus ranking must score it, not zero it.
  assert.ok(
    qualityScore({ resolution: '4320p', sourceType: 'WEB-DL', codec: 'hevc', hdr: 'DV' })
    > qualityScore({ resolution: '480p', sourceType: 'WEB-DL', codec: 'h264', hdr: null }),
    'an 8K release outscores a 480p release on quality',
  );
});

test('U2 — the upstream facts survive normalization without exploding the schema', () => {
  const out = normalizeStream(upstreamStream(), { addonId: 'torrentio', sourceOrdinal: 7 });
  assert.equal(out.upstreamFacts.bitDepth, '10bit', 'the bit depth is carried');
  assert.equal(out.upstreamFacts.seeders, 186, 'the seeder count is carried');
  assert.equal(out.upstreamFacts.sourceLabel, 'torrentio', 'the source label is carried');
  assert.equal(out.upstreamFacts.sizeText, '6.91 GB', 'the display size text is carried');
  assert.deepEqual(
    Object.keys(out.upstreamFacts).sort(),
    ['bitDepth', 'seeders', 'sizeText', 'sourceLabel', 'tags'],
    'the evidence object has a fixed, small shape',
  );
});

test('U3 — the source-local ordinal is retained and is never a global rank', () => {
  const out = normalizeStream(upstreamStream(), { addonId: 'torrentio', sourceOrdinal: 7 });
  assert.equal(out.sourceOrdinal, 7);
  assert.equal(out.sourceId, 'torrentio');
  const unknown = normalizeStream(upstreamStream(), { addonId: 'torrentio' });
  assert.equal(unknown.sourceOrdinal, null, 'an unknown ordinal is null, never a guess');
});

test('U4 — the ordinal breaks a tie only WITHIN one source', () => {
  const mk = (hash, addonId, ordinal, title) => ({
    ...normalizeStream(upstreamStream({ infoHash: hash, title, name: 'Torrentio\n1080p' }), {
      addonId, sourceOrdinal: ordinal, sortOrder: 0,
    }),
    title,
  });
  // Same source: the ordinal decides.
  const sameSource = sortStreams([
    mk('a'.repeat(40), 'torrentio', 5, 'Zulu'),
    mk('b'.repeat(40), 'torrentio', 1, 'Alpha'),
  ]);
  assert.equal(sameSource[0].infoHash, 'b'.repeat(40), 'the lower ordinal wins inside one source');

  // Different sources: the ordinal must NOT be compared across them.
  const crossSource = sortStreams([
    mk('a'.repeat(40), 'torrentio', 9, 'Alpha'),
    mk('b'.repeat(40), 'comet', 0, 'Alpha'),
  ]);
  // With identical everything else, the cross-source pair falls through to the
  // title tiebreak — it does not adopt either side's ordinal.
  assert.deepEqual(
    crossSource.map((s) => s.infoHash).sort(),
    ['a'.repeat(40), 'b'.repeat(40)],
    'both candidates survive; neither ordinal leaks across sources',
  );
  assert.equal(
    crossSource[0].infoHash,
    'a'.repeat(40),
    'the cross-source tie is decided without an ordinal comparison',
  );
});

test('U5 — the cache hint stays scoped to the upstream source', () => {
  const hinted = normalizeStream(upstreamStream({
    behaviorHints: { cached: true, bingeGroup: 'torrentio|1080p|WEB-DL' },
  }), { addonId: 'torrentio' });
  assert.equal(hinted.upstreamCachedHint, true);
  assert.equal(hinted.cached, undefined, 'there is no universal "cached" field on a candidate');
  const unhinted = normalizeStream(upstreamStream(), { addonId: 'torrentio' });
  assert.equal(unhinted.upstreamCachedHint, false);
});

test('U6 — the local parser still supplies what it can', () => {
  // The local parse reads the FILENAME, which carries more than the tag list.
  const out = normalizeStream(upstreamStream(), { addonId: 'torrentio', sourceOrdinal: 0 });
  assert.equal(out.resolution, '2160p', 'the local parse read the resolution from the filename');
  assert.equal(out.attributeOrigin.resolution, 'local');
  assert.equal(out.codec, 'x265', 'the local parse read the codec');
  assert.equal(out.hdr, 'HDR');
  // The scene form "AAC5.1" used to parse to nothing; the grammar fix
  // reads the channel suffix and drops it, so the local parse supplies the
  // codec. The upstream's tag list never carries an audio token, so the audio
  // is a LOCAL fact — the upstream never supplies it.
  assert.equal(out.audio, 'AAC', 'the local parse reads the scene form "AAC5.1"');
  assert.equal(out.upstreamFacts.tags.includes('AAC'), false,
    'the upstream never publishes an audio token');
});

test('U7 — an upstream disagreement never overwrites a stronger local fact', () => {
  // The upstream claims 4320p; the filename says 2160p.
  const out = normalizeStream(upstreamStream({
    name: 'Torrentio\n4320p',
    behaviorHints: { bingeGroup: 'torrentio|4320p|WEB-DL', filename: 'Some.Movie.2026.2160p.BluRay.x265.mkv' },
  }), { addonId: 'torrentio', sourceOrdinal: 0 });
  assert.equal(out.resolution, '2160p', 'the local parse wins');
  assert.equal(out.attributeOrigin.resolution, 'local');
  // And the upstream's reading is still available for inspection.
  assert.equal(out.upstreamFacts.tags, 'Torrentio\n4320p'.split('\n')[1] || out.upstreamFacts.tags);
});

test('U8 — the upstream may fill a fact the local parse missed', () => {
  // Nothing local to read: a bare filename AND a bare name. Only the
  // upstream's structured bingeGroup carries a quality here.
  const out = normalizeStream(upstreamStream({
    name: 'Torrentio',
    title: 'Some Release',
    behaviorHints: { bingeGroup: 'torrentio|4k|BluRay REMUX|hevc|DV', filename: 'Some.Release.mkv' },
  }), { addonId: 'torrentio', sourceOrdinal: 0 });
  assert.equal(out.resolution, '2160p', 'the upstream filled the resolution');
  assert.equal(out.attributeOrigin.resolution, 'upstream');
  assert.equal(out.hdr, 'DV', 'the upstream filled the HDR type');
  assert.equal(out.attributeOrigin.hdr, 'upstream');
});

test('U9 — a file index still cannot authorize an exact file', () => {
  const out = normalizeStream(upstreamStream(), { addonId: 'torrentio', sourceOrdinal: 0 });
  // infoHash + a file index, no torrent-internal path, no exact size: the
  // identity strength must stay "release-only". A fileIdx is an index, not
  // an identity.
  assert.equal(out.identityStrength, 'release-only');
  assert.equal(out.exactFileSize, null, 'the magnet form carries no exact file size');
  assert.equal(out.internalPath, undefined, 'the addon never supplies an internal path');
});

test('U10 — the upstream facts reader tolerates the shapes the addons publish', () => {
  // A series: the bingeGroup is the infoHash, with no quality at all.
  const series = readUpstreamFacts({
    name: 'Torrentio\n4k',
    title: 'Some Show S01E01\n👤 12 💾 2.1 GB',
    behaviorHints: { bingeGroup: 'torrentio|a584351126afcf50d32be068f3c9a62550d41ecc' },
  });
  // The bingeGroup's infoHash is NOT read as a quality token; the
  // resolution here comes from the NAME's tag list, which is a legitimate
  // source in its own right.
  assert.notEqual(series.resolution, 'a584351126afcf50d32be068f3c9a62550d41ecc',
    'an infoHash is never read as a quality token');
  assert.equal(series.resolution, '2160p', 'the name tag list is the comparable source (canonicalised)');
  assert.equal(series.seeders, 12);
  assert.equal(series.bitDepth, null);
  // A movie: the structured form.
  const movie = readUpstreamFacts({
    name: 'Torrentio\n4k DV | HDR10+ | HDR',
    title: 'X 2026 2160p BluRay\n👤 5 💾 60 GB',
    behaviorHints: { bingeGroup: 'torrentio|4k|BluRay REMUX|hevc|DV' },
  });
  // The upstream's tokens are read with OUR vocabulary, so the resolution is
  // canonical ('2160p', not '4k') and the raw tags stay available in
  // `tags` for inspection.
  assert.equal(movie.resolution, '2160p');
  assert.equal(movie.source, 'BluRay');
  assert.equal(movie.codec, 'x265', 'the codec is canonicalised into our vocabulary');
  assert.equal(movie.hdr, 'DV');
  assert.ok(movie.tags.includes('4k DV'), 'the raw upstream tag line is retained');
});

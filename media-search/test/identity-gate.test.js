/**
 * Representation identity hard gate (identity-correctness slice).
 *
 * Production defect: tt0159187 S01E01 ("Mogul", 1965) bound a Diddy
 * S01E01 release. The parsed candidate title embeds the EPISODE title
 * after the S/E token ("...S01E01.The.Making.of.a.Mogul..."), and the
 * substring branch of titlesMatch treated the episode-title token as a
 * series-title match. Downstream Binding/VFS/Plex agreement was circular
 * (derived filenames) and could not catch it.
 *
 * Invariant under test: identity acceptance (series title + coordinates)
 * is a hard gate that desirability (seed count, quality, cache, size)
 * can never outweigh. A highly seeded wrong show scores zero.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evaluateIdentityEligibility,
  seriesTitleBeforeEpisodeToken,
} from '../src/lib/discovery/ranking.js';
import { selectBindableCandidate } from '../src/lib/discovery/selection.js';
import {
  isPlayableVideoTorrentFile,
  resolveTvTorrentFile,
} from '../src/lib/resolver/tv-episode-resolver.js';
import { buildCorpusRankingInput } from '../src/api/media-request-stages.js';

const DIDDY_FILE = 'The.Fall.of.Diddy.S01E01.The.Making.of.a.Mogul.720p.HEVC.x265-MeGusta[EZTVx.to].mkv';
const DIDDY_TITLE = 'The Fall of Diy The Making of a Mogul MeGusta[EZTVx to]';

function episodeHit({ filename = DIDDY_FILE, title = DIDDY_TITLE, season = 1, episode = 1, origin = 'live' } = {}) {
  return {
    infoHash: 'abc123',
    fileIndex: null,
    filename,
    releaseAttributes: {
      title, year: undefined, season, episode, episodeRange: undefined,
      seasonOnly: false, mediaType: 'episode', resolution: '1080p',
      source: undefined, sourceType: undefined, codec: 'x265',
    },
    sources: [{ origin }],
  };
}

const MOGUL_QUERY = { season: 1, episode: 1, mediaType: 'series', mediaTitle: 'Mogul', year: 1965 };

// --- 1. The exact production false positive -----------------------------

test('Diddy S01E01 is rejected for Mogul S01E01 (episode-title contamination)', () => {
  const ev = evaluateIdentityEligibility(episodeHit(), MOGUL_QUERY);
  assert.equal(ev.eligible, false, 'must not bind a different show');
  assert.equal(ev.code, 'title_mismatch');
});

// --- 2. Series-portion helper --------------------------------------------

test('seriesTitleBeforeEpisodeToken isolates the series title', () => {
  assert.equal(
    seriesTitleBeforeEpisodeToken(DIDDY_FILE, 1, 1),
    'The.Fall.of.Diddy',
  );
  assert.equal(seriesTitleBeforeEpisodeToken('Movie.Name.2020.1080p.mkv', null, null), null);
  assert.equal(seriesTitleBeforeEpisodeToken('S01E01 - Pilot.mkv', 1, 1), null);
  // Token for another season is skipped in favor of the agreeing one.
  assert.equal(
    seriesTitleBeforeEpisodeToken('Show.S02.S01E01.Pilot.mkv', 1, 1),
    'Show.S02',
  );
  // 1x02 form works too.
  assert.equal(seriesTitleBeforeEpisodeToken('Show.1x02.Episode.mkv', 1, 2), 'Show');
});

// --- 3. Legitimate matches still pass (no false-negative regression) ----

test('legitimate episode matches still pass the gate', () => {
  const lasso = episodeHit({
    filename: 'Ted.Lasso.S04E02.1080p.x265-ELiTE.mkv',
    title: 'Ted Lasso',
    season: 4, episode: 2,
  });
  const ev = evaluateIdentityEligibility(lasso, { season: 4, episode: 4 - 2, mediaType: 'series', mediaTitle: 'Ted Lasso' });
  assert.equal(ev.eligible, true, JSON.stringify(ev));
  // Year-suffixed series portion still matches via containment.
  const yearNamed = episodeHit({
    filename: 'Mogul.1965.S01E01.Pilot.mkv',
    title: 'Mogul 1965',
    season: 1, episode: 1,
  });
  const ev2 = evaluateIdentityEligibility(yearNamed, MOGUL_QUERY);
  assert.equal(ev2.eligible, true, JSON.stringify(ev2));
});

// --- 4. Year handling ----------------------------------------------------

test('movie year conflict rejects; TV year never gates', () => {
  const movie = {
    infoHash: 'm1', fileIndex: null, filename: 'Dune.Part.Two.2024.1080p.mkv',
    releaseAttributes: { title: 'Dune Part Two', year: 2024, mediaType: 'movie' },
    sources: [{ origin: 'corpus' }],
  };
  const ev = evaluateIdentityEligibility(movie, { mediaType: 'movie', mediaTitle: 'Dune Part Two', year: 2021 });
  assert.equal(ev.eligible, false);
  assert.equal(ev.code, 'year_mismatch');
  // Same-shape TV candidate is unaffected by year (series span years).
  const tv = episodeHit();
  const evTv = evaluateIdentityEligibility(tv, { ...MOGUL_QUERY, year: 2024 });
  assert.equal(evTv.eligible, false, 'still rejected, but on title — not year');
  assert.equal(evTv.code, 'title_mismatch');
});

// --- 5. Association-poisoned corpus rows still face the title gate --------

test('corpus-direct path evaluates the resolved wanted title, not just S/E', () => {
  const diddyAttrs = {
    title: 'The Fall of Diy The Making of a Mogul MeGusta[EZTVx to]',
    year: undefined, season: 1, episode: 1, episodeRange: undefined,
    seasonOnly: false, mediaType: 'episode', resolution: '1080p',
    sourceType: undefined, codec: 'x265', confidence: 0.9,
  };
  const stubCache = {
    // Poisoned association from a past misbind (matchMethod request-ranked).
    getReleaseAttributes: () => [diddyAttrs],
    getMediaAssociations: () => [{ mediaId: 'tt0159187', confidence: 0.8 }],
    getProviderObservations: () => [],
  };
  const candidate = {
    infoHash: 'abc123', fileIndex: null,
    filename: 'The.Fall.of.Diddy.S01E01.The.Making.of.a.Mogul.720p.HEVC.x265-MeGusta[EZTVx.to].mkv',
    sources: [{ origin: 'corpus' }],
  };
  const ctx = { mediaId: 'tt0159187', mediaType: 'series', season: 1, episode: 1, mediaTitle: null, canonicalYear: null };
  const eligibilityByHash = new Map();
  buildCorpusRankingInput({
    cache: stubCache, candidate, ctx, eligibilityByHash, metadataByHash: new Map(),
    wantedIdentity: { title: 'Mogul', year: 1965 },
  });
  const ev = eligibilityByHash.get('abc123:torrent');
  assert.equal(ev.eligible, false, 'association must not override title contradiction');
  assert.equal(ev.code, 'title_mismatch');
});

test('corpus-direct path still accepts legitimate association-backed rows', () => {
  const stubCache = {
    getReleaseAttributes: () => [{
      title: 'Ted Lasso', year: undefined, season: 4, episode: 2,
      mediaType: 'episode', resolution: '1080p', sourceType: undefined, confidence: 0.9,
    }],
    getMediaAssociations: () => [{ mediaId: 'tt10986410', confidence: 0.9 }],
    getProviderObservations: () => [],
  };
  const candidate = {
    infoHash: 'def456', fileIndex: null,
    filename: 'Ted.Lasso.S04E02.1080p.x265-ELiTE.mkv',
    sources: [{ origin: 'corpus' }],
  };
  const ctx = { mediaId: 'tt10986410', mediaType: 'series', season: 4, episode: 2, mediaTitle: null, canonicalYear: null };
  const eligibilityByHash = new Map();
  buildCorpusRankingInput({
    cache: stubCache, candidate, ctx, eligibilityByHash, metadataByHash: new Map(),
    wantedIdentity: { title: 'Ted Lasso', year: null },
  });
  const ev = eligibilityByHash.get('def456:torrent');
  assert.equal(ev.eligible, true, JSON.stringify(ev));
});

// --- 6. Selection never binds an ineligible candidate --------------------

function pathBStore(torrentFiles) {
  return {
    listTorrentFilesForRelease: () => torrentFiles,
    listProviderRefsForTorrentFile: () => [],
  };
}

function bindableCandidate(overrides = {}) {
  return {
    infoHash: 'abc123',
    fileIndex: null,
    filename: DIDDY_FILE,
    rank: 1,
    score: 0.99,
    identity: { eligible: false, tier: 'Ineligible', confidence: 0 },
    availability: {},
    release: { title: 'x' },
    exactFileSize: null,
    selectedFileSize: null,
    ...overrides,
  };
}

test('ineligible identity is not bindable even when the provider would succeed', async () => {
  let ensureCalls = 0;
  const ensure = async () => {
    ensureCalls += 1;
    return {
      placementId: 'pl-1',
      torrentFiles: [{ id: 'tf-1', infoHash: 'abc123', internalPath: 'Pack/S01E01.mkv', size: 100 }],
    };
  };
  const result = await selectBindableCandidate(
    [bindableCandidate()],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: { season: 1, episode: 1 },
      controlPlaneStore: pathBStore([]),
    },
  );
  assert.equal(result.selected, null);
  assert.equal(result.reason, 'no eligible candidates');
  assert.equal(ensureCalls, 0, 'no provider work for ineligible candidates');
});

test('eligible legitimate candidate still binds via episode rules', async () => {
  const ensure = async () => ({
    placementId: 'pl-1',
    torrentFiles: [{ id: 'tf-1', infoHash: 'abc123', internalPath: 'Ted.Lasso.S04E02.1080p.x265-ELiTE.mkv', size: 700720950 }],
  });
  const result = await selectBindableCandidate(
    [bindableCandidate({
      filename: 'Ted.Lasso.S04E02.1080p.x265-ELiTE.mkv',
      identity: { eligible: true, tier: 'Probable', confidence: 0.6 },
    })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: { season: 4, episode: 2 },
      controlPlaneStore: pathBStore([]),
    },
  );
  assert.equal(result.reason, 'tv-episode bound S4E2');
  assert.equal(result.selected._torrentFileId, 'tf-1');
});

// --- 6. Selected-file checks ---------------------------------------------

test('samples, neighbors, and ambiguous packs cannot win the file', () => {
  const sample = { id: 't', infoHash: 'h', internalPath: 'Show.S01E01.sample.mkv', size: 100 };
  assert.equal(isPlayableVideoTorrentFile(sample), false, 'sample rejected');
  assert.throws(
    () => resolveTvTorrentFile({ torrentFiles: [{ id: 't', infoHash: 'h', internalPath: 'Show.S01E02.mkv', size: 100 }], season: 1, episode: 1 }),
    'neighbor episode cannot satisfy the coordinate',
  );
  assert.throws(
    () => resolveTvTorrentFile({
      torrentFiles: [
        { id: 'a', infoHash: 'h', internalPath: 'Pack/Show.S01E01.A.mkv', size: 100 },
        { id: 'b', infoHash: 'h', internalPath: 'Pack/Show.S01E01.B.mkv', size: 100 },
      ],
      season: 1, episode: 1,
    }),
    'ambiguous duplicates cannot win silently',
  );
  const { torrentFile } = resolveTvTorrentFile({
    torrentFiles: [{ id: 't', infoHash: 'h', internalPath: 'Show.S01E01.mkv', size: 100 }],
    season: 1, episode: 1,
  });
  assert.equal(torrentFile.id, 't', 'unique exact coordinate binds');
});

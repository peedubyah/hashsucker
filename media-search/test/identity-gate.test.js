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
  cleanReleasePortion,
  evaluateIdentityEligibility,
  matchWantedPortion,
  matchWantedTitle,
  movieTitleBeforeYearToken,
  seriesTitleBeforeEpisodeToken,
  titlesMatch,
} from '../src/lib/discovery/ranking.js';
import { knownAliasesFor } from '../src/lib/discovery/known-aliases.js';
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
  // Bare season token (season packs) terminates the portion.
  assert.equal(
    seriesTitleBeforeEpisodeToken('Ted.Lasso.S01.MULTi.2160p.WEB.H265-FW.mkv', 1, null),
    'Ted.Lasso',
  );
  // Localized season words terminate the portion too (observed Polish
  // "Sezon", French "Saison", Spanish "Temporada", Italian "Stagione").
  assert.equal(
    seriesTitleBeforeEpisodeToken('[BEST-TORRENTS.COM] The.Lowdown.Sezon01.sub.i.MULTi.2160p.mkv', 1, null),
    '[BEST-TORRENTS.COM] The.Lowdown',
  );
  assert.equal(
    seriesTitleBeforeEpisodeToken('Show.Saison.2.Episode.3.mkv', 2, 3),
    'Show',
  );
  // Bare season for another season is skipped.
  assert.equal(
    seriesTitleBeforeEpisodeToken('Show.S02.Bonus.mkv', 1, null),
    null,
  );
});

// --- 2b. Movie-portion helper ---------------------------------------------

test('movieTitleBeforeYearToken isolates the movie title', () => {
  assert.equal(
    movieTitleBeforeYearToken('Oppenheimer.2023.2160p.10bit.HDR.BluRay.6CH.x265.HEVC-PSA.mkv', 2023),
    'Oppenheimer',
  );
  assert.equal(
    movieTitleBeforeYearToken('The.Matrix.1999.UHD.BluRay.2160p.TrueHD.Atmos.7.1.DV.HEVC.REMUX-FraMeSToR.mkv', 1999),
    'The.Matrix',
  );
  // No agreeing year token → null (caller falls back, never mis-splits).
  assert.equal(movieTitleBeforeYearToken('The.Godfather.trilogy.MULTi.FRENCH.2160p.10bit.4KLight.mkv', 1972), null);
  // Year-like resolution tokens never split.
  assert.equal(movieTitleBeforeYearToken('Show.2160p.WEB.mkv', 2023), null);
  // Title that starts with a number survives.
  assert.equal(movieTitleBeforeYearToken('2012.2009.1080p.BluRay.x264.mkv', 2009), '2012');
});

// --- 2c. Portion cleaner ---------------------------------------------------

test('cleanReleasePortion strips machine tags, never title words', () => {
  assert.equal(cleanReleasePortion('[DK2] The Dark Knight'), 'The Dark Knight');
  assert.equal(cleanReleasePortion('www.UIndex.org    -    Gladiator'), 'Gladiator');
  assert.equal(cleanReleasePortion('The Matrix [IMAX]'), 'The Matrix');
  assert.equal(cleanReleasePortion('Dune Part Two {tmdb-123}'), 'Dune Part Two');
  // Commentary brand has no dot: survives as a comparable title word
  // (separator normalized to space, exactly as the matcher sees it).
  assert.equal(cleanReleasePortion('Rifftrax- The Matrix'), 'Rifftrax The Matrix');
  // A portion that is ONLY a tag group cleans to null: the caller falls
  // back to the parsed title ("[REC]" the film still matches via its
  // parsed title "REC"). Cleaning never invents a title from a tag.
  assert.equal(cleanReleasePortion('[REC]'), null);
  // Dotted title words are never treated as domains: "Despicable.Me",
  // "The.Net", and "WALL.E" survive cleaning intact. (A generic
  // dot-word-dot-TLD strip was rejected: it cannot tell group domains
  // from title words.)
  assert.equal(cleanReleasePortion('Despicable.Me'), 'Despicable Me');
  assert.equal(cleanReleasePortion('The.Net'), 'The Net');
  assert.equal(cleanReleasePortion('S.W.A.T'), 'S W A T');
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

// --- 6b. PATH A verifies the sized file is the requested episode ---------

function tvStoreWithFiles(torrentFiles) {
  return {
    listTorrentFilesForRelease: () => torrentFiles,
    listProviderRefsForTorrentFile: () => [],
    getTorrentFile: (id) => torrentFiles.find((t) => t.id === id) ?? null,
  };
}

test('PATH A never binds a sized file that parses to the wrong episode', async () => {
  const ensure = async (params) => {
    if (!params.skipSizeMatch) {
      // Exact-size match returns the WRONG episode's file (upstream
      // stream mislabel: title says E02, sized file is E10).
      return { placementId: 'pl-1', providerFileId: 'pf-10', torrentFileId: 'tf-e10', size: 700 };
    }
    return {
      placementId: 'pl-1',
      torrentFiles: [
        { id: 'tf-e10', infoHash: 'abc123', internalPath: 'Show.S01E10.mkv', size: 700 },
        { id: 'tf-e2', infoHash: 'abc123', internalPath: 'Show.S01E02.mkv', size: 800 },
      ],
    };
  };
  const result = await selectBindableCandidate(
    [bindableCandidate({
      filename: 'Show.S01E02.1080p.mkv',
      exactFileSize: 700,
      identity: { eligible: true, tier: 'Probable', confidence: 0.6 },
    })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: { season: 1, episode: 2 },
      controlPlaneStore: tvStoreWithFiles([
        { id: 'tf-e10', infoHash: 'abc123', internalPath: 'Show.S01E10.mkv', size: 700 },
        { id: 'tf-e2', infoHash: 'abc123', internalPath: 'Show.S01E02.mkv', size: 800 },
      ]),
    },
  );
  assert.equal(result.selected._torrentFileId, 'tf-e2', 'PATH B resolves the correct episode after PATH A contradiction');
  assert.ok(
    (result.skipped || []).some((s) => String(s.reason || '').includes('path-a-episode-contradiction')),
    'contradiction is recorded in the skip list',
  );
});

test('PATH A still binds when the sized file matches the episode', async () => {
  const ensure = async () => ({
    placementId: 'pl-1', providerFileId: 'pf-2', torrentFileId: 'tf-e2', size: 800,
  });
  const result = await selectBindableCandidate(
    [bindableCandidate({
      filename: 'Show.S01E02.1080p.mkv',
      exactFileSize: 800,
      identity: { eligible: true, tier: 'Probable', confidence: 0.6 },
    })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: { season: 1, episode: 2 },
      controlPlaneStore: tvStoreWithFiles([
        { id: 'tf-e2', infoHash: 'abc123', internalPath: 'Show.S01E02.mkv', size: 800 },
      ]),
    },
  );
  assert.equal(result.selected._torrentFileId, 'tf-e2');
  assert.equal(result.reason, 'exact-size bound');
});

test('PATH A still binds when the sized file path is unparseable', async () => {
  // Unverifiable is not proven-wrong: release-level title+S/E already
  // passed, so today's behavior is preserved (no regression for odd
  // internal naming that PATH B could not resolve either).
  const ensure = async () => ({
    placementId: 'pl-1', providerFileId: 'pf-x', torrentFileId: 'tf-x', size: 800,
  });
  const result = await selectBindableCandidate(
    [bindableCandidate({
      filename: 'Show.S01E02.1080p.mkv',
      exactFileSize: 800,
      identity: { eligible: true, tier: 'Probable', confidence: 0.6 },
    })],
    {
      ensureTorBoxFileIdentityFn: ensure,
      resolveTvTorrentFileFn: resolveTvTorrentFile,
      tvCoordinates: { season: 1, episode: 2 },
      controlPlaneStore: tvStoreWithFiles([
        { id: 'tf-x', infoHash: 'abc123', internalPath: 'Show/video_final_v2.mkv', size: 800 },
      ]),
    },
  );
  assert.equal(result.selected._torrentFileId, 'tf-x');
  assert.equal(result.reason, 'exact-size bound');
});

// --- 7. Short-title / superstring adversarial suite ----------------------
//
// Single-meaningful-token wanted titles are the dangerous class: naive
// containment lets any longer title containing the token pass. The
// contract: containment is legitimate ONLY when every extra meaningful
// token is benign (release year, S/E-shaped coordinate residue). Any
// other extra meaningful token is a hard contradiction.

function tvHitForTitle(parsedTitle, filename) {
  return {
    infoHash: 'adv',
    fileIndex: null,
    filename,
    releaseAttributes: {
      title: parsedTitle, year: undefined, season: 1, episode: 1,
      episodeRange: undefined, seasonOnly: false, mediaType: 'episode',
      resolution: '1080p', sourceType: undefined, codec: 'x265',
    },
    sources: [{ origin: 'live' }],
  };
}

test('titlesMatch: single-token superstrings reject', () => {
  assert.equal(titlesMatch('Mogul', 'Mogul'), true);
  assert.equal(titlesMatch('Mogul', 'The Mogul'), true, 'article prefix is benign');
  assert.equal(titlesMatch('Mogul', 'Mogul 1965'), true, 'release-year suffix is benign');
  assert.equal(titlesMatch('Mogul', 'Moguls'), false, 'plural affix is a different title');
  assert.equal(titlesMatch('Mogul', 'Myth and Mogul'), false, 'extra meaningful token rejects');  assert.equal(titlesMatch('Mogul', 'The Making of a Mogul'), false, 'episode-title residue rejects');
  assert.equal(titlesMatch('Mogul', 'Mogul Money'), false, 'trailing meaningful token rejects');
  assert.equal(titlesMatch('Up', 'Stargate Collection Upscale'), false, 'character-affix must not match');
  assert.equal(titlesMatch('Up', 'Up'), true);
  // Leading release-grammar strip (P2P prefix naming): closed-class
  // source/resolution tags before the title are not identity.
  assert.equal(titlesMatch('Barbie', 'REMUX 2160p Barbie 2023'), true, 'leading tags strip');
  assert.equal(titlesMatch('Total Recall', 'REMUX 2160p Total Recall 1990'), true);
  // The wanted side is never stripped: "Therapy" alone is not "Web Therapy".
  assert.equal(titlesMatch('Web Therapy', 'Web Therapy'), true);
  assert.equal(titlesMatch('Web Therapy', 'Therapy'), false);
  // Sequel-number expressions denote the same film as the bare number.
  assert.equal(titlesMatch('John Wick 4', 'John Wick Chapter 4'), true, 'Chapter N folds to N');
  assert.equal(titlesMatch('Dune', 'Dune 2'), false, 'bare sequel digit still rejects');
  assert.equal(titlesMatch('Dune', 'Dune Part Two'), false, 'word-number extras still reject');
  // Pack words describe a container holding the wanted title, not a
  // different title. Downstream exactness gates (episode resolution,
  // single-file cardinality) still decide bindability.
  assert.equal(titlesMatch('Ted Lasso', 'Ted Lasso COMPLETE'), true, 'complete pack holds the show');
  assert.equal(titlesMatch('The Godfather', 'The Godfather trilogy'), true, 'trilogy pack holds the film');
});

test('short-title superstring candidates are ineligible', () => {
  for (const [parsed, file] of [
    ['Myth and Mogul', 'Myth.and.Mogul.S01E01.1080p.mkv'],
    ['The Making of a Mogul', 'Other.Show.S01E01.The.Making.of.a.Mogul.1080p.mkv'],
    ['Mogul Money', 'Mogul.Money.S01E01.1080p.mkv'],
  ]) {
    const ev = evaluateIdentityEligibility(tvHitForTitle(parsed, file), MOGUL_QUERY);
    assert.equal(ev.eligible, false, `${parsed} must not satisfy Mogul`);
    assert.equal(ev.code, 'title_mismatch');
  }
  // Benign extras still pass the gate.
  for (const [parsed, file] of [
    ['Mogul', 'Mogul.S01E01.1080p.mkv'],
    ['The Mogul', 'The.Mogul.S01E01.1080p.mkv'],
    ['Mogul 1965', 'Mogul.1965.S01E01.1080p.mkv'],
  ]) {
    const ev = evaluateIdentityEligibility(tvHitForTitle(parsed, file), MOGUL_QUERY);
    assert.equal(ev.eligible, true, `${parsed} must satisfy Mogul: ${ev.reason}`);
  }
});

test('stylized titles match only through explicit alias evidence', () => {
  // Strict layer: no global leet folding (Se7en's 7 stands for V — a
  // fixed 7→t map yields "seten", and any global map has unbounded
  // blast radius). Stylization is alias evidence, asserted by metadata.
  assert.equal(titlesMatch('Seven', 'Se7en'), false);
  assert.equal(titlesMatch('Seven', 'Seven Brides'), false);
  // Alias layer: accepted stylized alias satisfies exactly.
  const wanted = { title: 'Seven', aliases: ['Se7en'] };
  assert.equal(matchWantedTitle(wanted, 'Se7en'), true);
  assert.equal(matchWantedTitle(wanted, 'Seven'), true);
  assert.equal(matchWantedTitle(wanted, 'Seventy'), false);
  // Without the alias asserted, the stylized spelling must not pass.
  assert.equal(matchWantedTitle({ title: 'Seven', aliases: [] }, 'Se7en'), false);
});

test('aliases satisfy through explicit evidence, never fuzzy inference', () => {
  // Italian-titled Empire: canonical English title contradicts, but the
  // accepted localized alias matches exactly.
  const wanted = { title: 'The Empire Strikes Back', aliases: ["L'Impero colpisce ancora"] };
  assert.equal(matchWantedTitle(wanted, "L'Impero colpisce ancora"), true);
  assert.equal(matchWantedTitle(wanted, 'The Empire Strikes Back'), true);
  assert.equal(matchWantedTitle(wanted, 'Star Wars'), false);
  // No aliases: contradiction stands.
  assert.equal(matchWantedTitle({ title: 'The Empire Strikes Back', aliases: [] }, "L'Impero colpisce ancora"), false);
  // Empty wanted: indeterminate, never acceptance.
  assert.equal(matchWantedTitle({ title: null, aliases: [] }, 'Anything'), null);
});

test('alias match passes the eligibility gate', () => {
  const hit = {
    infoHash: 'it',
    fileIndex: null,
    filename: "L.Impero.colpisce.ancora.1980.1080p.mkv",
    releaseAttributes: { title: "L'Impero colpisce ancora", year: 1980, mediaType: 'movie' },
    sources: [{ origin: 'live' }],
  };
  const q = {
    mediaType: 'movie',
    mediaTitle: 'The Empire Strikes Back',
    mediaTitleAliases: ["L'Impero colpisce ancora"],
    year: 1980,
  };
  assert.equal(evaluateIdentityEligibility(hit, q).eligible, true);
  const qNoAlias = { mediaType: 'movie', mediaTitle: 'The Empire Strikes Back', year: 1980 };
  const ev = evaluateIdentityEligibility(hit, qNoAlias);
  assert.equal(ev.eligible, false, 'without alias evidence the foreign title must not pass');
  assert.equal(ev.code, 'title_mismatch');
});

// --- 7c. Bilingual constructions ------------------------------------------
//
// "Via col vento - Gone with the Wind": both halves are known strings
// (alias + canonical), so the construction confirms. "Rifftrax- The
// Matrix" has an unknown brand half, so it rejects even though the
// other half matches.

test('bilingual gate behavior', () => {  const wanted = { title: 'Gone with the Wind', aliases: ['Via col vento'] };
  // Whole-portion match fails (Italian extras), bilingual accepts.
  const r = matchWantedPortion(wanted, null, 'Via col vento - Gone with the Wind', 'Via col vento Gone with the Wind 5 1');
  assert.equal(r.result, true, JSON.stringify(r));
  assert.equal(r.bilingual, true);
  // Brand half unknown → reject.
  const r2 = matchWantedPortion(
    { title: 'The Matrix', aliases: [] },
    null, 'Rifftrax- The Matrix', 'Rifftrax The Matrix',
  );
  assert.equal(r2.result, false);
  // No dash shape → whole verdict stands (null here: nothing comparable).
  const r3 = matchWantedPortion({ title: null, aliases: [] }, null, 'Anything', 'Anything');
  assert.equal(r3.result, null);
});

test('curated aliases cover the observed localized/stylized rows', () => {
  assert.deepEqual(knownAliasesFor('tt0114369'), ['Se7en']);
  assert.ok(knownAliasesFor('tt0080684').includes('Star Wars Episode V Das Imperium schlaegt zurueck'));
  assert.deepEqual(knownAliasesFor('tt9999999'), []);
  // Alias entries are exact-match evidence: Se7en rows satisfy Seven.
  const r = matchWantedPortion(
    { title: 'Seven', aliases: knownAliasesFor('tt0114369') },
    null, 'Se7en', 'Se7en MA 7 1 HYBRID',
  );
  assert.equal(r.result, true);
  assert.equal(r.matchedAlias, 'Se7en');
  // A wrong film with the same year still rejects (year gate is separate,
  // but title must already agree — Bond is not Fellini).
  const bond = matchWantedPortion(
    { title: '8½', aliases: knownAliasesFor('tt0056801') },
    null, 'From Russia With Love', 'From Russia With Love 5 1',
  );
  assert.equal(bond.result, false);
});

test('curated aliases cover the observed short/foreign titles', () => {
  // Short canonical-subtitle forms that releases actually use.
  assert.equal(
    matchWantedTitle(
      { title: 'Dr. Strangelove or How I Learned to Stop Worrying and Love the Bomb', aliases: knownAliasesFor('tt0057012') },
      'Dr Strangelove MA 5 1 HYBRID',
    ),
    false,
    'residue still defeats the alias without a year-anchored filename portion',
  );
  // Abbreviation alias (exact observed spelling).
  assert.equal(
    matchWantedTitle({ title: 'Sunset Boulevard', aliases: knownAliasesFor('tt0043014') }, 'Sunset Blvd'),
    true,
  );
  // Japanese title alias.
  assert.equal(
    matchWantedTitle({ title: 'Harakiri', aliases: knownAliasesFor('tt0056058') }, 'Seppuku'),
    true,
  );
});

// --- 7b. Release-grammar isolation (movie pre-year portion) -----------------
//
// Parser residue (codec, audio, source, edition tags) routinely lands in
// the stored title. Comparing against the filename portion before the
// known year token keeps residue out of identity structurally.

// --- 7b2. Altered-content markers ------------------------------------------
//
// Fanedits, fan recuts, parody trailers, and commentary tracks are never
// the canonical film — even when the pre-year portion matches exactly.
// The marker scan runs on the FULL filename because alteration markers
// live in the same post-year position as benign residue.

function movieHitForTitle(parsedTitle, filename, year) {
  return {
    infoHash: 'mv',
    fileIndex: null,
    filename,
    releaseAttributes: {
      title: parsedTitle, year, season: null, episode: null,
      episodeRange: undefined, seasonOnly: false, mediaType: 'movie',
      resolution: '2160p', sourceType: undefined, codec: 'x265',
    },
    sources: [{ origin: 'corpus' }],
  };
}

test('altered-content markers reject even with a clean pre-year title', () => {
  const rogue = movieHitForTitle(
    'Star Wars Episode IV A New Hope The Rogue Cut v2',
    'Star.Wars.Episode.IV.A.New.Hope.The.Rogue.Cut.x265.HDR.2160p-v2-NumeralJ.mkv',
    1977,
  );
  const ev = evaluateIdentityEligibility(rogue, {
    mediaType: 'movie', mediaTitle: 'Star Wars Episode IV - A New Hope', year: 1977,
  });
  assert.equal(ev.eligible, false);
  assert.equal(ev.code, 'altered_content');

  // Post-year markers are not blind spots: portion isolation would hide them.
  const altCut = movieHitForTitle(
    'Star Wars Episode IV A New Hope READNFO ALTERNATIVE CUT',
    'Star.Wars.Episode.IV-A.New.Hope.1977.READNFO.ALTERNATIVE.CUT.DV.2160p.WEB.H265-P.mkv',
    1977,
  );
  const ev2 = evaluateIdentityEligibility(altCut, {
    mediaType: 'movie', mediaTitle: 'Star Wars Episode IV - A New Hope', year: 1977,
  });
  assert.equal(ev2.eligible, false);
  assert.equal(ev2.code, 'altered_content');

  // First-party editions still pass: Director's/Extended/Criterion cuts
  // are legitimate representations, and "cut" alone is benign.
  const directors = movieHitForTitle(
    'Blade Runner The Final Cut',
    'Blade.Runner.The.Final.Cut.1982.2160p.UHD.BluRay.REMUX.HDR.HEVC.TrueHD.7.1.mkv',
    1982,
  );
  const ev3 = evaluateIdentityEligibility(directors, {
    mediaType: 'movie', mediaTitle: 'Blade Runner', year: 1982,
  });
  assert.equal(ev3.eligible, true, JSON.stringify(ev3));

  // Title-independent: a fanedit rejects even with no wanted identity.
  const ev4 = evaluateIdentityEligibility(rogue, { mediaType: 'movie' });
  assert.equal(ev4.eligible, false);
  assert.equal(ev4.code, 'altered_content');
});

// --- 7c. Bilingual constructions ------------------------------------------

test('movie residue after the year token never participates in identity', () => {  const cases = [
    // [wanted, parsedTitle, filename, year]
    ['Oppenheimer', 'Oppenheimer 10bit 6CH',
      'Oppenheimer.2023.2160p.10bit.HDR.BluRay.6CH.x265.HEVC-PSA.mkv', 2023],
    ['The Matrix', 'The Matrix MULTI VFI 7 1',
      'The.Matrix.1999.MULTI.VFI.2160p.UHD.BluRay.Remux.DV.HDR.TrueHD.Atmos.7.1.HEVC-HYPERION.mkv', 1999],
    ['Interstellar', 'Interstellar IMAX MULTi VFI 10bit + 7 1',
      'Interstellar (2014) IMAX MULTi VFI 2160p 10bit DV HDR10+ BluRay x265 TrueHD 7.1 Atmos-XAND.mkv', 2014],
    ['The Dark Knight', '[DK2] The Dark Knight Hybri8 MULTI VFF 5 1 MA',
      '[DK2] The Dark Knight (2008) [2160p HDR10 HybriDV8 x265 MULTI VFF 5.1 DTS HDMA].mkv', 2008],
    ['Gladiator', 'www UIndex org Gladiator Cut 5 1 DoVi',
      'www.UIndex.org    -    Gladiator 2000 Extended Cut PROPER UHD BluRay 1080p DDP 5 1 DoVi HD.mkv', 2000],
    ['John Wick 4', 'John Wick Chapter 4 Hybrid + 7 1',
      'John Wick Chapter 4 2023 Hybrid 2160p UHD BluRay REMUX DV HDR10+ HEVC TrueHD 7.1 Atmos-Dat.mkv', 2023],
  ];
  for (const [wanted, parsed, file, year] of cases) {
    const ev = evaluateIdentityEligibility(
      movieHitForTitle(parsed, file, year),
      { mediaType: 'movie', mediaTitle: wanted, year },
    );
    assert.equal(ev.eligible, true, `${parsed} must satisfy ${wanted}: ${ev.reason}`);
  }
});

test('movie portion isolation cannot manufacture agreement', () => {
  // Wrong film with residue: year token present, but the pre-year title
  // is a different movie. Isolation must not rescue it.
  const ev = evaluateIdentityEligibility(
    movieHitForTitle('From Russia With Love 5 1', 'From.Russia.With.Love.1963.2160p.BluRay.HEVC.TrueHD.5.1.mkv', 1963),
    { mediaType: 'movie', mediaTitle: '8 1/2', year: 1963 },
  );
  assert.equal(ev.eligible, false);
  assert.equal(ev.code, 'title_mismatch');
  // Commentary brand is content, not a tag: the altered-content scan
  // fires first (Rifftrax is a commentary track, never the clean film).
  const ev2 = evaluateIdentityEligibility(
    movieHitForTitle('Rifftrax The Matrix', 'Rifftrax- The Matrix (1999) 2160p.BluRay.HDR.DDP5.1.x265 -Mesc.mkv', 1999),
    { mediaType: 'movie', mediaTitle: 'The Matrix', year: 1999 },
  );
  assert.equal(ev2.eligible, false, 'commentary track is not the clean film');
  assert.equal(ev2.code, 'altered_content');
});

// --- 8. Association vetoes ------------------------------------------------

test('Verified tier cannot survive a current title contradiction', async () => {
  const { classifyIdentityTier } = await import('../src/lib/discovery/ranking.js');
  const hit = {
    hash: 'poison',
    filename: DIDDY_FILE,
    relevance: 1.0,
    releaseAttributes: {
      title: DIDDY_TITLE, season: 1, episode: 1, mediaType: 'episode',
    },
    sources: [{ origin: 'corpus' }],
    mediaAssociations: [{ mediaId: 'tt0159187', confidence: 0.95 }],
  };
  const tier = classifyIdentityTier(hit, { season: 1, episode: 1, mediaTitle: 'Mogul' }, 'tt0159187');
  assert.equal(tier.IdentityTier, 'Rejected');
  assert.ok(tier.IdentityEvidence.includes('title-contradiction'));
});

test('Verified tier cannot survive contradictory coordinates', async () => {
  const { classifyIdentityTier } = await import('../src/lib/discovery/ranking.js');
  const hit = {
    hash: 'wrongep',
    filename: 'Mogul.S01E02.1080p.mkv',
    relevance: 1.0,
    releaseAttributes: { title: 'Mogul', season: 1, episode: 2, mediaType: 'episode' },
    sources: [{ origin: 'corpus' }],
    mediaAssociations: [{ mediaId: 'tt0159187', confidence: 0.95 }],
  };
  const tier = classifyIdentityTier(hit, { season: 1, episode: 1, mediaTitle: 'Mogul' }, 'tt0159187');
  assert.equal(tier.IdentityTier, 'Rejected');
  assert.ok(tier.IdentityEvidence.includes('coordinate-contradiction'));
});

test('source IDs strengthen but never override file evidence', async () => {
  const { classifyIdentityTier } = await import('../src/lib/discovery/ranking.js');
  const liveHit = (imdbId) => ({
    hash: 'srchash',
    filename: 'Show.S01E01.1080p.mkv',
    relevance: 0.7,
    releaseAttributes: { title: 'Show', season: 1, episode: 1, mediaType: 'episode' },
    sources: [{ origin: 'live' }, { origin: 'prowlarr' }],
    ...(imdbId ? { sourceIds: { imdbId } } : {}),
    selectedMediaId: 'tt9999999',
  });
  const q = { season: 1, episode: 1, mediaTitle: 'Show' };
  // Agreeing source ID: ProviderConfirmed with corroboration evidence.
  const agree = classifyIdentityTier(liveHit('tt9999999'), q, 'tt9999999');
  assert.equal(agree.IdentityTier, 'ProviderConfirmed');
  assert.ok(agree.IdentityEvidence.includes('source-id-corroborated'));
  // Disagreeing source ID: capped at ProviderScoped even with S/E match.
  const disagree = classifyIdentityTier(liveHit('tt0000001'), q, 'tt9999999');
  assert.equal(disagree.IdentityTier, 'ProviderScoped');
  assert.ok(disagree.IdentityEvidence.includes('source-id-mismatch'));
  // No source ID: scope + S/E still confirms (pre-existing behavior).
  const bare = classifyIdentityTier(liveHit(null), q, 'tt9999999');
  assert.equal(bare.IdentityTier, 'ProviderConfirmed');
});

// --- 9. Backfill is supporting evidence only ------------------------------

test('backfill persists only current-evidence tiers, capped, with gate provenance', async () => {
  const { backfillRequestMediaAssociations } = await import('../src/api/media-request-stages.js');
  const written = [];
  const cache = {
    upsertMediaAssociation: (infoHash, fileIndex, mediaId, opts) => {
      written.push({ infoHash, fileIndex, mediaId, opts });
    },
  };
  const rows = [
    { infoHash: 'verified', fileIndex: null, rank: 1, identity: { eligible: true, tier: 'Verified', confidence: 1.0, state: 'resolved' } },
    { infoHash: 'probable', fileIndex: null, rank: 2, identity: { eligible: true, tier: 'Probable', confidence: 0.8, state: 'unresolved' } },
    { infoHash: 'textonly', fileIndex: null, rank: 3, identity: { eligible: true, tier: 'TextOnly', confidence: 0.2, state: 'unresolved' } },
    { infoHash: 'scoped', fileIndex: null, rank: 4, identity: { eligible: true, tier: 'ProviderScoped', confidence: 0.4, state: 'unresolved' } },
    { infoHash: 'inelig', fileIndex: null, rank: 5, identity: { eligible: false, tier: 'Ineligible', confidence: 0, state: 'unresolved' } },
  ];
  const n = backfillRequestMediaAssociations(cache, { mediaId: 'ttX' }, rows, 99);
  assert.equal(n, 2, 'only Verified + Probable persist');
  assert.deepEqual(written.map((w) => w.infoHash), ['verified', 'probable']);
  for (const w of written) {
    assert.ok(w.opts.confidence <= 0.6, 'request-ranked confidence is capped');
    assert.equal(w.opts.matchMethod, 'request-ranked');
    assert.ok(w.opts.evidence.some((e) => String(e).startsWith('tier:')), 'gate tier recorded as provenance');
  }
});

// --- 10. Selected-file checks ---------------------------------------------

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

/**
 * Ranker V2 minimal-correction tests (ranker forensic tranche).
 *
 * Locks the proven fixes, nothing more:
 *  1. live source classes score (REMUX/BluRay/WEB-DL/WEBRip/HDTV + case)
 *  2. theatrical captures penalized below unknown (no resolution premium)
 *  3. tier-aware binding order (strong identity before weak cached)
 *  4. year gate: match/mismatch/unknown/absurd, movies only
 *  5. episodeMatch present in persisted score breakdown
 *  6. TV Prowlarr scope guard (contradiction + unverifiable rejection)
 *
 * Run:
 *   node --test test/ranker-v2.test.js
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  rankHit,
  qualityScore,
  evaluateIdentityEligibility,
  classifyIdentityTier,
} from '../src/lib/discovery/ranking.js';
import { selectBindableCandidate } from '../src/lib/discovery/selection.js';
import { detectTheatricalSource } from '../src/lib/discovery/quality-features.js';

function liveHit(hash, filename, attrs) {
  return {
    hash, fileIndex: 0, filename, relevance: 0.8,
    releaseAttributes: attrs,
    parserConfidence: 0.5, mediaAssociations: [], providerObservations: [],
    sources: [{ origin: 'live' }], selectedMediaId: 'ttX', hasLiveDiscovery: true,
  };
}

// ---------------------------------------------------------------------------
// 1. Live source classes contribute (fix 1)
// ---------------------------------------------------------------------------

test('v2: live REMUX > BluRay > WEB-DL > WEBRip > HDTV strictly orders', () => {
  const rows = [
    ['remux', { resolution: '2160p', source: 'REMUX', codec: 'x265', hdr: true }],
    ['bluray', { resolution: '2160p', source: 'BluRay', codec: 'x265', hdr: true }],
    ['webdl', { resolution: '2160p', source: 'WEB-DL', codec: 'x265', hdr: true }],
    ['webrip', { resolution: '2160p', source: 'WEBRip', codec: 'x264', hdr: false }],
    ['hdtv', { resolution: '720p', source: 'HDTV', codec: 'x264', hdr: false }],
  ].map(([h, at], i) => rankHit(liveHit(`h${i}`, `M.${at.resolution}.mkv`, at), {}, 'ttX'));
  const scores = rows.map((r) => r.score);
  const sorted = [...scores].sort((a, b) => b - a);
  assert.deepEqual(scores, sorted, 'strictly monotonic with source hierarchy');
  assert.ok(scores[0] - scores[4] > 0.05, 'material spread, not hash lottery');
});

test('v2: source class is case-insensitive across upstream vocabularies', () => {
  const q = (sourceType) => qualityScore({ resolution: '2160p', sourceType, codec: 'x265', hdr: true });
  assert.equal(q('REMUX'), q('Remux'));
  assert.equal(q('Remux'), q('remux'));
  assert.ok(q('REMUX') > 0.89, 'REMUX scores premium in any case');
  const d = qualityScore({ resolution: '1080p', sourceType: 'blu-ray' });
  assert.ok(d > 0.6, 'hyphenated bluray resolves');
});

test('v2: corpus canonical classes unchanged', () => {
  // Parser-normalized vocabulary must score exactly as before.
  assert.equal(qualityScore({ resolution: '2160p', sourceType: 'Remux', codec: 'x265', hdr: true }).toFixed(2), '0.90');
  assert.equal(qualityScore({ resolution: '1080p', sourceType: 'BluRay', codec: 'x264', hdr: false }).toFixed(3), '0.695');
  assert.equal(qualityScore({}), 0, 'unknown still zero, not negative');
});

// ---------------------------------------------------------------------------
// 2. Theatrical captures (fix 3)
// ---------------------------------------------------------------------------

test('v2: CAM/TS/TC/SCR filenames score below unknown', () => {
  const cam = rankHit(
    liveHit('c1', 'Movie.2026.1080p.CAM.x264-GROUP', { resolution: '1080p', codec: 'x264' }),
    {}, 'ttX',
  );
  const unknown720 = rankHit(
    liveHit('u1', 'Movie.2026.720p-GROUP.mkv', { resolution: '720p', codec: 'x264' }),
    {}, 'ttX',
  );
  const remux720 = rankHit(
    liveHit('r1', 'Movie.2026.720p.REMUX.x264-GROUP.mkv', { resolution: '720p', source: 'REMUX', sourceType: 'REMUX', codec: 'x264' }),
    {}, 'ttX',
  );
  assert.ok(cam.components.quality < unknown720.components.quality,
    `1080p CAM (${cam.components.quality}) must not beat unknown 720p (${unknown720.components.quality}) on resolution`);
  assert.ok(cam.components.quality < remux720.components.quality, 'CAM below legitimate source');
  assert.equal(cam.releaseAttributes.sourceType, 'cam', 'override visible for explainability');
});

test('v2: theatrical detector is group-safe and extension-safe', () => {
  assert.equal(detectTheatricalSource('Movie.2026.1080p.WEB-DL.DDP5.1.H.264-TC'), null);
  assert.equal(detectTheatricalSource('Movie.2026.1080p.BluRay.DTS.x264-GROUP'), null);
  assert.equal(detectTheatricalSource('Episode.S01E01.1080p.HDTV.ts'), null);
  assert.equal(detectTheatricalSource('Movie.2026.HDTS.x264-GROUP'), 'cam');
  assert.equal(detectTheatricalSource('Movie.2026.TC.x264-GROUP'), 'cam');
  assert.equal(detectTheatricalSource('Movie.2026.DVDSCR.x264-GROUP'), 'cam');
});

// ---------------------------------------------------------------------------
// 3. Tier-aware binding order (fix 2)
// ---------------------------------------------------------------------------

function explainedRow(hash, tier, avail, rank) {
  return {
    infoHash: hash, fileIndex: 0, filename: `${hash}.mkv`, rank,
    score: 0.5, identity: { tier, eligible: true },
    availability: { torbox: { state: avail } },
    // Exact byte size so PATH A (size binding) actually attempts.
    exactFileSize: 1000000000 + rank,
    release: {}, sources: [],
  };
}

test('v2: strong identity binds before weak cached regardless of rank', async () => {
  const calls = [];
  const ensure = async ({ infoHash }) => {
    calls.push(infoHash);
    if (infoHash === 'strong') return { torrentFileId: 'tf_strong' };
    throw Object.assign(new Error('nope'), { code: 'NO_PLACEMENT' });
  };
  // Weak cached row ranked FIRST (rank 1), strong uncached... no:
  // strong CACHED row ranked LAST must still win over weak cached first.
  const rows = [
    explainedRow('weak', 'ProviderScoped', 'cached', 1),
    explainedRow('strong', 'Verified', 'cached', 2),
  ];
  const sel = await selectBindableCandidate(rows, { ensureTorBoxFileIdentityFn: ensure });
  assert.equal(sel.selected.infoHash, 'strong');
  assert.deepEqual(calls, ['strong'], 'weak row never attempted once strong binds');
});

test('v2: uncached strong is attempted before weak cached, falls back cleanly', async () => {
  const calls = [];
  const ensure = async ({ infoHash }) => {
    calls.push(infoHash);
    if (infoHash === 'weak') return { torrentFileId: 'tf_weak' };
    throw Object.assign(new Error('nope'), { code: 'SIZE_MISMATCH' });
  };
  const rows = [
    explainedRow('weak', 'TextOnly', 'cached', 1),
    explainedRow('strong', 'Probable', 'uncached', 2),
  ];
  const sel = await selectBindableCandidate(rows, { ensureTorBoxFileIdentityFn: ensure });
  // Strong-uncached cannot bind (placement is cached-only by construction)
  // but must be TRIED first; weak cached is the honest fallback.
  assert.equal(calls[0], 'strong');
  assert.equal(sel.selected.infoHash, 'weak');
});

// ---------------------------------------------------------------------------
// 4. Year gate (fix 4)
// ---------------------------------------------------------------------------

test('v2: year gate matches, mismatches, and never guesses', () => {
  const hit = (year) => ({ releaseAttributes: { title: 'Dune', year } });
  const q = (year) => ({ mediaType: 'movie', mediaTitle: 'Dune', year });
  assert.equal(evaluateIdentityEligibility(hit(2021), q(2021)).eligible, true);
  assert.equal(evaluateIdentityEligibility(hit(1984), q(2021)).eligible, false);
  assert.equal(evaluateIdentityEligibility(hit(1984), q(2021)).code, 'year_mismatch');
  assert.equal(evaluateIdentityEligibility(hit(null), q(2021)).eligible, true, 'unknown candidate year never rejects');
  assert.equal(evaluateIdentityEligibility(hit(1984), q(null)).eligible, true, 'unknown requested year never rejects');
  assert.equal(evaluateIdentityEligibility(hit(1984), {}).eligible, true, 'no year context never rejects');
  assert.equal(evaluateIdentityEligibility(hit(0), q(2021)).eligible, true, 'absurd candidate year treated as unknown');
  assert.equal(evaluateIdentityEligibility(hit('2021'), q(2021)).eligible, true, 'string years coerce');
  // TV excluded: series span years; season identity already gates.
  const tvHit = { releaseAttributes: { title: 'Show', year: 2019, season: 1, episode: 1 } };
  assert.equal(
    evaluateIdentityEligibility(tvHit, { mediaType: 'series', season: 1, episode: 1, mediaTitle: 'Show', year: 2011 }).eligible,
    true,
  );
});

// ---------------------------------------------------------------------------
// 5. Full six-component breakdown (fix 5)
// ---------------------------------------------------------------------------

test('v2: persisted breakdown carries all six components', () => {
  const r = rankHit(
    liveHit('e1', 'S.S01E01.1080p.WEB-DL.mkv', { season: 1, episode: 1, resolution: '1080p', source: 'WEB-DL', codec: 'x264' }),
    { season: 1, episode: 1 }, 'ttS',
  );
  const keys = Object.keys(r.justification.scoreBreakdown).sort();
  assert.deepEqual(keys, ['cacheScore', 'episodeMatchScore', 'metadataScore', 'popularityScore', 'qualityDetails', 'qualityScore', 'sourceScore']);
});

// ---------------------------------------------------------------------------
// 6. TV null-S/E scope behavior locked (fix 7 parked)
// ---------------------------------------------------------------------------

test('v2: Prowlarr null-S/E rows fail closed, scoped rows keep scope trust', () => {
  // Fix 7 proof: Prowlarr hints are unenforced (observed live: majority
  // wrong-S/E + ~40% null-S/E responses), so a Prowlarr row with no
  // parseable coordinates, no pack shape, and no query-season token
  // carries zero episode evidence and is ineligible. Torrentio-style
  // scoped rows (no prowlarr origin) keep scope trust; parsed wrong
  // episodes were already rejected.
  const prowlarrNull = {
    releaseAttributes: { title: 'Game of Thrones' },
    filename: 'Game.of.Thrones.720p.BluRay.x264-GROUP.mkv',
    sources: [
      { origin: 'live', evidence: ['prowlarr-tracker-source'], confidence: 0.7 },
      { origin: 'prowlarr', evidence: ['prowlarr-tracker'], confidence: 0.7 },
    ],
    selectedMediaId: 'tt0944947',
  };
  const q = { season: 1, episode: 1, mediaType: 'series', mediaTitle: 'Game of Thrones' };
  const el = evaluateIdentityEligibility(prowlarrNull, q);
  assert.equal(el.eligible, false);
  assert.equal(el.code, 'prowlarr_episode_unverifiable');
  // Same row without Prowlarr origin (scoped API trust): eligible.
  const scoped = { ...prowlarrNull, sources: [{ origin: 'live' }] };
  assert.equal(evaluateIdentityEligibility(scoped, q).eligible, true);
  // Pack-shaped Prowlarr row (query-season token present): eligible.
  const pack = {
    ...prowlarrNull,
    filename: 'Game.of.Thrones.S01.COMPLETE.1080p.BluRay.x265-GROUP.mkv',
  };
  assert.equal(evaluateIdentityEligibility(pack, q).eligible, true);
  // Contradicting season token: rejected even with pack-ish shape.
  const wrongSeason = {
    ...prowlarrNull,
    filename: 'Game.of.Thrones.S05.COMPLETE.720p.BluRay.x264-GROUP.mkv',
  };
  const elW = evaluateIdentityEligibility(wrongSeason, q);
  assert.equal(elW.eligible, false);
  assert.equal(elW.code, 'prowlarr_season_contradiction');
  // Parsed wrong-episode rows were and remain rejected:
  const wrong = {
    releaseAttributes: { title: 'Game of Thrones', season: 5, episode: 10 },
    sources: [{ origin: 'live' }],
    selectedMediaId: 'tt0944947',
  };
  assert.equal(
    evaluateIdentityEligibility(wrong, { season: 1, episode: 1, mediaType: 'series' }).eligible,
    false,
  );
});

test('v2: premium audio orders losslessly without dominating', () => {
  const q = (audio) => qualityScore({ resolution: '2160p', sourceType: 'WEB-DL', codec: 'x265', audio });
  const atmos = q('TrueHD Atmos');
  const dtsx = q('DTS:X');
  const truehd = q('TrueHD');
  const dtshd = q('DTS-HD MA');
  const ddAtmos = q('DDP Atmos 5.1');
  const dd = q('DDP 5.1');
  const ac3 = q('AC-3');
  const aac = q('AAC');
  const none = q(null);
  assert.ok(atmos >= dtsx && dtsx >= truehd, `lossless object first: ${atmos} ${dtsx} ${truehd}`);
  assert.ok(truehd >= dtshd && dtshd > ddAtmos, `lossless above lossy: ${truehd} ${dtshd} ${ddAtmos}`);
  assert.ok(ddAtmos >= dd && dd >= ac3 && ac3 >= aac && aac >= none, `lossy order: ${ddAtmos} ${dd} ${ac3} ${aac} ${none}`);
  assert.ok(atmos - none < 0.03, 'audio swing stays below source/resolution steps');
});

test('v2: source class dominates minor HDR/audio bonuses', () => {
  const q = (at) => qualityScore(at);
  // REMUX HDR10 beats WEBRip DV (source gap > HDR gap).
  assert.ok(
    q({ resolution: '2160p', sourceType: 'Remux', codec: 'x265', hdr: 'HDR10' })
    > q({ resolution: '2160p', sourceType: 'WEBRip', codec: 'x265', hdr: 'DV' }),
    'REMUX HDR10 > WEBRip DV',
  );
  // BluRay HDR10 beats WEB-DL DV.
  assert.ok(
    q({ resolution: '2160p', sourceType: 'BluRay', codec: 'x265', hdr: 'HDR10' })
    > q({ resolution: '2160p', sourceType: 'WEB-DL', codec: 'x265', hdr: 'DV' }),
    'BluRay HDR10 > WEB-DL DV',
  );
  // 2160p WEB-DL AAC beats 1080p WEB-DL TrueHD (resolution > audio).
  assert.ok(
    q({ resolution: '2160p', sourceType: 'WEB-DL', codec: 'x265', audio: 'AAC' })
    > q({ resolution: '1080p', sourceType: 'WEB-DL', codec: 'x265', audio: 'TrueHD Atmos' }),
    '2160p AAC > 1080p TrueHD Atmos',
  );
});

test('v2: quality breakdown exposes hdr/audio inputs', () => {
  const r = rankHit(
    liveHit('e1', 'M.2020.2160p.BluRay.DV.TrueHD.mkv', { resolution: '2160p', source: 'BluRay', codec: 'x265', hdr: 'DV', audio: 'TrueHD Atmos' }),
    {}, 'ttX',
  );
  const det = r.justification.scoreBreakdown.qualityDetails;
  assert.equal(det.hdr, 'DV');
  assert.equal(det.audio, 'TrueHD Atmos');
  assert.equal(det.hdrBonus, 0.125);
  assert.equal(det.audioBonus, 0.025);
});

// ---------------------------------------------------------------------------
// Intent quality cap (quality-profile tranche)
// ---------------------------------------------------------------------------

function tieredRow(hash, source, resolution, rank) {
  return {
    infoHash: hash, fileIndex: 0, filename: `${hash}.mkv`, rank,
    score: 0.5, identity: { tier: 'Probable', eligible: true },
    availability: { torbox: { state: 'cached' } },
    exactFileSize: 2000000000 + rank,
    release: { source, resolution }, sources: [],
  };
}

test('profile cap: hd binds best at-or-below terminal, uncapped binds top', async () => {
  const ensure = async ({ infoHash }) => ({ torrentFileId: `tf_${infoHash}` });
  const rows = [
    tieredRow('remux', 'Remux', '2160p', 1),
    tieredRow('bluray', 'BluRay', '1080p', 2),
    tieredRow('webdl', 'WEB-DL', '1080p', 3),
  ];
  const capped = await selectBindableCandidate(rows, {
    ensureTorBoxFileIdentityFn: ensure, maxTier: 42,
  });
  assert.equal(capped.selected.infoHash, 'bluray');
  const open = await selectBindableCandidate(rows, {
    ensureTorBoxFileIdentityFn: ensure, maxTier: null,
  });
  assert.equal(open.selected.infoHash, 'remux');
  const omitted = await selectBindableCandidate(rows, {
    ensureTorBoxFileIdentityFn: ensure,
  });
  assert.equal(omitted.selected.infoHash, 'remux', 'omitted cap behaves exactly as before');
});

test('profile cap: all-above-cap falls back unfiltered instead of failing', async () => {
  const ensure = async ({ infoHash }) => ({ torrentFileId: `tf_${infoHash}` });
  const rows = [tieredRow('remux', 'Remux', '2160p', 1)];
  const sel = await selectBindableCandidate(rows, {
    ensureTorBoxFileIdentityFn: ensure, maxTier: 42,
  });
  assert.equal(sel.selected.infoHash, 'remux');
});

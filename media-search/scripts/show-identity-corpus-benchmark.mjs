#!/usr/bin/env node
/**
 * Read-only real-corpus study for conservative show identity.
 *
 * Usage:
 *   DISCOVERY_DB=/path/discovery-cache.db node scripts/show-identity-corpus-benchmark.mjs
 *
 * The persisted candidate_media association is used only as a bounded oracle
 * for classification; this script never writes candidate_media or any other
 * discovery state.
 */
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { agreeShowIdentity } from '../src/lib/discovery/show-identity.js';
import { isEpisodeCovered } from '../src/lib/discovery/episode-coverage.js';

const dbPath = process.env.DISCOVERY_DB || '/home/patrick/hashsucker-data/discovery/discovery-cache.db';
const db = new DatabaseSync(dbPath, { readOnly: true });

// Provider-neutral contexts. These are deliberately explicit: no Cinemeta,
// TMDB, Stremio, Torrentio, or provider response objects enter this study.
const shows = [
  ['Breaking Bad', 'tt0903747', 2008], ['Ted Lasso', 'tt10986410', 2020],
  ['When They See Us', 'tt7137906', 2019], ['Chernobyl', 'tt7366338', 2019],
  ['True Detective', 'tt2356777', 2014], ['Fleabag', 'tt5687612', 2016],
  ['The Office', 'tt0386676', 2005], ['Game of Thrones', 'tt0944947', 2011],
  ['The Sopranos', 'tt0141842', 1999], ['The Last of Us', 'tt3581920', 2023],
  ['Dune', 'tt12451788', 2021], ['Sinners', 'tt31193180', 2025],
  ['Star Wars', 'tt0076759', 1977], ['Interstellar', 'tt0816692', 2014],
  ['The Godfather', 'tt0068646', 1972], ['The Matrix', 'tt0133093', 1999],
  ['Inception', 'tt1375666', 2010], ['The Dark Knight', 'tt1345836', 2008],
  ['Titanic', 'tt0120338', 1997], ['Pulp Fiction', 'tt0110912', 1994],
  ['Casablanca', 'tt0034583', 1942], ['Back to the Future', 'tt0088763', 1985],
  ['The Twilight Zone', 'tt0052520', 1959], ['Deadwood', 'tt0348914', 2004],
  ['House', 'tt0412142', 2004], ['Lost', 'tt0411008', 2004],
  ['Dark', 'tt5753856', 2017], ['From', 'tt9813792', 2022],
  ['You', 'tt7335184', 2018], ['Friends', 'tt0108778', 1994],
];

function ftsMatch(title) {
  const tokens = String(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/ +/).filter(Boolean);
  return tokens.length ? tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ') : '""';
}
function percent(n, d) { return d ? Number((100 * n / d).toFixed(2)) : 0; }
function percentile(values, p) {
  if (!values.length) return 0;
  const xs = [...values].sort((a, b) => a - b);
  return xs[Math.min(xs.length - 1, Math.ceil(xs.length * p) - 1)];
}
function classifyKnownPositives(rows, mediaId) {
  const cm = db.prepare('SELECT 1 FROM candidate_media WHERE info_hash=? AND file_index_key=? AND media_id=?');
  const out = { acceptedKnownPositive: 0, rejectedKnownPositive: 0, unlabeledAccepted: 0, unlabeledRejected: 0 };
  for (const row of rows) {
    const knownPositive = Boolean(cm.get(row.info_hash, row.file_index_key, mediaId));
    if (knownPositive && row.accepted) out.acceptedKnownPositive++;
    else if (knownPositive) out.rejectedKnownPositive++;
    else if (row.accepted) out.unlabeledAccepted++;
    else out.unlabeledRejected++;
  }
  return out;
}
function add(a, b) { for (const k of Object.keys(a)) a[k] += b[k]; return a; }

const modes = { existing: [], scoped: [], persisted: [] };
const totals = { existing: {acceptedKnownPositive:0,rejectedKnownPositive:0,unlabeledAccepted:0,unlabeledRejected:0}, scoped: {acceptedKnownPositive:0,rejectedKnownPositive:0,unlabeledAccepted:0,unlabeledRejected:0}, persisted: {acceptedKnownPositive:0,rejectedKnownPositive:0,unlabeledAccepted:0,unlabeledRejected:0} };
const answerability = { existing: {one:0,three:0,ten:0,unresolved:0}, scoped: {one:0,three:0,ten:0,unresolved:0}, persisted: {one:0,three:0,ten:0,unresolved:0} };
const timings = { metadata: [], fts: [], identity: [], episode: [], total: [] };
const perShow = [];

for (const [canonicalTitle, mediaId, firstAirYear] of shows) {
  const associated = db.prepare('SELECT COUNT(*) n FROM candidate_media WHERE media_id=?').get(mediaId).n;
  const context = { canonicalTitle, alternateTitles: [], originalTitle: null, firstAirYear, externalIds: { imdb: mediaId }, episodeTitles: [] };
  const t0 = performance.now();
  const tm = performance.now();
  // Metadata context is already provider-neutral and local in this offline study.
  timings.metadata.push(performance.now() - tm);
  const tf = performance.now();
  const rows = db.prepare(`
    SELECT ra.info_hash, ra.file_index_key, ra.filename, ra.title, ra.year, ra.season,
           ra.episode, ra.episode_range, ra.media_type, ra.resolution, ra.source_type,
           ra.codec, ra.hdr, ra.audio, ra.release_group
    FROM release_search rs JOIN release_attributes ra ON ra.rowid=rs.rowid
    WHERE release_search MATCH ? LIMIT 5000`).all(ftsMatch(canonicalTitle));
  timings.fts.push(performance.now() - tf);
  const ti = performance.now();
  const scopedRows = rows.map((row) => ({ ...row, accepted: agreeShowIdentity({ ...context, release: { filename: row.filename }, year: row.year }).matched }));
  timings.identity.push(performance.now() - ti);
  const te = performance.now();
  const episodeRows = scopedRows.map((row) => ({ ...row, accepted: row.accepted && isEpisodeCovered({ ...row, episodeRange: row.episode_range, seasonOnly: row.media_type === 'season' }, 1, 1) }));
  timings.episode.push(performance.now() - te);
  timings.total.push(performance.now() - t0);
  const persistedRows = rows.map((row) => ({ ...row, accepted: Boolean(db.prepare('SELECT 1 FROM candidate_media WHERE info_hash=? AND file_index_key=? AND media_id=?').get(row.info_hash, row.file_index_key, mediaId)) }));
  const existingRows = rows.map((row) => ({ ...row, accepted: isEpisodeCovered({ ...row, episodeRange: row.episode_range, seasonOnly: row.media_type === 'season' }, 1, 1) }));
  const resultRows = { existing: existingRows, scoped: episodeRows, persisted: persistedRows };
  for (const mode of Object.keys(resultRows)) {
    const c = classifyKnownPositives(resultRows[mode], mediaId); add(totals[mode], c);
    const accepted = resultRows[mode].filter((r) => r.accepted).length;
    answerability[mode].one += accepted >= 1; answerability[mode].three += accepted >= 3; answerability[mode].ten += accepted >= 10; answerability[mode].unresolved += accepted === 0;
  }
  perShow.push({ canonicalTitle, mediaId, associated, before: rows.length, existing: existingRows.filter(r=>r.accepted).length, scoped: episodeRows.filter(r=>r.accepted).length, persisted: persistedRows.filter(r=>r.accepted).length });
}

console.log(JSON.stringify({
  status: 'offline-read-only', dbPath, sampleSize: shows.length,
  metadataContract: ['canonicalTitle','originalTitle?','alternateTitles[]','firstAirYear?','externalIds?','episodeTitle?','episodeTitles[]'],
  classificationOracle: 'candidate_media exact association; bounded, not exhaustive manual truth',
  perShow, totals,
  metrics: Object.fromEntries(Object.entries(totals).map(([mode,c]) => [mode, { ...c, knownPositiveRecovery: percent(c.acceptedKnownPositive, c.acceptedKnownPositive+c.rejectedKnownPositive) }])),
  note: 'Unlabeled FTS candidates are reported separately and are not false positives or true negatives.',
  answerability, latencyMs: Object.fromEntries(Object.entries(timings).map(([k,v]) => [k, { p50: Number(percentile(v,.5).toFixed(3)), p95: Number(percentile(v,.95).toFixed(3)) }])),
}, null, 2));
db.close();

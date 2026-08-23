import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createDiscoveryCache } from './cache.js';
import { qualityScore } from './ranking.js';
import { combinedSearch, searchReleases } from './search-engine.js';

const REPORT_VERSION = 1;
const DEFAULT_RETRIEVAL_WINDOW = 2000;
const NEUTRAL = 0.5;
const SCORE_PRECISION = 1000;

const RESOLUTION_QUALITY = {
  '2160p': 1.0,
  '1080p': 0.9,
  '720p': 0.7,
  '480p': 0.4,
  '360p': 0.2,
};

const SOURCE_QUALITY = {
  Remux: 1.0,
  BluRay: 0.95,
  'WEB-DL': 0.85,
  WEBRip: 0.75,
  HDTV: 0.6,
  DSRip: 0.5,
  DVD: 0.4,
};

function roundScore(value) {
  return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}

function identity(infoHash, fileIndex) {
  return { infoHash, fileIndex: fileIndex ?? null };
}

function identityKey(value) {
  if (!value) return null;
  const infoHash = value.infoHash ?? value.hash;
  return `${infoHash}:${value.fileIndex == null ? 'torrent' : value.fileIndex}`;
}

function sameIdentity(a, b) {
  return identityKey(a) === identityKey(b);
}

function toNativeWinner(result) {
  if (!result) return null;
  return {
    ...identity(result.hash, result.fileIndex),
    score: result.score,
    components: result.components,
  };
}

function toReferenceWinner(result) {
  if (!result) return null;
  return {
    ...identity(result.info_hash, result.file_index_key === -1 ? null : result.file_index_key),
    score: result.score,
    components: {
      relevance: roundScore(result.relevance),
      quality: roundScore(result.quality),
      releaseConfidence: roundScore(result.releaseConfidence),
      identityConfidence: NEUTRAL,
      providerAvailability: NEUTRAL,
      episodeMatch: NEUTRAL,
    },
  };
}

/** Build the fixture producer's quoted prefix-AND FTS expression. */
export function buildReferenceMatch(query) {
  const terms = String(query ?? '').trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) {
    throw new Error('Stage 3 reference queries must contain at least one term');
  }
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"*`)
    .join(' AND ');
}

function referenceQuality(row, includeHevc4kBonus) {
  let quality = (RESOLUTION_QUALITY[row.resolution] ?? 0) * 0.4;
  quality += (SOURCE_QUALITY[row.source_type] ?? 0) * 0.3;
  quality += row.codec === 'x265' ? 0.1 : row.codec === 'x264' ? 0.05 : 0;
  quality += row.hdr === 1 ? 0.15 : 0;
  if (includeHevc4kBonus && row.resolution === '2160p' && row.codec === 'x265') {
    quality += 0.1;
  }
  return Math.min(1, quality);
}

function rankReferenceRows(rows, { bm25Field, includeHevc4kBonus }) {
  return rows.map((row) => {
    const bm25 = row[bm25Field] ?? 0;
    const relevance = 1 / (1 + Math.abs(bm25));
    const quality = referenceQuality(row, includeHevc4kBonus);
    const releaseConfidence = row.confidence || NEUTRAL;
    const score = roundScore(
      relevance * 0.25
      + quality * 0.20
      + releaseConfidence * 0.20
      + NEUTRAL * 0.15
      + NEUTRAL * 0.10
      + NEUTRAL * 0.10,
    );
    return { ...row, relevance, quality, releaseConfidence, score };
  }).sort(compareReferenceRows);
}

function compareReferenceRows(a, b) {
  if (a.score !== b.score) return b.score - a.score;
  if (a.releaseConfidence !== b.releaseConfidence) {
    return b.releaseConfidence - a.releaseConfidence;
  }
  if (a.quality !== b.quality) return b.quality - a.quality;
  if (a.relevance !== b.relevance) return b.relevance - a.relevance;
  if (a.info_hash !== b.info_hash) return a.info_hash < b.info_hash ? -1 : 1;
  const aIndex = a.file_index_key === -1 ? Number.MAX_SAFE_INTEGER : a.file_index_key;
  const bIndex = b.file_index_key === -1 ? Number.MAX_SAFE_INTEGER : b.file_index_key;
  return aIndex - bIndex;
}

function compareReferenceWinner(a, b) {
  if (!a || !b) return 'unresolved';
  if (a.score !== b.score) return 'ranking-formula';
  if (a.components.releaseConfidence !== b.components.releaseConfidence) {
    return 'release-confidence-tie-break';
  }
  if (a.components.quality !== b.components.quality) return 'quality-tie-break';
  if (a.components.relevance !== b.components.relevance) return 'relevance-tie-break';
  if (a.infoHash !== b.infoHash) return 'hash-tie-break';
  if (a.fileIndex !== b.fileIndex) return 'file-index-tie-break';
  return 'unresolved';
}

function selectReferenceRows(db, query) {
  return db.prepare(`
    SELECT
      ra.*,
      bm25(release_search) AS local_bm25
    FROM release_search rs
    JOIN release_attributes ra ON ra.rowid = rs.rowid
    WHERE release_search MATCH @match
  `).all({ match: buildReferenceMatch(query) });
}

function evaluateReferencePhases(db, query, retrievalWindow) {
  const rows = selectReferenceRows(db, query);
  const localRuntimeQuality = rankReferenceRows(rows, {
    bm25Field: 'local_bm25',
    includeHevc4kBonus: false,
  });
  const localReferenceQuality = rankReferenceRows(rows, {
    bm25Field: 'local_bm25',
    includeHevc4kBonus: true,
  });
  const productionRuntimeQuality = rankReferenceRows(rows, {
    bm25Field: 'production_bm25',
    includeHevc4kBonus: false,
  });
  const reference = rankReferenceRows(rows, {
    bm25Field: 'production_bm25',
    includeHevc4kBonus: true,
  });
  const cappedRows = [...rows]
    .sort((a, b) => {
      if (a.production_bm25 !== b.production_bm25) return a.production_bm25 - b.production_bm25;
      return a.production_rowid - b.production_rowid;
    })
    .slice(0, retrievalWindow);
  const cappedReference = rankReferenceRows(cappedRows, {
    bm25Field: 'production_bm25',
    includeHevc4kBonus: true,
  });

  return {
    candidateCount: rows.length,
    winners: {
      localRuntimeQuality: toReferenceWinner(localRuntimeQuality[0]),
      localReferenceQuality: toReferenceWinner(localReferenceQuality[0]),
      productionRuntimeQuality: toReferenceWinner(productionRuntimeQuality[0]),
      reference: toReferenceWinner(reference[0]),
      cappedReference: toReferenceWinner(cappedReference[0]),
    },
    referenceRows: reference,
  };
}

function expectedWinner(vector) {
  return {
    ...identity(vector.expectedWinner.infoHash, vector.expectedWinner.fileIndex),
    score: vector.expectedWinner.rankingScore,
    stage1Ordinal: vector.expectedWinner.stage1Ordinal,
  };
}

function expectedCappedWinner(vector) {
  return {
    ...identity(vector.cappedWinner.infoHash, vector.cappedWinner.fileIndex),
    score: vector.cappedWinner.rankingScore,
    sameAsUncapped: vector.cappedWinner.sameAsUncapped,
  };
}

function findStage1Ordinal(rows, expected) {
  const ordered = [...rows].sort((a, b) => {
    if (a.production_bm25 !== b.production_bm25) return a.production_bm25 - b.production_bm25;
    return a.production_rowid - b.production_rowid;
  });
  const index = ordered.findIndex((row) => sameIdentity(
    identity(row.info_hash, row.file_index_key === -1 ? null : row.file_index_key),
    expected,
  ));
  return index < 0 ? null : index + 1;
}

function mismatchReasons({ vector, native, phases }) {
  const reasons = [];
  const expected = expectedWinner(vector);
  const reference = phases.winners.reference;

  if (!sameIdentity(native.winner, phases.winners.localRuntimeQuality)) {
    reasons.push('query-parser');
  }
  if (!sameIdentity(phases.winners.localRuntimeQuality, phases.winners.productionRuntimeQuality)) {
    reasons.push('bm25-scope');
  }
  if (!sameIdentity(phases.winners.productionRuntimeQuality, reference)) {
    reasons.push('ranking-formula');
  }
  if (!sameIdentity(reference, expected)) {
    const expectedRow = phases.referenceRows.find((row) => sameIdentity(
      identity(row.info_hash, row.file_index_key === -1 ? null : row.file_index_key),
      expected,
    ));
    reasons.push(compareReferenceWinner(reference, toReferenceWinner(expectedRow)));
    reasons.push('reference-vector-conflict');
  }
  if (!sameIdentity(phases.winners.cappedReference, reference)) {
    reasons.push('retrieval-window');
  }
  if (phases.referenceRows.some((row) => row.production_bm25 == null)) {
    reasons.push('missing-production-bm25');
  }
  return [...new Set(reasons)];
}

async function sha256(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function validateFixturePath(filePath) {
  const fixtureStat = await stat(filePath);
  if (!fixtureStat.isFile()) throw new Error(`Stage 3 fixture is not a file: ${filePath}`);
}

async function evaluateNativeQueries(fixturePath, vectors, retrievalWindow) {
  const tempDir = await mkdtemp(path.join(tmpdir(), 'hashsucker-stage3-'));
  const copyPath = path.join(tempDir, path.basename(fixturePath));
  let cache;
  try {
    await copyFile(fixturePath, copyPath);
    cache = createDiscoveryCache({ dbPath: copyPath });
    const results = {};
    for (const vector of vectors.queries) {
      const direct = searchReleases(cache, {
        query: vector.query,
        limit: Math.max(vector.candidateCount + 1, retrievalWindow),
      });
      const combined = await combinedSearch(cache, {
        query: vector.query,
        retrievalWindow,
        limit: 1,
      });
      results[vector.query] = {
        candidateCount: direct.total,
        query: direct.query,
        winner: toNativeWinner(direct.results[0]),
        cappedWinner: toNativeWinner(combined.results[0]),
      };
    }
    return results;
  } finally {
    cache?.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Evaluate current runtime retrieval and the frozen production-ranking reference
 * without making either implementation depend on the other.
 */
export async function evaluateStage3Fixtures({
  fixturePath,
  vectorsPath,
  manifestPath = null,
  retrievalWindow = DEFAULT_RETRIEVAL_WINDOW,
  includeNative = true,
} = {}) {
  if (!fixturePath) throw new Error('fixturePath is required');
  if (!vectorsPath) throw new Error('vectorsPath is required');
  if (!Number.isInteger(retrievalWindow) || retrievalWindow <= 0) {
    throw new Error('retrievalWindow must be a positive integer');
  }

  await validateFixturePath(fixturePath);
  const fixtureHashBefore = await sha256(fixturePath);
  const vectors = await loadJson(vectorsPath);
  const manifest = manifestPath ? await loadJson(manifestPath) : null;
  const nativeByQuery = includeNative
    ? await evaluateNativeQueries(fixturePath, vectors, retrievalWindow)
    : {};

  const db = new DatabaseSync(fixturePath, { readOnly: true });
  let queryResults;
  try {
    queryResults = vectors.queries.map((vector) => {
      const phases = evaluateReferencePhases(db, vector.query, retrievalWindow);
      const expected = expectedWinner(vector);
      const expectedCapped = expectedCappedWinner(vector);
      const native = nativeByQuery[vector.query] ?? {
        candidateCount: null,
        query: null,
        winner: null,
        cappedWinner: null,
      };
      const reference = phases.winners.reference;
      const stage1Ordinal = findStage1Ordinal(phases.referenceRows, expected);
      return {
        query: vector.query,
        expected: {
          candidateCount: vector.candidateCount,
          winner: expected,
          cappedWinner: expectedCapped,
        },
        native,
        reference: {
          candidateCount: phases.candidateCount,
          stage1Ordinal,
          winner: reference,
          cappedWinner: phases.winners.cappedReference,
        },
        phases: phases.winners,
        matches: {
          candidateCount: phases.candidateCount === vector.candidateCount,
          stage1Ordinal: stage1Ordinal === expected.stage1Ordinal,
          referenceIdentity: sameIdentity(reference, expected),
          referenceScore: reference?.score === expected.score,
          cappedReferenceIdentity: sameIdentity(phases.winners.cappedReference, expectedCapped),
          nativeIdentity: includeNative ? sameIdentity(native.winner, expected) : null,
          nativeScore: includeNative ? native.winner?.score === expected.score : null,
        },
        mismatchReasons: includeNative
          ? mismatchReasons({ vector, native, phases })
          : [],
        specialCases: vector.specialCases,
      };
    });
  } finally {
    db.close();
  }

  const fixtureHashAfter = await sha256(fixturePath);
  const manifestByQuery = new Map((manifest?.queries ?? []).map((entry) => [entry.query, entry]));
  const referenceManifestIdentityMatches = manifest
    ? queryResults.filter((result) => sameIdentity(
      result.reference.winner,
      manifestByQuery.get(result.query)?.winner,
    )).length
    : null;

  const summary = {
    queryCount: queryResults.length,
    candidateCountMatches: queryResults.filter((result) => result.matches.candidateCount).length,
    stage1OrdinalMatches: queryResults.filter((result) => result.matches.stage1Ordinal).length,
    referenceIdentityMatches: queryResults.filter((result) => result.matches.referenceIdentity).length,
    referenceScoreMatches: queryResults.filter((result) => result.matches.referenceScore).length,
    referenceManifestIdentityMatches,
    cappedReferenceIdentityMatches: queryResults.filter((result) => result.matches.cappedReferenceIdentity).length,
    cappedWinnerChanges: queryResults.filter((result) => !sameIdentity(
      result.reference.winner,
      result.reference.cappedWinner,
    )).length,
    nativeIdentityMatches: includeNative
      ? queryResults.filter((result) => result.matches.nativeIdentity).length
      : null,
    nativeScoreMatches: includeNative
      ? queryResults.filter((result) => result.matches.nativeScore).length
      : null,
  };

  return {
    schemaVersion: REPORT_VERSION,
    mode: includeNative ? 'native-and-reference' : 'reference-only',
    fixture: {
      path: path.resolve(fixturePath),
      sha256Before: fixtureHashBefore,
      sha256After: fixtureHashAfter,
      unchanged: fixtureHashBefore === fixtureHashAfter,
      nativeEvaluation: includeNative ? 'isolated-writable-copy' : 'not-run',
      referenceEvaluation: 'source-read-only',
    },
    inputs: {
      vectorsPath: path.resolve(vectorsPath),
      manifestPath: manifestPath ? path.resolve(manifestPath) : null,
      retrievalWindow,
      vectorsVersion: vectors.version,
      manifestVersion: manifest?.version ?? null,
    },
    contract: {
      native: 'Current searchReleases()/combinedSearch() behavior on an isolated fixture copy',
      reference: 'Quoted prefix-AND FTS, production_bm25, handoff quality formula, documented tie order',
      productionDependency: false,
    },
    summary,
    queries: queryResults,
  };
}

/** Validate basic fixture structure without invoking runtime bootstrap. */
export function inspectStage3Fixture(fixturePath) {
  const db = new DatabaseSync(fixturePath, { readOnly: true });
  try {
    const releaseRows = db.prepare('SELECT COUNT(*) AS count FROM release_attributes').get().count;
    const ftsRows = db.prepare('SELECT COUNT(*) AS count FROM release_search').get().count;
    const nullRows = db.prepare('SELECT COUNT(*) AS count FROM release_attributes WHERE file_index IS NULL AND file_index_key = -1').get().count;
    const invalidNullRows = db.prepare('SELECT COUNT(*) AS count FROM release_attributes WHERE (file_index IS NULL) != (file_index_key = -1)').get().count;
    const duplicateIdentities = db.prepare(`
      SELECT COUNT(*) AS count FROM (
        SELECT info_hash, file_index_key, COUNT(*) AS rows
        FROM release_attributes
        GROUP BY info_hash, file_index_key
        HAVING rows > 1
      )
    `).get().count;
    return {
      releaseRows,
      ftsRows,
      ftsCoverageComplete: releaseRows === ftsRows,
      nullFileIndexRows: nullRows,
      invalidNullMappings: invalidNullRows,
      duplicateExactIdentities: duplicateIdentities,
    };
  } finally {
    db.close();
  }
}

/** Exposed only for focused harness tests; production ranking remains authoritative. */
export function compareRuntimeAndReferenceQuality(attributes) {
  const row = {
    resolution: attributes.resolution ?? null,
    source_type: attributes.sourceType ?? null,
    codec: attributes.codec ?? null,
    hdr: attributes.hdr === true ? 1 : 0,
  };
  return {
    runtime: qualityScore(attributes),
    reference: referenceQuality(row, true),
  };
}

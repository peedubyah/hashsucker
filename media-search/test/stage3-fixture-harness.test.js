import assert from 'node:assert/strict';
import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  buildReferenceMatch,
  compareRuntimeAndReferenceQuality,
  evaluateStage3Fixtures,
  inspectStage3Fixture,
} from '../src/lib/discovery/stage3-fixture-evaluator.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(TEST_DIR, '../..');
const ARTIFACT_ROOT = path.join(REPOSITORY_ROOT, 'artifacts/stage3');
const FUNCTIONAL_FIXTURE = path.join(ARTIFACT_ROOT, 'dmm-stage3-functional.db');
const RANKING_FIXTURE = path.join(ARTIFACT_ROOT, 'dmm-stage3-ranking.db');
const VECTORS = path.join(ARTIFACT_ROOT, 'stage3-query-vectors.json');
const MANIFEST = path.join(ARTIFACT_ROOT, 'dmm-stage3-fixture-manifest.json');
const EXPECTED_FUNCTIONAL_SHA256 = 'b420de8fc3cdf30cb5d4aa78ad56452737a2631e3174bbce241b08df4a3d2645';
const EXPECTED_RANKING_SHA256 = '07151dd4c4aac82d89a10377a1b92f138cc22f6abd98ae59b0a57f4d422dec9b';

async function exists(filePath) {
  try {
    await access(filePath, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

test('reference query builder preserves prefix-AND producer semantics', () => {
  assert.equal(buildReferenceMatch('Dragon Ball'), '"Dragon"* AND "Ball"*');
  assert.equal(buildReferenceMatch('Director\'s Cut'), '"Director\'s"* AND "Cut"*');
  assert.equal(buildReferenceMatch('  Sci-Fi  '), '"Sci-Fi"*');
  assert.throws(() => buildReferenceMatch('  '), /at least one term/);
});

test('reference quality remains separate from production runtime quality', () => {
  const quality = compareRuntimeAndReferenceQuality({
    resolution: '2160p',
    sourceType: 'BluRay',
    codec: 'x265',
    hdr: false,
  });
  assert.equal(quality.runtime, 0.785);
  assert.equal(quality.reference, 0.885);
});

test('functional fixture is structurally compatible and identity-safe', async (t) => {
  if (!(await exists(FUNCTIONAL_FIXTURE))) {
    t.skip(`external fixture not available: ${FUNCTIONAL_FIXTURE}`);
    return;
  }

  const inspection = inspectStage3Fixture(FUNCTIONAL_FIXTURE);
  assert.deepEqual(inspection, {
    releaseRows: 529,
    ftsRows: 529,
    ftsCoverageComplete: true,
    nullFileIndexRows: 529,
    invalidNullMappings: 0,
    duplicateExactIdentities: 0,
  });
});

test('ranking fixture reproduces the accepted Stage 3 evidence', {
  skip: process.env.STAGE3_RANKING_FIXTURE !== '1'
    ? 'set STAGE3_RANKING_FIXTURE=1 or run npm run test:stage3:ranking'
    : false,
  timeout: 180_000,
}, async (t) => {
  for (const filePath of [RANKING_FIXTURE, VECTORS, MANIFEST]) {
    if (!(await exists(filePath))) {
      t.skip(`external Stage 3 artifact not available: ${filePath}`);
      return;
    }
  }

  const report = await evaluateStage3Fixtures({
    fixturePath: RANKING_FIXTURE,
    vectorsPath: VECTORS,
    manifestPath: MANIFEST,
    retrievalWindow: 2000,
    includeNative: true,
  });

  assert.equal(report.fixture.sha256Before, EXPECTED_RANKING_SHA256);
  assert.equal(report.fixture.sha256After, EXPECTED_RANKING_SHA256);
  assert.equal(report.fixture.unchanged, true);
  assert.equal(report.fixture.nativeEvaluation, 'isolated-writable-copy');
  assert.equal(report.fixture.referenceEvaluation, 'source-read-only');
  assert.deepEqual(report.summary, {
    queryCount: 30,
    candidateCountMatches: 30,
    stage1OrdinalMatches: 29,
    referenceIdentityMatches: 27,
    referenceScoreMatches: 28,
    referenceManifestIdentityMatches: 25,
    cappedReferenceIdentityMatches: 22,
    cappedWinnerChanges: 11,
    nativeIdentityMatches: 10,
    nativeScoreMatches: 0,
  });

  const changedByCap = report.queries
    .filter((query) => query.mismatchReasons.includes('retrieval-window'))
    .map((query) => query.query);
  assert.deepEqual(changedByCap, [
    'One Piece',
    'Batman',
    'Horror',
    'Criterion',
    'Remux',
    'Extended',
    'Dual Audio',
    'Subs',
    'Dubbed',
    'AAC',
    'DTS-HD',
  ]);

  const remux = report.queries.find((query) => query.query === 'Remux');
  assert.equal(remux.native.query.match, '*');
  assert.equal(remux.native.query.filters.source, 'Remux');
  assert.ok(remux.mismatchReasons.includes('query-parser'));

  const referenceConflicts = report.queries
    .filter((query) => query.mismatchReasons.includes('reference-vector-conflict'))
    .map((query) => query.query);
  assert.deepEqual(referenceConflicts, ['My Hero Academia', 'Comedy', 'Sci-Fi']);

  assert.ok(report.queries.every((query) => query.reference.winner.fileIndex === null));
});

test('functional fixture checksum constant documents the transferred source', () => {
  assert.match(EXPECTED_FUNCTIONAL_SHA256, /^[0-9a-f]{64}$/);
});

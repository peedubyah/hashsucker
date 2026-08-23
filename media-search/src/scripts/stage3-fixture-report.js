#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  evaluateStage3Fixtures,
  inspectStage3Fixture,
} from '../lib/discovery/stage3-fixture-evaluator.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MEDIA_SEARCH_ROOT = path.resolve(SCRIPT_DIR, '../..');
const REPOSITORY_ROOT = path.resolve(MEDIA_SEARCH_ROOT, '..');
const DEFAULT_ARTIFACT_ROOT = path.join(REPOSITORY_ROOT, 'artifacts/stage3');

function usage() {
  return `Usage: node src/scripts/stage3-fixture-report.js [options]

Options:
  --fixture <path>       Ranking fixture database
  --vectors <path>       Stage 3 query vectors JSON
  --manifest <path>      Stage 3 fixture manifest JSON
  --window <rows>        Retrieval window to compare (default: 2000)
  --reference-only       Skip current-runtime evaluation
  --json                 Print the stable JSON report
  --output <path>        Write the JSON report to a file
  --help                 Show this help

The source fixture is opened read-only for reference evaluation. Native runtime
retrieval runs only against an isolated temporary writable copy.`;
}

function parseArgs(argv) {
  const options = {
    fixturePath: path.join(DEFAULT_ARTIFACT_ROOT, 'dmm-stage3-ranking.db'),
    vectorsPath: path.join(DEFAULT_ARTIFACT_ROOT, 'stage3-query-vectors.json'),
    manifestPath: path.join(DEFAULT_ARTIFACT_ROOT, 'dmm-stage3-fixture-manifest.json'),
    retrievalWindow: 2000,
    includeNative: true,
    json: false,
    output: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
      index += 1;
      return value;
    };

    if (argument === '--fixture') options.fixturePath = path.resolve(nextValue());
    else if (argument === '--vectors') options.vectorsPath = path.resolve(nextValue());
    else if (argument === '--manifest') options.manifestPath = path.resolve(nextValue());
    else if (argument === '--window') options.retrievalWindow = Number.parseInt(nextValue(), 10);
    else if (argument === '--reference-only') options.includeNative = false;
    else if (argument === '--json') options.json = true;
    else if (argument === '--output') options.output = path.resolve(nextValue());
    else if (argument === '--help') options.help = true;
    else throw new Error(`Unknown option: ${argument}`);
  }
  return options;
}

function humanReport(report, fixtureInspection) {
  const { summary } = report;
  const lines = [
    'Stage 3 fixture regression report',
    `Mode: ${report.mode}`,
    `Fixture: ${report.fixture.path}`,
    `Fixture SHA-256: ${report.fixture.sha256Before}`,
    `Fixture unchanged: ${report.fixture.unchanged ? 'yes' : 'NO'}`,
    `Rows / FTS rows: ${fixtureInspection.releaseRows} / ${fixtureInspection.ftsRows}`,
    `Exact-identity duplicates: ${fixtureInspection.duplicateExactIdentities}`,
    '',
    `Queries: ${summary.queryCount}`,
    `Candidate cardinalities: ${summary.candidateCountMatches}/${summary.queryCount}`,
    `Production Stage 1 ordinals: ${summary.stage1OrdinalMatches}/${summary.queryCount}`,
    `Reference identities: ${summary.referenceIdentityMatches}/${summary.queryCount}`,
    `Reference scores: ${summary.referenceScoreMatches}/${summary.queryCount}`,
    `2000-cap changed winner: ${summary.cappedWinnerChanges}/${summary.queryCount}`,
  ];
  if (summary.nativeIdentityMatches != null) {
    lines.push(
      `Native identities vs vectors: ${summary.nativeIdentityMatches}/${summary.queryCount}`,
      `Native scores vs vectors: ${summary.nativeScoreMatches}/${summary.queryCount}`,
    );
  }

  const mismatches = report.queries.filter((query) => query.mismatchReasons.length > 0);
  if (mismatches.length > 0) {
    lines.push('', 'Attributed differences:');
    for (const mismatch of mismatches) {
      lines.push(`- ${mismatch.query}: ${mismatch.mismatchReasons.join(', ')}`);
    }
  }
  return lines.join('\n');
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    console.log(usage());
    return;
  }

  const report = await evaluateStage3Fixtures(options);
  const fixtureInspection = inspectStage3Fixture(options.fixturePath);
  const serialized = `${JSON.stringify({ ...report, fixtureInspection }, null, 2)}\n`;

  if (options.output) await writeFile(options.output, serialized, 'utf8');
  if (options.json) console.log(serialized.trimEnd());
  else console.log(humanReport(report, fixtureInspection));

  if (!report.fixture.unchanged || !fixtureInspection.ftsCoverageComplete) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`stage3-fixture-report: ${error.stack || error.message}`);
  process.exitCode = 1;
});

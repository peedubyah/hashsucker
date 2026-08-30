#!/usr/bin/env node
/**
 * DMM Corpus Finalization
 *
 * Materializes release_attributes and release_search (FTS) for the
 * authoritative dmm-final.db corpus using the production parser-adapter.js
 * (parseFilename) and the existing INSERT_RELEASE_ATTRIBUTES SQL path.
 *
 * Bulk workload: batched transactions, no per-row autocommit.
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { parseFilename } from '../lib/discovery/parser-adapter.js';

const DB_PATH = process.env.DMM_FINAL_DB || path.resolve(
  process.cwd(), '../../artifacts/dmm-rebuild/dmm-final.db'
);
const BATCH_SIZE = parseInt(process.env.FINALIZE_BATCH_SIZE || '10000', 10);
const SOURCE = 'ptn-regex';

// INSERT_RELEASE_ATTRIBUTES from cache.js (production path)
const INSERT_RELEASE_ATTRIBUTES = `
INSERT INTO release_attributes (
  info_hash, file_index, file_index_key, source, filename, confidence,
  title, year, media_type, season, episode, episode_range, resolution, source_type,
  codec, hdr, audio, language, release_group, evidence, parsed_at
) VALUES (
  @info_hash, @file_index, @file_index_key, @source, @filename, @confidence,
  @title, @year, @media_type, @season, @episode, @episode_range, @resolution, @source_type,
  @codec, @hdr, @audio, @language, @release_group, @evidence, @parsed_at)
ON CONFLICT(info_hash, file_index_key, source) DO UPDATE SET
  filename = EXCLUDED.filename,
  confidence = EXCLUDED.confidence,
  title = EXCLUDED.title,
  year = EXCLUDED.year,
  media_type = EXCLUDED.media_type,
  season = EXCLUDED.season,
  episode = EXCLUDED.episode,
  episode_range = EXCLUDED.episode_range,
  resolution = EXCLUDED.resolution,
  source_type = EXCLUDED.source_type,
  codec = EXCLUDED.codec,
  hdr = EXCLUDED.hdr,
  audio = EXCLUDED.audio,
  language = EXCLUDED.language,
  release_group = EXCLUDED.release_group,
  evidence = EXCLUDED.evidence,
  parsed_at = EXCLUDED.parsed_at;
`;

function fileIndexKey(fileIndex) {
  return fileIndex == null ? -1 : fileIndex;
}

function main() {
  const startTime = Date.now();

  console.log(`Opening DB: ${DB_PATH}`);
  const db = new DatabaseSync(DB_PATH, { readOnly: false });

  // Count total candidates
  const totalCandidates = db.prepare('SELECT COUNT(*) as c FROM candidates').get().c;
  console.log(`Total candidates: ${totalCandidates.toLocaleString()}`);

  // Get candidates without release attributes
  const candidateRows = db.prepare(`
    SELECT c.info_hash, c.file_index, c.file_index_key, c.filename, c.title
    FROM candidates c
    LEFT JOIN release_attributes ra ON c.info_hash = ra.info_hash AND c.file_index_key = ra.file_index_key
    WHERE ra.info_hash IS NULL
  `).all();

  console.log(`Candidates needing release_attributes: ${candidateRows.length.toLocaleString()}`);

  const insertStmt = db.prepare(INSERT_RELEASE_ATTRIBUTES);

  const stats = {
    total: candidateRows.length,
    parsed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    rejectionReasons: {
      nullFilename: 0,
      emptyFilename: 0,
      parseReturnedNull: 0,
      parseException: 0,
    },
  };

  // Parse all candidates first (CPU-bound)
  const parsedBatch = [];
  for (const row of candidateRows) {
    const filename = row.filename || row.title;
    if (!filename) {
      stats.skipped++;
      stats.rejectionReasons.nullFilename++;
      continue;
    }
    if (!filename.trim()) {
      stats.skipped++;
      stats.rejectionReasons.emptyFilename++;
      continue;
    }

    try {
      const result = parseFilename(filename);
      if (!result) {
        stats.skipped++;
        stats.rejectionReasons.parseReturnedNull++;
        continue;
      }

      const { parsed, confidence, evidence } = result;
      parsedBatch.push({
        info_hash: row.info_hash,
        file_index: row.file_index ?? null,
        file_index_key: fileIndexKey(row.file_index),
        source: SOURCE,
        filename: filename,
        confidence: confidence ?? 0.5,
        title: parsed.title ?? null,
        year: parsed.year ?? null,
        media_type: parsed.mediaType ?? null,
        season: parsed.season ?? null,
        episode: parsed.episode ?? null,
        episode_range: parsed.episodeRange ?? null,
        resolution: parsed.resolution ?? null,
        source_type: parsed.source ?? null,
        codec: parsed.codec ?? null,
        hdr: parsed.hdr === true ? 1 : 0,
        audio: parsed.audio ?? null,
        language: parsed.language ?? null,
        release_group: parsed.releaseGroup ?? null,
        evidence: JSON.stringify(evidence || []),
        parsed_at: Date.now(),
      });
      stats.parsed++;
    } catch (error) {
      stats.failed++;
      stats.rejectionReasons.parseException++;
      if (stats.errors.length < 10) {
        stats.errors.push({ filename: filename.substring(0, 80), error: error.message });
      }
    }
  }

  console.log(`Parsed: ${stats.parsed.toLocaleString()}, Skipped: ${stats.skipped.toLocaleString()}, Failed: ${stats.failed.toLocaleString()}`);

  // Bulk insert in transactions
  let inserted = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let i = 0; i < parsedBatch.length; i++) {
      const attrs = parsedBatch[i];
      insertStmt.run(attrs);
      inserted++;

      if ((i + 1) % BATCH_SIZE === 0) {
        db.exec('COMMIT');
        db.exec('BEGIN IMMEDIATE');
        console.log(`  Inserted ${(i + 1).toLocaleString()} / ${parsedBatch.length.toLocaleString()}`);
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    console.error('Insert failed:', error.message);
    throw error;
  }

  console.log(`Inserted ${inserted.toLocaleString()} release_attributes rows`);

  // Final counts
  const finalRA = db.prepare('SELECT COUNT(*) as c FROM release_attributes').get().c;
  const finalRS = db.prepare('SELECT COUNT(*) as c FROM release_search').get().c;
  const finalPrev = db.prepare('SELECT COUNT(*) as c FROM dmm_hash_prevalence').get().c;
  const finalCand = db.prepare('SELECT COUNT(*) as c FROM candidates').get().c;
  const missing = db.prepare(`
    SELECT COUNT(*) as c FROM candidates c
    LEFT JOIN release_attributes ra ON c.info_hash = ra.info_hash AND c.file_index_key = ra.file_index_key
    WHERE ra.info_hash IS NULL
  `).get().c;

  // DB size
  const dbStat = fs.statSync(DB_PATH);
  const dbSizeMB = (dbStat.size / (1024 * 1024)).toFixed(1);

  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n=== FINAL REPORT ===');
  console.log(`Candidates: ${finalCand.toLocaleString()}`);
  console.log(`release_attributes: ${finalRA.toLocaleString()}`);
  console.log(`release_search (FTS): ${finalRS.toLocaleString()}`);
  console.log(`prevalence: ${finalPrev.toLocaleString()}`);
  console.log(`Candidates missing release_attributes: ${missing.toLocaleString()}`);
  console.log(`Parsing failures: ${stats.failed}`);
  console.log(`Rejection reasons:`, stats.rejectionReasons);
  if (stats.errors.length > 0) {
    console.log('Sample errors:');
    stats.errors.forEach(e => console.log(`  ${e.filename}: ${e.error}`));
  }
  console.log(`DB size: ${dbSizeMB} MB`);
  console.log(`Elapsed: ${elapsedSec}s`);

  db.close();
  console.log('\nDone.');
}

main();

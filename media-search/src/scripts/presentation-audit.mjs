#!/usr/bin/env node
/**
 * PRESENTATION AUDIT — what the library actually looks like to a consumer.
 *
 * The presentation identity is durable and committed once, so the audit
 * compares what IS committed against what the consumer-visible trees
 * actually contain. It reports, per published item:
 *
 *   - the committed identity (the authority), if any;
 *   - the canonical VFS path (the byte path);
 *   - the `.strm` artifact path (the consumer path);
 *   - the DRIFT between them, classified.
 *
 * It never renames anything and never mutates a media intent. With
 * `--adopt` it commits the identities that are missing, ADOPTING the paths
 * that are already published — the artifact the consumer already has keeps
 * its path. That is the whole repair: after adoption, a republication
 * writes to the same place instead of recomputing a name.
 *
 * Usage:
 *   node src/scripts/presentation-audit.mjs [--adopt] [--json]
 *
 * Environment: CONTROL_PLANE_DB, DISCOVERY_DB, STRM_OUTPUT_PATH.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createControlPlaneStore } from '../lib/control-plane/store.js';

const args = new Set(process.argv.slice(2));
const adopt = args.has('--adopt');
const asJson = args.has('--json');

const controlPlaneDb = process.env.CONTROL_PLANE_DB || '/data/control-plane.db';
const discoveryDb = process.env.DISCOVERY_DB || '/data/discovery-cache.db';
const strmRoot = process.env.STRM_OUTPUT_PATH || '/strm';

/** The `.strm` artifacts on disk, keyed by the media identity they carry. */
function readStrmArtifacts() {
  const byIdentity = new Map();
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.strm')) continue;
      files.push(full);
      let content = '';
      try {
        content = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      const first = content.split('\n')[0].trim();
      const movie = first.match(/\/stream\/movie\/([A-Za-z0-9_]+)/);
      if (movie) {
        byIdentity.set(movie[1], full);
        continue;
      }
      const series = first.match(/\/stream\/series\/([A-Za-z0-9_]+)(?:\?season=(\d+)&episode=(\d+))?/);
      if (series) {
        byIdentity.set(`${series[1]}:${series[2] ?? ''}:${series[3] ?? ''}`, full);
      }
    }
  };
  walk(strmRoot);
  return { byIdentity, files };
}

/** The identity components a published `.strm` path carries. */
function nameFromStrmPath(strmPath) {
  const relative = path.relative(strmRoot, strmPath);
  const parts = relative.split(path.sep);
  const dir = parts.length >= 2 ? parts[parts.length - 2] : '';
  const file = parts.length >= 1 ? parts[parts.length - 1].replace(/\.strm$/, '') : '';
  const yearMatch = dir.match(/^(.*) \((\d{4})\)$/);
  return {
    title: yearMatch ? yearMatch[1] : dir,
    year: yearMatch ? Number(yearMatch[2]) : null,
  };
}

/** The canonical VFS paths, keyed by the media identity. */
function readVfsPaths() {
  const byIdentity = new Map();
  let db;
  try {
    db = new DatabaseSync(discoveryDb, { readOnly: true });
  } catch {
    return byIdentity;
  }
  try {
    for (const row of db.prepare('SELECT media_id, canonical_path FROM vfs_movie_entries').all()) {
      byIdentity.set(row.media_id, row.canonical_path);
    }
    for (const row of db.prepare('SELECT media_id, season, episode, canonical_path FROM vfs_tv_entries').all()) {
      byIdentity.set(`${row.media_id}:${row.season}:${row.episode}`, row.canonical_path);
    }
  } catch {
    // A missing discovery cache is not a reason to fail the audit.
  } finally {
    db.close();
  }
  return byIdentity;
}

function classifyDrift({ identity, vfsPath, strmPath }) {
  if (!vfsPath && !strmPath) return 'no-artifact';
  if (!identity) return 'not-committed';
  if (!strmPath) return 'strm-missing';
  if (!vfsPath) return 'vfs-missing';
  const expected = identity.strmPath;
  if (expected && path.relative(strmRoot, strmPath) === expected) return 'aligned';
  const name = nameFromStrmPath(strmPath);
  const identityName = `${identity.title}${identity.year ? ` (${identity.year})` : ''}`;
  if (name.title === identityName) return 'legacy-name';
  return 'name-differs';
}

async function main() {
  const store = createControlPlaneStore({ dbPath: controlPlaneDb });
  const { byIdentity, files } = readStrmArtifacts();
  const vfsPaths = readVfsPaths();
  const identities = store.listPresentationIdentities({ limit: 5000 });

  const rows = [];
  for (const identity of identities) {
    const key = identity.mediaType === 'movie'
      ? identity.mediaId
      : `${identity.mediaId}:${identity.season ?? ''}:${identity.episode ?? ''}`;
    const strmPath = byIdentity.get(key) ?? null;
    const vfsPath = vfsPaths.get(key) ?? identity.canonicalPath ?? null;
    rows.push({
      mediaId: identity.mediaId,
      mediaType: identity.mediaType,
      season: identity.season,
      episode: identity.episode,
      title: identity.title,
      year: identity.year,
      committedPath: identity.canonicalPath,
      committedStrmPath: identity.strmPath,
      vfsPath,
      strmPath: strmPath ? path.relative(strmRoot, strmPath) : null,
      drift: classifyDrift({ identity, vfsPath, strmPath }),
    });
  }

  // Items with an artifact but no committed identity: the adoption set.
  const uncommitted = [];
  for (const [key, strmPath] of byIdentity) {
    const mediaId = key.split(':')[0];
    const committed = identities.find((identity) => identity.mediaId === mediaId
      && (identity.mediaType === 'movie'
        ? key === mediaId
        : key === `${identity.mediaId}:${identity.season ?? ''}:${identity.episode ?? ''}`));
    if (committed) continue;
    uncommitted.push({
      key,
      strmPath: path.relative(strmRoot, strmPath),
      vfsPath: vfsPaths.get(key) ?? null,
    });
  }

  const adopted = [];
  if (adopt) {
    for (const item of uncommitted) {
      const [mediaId, season, episode] = item.key.split(':');
      const isMovie = !season && !episode;
      const libraryItem = store.getLibraryItemByIdentityKey(
        isMovie
          ? `movie:${mediaId}:default`
          : `episode:${mediaId}:default:${season}:${episode}`,
      );
      if (!libraryItem) continue;
      const name = nameFromStrmPath(path.join(strmRoot, item.strmPath));
      const result = store.commitPresentationIdentity(libraryItem.id, {
        title: name.title,
        year: name.year,
        canonicalPath: item.vfsPath ?? null,
        strmPath: item.strmPath,
      });
      if (result?.committed) {
        adopted.push({ key: item.key, strmPath: item.strmPath, vfsPath: item.vfsPath });
      }
    }
  }

  const summary = {};
  for (const row of rows) summary[row.drift] = (summary[row.drift] ?? 0) + 1;

  const report = {
    generatedAt: new Date().toISOString(),
    strmRoot,
    artifactsOnDisk: files.length,
    committedIdentities: identities.length,
    uncommittedArtifacts: uncommitted.length,
    adopted: adopted.length,
    drift: summary,
    rows,
    uncommitted,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`presentation audit @ ${report.generatedAt}`);
    console.log(`  artifacts on disk      : ${report.artifactsOnDisk}`);
    console.log(`  committed identities   : ${report.committedIdentities}`);
    console.log(`  artifacts without one  : ${report.uncommittedArtifacts}`);
    console.log(`  adopted this run       : ${report.adopted}`);
    console.log('  drift classes          :');
    for (const [drift, count] of Object.entries(summary)) {
      console.log(`    ${drift.padEnd(16)} ${count}`);
    }
    if (uncommitted.length) {
      console.log('  artifacts without a committed identity (first 20):');
      for (const item of uncommitted.slice(0, 20)) {
        console.log(`    ${item.key}  ${item.strmPath}`);
      }
    }
  }
  store.close();
}

await main();

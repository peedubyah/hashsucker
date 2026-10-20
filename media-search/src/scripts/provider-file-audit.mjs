#!/usr/bin/env node
/**
 * PROVIDER FILE IDENTITY AUDIT — does every provider file that carries a
 * route prove it is the TorrentFile it is mapped to?
 *
 * A provider file may carry a route to a TorrentFile only when its
 * canonical path AND its exact size are that TorrentFile's. This audit
 * reports, per provider file, whether that holds — and it never mutates
 * anything.
 *
 * Usage:
 *   node src/scripts/provider-file-audit.mjs [--json]
 *
 * Environment: CONTROL_PLANE_DB.
 */

import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { canonicalProviderPath } from '../lib/providers/exact-file-identity.js';

const asJson = process.argv.includes('--json');
const controlPlaneDb = process.env.CONTROL_PLANE_DB || '/data/control-plane.db';

const store = createControlPlaneStore({ dbPath: controlPlaneDb });

try {
  const rows = store.db.prepare(`
    SELECT pf.id AS provider_file_id, pf.placement_id, pf.provider_file_id,
           pf.path AS provider_path, pf.size AS provider_size, pf.present,
           pf.mapping_state, pf.torrent_file_id,
           pl.provider, pl.account_scope, pl.info_hash AS placement_hash,
           pl.provider_resource_id,
           tf.info_hash AS tf_hash, tf.internal_path AS tf_path, tf.size AS tf_size
    FROM provider_files pf
    JOIN provider_placements pl ON pl.id = pf.placement_id
    LEFT JOIN torrent_files tf ON tf.id = pf.torrent_file_id
  `).all();

  const classes = {};
  const detail = [];
  for (const row of rows) {
    let cls;
    if (!row.torrent_file_id) cls = 'unmapped';
    else if (!row.tf_hash) cls = 'missing-torrent-file';
    else if (String(row.tf_hash).toLowerCase() !== String(row.placement_hash ?? '').toLowerCase()) cls = 'release-mismatch';
    else if (!row.provider_size || !row.tf_size) cls = 'missing-size';
    else if (Number(row.provider_size) !== Number(row.tf_size)) cls = 'size-mismatch';
    else if (canonicalProviderPath(row.provider_path) !== canonicalProviderPath(row.tf_path)) cls = 'path-mismatch';
    else cls = 'exact';
    classes[cls] = (classes[cls] ?? 0) + 1;
    if (cls !== 'exact') {
      detail.push({
        provider: row.provider,
        resource: row.provider_resource_id,
        providerFileId: row.provider_file_id,
        providerPath: row.provider_path,
        providerSize: row.provider_size,
        torrentFileId: row.torrent_file_id,
        torrentFilePath: row.tf_path,
        torrentFileSize: row.tf_size,
        class: cls,
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    total: rows.length,
    classes,
    detail,
  };
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`provider file identity audit @ ${report.generatedAt}`);
    console.log(`  provider files audited : ${report.total}`);
    for (const [cls, count] of Object.entries(classes)) {
      console.log(`    ${cls.padEnd(22)} ${count}`);
    }
    if (detail.length) {
      console.log('  not exact (first 30):');
      for (const row of detail.slice(0, 30)) {
        console.log(`    ${row.class} ${row.provider} ${row.resource}/${row.providerFileId}`);
        console.log(`        provider ${row.providerPath} (${row.providerSize})`);
        console.log(`        torrent  ${row.torrentFilePath} (${row.torrentFileSize})`);
      }
    }
  }
} finally {
  store.close();
}

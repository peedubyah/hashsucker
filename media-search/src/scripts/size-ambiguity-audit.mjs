#!/usr/bin/env node
/**
 * SIZE-ONLY AMBIGUITY AUDIT — where a byte count is not a file.
 *
 * A provider file may carry a route to a TorrentFile only when its path
 * AND its exact size are the TorrentFile's. Where the discovery can state
 * only a byte count, a resource that holds TWO files of that size cannot
 * be resolved by count alone — and a resource that holds exactly one file
 * of that size may still be resolving the WRONG file.
 *
 * This audit counts both cases, from the provider's own inventories (the
 * only place a per-file path exists).
 *
 * Usage:
 *   node src/scripts/size-ambiguity-audit.mjs [--json]
 *
 * Environment: CONTROL_PLANE_DB.
 */

import { createControlPlaneStore } from '../lib/control-plane/store.js';

const asJson = process.argv.includes('--json');
const controlPlaneDb = process.env.CONTROL_PLANE_DB || '/data/control-plane.db';

const store = createControlPlaneStore({ dbPath: controlPlaneDb });

try {
  // Per placement: the files that share one exact byte count.
  const collisions = store.db.prepare(`
    SELECT pl.provider, pl.account_scope, pl.provider_resource_id, pf.size,
           COUNT(*) AS files,
           GROUP_CONCAT(pf.provider_file_id) AS provider_file_ids,
           GROUP_CONCAT(pf.path) AS paths
    FROM provider_files pf
    JOIN provider_placements pl ON pl.id = pf.placement_id
    WHERE pf.present = 1 AND pf.size IS NOT NULL AND pf.size > 0
    GROUP BY pl.id, pf.size
    HAVING COUNT(*) > 1
  `).all();

  // The mapped files: a provider file whose size is shared with another
  // file of the same resource is a file a size-only match could confuse.
  const mapped = store.db.prepare(`
    SELECT pl.provider, pl.provider_resource_id, pf.provider_file_id, pf.path, pf.size,
           pf.torrent_file_id,
           (SELECT COUNT(*) FROM provider_files other
             WHERE other.placement_id = pf.placement_id
               AND other.present = 1 AND other.size = pf.size) AS same_size_siblings
    FROM provider_files pf
    JOIN provider_placements pl ON pl.id = pf.placement_id
    WHERE pf.present = 1 AND pf.torrent_file_id IS NOT NULL
  `).all();

  const ambiguous = mapped.filter((row) => row.same_size_siblings > 1);
  const unique = mapped.filter((row) => row.same_size_siblings === 1);

  const byProvider = {};
  for (const row of collisions) {
    byProvider[row.provider] = (byProvider[row.provider] ?? 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mappedProviderFiles: mapped.length,
    sizeUniqueWithinResource: unique.length,
    sizeAmbiguousWithinResource: ambiguous.length,
    ambiguousResources: collisions.length,
    ambiguousByProvider: byProvider,
    ambiguousSamples: ambiguous.slice(0, 30).map((row) => ({
      provider: row.provider,
      resource: row.provider_resource_id,
      providerFileId: row.provider_file_id,
      providerPath: row.path,
      size: row.size,
      sameSizeSiblings: row.same_size_siblings,
      torrentFileId: row.torrent_file_id,
    })),
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`size-only ambiguity audit @ ${report.generatedAt}`);
    console.log(`  mapped provider files        : ${report.mappedProviderFiles}`);
    console.log(`    unique size in resource     : ${report.sizeUniqueWithinResource}`);
    console.log(`    AMBIGUOUS size in resource  : ${report.sizeAmbiguousWithinResource}`);
    console.log(`  resources with a size clash : ${report.ambiguousResources}`);
    for (const [provider, count] of Object.entries(report.ambiguousByProvider)) {
      console.log(`    ${provider.padEnd(14)} ${count}`);
    }
    for (const row of report.ambiguousSamples.slice(0, 10)) {
      console.log(`    ${row.provider} ${row.resource}/${row.providerFileId} size=${row.size} siblings=${row.sameSizeSiblings}`);
      console.log(`        ${row.providerPath}`);
    }
  }
} finally {
  store.close();
}

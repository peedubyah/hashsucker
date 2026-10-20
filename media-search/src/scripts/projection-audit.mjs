#!/usr/bin/env node
/**
 * CONSUMER PROJECTION AUDIT — what the consumers hold versus what our
 * durable truth says they should hold.
 *
 * The audit derives the desired projection from HashSucker's own durable
 * state (the library item, the committed presentation identity, the VFS
 * row, the binding), observes each consumer, and classifies the
 * difference. It NEVER repairs anything and never mutates a media intent:
 * a report first, a repair only where the class is unambiguous.
 *
 * Usage:
 *   node src/scripts/projection-audit.mjs [--json] [--limit N]
 *
 * Environment: CONTROL_PLANE_DB, DISCOVERY_DB, PLEX_*.
 */

import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { auditProjections } from '../lib/control-plane/projection-audit.js';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : 500;

const controlPlaneDb = process.env.CONTROL_PLANE_DB || '/data/control-plane.db';
const discoveryDb = process.env.DISCOVERY_DB || '/data/discovery-cache.db';

const store = createControlPlaneStore({ dbPath: controlPlaneDb });
const cache = createDiscoveryCache({ dbPath: discoveryDb });

try {
  const report = await auditProjections({
    store, cache, env: process.env, limit,
  });
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`consumer projection audit @ ${report.generatedAt}`);
    console.log(`  intents audited : ${report.total}`);
    for (const [state, count] of Object.entries(report.summary)) {
      console.log(`    ${state.padEnd(14)} ${count}`);
    }
    const interesting = report.rows.filter((row) => row.state !== 'aligned');
    if (interesting.length) {
      console.log('  projections that are not aligned (first 30):');
      for (const row of interesting.slice(0, 30)) {
        console.log(`    ${row.mediaId}${row.season != null ? ` S${row.season}E${row.episode}` : ''}`
          + ` ${row.state} ${row.detail ?? ''}`);
        if (row.expectedPartFile) console.log(`        expected ${row.expectedPartFile} (${row.expectedPartSize})`);
        if (row.observedPartFile) console.log(`        observed ${row.observedPartFile} (${row.observedPartSize})`);
      }
    }
  }
} finally {
  store.close();
  cache.close();
}

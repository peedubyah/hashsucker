#!/usr/bin/env node
/**
 * BYTE AUTHORITY AUDIT — does the VFS name the TorrentFile the Binding
 * names?
 *
 * Read-only by default: it reports the drift and classifies it. With
 * --repair it applies the projection (the VFS row follows the active
 * Binding) — never a reselection, never a provider call, never a
 * metadata lookup, never a consumer call.
 *
 * Usage:
 *   node src/scripts/byte-authority-audit.mjs [--json] [--repair]
 *
 * Environment: CONTROL_PLANE_DB, DISCOVERY_DB.
 */

import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { auditByteAuthority, reconcileByteAuthority } from '../lib/vfs/byte-projection.js';

const args = new Set(process.argv.slice(2));
const asJson = args.has('--json');
const repair = args.has('--repair');

const controlPlaneDb = process.env.CONTROL_PLANE_DB || '/data/control-plane.db';
const discoveryDb = process.env.DISCOVERY_DB || '/data/discovery-cache.db';

const store = createControlPlaneStore({ dbPath: controlPlaneDb });
const cache = createDiscoveryCache({ dbPath: discoveryDb });

try {
  const rows = auditByteAuthority({ store, cache });
  const summary = {};
  for (const row of rows) summary[row.state] = (summary[row.state] ?? 0) + 1;

  const report = { generatedAt: new Date().toISOString(), summary, total: rows.length, rows };
  if (repair) {
    const outcome = reconcileByteAuthority({ store, cache, dryRun: false });
    report.repair = {
      scanned: outcome.scanned,
      repaired: outcome.repaired.length,
      skipped: outcome.skipped.length,
      detail: outcome.repaired,
    };
  } else {
    const dry = reconcileByteAuthority({ store, cache, dryRun: true });
    report.dryRun = { scanned: dry.scanned, wouldProject: dry.repaired.length, skipped: dry.skipped.length };
  }

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`byte authority audit @ ${report.generatedAt}`);
    console.log(`  intents audited : ${report.total}`);
    for (const [state, count] of Object.entries(summary)) {
      console.log(`    ${state.padEnd(14)} ${count}`);
    }
    const drifted = rows.filter((r) => r.state === 'drifted');
    if (drifted.length) {
      console.log('  DRIFT (the VFS names a TorrentFile the Binding does not):');
      for (const row of drifted) {
        console.log(`    ${row.identityKey}`);
        console.log(`        binding ${row.bindingTorrentFileId} (${row.bindingSize}) v${row.bindingVersion}`);
        console.log(`        vfs     ${row.vfsTorrentFileId} (${row.vfsSize})`);
      }
    }
    if (report.dryRun) {
      console.log(`  dry run          : ${report.dryRun.wouldProject} would be projected, ${report.dryRun.skipped} skipped`);
    }
    if (report.repair) {
      console.log(`  repaired        : ${report.repair.repaired} projected, ${report.repair.skipped} skipped`);
    }
  }
} finally {
  store.close();
  cache.close();
}

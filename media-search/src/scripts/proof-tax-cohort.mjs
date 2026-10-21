#!/usr/bin/env node
/**
 * PROOF-TAX COHORT — run the real request pipeline in shadow mode and
 * record what the selection decided and why.
 *
 * WHY: the question is "what does exactness cost us?" — when the top-ranked
 * candidate is skipped because its exact identity could not be proven and a
 * lower-ranked candidate is chosen instead, what quality did the user get?
 * Answering it needs the DECISION plus the RANKING, joined per request.
 * The production DBs hold the ranking (media_request_results) and the winner
 * (playback_handoffs) but NOT the losers' reasons — hence the
 * selection_decisions diagnostic.
 *
 * SHADOW MODE: prepareOnly=true, so the pipeline does discovery → ranking →
 * selection → binding → durable persistence but NO presentation (no VFS
 * materialization, no .strm, no Plex/Jellyfin notification, no binding
 * activation). The provider identity work IS real (a cached-only TorBox
 * placement + authoritative inventory fetch is the only way to learn whether
 * a file can be proven exact), but nothing is published.
 *
 * SCRATCH: both DBs are scratch copies. The live corpus is read from the
 * scratch discovery DB copy; nothing writes to production.
 *
 * Usage:
 *   DISCOVERY_DB=... CONTROL_PLANE_DB=... TORBOX_API_KEY=... \
 *   node src/scripts/proof-tax-cohort.mjs <fixtures.json> [--json]
 *
 * The fixture file is a JSON array of
 *   { mediaId, mediaType, season?, episode?, label? }
 */

import { readFileSync } from 'node:fs';

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createTorBoxInventoryProvider } from '../lib/providers/torbox-inventory.js';
import { createTorBoxProvider } from '../lib/providers/torbox.js';
import { ensureTorBoxFileIdentity } from '../lib/resolver/torbox-file-identity.js';
import { searchByMedia } from '../api/media-request.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const fixturePath = args.find((a) => !a.startsWith('--'));

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';
const CP_PATH = process.env.CONTROL_PLANE_DB || ':memory:';

function loadEnv() {
  for (const file of ['.env', '../../.env']) {
    try { process.loadEnvFile(file); } catch { /* optional */ }
  }
}

async function main() {
  loadEnv();
  if (!fixturePath) {
    console.error('Usage: proof-tax-cohort.mjs <fixtures.json> [--json]');
    process.exit(1);
  }
  const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8'));

  const cache = createDiscoveryCache({ dbPath: DB_PATH });
  const controlPlaneStore = createControlPlaneStore({ dbPath: CP_PATH });

  const torBoxInventoryProvider = process.env.TORBOX_API_KEY
    ? createTorBoxInventoryProvider({ apiKey: process.env.TORBOX_API_KEY })
    : null;
  const torBoxProvider = process.env.TORBOX_API_KEY
    ? createTorBoxProvider({ apiKey: process.env.TORBOX_API_KEY })
    : null;

  // The real production seam: cached-only placement + authoritative
  // inventory. This is what proves (or fails to prove) a TorrentFile.
  const ensureTorBoxFileIdentityFn = async ({ infoHash, controlPlaneStore: cp, skipSizeMatch }) => ensureTorBoxFileIdentity({
    infoHash,
    controlPlaneStore: cp,
    torBoxInventoryProvider,
    torBoxProvider,
    skipSizeMatch: skipSizeMatch === true,
  });

  const results = [];
  for (const fixture of fixtures) {
    const label = fixture.label || `${fixture.mediaId}${fixture.season != null ? `:S${fixture.season}E${fixture.episode ?? ''}` : ''}`;
    const startedAt = Date.now();
    let record;
    try {
      const outcome = await searchByMedia(cache, {
        mediaId: fixture.mediaId,
        mediaType: fixture.mediaType || 'movie',
        season: fixture.season ?? null,
        episode: fixture.episode ?? null,
        source: 'proof-tax-cohort',
        sourceType: 'measurement',
        sourceId: label,
        sourceLabel: fixture.label || null,
        persist: true,
        // Shadow: no publication, no VFS, no .strm, no consumer notify.
        prepareOnly: true,
        // The prepared/healthy-publication fast paths would answer with the
        // EXISTING representation and never run discovery, ranking, or
        // selection — so the cohort would measure nothing. forceDiscovery
        // makes the request take the full path so the decision under
        // measurement actually happens.
        forceDiscovery: true,
        controlPlaneStore,
        ensureTorBoxFileIdentity: ensureTorBoxFileIdentityFn,
      });
      const decision = cache.listSelectionDecisions({ limit: 1 })[0] ?? null;
      record = {
        label,
        mediaId: fixture.mediaId,
        mediaType: fixture.mediaType || 'movie',
        season: fixture.season ?? null,
        episode: fixture.episode ?? null,
        ms: Date.now() - startedAt,
        total: outcome.total ?? 0,
        requestId: outcome.requestId ?? null,
        selection: {
          reason: outcome.selection?.reason ?? null,
          selected: outcome.selection?.selected
            ? {
              infoHash: outcome.selection.selected.infoHash,
              fileIndex: outcome.selection.selected.fileIndex ?? null,
              rank: outcome.selection.selected.rank ?? null,
              filename: outcome.selection.selected.filename ?? null,
              score: outcome.selection.selected.score ?? null,
              identityTier: outcome.selection.selected.identityTier ?? null,
              selectedFileSize: outcome.selection.selected.selectedFileSize ?? null,
            }
            : null,
          serviceability: outcome.selection?.serviceability ?? null,
          skipped: outcome.selection?.skipped ?? [],
        },
        decision,
      };
    } catch (error) {
      record = { label, mediaId: fixture.mediaId, error: String(error?.message ?? error) };
    }
    results.push(record);
    const sel = record.selection;
    console.error(
      `[cohort] ${label} total=${record.total ?? '-'} `
      + `selected=${sel?.selected?.rank ?? 'none'}/${sel?.selected?.infoHash?.slice(0, 8) ?? '-'} `
      + `reason=${sel?.reason ?? '-'} skipped=${sel?.skipped?.length ?? 0} ${record.ms ?? 0}ms`
      + (record.error ? ` ERROR=${record.error}` : ''),
    );
  }

  if (asJson) {
    // The report goes to a FILE, not stdout: the pipeline logs to stdout
    // too, and a mixed stream is not machine-readable.
    const outPath = process.env.PROOF_TAX_OUT || null;
    const json = JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2);
    if (outPath) {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(outPath, json);
      console.error(`[cohort] wrote ${results.length} results to ${outPath}`);
    } else {
      console.log(json);
    }
  }
  cache.close();
  controlPlaneStore.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

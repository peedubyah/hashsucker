#!/usr/bin/env node
/**
 * PROOF-TAX PROBE — drive the REAL selection over the real ranked
 * candidates of a media item, with the real provider seam, and record the
 * decision plus WHY each candidate above the winner was passed over.
 *
 * WHY this exists: the request path's selection is a traversal whose
 * outcome depends on the provider's inventory for each candidate. To
 * measure the "exactness tax" — what quality the user loses when the
 * top-ranked candidate cannot be proven exact and a lower-ranked one is
 * chosen instead — the decision must be observed where it happens, with
 * the provider's real answer.
 *
 * This probe calls the SAME production function the request path calls
 * (selectBindableCandidate) with the SAME production seam
 * (ensureTorBoxFileIdentity), over the SAME ranked rows the request path
 * produced. It changes nothing: it does not publish, does not bind, and
 * writes only to the scratch discovery DB.
 *
 * Usage:
 *   DISCOVERY_DB=... CONTROL_PLANE_DB=... TORBOX_API_KEY=... \
 *   node src/scripts/proof-tax-probe.mjs <mediaId>[:season:episode] ...
 */

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createTorBoxInventoryProvider } from '../lib/providers/torbox-inventory.js';
import { createTorBoxProvider } from '../lib/providers/torbox.js';
import { ensureTorBoxFileIdentity } from '../lib/resolver/torbox-file-identity.js';
import { selectBindableCandidate } from '../lib/discovery/selection.js';
import { buildRequestContext } from '../api/media-request-stages.js';
import { collectTitleIndexInputs, shapeRankedResults, buildCorpusRankingInput, applyTorboxAvailability, runLiveDiscoveryStage } from '../api/media-request-stages.js';
import { rankHitsTiered } from '../lib/discovery/ranking.js';

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';
const CP_PATH = process.env.CONTROL_PLANE_DB || ':memory:';

function loadEnv() {
  for (const file of ['.env', '../../.env']) {
    try { process.loadEnvFile(file); } catch { /* optional */ }
  }
}

/** Rebuild the ranked rows the request path would build for this media. */
async function rankedRowsFor(cache, ctx, { live = false } = {}) {
  const titleIndex = await collectTitleIndexInputs(ctx);
  const candidates = cache.queryCandidatesByMedia(ctx.mediaId);
  const metadataByHash = new Map();
  const liveMetadataByHash = new Map();
  const eligibilityByHash = new Map();
  const inputs = live ? [] : candidates.map((candidate) => buildCorpusRankingInput({
    cache, candidate, ctx, eligibilityByHash, metadataByHash, wantedIdentity: titleIndex?.wanted ?? null,
  }));
  if (!live) {
    for (const t of titleIndex.inputs) {
      const haveKeys = new Set(inputs.map((i) => i?.releaseKey));
      if (haveKeys.has(t.releaseKey)) continue;
      inputs.push(t);
    }
  }

  // The live arm: the LIVE-ADDON candidates, ranked exactly as the request
  // path ranks them. These carry the upstream's own per-file facts
  // (behaviorHints.videoSize), which is the arm where an exact identity CAN
  // be proven — and therefore the arm where the tax is measurable.
  //
  // The candidates are taken VERBATIM from the production discovery stage
  // (runLiveDiscoveryStage), so the shape is the production shape.
  if (live) {
    const discovery = await runLiveDiscoveryStage(ctx, { wantedIdentity: titleIndex?.wanted });
    for (const liveCandidate of discovery.liveCandidates) {
      const key = liveCandidate.releaseKey;
      if (eligibilityByHash.has(key)) continue;
      liveMetadataByHash.set(key, { ...discovery.liveMetadataByHash.get(key), live: true });
      eligibilityByHash.set(key, discovery.liveEligibilityByHash.get(key));
      inputs.push(liveCandidate);
    }
  }

  const { ranked } = rankHitsTiered(inputs, {
    season: ctx.season,
    episode: ctx.episode,
    mediaTitle: titleIndex?.wanted?.title ?? ctx.mediaTitle,
    year: titleIndex?.wanted?.year ?? ctx.canonicalYear ?? null,
  }, ctx.mediaId, eligibilityByHash);
  const explainable = shapeRankedResults({
    ranked, ctx, metadataByHash, eligibilityByHash, liveMetadataByHash,
    wantedIdentity: titleIndex?.wanted ?? null,
  });
  return { explainable, titleIndex };
}

async function main() {
  loadEnv();
  const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  if (targets.length === 0) {
    console.error('Usage: proof-tax-probe.mjs <mediaId>[:season:episode] ...');
    process.exit(1);
  }

  const cache = createDiscoveryCache({ dbPath: DB_PATH });
  const controlPlaneStore = createControlPlaneStore({ dbPath: CP_PATH });
  const torBoxInventoryProvider = process.env.TORBOX_API_KEY
    ? createTorBoxInventoryProvider({ apiKey: process.env.TORBOX_API_KEY })
    : null;
  const torBoxProvider = process.env.TORBOX_API_KEY
    ? createTorBoxProvider({ apiKey: process.env.TORBOX_API_KEY })
    : null;
  // The seam must match the PRODUCTION seam exactly (app.js): it injects
  // the control plane, the providers, and the clock itself, and forwards
  // every parameter the selection passes. A seam that drops the control
  // plane makes every binding fail closed with INVALID_INPUT, which would
  // measure the harness, not the product.
  const ensureTorBoxFileIdentityFn = async (params) => ensureTorBoxFileIdentity({
    ...params,
    controlPlaneStore,
    torBoxInventoryProvider,
    torBoxProvider,
  }).catch((e) => {
    if (process.env.PROOF_TAX_TRACE && e?.code === 'INVALID_INPUT') {
      console.error(`[probe-trace] INVALID_INPUT hash=${JSON.stringify(params.infoHash)} size=${JSON.stringify(params.selectedFileSize)} skip=${params.skipSizeMatch} msg=${e.message}`);
    }
    throw e;
  });

  const out = [];
  // A target may be prefixed with 'live:' to probe the LIVE-ADDON arm
  // (the upstream's own candidates, carrying its per-file videoSize) and
  // with 'corpus:' for the corpus arm. Default: both arms.
  for (const target of targets) {
    const arm = target.startsWith('live:') ? 'live' : target.startsWith('corpus:') ? 'corpus' : 'both';
    const bare = target.replace(/^(live|corpus):/, '');
    const [mediaId, seasonStr, episodeStr] = bare.split(':');
    const season = seasonStr != null ? parseInt(seasonStr, 10) : null;
    const episode = episodeStr != null ? parseInt(episodeStr, 10) : null;
    const mediaType = season != null && episode != null ? 'series' : 'movie';

    const ctx = buildRequestContext(cache, {
      mediaId, mediaType, season, episode, persist: false,
    });
    const { explainable } = await rankedRowsFor(cache, ctx, { live: arm !== 'corpus' });
    await applyTorboxAvailability({ explainable, cache });

    const selection = await selectBindableCandidate(explainable, {
      ensureTorBoxFileIdentityFn,
      resolveTvTorrentFileFn: (await import('../lib/resolver/tv-episode-resolver.js')).resolveTvTorrentFile,
      tvCoordinates: season != null && episode != null ? { season, episode } : null,
      controlPlaneStore,
      maxTier: null,
    });

    const byRank = new Map(explainable.map((r) => [r.rank, r]));
    const record = {
      target: bare,
      arm,
      mediaId,
      mediaType,
      season,
      episode,
      candidateCount: explainable.length,
      selected: selection.selected
        ? {
          rank: selection.selected.rank,
          infoHash: selection.selected.infoHash,
          fileIndex: selection.selected.fileIndex,
          filename: selection.selected.filename,
          score: selection.selected.score,
          identityTier: selection.selected.identityTier,
          selectedFileSize: selection.selected.selectedFileSize,
          release: selection.selected.release ?? null,
          torboxState: selection.selected.torboxState,
        }
        : null,
      reason: selection.reason,
      skipped: (selection.skipped || []).map((s) => {
        const row = byRank.get(s.rank);
        return {
          rank: s.rank,
          infoHash: s.infoHash,
          reason: s.reason,
          torboxState: s.torboxState,
          score: row?.score ?? null,
          identityTier: row?.identity?.tier ?? null,
          selectedFileSize: row?.selectedFileSize ?? null,
          release: row?.release ?? null,
          torboxStateRow: row?.availability?.torbox?.state ?? null,
        };
      }),
    };
    out.push(record);
    console.error(
      `[probe] ${target} total=${record.candidateCount} selected=${record.selected?.rank ?? 'none'}/${record.selected?.infoHash?.slice(0, 8) ?? '-'} `
      + `reason=${record.reason} skipped=${record.skipped.length}`,
    );
  }

  const { writeFileSync } = await import('node:fs');
  const outPath = process.env.PROOF_TAX_OUT || null;
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), results: out }, null, 2);
  if (outPath) {
    writeFileSync(outPath, json);
    console.error(`[probe] wrote ${out.length} probes to ${outPath}`);
  } else {
    console.log(json);
  }
  cache.close();
  controlPlaneStore.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

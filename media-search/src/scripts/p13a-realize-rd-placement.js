#!/usr/bin/env node
/**
 * P13A: Realize one Real-Debrid ProviderPlacement + ProviderFile mapping for
 * an existing durable TorrentFile.
 *
 * Scope (P13A brief):
 *   - One real RD torrent the user has in their RD account.
 *   - One exact existing TorrentFile in the control plane.
 *   - Use the existing production control-plane store methods
 *     (recordPlacement + replaceProviderFileInventory). No SQL seeds, no
 *     second ingestion model.
 *   - Do not touch Rust, do not persist DeliveryCapability, do not create
 *     a delivery URL.
 *   - Sibling-file correctness: only the file that has an existing
 *     torrent_files row (by (info_hash, internal_path, size)) is mapped.
 *     Sibling RD files with no torrent_file are left un-materialized
 *     (inventory reported as `complete: false`).
 *
 * Usage:
 *   docker exec -e REALDEBRID_API_KEY hashsucker-media-search-1 \
 *     node src/scripts/p13a-realize-rd-placement.js \
 *       --info-hash 06bfe49fdc99ad0c6fef1f761382a8181490e456 \
 *       --rd-torrent-id 5VFSK7HKPITZW \
 *       --tf-id tf_5de34a78-0a1a-410b-8de5-76ded2680e7d
 *
 * Required env (already set in the container):
 *   CONTROL_PLANE_DB=/data/control-plane.db
 *   REALDEBRID_API_KEY
 */

import { createRealDebridClient } from '../lib/providers/realdebrid/client.js';
import { createControlPlaneStore } from '../lib/control-plane/store.js';

const DB_PATH = process.env.CONTROL_PLANE_DB || ':memory:';

function parseArgs(argv) {
  const out = { infoHash: null, rdTorrentId: null, tfId: null, accountScope: 'default' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--info-hash') out.infoHash = argv[++i];
    else if (a === '--rd-torrent-id') out.rdTorrentId = argv[++i];
    else if (a === '--tf-id') out.tfId = argv[++i];
    else if (a === '--account-scope') out.accountScope = argv[++i];
  }
  return out;
}

function assertHex40(s, field) {
  if (!/^[0-9a-f]{40}$/i.test(s)) {
    throw new TypeError(`${field} must be 40 lowercase hex chars; got ${s}`);
  }
  return s.toLowerCase();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.infoHash || !args.rdTorrentId || !args.tfId) {
    console.error('Usage: p13a-realize-rd-placement.js --info-hash <40hex> --rd-torrent-id <id> --tf-id <tfId> [--account-scope default]');
    process.exit(2);
  }
  const infoHash = assertHex40(args.infoHash, '--info-hash');
  const rdTorrentId = String(args.rdTorrentId);
  const tfId = String(args.tfId);

  console.log(`[p13a] CONTROL_PLANE_DB=${DB_PATH}`);
  console.log(`[p13a] infoHash=${infoHash}  rdTorrentId=${rdTorrentId}  tfId=${tfId}  accountScope=${args.accountScope}`);

  const controlPlaneStore = createControlPlaneStore({ dbPath: DB_PATH });

  // 1) Verify the existing TorrentFile exists, matches the info_hash, and
  //    has a positive size. This is the durable identity we map onto.
  const existingTf = controlPlaneStore.getTorrentFile(tfId);
  if (!existingTf) {
    console.error(`[p13a] FATAL: torrent_file ${tfId} not found in control plane`);
    process.exit(1);
  }
  if (existingTf.infoHash !== infoHash) {
    console.error(`[p13a] FATAL: torrent_file ${tfId} has infoHash=${existingTf.infoHash}, expected ${infoHash}`);
    process.exit(1);
  }
  if (!Number.isSafeInteger(existingTf.size) || existingTf.size <= 0) {
    console.error(`[p13a] FATAL: torrent_file ${tfId} has invalid size ${existingTf.size}`);
    process.exit(1);
  }
  console.log(`[p13a] existing TorrentFile: path=${existingTf.internalPath}  size=${existingTf.size}`);

  // 2) Real RD inventory: exactly one API call (GET /torrents/info/{id}).
  //    Reuses the existing RD client (no second client, no listTorrents call).
  if (!process.env.REALDEBRID_API_KEY) {
    console.error('[p13a] FATAL: REALDEBRID_API_KEY env required');
    process.exit(1);
  }
  const rdClient = createRealDebridClient({ apiKey: process.env.REALDEBRID_API_KEY });
  let rdInfo;
  try {
    rdInfo = await rdClient.getTorrentInfo(rdTorrentId);
  } catch (err) {
    console.error(`[p13a] FATAL: RD torrents/info failed: ${err.message}`);
    process.exit(1);
  }
  if (!rdInfo || !Array.isArray(rdInfo.files)) {
    console.error('[p13a] FATAL: RD info missing files[]');
    process.exit(1);
  }
  if (String(rdInfo.hash).toLowerCase() !== infoHash) {
    console.error(`[p13a] FATAL: RD info hash=${rdInfo.hash} does not match --info-hash ${infoHash}`);
    process.exit(1);
  }
  if (rdInfo.status !== 'downloaded') {
    console.error(`[p13a] FATAL: RD status=${rdInfo.status}, expected downloaded. selectFiles was not run?`);
    process.exit(1);
  }
  console.log(`[p13a] RD status=${rdInfo.status}  files=${rdInfo.files.length}  bytes_total=${rdInfo.bytes}`);

  // 3) Sibling-file correctness: find the RD file whose (path, bytes) match
  //    the existing torrent_file (canonicalized). No positional matching,
  //    no fileIndex heuristic, no filename-only guess. The path and the
  //    positive size must BOTH match.
  //
  //    RD reports files with a leading "/" and typically just the basename
  //    under the torrent root, while torbox reports the full torrent-relative
  //    path including any directory. The full canonical path for an RD file
  //    is constructed from RD's OWN metadata:
  //      rdInfo.original_filename  (torrent root, before selectFiles changed filename)
  //      + '/' + canonical(rdFile.path)
  //    After selectFiles, RD's `filename` field reflects the selected file's
  //    basename; the torrent root lives in `original_filename`. This is RD's
  //    own representation of the file's location, not a guess. The exact
  //    positive size is the second binding constraint.
  const canonical = (p) => (p.startsWith('/') ? p.slice(1) : (p.startsWith('./') ? p.slice(2) : p));
  const expectedPath = canonical(existingTf.internalPath);
  const expectedSize = existingTf.size;
  const rdRoot = canonical(String(rdInfo.original_filename || rdInfo.filename || ''));
  const matchingRdFile = rdInfo.files.find((f) => {
    const fp = canonical(String(f.path || ''));
    const fullPath = rdRoot ? `${rdRoot}/${fp}` : fp;
    return fullPath === expectedPath && Number(f.bytes) === expectedSize;
  });
  if (!matchingRdFile) {
    console.error(`[p13a] FATAL: no RD file matches (path=${expectedPath}, size=${expectedSize})`);
    console.error(`[p13a] RD root from original_filename: ${rdRoot ? `'${rdRoot}'` : '(none)'}`);
    console.error('[p13a] RD files:');
    for (const f of rdInfo.files) {
      const fp = canonical(String(f.path || ''));
      const full = rdRoot ? `${rdRoot}/${fp}` : fp;
      console.error(`    id=${f.id}  fullPath=${full}  bytes=${f.bytes}  selected=${f.selected}`);
    }
    process.exit(1);
  }
  console.log(`[p13a] matched RD file: id=${matchingRdFile.id}  path=${rdRoot}/${canonical(String(matchingRdFile.path))}  bytes=${matchingRdFile.bytes}`);

  // 4) Sibling report: how many RD files we deliberately did NOT materialize.
  //    These are the file-inventory siblings that have no existing torrent_file.
  const siblingCount = rdInfo.files.length - 1;
  console.log(`[p13a] sibling RD files NOT materialized: ${siblingCount} (intentional, narrow path)`);

  // 5) Materialize via the existing production store methods. This is the
  //    same call shape the torbox inventory path uses; we are NOT seeding
  //    rows and NOT manufacturing mappings.
  const observedAt = Date.now();
  const expiresAt = observedAt + 5 * 60 * 1000;

  const placement = controlPlaneStore.recordPlacement({
    provider: 'realdebrid',
    accountScope: args.accountScope,
    infoHash,
    providerResourceId: rdTorrentId,
    state: 'ready',
    ownership: 'owned',
    ownerKey: `p13a-${observedAt}`,
    provenance: 'p13a-realize-rd-placement',
    observedAt,
    expiresAt,
  });
  console.log(`[p13a] recordPlacement -> ${placement.id}  state=${placement.state}  ownership=${placement.ownership}`);

  // Pass only the file that has a durable identity. complete=false because
  // the inventory report is intentionally partial (siblings are not in the
  // control plane and are NOT being created here). The store's demote-absent
  // logic will correctly leave no stale rows for this fresh placement.
  //
  // The provider_file.path is the torrent-relative path (full canonical),
  // matching the shape torbox inventory records. This is what
  // replaceProviderFileInventory uses to dedup to the existing torrent_file.
  const matchedFilePath = `${rdRoot}/${canonical(String(matchingRdFile.path))}`;
  const files = [{
    providerFileId: String(matchingRdFile.id),
    path: matchedFilePath,
    name: matchedFilePath.split('/').pop(),
    size: Number(matchingRdFile.bytes),
    selected: matchingRdFile.selected === 1,
    corpusFileIndex: Number(matchingRdFile.id),
    evidence: {
      source: 'p13a-realize-rd-placement',
      rdTorrentId,
      rdOriginalBytes: rdInfo.original_bytes,
      rdBytes: rdInfo.bytes,
    },
  }];
  const inventory = controlPlaneStore.replaceProviderFileInventory(placement.id, files, {
    authoritative: true,
    complete: false, // siblings intentionally not materialized
    expiresAt,
    evidence: {
      source: 'p13a-realize-rd-placement',
      rdTorrentId,
      siblingCount,
    },
  });
  console.log(`[p13a] replaceProviderFileInventory -> ${inventory.length} provider_file row(s)`);
  for (const pf of inventory) {
    console.log(`    pfId=${pf.providerFileId}  torrentFileId=${pf.torrentFileId}  mappingState=${pf.mappingState}  path=${pf.path}`);
  }

  // 6) Verify the materialized control-plane state: same query the S-1
  //    /api/data-plane/files/:tfId endpoint runs.
  const coords = controlPlaneStore.listDataPlaneCoordinates(tfId);
  console.log(`[p13a] listDataPlaneCoordinates(${tfId}) -> ${coords.length} coordinate(s):`);
  for (const c of coords) {
    console.log(`    provider=${c.provider}  account=${c.account_scope}  resid=${c.provider_resource_id}  pfId=${c.provider_file_id}  size=${c.size}  path=${c.provider_path}`);
  }
  if (!coords.some((c) => c.provider === 'realdebrid' && c.provider_file_id === String(matchingRdFile.id))) {
    console.error('[p13a] FATAL: S-1 projection does NOT include the new RD coordinate');
    process.exit(1);
  }
  console.log(`[p13a] OK: S-1 projection now includes RD coordinate for ${tfId}`);
}

main().catch((e) => {
  console.error('[p13a] unhandled:', e?.stack || e);
  process.exit(1);
});

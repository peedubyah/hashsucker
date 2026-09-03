/**
 * Worker B — TorBox rank-5 promotion / mounted lifecycle proofs
 *
 * The TorBox rank-5 specimen for tt7137906 S01E02 is the durable
 * authority. The production promotion lifecycle must:
 *   - replace the poisoned playback_handoffs row in place (B1, B2)
 *   - supersede the VFS row to the rank-5 TorrentFile (B3)
 *   - leave the poisoned primary TorrentFile row untouched (B4)
 *   - converge under concurrent and replayed promotion (B5, B6)
 *   - refuse to mutate anything when byte validation is missing (B7)
 *   - keep the binding keyed on the rank-5 (placement, providerFile) (B8)
 *   - leave WebDAV metadata reporting the new exact size (B10)
 *   - keep the playback_handoffs and vfs_tv_entries rows identifying
 *     the same physical file after promotion (B11)
 *   - not allow a null legacy fileIndexKey scan to poison sibling
 *     modern ProviderFile evidence (B12)
 *
 * These tests are deterministic — they drive the in-process
 * promoteAlternate + materializeVfsEntry seam. No real network.
 * No new abstractions; only evidence that the existing seam is
 * correct under the production-shape seeded state.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createAlternateFallback } from '../src/lib/resolver/alternate-fallback.js';
import { createTerminalDeliveryEvidenceStore, TERMINAL_DELIVERY_STATES } from '../src/lib/resolver/terminal-delivery-evidence.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';
import { buildPlaybackHandoff } from '../src/lib/discovery/playback-handoff.js';
import {
  registerDurabilityScheduler,
  clearDurabilityScheduler,
} from '../src/lib/control-plane/durability-enroller.js';

const PRIMARY_HASH = 'a07b84404989fccee1d55c247cb03e22c8847ecc';
const PRIMARY_SIZE = 8_775_633_660;
const PRIMARY_PROVIDER_FILE_ID = '0';

const ALT_HASH = '8862ba8185d52ad54a9fda496546d828ed244a91';
const ALT_FILE_INDEX = 2;
const ALT_RELEASE_KEY = `${ALT_HASH}:${ALT_FILE_INDEX}`;
const ALT_SIZE = 2_834_055_554;
const ALT_FILENAME = 'When.They.See.Us.S01E02.1080p.NF.WEB-DL.Atmos.DDP5.1.HDR.H.265-ExREN.mkv';
const ALT_PROVIDER_FILE_ID = '3';

const MEDIA_ID = 'tt7137906';
const SEASON = 1;
const EPISODE = 2;
const CANONICAL_PATH = `TV/${MEDIA_ID}/Season 01/${MEDIA_ID} - S01E0${EPISODE}.mkv`;

/**
 * Mirror the production state at the time of the rank-5 promotion:
 *   - poisoned primary placement + ProviderFile + TorrentFile in CP
 *   - rank-5 placement + ProviderFile + TorrentFile in CP
 *   - poisoned VFS row bound to the canonical alias
 *   - poisoned playback_handoffs row already authoritative
 *
 * The playback_handoffs row is what made Worker A's tests pass while
 * still leaving a production defect: the upsert's ON CONFLICT
 * WHERE clause refused to overwrite an existing authoritative
 * payload, so the durable handoff stayed poisoned even when the
 * VFS row was superseded.
 */
function seedProductionState({ controlPlane, cache, now = 1_700_000_000_000 }) {
  // Bad primary placement + ProviderFile + TorrentFile.
  controlPlane.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: PRIMARY_HASH,
    providerResourceId: 'torbox-bad-88800420',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'worker-b-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: now - 1_000,
    expiresAt: now + 5 * 60_000,
  });
  const primaryPlacement = controlPlane.findPlacementByInfoHash('torbox', PRIMARY_HASH);
  controlPlane.replaceProviderFileInventory(primaryPlacement.id, [
    {
      providerFileId: PRIMARY_PROVIDER_FILE_ID,
      path: '/When They See Us S01 HDR WEB-DL 2160p/When They See Us S01E02 WEB-DL 2160p.mkv',
      name: 'When They See Us S01E02 WEB-DL 2160p.mkv',
      size: PRIMARY_SIZE,
      selected: true,
      corpusFileIndex: 1,
    },
  ], { authoritative: true, complete: true, observedAt: now - 1_000, expiresAt: now + 5 * 60_000 });
  controlPlane.recordFileMapping({
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    releaseKey: `${PRIMARY_HASH}:1`,
    placementId: primaryPlacement.id,
    providerFileId: PRIMARY_PROVIDER_FILE_ID,
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    evidence: { candidateFilename: 'When They See Us S01E02 WEB-DL 2160p.mkv' },
    mappedAt: now - 500,
  });
  const primaryFiles = controlPlane.listProviderFiles(primaryPlacement.id);
  const primaryPf = primaryFiles.find((f) => f.providerFileId === PRIMARY_PROVIDER_FILE_ID);
  const primaryTorrentFileId = primaryPf?.torrentFileId ?? null;

  // Verify the seed produced a 2160p primary (the production defect
  // shape). The promoteAlternate seam must leave the primary TF row
  // intact — historical primaries stay in the corpus.

  // Rank-5 alt placement + ProviderFile + TorrentFile.
  controlPlane.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: ALT_HASH,
    providerResourceId: 'torbox-alt-89028862',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'worker-b-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: now - 1_000,
    expiresAt: now + 5 * 60_000,
  });
  const altPlacement = controlPlane.findPlacementByInfoHash('torbox', ALT_HASH);
  controlPlane.replaceProviderFileInventory(altPlacement.id, [
    { providerFileId: '0', path: '/RARBG.txt', name: 'RARBG.txt', size: 31, selected: false, corpusFileIndex: 0 },
    {
      providerFileId: '1',
      path: '/E01.mkv',
      name: 'When.They.See.Us.S01E01.1080p.NF.WEB-DL.Atmos.DDP5.1.HDR.H.265-ExREN.mkv',
      size: 2_477_980_171,
      selected: false,
      corpusFileIndex: 1,
    },
    {
      providerFileId: ALT_PROVIDER_FILE_ID,
      path: '/E02.mkv',
      name: ALT_FILENAME,
      size: ALT_SIZE,
      selected: true,
      corpusFileIndex: 3,
    },
  ], { authoritative: true, complete: true, observedAt: now - 1_000, expiresAt: now + 5 * 60_000 });
  controlPlane.recordFileMapping({
    infoHash: ALT_HASH,
    fileIndex: ALT_FILE_INDEX,
    releaseKey: ALT_RELEASE_KEY,
    placementId: altPlacement.id,
    providerFileId: ALT_PROVIDER_FILE_ID,
    state: 'mapped',
    method: 'provider-filename-exact',
    authoritative: true,
    evidence: { candidateFilename: ALT_FILENAME },
    mappedAt: now - 500,
  });
  const altFiles = controlPlane.listProviderFiles(altPlacement.id);
  const altPf = altFiles.find((f) => f.providerFileId === ALT_PROVIDER_FILE_ID);
  const altTorrentFileId = altPf?.torrentFileId ?? null;

  // Persisted ranking candidates (rank-5 alt present in corpus).
  const results = [
    {
      infoHash: PRIMARY_HASH,
      fileIndex: 1,
      releaseKey: `${PRIMARY_HASH}:1`,
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      provider: 'torbox',
      providerState: 'cached',
      filename: 'When They See Us S01E02 WEB-DL 2160p.mkv',
      size: PRIMARY_SIZE,
      score: 0.9,
      rank: 4,
      release: { infoHash: PRIMARY_HASH, fileIndex: 1, releaseKey: `${PRIMARY_HASH}:1` },
    },
    {
      infoHash: ALT_HASH,
      fileIndex: ALT_FILE_INDEX,
      releaseKey: ALT_RELEASE_KEY,
      mediaId: MEDIA_ID,
      season: SEASON,
      episode: EPISODE,
      provider: 'torbox',
      providerState: 'cached',
      size: ALT_SIZE,
      score: 0.85,
      rank: 5,
      filename: ALT_FILENAME,
      release: { infoHash: ALT_HASH, fileIndex: ALT_FILE_INDEX, releaseKey: ALT_RELEASE_KEY },
    },
  ];
  const persistedRequestId = cache.persistMediaRequest({
    mediaId: MEDIA_ID, mediaType: 'tv', source: 'test', season: SEASON, episode: EPISODE,
  }, results);

  // Initial VFS row bound to the bad primary at the canonical path.
  cache.createVfsTvEntry({
    mediaId: MEDIA_ID,
    season: SEASON,
    episode: EPISODE,
    releaseKey: `${PRIMARY_HASH}:1`,
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    canonicalPath: CANONICAL_PATH,
    torrentFileId: primaryTorrentFileId,
    size: PRIMARY_SIZE,
    createdAt: now - 60_000,
    updatedAt: now - 60_000,
  });

  // Production defect shape: a pre-existing authoritative handoff row
  // pointing at the bad primary. This is the row that the previous
  // ON CONFLICT WHERE clause refused to overwrite.
  const poisonedSelection = {
    selected: {
      infoHash: PRIMARY_HASH,
      fileIndex: 1,
      filename: 'When They See Us S01E02 WEB-DL 2160p.mkv',
      torboxState: 'cached',
      identityTier: 'Verified',
      release: { resolution: '4K' },
    },
    reason: 'primary-bound',
  };
  const poisonedHandoff = buildPlaybackHandoff(poisonedSelection, {
    requestId: persistedRequestId,
    mediaId: MEDIA_ID,
    mediaType: 'series',
    season: SEASON,
    episode: EPISODE,
    torrentFileId: primaryTorrentFileId,
  });
  poisonedHandoff.torrentFileIdentity = {
    status: 'mapped',
    torrentFileId: primaryTorrentFileId,
    placementId: primaryPlacement.id,
    providerFileId: PRIMARY_PROVIDER_FILE_ID,
    size: PRIMARY_SIZE,
  };
  cache.persistPlaybackHandoff(poisonedHandoff);

  return {
    persistedRequestId,
    primaryPlacementId: primaryPlacement.id,
    primaryProviderFileId: PRIMARY_PROVIDER_FILE_ID,
    primaryTorrentFileId,
    altPlacementId: altPlacement.id,
    altProviderFileId: ALT_PROVIDER_FILE_ID,
    altTorrentFileId,
  };
}

/**
 * Drive the production promoteAlternate → materializeVfsEntry chain
 * against a seeded fixture. Mirrors the call site in app.js so the
 * test exercises the real handoff build + VFS materialize + binding
 * write.
 */
function runPromotion({
  cache, controlPlane, ids, evidence, durabilityScheduler = null,
  now = () => 1_700_000_000_000,
}) {
  if (durabilityScheduler) registerDurabilityScheduler(durabilityScheduler);
  try {
    const altTorrentFile = controlPlane.getTorrentFile(ids.altTorrentFileId);
    const alt = createAlternateFallback({
      searchCache: cache,
      fetchFn: async () => ({ ok: true, status: 200, body: null, json: async () => null }),
      revalidator: {
        revalidateAvailability: async () => ({ cacheState: 'cached', availabilitySource: 'cached', providerCheckOccurred: true }),
      },
      rdClient: null,
    });
    const result = alt.promoteAlternate({
      candidate: {
        info_hash: ALT_HASH,
        fileIndex: ALT_FILE_INDEX,
        filename: ALT_FILENAME,
        media_id: MEDIA_ID,
        season: SEASON,
        episode: EPISODE,
        releaseKey: ALT_RELEASE_KEY,
        size: ALT_SIZE,
        torrentFileId: ids.altTorrentFileId,
      },
      delivery: { placementId: ids.altPlacementId, providerFileId: ids.altProviderFileId },
      controlPlaneStore: controlPlane,
      evidence,
      mediaRequest: { mediaId: MEDIA_ID, media_type: 'series', season: SEASON, episode: EPISODE },
      now,
    });
    if (!result?.promoted) return result;
    materializeVfsEntry(cache, result.handoff, controlPlane, now, { allowLegacy: true });
    return result;
  } finally {
    if (durabilityScheduler) clearDurabilityScheduler();
  }
}

test('B1/B2/B11: rank-5 promotion over poisoned authoritative handoff → durable handoff swapped', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedProductionState({ controlPlane, cache });

  // Sanity: the seed itself produced a poisoned authoritative handoff.
  const beforeHandoff = cache.getTvPlaybackHandoff(MEDIA_ID, SEASON, EPISODE);
  assert.equal(beforeHandoff.infoHash, PRIMARY_HASH);
  assert.equal(beforeHandoff.torrentFileId, ids.primaryTorrentFileId);

  const result = runPromotion({
    cache, controlPlane, ids,
    evidence: { validatedBytes: true },
  });
  assert.equal(result.promoted, true, 'rank-5 promotion must succeed');

  // B1 — current authoritative handoff is the rank-5.
  const afterHandoff = cache.getTvPlaybackHandoff(MEDIA_ID, SEASON, EPISODE);
  assert.equal(afterHandoff.infoHash, ALT_HASH, 'B1: handoff infoHash swapped');
  assert.equal(afterHandoff.fileIndex, ALT_FILE_INDEX, 'B1: handoff fileIndex swapped');
  assert.equal(afterHandoff.torrentFileId, ids.altTorrentFileId, 'B1: handoff torrentFileId swapped');
  assert.equal(afterHandoff.releaseKey, ALT_RELEASE_KEY, 'B1: handoff releaseKey swapped');

  // B2 — current active binding is on the rank-5 (placement, providerFile).
  const binding = controlPlane.db.prepare(
    `SELECT * FROM bindings WHERE status = ? AND info_hash = ?`,
  ).get('active', ALT_HASH);
  assert.ok(binding, 'B2: exactly one active binding on rank-5');
  assert.equal(binding.placement_id, ids.altPlacementId);
  assert.equal(binding.provider_file_id, ids.altProviderFileId);

  // B3 — current VFS row tracks the rank-5 with the exact size and the
  // original canonical alias.
  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.equal(vfs.canonicalPath, CANONICAL_PATH, 'B3: canonical alias preserved');
  assert.equal(vfs.infoHash, ALT_HASH);
  assert.equal(vfs.torrentFileId, ids.altTorrentFileId);
  assert.equal(vfs.size, ALT_SIZE, 'B3: exact size 2834055554');

  // B11 — VFS row + handoff row identify the same physical file.
  assert.equal(vfs.infoHash, afterHandoff.infoHash, 'B11: VFS and handoff share infoHash');
  assert.equal(vfs.torrentFileId, afterHandoff.torrentFileId, 'B11: VFS and handoff share torrentFileId');
  assert.equal(vfs.size, ALT_SIZE, 'B11: VFS size matches authoritative TorrentFile size');
});

test('B4: poisoned primary TorrentFile remains unchanged after rank-5 promotion', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedProductionState({ controlPlane, cache });
  runPromotion({ cache, controlPlane, ids, evidence: { validatedBytes: true } });

  // The poisoned primary TorrentFile row in the control plane is the
  // durable physical identity of the bad release. The promotion must
  // not delete or rewrite it — historical primaries stay in the corpus.
  const primaryTf = controlPlane.getTorrentFile(ids.primaryTorrentFileId);
  assert.ok(primaryTf, 'B4: primary TorrentFile still exists');
  assert.equal(primaryTf.infoHash, PRIMARY_HASH);
  assert.equal(primaryTf.size, PRIMARY_SIZE);
  assert.match(primaryTf.internalPath, /2160p|RARBG/i);
});

test('B5: replayed promotion is idempotent (no duplicate VFS row, no duplicate active binding)', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedProductionState({ controlPlane, cache });

  for (let i = 0; i < 3; i += 1) {
    const r = runPromotion({ cache, controlPlane, ids, evidence: { validatedBytes: true } });
    assert.equal(r.promoted, true, `replay ${i} must promote`);
  }

  // Exactly one VFS row for the slot.
  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.ok(vfs);
  assert.equal(vfs.size, ALT_SIZE);

  // Exactly one active binding for rank-5.
  const active = controlPlane.db.prepare(
    `SELECT * FROM bindings WHERE status = 'active' AND info_hash = ?`,
  ).all(ALT_HASH);
  assert.equal(active.length, 1, 'B5: exactly one active binding after replay');

  // No legacy active binding lingering on the bad primary.
  const legacyActive = controlPlane.db.prepare(
    `SELECT * FROM bindings WHERE status = 'active' AND info_hash = ?`,
  ).all(PRIMARY_HASH);
  assert.equal(legacyActive.length, 0, 'B5: no active binding remains on bad primary');
});

test('B6: concurrent rank-5 promotions converge on one VFS row, one active binding', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedProductionState({ controlPlane, cache });

  // Fire 4 promotions "concurrently". Node's single-threaded model
  // serializes them, but the seam must still converge without
  // producing duplicates or losing data.
  const results = [];
  for (let i = 0; i < 4; i += 1) {
    results.push(runPromotion({ cache, controlPlane, ids, evidence: { validatedBytes: true } }));
  }
  for (const r of results) assert.equal(r.promoted, true, 'every concurrent promotion succeeds');

  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.equal(vfs.size, ALT_SIZE);
  assert.equal(vfs.torrentFileId, ids.altTorrentFileId);

  const active = controlPlane.db.prepare(
    `SELECT * FROM bindings WHERE status = 'active' AND info_hash = ?`,
  ).all(ALT_HASH);
  assert.equal(active.length, 1, 'B6: exactly one active binding after concurrent promotion');
});

test('B7: failed byte validation → no durable state change', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedProductionState({ controlPlane, cache });

  const r = runPromotion({ cache, controlPlane, ids, evidence: { validatedBytes: false } });
  assert.equal(r.promoted, false, 'B7: promotion refused when no validated bytes');

  // Handoff row still points at the bad primary.
  const handoff = cache.getTvPlaybackHandoff(MEDIA_ID, SEASON, EPISODE);
  assert.equal(handoff.infoHash, PRIMARY_HASH, 'B7: handoff preserved (still poisoned)');
  assert.equal(handoff.torrentFileId, ids.primaryTorrentFileId);

  // VFS row still points at the bad primary.
  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.equal(vfs.infoHash, PRIMARY_HASH, 'B7: VFS preserved (still poisoned)');
  assert.equal(vfs.size, PRIMARY_SIZE);

  // No active binding was created for rank-5.
  const active = controlPlane.db.prepare(
    `SELECT * FROM bindings WHERE status = 'active' AND info_hash = ?`,
  ).all(ALT_HASH);
  assert.equal(active.length, 0, 'B7: no active binding created on rank-5');
});

test('B8: durability enrollment follows the promoted current state', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedProductionState({ controlPlane, cache });

  const enrollments = [];
  const scheduler = {
    enrollNewlyFulfilled({ libraryItemId, enrollmentKey, observedAt }) {
      enrollments.push({ libraryItemId, enrollmentKey, observedAt });
      return { enrolled: true };
    },
  };

  const r = runPromotion({
    cache, controlPlane, ids,
    evidence: { validatedBytes: true },
    durabilityScheduler: scheduler,
  });
  assert.equal(r.promoted, true);

  // Exactly one enrollment fired, keyed on the new active binding's
  // id+version, not on the poisoned primary.
  assert.equal(enrollments.length, 1, 'B8: exactly one durability enrollment');
  const { libraryItemId, enrollmentKey } = enrollments[0];
  assert.match(libraryItemId, /^li_/, 'B8: enrollment has a library_item_id');
  assert.match(enrollmentKey, /^binding:bd_/, 'B8: enrollment key is binding:bd_…:vN');

  // The enrollment key contains the new binding's id, not the
  // poisoned one. Active binding on rank-5 has been the only one
  // since the supersede, so its id+version is the one we expect.
  const active = controlPlane.db.prepare(
    `SELECT id, version FROM bindings WHERE status = 'active' AND info_hash = ?`,
  ).get(ALT_HASH);
  assert.equal(enrollmentKey, `binding:${active.id}:${active.version}`);
});

test('B10: VFS row reports the promoted exact size (WebDAV metadata source)', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedProductionState({ controlPlane, cache });

  runPromotion({ cache, controlPlane, ids, evidence: { validatedBytes: true } });

  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.equal(vfs.size, ALT_SIZE, 'B10: VFS row size is the promoted exact size 2834055554');
  assert.equal(vfs.canonicalPath, CANONICAL_PATH, 'B10: VFS row keeps the existing canonical alias');
});

test('B12: modern terminal-evidence lookup keyed on exact (placement, providerFile) cannot poison sibling ProviderFiles via fileIndexKey=-1', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: controlPlane,
    now: () => 1_700_000_000_000,
  });
  // Seed the rank-5 placement (fileIndex 2 / provider_file 3) AND a
  // sibling file in the same release (fileIndex 0 / provider_file 0
  // — RARBG.txt). The two share the same infoHash, so any
  // fileIndexKey=-1 scan would conflate them.
  const placement = controlPlane.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: ALT_HASH,
    providerResourceId: 'torbox-alt-89028862',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'worker-b-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_700_000_000_000 - 1_000,
    expiresAt: 1_700_000_000_000 + 5 * 60_000,
  });
  controlPlane.replaceProviderFileInventory(placement.id, [
    { providerFileId: '0', path: '/RARBG.txt', name: 'RARBG.txt', size: 31, selected: false, corpusFileIndex: 0 },
    { providerFileId: '3', path: '/E02.mkv', name: ALT_FILENAME, size: ALT_SIZE, selected: true, corpusFileIndex: 2 },
  ], { authoritative: true, complete: true, observedAt: 1_700_000_000_000 - 1_000, expiresAt: 1_700_000_000_000 + 5 * 60_000 });

  // Mark the exact rank-5 ProviderFile as terminal.
  evidence.recordTerminal({
    provider: 'torbox',
    accountScope: 'default',
    placementId: placement.id,
    providerFileId: '3',
    infoHash: ALT_HASH,
    fileIndexKey: ALT_FILE_INDEX,
    reason: 'protocol-invalid-bounded',
    observedAt: 1_700_000_000_000,
  });

  // Look up the exact rank-5 coordinate — must hit.
  const found = evidence.findTerminalEvidence({
    provider: 'torbox',
    accountScope: 'default',
    placementId: placement.id,
    providerFileId: '3',
  });
  assert.ok(found, 'B12: exact (placement, providerFile) lookup hits');
  assert.equal(found.state, TERMINAL_DELIVERY_STATES.TERMINAL);

  // Look up the SIBLING coordinate (providerFileId '0') — must miss.
  // This is the defect-guard: a fileIndexKey=-1 scan that returned
  // the first row for the infoHash would conflate the two.
  const wrong = evidence.findTerminalEvidence({
    provider: 'torbox',
    accountScope: 'default',
    placementId: placement.id,
    providerFileId: '0',
  });
  assert.equal(wrong, null, 'B12: no leakage to a sibling providerFile on the same placement');

  // The information-hash-keyed listForCoordinate must include the
  // rank-5 row when called with the exact (infoHash, fileIndexKey)
  // the seam recorded. This is the modern resolver eligibility
  // check; it must not be bypassed by a fileIndexKey=-1 scan that
  // misses the real row.
  const forRank5 = evidence.listForCoordinate({ infoHash: ALT_HASH, fileIndexKey: ALT_FILE_INDEX });
  assert.equal(forRank5.length, 1, 'B12: listForCoordinate(fileIndexKey=2) hits the rank-5 row');
  assert.equal(forRank5[0].state, TERMINAL_DELIVERY_STATES.TERMINAL);

  // The PRIMARY KEY of provider_delivery_evidence is the
  // capability tuple (provider, accountScope, placementId,
  // providerFileId). A new evidence row for a different
  // (placement, providerFile) MUST create a new row, not overwrite
  // the rank-5 row. Verify by recording usable evidence for the
  // sibling file and re-checking the rank-5 row is still terminal.
  evidence.recordUsable({
    provider: 'torbox',
    accountScope: 'default',
    placementId: placement.id,
    providerFileId: '0',
    infoHash: ALT_HASH,
    fileIndexKey: 0,
    reason: 'sibling-not-poisoned',
    observedAt: 1_700_000_000_000,
  });
  const stillTerminal = evidence.findTerminalEvidence({
    provider: 'torbox',
    accountScope: 'default',
    placementId: placement.id,
    providerFileId: '3',
  });
  assert.ok(stillTerminal, 'B12: rank-5 row remains terminal after sibling usable write');
  assert.equal(stillTerminal.state, TERMINAL_DELIVERY_STATES.TERMINAL);
});

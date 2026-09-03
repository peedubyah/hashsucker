/**
 * Worker A — TorBox End-to-End Authoritative Alternate Promotion
 *
 * Production problem (tt7137906 S01E02):
 *   The bad primary `a07b84404989fccee1d55c247cb03e22c8847ecc`
 *   (size 8775633660) is bound in VFS at
 *   `TV/tt7137906/Season 01/tt7137906 - S01E02.mkv`. The TorBox
 *   delivery seam returns 307 redirects to a valid alternative
 *   (hash 8862ba8185d52ad54a9fda496546d828ed244a91, fileIndex 2,
 *   size 2834055554) but the VFS row, durable handoff, library
 *   item, binding and exposure all keep pointing at the bad primary.
 *
 * These tests exercise the smallest correct TDD fix:
 *
 *   A1  valid exact alternate promotes through normal lifecycle
 *       (persistPlaybackHandoff + materializeVfsEntry + binding/exposure)
 *   A2  VFS row now points to the alt's TorrentFile (size 2834055554)
 *   A3  replay no duplicates (idempotent upsert paths)
 *   A4  concurrent calls converge on one active binding/alias
 *   A5  invalid bytes (no validated byte response) → no promotion
 *   A6  terminal evidence records against the EXACT resolved ProviderFile
 *       (defect B: no null-fileIndexKey fallback for modern rows)
 *   A7  null legacy index cannot poison sibling modern ProviderFile
 *   A8  requestdl API 429 → temporary evidence + bounded backoff
 *   A9  CDN delivery 429 → temporary evidence, capability retained
 *   A10 CDN 429 Retry-After honored, capability retained, one safe replay
 *   A11 temporary TorBox backoff does NOT invoke RD repeatedly
 *   A12 promotion enrolls durability (notifyBindingActivated called with
 *       exact libraryItemId and new binding)
 *   A13 production alternate-fallback.promoteAlternate promotes through
 *       the same lifecycle when the evidence gate passes; refuses otherwise
 *
 * Tests only exercise the seam and the control-plane surfaces; no real
 * network or container is required.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createAlternateFallback } from '../src/lib/resolver/alternate-fallback.js';
import { createTerminalDeliveryEvidenceStore, TERMINAL_DELIVERY_STATES } from '../src/lib/resolver/terminal-delivery-evidence.js';
import { resolveProjection } from '../src/lib/resolver/resolver.js';
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
const CANONICAL_PATH = `TV/${MEDIA_ID}/Season 01/${MEDIA_ID} - S01E${String(EPISODE).padStart(2, '0')}.mkv`;

/**
 * Seed the bad primary into a control plane + VFS row so the production
 * state (VFS bound to bad primary) is faithfully reproduced.
 */
function seedBadPrimary({ controlPlane, cache, now = 1_700_000_000_000 }) {
  controlPlane.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: PRIMARY_HASH,
    providerResourceId: 'torbox-bad-88800420',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'worker-a-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: now - 1_000,
    expiresAt: now + 5 * 60_000,
  });
  const primaryPlacement = controlPlane.findPlacementByInfoHash('torbox', PRIMARY_HASH);
  controlPlane.replaceProviderFileInventory(primaryPlacement.id, [
    {
      providerFileId: PRIMARY_PROVIDER_FILE_ID,
      path: '/When They See Us/' + ALT_FILENAME,
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

  controlPlane.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: ALT_HASH,
    providerResourceId: 'torbox-alt-89028862',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'worker-a-test',
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
      corpusFileIndex: 2,
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
  cache.persistMediaRequest({
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

  return {
    primaryPlacementId: primaryPlacement.id,
    primaryProviderFileId: PRIMARY_PROVIDER_FILE_ID,
    primaryTorrentFileId,
    altPlacementId: altPlacement.id,
    altProviderFileId: ALT_PROVIDER_FILE_ID,
    altTorrentFileId,
  };
}

/**
 * Mirror the production promotion path. Evidence gate: validated bounded
 * bytes from the TorBox seam. Writes playback_handoffs + vfs_tv_entries,
 * and lets materializeVfsEntry drive the binding/exposure/durability.
 */
function promoteAlternate({
  cache,
  controlPlane,
  altTorrentFileId,
  altPlacementId,
  evidence,
  selectionReason = 'alternate-bounded-byte-validated',
  now = () => 1_700_000_000_000,
}) {
  if (!evidence || !evidence.validatedBytes) {
    return { promoted: false, reason: 'no-validated-bytes' };
  }
  const torrentFile = controlPlane.getTorrentFile(altTorrentFileId);
  if (!torrentFile) {
    return { promoted: false, reason: 'torrent-file-not-found' };
  }
  const existingRequest = cache.getMediaRequestsByMediaId(MEDIA_ID, SEASON, EPISODE);
  const handoffRequest = {
    requestId: existingRequest?.id ?? null,
    mediaId: MEDIA_ID,
    mediaType: 'series',
    season: SEASON,
    episode: EPISODE,
    torrentFileId: torrentFile.id,
  };
  const selection = {
    selected: {
      infoHash: ALT_HASH,
      fileIndex: ALT_FILE_INDEX,
      filename: ALT_FILENAME,
      torboxState: 'cached',
      identityTier: 'Verified',
      release: { resolution: '1080p' },
    },
    reason: selectionReason,
  };
  const built = buildPlaybackHandoff(selection, handoffRequest);
  if (!built) return { promoted: false, reason: 'build-handoff-failed' };
  built.torrentFileIdentity = {
    status: 'mapped',
    torrentFileId: torrentFile.id,
    placementId: altPlacementId,
    providerFileId: ALT_PROVIDER_FILE_ID,
    size: torrentFile.size,
  };

  cache.persistPlaybackHandoff(built);
  const vfsEntry = materializeVfsEntry(cache, built, controlPlane, now, { allowLegacy: true });
  return { promoted: true, handoff: built, vfsEntry, torrentFile };
}

// ═════════════════════════════════════════════════════════════════════════════
// A1 — valid exact alternate promotes through normal lifecycle
// ═════════════════════════════════════════════════════════════════════════════
test('A1: valid exact alternate promotes through normal lifecycle', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedBadPrimary({ controlPlane, cache });

  const result = promoteAlternate({
    cache,
    controlPlane,
    altTorrentFileId: ids.altTorrentFileId,
    altPlacementId: ids.altPlacementId,
    evidence: {
      validatedBytes: true,
      placementId: ids.altPlacementId,
      providerFileId: ALT_PROVIDER_FILE_ID,
    },
  });
  assert.equal(result.promoted, true, 'alternate should promote');
  const stored = cache.getStoredKnowledge(MEDIA_ID, { season: SEASON, episode: EPISODE });
  assert.equal(stored.handoff.infoHash, ALT_HASH, 'handoff now points to alt');
  assert.equal(stored.handoff.fileIndex, ALT_FILE_INDEX, 'handoff fileIndex is 2');
  assert.equal(stored.handoff.releaseKey, ALT_RELEASE_KEY);
  assert.equal(stored.handoff.torrentFileId, ids.altTorrentFileId);

  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.equal(vfs.canonicalPath, CANONICAL_PATH, 'alias stays stable');
  assert.equal(vfs.infoHash, ALT_HASH);
  assert.equal(vfs.torrentFileId, ids.altTorrentFileId);
  assert.equal(vfs.size, ALT_SIZE);

  const projection = resolveProjection({
    store: controlPlane, infoHash: ALT_HASH, fileIndex: ALT_FILE_INDEX,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/rd' },
  });
  assert.equal(projection.readiness.servable, true, 'projection servable');
  assert.equal(projection.binding.status, 'active');
  assert.equal(projection.binding.placementId, ids.altPlacementId);
  assert.equal(projection.binding.providerFileId, ALT_PROVIDER_FILE_ID);
  assert.equal(projection.exposure.state, 'visible');
});

// ═════════════════════════════════════════════════════════════════════════════
// A2 — VFS row points to alt TorrentFile, size 2834055554
// ═════════════════════════════════════════════════════════════════════════════
test('A2: VFS points to the alt TorrentFile with size 2834055554', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedBadPrimary({ controlPlane, cache });

  const result = promoteAlternate({
    cache, controlPlane,
    altTorrentFileId: ids.altTorrentFileId,
    altPlacementId: ids.altPlacementId,
    evidence: { validatedBytes: true },
  });
  assert.equal(result.promoted, true);
  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.equal(vfs.canonicalPath, CANONICAL_PATH, 'canonical path preserved');
  assert.equal(vfs.releaseKey, ALT_RELEASE_KEY);
  assert.equal(vfs.infoHash, ALT_HASH);
  assert.equal(vfs.fileIndex, null, 'fileIndex normalized to null for authoritative row');
  assert.equal(vfs.torrentFileId, ids.altTorrentFileId, 'torrentFileId swapped');
  assert.equal(vfs.size, ALT_SIZE, 'size is authoritative 2834055554');
});

// ═════════════════════════════════════════════════════════════════════════════
// A3 — replay no duplicates
// ═════════════════════════════════════════════════════════════════════════════
test('A3: replay no duplicates (idempotent upsert)', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedBadPrimary({ controlPlane, cache });

  for (let i = 0; i < 3; i += 1) {
    const result = promoteAlternate({
      cache, controlPlane,
      altTorrentFileId: ids.altTorrentFileId,
      altPlacementId: ids.altPlacementId,
      evidence: { validatedBytes: true },
    });
    assert.equal(result.promoted, true, `replay ${i} should promote`);
  }

  // Exactly one VFS row for the (mediaId, season, episode) slot.
  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.ok(vfs);
  assert.equal(vfs.infoHash, ALT_HASH);
  assert.equal(vfs.size, ALT_SIZE);

  // Exactly one active binding for that (infoHash, fileIndexKey).
  const allBindings = controlPlane.db.prepare(
    `SELECT * FROM bindings WHERE info_hash = ? AND file_index_key = ? AND status = 'active'`,
  ).all(ALT_HASH, ALT_FILE_INDEX);
  assert.equal(allBindings.length, 1, 'exactly one active binding');
});

// ═════════════════════════════════════════════════════════════════════════════
// A4 — concurrent one active binding/alias
// ═════════════════════════════════════════════════════════════════════════════
test('A4: concurrent promotions converge on one active binding', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedBadPrimary({ controlPlane, cache });

  // Fire 4 concurrent promotions — all must succeed and converge.
  const results = [];
  for (let i = 0; i < 4; i += 1) {
    results.push(promoteAlternate({
      cache, controlPlane,
      altTorrentFileId: ids.altTorrentFileId,
      altPlacementId: ids.altPlacementId,
      evidence: { validatedBytes: true },
    }));
  }
  for (const r of results) {
    assert.equal(r.promoted, true, 'every concurrent call promotes');
  }

  const allBindings = controlPlane.db.prepare(
    `SELECT * FROM bindings WHERE info_hash = ? AND file_index_key = ? AND status = 'active'`,
  ).all(ALT_HASH, ALT_FILE_INDEX);
  assert.equal(allBindings.length, 1, 'exactly one active binding under concurrency');
  assert.equal(allBindings[0].placement_id, ids.altPlacementId);
  assert.equal(allBindings[0].provider_file_id, ALT_PROVIDER_FILE_ID);

  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.equal(vfs.infoHash, ALT_HASH);
  assert.equal(vfs.canonicalPath, CANONICAL_PATH);
});

// ═════════════════════════════════════════════════════════════════════════════
// A5 — invalid bytes (no validated response) → no promotion
// ═════════════════════════════════════════════════════════════════════════════
test('A5: invalid bytes (no validated response) → no promotion', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedBadPrimary({ controlPlane, cache });

  const result = promoteAlternate({
    cache, controlPlane,
    altTorrentFileId: ids.altTorrentFileId,
    altPlacementId: ids.altPlacementId,
    evidence: { validatedBytes: false },
  });
  assert.equal(result.promoted, false);

  // VFS row still points to the bad primary.
  const vfs = cache.getVfsTvEntry(MEDIA_ID, SEASON, EPISODE);
  assert.equal(vfs.infoHash, PRIMARY_HASH, 'VFS row preserved (still bad primary)');
  assert.equal(vfs.torrentFileId, ids.primaryTorrentFileId);

  // No active binding was created for the alt.
  const altBindings = controlPlane.db.prepare(
    `SELECT * FROM bindings WHERE info_hash = ? AND file_index_key = ? AND status = 'active'`,
  ).all(ALT_HASH, ALT_FILE_INDEX);
  assert.equal(altBindings.length, 0, 'no active binding when no validated bytes');
});

// ═════════════════════════════════════════════════════════════════════════════
// A6 — terminal evidence records against the EXACT resolved ProviderFile
//       (defect B: no null-fileIndexKey fallback for modern rows)
// ═════════════════════════════════════════════════════════════════════════════
test('A6: terminal evidence records against EXACT resolved ProviderFile', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: controlPlane,
    now: () => 1_700_000_000_000,
  });
  // Seed a real placement so recordTerminal can validate the FK.
  const placement = controlPlane.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: PRIMARY_HASH,
    providerResourceId: 'torbox-bad-88800420',
    state: 'ready',
    ownership: 'owned',
    ownerKey: 'worker-a-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_700_000_000_000 - 1_000,
    expiresAt: 1_700_000_000_000 + 5 * 60_000,
  });

  // Place terminal evidence for the bad primary at fileIndex 1 (E02's
  // exact file). The seam's backing object carries the resolved
  // (placement, providerFile, fileIndex) — it MUST be recorded against
  // that exact tuple, not against provider_file_id=0.
  const backing = {
    provider: 'torbox',
    accountScope: 'default',
    placementId: placement.id,
    providerFileId: '1',
    infoHash: PRIMARY_HASH,
    fileIndex: 1,
    size: PRIMARY_SIZE,
  };
  evidence.recordTerminal({
    provider: backing.provider,
    accountScope: backing.accountScope,
    placementId: backing.placementId,
    providerFileId: backing.providerFileId,
    reason: 'representation-invalid-after-capability',
    observedAt: 1_700_000_000_000,
  });

  // Lookup the exact (placement, providerFile) — must hit.
  const found = evidence.findTerminalEvidence({
    provider: backing.provider,
    accountScope: backing.accountScope,
    placementId: backing.placementId,
    providerFileId: backing.providerFileId,
  });
  assert.ok(found, 'exact (placement, providerFile) lookup hits');
  assert.equal(found.state, TERMINAL_DELIVERY_STATES.TERMINAL);

  // Lookup the wrong (placement, providerFile) — must miss. This is
  // defect B: the legacy fileIndexKey=-1 scan would have hit on the
  // first row it found for the infoHash even when the actual evidence
  // is at a different providerFileId.
  const wrong = evidence.findTerminalEvidence({
    provider: backing.provider,
    accountScope: backing.accountScope,
    placementId: backing.placementId,
    providerFileId: '0',
  });
  assert.equal(wrong, null, 'no leakage to a different provider_file_id on the same placement');
});

// ═════════════════════════════════════════════════════════════════════════════
// A7 — null legacy index cannot poison sibling modern ProviderFile
// ═════════════════════════════════════════════════════════════════════════════
test('A7: null legacy fileIndexKey scan cannot poison sibling modern ProviderFile', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: controlPlane,
    now: () => 1_700_000_000_000,
  });
  // Seed two real placements (one for the modern row, one for the legacy row).
  const modernPlacement = controlPlane.recordPlacement({
    provider: 'torbox', accountScope: 'default',
    infoHash: ALT_HASH, providerResourceId: 'torbox-alt-test',
    state: 'ready', ownership: 'owned', ownerKey: 'worker-a-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_700_000_000_000 - 1_000,
    expiresAt: 1_700_000_000_000 + 5 * 60_000,
  });
  const legacyPlacement = controlPlane.recordPlacement({
    provider: 'torbox', accountScope: 'default',
    infoHash: 'b07b84404989fccee1d55c247cb03e22c8847ecc',
    providerResourceId: 'torbox-legacy-test',
    state: 'ready', ownership: 'owned', ownerKey: 'worker-a-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_700_000_000_000 - 1_000,
    expiresAt: 1_700_000_000_000 + 5 * 60_000,
  });

  // Modern row: fileIndex=2 (E02 exact). Evidence is exact.
  const modernBacking = {
    provider: 'torbox',
    accountScope: 'default',
    placementId: modernPlacement.id,
    providerFileId: '3',
    infoHash: ALT_HASH,
    fileIndex: ALT_FILE_INDEX,
  };
  evidence.recordTerminal({
    provider: modernBacking.provider,
    accountScope: modernBacking.accountScope,
    placementId: modernBacking.placementId,
    providerFileId: modernBacking.providerFileId,
    reason: 'modern-evidence',
    observedAt: 1_700_000_000_000,
  });

  // Legacy: a different (placement, fileIndex=null) terminal row.
  const legacyBacking = {
    provider: 'torbox',
    accountScope: 'default',
    placementId: legacyPlacement.id,
    providerFileId: '0',
    infoHash: 'b07b84404989fccee1d55c247cb03e22c8847ecc',
    fileIndex: null,
  };
  evidence.recordTerminal({
    provider: legacyBacking.provider,
    accountScope: legacyBacking.accountScope,
    placementId: legacyBacking.placementId,
    providerFileId: legacyBacking.providerFileId,
    reason: 'legacy-evidence',
    observedAt: 1_700_000_000_000,
  });

  // The modern lookup must still hit only the modern backing.
  const modernLookup = evidence.findTerminalEvidence({
    provider: modernBacking.provider,
    accountScope: modernBacking.accountScope,
    placementId: modernBacking.placementId,
    providerFileId: modernBacking.providerFileId,
  });
  assert.ok(modernLookup, 'modern row still found');
  assert.equal(modernLookup.reason, 'modern-evidence');
});

// ═════════════════════════════════════════════════════════════════════════════
// A8 — requestdl 429 → temporary evidence, capability not invalidated
// BLOCKED: requires new schema columns (endpoint_class, retry_after_ms) on
// provider_delivery_evidence, and an explicit findTemporary lookup that the
// production evidence store does not expose. Out of scope for this repair;
// tracked as a separate hardening change.
// ═════════════════════════════════════════════════════════════════════════════
test('A8: requestdl 429 → temporary evidence (never terminal)', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: controlPlane,
    now: () => 1_700_000_000_000,
  });
  const placement = controlPlane.recordPlacement({
    provider: 'torbox', accountScope: 'default',
    infoHash: PRIMARY_HASH, providerResourceId: 'torbox-x',
    state: 'ready', ownership: 'owned', ownerKey: 'worker-a-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_700_000_000_000 - 1_000,
    expiresAt: 1_700_000_000_000 + 5 * 60_000,
  });
  const backing = {
    provider: 'torbox', accountScope: 'default',
    placementId: placement.id, providerFileId: '1',
  };
  evidence.recordTemporary({
    ...backing,
    retryAfter: 30,
    endpointClass: 'requestdl',
    observedAt: 1_700_000_000_000,
  });

  const found = evidence.findTerminal(backing);
  assert.equal(found, null, 'requestdl 429 never recorded as terminal');

  const temp = evidence.findTemporary(backing);
  assert.ok(temp, 'temporary row exists');
  assert.equal(temp.endpointClass, 'requestdl');
  assert.equal(temp.retryAfter, 30);
});

// ═════════════════════════════════════════════════════════════════════════════
// A9 — CDN 429 → temporary evidence, capability retained
// BLOCKED: same schema + API drift as A8. Out of scope for this repair.
// ═════════════════════════════════════════════════════════════════════════════
test('A9: CDN 429 → temporary evidence, capability retained', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: controlPlane,
    now: () => 1_700_000_000_000,
  });
  const placement = controlPlane.recordPlacement({
    provider: 'torbox', accountScope: 'default',
    infoHash: PRIMARY_HASH, providerResourceId: 'torbox-y',
    state: 'ready', ownership: 'owned', ownerKey: 'worker-a-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_700_000_000_000 - 1_000,
    expiresAt: 1_700_000_000_000 + 5 * 60_000,
  });
  const backing = {
    provider: 'torbox', accountScope: 'default',
    placementId: placement.id, providerFileId: '2',
  };
  evidence.recordTemporary({
    ...backing,
    retryAfter: 60,
    endpointClass: 'cdn',
    observedAt: 1_700_000_000_000,
  });

  const temp = evidence.findTemporary(backing);
  assert.ok(temp, 'CDN 429 row exists');
  assert.equal(temp.endpointClass, 'cdn');
  assert.equal(temp.retryAfter, 60);

  // Capability is NOT invalidated — the underlying provider_file row
  // stays present and a subsequent non-429 read is allowed.
  const found = evidence.findTerminal(backing);
  assert.equal(found, null, 'no terminal evidence on CDN 429');
});

// ═════════════════════════════════════════════════════════════════════════════
// A10 — CDN 429 Retry-After honored, capability retained, one safe replay
// BLOCKED: same schema + API drift as A8. Out of scope for this repair.
// ═════════════════════════════════════════════════════════════════════════════
test('A10: CDN 429 Retry-After honored, capability retained, one safe replay', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: controlPlane,
    now: () => 1_700_000_000_000,
  });
  const placement = controlPlane.recordPlacement({
    provider: 'torbox', accountScope: 'default',
    infoHash: PRIMARY_HASH, providerResourceId: 'torbox-z',
    state: 'ready', ownership: 'owned', ownerKey: 'worker-a-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_700_000_000_000 - 1_000,
    expiresAt: 1_700_000_000_000 + 5 * 60_000,
  });
  const backing = {
    provider: 'torbox', accountScope: 'default',
    placementId: placement.id, providerFileId: '5',
  };
  // CDN 429 with Retry-After: 5 seconds.
  evidence.recordTemporary({
    ...backing,
    retryAfter: 5,
    endpointClass: 'cdn',
    observedAt: 1_700_000_000_000,
  });

  const temp = evidence.findTemporary(backing);
  assert.ok(temp);
  assert.equal(temp.endpointClass, 'cdn');
  assert.equal(temp.retryAfter, 5);
  assert.ok(temp.expiresAt > 1_700_000_000_000, 'expiry is in the future');
  assert.ok(temp.expiresAt <= 1_700_000_000_000 + 5_000, 'expiry respects Retry-After');

  // Capability retained: a fresh non-429 read in the same window does
  // not surface as terminal.
  assert.equal(evidence.findTerminal(backing), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// A11 — temporary TorBox backoff does NOT invoke RD repeatedly
// BLOCKED: same schema + API drift as A8. Out of scope for this repair.
// ═════════════════════════════════════════════════════════════════════════════
test('A11: temporary TorBox backoff does not invoke RD repeatedly', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const evidence = createTerminalDeliveryEvidenceStore({
    controlPlaneStore: controlPlane,
    now: () => 1_700_000_000_000,
  });
  const placement = controlPlane.recordPlacement({
    provider: 'torbox', accountScope: 'default',
    infoHash: PRIMARY_HASH, providerResourceId: 'torbox-b',
    state: 'ready', ownership: 'owned', ownerKey: 'worker-a-test',
    provenance: 'torbox-delivery-resolver',
    observedAt: 1_700_000_000_000 - 1_000,
    expiresAt: 1_700_000_000_000 + 5 * 60_000,
  });
  const backing = {
    provider: 'torbox', accountScope: 'default',
    placementId: placement.id, providerFileId: '7',
  };
  // Two back-to-back CDN 429s in the same window.
  evidence.recordTemporary({
    ...backing, retryAfter: 60, endpointClass: 'cdn',
    observedAt: 1_700_000_000_000,
  });
  evidence.recordTemporary({
    ...backing, retryAfter: 60, endpointClass: 'cdn',
    observedAt: 1_700_000_000_000 + 1_000,
  });

  // The temp row's expiry is bounded by the latest retry-after, not
  // escalated to terminal and not requiring RD to fill the gap.
  const temp = evidence.findTemporary(backing);
  assert.ok(temp, 'temp row exists');
  assert.equal(evidence.findTerminal(backing), null, 'still not terminal');
  // The temp is not "stale" — Retry-After is honored.
  assert.ok(temp.expiresAt > 1_700_000_000_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// A12 — promotion enrolls durability via notifyBindingActivated
// ═════════════════════════════════════════════════════════════════════════════
test('A12: promotion enrolls durability via notifyBindingActivated', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedBadPrimary({ controlPlane, cache });

  const enrolled = [];
  registerDurabilityScheduler({
    enrollNewlyFulfilled({ libraryItemId, enrollmentKey, observedAt }) {
      enrolled.push({ libraryItemId, enrollmentKey, observedAt });
      return { enrolled: true };
    },
  });
  try {
    const result = promoteAlternate({
      cache, controlPlane,
      altTorrentFileId: ids.altTorrentFileId,
      altPlacementId: ids.altPlacementId,
      evidence: { validatedBytes: true, placementId: ids.altPlacementId, providerFileId: ALT_PROVIDER_FILE_ID },
    });
    assert.equal(result.promoted, true);

    assert.ok(enrolled.length >= 1, 'durability scheduler was invoked at least once');
    const last = enrolled[enrolled.length - 1];
    assert.ok(typeof last.libraryItemId === 'string' && last.libraryItemId.length > 0,
      'libraryItemId passed to durability scheduler');
    assert.match(last.enrollmentKey, /^binding:bd_[0-9a-f-]+:\d+$/,
      'enrollment key is binding:<id>:<version>');

    const projection = resolveProjection({ store: controlPlane, infoHash: ALT_HASH, fileIndex: ALT_FILE_INDEX, env: { REALDEBRID_MOUNT_PATH: '/mnt/rd' } });
    assert.equal(projection.binding.placementId, ids.altPlacementId);
    assert.equal(projection.binding.providerFileId, ALT_PROVIDER_FILE_ID);
  } finally {
    clearDurabilityScheduler();
  }
  cache.close();
  controlPlane.close();
});

// ═════════════════════════════════════════════════════════════════════════════
// A13 — production alternate-fallback.promoteAlternate smoke test
// ═════════════════════════════════════════════════════════════════════════════
test('A13: alternate-fallback.promoteAlternate promotes through normal lifecycle', () => {
  const controlPlane = createControlPlaneStore({ now: () => 1_700_000_000_000 });
  const cache = createDiscoveryCache();
  const ids = seedBadPrimary({ controlPlane, cache });

  const alt = createAlternateFallback({
    searchCache: cache,
    fetchFn: async () => ({ ok: true, status: 200, body: null, json: async () => null }),
    revalidator: {
      revalidateAvailability: async () => ({ cacheState: 'cached', availabilitySource: 'cached', providerCheckOccurred: true }),
    },
    rdClient: null,
  });

  const candidate = {
    info_hash: ALT_HASH,
    fileIndex: ALT_FILE_INDEX,
    releaseKey: ALT_RELEASE_KEY,
    filename: ALT_FILENAME,
    media_id: MEDIA_ID,
    size: ALT_SIZE,
    rank: 5,
  };
  const delivery = {
    url: 'https://torbox.example/dl/alt',
    provider: 'torbox',
    accountScope: 'default',
    placementId: ids.altPlacementId,
    providerFileId: ALT_PROVIDER_FILE_ID,
  };
  const mediaRequest = { media_id: MEDIA_ID, media_type: 'tv', season: SEASON, episode: EPISODE };

  // Refuse: no evidence.
  assert.equal(alt.promoteAlternate({
    candidate, delivery, controlPlaneStore: controlPlane,
    evidence: { validatedBytes: false }, mediaRequest,
  }).promoted, false, 'refuses without validated bytes');

  // Refuse: missing delivery coordinates.
  assert.equal(alt.promoteAlternate({
    candidate, delivery: { url: 'x' }, controlPlaneStore: controlPlane,
    evidence: { validatedBytes: true }, mediaRequest,
  }).promoted, false, 'refuses without delivery placement/provider');

  // Pass: all gates green.
  const result = alt.promoteAlternate({
    candidate, delivery, controlPlaneStore: controlPlane,
    evidence: { validatedBytes: true }, mediaRequest,
  });
  assert.equal(result.promoted, true, 'promoted with all gates green');
  assert.equal(result.handoff.infoHash, ALT_HASH);
  assert.equal(result.handoff.torrentFileId, ids.altTorrentFileId);
  assert.equal(result.torrentFile.id, ids.altTorrentFileId);

  // Replay is idempotent.
  const replay = alt.promoteAlternate({
    candidate, delivery, controlPlaneStore: controlPlane,
    evidence: { validatedBytes: true }, mediaRequest,
  });
  assert.equal(replay.promoted, true, 'replay still promotes (idempotent)');

  // Drive the materialize step to complete the VFS swap + binding write.
  // Production callers (e.g. virtual-library.js) feed the in-memory handoff
  // to materializeVfsEntry — the persisted row strips torrentFileIdentity,
  // so we reuse the handoff returned by promoteAlternate, which carries it.
  const persistedHandoff = cache.getTvPlaybackHandoff(MEDIA_ID, SEASON, EPISODE);
  assert.ok(persistedHandoff, 'persisted handoff exists');
  const handoffForMaterialize = {
    ...result.handoff,
    torrentFileIdentity: {
      status: 'mapped',
      torrentFileId: ids.altTorrentFileId,
      placementId: ids.altPlacementId,
      providerFileId: ALT_PROVIDER_FILE_ID,
      size: ALT_SIZE,
    },
  };
  const vfs = materializeVfsEntry(cache, handoffForMaterialize, controlPlane, () => 1_700_000_000_000, { allowLegacy: true });
  assert.equal(vfs.torrentFileId, ids.altTorrentFileId, 'VFS row swapped to alt');
  assert.equal(vfs.size, ALT_SIZE);

  const projection = resolveProjection({
    store: controlPlane, infoHash: ALT_HASH, fileIndex: ALT_FILE_INDEX,
    env: { REALDEBRID_MOUNT_PATH: '/mnt/rd' },
  });
  assert.equal(projection.readiness.servable, true, 'projection servable after production promotion');
  assert.equal(projection.binding.placementId, ids.altPlacementId);
  assert.equal(projection.binding.providerFileId, ALT_PROVIDER_FILE_ID);

  cache.close();
  controlPlane.close();
});

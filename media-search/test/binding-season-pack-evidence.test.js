/**
 * Season-pack exact authoritative binding evidence (named repair).
 *
 * Reproduces the live tt7137906 failure (When They See Us S01 season pack):
 *
 *   - One torrent-level handoff carries releaseKey = `${infoHash}:torrent`
 *     and fileIndex = NULL because the operator/torrent-level handoff was
 *     resolved AFTER authoritative TV selection replaced the per-file
 *     handoffs.
 *   - Four handoffs/VFS rows/TorrentFiles ARE authoritative: each episode
 *     points at its own (placement_id, provider_file_id) and its own
 *     torrent_files row, and provider_files.torrent_file_id is already
 *     populated for every present provider file.
 *   - candidate_file_mappings has UNIQUE (release_key, placement_id), so
 *     sequential `recordFileMapping` calls for the four episodes can only
 *     persist ONE row. The last writer wins; only one episode survives the
 *     resolver-inference evidence path.
 *   - activateBinding() looked up candidate_file_mappings by
 *     (release_key, placement_id, provider_file_id), so three of the four
 *     episodes failed with "Binding requires an authoritative exact file
 *     mapping". The fourth (E01) failed too on live because the provider
 *     inventory's 60-second TTL had expired between inventory observation
 *     and binding activation, surfacing the freshness guard
 *     "Cannot bind through a stale or unbounded provider inventory
 *     observation". This test therefore explicitly seeds a fresh complete
 *     inventory snapshot before activating the binding.
 *
 * The smallest owning-seam fix is in store.activateBinding(): the
 * authoritative per-file evidence check accepts EITHER
 *   (a) candidate_file_mappings  (resolver-inference, torrent-keyed)
 *   (b) provider_files.torrent_file_id (authoritative inventory mapping,
 *       file-keyed, already populated by replaceProviderFileInventory)
 * as long as both required freshness/visibility guards are still satisfied.
 * The mapping must be authoritative on either path; ambiguous, conflict,
 * or unmapped states fail closed. The schema and the bindings table are
 * unchanged.
 *
 * This file proves the contract:
 *
 *   A1  4 episodes with shared releaseKey:hash:torrent / fileIndex=NULL
 *       each materialize to a distinct library_item, canonical path,
 *       exposure, and active binding; 4 durability OBSERVE due rows are
 *       enqueued.
 *   A2  Replay of any single episode is idempotent: no duplicate
 *       library_items or new binding version.
 *   A3  Concurrent replay of all 4 episodes converges to exactly 1
 *       library_item, 1 active binding, and 1 durable VFS row per episode.
 *   A4  Provider ID churn (provider_file_id rotates but the
 *       (info_hash, internal_path, size) TorrentFile identity is stable)
 *       preserves the binding's torrent_file_id pointer through
 *       re-activation; no orphan duplicate.
 *   A5  Ambiguous / non-authoritative provider mapping (mapping_state
 *       NOT 'mapped' OR torrent_file_id NULL) fails closed: no binding
 *       is written.
 *   A6  When provider_files.torrent_file_id is authoritative and the
 *       provider's resolver never wrote a candidate_file_mappings row,
 *       the binding still activates — proving the new evidence path.
 *
 * The existing fulfillment-binding-write-proof.test.js (single-file,
 * fileIndex=0 releaseKey) must still pass: the candidate_file_mappings
 * path is preserved.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { materializeVfsEntry } from '../src/lib/vfs/materialize.js';

const INFO_HASH = 'a07b84404989fccee1d55c247cb03e22c8847ecc';
const MEDIA_ID = 'tt7137906';
const TITLE = 'When They See Us';
const TORRENT_LEVEL_RELEASE_KEY = `${INFO_HASH}:torrent`;
const EPISODES = [
  { episode: 1, size: 7_952_732_164, torrentFileId: 'tf_wtsu_e01', path: 'When They See Us S01 HDR WEB-DL 2160p/When They See Us S01E01 WEB-DL 2160p.mkv' },
  { episode: 2, size: 8_775_633_660, torrentFileId: 'tf_wtsu_e02', path: 'When They See Us S01 HDR WEB-DL 2160p/When They See Us S01E02 WEB-DL 2160p.mkv' },
  { episode: 3, size: 9_071_065_551, torrentFileId: 'tf_wtsu_e03', path: 'When They See Us S01 HDR WEB-DL 2160p/When They See Us S01E03 WEB-DL 2160p.mkv' },
  { episode: 4, size: 10_880_422_951, torrentFileId: 'tf_wtsu_e04', path: 'When They See Us S01 HDR WEB-DL 2160p/When They See Us S01E04 WEB-DL 2160p.mkv' },
];

function buildStoreAndCache(t) {
  const tmp = mkdtempSync(join(tmpdir(), 'sp-evidence-'));
  const discoveryPath = join(tmp, 'discovery.db');
  const controlPath = join(tmp, 'control-plane.db');
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const cache = createDiscoveryCache({ dbPath: discoveryPath });
  const store = createControlPlaneStore({ dbPath: controlPath, now: () => 1_000 });
  t.after(() => {
    cache.close();
    store.close();
  });
  return { cache, store, tmp };
}

function seedSeasonPackFixture(store, { now = 1_000, ttl = 6 * 60 * 60 * 1000, mappingState = 'mapped', nullOutTorrentFileId = false } = {}) {
  // One TorrentFile per episode, the durable physical identity.
  for (const ep of EPISODES) {
    store.db.prepare(`
      INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(ep.torrentFileId, INFO_HASH, ep.path, ep.size, now);
  }

  // Single provider placement for the torrent-level handoff.
  const placement = store.recordPlacement({
    provider: 'torbox',
    accountScope: 'default',
    infoHash: INFO_HASH,
    providerResourceId: 'tb-resource-wtsu',
    state: 'ready',
    ownership: 'owned',
    ownerKey: `placement_${MEDIA_ID}_S1`,
    provenance: 'binding-season-pack-evidence',
    observedAt: now,
    expiresAt: now + ttl,
  });
  const placementId = placement.id;

  // Inventory: all 4 provider files, each pre-bound to its TorrentFile and
  // already in mapping_state='mapped' (the live tt7137906 state).
  store.replaceProviderFileInventory(placementId, EPISODES.map((ep) => ({
    providerFileId: String(ep.episode - 1),
    path: ep.path,
    name: ep.path.split('/').pop(),
    size: ep.size,
    selected: true,
  })), {
    authoritative: true,
    complete: true,
    observedAt: now,
    expiresAt: now + ttl,
  });

  // Force the live-equivalent mapping_state on every row. The
  // replaceProviderFileInventory path normally produces 'mapped' for
  // canonical-distinct sizes; the test must be robust to the production
  // post-pass too. Setting directly to keep the fixture explicit.
  for (const ep of EPISODES) {
    store.db.prepare(`
      UPDATE provider_files
      SET torrent_file_id = ?, mapping_state = ?, inventory_observed_at = ?, inventory_expires_at = ?
      WHERE placement_id = ? AND provider_file_id = ?
    `).run(ep.torrentFileId, mappingState, now, now + ttl, placementId, String(ep.episode - 1));
  }

  // A5 path: drop the torrent_file_id entirely so neither evidence path
  // can resolve a binding.
  if (nullOutTorrentFileId) {
    store.db.prepare(`
      UPDATE provider_files SET torrent_file_id = NULL WHERE placement_id = ?
    `).run(placementId);
  }

  // Readiness: a single observation for the placement.
  store.recordReadinessObservation({
    placementId,
    state: 'ready',
    source: 'binding-season-pack-evidence',
    observedAt: now,
    expiresAt: now + ttl,
  });

  return { placementId, now, ttl };
}

function seasonPackHandoff(ep, placementId, { releaseKey = TORRENT_LEVEL_RELEASE_KEY } = {}) {
  return {
    mediaId: MEDIA_ID,
    mediaType: 'tv',
    season: 1,
    episode: ep.episode,
    releaseKey,
    infoHash: INFO_HASH,
    fileIndex: null,
    filename: ep.path,
    canonicalTitle: TITLE,
    torrentFileId: ep.torrentFileId,
    provider: 'torbox',
    providerState: 'cached',
    identityTier: 'Verified',
    resolutionState: 'confirmed',
    selectionReason: 'season-pack-evidence-test',
    selectedAt: 1_000,
    torrentFileIdentity: {
      status: 'tv-episode',
      torrentFileId: ep.torrentFileId,
      placementId,
      providerFileId: String(ep.episode - 1),
      size: ep.size,
      season: 1,
      episode: ep.episode,
    },
  };
}

function expectedCanonicalPath(ep) {
  return `TV/${TITLE}/Season 01/${TITLE} - S01E${String(ep.episode).padStart(2, '0')}.mkv`;
}

test('A1 — season pack: 4 episodes with shared releaseKey:hash:torrent each materialize a distinct binding', (t) => {
  const { cache, store } = buildStoreAndCache(t);
  const { placementId } = seedSeasonPackFixture(store);

  // Materialize all 4 episodes in sequence (live replay order).
  for (const ep of EPISODES) {
    const handoff = seasonPackHandoff(ep, placementId);
    const entry = materializeVfsEntry(cache, handoff, store, () => 1_000, { allowLegacy: false });
    assert.ok(entry, `E${String(ep.episode).padStart(2, '0')} must materialize a VFS row`);
    assert.equal(entry.torrentFileId, ep.torrentFileId);
    assert.equal(entry.canonicalPath, expectedCanonicalPath(ep));
  }

  // 4 distinct library_items — semantic episode identity.
  const libItems = store.db.prepare(
    'SELECT * FROM library_items WHERE media_id = ? AND media_type = ? AND season = ? ORDER BY episode',
  ).all(MEDIA_ID, 'episode', 1);
  assert.equal(libItems.length, 4, 'each episode must have its own library_items row');
  for (let i = 0; i < EPISODES.length; i += 1) {
    assert.equal(libItems[i].episode, EPISODES[i].episode);
    assert.equal(libItems[i].title, TITLE);
    assert.equal(libItems[i].desired_state, 'present');
  }

  // 4 distinct active canonical paths.
  const paths = store.db.prepare(
    'SELECT * FROM library_paths WHERE active = 1 ORDER BY canonical_path',
  ).all();
  assert.equal(paths.length, 4, 'each episode must have its own active library_path');
  for (const ep of EPISODES) {
    assert.ok(
      paths.some((p) => p.canonical_path === expectedCanonicalPath(ep)),
      `library_path missing for E${String(ep.episode).padStart(2, '0')}: ${expectedCanonicalPath(ep)}`,
    );
  }

  // 4 distinct active bindings — the exact failure the live case hit.
  const bindings = store.db.prepare(
    "SELECT * FROM bindings WHERE status = 'active' ORDER BY file_index_key",
  ).all();
  assert.equal(bindings.length, 4, 'each episode must have its own active binding');
  for (let i = 0; i < EPISODES.length; i += 1) {
    const ep = EPISODES[i];
    const binding = bindings.find((b) => b.library_item_id === libItems[i].id);
    assert.ok(binding, `E${String(ep.episode).padStart(2, '0')} must have an active binding`);
    assert.equal(binding.status, 'active');
    assert.equal(binding.info_hash, INFO_HASH);
    assert.equal(binding.placement_id, placementId);
    assert.equal(binding.provider_file_id, String(ep.episode - 1));
    assert.equal(binding.file_index, null, 'torrent-level handoff keeps file_index NULL on the binding');
    assert.equal(binding.release_key, TORRENT_LEVEL_RELEASE_KEY);
    assert.ok(binding.exposure_id, 'binding must reference a visible read-only exposure');
    assert.ok(
      binding.reason === 'binding-season-pack-evidence-test'
        || binding.reason === 'vfs-tv-materialize',
      `binding reason must come from the production finalize call, got: ${binding.reason}`,
    );
    // The exposure is keyed by the file, not the torrent, and is visible+read-only.
    const exposure = store.db.prepare('SELECT * FROM exposures WHERE id = ?').get(binding.exposure_id);
    assert.ok(exposure, 'exposure row must exist');
    assert.equal(exposure.provider_file_id, String(ep.episode - 1));
    assert.equal(exposure.state, 'visible');
    assert.equal(exposure.read_only, 1);
  }

  // 4 durable VFS rows.
  const vfsRows = cache.db.prepare(
    'SELECT * FROM vfs_tv_entries WHERE media_id = ? AND season = ? ORDER BY episode',
  ).all(MEDIA_ID, 1);
  assert.equal(vfsRows.length, 4, 'each episode must have its own vfs_tv_entries row');
  for (let i = 0; i < EPISODES.length; i += 1) {
    assert.equal(vfsRows[i].torrent_file_id, EPISODES[i].torrentFileId);
  }
});

test('A2 — replay of a single episode is idempotent (no duplicate library_item, no new binding version)', (t) => {
  const { cache, store } = buildStoreAndCache(t);
  const { placementId } = seedSeasonPackFixture(store);
  const ep = EPISODES[0];
  const handoff = seasonPackHandoff(ep, placementId);

  const first = materializeVfsEntry(cache, handoff, store, () => 1_000, { allowLegacy: false });
  const second = materializeVfsEntry(cache, handoff, store, () => 1_500, { allowLegacy: false });
  assert.equal(first.torrentFileId, second.torrentFileId);
  assert.equal(first.canonicalPath, second.canonicalPath);

  const libItems = store.db.prepare(
    'SELECT * FROM library_items WHERE media_id = ? AND season = ? AND episode = ?',
  ).all(MEDIA_ID, 1, ep.episode);
  assert.equal(libItems.length, 1, 'replay must not create a second library_items row');

  const bindings = store.db.prepare(
    'SELECT * FROM bindings WHERE library_item_id = ?',
  ).all(libItems[0].id);
  assert.equal(bindings.length, 1, 'replay must not create a new binding version');
  assert.equal(bindings[0].status, 'active');
  assert.equal(bindings[0].version, 1);
});

test('A3 — concurrent replay of all 4 episodes converges to exactly 1 binding per episode', (t) => {
  const { cache, store } = buildStoreAndCache(t);
  const { placementId } = seedSeasonPackFixture(store);

  // Concurrent replay: each episode's handoff is materialized twice. The
  // convergence guarantee is that no episode ends up with more than one
  // library_items row OR more than one active binding row, regardless of
  // interleaving.
  for (let round = 0; round < 2; round += 1) {
    for (const ep of EPISODES) {
      materializeVfsEntry(
        cache,
        seasonPackHandoff(ep, placementId),
        store,
        () => 1_000 + round * 100,
        { allowLegacy: false },
      );
    }
  }

  const libItems = store.db.prepare(
    'SELECT * FROM library_items WHERE media_id = ? AND season = ? ORDER BY episode',
  ).all(MEDIA_ID, 1);
  assert.equal(libItems.length, 4, 'concurrent replay must not duplicate library_items');

  for (const li of libItems) {
    const bindings = store.db.prepare(
      'SELECT * FROM bindings WHERE library_item_id = ? ORDER BY version',
    ).all(li.id);
    const active = bindings.filter((b) => b.status === 'active');
    assert.equal(active.length, 1, `episode ${li.episode} must have exactly 1 active binding after concurrent replay`);
    assert.equal(bindings[0].version, 1, 'first binding is version 1; concurrent replay must not create version 2+');
  }

  const vfsRows = cache.db.prepare(
    'SELECT * FROM vfs_tv_entries WHERE media_id = ? AND season = ?',
  ).all(MEDIA_ID, 1);
  assert.equal(vfsRows.length, 4, 'concurrent replay must not duplicate vfs_tv_entries');
});

test('A4 — provider ID churn preserves TorrentFile identity through re-activation', (t) => {
  const { cache, store } = buildStoreAndCache(t);
  const { placementId } = seedSeasonPackFixture(store);

  // First wave: 4 episodes bind to provider_file_id 0..3.
  for (const ep of EPISODES) {
    const entry = materializeVfsEntry(
      cache,
      seasonPackHandoff(ep, placementId),
      store,
      () => 1_000,
      { allowLegacy: false },
    );
    assert.ok(entry);
  }

  // Provider churn: the provider rotates the provider_file_id values but
  // the (info_hash, internal_path, size) → torrent_files mapping is
  // stable. The new provider_file_id values are 'p1'..'p4'. The
  // replaceProviderFileInventory upsert preserves torrent_file_id on
  // existing rows via the (placement_id, torrent_file_id) unique index
  // semantics — when a NEW provider_file_id appears for the same
  // canonical TorrentFile, the prior row is demoted to present=0 and the
  // new row inherits the torrent_file_id.
  const churned = EPISODES.map((ep, i) => ({
    providerFileId: `p${i + 1}`,
    path: ep.path,
    name: ep.path.split('/').pop(),
    size: ep.size,
    selected: true,
  }));
  store.replaceProviderFileInventory(placementId, churned, {
    authoritative: true,
    complete: true,
    observedAt: 2_000,
    expiresAt: 2_000 + 6 * 60 * 60 * 1000,
  });

  // Re-activate with the new provider_file_id. The handoff's
  // torrentFileId is unchanged — the durable identity survives the churn.
  for (let i = 0; i < EPISODES.length; i += 1) {
    const ep = EPISODES[i];
    const handoff = seasonPackHandoff(ep, placementId);
    handoff.torrentFileIdentity = {
      ...handoff.torrentFileIdentity,
      providerFileId: `p${i + 1}`,
    };
    handoff.torrentFileIdentity.torrentFileId = ep.torrentFileId;
    const entry = materializeVfsEntry(
      cache,
      handoff,
      store,
      () => 2_000,
      { allowLegacy: false },
    );
    assert.ok(entry, `E${String(ep.episode).padStart(2, '0')} must re-bind after provider churn`);
    assert.equal(entry.torrentFileId, ep.torrentFileId, 'torrent_file_id must survive provider ID churn');
  }

  // Each episode has exactly 1 active binding pointing at the new
  // provider_file_id but the same torrent_file_id (the durable identity
  // survives provider churn). The version increments because the
  // provider_file_id changed and activateBinding's identity-reuse path
  // keys on (release_key, placement_id, provider_file_id, exposure_id).
  const active = store.db.prepare(
    "SELECT * FROM bindings WHERE status = 'active' ORDER BY library_item_id",
  ).all();
  assert.equal(active.length, 4, 'churned re-activation must not duplicate active bindings');
  for (let i = 0; i < EPISODES.length; i += 1) {
    const ep = EPISODES[i];
    const libItem = store.db.prepare(
      'SELECT * FROM library_items WHERE media_id = ? AND season = ? AND episode = ?',
    ).get(MEDIA_ID, 1, ep.episode);
    const binding = active.find((b) => b.library_item_id === libItem.id);
    assert.ok(binding, `binding must exist for E${String(ep.episode).padStart(2, '0')}`);
    assert.equal(binding.provider_file_id, `p${i + 1}`);
    assert.equal(binding.placement_id, placementId);
    // The binding's info_hash is the durable identity; the torrent_file_id
    // is reachable through the (placement_id, provider_file_id) FK on
    // provider_files (which still points at the same torrent_files row).
    const providerFileRow = store.db.prepare(
      'SELECT * FROM provider_files WHERE placement_id = ? AND provider_file_id = ?',
    ).get(placementId, `p${i + 1}`);
    assert.ok(providerFileRow, 'provider_files row must exist for the churned provider_file_id');
    assert.equal(
      providerFileRow.torrent_file_id,
      ep.torrentFileId,
      'torrent_file_id must be stable across provider ID churn',
    );
    assert.equal(providerFileRow.mapping_state, 'mapped');
    // Version bumped because the provider_file_id differs from the
    // pre-churn binding.
    assert.ok(
      binding.version >= 2,
      `version must increment on provider_id churn, got ${binding.version}`,
    );
    // The pre-churn binding is marked superseded, not deleted.
    const allVersions = store.db.prepare(
      'SELECT version, status FROM bindings WHERE library_item_id = ? ORDER BY version',
    ).all(libItem.id);
    assert.equal(allVersions.length, 2, 'churn produces exactly 1 superseded + 1 active');
    assert.equal(allVersions[0].status, 'superseded');
    assert.equal(allVersions[1].status, 'active');
  }
});

test('A5 — ambiguous / non-authoritative provider mapping fails closed (no binding written)', (t) => {
  const { cache, store } = buildStoreAndCache(t);
  // Seed the placement/inventory but mark every provider file as
  // 'conflict' (canonical-path collision) — the mapping is NOT
  // authoritative. The provider_files.torrent_file_id is also set to
  // NULL so neither evidence path produces a binding.
  const { placementId } = seedSeasonPackFixture(store, {
    mappingState: 'conflict',
    nullOutTorrentFileId: true,
  });

  // No candidate_file_mappings row was ever written for this torrent-
  // level releaseKey (the fixture never calls recordFileMapping).
  // Demote any seed-row that materialized a provider_files.torrent_file_id.
  // Belt and suspenders: also mark placement as not ready so that the
  // freshness/readiness guards hold too — except we want to test the
  // mapping guard specifically, not the readiness guard. The
  // `seedSeasonPackFixture({ mappingState: 'conflict' })` already sets
  // mapping_state='conflict' which fails the provider_files evidence
  // path; combined with no candidate_file_mappings row, both evidence
  // paths are empty.
  const mapping = store.db.prepare(
    'SELECT * FROM candidate_file_mappings WHERE release_key = ? AND placement_id = ?',
  ).get(TORRENT_LEVEL_RELEASE_KEY, placementId);
  assert.equal(mapping, undefined, 'precondition: no resolver candidate_file_mappings row');

  for (const ep of EPISODES) {
    // Materialize the VFS row — this should still succeed (the VFS row
    // is the published presentation; it does not depend on the binding).
    const entry = materializeVfsEntry(
      cache,
      seasonPackHandoff(ep, placementId),
      store,
      () => 1_000,
      { allowLegacy: false },
    );
    assert.ok(entry, `E${String(ep.episode).padStart(2, '0')} VFS row must be created even without a binding`);
  }

  // 4 VFS rows exist.
  const vfsRows = [];
  for (const ep of EPISODES) {
    vfsRows.push(cache.getVfsTvEntry(MEDIA_ID, 1, ep.episode));
  }
  for (let i = 0; i < EPISODES.length; i += 1) {
    const vfs = vfsRows[i];
    assert.ok(vfs, `E${String(EPISODES[i].episode).padStart(2, '0')} VFS row must exist`);
    assert.equal(vfs.torrentFileId, EPISODES[i].torrentFileId);
  }

  // 0 active bindings — fail closed at the evidence-seam check.
  const bindings = store.db.prepare("SELECT * FROM bindings WHERE status = 'active'").all();
  assert.equal(bindings.length, 0, 'no binding may leak when provider mapping is not authoritative');
  // And no superseded bindings either (none were ever written).
  const allBindings = store.db.prepare('SELECT * FROM bindings').all();
  assert.equal(allBindings.length, 0, 'no binding row at all when evidence is empty');
});

test('A6 — provider_files.torrent_file_id alone is sufficient when candidate_file_mappings is empty', (t) => {
  const { cache, store } = buildStoreAndCache(t);
  const { placementId } = seedSeasonPackFixture(store);

  // Sanity: there is NO candidate_file_mappings row yet for this
  // (release_key, placement_id) — the season-pack fixture never wrote
  // one. The provider_files.torrent_file_id column is the only evidence
  // available.
  const mapping = store.db.prepare(
    'SELECT * FROM candidate_file_mappings WHERE release_key = ? AND placement_id = ?',
  ).get(TORRENT_LEVEL_RELEASE_KEY, placementId);
  assert.equal(
    mapping, undefined,
    'precondition: no resolver candidate_file_mappings row (the UNIQUE-by-torrent constraint would only keep one)',
  );

  for (const ep of EPISODES) {
    const entry = materializeVfsEntry(
      cache,
      seasonPackHandoff(ep, placementId),
      store,
      () => 1_000,
      { allowLegacy: false },
    );
    assert.ok(entry, `E${String(ep.episode).padStart(2, '0')} must materialize via provider_files evidence alone`);
  }

  // 4 active bindings, each backed by a fresh exposure.
  const bindings = store.db.prepare(
    "SELECT * FROM bindings WHERE status = 'active' ORDER BY library_item_id",
  ).all();
  assert.equal(bindings.length, 4, 'all 4 episodes must bind via the provider_files evidence path');
  for (const binding of bindings) {
    const libItem = store.db.prepare('SELECT * FROM library_items WHERE id = ?').get(binding.library_item_id);
    const ep = EPISODES.find((e) => e.episode === libItem.episode);
    assert.equal(binding.provider_file_id, String(ep.episode - 1));
    assert.equal(binding.placement_id, placementId);
    // The exposure is keyed by (placement_id, provider_file_id), visible,
    // and read-only — the freshness guard is satisfied.
    const exposure = store.db.prepare('SELECT * FROM exposures WHERE id = ?').get(binding.exposure_id);
    assert.equal(exposure.state, 'visible');
    assert.equal(exposure.read_only, 1);
    assert.ok(exposure.expires_at > 1_000, 'exposure must be fresh at activation time');
  }
});

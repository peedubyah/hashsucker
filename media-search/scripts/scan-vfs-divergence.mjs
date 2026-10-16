/**
 * Global scan for the VFS/Binding/handoff divergence invariant.
 *
 * Canonical authority is the active Binding (per library item): its
 * (release_key, info_hash, torrent_file_id) is what the durable truth says is
 * published. A VFS projection row that does not name the Binding's
 * (release_key, torrent_file_id), or a VFS row whose handoff is missing, is a
 * divergence. The scan reports every class separately so the blast radius is
 * measured rather than guessed.
 *
 * Usage: node scripts/scan-vfs-divergence.mjs [--verbose]
 */

import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

const verbose = process.argv.includes('--verbose');
const cp = createControlPlaneStore({ dbPath: process.env.CONTROL_PLANE_DB });
const dc = createDiscoveryCache({ dbPath: process.env.DISCOVERY_DB });

const report = {
  vfs_row_mismatch: [],
  vfs_row_missing_handoff: [],
  binding_missing_for_vfs: [],
  binding_tf_mismatch: [],
  handoff_stale_release: [],
  tv_vfs_row_mismatch: [],
  tv_vfs_row_missing: [],
};

// ── Movies ───────────────────────────────────────────────────────────────
const movieRows = dc.db.prepare('SELECT media_id, release_key, torrent_file_id, size, updated_at FROM vfs_movie_entries').all();
for (const row of movieRows) {
  const item = cp.db.prepare(`
    SELECT li.id FROM library_items li
    WHERE li.media_id = ? AND (li.media_type = 'movie')
  `).get(row.media_id);
  const binding = item
    ? cp.db.prepare(`
      SELECT release_key, info_hash, torrent_file_id, provider_file_id, status
      FROM bindings WHERE library_item_id = ? AND status = 'active'
    `).get(item.id)
    : null;
  if (!binding) {
    report.binding_missing_for_vfs.push({ kind: 'movie', ...row });
    continue;
  }
  if (binding.release_key !== row.release_key || binding.torrent_file_id !== row.torrent_file_id) {
    report.vfs_row_mismatch.push({
      kind: 'movie', mediaId: row.media_id,
      vfsRelease: row.release_key, bindingRelease: binding.release_key,
      vfsTf: row.torrent_file_id, bindingTf: binding.torrent_file_id,
      updatedAt: row.updated_at,
    });
  }
  const handoff = dc.db.prepare(`
    SELECT release_key, torrent_file_id, provider_state, selected_at
    FROM playback_handoffs WHERE media_id = ? AND release_key = ?
  `).get(row.media_id, binding.release_key);
  if (!handoff) {
    const any = dc.db.prepare(`
      SELECT release_key, torrent_file_id, provider_state, selected_at
      FROM playback_handoffs WHERE media_id = ?
    `).all(row.media_id);
    report.vfs_row_missing_handoff.push({
      kind: 'movie', mediaId: row.media_id,
      bindingRelease: binding.release_key,
      existingHandoffs: any.map((h) => h.release_key),
    });
  }
}

// ── TV ───────────────────────────────────────────────────────────────────
const tvRows = dc.db.prepare('SELECT media_id, season, episode, release_key, torrent_file_id, updated_at FROM vfs_tv_entries').all();
for (const row of tvRows) {
  const item = cp.db.prepare(`
    SELECT li.id FROM library_items li
    WHERE li.media_id = ? AND li.season = ? AND li.episode = ?
  `).get(row.media_id, row.season, row.episode);
  const binding = item
    ? cp.db.prepare(`
      SELECT release_key, info_hash, torrent_file_id, provider_file_id, status
      FROM bindings WHERE library_item_id = ? AND status = 'active'
    `).get(item.id)
    : null;
  if (!binding) {
    report.binding_missing_for_vfs.push({ kind: 'episode', ...row });
    continue;
  }
  if (binding.release_key !== row.release_key || binding.torrent_file_id !== row.torrent_file_id) {
    report.tv_vfs_row_mismatch.push({
      kind: 'episode', mediaId: row.media_id, season: row.season, episode: row.episode,
      vfsRelease: row.release_key, bindingRelease: binding.release_key,
      vfsTf: row.torrent_file_id, bindingTf: binding.torrent_file_id,
      updatedAt: row.updated_at,
    });
  }
  const handoff = dc.db.prepare(`
    SELECT release_key FROM playback_handoffs
    WHERE media_id = ? AND season = ? AND episode = ? AND release_key = ?
  `).get(row.media_id, row.season, row.episode, binding.release_key);
  if (!handoff) {
    report.tv_vfs_row_missing.push({
      kind: 'episode', mediaId: row.media_id, season: row.season, episode: row.episode,
      bindingRelease: binding.release_key,
    });
  }
}

// ── Handoffs whose release no longer matches the Binding (stale selection) ─
const handoffs = dc.db.prepare('SELECT media_id, media_type, season, episode, release_key, selected_at FROM playback_handoffs').all();
for (const h of handoffs) {
  const item = h.season != null || h.episode != null
    ? cp.db.prepare(`
      SELECT li.id FROM library_items li
      WHERE li.media_id = ? AND li.season = ? AND li.episode = ?
    `).get(h.media_id, h.season, h.episode)
    : cp.db.prepare(`
      SELECT li.id FROM library_items li
      WHERE li.media_id = ? AND (li.season IS NULL AND li.episode IS NULL)
    `).get(h.media_id);
  const binding = item
    ? cp.db.prepare('SELECT release_key FROM bindings WHERE library_item_id = ? AND status = ?').get(item.id, 'active')
    : null;
  if (binding && binding.release_key !== h.release_key) {
    report.handoff_stale_release.push({
      mediaId: h.media_id, season: h.season, episode: h.episode,
      handoffRelease: h.release_key, bindingRelease: binding.release_key,
      handoffSelectedAt: h.selected_at,
    });
  }
}

const summary = Object.fromEntries(
  Object.entries(report).map(([k, v]) => [k, v.length]),
);
console.log(JSON.stringify(summary, null, 1));
if (verbose) {
  for (const [k, v] of Object.entries(report)) {
    if (v.length > 0) {
      console.log(`\n### ${k} (${v.length})`);
      for (const item of v.slice(0, 12)) console.log(' ', JSON.stringify(item));
    }
  }
}
cp.close();
dc.close();

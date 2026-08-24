/**
 * Request lifecycle health — cross-reference queue files against control-plane DB.
 * Identifies orphaned, stuck, and invalid requests.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const STUCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Check request lifecycle health across queue and control-plane.
 * @param {Object} options
 * @param {string} options.requestsRoot - Path to requests directory
 * @param {Object} [options.controlPlaneStore] - Control-plane store instance (optional)
 * @param {() => number} [options.now] - Clock function
 * @returns {Promise<{ orphaned: Array, stuck: Array, invalid: Array, healthyCount: number }>}
 */
export async function checkRequestLifecycleHealth({ requestsRoot, controlPlaneStore, now = Date.now } = {}) {
  const orphaned = [];
  const stuck = [];
  const invalid = [];
  let healthyCount = 0;

  const dirs = ['incoming', 'processing', 'done', 'failed'];
  const allRequests = [];

  // 1. Scan all queue files
  for (const dir of dirs) {
    const dirPath = path.join(requestsRoot, dir);
    let entries;
    try {
      entries = await fs.readdir(dirPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const requestId = entry.slice(0, -5);
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) continue;

      try {
        const body = await fs.readFile(path.join(dirPath, entry), 'utf8');
        const request = JSON.parse(body);
        allRequests.push({ requestId, status: dir, request });
      } catch {
        invalid.push({
          requestId,
          state: dir,
          reason: 'unreadable queue file',
          action: 'delete or repair file',
        });
      }
    }
  }

  // 2. Check each request
  for (const { requestId, status, request } of allRequests) {
    const mediaId = request?.mediaId || request?.media_id;
    const infoHash = request?.release?.infoHash || request?.info_hash;
    const createdAt = request?.createdAt || request?.created_at;
    const updatedAt = request?.updatedAt || request?.updated_at;

    // Check for stuck processing
    if (status === 'processing') {
      const lastUpdate = updatedAt ? new Date(updatedAt).getTime() : createdAt ? new Date(createdAt).getTime() : null;
      if (lastUpdate && now() - lastUpdate > STUCK_TIMEOUT_MS) {
        stuck.push({
          requestId,
          state: 'processing',
          reason: `no update for ${Math.round((now() - lastUpdate) / 60000)}min`,
          action: 'retry or reset',
        });
        continue;
      }
    }

    // Cross-reference with control-plane DB
    if (controlPlaneStore && typeof mediaId === 'string' && mediaId.length > 0) {
      let items = [];
      try {
        items = controlPlaneStore.listLibraryItems({ mediaId, limit: 10 });
      } catch {
        items = [];
      }

      if (items.length === 0) {
        orphaned.push({
          requestId,
          state: status,
          reason: `no library item for mediaId=${mediaId}`,
          action: 'reconcile or purge',
        });
        continue;
      }

      // Check for terminal requests with leftover artifacts
      if (status === 'done' || status === 'failed') {
        const item = items[0];
        const lifecycle = controlPlaneStore.getLifecycle(item.id);
        const hasFailedMilestone = lifecycle.events?.some(e => e.status === 'failed');
        if (status === 'done' && hasFailedMilestone) {
          invalid.push({
            requestId,
            state: status,
            reason: 'terminal success but lifecycle has failed milestones',
            action: 'verify STRM and provider placement',
          });
          continue;
        }
      }

      // Check for infoHash without provider placement
      if (infoHash && status === 'done') {
        let placements = [];
        try {
          placements = controlPlaneStore.db.prepare(
            'SELECT * FROM provider_placements WHERE info_hash = ? AND state = ?',
          ).all(infoHash, 'ready');
        } catch {
          placements = [];
        }
        if (placements.length === 0) {
          invalid.push({
            requestId,
            state: status,
            reason: `no ready provider placement for infoHash=${infoHash}`,
            action: 'verify TorBox torrent status',
          });
          continue;
        }
      }
    }

    healthyCount++;
  }

  // 3. Check for DB records with no queue file (reverse lookup)
  if (controlPlaneStore) {
    const queueRequestIds = new Set(allRequests.map(r => r.requestId));

    // Query lifecycle events table directly to find items with failed events
    let failedItems = [];
    try {
      failedItems = controlPlaneStore.db.prepare(`
        SELECT DISTINCT le.library_item_id
        FROM lifecycle_events le
        WHERE le.status = 'failed'
      `).all();
    } catch {
      // Table may not exist
    }

    for (const { library_item_id: itemId } of failedItems) {
      const lifecycle = controlPlaneStore.getLifecycle(itemId);
      const requestEvent = lifecycle.events?.find(e => e.correlationId && queueRequestIds.has(e.correlationId));
      if (!requestEvent) {
        invalid.push({
          requestId: `db:${itemId}`,
          state: 'database-only',
          reason: `library item ${itemId} has failed lifecycle but no queue file`,
          action: 'reconcile or purge database record',
        });
      }
    }
  }

  return { orphaned, stuck, invalid, healthyCount };
}

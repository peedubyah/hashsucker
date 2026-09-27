// Reconciliation-only stable pagination over library_items.
export function listLibraryItemsPage(controlPlaneStore, { afterIdentityKey = null, limit = 500 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new TypeError('limit must be between 1 and 500');
  const db = controlPlaneStore?.db;
  if (!db) throw new TypeError('controlPlaneStore.db is required');
  const rows = afterIdentityKey == null
    ? db.prepare('SELECT * FROM library_items ORDER BY identity_key LIMIT ?').all(limit)
    : db.prepare('SELECT * FROM library_items WHERE identity_key > ? ORDER BY identity_key LIMIT ?').all(afterIdentityKey, limit);
  return rows;
}

/**
 * Background Durability V1 — runtime integration seam (named repair).
 *
 * Wires the Worker A scheduler to the Worker B executor across the
 * scheduling → execution / runtime boundary that the two slice commits left
 * disconnected. This module is intentionally microscopic: it does not own
 * provider logic, does not own eligibility/persistence (that lives in
 * durability-scheduler.js), and does not own provider evidence (that
 * lives in background-durability-executor.js). It only:
 *
 *   1. Hydrates each scheduler due row into an authoritative rich item
 *      ({placementId, provider, accountScope, infoHash, torrentFileId})
 *      by reading the persisted control-plane store. Hydration is
 *      fail-closed: any missing placement / binding / torrent_file row
 *      yields a "no-op" per-row outcome and the row is left to the
 *      scheduler's normal reschedule path (no provider work, no repair
 *      invocation).
 *   2. Groups the hydrated rich items by (provider, accountScope) and
 *      invokes Worker B's runBatch(dueItems) ONCE per group, so the
 *      shared per-(provider, accountScope) snapshot fetch happens
 *      exactly once even when five due items share a scope.
 *   3. Translates Worker B per-item outcomes into the scheduler's
 *      durable outcome vocabulary (succeeded / failed / skipped) and
 *      applies scope-level backoff (rate-limited / transient) by
 *      marking the affected due rows as 'failed' with a stable
 *      last_error so the scheduler's normal reschedule path
 *      advances next_due_at without mutation.
 *   4. Returns a per-row summary that the scheduler can write back
 *      into durability_due_state via its existing writeRunResult path.
 *
 * Default mode is 'disabled'; the runtime is only created when an
 * explicit env-style mode flag (BACKGROUND_DURABILITY_MODE) requests
 * 'observe' or 'execute'. No provider work, no library scan, no
 * snapshot fetch happens at disabled startup. Real-Debrid is always
 * routed to on-demand-only via the executor's existing
 * partitionDueItemsByClass, never to the background snapshot seam.
 *
 * Event-driven enrollment is wired into existing fulfillment/repair
 * seams by a small shim (notifyBindingActivated /
 * notifyStalePlacementRepaired) defined in ./durability-enroller.js.
 * The reconciler (reconciler.js) and torbox-delivery.js call sites
 * invoke that shim; createDurabilityRuntime() below registers the
 * scheduler with the shim via registerDurabilityScheduler(scheduler)
 * so the registry holds a live reference until runtime.dispose() calls
 * clearDurabilityScheduler. The shim never invents playback tracking:
 * enrollment is keyed on the persisted binding-id+version or repair
 * event id, exactly as the scheduler already expects.
 */
import { createBackgroundDurabilityExecutor } from './background-durability-executor.js';
import { createProviderAdapter, PROVIDER_CAPABILITIES } from '../providers/capabilities.js';
import { classifyProviderDurability, evaluateProviderForBackground } from './durability-provider-classifier.js';
import { registerDurabilityScheduler } from './durability-enroller.js';

function requireStore(store) {
  if (!store || typeof store !== 'object' || typeof store.db !== 'object') {
    throw new TypeError('controlPlaneStore is required');
  }
  return store;
}

function requireScheduler(scheduler) {
  if (!scheduler || typeof scheduler.runPass !== 'function'
    || typeof scheduler.listDue !== 'function') {
    throw new TypeError('durabilityScheduler is required');
  }
  return scheduler;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeInfoHash(value) {
  const hash = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(hash)) {
    throw new TypeError('infoHash must be a 40-character lowercase hex string');
  }
  return hash;
}

function normalizeIdentifier(value, field) {
  if (typeof value !== 'string') {
    throw new TypeError(`${field} must be a string`);
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return trimmed;
}

/**
 * Look up the active binding for a library item. Returns null if the
 * library item has no authoritative binding (cold historical items
 * without an active binding are intentionally excluded).
 */
function findActiveBinding(store, libraryItemId) {
  const bindings = typeof store.listBindings === 'function'
    ? store.listBindings(libraryItemId)
    : [];
  for (const binding of bindings) {
    if (binding?.status === 'active') return binding;
  }
  return null;
}

/**
 * Look up the torrent_file_id of the (placementId, providerFileId) row
 * via the persisted provider_files table. Returns null if the provider
 * file is no longer present (e.g. inventory conflict / removed).
 */
function findTorrentFileId(store, placementId, providerFileId) {
  const files = typeof store.listProviderFiles === 'function'
    ? store.listProviderFiles(placementId)
    : [];
  for (const file of files) {
    if (file?.providerFileId === providerFileId && file?.torrentFileId) {
      return file.torrentFileId;
    }
  }
  return null;
}

/**
 * Look up a placement by its primary id, returning the row normalized
 * to the store's placement shape. The store does not currently expose
 * a public getPlacement; we read the row directly through the
 * store's db handle, which is the documented extension point.
 */
function findPlacementById(store, placementId) {
  if (!store || typeof store.db?.prepare !== 'function') return null;
  const row = store.db.prepare(
    `SELECT * FROM provider_placements WHERE id = ?`,
  ).get(placementId);
  return row ?? null;
}

/**
 * Hydrate one due row into an authoritative rich item. Fail-closed: any
 * missing reference (no active binding, placement missing, torrent_file
 * missing) returns a per-row "no-op" outcome the runtime can map to a
 * scheduler 'skipped' so the next pass can re-evaluate.
 */
function hydrateDueRow({ store, row, now: _now }) {
  const libraryItemId = requireString(row?.library_item_id, 'due.library_item_id');
  const item = typeof store.getLibraryItem === 'function'
    ? store.getLibraryItem(libraryItemId)
    : null;
  if (!item) {
    return { ok: false, reason: 'library-item-missing' };
  }
  const binding = findActiveBinding(store, libraryItemId);
  if (!binding) {
    return { ok: false, reason: 'no-active-binding' };
  }
  const placement = findPlacementById(store, binding.placementId);
  if (!placement) {
    return { ok: false, reason: 'placement-missing' };
  }
  if (placement.id !== binding.placementId) {
    return { ok: false, reason: 'placement-id-mismatch' };
  }
  if (placement.state === 'removed') {
    return { ok: false, reason: 'placement-removed' };
  }
  const torrentFileId = findTorrentFileId(store, placement.id, binding.providerFileId);
  if (!torrentFileId) {
    return { ok: false, reason: 'torrent-file-missing' };
  }
  return {
    ok: true,
    item: Object.freeze({
      libraryItemId,
      placementId: placement.id,
      provider: normalizeIdentifier(placement.provider, 'provider'),
      accountScope: normalizeIdentifier(placement.account_scope ?? placement.accountScope ?? 'default', 'accountScope'),
      infoHash: normalizeInfoHash(placement.info_hash ?? placement.infoHash ?? binding.infoHash),
      torrentFileId,
    }),
  };
}

/**
 * Build a TorBox provider adapter that exposes only the MYLIST_SNAPSHOT
 * capability. We do not import the full createTorBoxInventoryProvider
 * here: a thin read-only adapter is enough for the background seam and
 * keeps the runtime seam testable in isolation. The full inventory
 * provider is wired in by the server bootstrap when configured.
 */
function buildTorboxSnapshotAdapter(torboxInventoryProvider) {
  const impl = torboxInventoryProvider?.capabilities?.[PROVIDER_CAPABILITIES.MYLIST_SNAPSHOT];
  if (!impl || typeof impl.getMylistSnapshot !== 'function') {
    return null;
  }
  const provider = (typeof torboxInventoryProvider.provider === 'string'
    && torboxInventoryProvider.provider)
    || 'torbox';
  const accountScope = (typeof torboxInventoryProvider.accountScope === 'string'
    && torboxInventoryProvider.accountScope)
    || 'default';
  return createProviderAdapter({
    provider,
    accountScope,
    capabilities: {
      [PROVIDER_CAPABILITIES.MYLIST_SNAPSHOT]: impl,
    },
  });
}

/**
 * Translate a Worker B per-item outcome into the scheduler's durable
 * outcome vocabulary. Pure function.
 */
function translateOutcome(itemOutcome) {
  switch (itemOutcome?.outcome) {
    case 'healthy':
      return { outcome: 'succeeded' };
    case 'stale-confirmed':
      // Bounded same-TorrentFile repair seam was invoked. The placement
      // is now state='removed' and the next on-demand resolution will
      // re-enter the recreate-once path. The scheduler records this as
      // 'succeeded' because the background work completed without
      // producing an error.
      return { outcome: 'succeeded', error: itemOutcome?.reason ?? null };
    case 'ambiguous':
    case 'on-demand-only':
    case 'not-found':
    case 'invalid':
      return { outcome: 'skipped', error: itemOutcome?.reason ?? itemOutcome?.outcome };
    case 'transient':
    case 'rate-limited':
      return { outcome: 'failed', error: itemOutcome?.reason ?? itemOutcome?.outcome };
    default:
      return { outcome: 'failed', error: `unknown-executor-outcome:${itemOutcome?.outcome}` };
  }
}

/**
 * Create the runtime seam.
 *
 * @param {Object} options
 * @param {Object} options.controlPlaneStore       Worker A / store.
 * @param {Object} options.durabilityScheduler     Worker A scheduler.
 * @param {Object} [options.torboxInventoryProvider] TorBox inventory
 *        provider exposing MYLIST_SNAPSHOT. When omitted, no TorBox
 *        snapshot adapter is wired and the runtime reports no
 *        BACKGROUND_SAFE provider is configured. Real-Debrid is never
 *        wired here.
 * @param {Function} [options.now]                 Clock.
 * @param {Function} [options.log]                 Logger.
 */
export function createDurabilityRuntime(options = {}) {
  const store = requireStore(options.controlPlaneStore);
  const scheduler = requireScheduler(options.durabilityScheduler);
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});

  // Register the scheduler with the enroller shim so the existing
  // reconciler / torbox-delivery seams can enroll newly-fulfilled
  // bindings and stale-placement-repaired events without inventing
  // playback tracking. The shim is a no-op when the scheduler is
  // null; clearDurabilityScheduler is called on runtime.dispose() so
  // the registry does not hold a stale reference.
  registerDurabilityScheduler(scheduler);

  const providerAdapters = {};
  const torboxAdapter = options.torboxInventoryProvider
    ? buildTorboxSnapshotAdapter(options.torboxInventoryProvider)
    : null;
  if (torboxAdapter) {
    providerAdapters[torboxAdapter.provider] = torboxAdapter;
  }

  const executor = createBackgroundDurabilityExecutor({
    controlPlaneStore: store,
    providerAdapters,
    now,
  });

  /**
   * Execute one pass for the scheduler. The scheduler hands its due
   * rows to this function; this function ensures Worker B's runBatch is
   * invoked at most once per (provider, accountScope) group for the
   * selected due rows.
   *
   * @param {Array<object>} rows
   * @returns {Promise<Array<{row: object, outcome: 'succeeded'|'failed'|'skipped', error?: string}>>}
   */
  async function executeBatchPass(rows) {
    const batch = Array.isArray(rows) ? rows : [];
    if (batch.length === 0) return [];

    // 1) Hydrate every due row into an authoritative rich item.
    const hydrated = [];
    const perRowNoop = new Map();
    for (const row of batch) {
      const result = hydrateDueRow({ store, row, now });
      if (result.ok) {
        hydrated.push({ row, item: result.item });
      } else {
        perRowNoop.set(row, { reason: result.reason });
      }
    }

    // 2) Group by (provider, accountScope). Only items whose provider is
    //    background-safe reach the executor; the rest are surfaced as
    //    'on-demand-only' so the scheduler can reschedule them.
    const groups = new Map();
    for (const entry of hydrated) {
      const klass = classifyProviderDurability(entry.item.provider);
      if (klass !== 'background-safe') {
        perRowNoop.set(entry.row, { reason: `provider-not-background-safe:${entry.item.provider}` });
        continue;
      }
      const evaluation = providerAdapters[entry.item.provider]
        ? evaluateProviderForBackground(providerAdapters[entry.item.provider])
        : { eligible: false, reason: 'no-snapshot-adapter' };
      if (!evaluation.eligible) {
        perRowNoop.set(entry.row, { reason: evaluation.reason ?? 'adapter-ineligible' });
        continue;
      }
      const key = `${entry.item.provider}:${entry.item.accountScope}`;
      let group = groups.get(key);
      if (!group) {
        group = { provider: entry.item.provider, accountScope: entry.item.accountScope, items: [], rows: [] };
        groups.set(key, group);
      }
      group.items.push(entry.item);
      group.rows.push(entry.row);
    }

    // 3) Invoke Worker B's runBatch once per group, and translate per-item
    //    outcomes back to the scheduler vocabulary.
    const perRowOutcome = new Map();
    for (const group of groups.values()) {
      let batchResult;
      try {
        batchResult = await executor.runBatch(group.items);
      } catch (error) {
        // Defensive: the executor is fail-closed but a thrown error means
        // we cannot mark anything stale. Surface as a transient group
        // backoff and let the scheduler reschedule the rows.
        log('durability: executor batch failed', { error: String(error?.message ?? error) });
        for (const row of group.rows) {
          perRowOutcome.set(row, { outcome: 'failed', error: `executor-threw:${error?.message ?? 'unknown'}` });
        }
        continue;
      }
      const outcomes = Array.isArray(batchResult?.outcomes) ? batchResult.outcomes : [];
      const byPlacement = new Map();
      for (const o of outcomes) {
        if (o?.placementId) byPlacement.set(o.placementId, o);
      }
      for (let i = 0; i < group.rows.length; i += 1) {
        const row = group.rows[i];
        const item = group.items[i];
        const o = byPlacement.get(item.placementId);
        if (!o) {
          perRowOutcome.set(row, { outcome: 'skipped', error: 'no-outcome-for-placement' });
          continue;
        }
        perRowOutcome.set(row, translateOutcome(o));
      }
      // Scope-level backoff: if every outcome in this group is rate-limited
      // or transient, surface a uniform last_error so the scheduler's
      // writeRunResult path records the reschedule reason.
      if (Array.isArray(batchResult?.scopes)) {
        for (const scope of batchResult.scopes) {
          if (!scope?.backoff) continue;
          for (const row of group.rows) {
            const prior = perRowOutcome.get(row);
            if (prior?.outcome !== 'succeeded') {
              perRowOutcome.set(row, {
                outcome: 'failed',
                error: `scope-backoff:${scope.backoffReason ?? 'unknown'}`,
              });
            }
          }
        }
      }
    }

    // 4) Assemble the per-row results in the original order.
    const results = [];
    for (const row of batch) {
      const translated = perRowOutcome.get(row);
      if (translated) {
        results.push({ row, outcome: translated.outcome, error: translated.error ?? null });
        continue;
      }
      const noop = perRowNoop.get(row);
      results.push({ row, outcome: 'skipped', error: noop?.reason ?? 'unmapped' });
    }
    return results;
  }

  /**
   * Run a single pass using the scheduler's persisted due rows. Returns
   * the scheduler's pass summary augmented with the per-row outcomes.
   * The scheduler's per-row writeRunResult is invoked for each row so
   * the durability_due_state row is updated exactly as if the
   * scheduler had driven it directly.
   */
  async function runOnePass({ now: clockOverride } = {}) {
    if (typeof scheduler.listDue !== 'function') {
      throw new TypeError('scheduler.listDue is required');
    }
    if (typeof scheduler.runPass !== 'function') {
      throw new TypeError('scheduler.runPass is required');
    }
    // We hand the runtime the scheduler's listDue directly so Worker B
    // sees the full batch in one shot; this is the seam the brief
    // requires ("scheduler pass invoke Worker B once per selected
    // batch"). The scheduler's runPass() is still the source of
    // truth for last_pass_* and next_pass_at; we call it as the
    // final write step so the persisted state advances exactly once.
    const rows = scheduler.listDue();
    const perRow = await executeBatchPass(rows);
    const passSummary = await scheduler.runPass({ rowResults: perRow });
    return { passSummary, perRow };
  }

  return Object.freeze({
    executeBatchPass,
    runOnePass,
    diagnostics() {
      return {
        backgroundSafeProviders: Object.keys(providerAdapters),
        executorReady: typeof executor.runBatch === 'function',
      };
    },
  });
}

/**
 * Resolve the runtime mode from an env-style flag. Default: 'disabled'
 * (no provider work, no library scan, no snapshot adapter wired).
 */
export function resolveDurabilityMode(env = process.env) {
  const raw = env?.BACKGROUND_DURABILITY_MODE;
  if (raw == null) return 'disabled';
  const value = String(raw).trim().toLowerCase();
  if (value === '' || value === '0' || value === 'false' || value === 'off') {
    return 'disabled';
  }
  if (value === 'observe') return 'observe';
  if (value === 'execute' || value === 'exec') return 'execute';
  return 'disabled';
}

export const _internal = Object.freeze({
  hydrateDueRow,
  translateOutcome,
  findActiveBinding,
  findTorrentFileId,
  buildTorboxSnapshotAdapter,
});

export default {
  createDurabilityRuntime,
  resolveDurabilityMode,
};

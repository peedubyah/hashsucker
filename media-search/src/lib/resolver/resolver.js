/**
 * Resolver projection boundary — Phase 1 (read-only).
 *
 * Turns (info_hash, file_index) into a structured projection:
 *
 *   (info_hash, file_index)
 *     ↓
 *   Bindings
 *     ↓
 *   Exposure
 *     ↓
 *   Mount configuration
 *     ↓
 *   Servable projection
 *
 * The resolver is a READ-ONLY projection layer. It never writes to the
 * control plane, never calls providers, never mutates lifecycle.
 *
 * Phase 1 returns a structured projection only. No byte streaming.
 */

import { createReleaseIdentity } from '../../api/release-contract.js';
import { resolveMountRoot } from './mounts.js';

const BINDING_STATUS_ACTIVE = 'active';
const EXPOSURE_STATE_VISIBLE = 'visible';

export class ResolverError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'ResolverError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Find the active binding for a given content identity.
 * Returns null if no active binding exists.
 */
export function findActiveBinding(store, infoHash, fileIndexKey) {
  const row = store.db.prepare(`
    SELECT * FROM bindings
    WHERE info_hash = ?
      AND file_index_key = ?
      AND status = ?
    LIMIT 1
  `).get(infoHash, fileIndexKey, BINDING_STATUS_ACTIVE);
  return row ? store.db.prepare('SELECT * FROM bindings WHERE id = ?').get(row.id) : null;
}

/**
 * Look up an exposure by its ID.
 * Returns null if not found.
 */
export function findExposure(store, exposureId) {
  const row = store.db.prepare('SELECT * FROM exposures WHERE id = ?').get(exposureId);
  return row ?? null;
}

/**
 * Evaluate whether the projection is servable.
 *
 * A projection is servable when:
 * - binding exists and is active
 * - exposure exists and is visible
 * - mount scope resolves to a configured root
 * - relative_path is not null
 */
export function evaluateReadiness({ binding, exposure, mount }) {
  if (!binding) {
    return { servable: false, reason: 'no-binding' };
  }
  if (binding.status !== BINDING_STATUS_ACTIVE) {
    return { servable: false, reason: `binding-${binding.status}` };
  }
  if (!exposure) {
    return { servable: false, reason: 'no-exposure' };
  }
  if (exposure.state !== EXPOSURE_STATE_VISIBLE) {
    return { servable: false, reason: `exposure-${exposure.state}` };
  }
  if (!mount.configured) {
    return { servable: false, reason: 'mount-not-configured' };
  }
  if (exposure.relative_path == null) {
    return { servable: false, reason: 'relative-path-null' };
  }
  return { servable: true, reason: 'ready' };
}

/**
 * Look up provider file by placement_id and provider_file_id.
 */
function findProviderFile(store, placementId, providerFileId) {
  const row = store.db.prepare(`
    SELECT * FROM provider_files
    WHERE placement_id = ? AND provider_file_id = ? AND present = 1
  `).get(placementId, providerFileId);
  return row ? {
    id: row.id,
    placementId: row.placement_id,
    providerFileId: row.provider_file_id,
    path: row.path,
    name: row.name,
    size: row.size,
    selected: row.selected === 1,
  } : null;
}

/**
 * Build the full resolver projection for a content identity.
 *
 * @param {Object} options
 * @param {Object} options.store - Control-plane store instance
 * @param {string} options.infoHash - 40-char hex info hash
 * @param {number|null} options.fileIndex - File index or null for torrent-level
 * @param {Object} [options.env] - Environment variables (defaults to process.env)
 * @returns {Object} Structured resolver projection
 */
export function resolveProjection({ store, infoHash, fileIndex, env = process.env }) {
  const identity = createReleaseIdentity(infoHash, fileIndex);
  const fileIndexKey = identity.fileIndex ?? -1;

  const binding = findActiveBinding(store, identity.infoHash, fileIndexKey);
  const exposure = binding ? findExposure(store, binding.exposure_id) : null;
  const mount = exposure
    ? resolveMountRoot(exposure.mount_scope, env)
    : resolveMountRoot('default', env);
  const providerFile = binding
    ? findProviderFile(store, binding.placement_id, binding.provider_file_id)
    : null;

  const readiness = evaluateReadiness({ binding, exposure, mount });

  return {
    identity: {
      infoHash: identity.infoHash,
      fileIndex: identity.fileIndex,
      releaseKey: identity.releaseKey,
      fileIndexKey,
    },
    binding: binding ? {
      id: binding.id,
      status: binding.status,
      placementId: binding.placement_id,
      providerFileId: binding.provider_file_id,
      exposureId: binding.exposure_id,
      version: binding.version,
    } : null,
    exposure: exposure ? {
      id: exposure.id,
      transport: exposure.transport,
      exposureKey: exposure.exposure_key,
      relativePath: exposure.relative_path,
      state: exposure.state,
      mountScope: exposure.mount_scope,
      accountScope: exposure.account_scope,
      readOnly: exposure.read_only === 1,
    } : null,
    mount: {
      mountScope: exposure?.mount_scope ?? 'default',
      configured: mount.configured,
      envVar: mount.envVar,
      root: mount.root,
    },
    providerFile,
    readiness,
  };
}

/**
 * Parse and validate identity from URL path parameters.
 * Throws ResolverError with code 'invalid-identity' on bad input.
 */
export function parseIdentityFromParams(infoHashParam, fileIndexParam) {
  if (typeof infoHashParam !== 'string' || !/^[0-9a-f]{40}$/i.test(infoHashParam)) {
    throw new ResolverError(
      'infoHash must be 40 hexadecimal characters',
      'invalid-identity',
      400,
    );
  }
  let fileIndex;
  if (fileIndexParam === 'torrent' || fileIndexParam == null) {
    fileIndex = null;
  } else if (/^(0|[1-9]\d*)$/.test(fileIndexParam)) {
    fileIndex = Number(fileIndexParam);
  } else {
    throw new ResolverError(
      'fileIndex must be torrent or a non-negative integer',
      'invalid-identity',
      400,
    );
  }
  return createReleaseIdentity(infoHashParam, fileIndex);
}

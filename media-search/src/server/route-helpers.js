/**
 * Route helpers: shared request-shape parsing and guards used by the route
 * modules. They validate query/body input and throw typed errors the route
 * maps to HTTP status; no product policy lives here.
 */

import { createReleaseIdentity } from '../api/release-contract.js';

export function requireControlPlaneStore(store) {
  if (!store) throw new Error('Control-plane store is not configured');
}

export function parseBoundedLimit(value) {
  if (value == null || value === '') return 50;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('limit must be between 1 and 100');
  }
  return limit;
}

export function parseOptionalReleaseIdentity(params) {
  const infoHash = params.get('infoHash');
  const fileIndexValue = params.get('fileIndex');
  if (infoHash == null && fileIndexValue == null) return null;
  if (infoHash == null || fileIndexValue == null) {
    throw new Error('infoHash and fileIndex are required together');
  }
  let fileIndex;
  if (fileIndexValue === 'torrent') {
    fileIndex = null;
  } else if (/^(0|[1-9]\d*)$/.test(fileIndexValue)) {
    fileIndex = Number(fileIndexValue);
  } else {
    throw new Error('fileIndex must be torrent or a non-negative integer');
  }
  return createReleaseIdentity(infoHash, fileIndex);
}

export function parseOptionalStage6Scope(params) {
  const fields = ['accountScope', 'zurgInstanceScope', 'mountScope'];
  const values = fields.map((field) => params.get(field));
  if (values.every((value) => value == null)) return null;
  if (values.some((value) => value == null)) {
    throw new Error('accountScope, zurgInstanceScope, and mountScope are required together');
  }
  for (const [index, value] of values.entries()) {
    if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(value)) {
      throw new Error(`${fields[index]} must be a provider-safe identifier`);
    }
  }
  return {
    provider: 'realdebrid',
    accountScope: values[0].toLowerCase(),
    instanceScope: values[1].toLowerCase(),
    mountScope: values[2].toLowerCase(),
  };
}

/**
 * Adapt a `rowToPlaybackHandoff` shape (returned by `getTvPlaybackHandoff`)
 * to the selection shape expected by the rest of the resolver route.
 *
 * The selection shape carries `selectedHash` (not `infoHash`) and adds
 * `status: 'selected'`, `requestId`, `providerState`, etc. — all fields the
 * resolver reads downstream. Mirrors the mapping in `getExistingSelection`.
 */
export function adaptTvHandoffToSelection(handoff) {
  return {
    status: 'selected',
    requestId: handoff.requestId,
    mediaId: handoff.mediaId,
    mediaType: handoff.mediaType,
    season: handoff.season ?? null,
    episode: handoff.episode ?? null,
    releaseKey: handoff.releaseKey,
    selectedHash: handoff.infoHash,
    fileIndex: handoff.fileIndex,
    filename: handoff.filename,
    provider: handoff.provider,
    providerState: handoff.providerState,
    identityTier: handoff.identityTier,
    resolutionState: handoff.resolutionState,
    reason: handoff.selectionReason || 'existing tv handoff',
    selectedAt: handoff.selectedAt,
  };
}


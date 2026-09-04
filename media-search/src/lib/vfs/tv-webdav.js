/**
 * TV Episode WebDAV Catalog
 *
 * Extends the proven movies-only VFS pattern to TV episodes with correct
 * Plex filesystem semantics:
 *
 *   /TV Shows/<Series Name>/Season 01/<Series Name> - S01E01.mkv
 *
 * Identity: mediaId + season + episode backed by durable (infoHash, fileIndex).
 * Reuses movie VFS behavior for provider resolution, ranged reads, and
 * ephemeral provider URL handling.
 */

import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

import { attemptRdResolution, getRdPlaybackUrl } from '../providers/realdebrid/resolve.js';
import { isUrlLive } from '../resolver/liveness.js';
import { materializeVfsEntry } from './materialize.js';
import { providerAccounting } from '../providers/provider-accounting.js';
import {
  validateRangeResponseBody,
  validateRangeResponseHeaders,
  classifyReadFailure,
} from './range-response-validator.js';
import { streamFromDataPlane } from './data-plane-forward.js';
import { REVALIDATION_OUTCOME } from '../resolver/availability-revalidation.js';

const DAV_ROOT = '/vfs';
const CONTENT_TYPE = 'video/x-matroska';
const STALE_PROVIDER_STATUSES = new Set([401, 403, 404, 410]);

class VfsError extends Error {
  constructor(message, status = 502, code = 'VFS_ERROR') {
    super(message);
    this.name = 'VfsError';
    this.status = status;
    this.code = code;
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function encodeDavPath(pathname, collection = false) {
  const encoded = pathname.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return collection && !encoded.endsWith('/') ? `${encoded}/` : encoded;
}

function normalizePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new VfsError('Malformed WebDAV path', 400, 'MALFORMED_PATH');
  }
  if (decoded.length > 1 && decoded.endsWith('/')) return decoded.slice(0, -1);
  return decoded;
}

function httpDate(timestamp) {
  return new Date(timestamp).toUTCString();
}

function isoDate(timestamp) {
  return new Date(timestamp).toISOString();
}

function responseXml(entry, metadata) {
  const collection = entry.type === 'collection';
  const properties = collection
    ? '<d:resourcetype><d:collection/></d:resourcetype>'
    : [
        '<d:resourcetype/>',
        ...(Number.isSafeInteger(metadata.size)
          ? ['<d:getcontentlength>' + metadata.size + '</d:getcontentlength>']
          : []),
        '<d:getcontenttype>' + CONTENT_TYPE + '</d:getcontenttype>',
        '<d:getetag>' + escapeXml(metadata.etag) + '</d:getetag>',
      ].join('');

  return [
    '<d:response>',
    '<d:href>' + escapeXml(encodeDavPath(entry.path, collection)) + '</d:href>',
    '<d:propstat><d:prop>',
    '<d:displayname>' + escapeXml(entry.name) + '</d:displayname>',
    properties,
    '<d:getlastmodified>' + escapeXml(httpDate(metadata.modifiedAt)) + '</d:getlastmodified>',
    '<d:creationdate>' + escapeXml(isoDate(metadata.modifiedAt)) + '</d:creationdate>',
    '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>',
    '</d:response>',
  ].join('');
}

async function sendDavXml(response, entries, metadataForEntry) {
  const responses = [];
  for (const entry of entries) {
    responses.push(responseXml(entry, await metadataForEntry(entry)));
  }
  const body = '<?xml version="1.0" encoding="utf-8"?><d:multistatus xmlns:d="DAV:">' + responses.join('') + '</d:multistatus>';
  response.writeHead(207, {
    'content-type': 'application/xml; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    dav: '1',
    'cache-control': 'no-store',
  });
  response.end(body);
}

function sendError(response, error, { size = null, retryAfterSeconds = null } = {}) {
  // VfsError carries the canonical status/code. RangeResponseValidationError
  // (from the shared Range response validator) duck-types the same
  // surface so the byte path can surface 502 + structured codes
  // without depending on the VfsError class hierarchy.
  const status = error instanceof VfsError ? error.status : (Number.isFinite(error?.status) ? error.status : 500);
  const code = error instanceof VfsError ? error.code : (typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR');
  if (response.headersSent) {
    response.destroy(error);
    return;
  }
  const body = JSON.stringify({ error: error.message, code });
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  };
  // RFC 7233 §4.4: a 416 response SHOULD include a Content-Range header of
  // the form "bytes */<size>" so clients can correct their range arithmetic.
  // Only attach the header when we know the authoritative size for the
  // requested file. Otherwise omit it (clients must rely on a HEAD probe).
  if (status === 416 && Number.isSafeInteger(size) && size > 0) {
    headers['content-range'] = 'bytes */' + size;
    headers['accept-ranges'] = 'bytes';
  }
  // RFC 7231 §7.1.3: a 429 (or 503) response MAY include Retry-After to
  // tell the client how long to wait before retrying. We surface this when
  // the provider is currently rate-limiting reads of the cached capability.
  if (retryAfterSeconds != null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    headers['retry-after'] = String(Math.ceil(retryAfterSeconds));
  }
  response.writeHead(status, headers);
  response.end(body);
}

function parseContentRange(value) {
  const match = value?.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
  if (!match) return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  };
}

export function normalizeRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/i);
  // Multipart ranges and any header with commas / extra characters must fail
  // closed — we only serve a single byte range.
  if (!match || rangeHeader.includes(',')) {
    throw new VfsError('Only one byte range is supported', 416, 'INVALID_RANGE');
  }
  const [, startText, endText] = match;
  if (!startText && !endText) throw new VfsError('Malformed byte range', 416, 'INVALID_RANGE');

  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new VfsError('Byte range requires known content length', 416, 'RANGE_NOT_SATISFIABLE');
  }

  let start;
  let end;
  if (!startText) {
    // Suffix range: bytes=-N requests the last N bytes.
    const suffixLength = Number(endText);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
      throw new VfsError('Malformed suffix range', 416, 'INVALID_RANGE');
    }
    // RFC 7233 §2.1: a suffix range whose length exceeds the representation
    // is satisfiable but yields the whole representation.
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Math.min(Number(endText), size - 1) : size - 1;
  }

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || start > end) {
    throw new VfsError('Byte range is outside the file', 416, 'RANGE_NOT_SATISFIABLE');
  }
  return { start, end, header: 'bytes=' + start + '-' + end };
}

function buildTree(states) {
  const root = { path: DAV_ROOT, name: 'vfs', type: 'collection' };
  const entries = new Map([[DAV_ROOT, root]]);
  const children = new Map();

  function addChild(parentPath, child) {
    const siblings = children.get(parentPath) || [];
    if (!siblings.some((entry) => entry.path === child.path)) siblings.push(child);
    children.set(parentPath, siblings);
  }

  for (const state of states) {
    const segments = state.entry.canonicalPath.split('/');
    let parentPath = DAV_ROOT;
    segments.forEach((segment, index) => {
      const entryPath = parentPath + '/' + segment;
      const isFile = index === segments.length - 1;
      let treeEntry = entries.get(entryPath);
      if (!treeEntry) {
        treeEntry = {
          path: entryPath,
          name: segment,
          type: isFile ? 'file' : 'collection',
          ...(isFile ? { state } : {}),
        };
        entries.set(entryPath, treeEntry);
        addChild(parentPath, treeEntry);
      }
      parentPath = entryPath;
    });
  }

  for (const siblings of children.values()) {
    siblings.sort((left, right) => left.name.localeCompare(right.name));
  }
  return { entries, children };
}

function getEntries(tree, pathname, depth) {
  const entry = tree.entries.get(pathname);
  if (!entry) return null;
  return depth === '0' ? [entry] : [entry, ...(tree.children.get(pathname) || [])];
}

function sizeFromRdResult(result) {
  const file = result.torrentInfo?.files?.find((item) => String(item.id) === String(result.rdFileId));
  return Number.isSafeInteger(file?.bytes) && file.bytes > 0 ? file.bytes : null;
}

async function cancelBody(response) {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be closed.
  }
}

function metadataFromState(state) {
  return {
    size: state.entry.size,
    modifiedAt: state.handoff.selectedAt,
    etag: '"' + state.entry.releaseKey + '-' + state.entry.size + '"',
  };
}

export function createTvWebDav({
  searchCache,
  controlPlaneStore,
  rdClient,
  rdResolutionCache,
  resolveTorBoxDeliverySeam,
  torBoxDownloadUrlCache,
  // P5: persisted-candidate fallback seam (findUsableAlternate / promoteAlternate /
  // buildFallbackTelemetry). Wired from app.js so the VFS reuses the EXISTING
  // alternate lifecycle rather than reimplementing discovery/rerank.
  alternateFallback = null,
  terminalEvidenceStore = null,
  now = () => Date.now(),
  fetchFn = fetch,
  dataPlaneBaseUrl = 'http://hy4-data-plane:3001',
}) {
  const states = new Map();

  function getCatalog() {
    for (const handoff of searchCache.listTvPlaybackHandoffs()) {
      materializeVfsEntry(searchCache, handoff, controlPlaneStore, now, { allowLegacy: true });
    }
    const nextStates = [];
    for (const entry of searchCache.listVfsTvEntries()) {
      const stateKey = entry.mediaId + ':' + entry.season + ':' + entry.episode;
      let state = states.get(stateKey);
      if (!state) {
        const handoff = searchCache.getTvPlaybackHandoff(entry.mediaId, entry.season, entry.episode);
        if (!handoff) {
          throw new VfsError(
            'Durable handoff is missing for VFS episode ' + entry.mediaId + ' S' + entry.season + 'E' + entry.episode,
            503,
            'HANDOFF_MISSING',
          );
        }
        const identityMismatch = entry.torrentFileId
          ? entry.torrentFileId !== handoff.torrentFileId
            || entry.infoHash !== handoff.infoHash
          : entry.releaseKey !== handoff.releaseKey
            || entry.infoHash !== handoff.infoHash
            || entry.fileIndex !== handoff.fileIndex;
        if (identityMismatch) {
          throw new VfsError(
            'Durable TV entry and playback handoff identify different physical files',
            503,
            'HANDOFF_RELEASE_MISMATCH',
          );
        }
        state = { entry, handoff, metadataPromise: null };
        states.set(stateKey, state);
        console.log('[vfs-tv] bound media=' + entry.mediaId + ' S' + entry.season + 'E' + entry.episode + ' release=' + entry.releaseKey);
      } else if (state.entry.size == null && entry.size != null) {
        state.entry = entry;
      }
      nextStates.push(state);
    }
    return buildTree(nextStates);
  }

  async function resolveBacking(state, { forceFresh = false } = {}) {
    const { handoff } = state;
    if (forceFresh) {
      rdResolutionCache.delete(handoff.infoHash, handoff.fileIndex);
      // forceFresh forces the TorBox ephemeral downstream URL to be
      // re-resolved on the next cache miss. The cache now keys on the
      // provider-stable capability tuple (provider, accountScope,
      // placementId, providerFileId); that tuple is not known to the
      // VFS layer until the seam returns. Invalidation on actual byte
      // read failure is handled inside openValidatedProviderRead where
      // the fresh delivery is available.
    }

    if (rdClient) {
      // Same-TorrentFile RD fallback accounting: when the in-loop
      // 2nd attempt (forceFresh) asks for a fresh backing for the
      // SAME (infoHash, fileIndex) after a TorBox failure, that
      // attempt is a same-TorrentFile RD fallback. The 1st-attempt
      // path (forceFresh=false) is a normal primary RD probe and is
      // NOT counted here.
      const isRdFallback = forceFresh;
      if (isRdFallback) {
        providerAccounting.increment('realdebrid', 'realdebrid_fallback_attempted');
      }
      const cached = forceFresh ? null : rdResolutionCache.get(handoff.infoHash, handoff.fileIndex);
      if (cached) {
        return { provider: 'realdebrid', url: cached.url, size: null, resolution: 'cache' };
      }

      const result = await rdResolutionCache.getOrInFlight(
        handoff.infoHash,
        handoff.fileIndex,
        () => attemptRdResolution(rdClient, searchCache, {
          infoHash: handoff.infoHash,
          fileIndex: handoff.fileIndex,
          filename: handoff.filename,
          size: state.entry.size,
        }, { now }),
      );

      if (result.status === 'resolved') {
        const url = await getRdPlaybackUrl(rdClient, result.torrentInfo, result.rdFileId);
        if (await isUrlLive(url, { fetchFn })) {
          rdResolutionCache.set(handoff.infoHash, handoff.fileIndex, url, result.torrentId, result.rdFileId);
          if (isRdFallback) {
            providerAccounting.increment('realdebrid', 'realdebrid_fallback_resolved');
          }
          return {
            provider: 'realdebrid',
            url,
            size: sizeFromRdResult(result),
            resolution: 'fresh',
          };
        }
        console.warn('[vfs-tv] provider=realdebrid resolution=fresh failure=dead-url release=' + handoff.releaseKey);
      } else {
        const reason = result.error?.code || result.reason || 'unavailable';
        console.warn('[vfs-tv] provider=realdebrid resolution=failed failure=' + reason + ' release=' + handoff.releaseKey);
      }
      // RD did not produce a usable backing on this attempt. If this
      // was a same-TorrentFile fallback (in-loop 2nd attempt) the
      // attempt is fully spent — record the negative outcome so the
      // proof can assert the bounded retry did not silently swallow
      // RD work, then fall through to TorBox.
      if (isRdFallback) {
        providerAccounting.increment('realdebrid', 'realdebrid_fallback_failed');
      }
    }

    if (!resolveTorBoxDeliverySeam) {
      throw new VfsError('No TorBox delivery resolver is available', 503, 'TORBOX_DELIVERY_UNAVAILABLE');
    }
    // Shared authoritative TorBox delivery seam — owns placement reuse,
    // stale-resource repair, bounded mylist verification, cached-only
    // recreation, exact mapping, and ephemeral downstream URL cache.
    const delivery = await resolveTorBoxDeliverySeam({
      infoHash: handoff.infoHash,
      fileIndex: handoff.fileIndex,
      releaseKey: handoff.releaseKey,
      filename: handoff.filename,
    });
    return {
      provider: 'torbox',
      url: delivery.url,
      size: delivery.size,
      placementId: delivery.placementId,
      providerFileId: delivery.providerFileId,
      accountScope: delivery.accountScope,
      resolution: delivery.recovered ? 'recovered' : (forceFresh ? 'remapped' : 'mapped'),
    };
  }

  async function fetchProvider(backing, rangeHeader) {
    return fetchFn(backing.url, {
      method: 'GET',
      headers: rangeHeader ? { range: rangeHeader } : {},
      redirect: 'follow',
    });
  }

  function parseReadRetryAfter(response) {
    if (!response || !response.headers) return null;
    const raw = response.headers.get?.('retry-after');
    if (!raw) return null;
    const seconds = Number(String(raw).trim());
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(String(raw).trim());
    if (Number.isFinite(date)) {
      const diff = date - Date.now();
      return diff > 0 ? diff : null;
    }
    return null;
  }

  // Bounded read-429 back-pressure. When a byte read against a cached
  // capability returns 429, arm a per-capability DELIVERY backoff gate
  // in the TorBox download URL cache. Subsequent reads in the backoff
  // window short-circuit BEFORE the seam is invoked — no new requestdl,
  // no upstream byte GET. The capability itself is NOT invalidated
  // (a 429 is a transient throttle, not proof the URL is bad).
  //
  // Gate keying — the gate is keyed on the same capability tuple
  // (provider, accountScope, placementId, providerFileId) used for
  // requestdl backoff. The two gates are independent maps so a
  // requestdl 429 does not arm the delivery gate, and vice versa.
  // The capability tuple is the narrowest key supported by the
  // evidence we have: a 429 from the upstream CDN is per-URL, and
  // a per-URL observation safely narrows to the cached capability
  // tuple (one capability → one URL at any time).
  //
  // Process-local by design: the gate is short-lived (bounded by
  // the upstream Retry-After header or a conservative floor) so a
  // process restart naturally clears it without operator action.
  //
  // The pre-existing in-state `state.rateLimited` flag is preserved
  // for back-compat with any test that introspects it, but the
  // authoritative gate now lives in the cache so the contract is
  // shared across all VFS state instances and so the gate can be
  // surfaced in accounting without any VFS-specific wiring.
  const MIN_READ_RETRY_AFTER_MS = 30_000; // 30s floor when upstream omits Retry-After.

  function deliveryCapabilityFor(backing) {
    if (!backing) return null;
    if (backing.provider !== 'torbox') return null;
    if (!backing.placementId || !backing.providerFileId) return null;
    return {
      provider: 'torbox',
      accountScope: backing.accountScope ?? 'default',
      placementId: backing.placementId,
      providerFileId: backing.providerFileId,
    };
  }

  function gateReadRateLimited(state, capability) {
    if (torBoxDownloadUrlCache
        && typeof torBoxDownloadUrlCache.isDeliveryRateLimited === 'function'
        && capability) {
      const gate = torBoxDownloadUrlCache.isDeliveryRateLimited(capability, now());
      if (gate) return gate;
    }
    const rl = state?.rateLimited;
    if (!rl || !Number.isFinite(rl.until)) return null;
    if (now() >= rl.until) {
      state.rateLimited = null;
      return null;
    }
    return rl;
  }

  function markReadRateLimited(state, capability, retryAfterMs) {
    if (torBoxDownloadUrlCache
        && typeof torBoxDownloadUrlCache.markDeliveryRateLimited === 'function'
        && capability) {
      torBoxDownloadUrlCache.markDeliveryRateLimited(capability, retryAfterMs, now());
    }
    if (!state) return;
    const until = now() + (Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : MIN_READ_RETRY_AFTER_MS);
    const existing = state.rateLimited;
    state.rateLimited = { until: Math.max(until, existing?.until || 0) };
  }

  function clearReadRateLimited(state, capability) {
    if (torBoxDownloadUrlCache
        && typeof torBoxDownloadUrlCache.clearDeliveryRateLimited === 'function'
        && capability) {
      torBoxDownloadUrlCache.clearDeliveryRateLimited(capability);
    }
    if (state) state.rateLimited = null;
  }

  async function openValidatedProviderRead(state, rangeHeader, validate) {
    // P6 authority guard — regression-proof boundary for the legacy Node byte path.
    // This function is ONLY reachable for durable VFS entries WITHOUT a TorrentFile
    // (state.entry.torrentFileId === null). For any torrentFileId-present entry, byte
    // authority is Rust-only (enforced in streamFile via streamFromDataPlane). Invoking
    // this path for a tfId-present entry would silently re-grant Node provider
    // byte-delivery authority, which P6 forbids — so we fail loud rather than mask it
    // as a 200/206. This is the durable replacement for the deleted authority: the
    // modern entry point (streamFile) already routes tfId-present to Rust, and this
    // guard makes that invariant impossible to violate by accident.
    if (state?.entry?.torrentFileId) {
      throw new VfsError(
        'Legacy Node byte path invoked for a durable (torrentFileId-present) entry; byte authority is Rust-only',
        500,
        'LEGACY_PATH_AUTHORITY_VIOLATION',
      );
    }
    let firstFailure = null;
    let sawReadRateLimit = false;
    let firstFailureDefinitive = false;
    let firstBacking = null;
    let earlyBacking = null;
    let postGateOwnership = null;
    try {
    // Bounded read-429 back-pressure: if a prior byte read against the
    // same capability already returned 429 within the backoff window,
    // refuse the call without re-resolving requestdl and without
    // hitting the upstream URL again. The capability itself remains
    // valid — once the window expires the next read reuses it.
    //
    // The gate is checked against the state-level flag FIRST so the
    // gate check does NOT trigger an extra resolveBacking call (which
    // would amplify into a fresh requestdl stampede). The cache-level
    // gate is consulted as a secondary check after resolveBacking so
    // a 429 observed on a sibling VFS state is still honored.
    //
    // The cache-level gate is keyed on the resolved capability tuple
    // so a single 429 observation covers every concurrent and
    // subsequent byte read against the SAME (provider, accountScope,
    // placementId, providerFileId).
    const stateGate = gateReadRateLimited(state, null);
    if (stateGate) {
      const retryAfterSeconds = Math.max(1, Math.ceil((stateGate.until - now()) / 1000));
      const error = new VfsError(
        'Provider byte reads are currently rate-limited',
        429,
        'PROVIDER_READ_RATE_LIMITED',
      );
      error.retryAfterMs = Math.max(0, stateGate.until - now());
      error.retryAfterSeconds = retryAfterSeconds;
      providerAccounting.increment('torbox', 'delivery_backoff_short_circuit');
      throw error;
    }
    let earlyGate = null;
    try {
      earlyBacking = await resolveBacking(state, { forceFresh: false });
    } catch (error) {
      // resolveBacking may throw when the requestdl seam refuses
      // (requestdl 429 → fromGate throw). That throw is the
      // authoritative 429 signal for the capability; surface it
      // unchanged. No upstream byte GET is attempted in this path.
      throw error;
    }
    const earlyCapability = deliveryCapabilityFor(earlyBacking);
    // Now consult the cache-level gate (cross-VFS-state shared
    // signal). If a sibling already armed it for this capability,
    // we still short-circuit without an upstream byte GET.
    earlyGate = earlyCapability ? gateReadRateLimited(state, earlyCapability) : null;
    if (earlyGate) {
      const retryAfterSeconds = Math.max(1, Math.ceil((earlyGate.until - now()) / 1000));
      const error = new VfsError(
        'Provider byte reads are currently rate-limited',
        429,
        'PROVIDER_READ_RATE_LIMITED',
      );
      error.retryAfterMs = Math.max(0, earlyGate.until - now());
      error.retryAfterSeconds = retryAfterSeconds;
      if (earlyBacking?.provider) {
        providerAccounting.increment(earlyBacking.provider, 'delivery_backoff_short_circuit');
      } else {
        providerAccounting.increment('torbox', 'delivery_backoff_short_circuit');
      }
      throw error;
    }
    // Post-gate ownership lock. When the per-capability delivery
    // gate has expired and `state._deliveryRecentlyGated` is set,
    // this call is entering the post-gate retry window. The first
    // caller past expiry is the single retry owner; concurrent
    // siblings must NOT amplify the throttled upstream. The
    // per-capability lock in `torBoxDownloadUrlCache` makes that
    // guarantee: the first caller is the owner, every other
    // concurrent caller becomes a sibling and short-circuits to 429
    // without firing its own byte GET.
    let isPostGateOwner = false;
    if (earlyCapability && state?._deliveryRecentlyGated === true && !earlyGate) {
      if (torBoxDownloadUrlCache
        && typeof torBoxDownloadUrlCache.acquirePostGateDeliveryOwner === 'function') {
        postGateOwnership = torBoxDownloadUrlCache.acquirePostGateDeliveryOwner(earlyCapability);
        isPostGateOwner = Boolean(postGateOwnership?.isOwner);
      } else {
        // No lock available — preserve the existing single-attempt
        // behavior so the VFS never amplifies the upstream in this
        // branch even without the lock helper.
        isPostGateOwner = true;
      }
    }
    if (isPostGateOwner && earlyBacking?.provider) {
      providerAccounting.increment(earlyBacking.provider, 'delivery_post_backoff_retry');
    } else if (postGateOwnership && !isPostGateOwner) {
      // Sibling: do NOT fire upstream. Await the owner's outcome,
      // then short-circuit 429 with the same surface a normal
      // gated caller would see. The owner's release cleared the
      // per-capability cache gate on success (so the next sibling
      // call past this turn proceeds normally) or re-armed it on
      // failure (so this sibling's 429 is the correct response).
      try {
        await postGateOwnership.settled;
      } catch {
        // Owner failed; the VFS layer will have re-armed the cache
        // gate from the failure path. Fall through to 429.
      }
      const siblingGate = earlyCapability
        ? gateReadRateLimited(state, earlyCapability)
        : null;
      const retryAfterSeconds = siblingGate
        ? Math.max(1, Math.ceil((siblingGate.until - now()) / 1000))
        : 1;
      const error = new VfsError(
        'Provider byte reads are currently rate-limited',
        429,
        'PROVIDER_READ_RATE_LIMITED',
      );
      error.retryAfterMs = siblingGate
        ? Math.max(0, siblingGate.until - now())
        : 0;
      error.retryAfterSeconds = retryAfterSeconds;
      if (earlyBacking?.provider) {
        providerAccounting.increment(earlyBacking.provider, 'delivery_backoff_short_circuit');
      } else {
        providerAccounting.increment('torbox', 'delivery_backoff_short_circuit');
      }
      throw error;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const forceFresh = attempt === 1;
      // Reuse the backing we resolved in the gate-check above on
      // the first iteration; on the second (forceFresh) iteration
      // we re-resolve so the bounded retry path is preserved.
      const backing = attempt === 0 ? earlyBacking : await resolveBacking(state, { forceFresh: true });
      let upstream;
      try {
        providerAccounting.increment(backing?.provider ?? 'torbox', 'delivery_range_request');
        upstream = await fetchProvider(backing, rangeHeader);
      } catch (error) {
        // A transport failure is not proof that the capability is invalid.
        firstFailure ||= error;
        if (!forceFresh) continue;
        throw new VfsError('Provider read failed after fresh resolution', 502, 'PROVIDER_READ_FAILED');
      }

      const validationError = validate(upstream);
      if (!validationError) {
        // Success — clear any stale delivery gate for this capability
        // so a later 429 from a different surface re-arms it cleanly.
        const okCapability = deliveryCapabilityFor(backing);
        const wasGated = gateReadRateLimited(state, okCapability);
        // We attribute Delivery_success_after_backoff to the FIRST
        // successful read after a 429. The signal is the state-level
        // "recently gated" hint (set on 429, cleared on the next
        // success) — the cache-level gate may have already been
        // lazily evicted by the time the post-gate owner enters, so
        // we cannot rely on `wasGated` alone to identify the owner.
        if (state?._deliveryRecentlyGated || wasGated) {
          if (wasGated) clearReadRateLimited(state, okCapability);
          if (backing?.provider) {
            providerAccounting.increment(backing.provider, 'delivery_success_after_backoff');
          } else {
            providerAccounting.increment('torbox', 'delivery_success_after_backoff');
          }
        }
        if (state) state._deliveryRecentlyGated = false;
        return { backing, upstream };
      }
      await cancelBody(upstream);
      firstFailure ||= validationError;
      if (!forceFresh) {
        firstBacking = backing;
        const readFailure = classifyReadFailure(upstream);
        console.warn(
          '[vfs-tv] provider=' + backing.provider + ' read=' + readFailure
          + ' reason=' + (validationError.validationReason || validationError.code)
          + ' status=' + upstream.status
          + ' release=' + state.entry.releaseKey,
        );
        if (upstream.status !== 429) {
          // Definitive status and protocol-invalid byte semantics distrust
          // this exact capability. Transient 5xx responses retain it.
          if (STALE_PROVIDER_STATUSES.has(upstream.status)
              || readFailure === 'protocol-invalid') {
            firstFailureDefinitive = true;
            invalidateTorBoxCapability(backing);
          }
          continue;
        }
        // Read 429 — the capability itself is still valid (not stale),
        // it is just currently being throttled by the upstream. Arm a
        // per-capability delivery backoff gate so concurrent and
        // subsequent reads in the backoff window short-circuit BEFORE
        // the seam is invoked. Do not invalidate the capability — after
        // the window it should be reused. Do not retry within this loop
        // — the next call after the window is the correct retry
        // boundary. Do not write terminal/temporary evidence — a 429 is
        // a transient throttle, not proof of capability invalidity.
        const capability = deliveryCapabilityFor(backing);
        const upstreamRetryAfterMs = parseReadRetryAfter(upstream);
        const provider = backing?.provider ?? 'torbox';
        providerAccounting.increment(provider, 'delivery_429');
        if (Number.isFinite(upstreamRetryAfterMs)) {
          providerAccounting.increment(provider, 'delivery_retry_after_ms', upstreamRetryAfterMs);
        }
        markReadRateLimited(state, capability, upstreamRetryAfterMs);
        providerAccounting.increment(provider, 'delivery_backoff_enter');
        if (state) state._deliveryRecentlyGated = true;
        sawReadRateLimit = true;
        // First observer of the 429: surface the existing typed
        // error (preserves the established 502 contract for the
        // first observer). Subsequent readers in the window see a
        // 429 from the gate short-circuit path.
        throw validationError;
      }
      // Second (forceFresh) attempt also failed validation. If the
      // first failure was a definitive protocol-invalid / stale
      // mapping, the bounded fresh capability retry also failed
      // protocol validation, and the current exact mapping is
      // terminal: record durable evidence so the normal resolver
      // ladder skips this capability without repeating the byte-
      // path probe. A 429 first failure short-circuits above, so
      // this branch only handles definitive / transient non-429
      // failures.
      if (terminalEvidenceStore && backing?.provider === 'torbox' && backing.placementId && backing.providerFileId) {
        const reason = firstFailureDefinitive
          ? 'protocol-invalid-after-fresh-retry'
          : 'read-transient-after-fresh-retry';
        const evidenceState = firstFailureDefinitive
          ? 'terminal'
          : 'temporary';
        try {
          if (evidenceState === 'terminal') {
            terminalEvidenceStore.recordTerminal({
              provider: backing.provider,
              accountScope: backing.accountScope ?? 'default',
              placementId: backing.placementId,
              providerFileId: backing.providerFileId,
              infoHash: state.entry.infoHash,
              fileIndexKey: state.entry.fileIndex ?? -1,
              reason,
              failureCategory: 'delivery-capability-protocol-invalid',
              observedAt: now(),
            });
          } else {
            terminalEvidenceStore.recordTemporary({
              provider: backing.provider,
              accountScope: backing.accountScope ?? 'default',
              placementId: backing.placementId,
              providerFileId: backing.providerFileId,
              infoHash: state.entry.infoHash,
              fileIndexKey: state.entry.fileIndex ?? -1,
              reason,
              failureCategory: 'delivery-capability-transient',
              observedAt: now(),
            });
          }
        } catch (error) {
          // Recording evidence is best-effort. A failure here must
          // not mask the original read failure.
          console.warn('[vfs-tv] failed to record delivery evidence: ' + error.message);
        }
      }
      throw validationError;
    }
    if (sawReadRateLimit) {
      // First-failure path: surface the upstream provider failure as the
      // existing typed error (preserves the established 502 contract for
      // the FIRST observer of the 429). The back-pressure window now
      // guarantees subsequent reads within the window short-circuit
      // with 429.
      throw firstFailure;
    }
    throw firstFailure || new VfsError('Provider read failed', 502, 'PROVIDER_READ_FAILED');
    } finally {
      // Always release the per-capability post-gate ownership lock so
      // concurrent siblings wake up to a settled promise (success or
      // failure). The lock is the durable single-owner guarantee; the
      // release is the unblock boundary. Without this, a thrown 429
      // inside the read loop would leave the lock set forever and
      // starve every subsequent post-expiry caller.
      if (postGateOwnership?.isOwner) {
        // Owner. Decide ok/fail and release. We infer ok/fail by
        // re-checking the cache gate: if the gate is now cleared
        // (success path), release({ok: true}); if it was re-armed
        // (429/5xx path), release({ok: false}). The next call after
        // this release observes the cleared or re-armed gate
        // respectively.
        const releasedCapability = deliveryCapabilityFor(earlyBacking);
        const releasedGate = releasedCapability
          ? gateReadRateLimited(state, releasedCapability)
          : null;
        const ok = !releasedGate;
        if (ok) {
          postGateOwnership.release({ ok: true });
        } else {
          postGateOwnership.release({ ok: false });
        }
      }
    }
  }

  function invalidateTorBoxCapability(backing) {
    if (!torBoxDownloadUrlCache) return;
    if (backing?.provider !== 'torbox') return;
    if (typeof torBoxDownloadUrlCache.invalidateByCapability !== 'function') return;
    if (!backing.placementId || !backing.providerFileId) return;
    torBoxDownloadUrlCache.invalidateByCapability({
      provider: backing.provider,
      accountScope: backing.accountScope ?? 'default',
      placementId: backing.placementId,
      providerFileId: backing.providerFileId,
    });
  }

  async function loadMetadata(state) {
    if (state.entry.size != null) return metadataFromState(state);

    let backing = await resolveBacking(state);
    let size = backing.size;
    if (size == null) {
      const opened = await openValidatedProviderRead(state, 'bytes=0-0', (probe) => {
        const contentRange = parseContentRange(probe.headers.get('content-range'));
        return probe.status === 206
          && contentRange?.start === 0
          && contentRange.end === 0
          && Number.isSafeInteger(contentRange.total)
          && contentRange.total > 0
          ? null
          : new VfsError(
              'Provider did not supply usable byte-range size metadata',
              502,
              'PROVIDER_SIZE_UNAVAILABLE',
            );
      });
      const contentRange = parseContentRange(opened.upstream.headers.get('content-range'));
      size = contentRange.total;
      await cancelBody(opened.upstream);
      backing = opened.backing;
    }

    const persisted = searchCache.setVfsTvEntrySize(
      state.entry.mediaId,
      state.entry.season,
      state.entry.episode,
      state.entry.releaseKey,
      size,
      now(),
    );
    if (!persisted || persisted.releaseKey !== state.entry.releaseKey || persisted.size !== size) {
      throw new VfsError('Durable VFS size conflicts with provider metadata', 502, 'PROVIDER_SIZE_MISMATCH');
    }
    state.entry = persisted;
    console.log('[vfs-tv] stat path="' + DAV_ROOT + '/' + state.entry.canonicalPath + '" size=' + size + ' release=' + state.entry.releaseKey + ' provider=' + backing.provider);
    return metadataFromState(state);
  }

  // Return durable metadata only — no provider resolution.
  // Used by PROPFIND/listing where Plex scans should not depend on provider availability.
  function getDurableMetadata(state) {
    return metadataFromState(state);
  }

  // Resolve and persist size via provider. Only called on actual media reads (GET).
  async function ensureMetadata(state) {
    if (state.entry.size != null) return metadataFromState(state);
    if (state.metadataPromise) return state.metadataPromise;
    state.metadataPromise = loadMetadata(state);
    try {
      return await state.metadataPromise;
    } finally {
      state.metadataPromise = null;
    }
  }

  // Eagerly hydrate authoritative VFS TV size for a specific episode.
  // Idempotent: returns the current durable entry without touching the
  // provider when size is already known. Mirrors the movie hydrator so
  // Plex TV partial refreshes see real sizes before notification.
  async function hydrateVfsTvEntry({ mediaId, season, episode }) {
    if (!Number.isSafeInteger(season) || !Number.isSafeInteger(episode)) {
      throw new VfsError('Episode coordinates are required for VFS hydration', 400, 'HYDRATE_INVALID');
    }
    getCatalog();
    const stateKey = mediaId + ':' + season + ':' + episode;
    const state = states.get(stateKey);
    if (!state) {
      throw new VfsError(
        'VFS TV state not found for ' + mediaId + ' S' + season + 'E' + episode,
        503,
        'VFS_STATE_MISSING',
      );
    }
    const result = await ensureMetadata(state);
    return {
      releaseKey: state.entry.releaseKey,
      mediaId: state.entry.mediaId,
      season: state.entry.season,
      episode: state.entry.episode,
      canonicalPath: state.entry.canonicalPath,
      size: state.entry.size,
      alreadyHydrated: state.entry.size === result.size && result.size != null,
    };
  }

  /**
   * P5 persisted-candidate fallback seam (durable VFS entries only).
   *
   * Invoked ONLY when Rust returns a class-D failure (PROVIDER_EXHAUSTED) for a
   * tfId-present entry. Reuses the EXISTING persisted-candidate lifecycle:
   *   findUsableAlternate → resolveTorBoxDeliverySeam → isUrlLive →
   *   promoteAlternate → materializeVfsEntry → re-forward to Rust with the NEW
   *   durable TorrentFile.
   *
   * It does NOT rediscover/rerank and does NOT touch the legacy Node provider
   * byte path. On any failure (no candidate, no durable TorrentFile, validation
   * failed) it returns false so the caller emits the explicit Rust 5xx (no
   * legacy escape). Rust owns same-TorrentFile recovery; this only switches TF.
   *
   * @returns {Promise<boolean>} true if the alternate was served (response fully
   *   written); false if the caller must emit the terminal error.
   */
  async function attemptPersistedAlternateFallback({ error, state, request, response, metadata }) {
    if (error?.class !== 'D') return false;
    if (!alternateFallback || typeof alternateFallback.findUsableAlternate !== 'function') {
      return false;
    }

    const mediaType = 'tv';
    const expectedScope = {
      media_type: mediaType,
      season: state.entry.season ?? null,
      episode: state.entry.episode ?? null,
    };

    // 1. Find a persisted, TorBox-CACHED alternate (durable TorrentFile exists).
    let fallback;
    try {
      fallback = await alternateFallback.findUsableAlternate({
        mediaId: state.entry.mediaId,
        primaryReleaseKey: state.entry.releaseKey,
        expectedScope,
      });
    } catch (e) {
      console.warn(
        `[vfs-tv] persisted-alternate lookup failed for release=${state.entry.releaseKey}: ${e.message}`,
      );
      return false;
    }
    if (!fallback) {
      console.warn(
        `[vfs-tv] no usable persisted alternate for tfId=${state.entry.torrentFileId} release=${state.entry.releaseKey}`,
      );
      return false;
    }

    // VFS Rust path REQUIRES a durable TorrentFile. A TorBox-CACHED candidate has
    // one; an RD-only candidate does not, so it cannot be served here (P5 §10: no
    // provider-persistence expansion).
    if (fallback.revalidation?.cacheState !== REVALIDATION_OUTCOME.CACHED) {
      console.warn(
        `[vfs-tv] persisted alternate for release=${state.entry.releaseKey} is not TorBox-cached (${fallback.revalidation?.cacheState}); cannot serve via Rust`,
      );
      return false;
    }

    const { candidate } = fallback;

    // 2. Resolve the authoritative delivery seam (reuses existing placement).
    let delivery;
    try {
      delivery = await resolveTorBoxDeliverySeam({
        infoHash: candidate.info_hash,
        fileIndex: candidate.fileIndex,
        releaseKey: candidate.releaseKey,
        filename: candidate.filename,
      });
    } catch (e) {
      console.warn(`[vfs-tv] delivery seam failed for release=${candidate.releaseKey}: ${e.message}`);
      return false;
    }

    // 3. Validate a single bounded byte response from the delivery URL.
    let validatedBytes = false;
    try {
      validatedBytes = await isUrlLive(delivery.url);
    } catch {
      validatedBytes = false;
    }
    if (!validatedBytes) {
      console.warn(`[vfs-tv] delivery URL not live for release=${candidate.releaseKey}; skipping alternate`);
      return false;
    }

    // 4. Promote through the normal authoritative lifecycle (idempotent).
    let promotion;
    try {
      promotion = alternateFallback.promoteAlternate({
        candidate,
        delivery,
        controlPlaneStore,
        evidence: { validatedBytes: true },
        mediaRequest: {
          mediaId: state.entry.mediaId,
          media_type: mediaType,
          season: expectedScope.season,
          episode: expectedScope.episode,
        },
        now,
      });
    } catch (e) {
      console.warn(`[vfs-tv] promoteAlternate threw for release=${candidate.releaseKey}: ${e.message}`);
      return false;
    }
    if (!promotion?.promoted) {
      console.warn(
        `[vfs-tv] promoteAlternate refused for release=${candidate.releaseKey}: ${promotion?.reason ?? 'unknown'}`,
      );
      return false;
    }

    // 5. Reuse the single owner of the VFS row + binding write.
    try {
      materializeVfsEntry(searchCache, promotion.handoff, controlPlaneStore, now, { allowLegacy: true });
    } catch (e) {
      console.warn(`[vfs-tv] materializeVfsEntry failed for release=${candidate.releaseKey}: ${e.message}`);
      return false;
    }

    // 6. Reuse buildFallbackTelemetry so the fallback is observable with the same
    // envelope the resolver path uses (P5 §6).
    const fallbackTelemetry = alternateFallback.buildFallbackTelemetry({
      originalReleaseKey: state.entry.releaseKey,
      selectedReleaseKey: candidate.releaseKey,
      fallbackRank: candidate.rank,
      reason: 'PRIMARY_PROVIDER_EXHAUSTED',
    });
    console.log(
      `[vfs-tv] persisted-alternate fallback used for media=${state.entry.mediaId} `
        + `from=${state.entry.releaseKey} to=${candidate.releaseKey} rank=${candidate.rank} `
        + `newTfId=${promotion.handoff.torrentFileId}`,
      fallbackTelemetry,
    );

    // 7. Identity carried EXACTLY: re-forward to Rust with the NEW durable
    // TorrentFile id. Rust owns same-TorrentFile recovery; we only switch TF.
    try {
      await streamFromDataPlane({
        fetchFn,
        baseUrl: dataPlaneBaseUrl,
        tfId: promotion.handoff.torrentFileId,
        request,
        response,
        contentType: CONTENT_TYPE,
      });
      return true;
    } catch (e2) {
      console.warn(
        `[vfs-tv] re-forward to alternate tfId=${promotion.handoff.torrentFileId} failed: ${e2?.message ?? e2}`,
      );
      return false;
    }
  }

  async function streamFile(request, response, state, metadata) {
    let requestedRange;
    try {
      requestedRange = normalizeRange(request.headers.range, metadata.size);
    } catch (error) {
      // Reject impossible / malformed ranges before any provider call. A
      // locally-known impossible range must not call requestdl.
      sendError(response, error, { size: metadata.size });
      return;
    }

    // ---- P5 authoritative Rust byte path + persisted-candidate fallback ------
    // For any durable VFS entry (state.entry.torrentFileId != null), Rust is the
    // ONLY byte-serving authority. We forward to Rust and only one of two things
    // may happen:
    //   (a) Rust succeeds → bytes proxied to the client (return).
    //   (b) Rust returns a classified failure:
    //       - class D (PROVIDER_EXHAUSTED): reuse the persisted-candidate
    //         fallback to switch to a DIFFERENT durable TorrentFile and re-forward
    //         to Rust. If that serves bytes, return.
    //       - any other class (A/B/C/unreachable): explicit terminal failure.
    // In NO case do we fall through to the legacy Node provider byte path for a
    // tfId-present entry (P5 §1). The legacy path below is reachable ONLY for
    // entries without a durable TorrentFile (torrentFileId === null).
    if (state.entry.torrentFileId) {
      try {
        await streamFromDataPlane({
          fetchFn,
          baseUrl: dataPlaneBaseUrl,
          tfId: state.entry.torrentFileId,
          request,
          response,
          contentType: CONTENT_TYPE,
        });
        return;
      } catch (error) {
        const recovered = await attemptPersistedAlternateFallback({
          error,
          state,
          request,
          response,
          metadata,
        });
        if (recovered) return;
        // Terminal: emit the classified Rust failure verbatim. NO legacy escape.
        sendError(response, error, { size: metadata.size });
        return;
      }
    }

    // ---- LEGACY COMPAT PATH (torrentFileId === null ONLY) ----
    // Reached solely for entries without a durable TorrentFile. The guard at the
    // top of openValidatedProviderRead rejects any tfId-present entry, so Node
    // provider byte-delivery authority is strictly limited to legacy entries and
    // can never be regained for modern durable VFS entries.
    let opened;
    try {
      opened = await openValidatedProviderRead(
        state,
        requestedRange?.header,
        (upstream) => validateRangeResponseHeaders(
          upstream,
          requestedRange ?? null,
          { size: metadata.size },
        ),
      );
    } catch (error) {
      if (error instanceof VfsError && error.code === 'PROVIDER_READ_RATE_LIMITED') {
        sendError(response, error, { retryAfterSeconds: error.retryAfterSeconds ?? 1 });
        return;
      }
      throw error;
    }

    // Body byte-count check. For Range requests the validator buffers
    // the body, asserts the byte count matches the requested range,
    // and returns a re-wrapped upstream whose body is the buffered
    // bytes. For full-file (no Range) requests the body is NOT
    // buffered; only the Content-Length header was already checked by
    // validateRangeResponseHeaders above.
    const bodyCheck = await validateRangeResponseBody(
      opened.upstream,
      requestedRange ?? null,
      { size: metadata.size },
    );
    if (!bodyCheck.ok) {
      console.warn(
        '[vfs-tv] provider=' + opened.backing.provider
        + ' read=body-' + bodyCheck.error.validationReason
        + ' status=' + opened.upstream.status
        + ' release=' + state.entry.releaseKey,
      );
      invalidateTorBoxCapability(opened.backing);
      sendError(response, bodyCheck.error, { size: metadata.size });
      return;
    }
    const upstream = bodyCheck.upstream;

    try {
      response.writeHead(requestedRange ? 206 : 200, {
        'content-type': CONTENT_TYPE,
        'content-length': requestedRange
          ? requestedRange.end - requestedRange.start + 1
          : metadata.size,
        'content-range': requestedRange
          ? 'bytes ' + requestedRange.start + '-' + requestedRange.end + '/' + metadata.size
          : undefined,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
        etag: metadata.etag,
        'last-modified': httpDate(metadata.modifiedAt),
      });
      await finished(Readable.fromWeb(upstream.body).pipe(response));
    } catch (error) {
      response.destroy(error);
    }
  }

  function findEpisode(tree, pathname) {
    const entry = tree.entries.get(pathname);
    if (!entry || entry.type !== 'file') return null;
    return entry.state;
  }

  const handleTvWebDav = async function handleTvWebDav(request, response, url) {
    if (!url.pathname.startsWith('/vfs/TV')) return false;
    const tree = getCatalog();
    const pathname = normalizePath(url.pathname);

    if (request.method === 'PROPFIND') {
      const depth = request.headers.depth || '1';
      const entries = getEntries(tree, pathname, depth);
      if (!entries) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
        return true;
      }
      await sendDavXml(response, entries, (entry) => {
        if (entry.type === 'collection') {
          return { size: 0, modifiedAt: now(), etag: '"0"' };
        }
        // Durable metadata only — no provider resolution during Plex scans
        return getDurableMetadata(entry.state);
      });
      return true;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      const state = findEpisode(tree, pathname);
      if (!state) {
        response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'Not found', code: 'NOT_FOUND' }));
        return true;
      }
      let metadata;
      try {
        metadata = await ensureMetadata(state);
      } catch (error) {
        if (error instanceof VfsError && error.code === 'PROVIDER_READ_RATE_LIMITED') {
          sendError(response, error, { retryAfterSeconds: error.retryAfterSeconds ?? 1 });
          return true;
        }
        throw error;
      }
      if (request.method === 'HEAD') {
        response.writeHead(200, {
          'content-type': CONTENT_TYPE,
          'content-length': metadata.size,
          'accept-ranges': 'bytes',
          'cache-control': 'no-store',
          etag: metadata.etag,
          'last-modified': httpDate(metadata.modifiedAt),
        });
        response.end();
        return true;
      }
      await streamFile(request, response, state, metadata);
      return true;
    }

    if (request.method === 'OPTIONS') {
      response.writeHead(200, {
        allow: 'GET, HEAD, OPTIONS, PROPFIND',
        dav: '1',
        'content-length': 0,
      });
      response.end();
      return true;
    }

    sendError(response, new VfsError('Unsupported method ' + request.method, 405, 'METHOD_NOT_ALLOWED'));
    return true;
  };

  // Backwards-compatible callable: existing WebDAV dispatch treats the
  // factory return as a plain request handler. Expose the hydrator as a
  // property on the same callable so new code can reach it without breaking
  // existing call sites.
  handleTvWebDav.hydrateVfsTvEntry = hydrateVfsTvEntry;
  return handleTvWebDav;
}

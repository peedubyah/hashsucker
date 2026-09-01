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
  const status = error instanceof VfsError ? error.status : 500;
  const code = error instanceof VfsError ? error.code : 'INTERNAL_ERROR';
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
  now = () => Date.now(),
  fetchFn = fetch,
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
  // capability returns 429, mark the state as rate-limited. Subsequent
  // reads in the backoff window short-circuit BEFORE the seam is
  // invoked — no new requestdl, no upstream call.
  const MIN_READ_RETRY_AFTER_MS = 30_000; // 30s floor when upstream omits Retry-After.

  function gateRateLimited(state) {
    const rl = state?.rateLimited;
    if (!rl || !Number.isFinite(rl.until)) return null;
    if (now() >= rl.until) {
      state.rateLimited = null;
      return null;
    }
    return rl;
  }

  function markReadRateLimited(state, retryAfterMs) {
    if (!state) return;
    const until = now() + (Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? retryAfterMs
      : MIN_READ_RETRY_AFTER_MS);
    const existing = state.rateLimited;
    state.rateLimited = { until: Math.max(until, existing?.until || 0) };
  }

  async function openValidatedProviderRead(state, rangeHeader, validate) {
    let firstFailure = null;
    let sawReadRateLimit = false;
    // Bounded read-429 back-pressure: if a prior byte read against the
    // same playback handoff already returned 429 within the backoff
    // window, refuse the call without re-resolving requestdl and
    // without hitting the upstream URL again. The capability itself
    // remains valid — once the window expires the next read reuses it.
    const earlyGate = gateRateLimited(state);
    if (earlyGate) {
      const retryAfterSeconds = Math.max(1, Math.ceil((earlyGate.until - now()) / 1000));
      const error = new VfsError(
        'Provider byte reads are currently rate-limited',
        429,
        'PROVIDER_READ_RATE_LIMITED',
      );
      error.retryAfterMs = Math.max(0, earlyGate.until - now());
      error.retryAfterSeconds = retryAfterSeconds;
      throw error;
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const forceFresh = attempt === 1;
      const backing = await resolveBacking(state, { forceFresh });
      let upstream;
      try {
        upstream = await fetchProvider(backing, rangeHeader);
      } catch (error) {
        firstFailure ||= error;
        invalidateTorBoxCapability(backing);
        if (!forceFresh) continue;
        throw new VfsError('Provider read failed after fresh resolution', 502, 'PROVIDER_READ_FAILED');
      }

      const validationError = validate(upstream);
      if (!validationError) return { backing, upstream };
      await cancelBody(upstream);
      firstFailure ||= validationError;
      if (!forceFresh) {
        const readFailure = upstream.status === 429
          ? 'rate-limited'
          : STALE_PROVIDER_STATUSES.has(upstream.status) ? 'stale' : 'invalid';
        console.warn('[vfs-tv] provider=' + backing.provider + ' read=' + readFailure + ' status=' + upstream.status + ' release=' + state.entry.releaseKey);
        if (upstream.status !== 429) {
          // The cached capability (if any) just produced a stale or
          // invalid byte response — invalidate it so the retry resolves
          // fresh. Single-flight inside the cache prevents the retry
          // from stampeding requestdl.
          invalidateTorBoxCapability(backing);
          continue;
        }
        // Read 429 — the capability itself is still valid (not stale),
        // it is just currently being throttled by the upstream. Mark
        // the state rate-limited so concurrent and subsequent reads in
        // the backoff window short-circuit BEFORE the seam is invoked.
        // Do not invalidate the capability — after the window it should
        // be reused. Do not retry within this loop — the next call
        // after the window is the correct retry boundary.
        const upstreamRetryAfterMs = parseReadRetryAfter(upstream);
        markReadRateLimited(state, upstreamRetryAfterMs);
        sawReadRateLimit = true;
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
    let opened;
    try {
      opened = await openValidatedProviderRead(
        state,
        requestedRange?.header,
        (upstream) => {
          if (requestedRange) {
            const upstreamRange = parseContentRange(upstream.headers.get('content-range'));
            if (upstream.status !== 206) {
              return new VfsError('Provider did not honor the requested byte range', 502, 'PROVIDER_RANGE_FAILED');
            }
            if (!upstreamRange
              || upstreamRange.start !== requestedRange.start
              || upstreamRange.end !== requestedRange.end
              || upstreamRange.total !== metadata.size) {
              return new VfsError('Provider returned inconsistent range metadata', 502, 'PROVIDER_RANGE_MISMATCH');
            }
          } else if (upstream.status !== 200) {
            return new VfsError('Provider returned HTTP ' + upstream.status, 502, 'PROVIDER_READ_FAILED');
          }
          return null;
        },
      );
    } catch (error) {
      if (error instanceof VfsError && error.code === 'PROVIDER_READ_RATE_LIMITED') {
        sendError(response, error, { retryAfterSeconds: error.retryAfterSeconds ?? 1 });
        return;
      }
      throw error;
    }

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
      await finished(Readable.fromWeb(opened.upstream.body).pipe(response));
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

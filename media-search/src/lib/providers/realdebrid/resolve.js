/**
 * Real-Debrid resolver delivery.
 *
 * Attempts to deliver a selected candidate through Real-Debrid when:
 *   - the candidate has a fresh RD observation of `cached`, OR
 *   - the candidate has missing/stale RD observation (one bounded attempt)
 *
 * Behavior:
 *   - Fresh RD `cached` → attempt RD resolution directly
 *   - Fresh RD `uncached` + error_category=infringing → skip RD, use TorBox
 *   - Fresh RD ordinary uncached/unavailable → skip RD, use TorBox
 *   - Missing/stale RD observation → one bounded resolver-safe RD attempt
 *
 * File selection:
 *   - Never assumes RD file IDs equal corpus fileIndex.
 *   - Maps the intended candidate to RD's returned files using stored
 *     filename + size evidence.
 *   - Single-video-file torrents: the sole playable video is acceptable.
 *   - Multi-file torrents that cannot be mapped confidently → RD unusable.
 *
 * Safety:
 *   - All RD operations use resolver-safe mode (fail fast on cooldown).
 *   - RD problems never prevent playback when TorBox is usable.
 *   - Unrestricted URLs are never logged or persisted in telemetry.
 *   - Temporary RD torrents are deleted after resolution attempt.
 */

import { createCacheObservation } from '../observations.js';
import { RdCooldownError } from './client.js';
import { providerAccounting } from '../provider-accounting.js';

const RD_OBSERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const PLAYABLE_VIDEO_EXTENSIONS = new Set([
  '.mkv', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.m4v', '.mpg', '.mpeg', '.ts',
]);

/**
 * Error thrown when RD resolution fails but TorBox fallback is available.
 * The resolver catches this and falls through to TorBox.
 */
export class RdResolutionError extends Error {
  constructor(message, code, { rdStatus = null, rdErrorCode = null, category = 'unknown' } = {}) {
    super(message);
    this.name = 'RdResolutionError';
    this.code = code;
    this.rdStatus = rdStatus;
    this.rdErrorCode = rdErrorCode;
    this.category = category;
 }
}

/**
 * Determine if an RD observation is fresh (within TTL).
 */
function isFreshObservation(observation, now = Date.now()) {
  if (!observation) return false;
  if (observation.expiresAt != null) {
    return observation.expiresAt > now;
  }
  // No expiry: treat as fresh if within TTL of observedAt
  return (now - observation.observedAt) < RD_OBSERVATION_TTL_MS;
}

/**
 * Get the current RD observation for a candidate.
 * Returns the most recent RD observation, or null.
 */
function getCurrentRdObservation(searchCache, infoHash, fileIndex, now = Date.now()) {
  const observations = searchCache.getProviderObservations(infoHash, fileIndex, {
    includeStale: true,
  });
  const rdObs = observations.filter(o => o.provider === 'realdebrid');
  if (rdObs.length === 0) return null;
  // Return the most recent
  return rdObs.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
}

/**
 * Classify the RD observation state for resolver decision-making.
 * @returns {'cached'|'infringing'|'uncached'|'missing'}
 */
function classifyRdObservationState(observation, now = Date.now()) {
  if (!observation) return 'missing';
  if (!isFreshObservation(observation, now)) return 'missing';
  if (observation.state === 'cached') return 'cached';
  if (observation.errorCategory === 'infringing') return 'infringing';
  return 'uncached';
}

/**
 * Build a magnet URI from infoHash.
 */
function buildMagnetUri(infoHash) {
  return `magnet:?xt=urn:btih:${infoHash}`;
}

/**
 * Map the intended candidate to RD's returned files using stored metadata.
 *
 * Strategy:
 *   1. If RD reports exactly one playable video file → select it.
 *   2. If multiple files → match by filename (exact or basename) + size.
 *   3. If no confident match → return null (RD unusable).
 *
 * Accounting:
 *   Emits exactly one of realdebrid_file_{match,ambiguous,absent} under
 *   the 'realdebrid' provider bucket. The function is the sole producer
 *   of those three categories and is called only from attemptRdResolution.
 *
 * @param {Object} rdFiles - Array of RD file objects { id, path, bytes, selected }
 * @param {Object} candidateMetadata - { filename, size } from Hashsucker corpus
 * @returns {string|null} RD file ID to select, or null if no confident match.
 */
function mapCandidateToRdFile(rdFiles, candidateMetadata = {}) {
  const result = classifyCandidateToRdFile(rdFiles, candidateMetadata);
  // Accounting side effect: this function is the single source of truth
  // for the three file-mapping categories. Emit exactly one per call.
  providerAccounting.increment('realdebrid', `realdebrid_file_${result.classification}`);
  return result.rdFileId;
}

/**
 * Classify the candidate → RD-file mapping without accounting side effects.
 * Exported for tests that need to assert the classification without
 * polluting the live accounting counter.
 */
export function classifyCandidateToRdFile(rdFiles, candidateMetadata = {}) {
  if (!Array.isArray(rdFiles) || rdFiles.length === 0) {
    return { rdFileId: null, classification: 'absent' };
  }

  // Filter to playable video files
  const playableFiles = rdFiles.filter(f => {
    const path = (f.path || f.filename || '').toLowerCase();
    return Array.from(PLAYABLE_VIDEO_EXTENSIONS).some(ext => path.endsWith(ext));
  });

  if (playableFiles.length === 0) {
    return { rdFileId: null, classification: 'absent' };
  }

  // Single playable video file → select it
  if (playableFiles.length === 1) {
    return { rdFileId: String(playableFiles[0].id), classification: 'match' };
  }

  // Multiple files → attempt to match by filename + size
  const { filename, size } = candidateMetadata;
  if (filename) {
    const normalizedFilename = filename.toLowerCase();
    const basenameFilename = normalizedFilename.split('/').pop().split('\\').pop();

    // Try exact path match first
    const exactMatch = playableFiles.find(f => {
      const rdPath = (f.path || f.filename || '').toLowerCase();
      return rdPath === normalizedFilename || rdPath === basenameFilename;
    });
    if (exactMatch) {
      return { rdFileId: String(exactMatch.id), classification: 'match' };
    }

    // Try basename match
    const basenameMatch = playableFiles.find(f => {
      const rdPath = (f.path || f.filename || '').toLowerCase();
      const rdBasename = rdPath.split('/').pop().split('\\').pop();
      return rdBasename === basenameFilename;
    });
    if (basenameMatch) {
      // If size also matches, we're confident
      if (size != null && basenameMatch.bytes != null && basenameMatch.bytes === size) {
        return { rdFileId: String(basenameMatch.id), classification: 'match' };
      }
      // Without size confirmation, only match if it's the only basename match
      const allBasenameMatches = playableFiles.filter(f => {
        const rdPath = (f.path || f.filename || '').toLowerCase();
        const rdBasename = rdPath.split('/').pop().split('\\').pop();
        return rdBasename === basenameFilename;
      });
      if (allBasenameMatches.length === 1) {
        return { rdFileId: String(allBasenameMatches[0].id), classification: 'match' };
      }
      // Multiple basename matches with the same name but different sizes
      // (or the same name without size confirmation) → ambiguous. Fail closed.
      return { rdFileId: null, classification: 'ambiguous' };
    }
  }

  // Size-only match if filename didn't work
  if (size != null) {
    const sizeMatches = playableFiles.filter(f => f.bytes === size);
    if (sizeMatches.length === 1) {
      return { rdFileId: String(sizeMatches[0].id), classification: 'match' };
    }
    if (sizeMatches.length > 1) {
      // Multiple files of the exact authoritative size → ambiguous.
      return { rdFileId: null, classification: 'ambiguous' };
    }
  }

  // Cannot map confidently (no filename match, no size match) → absent.
  return { rdFileId: null, classification: 'absent' };
}

/**
 * Check if RD should attempt resolution for this candidate.
 * Returns the observation state that determines behavior.
 */
export function getRdObservationState(searchCache, infoHash, fileIndex, now = Date.now()) {
  const observation = getCurrentRdObservation(searchCache, infoHash, fileIndex, now);
  return classifyRdObservationState(observation, now);
}

/**
 * Attempt RD resolution for a candidate.
 *
 * @param {Object} client - RD client (from createRealDebridClient)
 * @param {Object} searchCache - Discovery cache for observation persistence
 * @param {Object} candidate - { infoHash, fileIndex, filename, size }
 * @param {Object} [options]
 * @param {Function} [options.now] - Clock function
 * @returns {Promise<{ status: 'resolved', rdFileId: string } | { status: 'skipped', reason: string } | { status: 'failed', error: RdResolutionError }>}
 */
export async function attemptRdResolution(client, searchCache, candidate, options = {}) {
  const { now = () => Date.now() } = options;
  const { infoHash, fileIndex, filename, size } = candidate;

  // Accounting: every entry into attemptRdResolution counts as a fallback
  // attempt. The result category (resolved/failed) is decided below and
  // recorded at each return site.
  providerAccounting.increment('realdebrid', 'realdebrid_fallback_attempted');

  // Check current RD observation state
  const observationState = getRdObservationState(searchCache, infoHash, fileIndex, now());

  // Fresh infringing → skip RD entirely
  if (observationState === 'infringing') {
    providerAccounting.increment('realdebrid', 'realdebrid_fallback_failed');
    return { status: 'skipped', reason: 'infringing' };
  }

  // Fresh uncached/unavailable → skip RD
  if (observationState === 'uncached') {
    providerAccounting.increment('realdebrid', 'realdebrid_fallback_failed');
    return { status: 'skipped', reason: 'uncached' };
  }

  // For cached or missing/stale: attempt RD resolution (resolver-safe)
  // If cooldown is active, this will fail fast
  let torrentId = null;
  const rdTiming = {};
  try {
    // Step 1: Add magnet
    const magnetUri = buildMagnetUri(infoHash);
    const t0 = now();
    const addResult = await client.addMagnet(magnetUri, { resolverSafe: true });
    rdTiming.addMagnet = now() - t0;
    torrentId = addResult.id;

    // Step 2: Get torrent info to see files
    const t1 = now();
    const torrentInfo = await client.getTorrentInfo(torrentId, { resolverSafe: true });
    rdTiming.getTorrentInfo1 = now() - t1;
    const rdFiles = torrentInfo.files || [];

    // Step 3: Map candidate to RD file
    const rdFileId = mapCandidateToRdFile(rdFiles, { filename, size });
    if (!rdFileId) {
      providerAccounting.increment('realdebrid', 'realdebrid_fallback_failed');
      return {
        status: 'failed',
        error: new RdResolutionError(
          'Cannot map candidate to RD file confidently',
          'RD_FILE_MAPPING_FAILED',
        ),
      };
    }

    // Step 4: Select the file
    const t2 = now();
    await client.selectFiles(torrentId, rdFileId, { resolverSafe: true });
    rdTiming.selectFiles = now() - t2;

    // Step 5: Check status from first getTorrentInfo (cached torrents show "downloaded" immediately)
    // For cached torrents, no need to re-fetch - status doesn't change after file selection
    const rdStatus = torrentInfo.status || '';
    rdTiming.firstStatus = rdStatus;

    let finalTorrentInfo = torrentInfo;

    // Step 6: If not yet downloaded, re-fetch to check status after selection
    if (rdStatus !== 'downloaded') {
      const t3 = now();
      const updatedInfo = await client.getTorrentInfo(torrentId, { resolverSafe: true });
      rdTiming.getTorrentInfo2 = now() - t3;
      const updatedStatus = updatedInfo.status || '';

      if (updatedStatus === 'downloaded') {
        finalTorrentInfo = updatedInfo;
      } else {
        // Torrent not yet cached — persist the actual state
        const classification = classifyRdFileStatus(updatedStatus);
        persistRdObservation(searchCache, infoHash, fileIndex, classification.result, {
          rdStatus: classification.rdStatus,
          rdErrorCode: classification.rdErrorCode,
          source: 'resolver:rd-resolution',
        });
        providerAccounting.increment('realdebrid', 'realdebrid_fallback_failed');
        return {
          status: 'failed',
          error: new RdResolutionError(
            `RD torrent not cached (status: ${updatedStatus})`,
            'RD_FILE_NOT_CACHED',
            { rdStatus: updatedStatus, category: classification.category },
          ),
        };
      }
    }

    // Torrent is downloaded - persist RD cached observation
    persistRdObservation(searchCache, infoHash, fileIndex, 'cached', {
      rdStatus: 'downloaded',
      rdErrorCode: null,
      source: 'resolver:rd-resolution',
    });

    // Return the torrent info so the caller can get the playback URL
    // BEFORE the torrent is deleted
    providerAccounting.increment('realdebrid', 'realdebrid_fallback_resolved');
    return { status: 'resolved', rdFileId, torrentId, torrentInfo: finalTorrentInfo, timing: rdTiming };
  } catch (error) {
    // Handle cooldown (fail fast)
    if (error instanceof RdCooldownError) {
      providerAccounting.increment('realdebrid', 'realdebrid_fallback_failed');
      return {
        status: 'failed',
        error: new RdResolutionError(
          'RD cooldown active, failing fast',
          'RD_COOLDOWN',
          { category: 'rate-limit' },
        ),
      };
    }

    // Handle infringing
    if (error.rdErrorCode === 35 || error.category === 'infringing') {
      persistRdObservation(searchCache, infoHash, fileIndex, 'uncached', {
        rdStatus: 'infringing_file',
        rdErrorCode: 35,
        errorCategory: 'infringing',
        source: 'resolver:rd-resolution',
      });
      providerAccounting.increment('realdebrid', 'realdebrid_fallback_failed');
      return {
        status: 'failed',
        error: new RdResolutionError(
          'RD reports infringing file',
          'RD_INFRINGING',
          { rdStatus: 'infringing_file', rdErrorCode: 35, category: 'infringing' },
        ),
      };
    }

    // Handle unavailable/not-found
    if (error.category === 'not-found' || error.category === 'unavailable') {
      persistRdObservation(searchCache, infoHash, fileIndex, 'uncached', {
        rdStatus: error.rdError || 'unavailable',
        rdErrorCode: error.rdErrorCode,
        source: 'resolver:rd-resolution',
      });
      providerAccounting.increment('realdebrid', 'realdebrid_fallback_failed');
      return {
        status: 'failed',
        error: new RdResolutionError(
          `RD file unavailable: ${error.message}`,
          'RD_UNAVAILABLE',
          { category: error.category },
        ),
      };
    }

    // Generic RD error
    providerAccounting.increment('realdebrid', 'realdebrid_fallback_failed');
    return {
      status: 'failed',
      error: new RdResolutionError(
        `RD resolution failed: ${error.message}`,
        'RD_ERROR',
        { category: error.category || 'unknown', rdErrorCode: error.rdErrorCode },
      ),
    };
  } finally {
    // Always clean up the temporary RD torrent
    if (torrentId) {
      try {
        await client.deleteTorrent(torrentId, { resolverSafe: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Persist an RD observation through the existing provider observation path.
 */
function persistRdObservation(searchCache, infoHash, fileIndex, result, details = {}) {
  try {
    const observation = createCacheObservation({
      provider: 'realdebrid',
      infoHash,
      fileIndex,
      scope: 'candidate',
      kind: 'authoritative',
      state: result === 'cached' ? 'cached' : 'uncached',
      observedAt: Date.now(),
      ttlMs: RD_OBSERVATION_TTL_MS,
      source: details.source || 'resolver:rd-resolution',
      errorCategory: details.errorCategory || null,
      evidence: {
        provider: 'realdebrid',
        rdStatus: details.rdStatus || null,
        rdErrorCode: details.rdErrorCode || null,
        classification: result,
      },
    });
    searchCache.appendProviderObservation(observation);
  } catch (obsError) {
    // Observation persistence must never block resolution
    console.error(`[RD resolve] observation persistence failed: ${obsError.message}`);
  }
}

/**
 * Classify RD file status for observation persistence.
 */
function classifyRdFileStatus(rdStatus) {
  switch (rdStatus) {
    case 'downloaded':
      return { result: 'cached', rdStatus: 'downloaded', category: null, rdErrorCode: null };
    case 'downloading':
    case 'queued':
      return { result: 'uncached', rdStatus, category: null, rdErrorCode: null };
    case 'magnet_conversion':
    case 'waiting_files_selection':
    case 'dead':
      return { result: 'uncached', rdStatus, category: 'unavailable', rdErrorCode: null };
    default:
      return { result: 'uncached', rdStatus, category: null, rdErrorCode: null };
  }
}

/**
 * Get the unrestricted playback URL for a selected RD file.
 *
 * RD returns links at the torrent level (torrentInfo.links), not file level.
 * Each link corresponds to a selected file. We map the link to the file
 * by index or by matching the link to the file ID.
 *
 * @param {Object} client - RD client
 * @param {Object} torrentInfo - RD torrent info with links array
 * @param {string} rdFileId - The selected RD file ID
 * @returns {Promise<string>} The unrestricted download URL
 */
export async function getRdPlaybackUrl(client, torrentInfo, rdFileId) {
  // RD returns links at the torrent level
  const links = torrentInfo.links || [];
  if (links.length === 0) {
    throw new RdResolutionError('RD torrent has no hoster links', 'RD_NO_LINK');
  }

  // If there's only one link, use it
  // If there are multiple links, we need to map to the correct file
  // RD API: links array corresponds to selected files in order
  let link = links[0];
  if (links.length > 1) {
    // Multiple links — try to find the one matching our file
    // RD doesn't provide file-to-link mapping directly, but the links
    // array is ordered the same as the selected files array
    const selectedFileIndex = (torrentInfo.files || []).findIndex(f => String(f.id) === rdFileId);
    if (selectedFileIndex >= 0 && selectedFileIndex < links.length) {
      link = links[selectedFileIndex];
    } else {
      // Fallback: use the first link
      link = links[0];
    }
  }

  // Unrestrict the link
  const unrestricted = await client.unrestrictLink(link, null, { resolverSafe: true });
  if (!unrestricted || !unrestricted.download) {
    throw new RdResolutionError('RD unrestrict returned no download URL', 'RD_UNRESTRICT_FAILED');
  }

  return unrestricted.download;
}

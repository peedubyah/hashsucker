/**
 * Real-Debrid observation persistence.
 *
 * Maps RD cache-probe outcomes to Hashsucker's existing provider observation
 * path. Reuses `provider_observation_events` and `provider_observation_current`
 * — no new tables, no new conventions.
 *
 * Outcome normalization:
 *   - cached      — selected file immediately reached `downloaded`
 *   - uncached    — selected file entered queued/downloading
 *   - infringing  — RD error code 35 (NOT collapsed into uncached)
 *   - unavailable — explicit unavailable/not-found/not-allowed/dead
 *   - error       — provider/network/rate-limit failure
 *
 * Evidence preserved: RD status, RD numeric error code, source, latency.
 * Never persisted: API key, unrestricted URLs, temporary RD torrent IDs.
 */

import { createCacheObservation } from '../observations.js';

const RD_OBSERVATION_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Map RD torrent status to a cache observation state.
 * @param {string} status - RD status string (e.g., 'downloaded', 'queued').
 * @returns {'cached'|'uncached'|'unavailable'|null}
 */
function classifyRdStatus(status) {
  if (status === 'downloaded') return 'cached';
  if (status === 'queued' || status === 'downloading') return 'uncached';
  if (status === 'dead' || status === 'virus') return 'unavailable';
  return null;
}

/**
 * Build a cache observation from an RD probe outcome.
 *
 * @param {Object} outcome
 * @param {string} outcome.infoHash - Candidate infoHash.
 * @param {number|null} outcome.fileIndex - Candidate fileIndex (null for torrent-level).
 * @param {'cached'|'uncached'|'infringing'|'unavailable'|'error'} outcome.result - Final classification.
 * @param {string} [outcome.rdStatus] - Raw RD torrent status.
 * @param {number} [outcome.rdErrorCode] - RD numeric error code.
 * @param {string} [outcome.source] - Observation source tag.
 * @param {number} [outcome.latencyMs] - Probe latency.
 * @param {number} [outcome.now] - Observation timestamp.
 * @returns {Object} Cache observation (frozen).
 */
export function buildRdObservation({
  infoHash,
  fileIndex = null,
  result,
  rdStatus = null,
  rdErrorCode = null,
  source = 'realdebrid:cache-probe',
  latencyMs = null,
  now = Date.now(),
}) {
  if (!infoHash || typeof infoHash !== 'string') {
    throw new TypeError('infoHash is required');
  }

  let state;
  let errorCategory = null;
  let retryable = null;

  switch (result) {
    case 'cached':
      state = 'cached';
      break;
    case 'uncached':
      state = 'uncached';
      break;
    case 'infringing':
      state = 'uncached';
      errorCategory = 'infringing';
      retryable = false;
      break;
    case 'unavailable':
      state = 'uncached';
      errorCategory = 'unsupported';
      retryable = false;
      break;
    case 'error':
      state = 'error';
      errorCategory = 'unknown';
      retryable = true;
      break;
    default:
      throw new TypeError(`Unknown RD observation result: ${result}`);
  }

  // Build safe evidence — no URLs, no credentials, no temp IDs
  const evidence = {
    provider: 'realdebrid',
    rdStatus: rdStatus || null,
    rdErrorCode: rdErrorCode || null,
    classification: result,
  };

  return createCacheObservation({
    provider: 'realdebrid',
    accountScope: 'default',
    scope: fileIndex == null ? 'torrent' : 'candidate',
    subjectType: fileIndex == null ? 'torrent' : 'candidate',
    subjectKey: infoHash,
    infoHash,
    fileIndex,
    kind: 'authoritative',
    state,
    observedAt: now,
    expiresAt: now + RD_OBSERVATION_TTL_MS,
    source,
    evidence,
    errorCategory,
    retryable,
    latencyMs,
    retryAfterMs: null,
    correlationId: null,
  });
}

/**
 * Probe a single hash through Real-Debrid and persist the outcome.
 *
 * @param {Object} client - Real-Debrid client (createRealDebridClient).
 * @param {Object} cache - Discovery cache (createDiscoveryCache).
 * @param {Object} options
 * @param {string} options.infoHash - Info hash to probe.
 * @param {number} [options.now] - Timestamp for observation.
 * @returns {Object} { observation, rdInfo, classification }
 */
export async function probeAndPersist(client, cache, { infoHash, now = Date.now() } = {}) {
  if (!client || !cache) {
    throw new TypeError('client and cache are required');
  }

  const magnetUri = `magnet:?xt=urn:btih:${infoHash}`;
  let torrentId = null;
  let startTime = Date.now();
  let rdStatus = null;
  let rdErrorCode = null;
  let classification;
  let observation;

  try {
    // Add magnet
    const addResult = await client.addMagnet(magnetUri);
    torrentId = addResult.id;

    // Get torrent info
    const info = await client.getTorrentInfo(torrentId);
    rdStatus = info.status;

    if (info.files && info.files.length > 0) {
      // Select primary video file (largest > 1MB)
      const videoFile = info.files
        .filter(f => f.bytes > 1000000)
        .sort((a, b) => b.bytes - a.bytes)[0];

      if (videoFile) {
        await client.selectFiles(torrentId, String(videoFile.id));

        // Re-fetch status after selection
        const info2 = await client.getTorrentInfo(torrentId);
        rdStatus = info2.status;
        classification = classifyRdStatus(info2.status) || 'error';
      } else {
        classification = 'error';
      }
    } else {
      classification = 'error';
    }
  } catch (error) {
    rdErrorCode = error.rdErrorCode ?? null;
    rdStatus = rdStatus || error.rdError || null;

    if (rdErrorCode === 35) {
      classification = 'infringing';
    } else if (error.category === 'unsupported' || error.category === 'not-found') {
      classification = 'unavailable';
    } else {
      classification = 'error';
    }
  } finally {
    // Always delete
    if (torrentId) {
      try {
        await client.deleteTorrent(torrentId);
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  // Build and persist observation
  const latencyMs = Date.now() - startTime;
  observation = buildRdObservation({
    infoHash,
    result: classification,
    rdStatus,
    rdErrorCode,
    latencyMs,
    now,
  });

  cache.appendProviderObservation(observation);

  return { observation, classification, rdStatus, rdErrorCode, latencyMs };
}

import { buildPlaybackHandoff } from '../discovery/playback-handoff.js';
import { publishStrm as defaultPublishStrm } from './strm-publisher.js';

/**
 * Commit an operator-selected release to the virtual library.
 *
 * Selection is already complete when this function runs. It deliberately does
 * not discover, rank, download, or enqueue the release. The exact release is
 * persisted as resolver state before its stable .strm artifact is published.
 *
 * Slice 1.75: `release.size` is a verbatim pass-through of the operator HTTP
 * body's `body.release.size` (validateSupportedRequest, app.js:1138). It is
 * the operator's typed claim of the selected physical file byte count, but
 * there is NO in-process producer that derives it from a verified TorBox
 * provider file — it is whatever the operator chose to type. Integer-ness
 * alone is not authoritative provenance, so fulfillVirtualSelection
 * intentionally does NOT bind selectedFileSize from release.size. Instead,
 * selectedFileSize is hard-coded to null on the operator path: the
 * pre-publication identity helper is skipped, and the handoff is persisted
 * with torrentFileId=null. The exact-size identity seam is reserved for
 * live-discovery candidates that carry a strict behaviorHints.videoSize.
 */
export async function fulfillVirtualSelection({
  cache,
  intent,
  release,
  publishStrm = defaultPublishStrm,
  ensureTorBoxFileIdentity,
}) {
  if (!cache) throw new Error('discovery cache is required');
  if (!intent) throw new Error('request intent is required');
  if (!release) throw new Error('selected release is required');

  const mediaType = intent.streamType;
  const episode = intent.episodes?.[0] ?? null;
  const filename = release.filename || release.title || release.releaseKey;
  const identity = {
    tier: 'operator-selected',
    confidence: 1,
    evidence: ['explicit operator selection'],
    state: 'selected',
    eligible: true,
  };
  // Slice 1.75: see provenance comment above. The operator path does NOT
  // bind selectedFileSize from release.size — the operator's typed value
  // has no verified producer and is not authoritative for TorBox file
  // identity. selectedFileSize is null on this path; the pre-publication
  // identity helper is skipped and the handoff is persisted with
  // torrentFileId=null.
  const selectedFileSize = null;
  const persistedCandidate = {
    rank: 1,
    infoHash: release.infoHash,
    fileIndex: release.fileIndex,
    filename,
    score: 1,
    scoreBreakdown: { operatorSelection: 1 },
    identity,
    release: {
      ...release,
      releaseKey: release.releaseKey,
    },
    rankingBreakdown: { policy: 'explicit-operator-selection' },
    selectedFileSize,
  };

  const requestId = cache.persistMediaRequest({
    mediaId: intent.mediaId,
    mediaType,
    season: intent.season,
    episode,
    source: 'operator-api',
    sourceType: 'virtual-library',
  }, [persistedCandidate]);

  const selection = {
    selected: {
      infoHash: release.infoHash,
      fileIndex: release.fileIndex,
      filename,
      torboxState: 'unknown',
      identityTier: identity.tier,
      selectedFileSize,
      release: { resolution: release.resolution || null },
    },
    reason: 'explicit operator selection',
  };

  // Slice 1.75: pre-publication identity binding.
  let torrentFileIdentity = null;
  let torrentFileId = null;
  if (typeof ensureTorBoxFileIdentity === 'function' && selectedFileSize != null) {
    try {
      const bound = await ensureTorBoxFileIdentity({
        infoHash: release.infoHash,
        selectedFileSize,
        releaseKey: release.releaseKey,
      });
      torrentFileId = bound?.torrentFileId ?? null;
      torrentFileIdentity = {
        status: 'bound',
        placementId: bound?.placementId ?? null,
        providerFileId: bound?.providerFileId ?? null,
        size: bound?.size ?? null,
        selectedFileSize,
      };
    } catch (error) {
      torrentFileIdentity = {
        status: 'unbound',
        code: error?.code || 'BINDING_ERROR',
        reason: error?.message || String(error),
        selectedFileSize,
      };
    }
  } else if (typeof ensureTorBoxFileIdentity === 'function') {
    torrentFileIdentity = { status: 'skipped', reason: 'operator-path-no-exact-size' };
  }

  const handoff = buildPlaybackHandoff(selection, {
    requestId,
    mediaId: intent.mediaId,
    mediaType,
    season: intent.season,
    episode,
    ...(torrentFileId ? { torrentFileId } : {}),
  });

  if (!handoff) {
    throw new Error('Selected release could not be committed for playback');
  }
  if (torrentFileIdentity) {
    handoff.torrentFileIdentity = torrentFileIdentity;
  }

  cache.persistPlaybackHandoff(handoff);
  const strm = await publishStrm({ handoff, selection });

  return {
    mediaRequestId: Number(requestId),
    handoff,
    strm,
  };
}

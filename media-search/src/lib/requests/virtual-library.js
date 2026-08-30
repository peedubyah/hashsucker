import { buildPlaybackHandoff } from '../discovery/playback-handoff.js';
import { publishStrm as defaultPublishStrm } from './strm-publisher.js';

/**
 * Commit an operator-selected release to the virtual library.
 *
 * Selection is already complete when this function runs. It deliberately does
 * not discover, rank, download, or enqueue the release. The exact release is
 * persisted as resolver state before its stable .strm artifact is published.
 */
export async function fulfillVirtualSelection({
  cache,
  intent,
  release,
  publishStrm = defaultPublishStrm,
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
      release: { resolution: release.resolution || null },
    },
    reason: 'explicit operator selection',
  };
  const handoff = buildPlaybackHandoff(selection, {
    requestId,
    mediaId: intent.mediaId,
    mediaType,
    season: intent.season,
    episode,
  });

  if (!handoff) {
    throw new Error('Selected release could not be committed for playback');
  }

  cache.persistPlaybackHandoff(handoff);
  const strm = await publishStrm({ handoff, selection });

  return {
    mediaRequestId: Number(requestId),
    handoff,
    strm,
  };
}

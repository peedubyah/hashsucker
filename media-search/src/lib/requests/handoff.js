import crypto from 'node:crypto';

import { validateReleaseIdentity } from '../../api/release-contract.js';
import { emit, EVENTS } from '../../lib/trace/events.js';
import { inc } from '../../lib/metrics.js';

export const HANDLING_MODES = ['download', 'stream'];

export function createHandoff({
  intent,
  release,
  provider = 'torbox',
  handlingMode = 'download',
}) {
  if (!intent) {
    throw new Error('intent is required');
  }

  const identity = validateReleaseIdentity(release);

  if (!['torbox', 'realdebrid', 'auto'].includes(provider)) {
    throw new Error(`Invalid provider: ${provider}`);
  }

  if (!HANDLING_MODES.includes(handlingMode)) {
    throw new Error(`Invalid handling mode: ${handlingMode}`);
  }

  const handoff = {
    version: 1,

    requestId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),

    provider,
    handlingMode,

    intent: {
      mediaType: intent.mediaType,
      streamType: intent.streamType,
      scope: intent.scope,

      mediaId: intent.mediaId,
      baseMediaId: intent.baseMediaId,

      season: intent.season,
      episodes: intent.episodes,
    },

    release: {
      ...identity,
      title: release.title || null,
      filename: release.filename || null,
      size: release.size ?? null,

      resolution: release.resolution || null,
      quality: release.quality || null,
      codec: release.codec || null,
      hdr: release.hdr || null,
    },
  };

  inc('requests_created_total');
  if (handlingMode === 'stream') {
    inc('stream_success_total'); // Optimistic — will be decremented on failure
  } else {
    inc('download_success_total');
  }

  emit(EVENTS.HANDOFF_CREATED, {
    requestId: handoff.requestId,
    mediaId: intent.mediaId,
    releaseKey: identity.releaseKey,
    provider,
    handlingMode,
  });

  return handoff;
}
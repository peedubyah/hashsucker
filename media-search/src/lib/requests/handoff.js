import crypto from 'node:crypto';

import { validateReleaseIdentity } from '../../api/release-contract.js';

export function createHandoff({
  intent,
  release,
  provider = 'torbox',
}) {
  if (!intent) {
    throw new Error('intent is required');
  }

  const identity = validateReleaseIdentity(release);

  if (!['torbox', 'realdebrid', 'auto'].includes(provider)) {
    throw new Error(`Invalid provider: ${provider}`);
  }

  return {
    version: 1,

    requestId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),

    provider,

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
}
/**
 * THE PROJECTION AUDIT — what SHOULD exist in the consumers, and what
 * DOES.
 *
 * For every published media intent, the audit derives the desired consumer
 * projection from HashSucker's durable truth alone, observes what each
 * consumer actually holds, and classifies the difference.
 *
 * It reads no consumer to decide anything: the consumer is observed, and
 * the observation is compared. The classification is the whole output, and
 * it is what makes "the consumer is missing our projection" distinguishable
 * from "the media is missing" — the two used to be the same sentence.
 *
 * The audit performs NO repair. Repair is a separate, explicit action
 * (`repairConsumerProjection`), because "what is wrong" and "what to do
 * about it" are different questions, and one of them can be automatic
 * while the other cannot.
 */

import { desiredProjection } from './desired-projection.js';
import { classifyConsumerProjection } from '../requests/projection-repair.js';

/**
 * The desired projection for one library item, derived from durable truth.
 *
 * @param {Object} params
 * @param {Object} params.store - the control-plane store
 * @param {Object} params.cache - the discovery cache
 * @param {Object} params.item - the library item
 * @param {Object} [params.env]
 * @returns {Object} the desired projection
 */
export function desiredProjectionForItem({ store, cache, item, env = process.env }) {
  const presentation = store.getPresentationIdentity?.(item.id) ?? null;
  const vfsEntry = item.season != null && item.episode != null
    ? cache.getVfsTvEntry?.(item.mediaId, item.season, item.episode) ?? null
    : cache.getVfsMovieEntry?.(item.mediaId) ?? null;
  const binding = store.getActiveBindingForLibraryItem?.(item.id) ?? null;
  const torrentFile = binding?.torrentFile ?? null;
  return desiredProjection({
    item: {
      mediaId: item.mediaId,
      mediaType: item.mediaType,
      season: item.season ?? null,
      episode: item.episode ?? null,
    },
    presentation,
    vfsEntry,
    binding,
    torrentFile,
    env,
  });
}

/**
 * Audit the projection of every published media intent.
 *
 * @param {Object} params
 * @param {Object} params.store
 * @param {Object} params.cache
 * @param {Object} [params.env]
 * @param {number} [params.limit]
 * @param {Function} [params.observe] - the observer (injectable for tests)
 * @returns {Promise<Object>} the audit report
 */
export async function auditProjections({
  store,
  cache,
  env = process.env,
  limit = 500,
  observe = null,
} = {}) {
  const items = (store.listAllLibraryItems?.({ limit: 5000 }) ?? [])
    .filter((item) => item.desiredState !== 'absent')
    .slice(0, Math.max(1, Math.trunc(limit)));
  const rows = [];
  const summary = {};
  for (const item of items) {
    const desired = desiredProjectionForItem({ store, cache, item, env });
    if (!desired.complete) {
      summary.incomplete = (summary.incomplete ?? 0) + 1;
      rows.push({
        mediaId: item.mediaId,
        mediaType: item.mediaType,
        season: item.season,
        episode: item.episode,
        state: 'incomplete',
        detail: 'durable-truth-incomplete',
      });
      continue;
    }
    const plex = observe
      ? await observe(desired)
      : await classifyConsumerProjection({ desired, consumer: 'plex' });
    const state = plex.state;
    summary[state] = (summary[state] ?? 0) + 1;
    rows.push({
      mediaId: item.mediaId,
      mediaType: item.mediaType,
      season: item.season,
      episode: item.episode,
      title: desired.presentation.title,
      canonicalPath: desired.presentation.canonicalPath,
      strmPath: desired.presentation.strmPath,
      torrentFileId: desired.representation.torrentFileId,
      size: desired.representation.size,
      expectedPartFile: desired.desired.plex.partFile,
      expectedPartSize: desired.desired.plex.partSize,
      consumer: 'plex',
      consumerItemId: plex.itemId ?? null,
      observedPartFile: plex.partFile ?? null,
      observedPartSize: plex.partSize ?? null,
      state,
      repairable: plex.repairable === true,
      detail: plex.detail ?? null,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    summary,
    total: rows.length,
    rows,
  };
}

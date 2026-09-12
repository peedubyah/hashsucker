/**
 * Consumer reconciliation pass.
 *
 * Enumerates published HashSucker library items, queries each configured
 * consumer adapter once (batched list calls, never per-item requests),
 * maps consumer rows back to (mediaId [+ season/episode]), and records
 * durable presence/absence/UNKNOWN observations. Optionally executes
 * retirement for ELIGIBLE items when the policy enables it (default OFF).
 *
 * Idempotent. Bounded API pressure: one list sequence per consumer per
 * pass. A failed consumer marks every item UNKNOWN for that consumer —
 * never absence.
 */

import { listLibrary } from '../library/listing.js';
import { evaluateRetirement, readRetirementPolicy } from './eligibility.js';
import { jellyfinAdapter } from './jellyfin.js';
import { plexAdapter } from './plex.js';
import { unpublishMedia } from '../library/unpublish.js';

export function defaultAdapters() {
  return [jellyfinAdapter, plexAdapter];
}

function adapterEnabled(name, env = process.env) {
  if (name === 'jellyfin') {
    const flag = String(env.CONSUMER_JELLYFIN_ENABLED ?? '').toLowerCase();
    if (flag === '0' || flag === 'false') return false;
    return Boolean(env.JELLYFIN_URL && env.JELLYFIN_API_KEY);
  }
  if (name === 'plex') {
    const flag = String(env.CONSUMER_PLEX_ENABLED ?? '').toLowerCase();
    if (flag === '0' || flag === 'false') return false;
    return Boolean(env.PLEX_URL && env.PLEX_TOKEN);
  }
  return false;
}

function matchKey(mediaId, season, episode) {
  return `${mediaId}|${season ?? ''}|${episode ?? ''}`;
}

/**
 * @returns {Promise<Object>} pass summary (counts + per-item outcomes)
 */
export async function runReconcile({
  cache,
  controlPlaneStore,
  adapters = null,
  policy = null,
  now = Date.now(),
  execute = null,
  env = process.env,
} = {}) {
  const effectivePolicy = policy ?? readRetirementPolicy(env);
  const list = adapters ?? defaultAdapters().filter((a) => adapterEnabled(a.name, env));
  const { items } = listLibrary({ cache, controlPlaneStore, limit: 500 });
  const published = items.filter((i) => i.state === 'published');

  const observations = [];
  for (const adapter of list) {
    try {
      const rows = await adapter.listLibrary();
      const byKey = new Map();
      for (const r of rows) {
        byKey.set(matchKey(r.mediaId, r.season ?? null, r.episode ?? null), r);
      }
      for (const item of published) {
        const hit = byKey.get(matchKey(item.mediaId, item.season, item.episode)) ?? null;
        const record = {
          consumer: adapter.name,
          mediaType: item.mediaType,
          mediaId: item.mediaId,
          season: item.season,
          episode: item.episode,
          present: hit ? 1 : 0,
          consumerItemId: hit?.consumerItemId ?? null,
          source: 'reconcile-list',
          now,
        };
        controlPlaneStore.recordConsumerObservation(record);
        observations.push({ ...record, lastCheckedAt: now });
      }
    } catch (error) {
      // Unreachable/unconfigured consumer: UNKNOWN for every published
      // item. Fail closed, keep going with the next consumer.
      for (const item of published) {
        const record = {
          consumer: adapter.name,
          mediaType: item.mediaType,
          mediaId: item.mediaId,
          season: item.season,
          episode: item.episode,
          present: null,
          consumerItemId: null,
          source: `reconcile-error:${error?.message ?? 'unknown'}`.slice(0, 120),
          now,
        };
        try {
          controlPlaneStore.recordConsumerObservation(record);
        } catch {
          // Observation write must never break the pass.
        }
        observations.push({ ...record, lastCheckedAt: now });
      }
    }
  }

  const shouldExecute = execute ?? effectivePolicy.enabled;
  const outcomes = [];
  for (const item of published) {
    const rows = controlPlaneStore.listConsumerObservations({
      mediaId: item.mediaId,
    }).filter((o) => (o.season ?? null) === (item.season ?? null)
      && (o.episode ?? null) === (item.episode ?? null));
    const evalResult = evaluateRetirement(item, rows, effectivePolicy, now);
    const outcome = {
      mediaId: item.mediaId,
      season: item.season,
      episode: item.episode,
      state: item.state,
      presence: evalResult.presence,
      absenceAgeMs: evalResult.absenceAgeMs,
      eligible: evalResult.eligible,
      reason: evalResult.reason,
      retired: false,
    };
    if (evalResult.eligible && shouldExecute) {
      try {
        await unpublishMedia({
          cache,
          controlPlaneStore,
          mediaId: item.mediaId,
          mediaType: item.mediaType,
          season: item.season,
          episode: item.episode,
        });
        outcome.retired = true;
      } catch (error) {
        outcome.retired = false;
        outcome.reason = `RETIRE_FAILED:${error?.message ?? 'unknown'}`.slice(0, 160);
      }
    }
    outcomes.push(outcome);
  }
  const retired = outcomes.filter((o) => o.retired).length;
  return {
    at: now,
    published: published.length,
    consumers: list.map((a) => a.name),
    eligible: outcomes.filter((o) => o.eligible).length,
    retired,
    executed: shouldExecute,
    outcomes,
  };
}

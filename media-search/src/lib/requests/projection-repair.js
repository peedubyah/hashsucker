/**
 * PROJECTION REPAIR — make the consumer hold what our durable truth says
 * it should hold.
 *
 * The repair is deliberately narrow, because everything else in the system
 * is forbidden here:
 *
 *   - no media reselection (the Binding and the TorrentFile are read-only);
 *   - no provider acquisition (nothing is downloaded or cached);
 *   - no presentation rename (the committed identity is read-only);
 *   - no Binding mutation.
 *
 * What it DOES do is ask the consumer to look again, at the exact
 * directory that holds our artifact, and then observe what the consumer
 * holds. That is the whole vocabulary of a projection repair: the durable
 * truth was already right, the consumer was behind.
 *
 * The repair classes:
 *
 *   aligned      the consumer holds exactly what it should — nothing to do
 *   missing      the consumer holds nothing — refresh the exact directory
 *   stale-path   the consumer's Part points at another file — refresh
 *   stale-size   the consumer's Part has another size — refresh
 *   conflicted   the consumer holds several items for one intent — NOT
 *                repairable here: choosing one is an operator decision
 *   unknown      the consumer could not be observed — NOT repairable: no
 *                absence was proven
 */

import { classifyProjection, PROJECTION_STATES } from '../control-plane/desired-projection.js';
import { observePlexProjection } from '../consumers/projection-observer.js';
import { notifyPlex } from './plex-notifier.js';
import { opportunisticIngestConfirm } from './plex-ingest.js';

/**
 * Observe what a consumer holds for one media intent.
 *
 * @param {Object} params
 * @returns {Promise<{observed: boolean, items: Array<Object>, error: string|null}>}
 */
export async function observeProjection({ mediaId, mediaType, season = null, episode = null, consumer = 'plex' }) {
  if (consumer !== 'plex') {
    return { observed: false, items: [], error: `unsupported-consumer:${consumer}` };
  }
  return observePlexProjection({ mediaId, mediaType, season, episode });
}

/**
 * Compare the desired projection with what the consumer holds.
 */
export async function classifyConsumerProjection({ desired, consumer = 'plex', observe = null }) {
  const observed = observe
    ? await observe({
      mediaId: desired?.mediaId ?? null,
      mediaType: desired?.mediaType ?? 'movie',
      season: desired?.season ?? null,
      episode: desired?.episode ?? null,
      consumer,
    })
    : await observeProjection({
      mediaId: desired?.mediaId ?? null,
      mediaType: desired?.mediaType ?? 'movie',
      season: desired?.season ?? null,
      episode: desired?.episode ?? null,
      consumer,
    });
  const classification = classifyProjection({
    desired,
    observed: observed.observed ? observed : null,
    consumer,
  });
  return { ...classification, observed: observed.observed, observedError: observed.error };
}

/**
 * Repair one consumer projection.
 *
 * @param {Object} params
 * @param {Object} params.desired - the desired projection
 * @param {Object} [params.consumer='plex']
 * @param {Function} [params.notify] - the refresh notifier (injectable)
 * @param {Function} [params.confirm] - the deterministic ingest confirm
 * @param {Function} [params.log]
 * @returns {Promise<{consumer, state, action, refreshed, confirmed, detail}>}
 */
export async function repairConsumerProjection({
  desired,
  consumer = 'plex',
  notify = notifyPlex,
  confirm = opportunisticIngestConfirm,
  observe = null,
  log = () => {},
} = {}) {
  const before = await classifyConsumerProjection({ desired, consumer, observe });
  if (before.state === PROJECTION_STATES.ALIGNED) {
    return { consumer, state: before.state, action: 'none', refreshed: false, confirmed: false, detail: null };
  }
  if (before.state === PROJECTION_STATES.UNKNOWN) {
    return {
      consumer, state: before.state, action: 'none', refreshed: false, confirmed: false,
      detail: before.observedError ?? 'consumer-unobserved',
    };
  }
  if (before.state === PROJECTION_STATES.CONFLICTED) {
    // Several consumer items for one intent: which one is ours is not a
    // question this module may answer.
    return { consumer, state: before.state, action: 'operator-decision', refreshed: false, confirmed: false, detail: before.detail };
  }

  const want = desired?.desired?.[consumer] ?? null;
  if (!want?.scanPath || !want?.sectionId) {
    return { consumer, state: before.state, action: 'none', refreshed: false, confirmed: false, detail: 'no-section-geometry' };
  }

  // Ask the consumer to look at the EXACT directory that holds our
  // artifact. The scan path is derived from our durable canonical path;
  // nothing else is scanned, and a whole-section scan is never used here.
  let refreshed = false;
  try {
    const notified = await notify({
      mediaId: desired.mediaId,
      mediaType: desired.mediaType,
      canonicalPath: desired.presentation?.canonicalPath ?? null,
      fullSection: false,
    });
    refreshed = notified?.notified === true;
    if (!refreshed) log(`projection refresh not sent for ${desired.mediaId}: ${notified?.error ?? 'unknown'}`);
  } catch (error) {
    log(`projection refresh failed for ${desired.mediaId}: ${error?.message ?? error}`);
    return { consumer, state: before.state, action: 'refresh', refreshed: false, confirmed: false, detail: 'refresh-failed' };
  }

  let confirmed = false;
  if (typeof confirm === 'function') {
    try {
      const result = await confirm({
        mediaType: desired.mediaType,
        canonicalPath: desired.presentation?.canonicalPath ?? null,
        mediaId: desired.mediaId,
        season: desired.season ?? null,
        episode: desired.episode ?? null,
        expectedPartFile: want.partFile ?? null,
        expectedSize: want.partSize ?? null,
        timeoutMs: 30_000,
      });
      confirmed = result?.outcome === 'verified';
    } catch {
      confirmed = false;
    }
  }

  const after = await classifyConsumerProjection({ desired, consumer, observe });
  return {
    consumer,
    state: after.state,
    action: 'refresh',
    refreshed,
    confirmed,
    detail: after.detail ?? null,
    before: before.state,
  };
}

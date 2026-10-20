/**
 * THE DESIRED CONSUMER PROJECTION — what SHOULD exist in Plex and Jellyfin.
 *
 * A consumer library is a projection of HashSucker's durable truth. This
 * module derives that projection from the durable state alone:
 *
 *   library item      the media intent
 *   presentation id.  the committed consumer-visible name and paths
 *   VFS entry         the byte path and the exact size
 *   binding + TF      the authoritative representation
 *
 * and states, per consumer, the artifacts that must exist there. Nothing
 * in this module talks to a consumer, reads a consumer, or asks a consumer
 * anything: it is the DESIRED side of the comparison, derived from
 * HashSucker's truth only.
 *
 * WHY IT EXISTS
 *
 * The projection was previously implied: the refresh notifier derived a
 * scan path from the canonical path, the ingest derived an expected Part
 * file from the section root, the request path asked "does Plex have some
 * Part?", and the operator surface reported a single `published` state.
 * Every one of those derived its own expectation, from a different
 * fragment, so "what should exist in the consumer" was never written down
 * anywhere — and a missing consumer item could not be told apart from a
 * missing media item.
 *
 * ONE derivation, now:
 *   - the scan path (the parent directory PMS must process) ✓
 *   - the expected Part.file (the exact file the Part must point at) ✓
 *   - the expected Part.size (the exact size the Part must carry) ✓
 *   - the expected consumer path (Jellyfin's own path for the artifact) ✓
 *
 * The module is PURE: same inputs, same answer, no clock, no network.
 */

import { sectionConfigFor } from '../plex/section-config.js';

/** The projection states a consumer item can be in, relative to the desire. */
export const PROJECTION_STATES = Object.freeze({
  /** The consumer holds exactly what the durable truth says it should. */
  ALIGNED: 'aligned',
  /** The consumer holds nothing for this intent: the projection is missing. */
  MISSING: 'missing',
  /** The consumer holds an item, but its Part points at another path. */
  STALE_PATH: 'stale-path',
  /** The consumer holds the right path, but the Part's size is wrong. */
  STALE_SIZE: 'stale-size',
  /** The consumer holds more than one item for this intent. */
  CONFLICTED: 'conflicted',
  /** The consumer could not be observed: absence was never proven. */
  UNKNOWN: 'unknown',
});

/**
 * The CONSUMER's vocabulary for a media kind: the library item says
 * 'movie' | 'episode', the consumer sections say 'movie' | 'series'.
 */
export function sectionKindFor(mediaType) {
  return mediaType === 'movie' ? 'movie' : 'series';
}

/**
 * The scan path PMS must process for a canonical path: the parent
 * directory of the file, under the section root.
 *
 * @param {string} canonicalPath - VFS-relative ("Movies/Title (2023)/Title (2023).mkv")
 * @param {string} root - the section's filesystem root
 * @returns {string|null}
 */
export function desiredScanPath(canonicalPath, root) {
  if (!root || typeof canonicalPath !== 'string') return null;
  const segments = canonicalPath.split('/');
  if (segments.length < 3) return null;
  return `${root}/${segments.slice(1, -1).join('/')}`;
}

/**
 * The host-side path of the file PMS must end up with.
 *
 * ONE derivation, from the section root (which is what the deployment
 * mounts). The two historical derivations — the section root and a
 * hard-coded `/mnt/hashsucker-vfs` — agreed only because the roots happen
 * to be configured that way.
 *
 * @param {string} canonicalPath
 * @param {string} root
 * @returns {string|null}
 */
export function desiredPartFile(canonicalPath, root) {
  if (!root || typeof canonicalPath !== 'string') return null;
  const segments = canonicalPath.split('/');
  if (segments.length < 2) return null;
  return `${root}/${segments.slice(1).join('/')}`;
}

/**
 * The path Jellyfin must hold for a `.strm` artifact.
 *
 * @param {string} strmPath - the `.strm` path, relative to the strm root
 * @param {Object} env
 * @returns {string|null}
 */
export function desiredJellyfinPath(strmPath, env = process.env) {
  if (typeof strmPath !== 'string' || !strmPath) return null;
  const strmRoot = env.STRM_OUTPUT_PATH || '/strm';
  const jellyfinRoot = env.JELLYFIN_MEDIA_ROOT || '';
  const absolute = strmPath.startsWith('/') ? strmPath : `${strmRoot}/${strmPath}`;
  if (!jellyfinRoot) return absolute;
  if (!absolute.startsWith(strmRoot)) return absolute;
  return `${jellyfinRoot}${absolute.slice(strmRoot.length)}`;
}

/**
 * Derive what SHOULD exist in the consumers for one media intent.
 *
 * @param {Object} params
 * @param {Object} params.item - the library item ({mediaId, mediaType, season, episode})
 * @param {Object|null} params.presentation - the committed presentation identity
 * @param {Object|null} params.vfsEntry - the durable VFS row ({canonicalPath, size})
 * @param {Object|null} params.binding - the active binding
 * @param {Object|null} params.torrentFile - the authoritative TorrentFile
 * @param {Object} [params.env]
 * @returns {{
 *   mediaId: string, mediaType: string, season: number|null, episode: number|null,
 *   presentation: {title: string|null, year: number|null, canonicalPath: string|null, strmPath: string|null},
 *   representation: {torrentFileId: string|null, infoHash: string|null, size: number|null, bindingActive: boolean},
 *   desired: {
 *     plex: {sectionId: string|null, collection: string|null, root: string|null,
 *             scanPath: string|null, partFile: string|null, partSize: number|null,
 *             providerId: string|null, itemType: string},
 *     jellyfin: {path: string|null, providerId: string|null, itemType: string},
 *   },
 *   complete: boolean
 * }}
 */
export function desiredProjection({
  item,
  presentation = null,
  vfsEntry = null,
  binding = null,
  torrentFile = null,
  env = process.env,
} = {}) {
  const mediaId = item?.mediaId ?? null;
  // The CONSUMER's vocabulary is 'movie' | 'series'; the library item's
  // is 'movie' | 'episode'. The section geometry is keyed by the former.
  const mediaType = item?.mediaType === 'episode' ? 'episode' : 'movie';
  const sectionKind = mediaType === 'episode' ? 'series' : 'movie';
  const season = item?.season ?? null;
  const episode = item?.episode ?? null;
  const canonicalPath = presentation?.canonicalPath ?? vfsEntry?.canonicalPath ?? null;
  const strmPath = presentation?.strmPath ?? null;
  const size = torrentFile?.size ?? vfsEntry?.size ?? null;

  const cfg = sectionConfigFor(sectionKind, env);
  const partFile = desiredPartFile(canonicalPath, cfg.root);
  const scanPath = desiredScanPath(canonicalPath, cfg.root);

  return {
    mediaId,
    mediaType,
    season,
    episode,
    presentation: {
      title: presentation?.title ?? null,
      year: presentation?.year ?? null,
      canonicalPath,
      strmPath,
    },
    representation: {
      torrentFileId: binding?.torrentFile?.id ?? torrentFile?.id ?? vfsEntry?.torrentFileId ?? null,
      infoHash: binding?.torrentFile?.infoHash ?? torrentFile?.infoHash ?? vfsEntry?.infoHash ?? null,
      size,
      bindingActive: binding?.status === 'active',
    },
    desired: {
      plex: {
        sectionId: cfg.sectionId,
        collection: cfg.collection,
        root: cfg.root,
        scanPath,
        partFile,
        partSize: size,
        providerId: mediaId,
        itemType: mediaType === 'episode' ? 'episode' : 'movie',
      },
      jellyfin: {
        path: desiredJellyfinPath(strmPath, env),
        providerId: mediaId,
        itemType: mediaType === 'episode' ? 'episode' : 'movie',
      },
    },
    // The projection is only COMPLETE when HashSucker knows everything the
    // consumer would need to hold it: the name, the byte path, the exact
    // size and the section geometry.
    complete: Boolean(mediaId && canonicalPath && size != null && cfg.sectionId && cfg.root),
  };
}

/**
 * Compare an OBSERVED consumer projection against the desired one.
 *
 * Pure: it classifies, it never acts. The repair is a separate decision
 * (see `projection-reconciliation.js`), because "what is wrong" and "what
 * to do about it" are different questions.
 *
 * @param {Object} params
 * @param {Object} params.desired - the desired projection
 * @param {Object} params.observed - {items: [{itemId, partFile, partSize, sectionId}]} | null
 * @param {string} params.consumer
 * @returns {{consumer: string, state: string, itemId: string|null, partFile: string|null,
 *            partSize: number|null, detail: string|null, repairable: boolean}}
 */
export function classifyProjection({ desired, observed = null, consumer }) {
  const want = desired?.desired?.[consumer] ?? null;
  if (!want) {
    return { consumer, state: PROJECTION_STATES.UNKNOWN, itemId: null, partFile: null, partSize: null, detail: 'no-desired-projection', repairable: false };
  }
  if (observed === null || observed === undefined) {
    // The consumer could not be observed. Absence was never proven.
    return { consumer, state: PROJECTION_STATES.UNKNOWN, itemId: null, partFile: null, partSize: null, detail: 'consumer-unobserved', repairable: false };
  }
  const items = Array.isArray(observed.items) ? observed.items : [];
  if (items.length === 0) {
    return { consumer, state: PROJECTION_STATES.MISSING, itemId: null, partFile: null, partSize: null, detail: 'no-consumer-item', repairable: true };
  }
  if (items.length > 1) {
    return {
      consumer, state: PROJECTION_STATES.CONFLICTED,
      itemId: null, partFile: null, partSize: null,
      detail: `${items.length} consumer items for one intent`, repairable: false,
    };
  }
  const item = items[0];
  const expectedFile = want.partFile ?? null;
  const expectedSize = want.partSize ?? null;
  if (expectedFile && item.partFile !== expectedFile) {
    return {
      consumer, state: PROJECTION_STATES.STALE_PATH,
      itemId: item.itemId ?? null, partFile: item.partFile ?? null, partSize: item.partSize ?? null,
      detail: `part ${item.partFile ?? 'none'} !== ${expectedFile}`, repairable: true,
    };
  }
  if (expectedSize != null && item.partSize != null && Number(item.partSize) !== Number(expectedSize)) {
    return {
      consumer, state: PROJECTION_STATES.STALE_SIZE,
      itemId: item.itemId ?? null, partFile: item.partFile ?? null, partSize: item.partSize ?? null,
      detail: `size ${item.partSize} !== ${expectedSize}`, repairable: true,
    };
  }
  return {
    consumer, state: PROJECTION_STATES.ALIGNED,
    itemId: item.itemId ?? null, partFile: item.partFile ?? null, partSize: item.partSize ?? null,
    detail: null, repairable: false,
  };
}

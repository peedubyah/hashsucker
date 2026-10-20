/**
 * Publication — one owner for turning a durable playback handoff into a
 * published, consumer-visible library item.
 *
 * The stage sequence is fixed:
 *
 *   1. authoritative VFS materialization (Binding activation + vfs row)
 *   2. .strm publication (verify-adopt-repair; never trusts bare existence)
 *   3. Jellyfin notification (fire-and-forget, diagnostic only)
 *   4. authoritative VFS metadata hydration (real provider size)
 *   5. Plex: targeted ingest confirm + notification (the only ordering that
 *      does not race the scanner differs by caller and is explicit below)
 *
 * Everything durable that already succeeded stays durable: a failure in a
 * later stage never rolls back an earlier one. Stage failures are raised as
 * `PublicationError` with the stage name so callers keep their exact
 * reason codes instead of generic adapter errors.
 *
 * Deliberately NOT here: discovery, ranking, selection, download/placement
 * policy, and scheduler retry policy. This module owns presentation only.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { publishStrm, expectedStrmPath } from './strm-publisher.js';
import { createLibraryIdentityKey, stableLibraryItemId } from '../control-plane/canonical-path.js';
import { resolvePresentationName } from '../control-plane/presentation-identity.js';
import { materializeVfsEntry } from '../vfs/materialize.js';
import { notifyJellyfin } from './jellyfin-notifier.js';
import { notifyPlex } from './plex-notifier.js';
import { INGEST_OUTCOMES, opportunisticIngestConfirm } from './plex-ingest.js';
import { sectionPartFileFor } from '../plex/section-config.js';
import { confirmPlexEpisode } from '../consumers/plex.js';
import { inc, setPlexIngestObservation } from '../metrics.js';

export class PublicationError extends Error {
  constructor(stage, cause) {
    super(cause?.message ? `${stage}: ${cause.message}` : String(stage));
    this.stage = stage;
    this.cause = cause ?? null;
    this.name = 'PublicationError';
  }
}

/**
 * Stage 1: authoritative VFS materialization.
 *
 * materializeVfsEntry re-asserts the stored handoff identity against the
 * existing row and throws on divergence; it is the single writer of the
 * vfs row and the Binding. Returns null only when it declines (no entry),
 * which callers treat per their own contract.
 */
export async function materializeHandoff({ cache, controlPlaneStore, handoff }) {
  try {
    return await materializeVfsEntry(
      cache,
      handoff,
      controlPlaneStore,
      undefined,
      { allowLegacy: false },
    );
  } catch (error) {
    throw new PublicationError('vfs-materialization', error);
  }
}

/**
 * Guard: a TorrentFile-bound handoff without a VFS entry is not published.
 * Shared so both callers fail with the same reason.
 */
function assertVfsEntry({ handoff, vfsEntry }) {
  if (handoff.torrentFileId && !vfsEntry) {
    throw new PublicationError('vfs-materialization',
      new Error(`VFS publication blocked: TorrentFile validation failed for ${handoff.mediaId}`));
  }
}

/**
 * Stage 2: .strm publication with convergence.
 *
 * publishStrm trusts path existence, not content, so a stale file at the
 * expected path would be a false success. When a VFS row is known, verify
 * the existing artifact first and adopt it when it matches; on mismatch
 * remove and republish exactly once so repair converges instead of
 * compounding. Without a VFS row, publish directly.
 */
async function publishStrmConverged({ handoff, selection, vfsEntry, controlPlaneStore = null }) {
  const identity = committedIdentityFor(controlPlaneStore, handoff);
  // The materializer resolved the name ONCE and carried it here: the
  // consumer path is derived from the SAME resolution as the byte path, so
  // two metadata answers cannot produce two names.
  const resolved = vfsEntry?.presentation ?? null;
  const verify = () => verifyPublishedStrm({
    vfsCanonicalPath: vfsEntry?.canonicalPath,
    mediaType: handoff.mediaType,
    mediaId: handoff.mediaId,
    season: handoff.season ?? null,
    episode: handoff.episode ?? null,
  }).catch(() => null);

  if (identity?.strmPath) {
    // The identity is committed: the artifact's path is known, no title
    // is resolved and no metadata is fetched. A missing artifact is
    // rewritten at the SAME path — the identity is the path.
    const target = path.join(strmOutputRoot(), identity.strmPath);
    const existing = await verifyAt(target, handoff);
    if (existing) return { path: existing, adopted: true, identity };
    const published = await runPublishStrm({ handoff, selection, presentation: identity });
    if (published?.path) return { path: published.path, adopted: false, identity };
    return { path: null, adopted: false, identity };
  }

  if (vfsEntry?.canonicalPath) {
    const adopted = await verify();
    if (adopted) {
      await commitIdentity(controlPlaneStore, handoff, vfsEntry, adopted, selection, resolved);
      return { path: adopted, adopted: true };
    }
    const published = await runPublishStrm({ handoff, selection, presentation: resolved });
    if (published?.path) {
      const verified = await verify();
      if (verified !== published.path) {
        try {
          await fs.unlink(published.path);
        } catch {
          // Already gone; republishing recreates it.
        }
        const repaired = await runPublishStrm({ handoff, selection, presentation: resolved });
        if (repaired?.path) {
          await commitIdentity(controlPlaneStore, handoff, vfsEntry, repaired.path, selection, resolved);
          return { path: repaired.path, adopted: false, repaired: true };
        }
      }
      await commitIdentity(controlPlaneStore, handoff, vfsEntry, published.path, selection, resolved);
    }
    return { path: published?.path ?? null, adopted: false };
  }
  const published = await runPublishStrm({ handoff, selection });
  await commitIdentity(controlPlaneStore, handoff, vfsEntry, published?.path ?? null, selection);
  return { path: published?.path ?? null, adopted: false };
}

/**
 * The committed presentation identity of a media intent, if it has one.
 */
function committedIdentityFor(controlPlaneStore, handoff) {
  if (!controlPlaneStore || typeof controlPlaneStore.getPresentationIdentity !== 'function') return null;
  try {
    const identityKey = createLibraryIdentityKey({
      mediaType: handoff.mediaType === 'movie' ? 'movie' : 'episode',
      mediaId: handoff.mediaId,
      season: handoff.season ?? undefined,
      episode: handoff.episode ?? undefined,
    });
    return controlPlaneStore.getPresentationIdentity(stableLibraryItemId(identityKey)) ?? null;
  } catch {
    return null;
  }
}

/**
 * COMMIT the presentation identity of a media intent.
 *
 * The commit happens once, at the publication that produced the artifacts
 * a consumer can see. The canonical path is the durable VFS path; the
 * `.strm` path is the artifact that was just written (or adopted). The
 * title and year are resolved through the shared precedence, so the
 * identity describes the same name every surface uses.
 */
async function commitIdentity(controlPlaneStore, handoff, vfsEntry, strmPath, selection, resolved = null) {
  if (!controlPlaneStore || typeof controlPlaneStore.commitPresentationIdentity !== 'function') return null;
  if (!strmPath) return null;
  const relative = path.relative(strmOutputRoot(), strmPath);
  // The name the byte path already used — one resolution, two paths.
  const title = resolved?.title
    ? { title: resolved.title, year: resolved.year ?? null }
    : await resolveTitleForIdentity(handoff, selection);
  const mediaType = handoff.mediaType === 'movie' ? 'movie' : 'episode';
  try {
    // The media intent must exist before it can carry an identity. The
    // library item is normally created by the binding activation; a
    // publication whose binding could not be activated yet (no route
    // coordinates yet) still has a consumer-visible name, so the intent
    // is ensured here.
    const item = controlPlaneStore.getLibraryItemByIdentityKey
      ? (controlPlaneStore.getLibraryItemByIdentityKey(createLibraryIdentityKey({
        mediaType,
        mediaId: handoff.mediaId,
        season: handoff.season ?? undefined,
        episode: handoff.episode ?? undefined,
      })) ?? controlPlaneStore.ensureLibraryItem({
        mediaType,
        mediaId: handoff.mediaId,
        title: title.title,
        season: handoff.season ?? null,
        episode: handoff.episode ?? null,
        desiredState: 'present',
      }))
      : null;
    if (!item) return null;
    const result = controlPlaneStore.commitPresentationIdentity(item.id, {
      title: title.title,
      year: title.year,
      canonicalPath: vfsEntry?.canonicalPath ?? null,
      strmPath: relative,
    });
    return result?.identity ?? null;
  } catch (error) {
    console.warn(`[publication] presentation identity commit failed for ${handoff.mediaId}: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * The `.strm` root. The identity stores the path RELATIVE to it: the root
 * is a deployment detail, the identity is not.
 */
function strmOutputRoot() {
  return process.env.STRM_OUTPUT_PATH || '/strm';
}

/**
 * The display name of a media intent, resolved through the shared
 * precedence. Used only when the identity is committed (the first
 * publication); a committed identity is never re-resolved.
 */
async function resolveTitleForIdentity(handoff, selection) {
  const release = selection?.selected?.release ?? null;
  let catalogTitle = null;
  let catalogYear = null;
  try {
    // The catalog is consulted only where the request was silent (the same
    // rule the VFS materializer and the `.strm` publisher use).
    const explicitTitle = typeof handoff.canonicalTitle === 'string' ? handoff.canonicalTitle.trim() : '';
    if (!explicitTitle) {
      const { getMedia } = await import('../metadata/cinemeta.js');
      const type = handoff.mediaType === 'movie' ? 'movie' : 'series';
      const media = await getMedia(type, handoff.mediaId);
      if (media?.title) {
        catalogTitle = media.title;
        catalogYear = media.year ?? null;
      }
    }
  } catch {
    // The catalog is optional: a name is committed either way.
  }
  return resolvePresentationName({
    canonicalTitle: handoff.canonicalTitle ?? null,
    canonicalYear: handoff.canonicalYear ?? null,
    catalogTitle,
    catalogYear,
    inferredTitle: release?.title ?? null,
    inferredYear: release?.year ?? null,
    mediaId: handoff.mediaId,
  });
}

/**
 * Does the file at `target` carry THIS media's resolver URL?
 */
async function verifyAt(target, handoff) {
  let content;
  try {
    content = await fs.readFile(target, 'utf8');
  } catch {
    return null;
  }
  const firstLine = content.split('\n')[0].trim();
  const isMovie = handoff.mediaType === 'movie';
  if (isMovie) return firstLine.includes(`/stream/movie/${handoff.mediaId}`) ? target : null;
  if (!firstLine.includes(`/stream/series/${handoff.mediaId}`)) return null;
  if (handoff.season != null && !firstLine.includes(`season=${handoff.season}`)) return null;
  if (handoff.episode != null && !firstLine.includes(`episode=${handoff.episode}`)) return null;
  return target;
}

async function runPublishStrm({ handoff, selection, presentation = null }) {
  try {
    return await publishStrm({
      handoff,
      ...(selection ? { selection } : {}),
      ...(presentation ? { presentation } : {}),
    });
  } catch (error) {
    throw new PublicationError('strm-publication', error);
  }
}

/**
 * Verify an existing .strm for an already-published item without any
 * network calls. Tries the derived canonical path first, then falls back to
 * a bounded content sweep: the .strm filename always ends with
 * ` - SNNENN.strm` (episodes) and content always carries the resolver URL,
 * so title divergence between VFS and STRM resolution can never cause a
 * false miss. Returns the verified path, or null when missing/mismatched
 * (caller republishes instead of reporting false success).
 */
export async function verifyPublishedStrm({ vfsCanonicalPath, mediaType, mediaId, season, episode }) {
  const isMovie = mediaType === 'movie';
  const candidates = [];
  const dirBase = path.posix.basename(path.posix.dirname(String(vfsCanonicalPath || '')));
  if (dirBase) {
    const m = dirBase.match(/^(.*) \((\d{4})\)$/);
    candidates.push(expectedStrmPath({
      title: m ? m[1] : dirBase,
      year: m ? Number(m[2]) : null,
      mediaType: isMovie ? 'movie' : 'series',
      season,
      episode,
    }));
  }
  const root = process.env.STRM_OUTPUT_PATH || '/strm';
  if (!isMovie && season != null && episode != null) {
    // TV filenames are consumer-structural (`TV Shows/... - SNNENN.strm`)
    // while VFS TV rows may carry mediaId-based names: sweep boundedly.
    const code = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    const showsRoot = path.join(root, 'TV Shows');
    try {
      const shows = await fs.readdir(showsRoot, { withFileTypes: true });
      for (const show of shows) {
        if (!show.isDirectory()) continue;
        const seasonDir = path.join(showsRoot, show.name,
          `Season ${String(season).padStart(2, '0')}`);
        let files;
        try {
          files = await fs.readdir(seasonDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.endsWith(` - ${code}.strm`)) candidates.push(path.join(seasonDir, f));
        }
      }
    } catch {
      // No TV Shows tree — derived path (if any) already covers it.
    }
  }
  if (isMovie) {
    // Presentation titles can diverge between VFS and STRM resolution
    // (request canonicals vs Cinemeta vs filename); content is the arbiter.
    const moviesRoot = path.join(root, 'Movies');
    try {
      const dirs = await fs.readdir(moviesRoot, { withFileTypes: true });
      for (const d of dirs) {
        if (!d.isDirectory()) continue;
        let files;
        try {
          files = await fs.readdir(path.join(moviesRoot, d.name));
        } catch {
          continue;
        }
        for (const f of files) {
          if (f.endsWith('.strm')) candidates.push(path.join(moviesRoot, d.name, f));
        }
      }
    } catch {
      // No Movies tree — derived path (if any) already covers it.
    }
  }
  for (const candidate of candidates) {
    let content;
    try {
      content = await fs.readFile(candidate, 'utf8');
    } catch {
      continue;
    }
    const firstLine = content.split('\n')[0].trim();
    if (isMovie) {
      if (firstLine.includes(`/stream/movie/${mediaId}`)) return candidate;
      continue;
    }
    if (!firstLine.includes(`/stream/series/${mediaId}`)) continue;
    if (season != null && !firstLine.includes(`season=${season}`)) continue;
    if (episode != null && !firstLine.includes(`episode=${episode}`)) continue;
    return candidate;
  }
  return null;
}

/**
 * Stage 3: Jellyfin notification. Non-blocking and diagnostic-only: a
 * failure never destroys the durable handoff, VFS entry, or .strm.
 */
function notifyJellyfinBestEffort({ strmPath, handoff }) {
  if (!strmPath) return;
  notifyJellyfin({
    strmPath,
    mediaId: handoff.mediaId,
    mediaType: handoff.mediaType,
  }).then((result) => {
    if (result.notified) {
      console.log(`[Jellyfin] Notified via ${result.method}: ${handoff.mediaId}`);
    } else if (result.error) {
      console.error(`[Jellyfin] Will be discovered on next scan: ${result.error}`);
    }
  }).catch(() => {
    // Jellyfin notification failure is non-fatal.
  });
}

/**
 * Stage 4: hydrate authoritative VFS metadata so PROPFIND advertises the
 * real provider size before Plex scans the directory. A hydrated entry is
 * returned; any failure returns null so the caller skips the Plex
 * notification instead of asking Plex to scan a 0-byte/size-NULL entry.
 */
async function hydrateVfsMetadata({ vfsEntry, mediaType, mediaId, season = null, episode = null, hydrateVfs }) {
  if (!vfsEntry || !hydrateVfs) return vfsEntry;
  try {
    if (mediaType === 'movie') {
      if (typeof hydrateVfs.hydrateMovie !== 'function') {
        throw new Error('hydrateMovie not provided');
      }
      const hydrated = await hydrateVfs.hydrateMovie(vfsEntry.releaseKey);
      if (hydrated?.size == null) throw new Error('hydrateMovie returned no size');
      console.log(`[vfs-hydrate] media=${mediaId} release=${hydrated.releaseKey} size=${hydrated.size} alreadyHydrated=${hydrated.alreadyHydrated === true}`);
    } else if (mediaType === 'series' || mediaType === 'tv') {
      if (typeof hydrateVfs.hydrateTv !== 'function') {
        throw new Error('hydrateTv not provided');
      }
      const hydrated = await hydrateVfs.hydrateTv({ mediaId, season, episode });
      if (hydrated?.size == null) throw new Error('hydrateTv returned no size');
      console.log(`[vfs-hydrate] media=${mediaId} S${hydrated.season}E${hydrated.episode} size=${hydrated.size} alreadyHydrated=${hydrated.alreadyHydrated === true}`);
    }
    return vfsEntry;
  } catch (error) {
    console.error(`[Plex] Will be discovered on next scan: VFS metadata hydration failed for ${mediaId}: ${error.message}`);
    return null;
  }
}

/**
 * Stage 5a: deterministic ingest confirmation, additive and bounded.
 * Returns the ingest outcome (or null when not applicable).
 */
async function confirmIngestForPublication({ vfsEntry, mediaType, mediaId, season = null, episode = null, timeoutMs = 20_000, pollMs = 250 }) {
  if (!vfsEntry?.canonicalPath) return null;
  const expectedPartFile = sectionPartFileFor(mediaType, vfsEntry.canonicalPath);
  inc('plex_ingest_attempts_total');
  let result;
  try {
    result = await opportunisticIngestConfirm({
      mediaType,
      canonicalPath: vfsEntry.canonicalPath,
      mediaId,
      season,
      episode,
      expectedPartFile,
      expectedSize: vfsEntry.size ?? null,
      timeoutMs,
      pollMs,
      findResult: async () => {
        const plex = await confirmPlexEpisode({
          mediaId, season, episode,
          ...(expectedPartFile ? { expectedPartFile } : {}),
        });
        if (!plex?.visible || !plex.mediaPart?.file) return null;
        return {
          partId: String(plex.mediaPart.id),
          file: plex.mediaPart.file,
          size: plex.mediaPart.size,
          ratingKey: plex.ratingKey,
        };
      },
    });
  } catch (error) {
    // Defensive: the helper is built not to throw, but publication must
    // never break because an opportunistic confirm did.
    console.error(`[Plex] opportunistic ingest confirm skipped for ${mediaId}: ${error?.message || error}`);
    return null;
  }
  const metric = result?.metric || result;
  if (metric) setPlexIngestObservation(metric);
  const outcome = result?.outcome;
  if (outcome === INGEST_OUTCOMES.VERIFIED) {
    inc('plex_ingest_verified_total');
    console.log(`[Plex] ingest verified media=${mediaId} part=${result.partId} file=${result.fileMatch ? 'exact' : 'MISMATCH'} size=${result.sizeMatch === null ? 'n/a' : (result.sizeMatch ? 'exact' : 'MISMATCH')} scanMs=${result.scanMs}`);
  } else if (outcome === INGEST_OUTCOMES.BUSY) {
    inc('plex_ingest_busy_total');
  } else if (outcome === INGEST_OUTCOMES.INVALID) {
    inc('plex_ingest_invalid_total');
    console.error(`[Plex] ingest path rejected locally for ${mediaId}: ${result.fallbackReason} (not sent to Plex)`);
  } else {
    inc('plex_ingest_unconfirmed_total');
  }
  return outcome;
}

/**
 * Stage 5b: Plex notification + opportunistic deterministic confirm.
 *
 * Two documented dispatch modes, both additive to publication:
 *
 *  - 'republish' (prepared-replay contract): deterministic confirm FIRST,
 *    awaited. notifyPlex queues its own refresh, which makes the section
 *    busy, so a confirm placed after it would always refuse; a VERIFIED
 *    result also makes the extra refresh redundant scanner work.
 *  - 'request': notification first, dispatch never awaited, and the bounded
 *    confirm is chained afterwards. The caller continues without blocking
 *    on scanner work; publication outcome is unchanged either way.
 */
async function notifyPlexForPublication({ vfsEntry, mediaType, mediaId, season = null, episode = null, isEpisode, mode }) {
  if (!vfsEntry?.canonicalPath) return;
  console.log(`[e2e] plex_notify_start media=${mediaId} ts=${Date.now()}`);
  const notify = () => notifyPlex({
    mediaId,
    mediaType,
    canonicalPath: vfsEntry.canonicalPath,
    fullSection: false,
  }).then((result) => {
    if (result.notified) {
      console.log(`[Plex] Notified via ${result.method}: ${mediaId}`);
    } else if (result.error) {
      console.error(`[Plex] Will be discovered on next scan: ${result.error}`);
    }
  });

  if (mode === 'republish') {
    if (isEpisode) {
      const ingest = await confirmIngestForPublication({ vfsEntry, mediaType, mediaId, season, episode, timeoutMs: 20_000 });
      if (ingest !== INGEST_OUTCOMES.VERIFIED) await notify();
      return;
    }
    await notify();
    return;
  }

  notify().then(async () => {
    if (!isEpisode) return;
    await confirmIngestForPublication({ vfsEntry, mediaType, mediaId, season, episode, timeoutMs: 60_000 })
      .catch(() => { /* Plex notification failure is non-fatal */ });
  }).catch(() => { /* Plex notification failure is non-fatal */ });
}

/**
 * Full publication for a freshly selected handoff on the request path.
 * Consumer notification is dispatched without blocking the caller.
 *
 * @returns {Promise<{ vfsEntry: Object|null, strmPath: string|null }>}
 */
export async function publishSelectedHandoff({
  cache, controlPlaneStore, handoff, selection,
  mediaId, mediaType, season = null, episode = null, isEpisode = false, hydrateVfs = null,
}) {
  console.log(`[e2e] publication_start media=${mediaId} ts=${Date.now()}`);
  const vfsEntry = await materializeHandoff({ cache, controlPlaneStore, handoff });
  console.log(`[e2e] vfs_materialized media=${mediaId} ts=${Date.now()}`);
  assertVfsEntry({ handoff, vfsEntry });
  const strm = await publishStrmConverged({ handoff, selection, vfsEntry, controlPlaneStore });
  if (strm.path) handoff.strmPath = strm.path;
  console.log(`[e2e] strm_written media=${mediaId} ts=${Date.now()} path=${strm.path}`);
  notifyJellyfinBestEffort({ strmPath: strm.path, handoff });
  const hydratedEntry = await hydrateVfsMetadata({ vfsEntry, mediaType, mediaId, season, episode, hydrateVfs });
  console.log(`[e2e] vfs_hydrated media=${mediaId} ts=${Date.now()}`);
  await notifyPlexForPublication({
    vfsEntry: hydratedEntry, mediaType, mediaId, season, episode, isEpisode, mode: 'request',
  });
  console.log(`[e2e] publication_end media=${mediaId} ts=${Date.now()}`);
  return { vfsEntry, strmPath: strm.path };
}

/**
 * Idempotent republication for a healthy durable publication (reuse path).
 * Awaits the bounded consumer work; any stage failure is a PublicationError
 * so the caller can fall back to full discovery.
 *
 * @returns {Promise<{ vfsEntry: Object, strmPath: string|null }>}
 */
export async function republishHealthyHandoff({
  cache, controlPlaneStore, handoff,
  mediaId, mediaType, season = null, episode = null, isEpisode = false, hydrateVfs = null,
}) {
  const vfsEntry = await materializeHandoff({ cache, controlPlaneStore, handoff });
  if (!vfsEntry) {
    throw new PublicationError('vfs-materialization',
      new Error(`VFS materialization returned no entry for ${handoff.mediaId}`));
  }
  const strm = await publishStrmConverged({ handoff, vfsEntry, controlPlaneStore });
  if (strm.path) handoff.strmPath = strm.path;
  notifyJellyfinBestEffort({ strmPath: strm.path, handoff });
  const hydratedEntry = await hydrateVfsMetadata({ vfsEntry, mediaType, mediaId, season, episode, hydrateVfs });
  await notifyPlexForPublication({
    vfsEntry: hydratedEntry, mediaType, mediaId, season, episode, isEpisode, mode: 'republish',
  });
  return { vfsEntry, strmPath: strm.path };
}

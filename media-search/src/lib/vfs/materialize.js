import path from 'node:path';

import {
  addDeterministicCollisionSuffix,
  buildPreferredCanonicalPath,
} from '../control-plane/canonical-path.js';
import { notifyBindingActivated } from '../control-plane/durability-enroller.js';

function isRealControlPlaneStore(store) {
  // Legacy / test stubs expose only getTorrentFile(). The authoritative
  // binding write requires the full store surface
  // (ensureLibraryItem / ensureCanonicalPath / recordExposure /
  // activateBinding). Skip the write when any of those are missing so
  // legacy readback paths and stubbed unit tests continue to behave
  // exactly as before.
  return Boolean(store)
    && typeof store.ensureLibraryItem === 'function'
    && typeof store.ensureCanonicalPath === 'function'
    && typeof store.recordExposure === 'function'
    && typeof store.activateBinding === 'function';
}

/**
 * Activate a durable control-plane binding for a freshly-materialized
 * authoritative VFS row. Idempotent under replay: re-running this on
 * the same (libraryItem, releaseKey, placement, providerFile, exposure)
 * returns the existing active binding without creating a new version.
 *
 * Failure is logged and swallowed: the VFS row is the source of truth
 * for playback, and a binding-write failure must not regress that path.
 * The 429 causality proof (requestdl-429-binding-causality-proof.test.js)
 * guarantees that no upstream error path can reach this helper; only
 * successful authoritative fulfillments do.
 *
 * The notifyBindingActivated() shim is a no-op when the durability
 * scheduler is not registered (default-disabled mode), so this call is
 * side-effect-free outside the observe / execute durability modes.
 */
function tryActivateAuthoritativeBinding({
  controlPlaneStore,
  handoff,
  torrentFile,
  canonicalPath,
  mediaItemFactory,
  reason,
  observedAt,
}) {
  if (!isRealControlPlaneStore(controlPlaneStore)) return null;
  const identity = handoff?.torrentFileIdentity;
  const placementId = identity?.placementId ?? null;
  const providerFileId = identity?.providerFileId ?? null;
  if (!placementId || !providerFileId) return null;
  if (!torrentFile || !torrentFile.id) return null;

  const itemInput = libraryItemInputFromHandoff(handoff);
  let item;
  try {
    item = controlPlaneStore.ensureLibraryItem(itemInput);
  } catch (error) {
    console.warn(`[vfs] binding write: ensureLibraryItem failed: ${error.message}`);
    return null;
  }
  const itemFactoryResult = mediaItemFactory?.();
  if (itemFactoryResult && itemFactoryResult.id !== item.id) {
    console.warn('[vfs] binding write: media item identity mismatch');
    return null;
  }
  let libraryPath;
  try {
    libraryPath = controlPlaneStore.ensureCanonicalPath(item.id, { canonicalPath });
  } catch (error) {
    console.warn(`[vfs] binding write: ensureCanonicalPath failed: ${error.message}`);
    return null;
  }
  let exposure;
  try {
    exposure = controlPlaneStore.recordExposure({
      placementId,
      providerFileId,
      accountScope: 'default',
      mountScope: 'default',
      transport: 'zurg-rclone',
      // Deterministic exposureKey keeps the exposure idempotent across
      // replays: same placement + same provider file => same key.
      exposureKey: `${placementId}:${providerFileId}`,
      relativePath: canonicalPath,
      state: 'visible',
      readOnly: true,
      observedAt,
      // 6h TTL covers one durability pass and is comfortably longer
      // than the requestdl cache TTL (10min) so a re-fetch never
      // observes an expired exposure on a still-fresh inventory.
      expiresAt: observedAt + 6 * 60 * 60 * 1000,
    });
  } catch (error) {
    console.warn(`[vfs] binding write: recordExposure failed: ${error.message}`);
    return null;
  }
  let binding;
  try {
    binding = controlPlaneStore.activateBinding({
      libraryItemId: item.id,
      libraryPathId: libraryPath.id,
      releaseKey: handoff.releaseKey,
      infoHash: handoff.infoHash,
      fileIndex: handoff.fileIndex ?? null,
      placementId,
      providerFileId,
      exposureId: exposure.id,
      reason,
    });
  } catch (error) {
    console.warn(`[vfs] binding write: activateBinding failed: ${error.message}`);
    return null;
  }
  try {
    notifyBindingActivated({ libraryItemId: item.id, binding, observedAt });
  } catch (error) {
    // The enroller shim is allowed to throw; log and continue.
    console.warn(`[vfs] binding write: notifyBindingActivated failed: ${error.message}`);
  }
  return binding;
}

/**
 * Build the (mediaType, title, year) for ensureLibraryItem() from a handoff.
 * The library item is the semantic identity (movie / episode), distinct
 * from the VFS canonical path. We use:
 *   - handoff.canonicalTitle / canonicalYear when supplied (Seerr detail body)
 *   - the provider release basename when not (legacy TV/Movie path)
 *   - the mediaId as last resort
 */
function libraryItemInputFromHandoff(handoff) {
  const base = {
    mediaType: handoff.mediaType === 'movie' ? 'movie' : 'episode',
    mediaId: handoff.mediaId,
    desiredState: 'present',
  };
  if (handoff.mediaType === 'movie') {
    return {
      ...base,
      title: handoff.canonicalTitle || handoff.title || handoff.mediaId,
      year: Number.isSafeInteger(handoff.canonicalYear) ? handoff.canonicalYear : null,
    };
  }
  return {
    ...base,
    title: handoff.canonicalTitle || handoff.title || handoff.mediaId,
    season: handoff.season,
    episode: handoff.episode,
  };
}

function releaseKeyFor(handoff) {
  return `${handoff.infoHash.toLowerCase()}:${handoff.fileIndex == null ? 'torrent' : handoff.fileIndex}`;
}

function movieIdentity(filename, mediaId) {
  const basename = path.posix.basename(String(filename || '').replaceAll('\\', '/'));
  const parsed = path.posix.parse(basename);
  const stem = parsed.name || basename || mediaId;
  const yearMatch = stem.match(/(?:^|[. _-])((?:19|20)\d{2})(?=$|[. _-])/);
  const year = yearMatch ? Number(yearMatch[1]) : null;
  const titlePart = yearMatch ? stem.slice(0, yearMatch.index).trim() : stem.trim();
  const title = titlePart
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || mediaId;
  const extension = /^\.[a-z0-9]{1,10}$/i.test(parsed.ext) ? parsed.ext : '.mkv';
  return { title, year, extension };
}

function episodeIdentity(filename, mediaId) {
  const basename = path.posix.basename(String(filename || '').replaceAll('\\', '/'));
  const parsed = path.posix.parse(basename);
  const base = parsed.name || basename || mediaId;
  const title = base
    .replace(/[._-]+/g, ' ')
    .replace(/\s+S\d+E\d+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim() || mediaId;
  const extension = /^\.[a-z0-9]{1,10}$/i.test(parsed.ext) ? parsed.ext : '.mkv';
  return { title, extension };
}

function torrentFileForHandoff(controlPlaneStore, handoff, allowLegacy) {
  if (!handoff.torrentFileId) {
    if (allowLegacy) return null;
    throw new Error(`TorrentFile identity is required for new VFS publication of ${handoff.mediaId}`);
  }
  if (!controlPlaneStore || typeof controlPlaneStore.getTorrentFile !== 'function') {
    throw new Error(`TorrentFile validation is unavailable for ${handoff.mediaId}`);
  }
  const torrentFile = controlPlaneStore.getTorrentFile(handoff.torrentFileId);
  if (!torrentFile) {
    throw new Error(`TorrentFile ${handoff.torrentFileId} does not exist for ${handoff.mediaId}`);
  }
  if (!Number.isSafeInteger(torrentFile.size) || torrentFile.size <= 0) {
    throw new Error(`TorrentFile ${torrentFile.id} has invalid physical size`);
  }
  if (typeof torrentFile.internalPath !== 'string' || !torrentFile.internalPath) {
    throw new Error(`TorrentFile ${torrentFile.id} has invalid internal path`);
  }
  if (typeof torrentFile.infoHash !== 'string'
    || torrentFile.infoHash.toLowerCase() !== handoff.infoHash.toLowerCase()) {
    throw new Error(`TorrentFile ${torrentFile.id} infoHash does not match handoff ${handoff.mediaId}`);
  }
  return torrentFile;
}

function assertExistingIdentity(existing, handoff, torrentFile) {
  if (!torrentFile) return;
  if (existing.torrentFileId !== torrentFile.id
    || existing.infoHash.toLowerCase() !== torrentFile.infoHash.toLowerCase()
    || existing.size !== torrentFile.size) {
    throw new Error(`Durable VFS entry conflicts with TorrentFile ${torrentFile.id}`);
  }
}

function assertExistingIdentityOrThrow(existing, handoff, torrentFile) {
  assertExistingIdentity(existing, handoff, torrentFile);
  return existing;
}

function isLegacyVfsEntry(existing) {
  return existing && existing.torrentFileId == null;
}

/**
 * Worker A — Defect A: rejection-supersede check.
 *
 * The VFS row is bound to an authoritative TorrentFile that has
 * been proven invalid (terminal evidence, alternate-rank-5
 * promotion, or any other authoritative replacement signal). The
 * new handoff carries a different (infoHash, torrentFileId) and
 * is itself authoritative (torrentFileIdentity.status === 'mapped'
 * or the candidate was promoted through the normal lifecycle).
 *
 * In that case we may atomically replace the existing row's
 * physical identity while keeping the stable canonical_path
 * (the library alias). This is the same contract as the
 * legacy-supersede path; the only difference is the existing row
 * already has a torrentFileId, but that id is now known to be the
 * wrong physical identity.
 *
 * Returns true if the new (handoff, torrentFile) is an authoritative
 * rejection of the existing row. The caller proceeds with the
 * supersede. Returns false otherwise (caller falls through to
 * the existing assertExistingIdentity safety net).
 */
function isRejectionSupersede(existing, handoff, torrentFile) {
  if (!torrentFile) return false;
  if (!existing || !existing.torrentFileId) return false; // legacy case handled separately
  if (existing.torrentFileId === torrentFile.id) return false; // idempotent, not a rejection
  // The new handoff must carry an authoritative identity (i.e.
  // the promotion came from a real lifecycle path, not a stray
  // ad-hoc buildPlaybackHandoff call). When status is 'skipped'
  // or unset, we still allow the supersede iff the existing row's
  // infoHash differs from the new handoff's infoHash — a
  // different physical identity is a definite signal.
  const status = handoff?.torrentFileIdentity?.status;
  const identityChanged = existing.infoHash?.toLowerCase() !== torrentFile.infoHash?.toLowerCase();
  if (status === 'mapped' || status === 'active') return identityChanged;
  // No explicit identity status: only supersede when the new
  // handoff's infoHash differs from the existing row's infoHash.
  // Same infoHash but different torrentFileId is a re-mapping
  // within the same physical release and is rejected (the
  // existing assertion will catch it).
  return identityChanged;
}

function authoritativeTvFields(torrentFile, handoff, canonicalPath, timestamp) {
  return {
    mediaId: handoff.mediaId,
    season: handoff.season,
    episode: handoff.episode,
    releaseKey: handoff.releaseKey,
    infoHash: torrentFile.infoHash,
    canonicalPath,
    torrentFileId: torrentFile.id,
    size: torrentFile.size,
    updatedAt: timestamp,
  };
}

function authoritativeMovieFields(torrentFile, handoff, canonicalPath, timestamp) {
  return {
    mediaId: handoff.mediaId,
    releaseKey: handoff.releaseKey,
    infoHash: torrentFile.infoHash,
    canonicalPath,
    torrentFileId: torrentFile.id,
    size: torrentFile.size,
    updatedAt: timestamp,
  };
}

/**
 * Materialize and return the durable VFS entry for a playback handoff.
 * TorrentFile supplies physical identity; handoff media fields supply the
 * stable library alias. New publication callers pass allowLegacy=false;
 * default compatibility preserves existing direct callers and WebDAV readback.
 *
 * Legacy reconciliation: when a VFS row already exists for the same logical
 * media alias but its torrent_file_id IS NULL (legacy hydrated row), and the
 * new authoritative publication carries a validated TorrentFile, the legacy
 * row is atomically superseded in place. The published canonical_path is
 * preserved verbatim so the library alias (and any downstream WebDAV /
 * Plex / Jellyfin references) remains stable. Authoritative rows
 * (torrent_file_id IS NOT NULL) are never overwritten here: identical
 * current identity is idempotent; differing identity is fail-closed.
 */
function isUniqueConstraintError(error) {
  if (!error) return false;
  const code = error.code || (typeof error.message === 'string' ? null : null);
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return true;
  }
  const msg = typeof error.message === 'string' ? error.message : '';
  return /UNIQUE constraint failed|PRIMARY KEY constraint failed/i.test(msg);
}

function raceRecoverVfsMovieEntry(searchCache, handoff, torrentFile, now, canonicalPath) {
  // Another writer materialized the same logical movie slot between our
  // SELECT and INSERT. Re-read and reconcile against the existing row.
  const existing = searchCache.getVfsMovieEntry(handoff.mediaId);
  if (!existing) {
    throw new Error(`VFS race recovery could not find media_id=${handoff.mediaId}`);
  }
  if (torrentFile && (isLegacyVfsEntry(existing) || isRejectionSupersede(existing, handoff, torrentFile))) {
    const supersedeOptions = { allowRejectionSupersede: !isLegacyVfsEntry(existing) };
    const replaced = searchCache.replaceVfsMovieEntry(
      authoritativeMovieFields(torrentFile, handoff, existing.canonicalPath, now()),
      supersedeOptions,
    );
    if (replaced) {
      console.log(`[vfs] race-recovered ${isLegacyVfsEntry(existing) ? 'legacy' : 'rejected'} media=${replaced.mediaId} path="${replaced.canonicalPath}" release=${replaced.releaseKey} torrentFileId=${replaced.torrentFileId}`);
      return replaced;
    }
  }
  return assertExistingIdentityOrThrow(existing, handoff, torrentFile);
}

function raceRecoverVfsTvEntry(searchCache, handoff, torrentFile, now) {
  const existing = searchCache.getVfsTvEntry(handoff.mediaId, handoff.season, handoff.episode);
  if (!existing) {
    throw new Error(`VFS race recovery could not find media_id=${handoff.mediaId} S${handoff.season}E${handoff.episode}`);
  }
  if (torrentFile && (isLegacyVfsEntry(existing) || isRejectionSupersede(existing, handoff, torrentFile))) {
    const supersedeOptions = { allowRejectionSupersede: !isLegacyVfsEntry(existing) };
    const replaced = searchCache.replaceVfsTvEntry(
      authoritativeTvFields(torrentFile, handoff, existing.canonicalPath, now()),
      supersedeOptions,
    );
    if (replaced) {
      console.log(`[vfs-tv] race-recovered ${isLegacyVfsEntry(existing) ? 'legacy' : 'rejected'} media=${replaced.mediaId} S${replaced.season}E${replaced.episode} path="${replaced.canonicalPath}" release=${replaced.releaseKey} torrentFileId=${replaced.torrentFileId}`);
      return replaced;
    }
  }
  return assertExistingIdentityOrThrow(existing, handoff, torrentFile);
}

export function materializeVfsEntry(
  searchCache,
  handoff,
  controlPlaneStore = null,
  now = () => Date.now(),
  { allowLegacy = true } = {},
) {
  const torrentFile = torrentFileForHandoff(controlPlaneStore, handoff, allowLegacy);
  // The binding write needs an item factory that closes over the handoff's
  // presentation identity. We attach it as a method on the handoff so the
  // result finalization below can run tryActivateAuthoritativeBinding on
  // every return path (success, idempotent, legacy supersede, race recovery)
  // without duplicating the call.
  const mediaItemFactory = () => {
    if (!isRealControlPlaneStore(controlPlaneStore)) return null;
    return controlPlaneStore.ensureLibraryItem(libraryItemInputFromHandoff(handoff));
  };
  const finalize = (entry, reason) => {
    if (!entry) return entry;
    const observedAt = entry.updatedAt ?? entry.createdAt ?? now();
    tryActivateAuthoritativeBinding({
      controlPlaneStore,
      handoff,
      torrentFile,
      canonicalPath: entry.canonicalPath,
      mediaItemFactory,
      reason,
      observedAt,
    });
    return entry;
  };

  if (handoff.mediaType === 'movie') {
    const existing = searchCache.getVfsMovieEntry(handoff.mediaId);
    if (existing) {
      if (torrentFile && (isLegacyVfsEntry(existing) || isRejectionSupersede(existing, handoff, torrentFile))) {
        // Legacy supersede: keep the existing canonical_path so the published
        // library alias stays stable, and atomically replace the physical
        // identity with the validated TorrentFile bundle.
        //
        // Worker A — Defect A: rejection-supersede is also taken when
        // the new handoff is authoritative and the existing row's
        // infoHash differs.
        const supersedeOptions = { allowRejectionSupersede: !isLegacyVfsEntry(existing) };
        const replaced = searchCache.replaceVfsMovieEntry(
          authoritativeMovieFields(torrentFile, handoff, existing.canonicalPath, now()),
          supersedeOptions,
        );
        if (replaced) {
          const action = isLegacyVfsEntry(existing) ? 'vfs-legacy-supersede' : 'vfs-rejection-supersede';
          console.log(`[vfs] superseded ${isLegacyVfsEntry(existing) ? 'legacy' : 'rejected'} media=${replaced.mediaId} path="${replaced.canonicalPath}" release=${replaced.releaseKey} torrentFileId=${replaced.torrentFileId}`);
          return finalize(replaced, action);
        }
        // Race: another writer converted the row to authoritative between
        // the SELECT and the UPDATE. Re-read and assert against the
        // authoritative identity.
        return finalize(
          assertExistingIdentityOrThrow(
            searchCache.getVfsMovieEntry(handoff.mediaId),
            handoff,
            torrentFile,
          ),
          'vfs-movie-race',
        );
      }
      assertExistingIdentity(existing, handoff, torrentFile);
      return finalize(existing, 'vfs-movie-idempotent');
    }
    if (handoff.releaseKey !== releaseKeyFor(handoff)) {
      throw new Error(`Durable movie handoff identity is inconsistent for ${handoff.mediaId}`);
    }

    // Prefer the canonical request identity (e.g. "Dune: Part Two", 2024
    // from the Seerr detail body) for the Plex-facing VFS path. Fall back
    // to the provider release filename only when no canonical identity
    // was supplied. The provider-backed `filename` and `infoHash` are
    // unchanged either way.
    const movie = movieIdentity(handoff.filename, handoff.mediaId);
    const physicalFile = movieIdentity(torrentFile?.internalPath ?? handoff.filename, handoff.mediaId);
    const presentationTitle = typeof handoff.canonicalTitle === 'string' && handoff.canonicalTitle.trim()
      ? handoff.canonicalTitle.trim()
      : (torrentFile ? handoff.mediaId : movie.title);
    const presentationYear = Number.isSafeInteger(handoff.canonicalYear) && handoff.canonicalYear >= 0
      ? handoff.canonicalYear
      : (torrentFile ? null : movie.year);
    let canonicalPath = buildPreferredCanonicalPath({
      mediaType: 'movie',
      mediaId: handoff.mediaId,
      title: presentationTitle,
      year: presentationYear,
    }, { extension: physicalFile.extension });
    const usedPaths = new Set(searchCache.listVfsMovieEntries().map((entry) => entry.canonicalPath));
    if (usedPaths.has(canonicalPath)) {
      canonicalPath = addDeterministicCollisionSuffix(
        canonicalPath,
        torrentFile?.id ?? handoff.releaseKey,
      );
    }
    const timestamp = now();
    let created;
    try {
      created = searchCache.createVfsMovieEntry({
        mediaId: handoff.mediaId,
        releaseKey: handoff.releaseKey,
        infoHash: torrentFile?.infoHash ?? handoff.infoHash,
        fileIndex: torrentFile ? null : handoff.fileIndex,
        canonicalPath,
        torrentFileId: torrentFile?.id ?? null,
        size: torrentFile?.size ?? null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    } catch (error) {
      // Slice 2.6: concurrent identical first-publication race. Two
      // requests both saw no row, then both tried to insert. The
      // PRIMARY KEY on vfs_movie_entries rejects the loser; reconcile
      // against the winner's row before giving up.
      if (isUniqueConstraintError(error)) {
        created = raceRecoverVfsMovieEntry(
          searchCache, handoff, torrentFile, now, canonicalPath,
        );
      } else {
        throw error;
      }
    }
    console.log(`[vfs] materialized media=${created.mediaId} path="${created.canonicalPath}" release=${created.releaseKey} torrentFileId=${created.torrentFileId}`);
    return finalize(created, 'vfs-movie-materialize');
  }

  if (!['series', 'tv'].includes(handoff.mediaType)
    || !Number.isSafeInteger(handoff.season)
    || !Number.isSafeInteger(handoff.episode)) {
    throw new Error(`Unsupported VFS handoff identity for ${handoff.mediaId}`);
  }

  const existing = searchCache.getVfsTvEntry(handoff.mediaId, handoff.season, handoff.episode);
  if (existing) {
    if (torrentFile && (isLegacyVfsEntry(existing) || isRejectionSupersede(existing, handoff, torrentFile))) {
      // Legacy supersede: keep the existing canonical_path so the published
      // library alias stays stable, and atomically replace the physical
      // identity with the validated TorrentFile bundle.
      //
      // Worker A — Defect A: rejection-supersede path is also taken
      // when the existing row's infoHash differs from the new
      // handoff's infoHash AND the new handoff is authoritative
      // (e.g. the rank-5 alternate was promoted through the
      // normal lifecycle after the bad primary was terminal-
      // evidenced). The canonical_path alias stays stable.
      const supersedeOptions = { allowRejectionSupersede: !isLegacyVfsEntry(existing) };
      const replaced = searchCache.replaceVfsTvEntry(
        authoritativeTvFields(torrentFile, handoff, existing.canonicalPath, now()),
        supersedeOptions,
      );
      if (replaced) {
        const action = isLegacyVfsEntry(existing) ? 'vfs-tv-legacy-supersede' : 'vfs-tv-rejection-supersede';
        console.log(`[vfs-tv] superseded ${isLegacyVfsEntry(existing) ? 'legacy' : 'rejected'} media=${replaced.mediaId} S${replaced.season}E${replaced.episode} path="${replaced.canonicalPath}" release=${replaced.releaseKey} torrentFileId=${replaced.torrentFileId}`);
        return finalize(replaced, action);
      }
      // Race: another writer converted the row to authoritative between
      // the SELECT and the UPDATE. Re-read and assert against the
      // authoritative identity.
      return finalize(
        assertExistingIdentityOrThrow(
          searchCache.getVfsTvEntry(handoff.mediaId, handoff.season, handoff.episode),
          handoff,
          torrentFile,
        ),
        'vfs-tv-race',
      );
    }
    assertExistingIdentity(existing, handoff, torrentFile);
    return finalize(existing, 'vfs-tv-idempotent');
  }
  const episode = episodeIdentity(torrentFile?.internalPath ?? handoff.filename, handoff.mediaId);
  const presentationTitle = typeof handoff.canonicalTitle === 'string' && handoff.canonicalTitle.trim()
    ? handoff.canonicalTitle.trim()
    : (torrentFile ? handoff.mediaId : episode.title);
  let canonicalPath = buildPreferredCanonicalPath({
    mediaType: 'episode',
    mediaId: handoff.mediaId,
    title: presentationTitle,
    season: handoff.season,
    episode: handoff.episode,
  }, { extension: episode.extension });
  const usedPaths = new Set(searchCache.listVfsTvEntries().map((entry) => entry.canonicalPath));
  if (usedPaths.has(canonicalPath)) {
    canonicalPath = addDeterministicCollisionSuffix(
      canonicalPath,
      torrentFile?.id ?? handoff.releaseKey,
    );
  }
  const timestamp = now();
  let created;
  try {
    created = searchCache.createVfsTvEntry({
      mediaId: handoff.mediaId,
      season: handoff.season,
      episode: handoff.episode,
      releaseKey: handoff.releaseKey,
      infoHash: torrentFile?.infoHash ?? handoff.infoHash,
      fileIndex: torrentFile ? null : handoff.fileIndex,
      canonicalPath,
      torrentFileId: torrentFile?.id ?? null,
      size: torrentFile?.size ?? null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  } catch (error) {
    // Slice 2.6: concurrent identical first-publication race. Two
    // requests both saw no row, then both tried to insert. The
    // PRIMARY KEY (media_id, season, episode) rejects the loser;
    // reconcile against the winner's row before giving up.
    if (isUniqueConstraintError(error)) {
      created = raceRecoverVfsTvEntry(searchCache, handoff, torrentFile, now);
    } else {
      throw error;
    }
  }
  console.log(`[vfs-tv] materialized media=${created.mediaId} S${created.season}E${created.episode} path="${created.canonicalPath}" release=${created.releaseKey} torrentFileId=${created.torrentFileId}`);
  return finalize(created, 'vfs-tv-materialize');
}

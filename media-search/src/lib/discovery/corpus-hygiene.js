/**
 * Background corpus-hygiene audit (correct the lie, not the bytes).
 *
 * Detects provably-wrong candidate_media associations and repairs exactly
 * the wrong row: DELETE the single (info_hash, file_index_key, media_id)
 * association, NOT the Release, TorrentFile, placements, attributes, or
 * sibling associations. Search stops surfacing the mapping because
 * media-scoped retrieval joins through candidate_media.
 *
 * Contradiction rules (all conservative, all deterministic):
 *  R-episode: candidate parses to S/E that cannot belong to the media —
 *    known movie + any parsed S/E, or an explicit expected S/E that
 *    differs (episode-scoped audit context).
 *  R-type: handled inside R-episode (movie vs episodic is the same
 *    deterministic signal).
 *  R-show: dominant reference (published truth, else strong consensus)
 *    disagrees AND the suspect row is machine-tier (idle-enrichment
 *    sourced, or confidence < 0.6). Household-verified rows
 *    (request-outcome at high confidence, published bindings) are only
 *    ever flagged, never auto-deleted.
 * Transliteration, punctuation, alternate titles, ±1 year, and incomplete
 * metadata can only ever FLAG (suspicious), never repair.
 *
 * Published-binding guard: when the suspect hash is currently bound for
 * that media, never delete — flag for normal resolver review instead.
 * Publication changes only through existing binding/replacement
 * semantics; hygiene never yanks playing media.
 *
 * Provenance: every decision appends to hygiene_repairs (bounded ring,
 * pruned to the newest 500) recording what was removed/flagged, the
 * introducing source, the contradicting evidence, and auto vs flagged.
 * No hash blacklist: future discovery may re-associate on better
 * evidence, and the shared matcher re-decides every time.
 */
import {
  significantTokens, isSubstantialTitle, titleAgrees, parsedReleaseTitle,
  referenceTitleForMedia,
} from './identity-agreement.js';
import { getStrongestReleaseAttributes } from './release-attributes.js';
import { createQuietGate } from './quiet-gate.js';

export const HYGIENE_BATCH = 25;
export const HYGIENE_MAX_MEDIAS = 10;

/** Sources whose rows are machine-generated (auto-repairable tier).
 * Deliberately narrow: the worker deletes only what background machinery
 * created (plus structural impossibilities). Household-sourced rows
 * (request outcomes at any confidence) are flagged at most — live proof
 * showed request-ranked backfill rows in French/Spanish/Italian that
 * disagree with English references yet depict the right film. Deleting
 * those would punish alternate-language titles, which is forbidden. */
export function isMachineSource(source) {
  return source === 'idle-enrichment';
}

function envNumber(env, name, { fallback, min = 0 }) {
  const v = Number(env?.[name]);
  if (!Number.isFinite(v) || v < min) return fallback;
  return v;
}

export function hygieneIntervalMs(env = process.env) {
  return envNumber(env, 'HYGIENE_INTERVAL_MIN', { fallback: 120, min: 5 }) * 60_000;
}

function ensureRepairLog(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hygiene_repairs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    info_hash TEXT NOT NULL,
    file_index_key INTEGER NOT NULL DEFAULT -1,
    media_id TEXT NOT NULL,
    decision TEXT NOT NULL,
    reason TEXT NOT NULL,
    prior_source TEXT,
    prior_confidence REAL,
    contradicting_evidence TEXT,
    published_guard INTEGER NOT NULL DEFAULT 0
  )`);
}

function pruneRepairLog(db, keep = 500) {
  try {
    db.prepare(`DELETE FROM hygiene_repairs WHERE id NOT IN
      (SELECT id FROM hygiene_repairs ORDER BY id DESC LIMIT ?)`).run(keep);
  } catch { /* best-effort */ }
}

export function createCorpusHygiene({
  cache,
  controlPlaneStore,
  downloadStore = null,
  busyHints = null,
  isCorpusBusy = null,
  measureLag = null,
  recordEvent = null,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  if (!cache?.db) throw new Error('corpus hygiene requires a discovery cache db');
  ensureRepairLog(cache.db);

  const { isQuiet } = createQuietGate({
    cache, downloadStore, busyHints, isCorpusBusy, env, now,
    ...(measureLag ? { measureLag } : {}),
  });

  const status = {
    lastTickAt: null, lastOutcome: 'never', checked: 0, repaired: 0,
    flagged: 0, reasons: {}, errors: 0,
  };

  /** Media type evidence: movie | episode-set | null (unknown). */
  function mediaTypeOf(mediaId) {
    try {
      const items = controlPlaneStore?.listAllLibraryItems?.({ limit: 500 }) ?? [];
      let sawMovie = false;
      let sawEpisode = false;
      for (const it of items) {
        if ((it.mediaId ?? it.media_id) !== mediaId) continue;
        if ((it.season ?? it.episode) != null) sawEpisode = true;
        else sawMovie = true;
      }
      if (sawMovie && !sawEpisode) return 'movie';
      if (sawEpisode && !sawMovie) return 'episode-set';
    } catch { /* fall through */ }
    try {
      if (cache.getVfsMovieEntry?.(mediaId)) return 'movie';
    } catch { /* fall through */ }
    try {
      const tv = cache.db.prepare('SELECT 1 AS ok FROM vfs_tv_entries WHERE media_id = ? LIMIT 1').get(mediaId);
      if (tv) return 'episode-set';
    } catch { /* fall through */ }
    return null;
  }

  /** All bound TorrentFile identity for a media (hashes currently serving). */
  function boundHashesFor(mediaId) {
    const out = new Set();
    try {
      const mv = cache.getVfsMovieEntry?.(mediaId);
      const tfs = [
        mv?.torrentFileId ?? mv?.torrent_file_id ?? null,
      ];
      const tvRows = cache.db.prepare('SELECT torrent_file_id FROM vfs_tv_entries WHERE media_id = ?').all(mediaId);
      for (const r of tvRows) tfs.push(r.torrent_file_id);
      for (const tfId of tfs) {
        if (!tfId) continue;
        const tf = controlPlaneStore?.getTorrentFile?.(tfId);
        const h = tf?.infoHash ?? tf?.info_hash ?? null;
        if (h) out.add(String(h).toLowerCase());
      }
    } catch { /* best-effort */ }
    return out;
  }

  /**
   * Dominant reference + strength for a media: published truth first,
   * else consensus when 3+ independent rows agree with it. Returns
   * { reference, householdVerified } — householdVerified is true when a
   * published binding exists or 3+ request-outcome/verified rows agree.
   */
  function dominantReference(mediaId) {
    const published = referenceTitleForMedia({ mediaId, title: null }, cache, controlPlaneStore);
    // Published layer is household-verified by construction (it returns a
    // title only from bound TorrentFiles); distinguish it from consensus.
    let fromPublished = false;
    try {
      const items = controlPlaneStore?.listAllLibraryItems?.({ limit: 500 }) ?? [];
      for (const it of items) {
        if ((it.mediaId ?? it.media_id) !== mediaId) continue;
        const isEp = (it.season ?? it.episode) != null;
        const handoff = isEp
          ? cache?.getTvPlaybackHandoff?.(mediaId, it.season, it.episode)
          : cache?.getPlaybackHandoffByMediaId?.(mediaId);
        if (handoff?.torrentFileId) {
          fromPublished = true;
          break;
        }
      }
    } catch { /* fall through */ }
    if (published && fromPublished) return { reference: published, householdVerified: true };
    // Consensus strength: 3+ independent rows agreeing with the reference.
    try {
      const rows = cache.db.prepare(`
        SELECT c.title, c.info_hash, m.source FROM candidates c
        JOIN candidate_media m ON m.info_hash = c.info_hash
        WHERE m.media_id = ? AND c.title IS NOT NULL LIMIT 60`).all(mediaId);
      if (published) {
        const agreeing = new Set(
          rows.filter((r) => titleAgrees(published, { filename: r.title, title: r.title }))
            .map((r) => r.source ?? 'unknown'),
        );
        if (agreeing.size >= 3 || rows.filter((r) => titleAgrees(published, { filename: r.title, title: r.title })).length >= 3) {
          return { reference: published, householdVerified: true };
        }
      }
    } catch { /* fall through */ }
    return { reference: published, householdVerified: false };
  }

  /**
   * Evaluate one association row. Returns
   * { verdict: 'ok'|'repair'|'flag', reason, evidence }.
   */
  function evaluateAssociation(assoc) {
    const { info_hash: infoHash, file_index_key: fileIndexKey, media_id: mediaId } = assoc;
    let candidate = null;
    try {
      candidate = cache.db.prepare('SELECT * FROM candidates WHERE info_hash = ? LIMIT 1').get(infoHash) ?? null;
    } catch { /* unreadable */ }
    // Absent candidate identity (no row, or neither title nor filename):
    // unknown remains unknown — never repair on missing evidence.
    if (!candidate?.filename && !candidate?.title) {
      return { verdict: 'ok', reason: 'no-candidate-evidence' };
    }
    let attrs = null;
    try {
      attrs = getStrongestReleaseAttributes(cache, infoHash, fileIndexKey === -1 ? null : fileIndexKey) ?? null;
    } catch { /* attributes best-effort */ }
    const release = {
      infoHash,
      filename: candidate?.filename ?? null,
      title: candidate?.title ?? attrs?.title ?? null,
      year: attrs?.year ?? null,
      confidence: assoc.confidence ?? 1,
    };
    const parsed = parsedReleaseTitle(release);
    const mediaType = mediaTypeOf(mediaId);

    // R-episode (deterministic): known movie + parsed S/E.
    if (mediaType === 'movie' && parsed.season != null && parsed.episode != null) {
      return {
        verdict: 'repair', reason: 'episode-on-movie',
        evidence: { parsedSeason: parsed.season, parsedEpisode: parsed.episode },
      };
    }
    // R-episode scoped: explicit expected S/E differs (audit context).
    if (assoc.__expectedSeason != null && assoc.__expectedEpisode != null
      && parsed.season != null && parsed.episode != null
      && (parsed.season !== assoc.__expectedSeason || parsed.episode !== assoc.__expectedEpisode)) {
      return {
        verdict: 'repair', reason: 'wrong-episode',
        evidence: {
          expected: [assoc.__expectedSeason, assoc.__expectedEpisode],
          parsed: [parsed.season, parsed.episode],
        },
      };
    }

    // R-show: dominant reference disagreement.
    const { reference, householdVerified } = dominantReference(mediaId);
    if (reference == null) {
      return { verdict: 'ok', reason: 'no-reference' };
    }
    if (titleAgrees(reference, release)) {
      return { verdict: 'ok', reason: 'agrees' };
    }
    const machineTier = isMachineSource(assoc.source, assoc.confidence);
    if (householdVerified && machineTier) {
      return {
        verdict: 'repair', reason: 'show-mismatch',
        evidence: { reference: reference.slice(0, 120), candidate: (candidate?.filename ?? candidate?.title ?? '').slice(0, 120) },
      };
    }
    return {
      verdict: 'flag', reason: 'show-mismatch-suspicious',
      evidence: { reference: reference.slice(0, 120), householdVerified, machineTier },
    };
  }

  /** Audit batch: associations for interesting media, bounded. */
  function buildAuditBatch(limit = HYGIENE_BATCH) {
    const medias = [];
    const seen = new Set();
    const pushMedia = (mediaId) => {
      if (!mediaId || seen.has(mediaId)) return;
      seen.add(mediaId);
      medias.push(mediaId);
    };
    try {
      const items = controlPlaneStore?.listAllLibraryItems?.({ limit: 500 }) ?? [];
      for (const it of items) pushMedia(it.mediaId ?? it.media_id);
    } catch { /* library unavailable */ }
    try {
      const reqs = cache.getMediaRequests?.() ?? [];
      const cutoff = now() - 7 * 24 * 60 * 60_000;
      for (const r of reqs) {
        if ((r.created_at ?? 0) >= cutoff) pushMedia(r.media_id);
      }
    } catch { /* requests unavailable */ }
    try {
      const rows = cache.db.prepare(
        "SELECT DISTINCT media_id FROM candidate_media WHERE source = 'idle-enrichment' LIMIT 10").all();
      for (const r of rows) pushMedia(r.media_id);
    } catch { /* none */ }
    const out = [];
    for (const mediaId of medias.slice(0, HYGIENE_MAX_MEDIAS)) {
      try {
        const rows = cache.db.prepare(`
          SELECT m.*, c.title AS candidate_title, c.filename AS candidate_filename
          FROM candidate_media m LEFT JOIN candidates c
            ON c.info_hash = m.info_hash AND c.file_index_key = m.file_index_key
          WHERE m.media_id = ? ORDER BY m.associated_at DESC LIMIT 5`).all(mediaId);
        for (const r of rows) {
          out.push(r);
          if (out.length >= limit) return out;
        }
      } catch { /* per-media failure isolated */ }
    }
    return out;
  }

  function logRepair({ infoHash, fileIndexKey, mediaId, decision, reason, assoc, guard }) {
    const detail = {
      priorSource: assoc?.source ?? null,
      priorConfidence: assoc?.confidence ?? null,
      priorEvidence: assoc?.evidence ?? null,
      priorMatchMethod: assoc?.match_method ?? null,
      reason,
      publishedGuard: !!guard,
    };
    try {
      ensureRepairLog(cache.db);
      cache.db.prepare(`INSERT INTO hygiene_repairs
        (at, info_hash, file_index_key, media_id, decision, reason, prior_source, prior_confidence, contradicting_evidence, published_guard)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(now(), infoHash, fileIndexKey ?? -1, mediaId, decision, reason,
          detail.priorSource, detail.priorConfidence, JSON.stringify(detail), guard ? 1 : 0);
      pruneRepairLog(cache.db);
    } catch { /* provenance best-effort */ }
    try {
      recordEvent?.({
        stage: 'corpus-hygiene', component: 'audit', status: decision,
        errorCode: reason, details: { infoHash, mediaId, ...detail },
      });
    } catch { /* event best-effort */ }
  }

  /**
   * One bounded tick: audit a small batch, repair provable contradictions,
   * flag the rest. Published bindings are never deleted.
   */
  async function tickOnce() {
    status.lastTickAt = now();
    const gate = await isQuiet();
    if (!gate.quiet) {
      status.lastOutcome = `deferred: ${gate.reasons.join(',')}`;
      return { acted: false, reason: 'not-quiet', gate: gate.reasons };
    }
    const batch = buildAuditBatch();
    status.checked += batch.length;
    if (batch.length === 0) {
      status.lastOutcome = 'idle: nothing-to-audit';
      return { acted: false, reason: 'nothing-to-audit' };
    }
    let repaired = 0;
    let flagged = 0;
    for (const assoc of batch) {
      let verdict;
      try {
        verdict = evaluateAssociation(assoc);
      } catch {
        status.errors += 1;
        continue;
      }
      if (verdict.verdict === 'ok') continue;
      // Published-binding guard: the hash serves this media right now —
      // never delete; flag for normal resolver review instead.
      let guard = false;
      try {
        guard = boundHashesFor(assoc.media_id).has(String(assoc.info_hash).toLowerCase());
      } catch { /* guard fails closed to flagging below */ }
      if (verdict.verdict === 'repair' && !guard) {
        try {
          cache.db.prepare(`DELETE FROM candidate_media
            WHERE info_hash = ? AND file_index_key = ? AND media_id = ?`)
            .run(assoc.info_hash, assoc.file_index_key ?? -1, assoc.media_id);
          repaired += 1;
          status.reasons[verdict.reason] = (status.reasons[verdict.reason] ?? 0) + 1;
          logRepair({
            infoHash: assoc.info_hash, fileIndexKey: assoc.file_index_key,
            mediaId: assoc.media_id, decision: 'repaired', reason: verdict.reason,
            assoc, guard: false,
          });
        } catch {
          status.errors += 1;
        }
        continue;
      }
      flagged += 1;
      status.reasons[`${verdict.reason}:flagged`] = (status.reasons[`${verdict.reason}:flagged`] ?? 0) + 1;
      logRepair({
        infoHash: assoc.info_hash, fileIndexKey: assoc.file_index_key,
        mediaId: assoc.media_id, decision: 'flagged', reason: verdict.reason,
        assoc, guard,
      });
    }
    status.repaired += repaired;
    status.flagged += flagged;
    status.lastOutcome = `audited: ~${repaired} ?${flagged}`;
    return { acted: repaired > 0, checked: batch.length, repaired, flagged };
  }

  function getStatus() {
    return { ...status };
  }

  return {
    buildAuditBatch, evaluateAssociation, mediaTypeOf, boundHashesFor,
    dominantReference, tickOnce, getStatus,
  };
}

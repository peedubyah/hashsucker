/**
 * Idle-time corpus enrichment (discovery evidence only — never acquisition).
 *
 * During quiet periods the worker runs ONE bounded live-discovery query per
 * tick (same `runLiveDiscoveryWithCounts` seam + same persistence —
 * `ingestCandidate`, `associateMedia`, `storeReleaseAttributes` — as
 * foreground requests) and persists what it learns. It never adds magnets
 * to Real-Debrid, never creates TorBox jobs, never materializes, never
 * publishes, and never probes provider caches: provider acquisition stays
 * demand-driven under existing placement logic.
 *
 * Targets (priority order, all from existing durable state, capped):
 *   1. upcoming future intents (Sonarr/Radarr)
 *   2. recently requested titles
 *   3. published items with few viable releases
 *   4. published items below their profile terminal tier (widest gap first)
 *   5. metadata-known titles with sparse candidate coverage
 *
 * Fresh state is reconstructed every tick (no durable crawl queue), so a
 * restart resumes naturally. Only per-source backoff + daily budget live
 * in memory, and losing them merely repeats at most one query.
 */
import { runLiveDiscoveryWithCounts } from './live-bridge.js';
import { storeReleaseAttributes } from './release-attributes.js';
import { parseFilename } from './parser-adapter.js';
import { profilePolicy } from '../lifecycle/quality-profiles.js';
import { readPublishedTier } from '../lifecycle/upgrade-watch.js';

export const ENRICHMENT_SOURCE = 'idle-enrichment';
export const DIVERSE_ENOUGH = 8;
export const MIN_CONFIDENCE = 0.5;
export const BACKOFF_BASE_MS = 60 * 60_000;
export const BACKOFF_MAX_MS = 24 * 60 * 60_000;

function envNumber(env, name, { fallback, min = 0 }) {
  const v = Number(env?.[name]);
  if (!Number.isFinite(v) || v < min) return fallback;
  return v;
}

export function enrichmentIntervalMs(env = process.env) {
  return envNumber(env, 'ENRICHMENT_INTERVAL_MIN', { fallback: 60, min: 5 }) * 60_000;
}

/**
 * Sources that represent background machinery (not human foreground
 * activity). Live proof showed the upgrade evaluator persisting
 * `upgrade-watch|upgrade-watch-prepare` rows; counting those as
 * foreground would defer enrichment forever while upgrades run.
 * Unknown sources default to foreground (safe direction).
 */
const BACKGROUND_REQUEST_SOURCES = new Set(['anticipation', 'prepare', 'upgrade-watch']);

const STOPWORDS = new Set(['the', 'of', 'a', 'an', 'and', 'or', 'to', 'in', 'on', 'for', 'with', 's']);

/** Significant tokens: lowercase alnum, len>=3, no stopwords. */
export function significantTokens(text) {
  return String(text ?? '').toLowerCase().split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * A reference title is usable for unsupervised agreement only when it is
 * substantial: 2+ significant tokens, or 8+ significant chars. Single
 * short tokens ("Mogul", "Up", "It") are too ambiguous — live proof showed
 * a garbage one-token resolution ("Mogul", 1965) admitting a wrong show
 * that happened to share season/episode numbers.
 */
export function isSubstantialTitle(title) {
  const toks = significantTokens(title);
  if (toks.length >= 2) return true;
  return toks.join('').length >= 8;
}

/**
 * Reference title for agreement, most-authoritative first:
 *  1. a published/bound TorrentFile for the same media (any episode) —
 *     household-verified truth; immune to association pollution and
 *     garbage metadata resolutions.
 *  2. consensus of already-associated candidate titles, when substantial.
 *  3. the resolved target title, when substantial.
 *  4. null (refuse — never guess blind).
 */
function referenceTitle(target, cache, controlPlaneStore) {
  try {
    const items = controlPlaneStore.listAllLibraryItems?.({ limit: 500 }) ?? [];
    for (const it of items) {
      if ((it.mediaId ?? it.media_id) !== target.mediaId) continue;
      const isEp = (it.season ?? it.episode) != null;
      const handoff = isEp
        ? cache.getTvPlaybackHandoff?.(target.mediaId, it.season, it.episode)
        : cache.getPlaybackHandoffByMediaId?.(target.mediaId);
      const tfId = handoff?.torrentFileId ?? null;
      if (!tfId) continue;
      const tf = controlPlaneStore.getTorrentFile?.(tfId);
      const internal = tf?.internalPath ?? tf?.internal_path ?? null;
      if (!internal) continue;
      let title = null;
      try {
        title = parseFilename(internal)?.parsed?.title ?? null;
      } catch { /* unparseable */ }
      if (isSubstantialTitle(title)) return title;
    }
  } catch { /* fall through */ }
  try {
    const rows = cache.db.prepare(`
      SELECT DISTINCT c.title FROM candidates c
      JOIN candidate_media m ON m.info_hash = c.info_hash
      WHERE m.media_id = ? AND c.title IS NOT NULL LIMIT 20`).all(target.mediaId);
    const consensus = rows.map((r) => r.title).join(' ');
    if (isSubstantialTitle(consensus)) return consensus;
  } catch { /* fall through to resolved title */ }
  if (isSubstantialTitle(target.title)) return target.title;
  return null;
}

/**
 * Release agrees with the reference title: 2+ shared significant tokens,
 * or shared coverage of 60%+ of the reference's significant chars (covers
 * single distinctive words like "Severance" without admitting one shared
 * word out of a long title).
 */
function titleAgrees(reference, release) {
  let parsed = null;
  try {
    parsed = parseFilename(release.filename ?? release.title ?? '')?.parsed ?? null;
  } catch { /* unparseable */ }
  const relTitle = parsed?.title ?? release.title ?? release.filename ?? '';
  const refToks = new Set(significantTokens(reference));
  if (refToks.size === 0) return false;
  const relToks = significantTokens(relTitle);
  const refChars = [...refToks].join('').length;
  let shared = 0;
  let sharedChars = 0;
  for (const t of new Set(relToks)) {
    if (refToks.has(t)) {
      shared += 1;
      sharedChars += t.length;
    }
  }
  if (shared >= 2) return true;
  return refChars > 0 && sharedChars / refChars >= 0.6;
}

function countAssociations(cache, mediaId) {
  try {
    const row = cache.db.prepare('SELECT COUNT(*) AS n FROM candidate_media WHERE media_id = ?').get(mediaId);
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/** Event-loop lag in ms (runtime-only quiet signal; ~5 lines, no deps). */
export async function measureLoopLag() {
  const start = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 0));
  return Date.now() - start;
}

export function createIdleEnrichment({
  cache,
  controlPlaneStore,
  downloadStore = null,
  futureIntentStore = null,
  getMediaById = null,
  discoverFn = runLiveDiscoveryWithCounts,
  measureLag = measureLoopLag,
  busyHints = null,
  isCorpusBusy = null,
  env = process.env,
  now = () => Date.now(),
} = {}) {
  if (!cache) throw new Error('idle enrichment requires a discovery cache');
  if (!controlPlaneStore) throw new Error('idle enrichment requires a control-plane store');

  const dailyCap = () => envNumber(env, 'ENRICHMENT_DAILY_CAP', { fallback: 100, min: 1 });
  const idleAfterMs = () => envNumber(env, 'ENRICHMENT_IDLE_AFTER_MIN', { fallback: 15, min: 1 }) * 60_000;
  const lagLimitMs = () => envNumber(env, 'ENRICHMENT_MAX_LAG_MS', { fallback: 250, min: 10 });

  const backoff = new Map();
  let knownSources = new Set();
  // Zero-yield skip: a target whose last 3 enrichments learned nothing is
  // skipped for 24h (in-memory only; restart resets to at most one extra
  // query). Prevents one dead target from starving everything behind it
  // while keeping the bounded re-check cadence for upcoming content.
  const zeroYield = new Map();
  const ZERO_YIELD_STRIKES = 3;
  const ZERO_YIELD_SKIP_MS = 24 * 60 * 60_000;
  let day = new Date(now()).toISOString().slice(0, 10);
  let dailyCount = 0;
  const status = {
    lastTickAt: null, lastOutcome: 'never', considered: 0, queried: 0,
    newHashes: 0, refreshed: 0, rejected: 0, rejectedReasons: {}, errors: 0,
    backoffUntil: {}, dailyCount: 0, lastTarget: null,
  };

  function noteBackoff(source, failed) {
    const cur = backoff.get(source) ?? { failures: 0, until: 0 };
    if (!failed) {
      if (cur.failures > 0) backoff.set(source, { failures: 0, until: 0 });
      return;
    }
    const failures = cur.failures + 1;
    const delay = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
    backoff.set(source, { failures, until: now() + delay });
  }

  function backoffState() {
    const out = {};
    for (const [source, b] of backoff) {
      if (b.until > now()) out[source] = b.until;
    }
    status.backoffUntil = out;
    return out;
  }

  /** Priority-ordered enrichment targets from existing durable state. */
  function buildTargets(limit = 20) {
    const targets = [];
    const seen = new Set();
    const push = (t) => {
      const key = `${t.mediaType}|${t.mediaId}|${t.season ?? ''}|${t.episode ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      targets.push(t);
    };
    // 1. Upcoming future intents (highest value: learn before release time).
    try {
      const due = futureIntentStore?.due?.({ limit: 5 }) ?? [];
      const listed = futureIntentStore?.list?.({ state: 'anticipated', limit: 5 }) ?? [];
      for (const it of [...due, ...listed]) {
        push({
          class: 'future-intent', mediaType: it.media_type === 'episode' ? 'episode' : 'movie',
          mediaId: it.media_id, season: it.season ?? null, episode: it.episode ?? null,
          reason: `future intent (${it.state ?? 'due'})`,
        });
      }
    } catch { /* intents unavailable */ }
    // 2. Recently requested titles (last 7 days).
    try {
      const reqs = cache.getMediaRequests?.() ?? [];
      const cutoff = now() - 7 * 24 * 60 * 60_000;
      for (const r of reqs) {
        if ((r.created_at ?? 0) < cutoff) continue;
        push({
          class: 'recent-request', mediaType: r.media_type ?? 'movie', mediaId: r.media_id,
          season: r.season ?? null, episode: r.episode ?? null, reason: 'requested in the last 7d',
        });
      }
    } catch { /* requests unavailable */ }
    // 3-5. Published items: thin diversity, below-terminal gap, sparse coverage.
    let items = [];
    try {
      items = controlPlaneStore.listAllLibraryItems?.({ limit: 500 }) ?? [];
    } catch { /* library unavailable */ }
    const thin = [];
    const gapped = [];
    for (const it of items) {
      if (it.desiredState !== 'present' && it.desired_state !== 'present') continue;
      const mediaId = it.mediaId ?? it.media_id;
      if (!mediaId) continue;
      const mediaType = (it.season ?? it.episode) != null ? 'episode' : 'movie';
      const diversity = countAssociations(cache, mediaId);
      const base = {
        mediaType, mediaId, season: it.season ?? null, episode: it.episode ?? null,
      };
      if (diversity < 3) thin.push({ ...base, class: 'thin-diversity', reason: `${diversity} known releases` });
      try {
        const pub = readPublishedTier({
          cache, controlPlaneStore, mediaType, mediaId,
          season: base.season, episode: base.episode,
        });
        const terminal = profilePolicy(pub?.profile)?.terminalTier;
        if (pub?.tier != null && terminal != null && pub.tier < terminal) {
          gapped.push({ ...base, class: 'below-terminal', gap: terminal - pub.tier, reason: `tier ${pub.tier} below terminal ${terminal}` });
        }
      } catch { /* tier unreadable */ }
      if (diversity >= 1 && diversity < DIVERSE_ENOUGH) {
        push({ ...base, class: 'sparse-coverage', reason: `${diversity} associations` });
      }
    }
    for (const t of thin) push(t);
    gapped.sort((a, b) => (b.gap ?? 0) - (a.gap ?? 0));
    for (const t of gapped) push(t);
    return targets.slice(0, limit);
  }

  /**
   * Wrong-match hygiene: episode-exact for TV, sane year + confidence
   * floor for movies, AND title agreement against a substantial reference
   * (consensus of existing associations, else the resolved title).
   * Rejected releases are dropped entirely (never persisted as ambiguous
   * associations).
   */
  function acceptRelease(target, release) {
    if (!release?.infoHash) return { accept: false, reason: 'no-infohash' };
    const confidence = Number.isFinite(release.confidence) ? release.confidence : 0.5;
    const reference = referenceTitle(target, cache, controlPlaneStore);
    if (reference == null) return { accept: false, reason: 'no-reference-title' };
    if (!titleAgrees(reference, release)) return { accept: false, reason: 'title-mismatch' };
    if (target.mediaType === 'episode' || target.season != null) {
      if (release.season !== target.season || release.episode !== target.episode) {
        return { accept: false, reason: 'wrong-episode' };
      }
      if (confidence < MIN_CONFIDENCE) return { accept: false, reason: 'low-confidence' };
      return { accept: true, confidence };
    }
    if (release.year != null && target.year != null
      && Math.abs(release.year - target.year) > 1) {
      return { accept: false, reason: 'year-mismatch' };
    }
    if ((release.year == null || target.year == null) && confidence < 0.6) {
      return { accept: false, reason: 'low-confidence' };
    }
    if (confidence < MIN_CONFIDENCE) return { accept: false, reason: 'low-confidence' };
    return { accept: true, confidence };
  }

  /** Quiet-appliance gate (all runtime signals, nothing durable). */
  async function isQuiet() {
    const reasons = [];
    try {
      const claimable = downloadStore?.listClaimable?.(1) ?? [];
      if (claimable.length > 0) reasons.push('download-work-pending');
    } catch { /* store unavailable */ }
    try {
      const reqs = cache.getMediaRequests?.() ?? [];
      let latest = 0;
      for (const r of reqs) {
        if (BACKGROUND_REQUEST_SOURCES.has(r.source)) continue;
        latest = Math.max(latest, r.created_at ?? 0);
      }
      if (now() - latest < idleAfterMs()) reasons.push('recent-foreground-request');
    } catch { /* requests unavailable */ }
    try {
      const lag = await measureLag();
      if (lag > lagLimitMs()) reasons.push(`event-loop-lag-${lag}ms`);
    } catch { /* lag unmeasurable */ }
    try {
      const hints = busyHints?.() ?? {};
      for (const [k, v] of Object.entries(hints)) {
        if (v) reasons.push(`worker-busy:${k}`);
      }
    } catch { /* hints unavailable */ }
    try {
      if (await isCorpusBusy?.()) reasons.push('corpus-bootstrap-busy');
    } catch { /* corpus state unknown */ }
    return { quiet: reasons.length === 0, reasons };
  }

  function persistRelease(target, release, sourceName, confidence) {
    let isNew = false;
    try {
      const existing = cache.db.prepare('SELECT info_hash FROM candidates WHERE info_hash = ? LIMIT 1')
        .get(release.infoHash);
      isNew = !existing;
    } catch { isNew = true; }
    const candidate = {
      infoHash: release.infoHash,
      fileIndex: release.fileIndex ?? null,
      title: release.title ?? null,
      filename: release.filename ?? release.title ?? null,
      size: Number.isSafeInteger(release.exactFileSize) && release.exactFileSize > 0
        ? release.exactFileSize : (Number.isSafeInteger(release.size) ? release.size : null),
      seeders: release.seeders ?? null,
      leechers: release.leechers ?? null,
      sources: [{ source: ENRICHMENT_SOURCE, via: sourceName, at: now() }],
    };
    cache.ingestCandidate(candidate);
    cache.associateMedia(release.infoHash, release.fileIndex ?? null, target.mediaId, {
      source: ENRICHMENT_SOURCE,
      confidence,
      evidence: ['idle-discovery', `source:${sourceName}`, `target:${target.class}`],
      matchMethod: 'idle-hygiene-v1',
    });
    try {
      storeReleaseAttributes(cache, {
        infoHash: release.infoHash,
        fileIndex: release.fileIndex ?? null,
        filename: candidate.filename ?? 'unknown',
        source: ENRICHMENT_SOURCE,
        confidence,
        parsed: {
          title: release.title ?? null,
          year: release.year ?? null,
          resolution: release.resolution ?? null,
          source: release.source ?? null,
          codec: release.codec ?? null,
          season: release.season ?? null,
          episode: release.episode ?? null,
        },
        evidence: ['idle-discovery'],
      });
    } catch { /* attributes best-effort */ }
    return { isNew };
  }

  async function resolveTitle(target) {
    if (!getMediaById) return {};
    try {
      const media = await getMediaById(target.mediaType === 'episode' ? 'series' : 'movie', target.mediaId);
      if (!media) return {};
      return { title: media.title ?? media.name ?? null, year: media.year ?? null };
    } catch {
      return {};
    }
  }

  /**
   * First target below sufficient diversity (per-target stop, not
   * per-tick: one rich show must not starve thinner targets behind it).
   * An episode with no published library item has zero coverage by
   * definition, regardless of its show's media-level association count.
   */
  function pickInsufficientTarget(targets) {
    let items = null;
    let skipped = 0;
    for (const t of targets) {
      const key = `${t.mediaType}|${t.mediaId}|${t.season ?? ''}|${t.episode ?? ''}`;
      const zy = zeroYield.get(key);
      if (zy && zy.skippedUntil > now()) {
        skipped += 1;
        continue;
      }
      let diversity = countAssociations(cache, t.mediaId);
      if ((t.season ?? t.episode) != null) {
        try {
          items ??= controlPlaneStore.listAllLibraryItems?.({ limit: 500 }) ?? [];
          const published = items.some((it) =>
            (it.mediaId ?? it.media_id) === t.mediaId
            && (it.season ?? null) === (t.season ?? null)
            && (it.episode ?? null) === (t.episode ?? null));
          if (!published) diversity = 0;
        } catch { /* library unreadable: keep media-level count */ }
      }
      if (diversity < DIVERSE_ENOUGH) return { target: t, skipped };
    }
    return { target: null, skipped };
  }

  /**
   * One bounded tick: gate → top target → sufficiency → discover →
   * hygiene → persist. Returns a small outcome (also folded into status).
   */
  async function tickOnce() {
    status.lastTickAt = now();
    const today = new Date(now()).toISOString().slice(0, 10);
    if (today !== day) {
      day = today;
      dailyCount = 0;
    }
    if (dailyCount >= dailyCap()) {
      status.lastOutcome = 'deferred: daily-cap';
      return { acted: false, reason: 'daily-cap' };
    }
    const gate = await isQuiet();
    if (!gate.quiet) {
      status.lastOutcome = `deferred: ${gate.reasons.join(',')}`;
      return { acted: false, reason: 'not-quiet', gate: gate.reasons };
    }
    const targets = buildTargets(20);
    status.considered = targets.length;
    if (targets.length === 0) {
      status.lastOutcome = 'idle: no-targets';
      return { acted: false, reason: 'no-targets' };
    }
    // Backoff enforcement: when every source seen on the last discovery
    // is still backed off, skip the tick. Partial failures still query —
    // allSettled isolation makes one sick source cheap while healthy
    // sources stay valuable.
    const backedOff = backoffState();
    if (knownSources.size > 0 && [...knownSources].every((s) => backedOff[s] != null)) {
      status.lastOutcome = 'deferred: sources-backed-off';
      return { acted: false, reason: 'sources-backed-off' };
    }
    const { target, skipped } = pickInsufficientTarget(targets);
    if (!target) {
      status.lastOutcome = skipped > 0 ? `idle: all-below-bar-skipped(${skipped})` : 'idle: sufficient-diversity';
      return { acted: false, reason: 'sufficient-diversity', skipped };
    }
    const meta = await resolveTitle(target);
    const fullTarget = { ...target, ...meta };
    let discovered;
    try {
      discovered = await discoverFn(target.mediaId, {
        mediaType: target.mediaType,
        season: target.season,
        episode: target.episode,
        title: meta.title,
        year: meta.year,
        env: typeof process !== 'undefined' ? process.env : undefined,
      });
    } catch (error) {
      status.errors += 1;
      status.lastOutcome = `error: ${String(error?.message ?? error).slice(0, 80)}`;
      return { acted: false, reason: 'discover-error', target };
    }
    const releases = discovered?.releases ?? discovered ?? [];
    const sources = discovered?.sources ?? {};
    knownSources = new Set(Object.keys(sources));
    for (const [name, src] of Object.entries(sources)) {
      noteBackoff(name, !!src?.error);
      if (src?.error) status.errors += 1;
    }
    dailyCount += 1;
    status.dailyCount = dailyCount;
    status.queried += 1;
    let added = 0, kept = 0, dropped = 0;
    for (const release of releases) {
      const verdict = acceptRelease(fullTarget, release);
      if (!verdict.accept) {
        dropped += 1;
        status.rejectedReasons[verdict.reason] = (status.rejectedReasons[verdict.reason] ?? 0) + 1;
        continue;
      }
      const sourceName = release._source ?? release.sourceName ?? 'live';
      try {
        const { isNew } = persistRelease(fullTarget, release, sourceName, verdict.confidence);
        if (isNew) added += 1;
        else kept += 1;
      } catch {
        dropped += 1;
      }
    }
    status.newHashes += added;
    status.refreshed += kept;
    status.rejected += dropped;
    status.lastTarget = {
      class: target.class, mediaType: target.mediaType, mediaId: target.mediaId,
      season: target.season ?? null, episode: target.episode ?? null, reason: target.reason ?? null,
    };
    if (added === 0 && kept === 0) {
      const key = `${target.mediaType}|${target.mediaId}|${target.season ?? ''}|${target.episode ?? ''}`;
      const zy = zeroYield.get(key) ?? { strikes: 0, skippedUntil: 0 };
      zy.strikes += 1;
      if (zy.strikes >= ZERO_YIELD_STRIKES) {
        zy.skippedUntil = now() + ZERO_YIELD_SKIP_MS;
        zy.strikes = 0;
      }
      zeroYield.set(key, zy);
    }
    status.lastOutcome = `enriched: +${added} ~${kept} x${dropped}`;
    return {
      acted: true, target, added, refreshed: kept, rejected: dropped, sources: Object.keys(sources),
    };
  }

  function getStatus() {
    return {
      ...status,
      backoffUntil: backoffState(),
      dailyCount,
      intervalMin: (enrichmentIntervalMs(typeof process !== 'undefined' ? process.env : undefined) / 60000),
    };
  }

  return { buildTargets, isQuiet, acceptRelease, tickOnce, getStatus, measureLoopLag };
}

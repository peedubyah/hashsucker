/**
 * Live Discovery Bridge
 *
 * Integrates live discovery sources (Torrentio, Torznab) into the
 * DMM corpus search pipeline. Called by combinedSearch when includeLive=true.
 *
 * This is the integration point between the new ranking pipeline and
 * the legacy live discovery adapters.
 */

import { createReleaseIdentity } from '../../api/release-contract.js';
import { searchStremio, loadDiscoveryAddons } from '../stremio/search.js';
import { searchTorznab } from '../torznab/torznab.js';
import { createProwlarrClient, searchProwlarr } from './prowlarr.js';
import { parseFilename } from './parser-adapter.js';
import { isEpisodeCovered } from './episode-coverage.js';

/**
 * Build a Prowlarr client from environment. Returns null when unconfigured
 * (Prowlarr stays a disabled source — never an error).
 */
function prowlarrClientFromEnv(env = process.env) {
  const baseUrl = env.PROWLARR_URL;
  const apiKey = env.PROWLARR_API_KEY;
  if (!baseUrl || !apiKey) return null;
  return createProwlarrClient({ baseUrl, apiKey });
}

/**
 * Run live discovery for a given media ID.
 *
 * @param {string} mediaId - Media identifier (e.g., "tt0944947:5:14")
 * @param {Object} options
 * @param {number} [options.season] - Season number
 * @param {number} [options.episode] - Episode number
 * @returns {Promise<Array>} Normalized release candidates
 */
export async function runLiveDiscovery(mediaId, options = {}) {
  const { season, episode, title, year, wantedImdbId } = options;
  const mediaType = episode != null ? 'series' : 'movie';

  // Stremio requires full episode identifier format: tt0944947:5:14
  let stremioMediaId = mediaId;
  if (season != null && episode != null) {
    stremioMediaId = `${mediaId}:${season}:${episode}`;
  } else if (season != null) {
    stremioMediaId = `${mediaId}:${season}`;
  }

  // Prowlarr is optional: unconfigured (or failing) means fewer candidates,
  // never a failed request. Failure isolation via allSettled, same as peers.
  const prowlarrClient = prowlarrClientFromEnv(options.env);
  const prowlarrTask = prowlarrClient
    ? searchProwlarr({
      type: mediaType, title: title ?? null, year: year ?? null,
      season, episode, wantedImdbId: wantedImdbId ?? mediaId, client: prowlarrClient,
    })
    : Promise.resolve([]);

  const results = await Promise.allSettled([
    // Stremio/Torrentio discovery
    searchStremio({ type: mediaType, mediaId: stremioMediaId }),
    // Torznab discovery
    searchTorznab({ type: mediaType, mediaId }),
    prowlarrTask,
  ]);

  const allReleases = [];

  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      // Legacy searchStremio returns streams with infoHash
      // Legacy searchTorznab returns items with infoHash
      allReleases.push(...result.value);
    }
  }

  // Normalize to UI-compatible shape
  return allReleases
    .filter(r => r.infoHash)
    .map(r => ({
      ...createReleaseIdentity(r.infoHash, r.fileIndex),
      filename: r.filename || r.title,
      // Prefer actual release filename for title (accurate identity source),
      // fall back to Stremio UI label only when no filename available
      title: r.filename || r.title,
      year: r.year,
      season: r.season,
      episode: r.episode,
      resolution: r.resolution,
      source: r.source || r.quality,
      codec: r.codec,
      hdr: r.hdr,
      audio: r.audio,
      // The upstream's evidence, carried forward rather than dropped:
      // the source-local ordinal, the upstream's own reading of the release,
      // which attributes filled each normalized fact, and the upstream's
      // provider-cache hint (scoped to the provider the ADDON is configured
      // with — it is not our own provider observation).
      sourceOrdinal: r.sourceOrdinal ?? null,
      sourceId: r.sourceId ?? null,
      upstreamFacts: r.upstreamFacts ?? null,
      attributeOrigin: r.attributeOrigin ?? null,
      upstreamCachedHint: r.upstreamCachedHint === true,
      releaseGroup: r.releaseGroup,
      providers: r.providers || {},
      confidence: r.confidence ?? 0.5,
      // Slice 1.75: the RAW byte size from behaviorHints.videoSize on the
      // source stream. Sourced from the strict `exactFileSize` field emitted
      // by normalize.js — NEVER from `size`, which may be a parseSizeFromText
      // round (GiB*1024^3) or torrent total size. Survives into
      // media_request_results so the pre-publication TorBox identity helper
      // can match by exact integer byte count.
      //
      // Part 0: `exactFileSize` is non-null ONLY when the upstream's stream
      // names a file, so the value here is always a per-file size.
      selectedFileSize:
        Number.isSafeInteger(r.exactFileSize) && r.exactFileSize > 0
          ? r.exactFileSize
          : null,
      // Part 0: when the upstream's stream names the RELEASE, its number is
      // the release's total. Release-level evidence: it stays available, and
      // it never reaches the exact-file proof.
      releaseSizeBytes:
        Number.isSafeInteger(r.releaseSizeBytes) && r.releaseSizeBytes > 0
          ? r.releaseSizeBytes
          : null,
    }));
}

/**
 * Run live discovery with per-source counts.
 *
 * Like runLiveDiscovery but returns a breakdown of counts per source
 * for diagnostic trace output. Source failures do not fail the whole
 * trace — they are reported with count 0 and an error field.
 *
 * @param {string} mediaId - Media identifier
 * @param {Object} options
 * @param {number} [options.season]
 * @param {number} [options.episode]
 * @returns {Promise<{ releases: Array, sources: Object }>}
 */
export async function runLiveDiscoveryWithCounts(mediaId, options = {}) {
  const { season, episode, title, year, wantedImdbId, cache = null } = options;
  const mediaType = episode != null ? 'series' : 'movie';
  const queryKey = `${mediaId}${season != null ? `:${season}` : ''}${episode != null ? `:${episode}` : ''}`;

  const prowlarrClient = prowlarrClientFromEnv(options.env);
  const prowlarrTask = prowlarrClient
    ? searchProwlarr({
      type: mediaType, title: title ?? null, year: year ?? null,
      season, episode, wantedImdbId: wantedImdbId ?? mediaId, client: prowlarrClient,
    })
    : Promise.resolve([]);

  const measure = async (sourceClass, task) => {
    const startedAt = Date.now();
    try {
      const value = await task;
      return { sourceClass, ok: true, value, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { sourceClass, ok: false, error, latencyMs: Date.now() - startedAt };
    }
  };
  const stremioAddons = options.addons ?? null;
  const stremioTask = stremioAddons
    ? Promise.all(stremioAddons.filter((addon) => addon.enabled !== false).map(async (addon) => {
      const streams = await searchStremio({ type: mediaType, mediaId, addons: [addon] });
      return streams.map((stream) => ({ ...stream, observer: stream.observer || addon.provider || addon.addon_id, addonId: addon.addon_id, addonName: addon.name }));
    })).then((batches) => batches.flat())
    : searchStremio({ type: mediaType, mediaId });
  const results = await Promise.all([
    measure('stremio', stremioTask),
    measure('torznab', searchTorznab({ type: mediaType, mediaId })),
    measure('prowlarr', prowlarrTask),
  ]);

  const stremioObserver = options.addons?.length === 1
    ? (options.addons[0].addon_id || options.addons[0].id || options.addons[0].provider || 'stremio')
    : 'stremio';
  const sources = {
    stremio: { observer: stremioObserver, sourceClass: 'stremio', count: 0, error: null, disposition: 'queried_success' },
    torznab: { observer: 'torznab', sourceClass: 'torznab', count: 0, error: null, disposition: 'queried_success' },
    prowlarr: { observer: 'prowlarr', sourceClass: 'prowlarr', count: 0, error: null, disposition: prowlarrClient ? 'queried_success' : 'not_configured' },
  };
  if (!prowlarrClient) sources.prowlarr.disposition = 'not_configured';

  const allReleases = [];

  for (const result of results) {
    const source = sources[result.sourceClass];
    const valid = result.ok && Array.isArray(result.value)
      ? result.value.filter((r) => r.infoHash)
      : [];
    source.count = valid.length;
    source.latencyMs = result.latencyMs;
    source.error = result.ok ? null : String(result.error?.message || result.error || 'unknown error');
    if (!result.ok) source.disposition = /timeout|abort/i.test(source.error) ? 'timeout' : 'upstream_error';
    else if (valid.length === 0 && source.disposition === 'queried_success') source.disposition = 'queried_empty';
    allReleases.push(...valid.map((release) => ({ ...release, sourceClass: result.sourceClass })));
    if (result.sourceClass === 'stremio' && valid.length > 0) {
      for (const release of valid) {
        const observer = release.observer || release.addonId || release.provider || 'stremio';
        sources[observer] ??= { observer, sourceClass: 'stremio', count: 0, error: null, disposition: 'queried_success' };
        sources[observer].count++;
      }
    }
    if (cache?.recordEvidenceQuery) {
      const unique = new Set(valid.map((r) => String(r.infoHash).toLowerCase()));
      let known = 0;
      for (const infoHash of unique) if (cache.getCandidate?.(infoHash, null)) known++;
      cache.recordEvidenceQuery({
        queryKey, observer: source.observer, sourceClass: source.sourceClass,
        disposition: source.disposition, observedAt: Date.now(), latencyMs: result.latencyMs,
        candidateCount: unique.size, novelReleaseCount: Math.max(0, unique.size - known),
      });
    }
  }

  // Normalize (same as runLiveDiscovery)
  const releases = allReleases.map(r => ({
    ...createReleaseIdentity(r.infoHash, r.fileIndex),
    filename: r.filename || r.title,
    title: r.title || r.filename,
    year: r.year,
    season: r.season,
    episode: r.episode,
    resolution: r.resolution,
    source: r.source || r.quality,
    codec: r.codec,
    hdr: r.hdr,
    audio: r.audio,
    releaseGroup: r.releaseGroup,
    providers: r.providers || {},
    sources: [{ addonId: r.addonId || r.sourceClass || 'live-discovery', addonName: r.addonName || r.sourceClass || 'live-discovery' }],
    observer: r.observer || r.addonId || r.sourceClass || 'live-discovery',
    sourceClass: r.sourceClass || 'live-discovery',
    confidence: r.confidence ?? 0.5,
    // Slice 1.75: prefer the strict `exactFileSize` (behaviorHints.videoSize
    // only, safe integer > 0) over `size`, which may be a parseSizeFromText
    // round. Identity helper needs an exact integer byte count.
    //
    // Part 0: `exactFileSize` is non-null ONLY when the upstream's stream
    // names a file, so this is always a per-file size.
    selectedFileSize:
      Number.isSafeInteger(r.exactFileSize) && r.exactFileSize > 0
        ? r.exactFileSize
        : null,
    // Part 0: the upstream's release-level number (stream names the
    // RELEASE, not a file). Release-level evidence only.
    releaseSizeBytes:
      Number.isSafeInteger(r.releaseSizeBytes) && r.releaseSizeBytes > 0
        ? r.releaseSizeBytes
        : null,
  }));

  return { releases, sources };
}

/**
 * Classify one normalized live row against a requested (season, episode).
 *
 * Returns 'na' when no episode intent exists, 'exact' when the row's
 * filename structurally covers the requested episode, 'wrong' when it
 * structurally contradicts it, and 'unknown' when the filename carries no
 * usable season/episode evidence. Unknown rows are NOT rejected here —
 * live scope trust plus fail-closed provider binding decide those
 * downstream. This classification exists for per-source observability:
 * source-has-nothing vs parser-dropped-it vs candidate-invalid.
 *
 * @param {Object} row - Normalized live row (filename/title)
 * @param {number|null} season
 * @param {number|null} episode
 * @returns {'na'|'exact'|'wrong'|'unknown'}
 */
export function classifyBloodhoundEpisode(row, season, episode) {
  if (season == null || episode == null) return 'na';
  const filename = row?.filename || row?.title;
  if (!filename || typeof filename !== 'string') return 'unknown';
  let parsed = null;
  try {
    parsed = parseFilename(filename);
  } catch {
    return 'unknown';
  }
  const p = parsed?.parsed;
  if (!p || (p.season == null && p.episode == null && !p.episodeRange && p.mediaType !== 'season')) {
    return 'unknown';
  }
  const attrs = {
    season: p.season ?? null,
    episode: p.episode ?? null,
    episodeRange: p.episodeRange ?? null,
    seasonOnly: p.seasonOnly === true || p.mediaType === 'season',
    mediaType: p.mediaType ?? null,
  };
  try {
    return isEpisodeCovered(attrs, season, episode) ? 'exact' : 'wrong';
  } catch {
    return 'unknown';
  }
}

/**
 * Merge normalized live rows by exact release identity (infoHash+fileIndex).
 *
 * Field-level union: the first non-null value wins per field, so a Prowlarr
 * row's parsed season/episode fills in a Stremio row's gap (and vice versa
 * for the Stremio exact file size) instead of one row clobbering the other.
 * Multi-source provenance is retained: every contributing addon's source
 * entry survives on the merged row.
 *
 * @param {Array<Array>} lists - Per-source normalized row lists
 * @returns {Array} Merged rows
 */
export function mergeBloodhoundRows(lists) {
  const byKey = new Map();
  const FIELDS = ['filename', 'title', 'year', 'season', 'episode', 'episodeRange',
    'seasonOnly', 'mediaType', 'resolution', 'source', 'quality', 'codec', 'hdr',
    'audio', 'language', 'releaseGroup', 'size', 'exactFileSize', 'releaseSizeBytes', 'cached',
    'confidence', 'parserConfidence', 'relevance', 'providers', 'observer',
    'sourceClass', 'addonId', 'addonName', 'nzbUrl', 'url', 'seeders', 'publishDate'];
  const sourceId = (s) => [s?.origin, s?.addonId, s?.observer, s?.indexer, s?.provider]
    .map((v) => v ?? '').join('|');
  for (const row of (lists || []).flat()) {
    if (!row?.infoHash) continue;
    const key = row.releaseKey
      || row.key
      || `${String(row.infoHash).toLowerCase()}:${row.fileIndex ?? 'torrent'}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, row);
      continue;
    }
    const mergedSources = [...(prev.sources || [])];
    for (const s of (row.sources || [])) {
      if (!mergedSources.some((x) => sourceId(x) === sourceId(s))) {
        mergedSources.push(s);
      }
    }
    const merged = { ...prev };
    for (const field of FIELDS) {
      if (merged[field] == null && row[field] != null) merged[field] = row[field];
    }
    merged.sources = mergedSources;
    byKey.set(key, merged);
  }
  return [...byKey.values()];
}

/**
 * Normalize one merged bloodhound row to the live-candidate shape the
 * fulfillment pipeline consumes (same contract as runLiveDiscovery output),
 * while PRESERVING the merged multi-source provenance. Entries without an
 * explicit origin are live-discovery evidence (origin 'live'); pre-tagged
 * entries (e.g. prowlarr scope-guard origin) keep their origin.
 *
 * @param {Object} r - Merged row
 * @returns {Object} Live-candidate shaped row
 */
export function toBloodhoundRelease(r) {
  // Structured S/E fill: Stremio/Torznab rows carry no parsed season/episode,
  // which would leave wrong-episode payloads (e.g. an S01E06 filename
  // answering an S01E07 query) eligible by scope trust — and therefore
  // bindable via the exact-size fast path, which never inspects content.
  // Fill the gap from the release filename with the same proven parser the
  // corpus pipeline uses. Filenames without usable S/E evidence stay null
  // (scope trust unchanged); structurally-contradicted rows are rejected
  // downstream by the standard identity eligibility gate. Fail-closed only:
  // a parser misfire can only turn a bind into an unfulfilled+retryOwned
  // miss, never into a wrong-episode binding.
  let season = r.season ?? null;
  let episode = r.episode ?? null;
  let episodeRange = r.episodeRange ?? null;
  let seasonOnly = r.seasonOnly ?? false;
  let mediaType = r.mediaType ?? null;
  if (season == null && episode == null && episodeRange == null) {
    try {
      const p = parseFilename(r.filename || r.title)?.parsed ?? null;
      if (p && (p.season != null || p.episode != null || p.episodeRange || p.mediaType === 'season')) {
        season = p.season ?? null;
        episode = p.episode ?? null;
        episodeRange = p.episodeRange ?? null;
        seasonOnly = p.seasonOnly === true || p.mediaType === 'season';
        mediaType = p.mediaType ?? mediaType;
      }
    } catch {
      // Parser failure keeps scope-trust behavior (fields stay null).
    }
  }
  return {
    ...createReleaseIdentity(r.infoHash, r.fileIndex ?? null),
    filename: r.filename || r.title,
    // Prefer the actual release filename for title (accurate identity
    // source), fall back to the source UI label only when absent.
    title: r.filename || r.title,
    year: r.year ?? null,
    season,
    episode,
    episodeRange,
    seasonOnly,
    mediaType,
    resolution: r.resolution ?? null,
    source: r.source || r.quality || null,
    codec: r.codec ?? null,
    hdr: r.hdr ?? null,
    audio: r.audio ?? null,
    releaseGroup: r.releaseGroup ?? null,
    providers: r.providers || {},
    sources: (r.sources || []).map((s) => ({ origin: 'live', ...(s || {}) })),
    observer: r.observer || r.addonId || r.sourceClass || 'live-discovery',
    sourceClass: r.sourceClass || 'live-discovery',
    confidence: r.confidence ?? r.parserConfidence ?? 0.5,
    parserConfidence: r.parserConfidence ?? r.confidence ?? 0.5,
    relevance: r.relevance ?? 0.8,
    // Slice 1.75: the RAW byte size from behaviorHints.videoSize only.
    // Survives into media_request_results so the pre-publication TorBox
    // identity helper can match by exact integer byte count.
    //
    // Part 0: `exactFileSize` is non-null ONLY when the upstream's stream
    // names a file, so this is always a per-file size.
    exactFileSize:
      Number.isSafeInteger(r.exactFileSize) && r.exactFileSize > 0
        ? r.exactFileSize
        : null,
    selectedFileSize:
      Number.isSafeInteger(r.exactFileSize) && r.exactFileSize > 0
        ? r.exactFileSize
        : null,
    // Part 0: the upstream's release-level number (stream names the
    // RELEASE, not a file). Release-level evidence only.
    releaseSizeBytes:
      Number.isSafeInteger(r.releaseSizeBytes) && r.releaseSizeBytes > 0
        ? r.releaseSizeBytes
        : null,
  };
}

function bloodhoundDisposition({ error, parsedCount }) {
  if (error) return /timeout|abort/i.test(String(error)) ? 'timeout' : 'upstream_error';
  return parsedCount === 0 ? 'queried_empty' : 'queried_success';
}

/**
 * Count fast-layer rows worth proceeding with (Prowlarr escalation gate).
 *
 * A row is viable when it could plausibly fulfill the request: exact-episode
 * coverage, or unknown coverage (scope trust + fail-closed binding decide
 * those downstream). Structurally-contradicted rows (wrong episode) never
 * count. Without episode intent every infoHash-carrying row counts.
 *
 * @param {Array} rows - Normalized pre-merge rows
 * @param {number|null} season
 * @param {number|null} episode
 * @returns {number} Viable row count
 */
export function countViableBloodhoundRows(rows, season, episode) {
  let viable = 0;
  for (const row of rows || []) {
    if (!row?.infoHash) continue;
    if (season == null || episode == null) {
      viable++;
      continue;
    }
    const cls = classifyBloodhoundEpisode(row, season, episode);
    if (cls === 'exact' || cls === 'unknown') viable++;
  }
  return viable;
}

/**
 * Recent-release bloodhound: query live sources for one media item in
 * fast-first layers, never stopping after the first source produces rows.
 *
 * Layer 1 (fast): Torrentio + Comet (+ Torznab when configured) in
 * parallel. When the fast layer yields viable candidates the pass
 * proceeds immediately — a slow Prowlarr tail must never hold up a
 * successful fast-source request (observed: ~8s empty Prowlarr tail vs
 * 40–600ms fast sources).
 *
 * Layer 2 (escalation): Prowlarr runs ONLY when the fast layer yields no
 * viable candidate. Prowlarr is not removed — its unique discoveries still
 * merge, persist, and serve background enrichment (which uses the
 * all-sources runner, not this gate).
 *
 * Every layer runs with per-source failure isolation (one dead addon never
 * fails the pass) and per-source observability (latency, raw/parsed/
 * exact-episode counts, error). Rows merge by exact release identity with
 * provenance retained. Eligibility gating, ranking, and provider binding
 * stay in the caller (media-request.js) so the same fulfillment pipeline
 * applies.
 *
 * @param {string} mediaId - Media identifier (e.g., "tt1234567")
 * @param {Object} options
 * @param {number} [options.season]
 * @param {number} [options.episode]
 * @param {string} [options.title]
 * @param {number} [options.year]
 * @param {string} [options.wantedImdbId]
 * @param {Array} [options.addons] - Stremio addon list override (default: configured)
 * @param {Array} [options.torznabIndexers] - Torznab indexer list override
 * @param {Object} [options.env] - Env override for Prowlarr client construction
 * @param {Object} [options.prowlarrClient] - Injected Prowlarr client (default: from env)
 * @returns {Promise<{ releases: Array, sources: Array }>}
 */
export async function runBloodhoundDiscovery(mediaId, options = {}) {
  const { season, episode, title, year, wantedImdbId } = options;
  const mediaType = episode != null ? 'series' : 'movie';

  // Stremio episode queries MUST carry the full :S:E suffix — a bare
  // series id returns series-level streams that cannot establish exact
  // episode coverage downstream.
  let stremioMediaId = mediaId;
  if (season != null && episode != null) {
    stremioMediaId = `${mediaId}:${season}:${episode}`;
  } else if (season != null) {
    stremioMediaId = `${mediaId}:${season}`;
  }

  let addons = options.addons;
  if (!addons) {
    try {
      addons = await loadDiscoveryAddons();
    } catch {
      addons = [];
    }
  }

  const stremioReports = [];
  const torznabReports = [];

  const stremioTask = (Array.isArray(addons) && addons.length > 0)
    ? searchStremio({
      type: mediaType,
      mediaId: stremioMediaId,
      addons,
      onSourceResult: (r) => stremioReports.push(r),
    })
    : Promise.resolve([]);

  const torznabTask = searchTorznab({
    type: mediaType,
    mediaId,
    ...(options.torznabIndexers ? { indexers: options.torznabIndexers } : {}),
    onSourceResult: (r) => torznabReports.push(r),
  });

  const prowlarrClient = options.prowlarrClient ?? prowlarrClientFromEnv(options.env);

  // Layer 1 (fast): Stremio + Torznab in parallel. Never stop after the
  // first source — every fast source settles independently.
  const [stremioSettled, torznabSettled] = await Promise.all([
    stremioTask.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
    torznabTask.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error })),
  ]);

  const stremioRows = stremioSettled.ok && Array.isArray(stremioSettled.value) ? stremioSettled.value : [];
  const torznabRows = torznabSettled.ok && Array.isArray(torznabSettled.value) ? torznabSettled.value : [];

  // Layer 2 (escalation): Prowlarr runs only when the fast layer yields no
  // viable candidate. A configured-but-skipped Prowlarr is recorded as
  // skipped_fast_sufficient (not queried_empty — it was never asked).
  const fastViable = countViableBloodhoundRows([...stremioRows, ...torznabRows], season, episode);
  let prowlarrRows = [];
  let prowlarrError = null;
  let prowlarrSkipped = false;
  let prowlarrLatencyMs = null;
  if (prowlarrClient && fastViable === 0) {
    const prowlarrStartedAt = Date.now();
    try {
      const value = await searchProwlarr({
        type: mediaType, title: title ?? null, year: year ?? null,
        season, episode, wantedImdbId: wantedImdbId ?? mediaId, client: prowlarrClient,
      });
      prowlarrRows = Array.isArray(value) ? value : [];
    } catch (error) {
      prowlarrError = String(error?.message || error || 'unknown error');
    }
    prowlarrLatencyMs = Date.now() - prowlarrStartedAt;
  } else if (prowlarrClient) {
    prowlarrSkipped = true;
  }

  const merged = mergeBloodhoundRows([stremioRows, torznabRows, prowlarrRows]);
  // Fulfillment-pipeline shape (same contract as runLiveDiscovery), with
  // merged multi-source provenance preserved on every release.
  const releases = merged.map(toBloodhoundRelease);

  // Attribute merged rows back to each reporting source for exact-episode
  // observability (a row returned by two sources counts for both).
  const rowsForSource = (report) => releases.filter((r) =>
    (r.sources || []).some((s) =>
      (s?.addonId || s?.observer || s?.indexer) === (report.addonId || report.addonName)));

  const sources = [];
  for (const report of [...stremioReports, ...torznabReports]) {
    const rows = rowsForSource(report);
    let exactEpisodeCount = 0;
    let unknownEpisodeCount = 0;
    let wrongEpisodeCount = 0;
    for (const row of rows) {
      const cls = classifyBloodhoundEpisode(row, season, episode);
      if (cls === 'exact') exactEpisodeCount++;
      else if (cls === 'unknown') unknownEpisodeCount++;
      else if (cls === 'wrong') wrongEpisodeCount++;
    }
    sources.push({
      id: report.addonId || report.addonName || 'unknown',
      name: report.addonName || null,
      provider: report.provider || null,
      debridProvider: report.debridProvider || null,
      sourceClass: 'stremio',
      latencyMs: report.latencyMs ?? null,
      rawCount: report.rawCount ?? 0,
      parsedCount: report.parsedCount ?? rows.length,
      exactEpisodeCount,
      unknownEpisodeCount,
      wrongEpisodeCount,
      error: report.error || null,
      disposition: bloodhoundDisposition({ error: report.error, parsedCount: report.parsedCount ?? 0 }),
    });
  }
  // Torznab reports carry the same shape; mark their class explicitly.
  for (const source of sources) {
    if (source.provider === 'torznab') source.sourceClass = 'torznab';
  }
  if (prowlarrClient || prowlarrError) {
    const prowlarrRowsForCount = releases.filter((r) =>
      (r.sources || []).some((s) => s?.origin === 'prowlarr' || s?.provider === 'prowlarr'));
    let exact = 0;
    let unknown = 0;
    let wrong = 0;
    const target = prowlarrRowsForCount.length > 0 ? prowlarrRowsForCount : prowlarrRows;
    for (const row of target) {
      const cls = classifyBloodhoundEpisode(row, season, episode);
      if (cls === 'exact') exact++;
      else if (cls === 'unknown') unknown++;
      else if (cls === 'wrong') wrong++;
    }
    sources.push({
      id: 'prowlarr',
      name: 'Prowlarr',
      provider: 'prowlarr',
      debridProvider: null,
      sourceClass: 'prowlarr',
      latencyMs: prowlarrLatencyMs,
      rawCount: prowlarrRows.length,
      parsedCount: prowlarrRows.length,
      exactEpisodeCount: exact,
      unknownEpisodeCount: unknown,
      wrongEpisodeCount: wrong,
      error: prowlarrError,
      disposition: prowlarrSkipped
        ? 'skipped_fast_sufficient'
        : (prowlarrClient
          ? bloodhoundDisposition({ error: prowlarrError, parsedCount: prowlarrRows.length })
          : 'not_configured'),
    });
  }

  // A configured addon that never reported (threw before reporting) is a
  // source we must still account for — otherwise "all sources queried" is
  // unverifiable.
  const reportedIds = new Set([...stremioReports, ...torznabReports].map((r) => r.addonId || r.addonName));
  for (const addon of (addons || [])) {
    const id = addon.addon_id || addon.id;
    if (!id || reportedIds.has(id)) continue;
    sources.push({
      id,
      name: addon.name || null,
      provider: addon.provider || null,
      debridProvider: addon.debridProvider || null,
      sourceClass: 'stremio',
      latencyMs: null,
      rawCount: 0,
      parsedCount: 0,
      exactEpisodeCount: 0,
      unknownEpisodeCount: 0,
      wrongEpisodeCount: 0,
      error: stremioSettled.ok ? null : String(stremioSettled.error?.message || stremioSettled.error || 'unknown error'),
      disposition: 'upstream_error',
    });
  }

  return { releases, sources };
}

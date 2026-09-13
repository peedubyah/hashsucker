/**
 * Sonarr/Radarr intent sync (anticipatory tranche: Arr as sensors).
 *
 * Batch reconciliation, not per-item polling:
 *   fetch monitored catalog(s)      (2-4 API calls total per sync)
 *     ↓
 *   pure diff vs existing intents   (tested without network)
 *     ↓
 *   upsert new/changed, withdraw unmonitored anticipated rows
 *
 * Arr never chooses releases/providers and never triggers downloads.
 * Identity is exact IDs only (IMDb preferred; unresolvable items are
 * counted and skipped, never fuzzy-matched).
 */
import { createArrClient, isoDay } from './arr-client.js';

const SYNC_SCHEMA = `
CREATE TABLE IF NOT EXISTS arr_sync_state (
  source TEXT PRIMARY KEY,
  last_sync INTEGER,
  last_error TEXT,
  imported_movies INTEGER NOT NULL DEFAULT 0,
  imported_episodes INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

function ensureSyncSchema(db) {
  db.exec(SYNC_SCHEMA);
}

function parseDate(value) {
  if (value == null) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
}

function normId(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

/** Radarr movie row → intent descriptor (or null with a skip reason). */
export function mapRadarrMovie(movie) {
  if (!movie || typeof movie !== 'object') return { skip: 'not-an-object' };
  if (movie.monitored !== true) return { skip: 'unmonitored' };
  const imdbId = normId(movie.imdbId);
  const tmdbId = movie.tmdbId != null ? String(movie.tmdbId) : null;
  const mediaId = /^tt\d{7,}$/.test(imdbId || '') ? imdbId : null;
  if (!mediaId) return { skip: tmdbId ? 'no-imdb-id' : 'no-identity' };
  const expectedAt = parseDate(movie.digitalRelease) ?? parseDate(movie.physicalRelease) ?? parseDate(movie.inCinemas) ?? null;
  // Library rows carry a numeric Radarr id; lookup (unadded) rows do not —
  // key those on the stable tmdbId so sources stay unique per movie.
  const ref = Number.isSafeInteger(movie.id) && movie.id > 0 ? String(movie.id) : `tmdb${tmdbId ?? 'unknown'}`;
  return {
    mediaType: 'movie',
    mediaId,
    season: null,
    episode: null,
    source: `radarr:movie:${ref}`,
    expectedAt,
    satisfied: movie.hasFile === true,
    title: movie.title ?? null,
  };
}

/** Sonarr calendar entry → intent descriptor (or null with a skip reason). */
export function mapSonarrEntry(entry) {
  if (!entry || typeof entry !== 'object') return { skip: 'not-an-object' };
  const series = entry.series || {};
  if (series.monitored !== true) return { skip: 'series-unmonitored' };
  if (entry.monitored === false) return { skip: 'episode-unmonitored' };
  const season = Number.isSafeInteger(entry.seasonNumber) ? entry.seasonNumber : null;
  const episode = Number.isSafeInteger(entry.episodeNumber) ? entry.episodeNumber : null;
  if (season == null || episode == null || season < 0 || episode < 1) return { skip: 'bad-coordinates' };
  const imdbId = normId(series.imdbId);
  const mediaId = /^tt\d{7,}$/.test(imdbId || '') ? imdbId : null;
  if (!mediaId) return { skip: 'no-imdb-id' };
  const file = entry.episodeFile || null;
  return {
    mediaType: 'series',
    mediaId,
    season,
    episode,
    source: `sonarr:${entry.seriesId}:S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`,
    expectedAt: parseDate(entry.airDateUtc),
    satisfied: !!(file && file.id != null),
    title: series.title ?? entry.title ?? null,
  };
}

/**
 * Pure diff: Arr descriptors vs existing intent rows.
 * Returns { upserts, unmonitoredSources }.
 * - upserts: descriptors to insert/refresh (new or date/satisfaction changed).
 * - unmonitoredSources: previously-seen Arr sources absent from this sync
 *   (caller withdraws only never-prepared anticipated rows).
 */
export function diffArrIntents(descriptors, existingRows) {
  const bySource = new Map((existingRows || []).map((r) => [r.source, r]));
  const seen = new Set();
  const upserts = [];
  const skipped = {};
  for (const d of descriptors) {
    if (!d || d.skip) {
      if (d?.skip) skipped[d.skip] = (skipped[d.skip] ?? 0) + 1;
      continue;
    }
    seen.add(d.source);
    const cur = bySource.get(d.source);
    if (!cur) {
      upserts.push({ ...d, change: 'new' });
    } else if (
      (cur.expected_at ?? null) !== (d.expectedAt ?? null)
      || (cur.arr_satisfied ?? 0) !== (d.satisfied ? 1 : 0)
    ) {
      upserts.push({ ...d, change: 'refresh' });
    }
  }
  const unmonitoredSources = [];
  for (const r of existingRows || []) {
    if ((r.source || '').startsWith('radarr:') || (r.source || '').startsWith('sonarr:')) {
      if (!seen.has(r.source)) unmonitoredSources.push(r.source);
    }
  }
  return { upserts, unmonitoredSources, skipped };
}

export function createArrSync({
  db,
  radarr = null,
  sonarr = null,
  clock = () => Date.now(),
  log = () => {},
} = {}) {
  if (!db) throw new Error('arr sync requires db');
  ensureSyncSchema(db);
  const now = () => clock();

  function recordSync(source, patch) {
    db.prepare(`INSERT INTO arr_sync_state (source, updated_at) VALUES (?, ?)
      ON CONFLICT(source) DO NOTHING`).run(source, now());
    const cols = [];
    const vals = [];
    for (const [k, v] of Object.entries(patch)) {
      if (['last_sync', 'last_error', 'imported_movies', 'imported_episodes'].includes(k)) {
        cols.push(`${k} = ?`);
        vals.push(v);
      }
    }
    cols.push('updated_at = ?');
    vals.push(now(), source);
    if (cols.length) db.prepare(`UPDATE arr_sync_state SET ${cols.join(', ')} WHERE source = ?`).run(...vals);
  }

  function syncState() {
    try {
      return db.prepare('SELECT * FROM arr_sync_state').all();
    } catch {
      return [];
    }
  }

  /**
   * Run one bounded sync. Each configured Arr gets a small fixed number
   * of list/calendar calls; failures leave existing intents intact.
   * Returns a compact summary (safe for logs/diagnostics).
   */
  async function syncOnce({ store, windowDays = 60 } = {}) {
    if (!store) throw new Error('arr sync requires intent store');
    const summary = { radarr: null, sonarr: null };
    const t = now();
    const start = new Date(t - 7 * 86400 * 1000);
    const end = new Date(t + windowDays * 86400 * 1000);

    if (radarr) {
      try {
        const movies = await radarr.radarrMovies();
        const descriptors = movies.map(mapRadarrMovie);
        const { applied, skipped } = applyDescriptors(store, descriptors);
        const imported = descriptors.filter((d) => !d.skip).length;
        recordSync('radarr', { last_sync: now(), last_error: null, imported_movies: imported, imported_episodes: 0 });
        summary.radarr = { ok: true, movies: movies.length, intents: imported, applied, skipped };
      } catch (err) {
        recordSync('radarr', { last_error: String(err?.message || err).slice(0, 200) });
        summary.radarr = { ok: false, error: String(err?.message || err).slice(0, 120) };
      }
    }

    if (sonarr) {
      try {
        const entries = await sonarr.sonarrCalendar({
          start: isoDay(start.getTime()), end: isoDay(end.getTime()), unmonitored: false,
        });
        const descriptors = entries.map(mapSonarrEntry);
        const { applied, skipped } = applyDescriptors(store, descriptors);
        const imported = descriptors.filter((d) => !d.skip).length;
        recordSync('sonarr', { last_sync: now(), last_error: null, imported_movies: 0, imported_episodes: imported });
        summary.sonarr = { ok: true, entries: entries.length, intents: imported, applied, skipped };
      } catch (err) {
        recordSync('sonarr', { last_error: String(err?.message || err).slice(0, 200) });
        summary.sonarr = { ok: false, error: String(err?.message || err).slice(0, 120) };
      }
    }
    return summary;
  }

  return { syncOnce, syncState, recordSync };
}

/** Apply descriptors to the intent store (insert/refresh + unmonitored withdraw). Visible for tests. */
export function applyDescriptors(store, descriptors, { prepareDays = 30, nowMs = Date.now() } = {}) {
  const existing = store.listArrSources();
  const { upserts, unmonitoredSources, skipped } = diffArrIntents(descriptors, existing);
  let applied = 0;
  for (const u of upserts) {
    const { intent } = store.seed({
      mediaType: u.mediaType,
      mediaId: u.mediaId,
      season: u.season,
      episode: u.episode,
      source: u.source,
      expectedAt: u.expectedAt,
    });
    store.refreshArr(intent.id, {
      expectedAt: u.expectedAt,
      satisfied: u.satisfied,
      nextCheckAt: arrNextCheck({ expectedAt: u.expectedAt, satisfied: u.satisfied }, nowMs, { prepareDays }),
    });
    applied++;
  }
  let withdrawn = 0;
  for (const source of unmonitoredSources) {
    withdrawn += store.withdrawUnmonitored(source);
  }
  return { applied, withdrawn, skipped };
}

/**
 * Next-check policy for Arr-managed intents (Phase 5/6): far-future
 * expectations sleep until the prepare window; satisfied intents park
 * (the next Arr sync re-arms them if files disappear).
 */
export function arrNextCheck({ expectedAt = null, satisfied = false }, nowMs, { prepareDays = 30 } = {}) {
  if (satisfied) return nowMs + 30 * 86400 * 1000;
  if (expectedAt == null) return nowMs;
  const windowStart = expectedAt - prepareDays * 86400 * 1000;
  return windowStart <= nowMs ? nowMs : windowStart;
}

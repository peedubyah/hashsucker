/**
 * Sonarr/Radarr read client (anticipatory tranche: Arr as sensors).
 *
 * Minimal GET surface over the stable v3 APIs. No downloads, no queue
 * manipulation, no library edits — list/calendar reads only. Keys stay
 * in memory; nothing here prints them.
 */
const DEFAULT_TIMEOUT_MS = 15_000;

export function createArrClient({ baseUrl, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchFn = fetch } = {}) {
  if (!baseUrl) throw new Error('arr client requires baseUrl');
  const base = String(baseUrl).replace(/\/+$/, '');

  async function get(path, params = {}) {
    const url = new URL(`${base}/api/v3/${path.replace(/^\/+/, '')}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(url.toString(), {
        headers: { 'X-Api-Key': apiKey ?? '', Accept: 'application/json' },
        signal: ctl.signal,
      });
      if (res.status === 401 || res.status === 403) {
        const err = new Error(`arr auth rejected (${res.status})`);
        err.code = 'ARR_AUTH';
        throw err;
      }
      if (!res.ok) throw new Error(`arr GET ${path} HTTP ${res.status}`);
      return res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async status() {
      return get('/system/status');
    },
    // Radarr: full movie catalog in one call (monitored, files, dates, IDs).
    async radarrMovies() {
      const rows = await get('/movie');
      return Array.isArray(rows) ? rows : [];
    },
    // Radarr: upcoming calendar window.
    async radarrCalendar({ start, end, unmonitored = false } = {}) {
      return get('/calendar', { start, end, unmonitored });
    },
    // Sonarr: episode calendar window (series + episode identity + air
    // dates + file presence in one range call — no per-series N+1).
    async sonarrCalendar({ start, end, unmonitored = false, includeEpisodeFile = true } = {}) {
      const rows = await get('/calendar', { start, end, unmonitored, includeEpisodeFile });
      return Array.isArray(rows) ? rows : [];
    },
    // Sonarr: series catalog (monitored flags, IDs). One call.
    async sonarrSeries() {
      const rows = await get('/series');
      return Array.isArray(rows) ? rows : [];
    },
  };
}

/** ISO day for calendar windows (YYYY-MM-DD). */
export function isoDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

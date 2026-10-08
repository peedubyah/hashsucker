/**
 * Plex active-session polling (consumption-aware retention tranche).
 *
 * Read-only use of the existing PLEX_URL/PLEX_TOKEN pair — no new
 * config, no webhook registration, no Plex Pass dependency. Sessions
 * answer "playback started" and coarse progress reliably; completion
 * is inferred conservatively (high progress observed, then gone) and
 * only ever SHORTENS retirement to a grace period, never deletes
 * immediately. TTL remains the fallback when Plex is absent.
 *
 * Identity reuses the consumer/plex.js IMDb mapping (agent guids),
 * never fuzzy titles.
 */
const DEFAULT_TIMEOUT_MS = 8000;

function imdbFromGuids(session) {
  const ids = [];
  const push = (v) => {
    if (typeof v !== 'string') return;
    const m = v.match(/(tt\d{7,})/);
    if (m) ids.push(m[1]);
  };
  const guid = session?.Guid ?? session?.guid;
  if (Array.isArray(guid)) {
    for (const g of guid) push(g?.id ?? g);
  } else {
    push(guid);
  }
  push(session?.grandparentGuid);
  push(session?.parentGuid);
  return ids.length > 0 ? ids[0] : null;
}

/**
 * Map one Plex session Metadata entry to HashSucker identity +
 * progress. Returns null when unmappable (never fuzzy-matched).
 */
export function mapSessionEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const mediaId = imdbFromGuids(entry);
  if (!mediaId) return null;
  const type = String(entry.type || entry.mediaType || '');
  const isEpisode = type === 'episode'
    || (Number.isSafeInteger(entry.parentIndex) && Number.isSafeInteger(entry.index));
  const season = isEpisode && Number.isSafeInteger(entry.parentIndex) ? entry.parentIndex : null;
  const episode = isEpisode && Number.isSafeInteger(entry.index) ? entry.index : null;
  if (isEpisode && (season == null || episode == null)) return null;
  const viewOffset = Number(entry.viewOffset) || 0;
  const duration = Number(entry.duration) || 0;
  const progress = duration > 0 ? viewOffset / duration : 0;
  const state = entry.Player?.state ?? entry.playerState ?? null;
  const part = entry.Media?.flatMap((media) => media.Part ?? []).find((candidate) => candidate.file);
  return {
    mediaId,
    mediaType: isEpisode ? 'episode' : 'movie',
    season, episode,
    viewOffset, duration, progress,
    partFile: part?.file ?? null,
    partId: part?.id ?? null,
    playerState: typeof state === 'string' ? state : null,
    sessionId: entry.Session?.id ?? entry.sessionId ?? null,
    ratingKey: entry.ratingKey != null ? String(entry.ratingKey) : null,
  };
}

export async function fetchPlexSessions({ plexUrl, plexToken, fetchFn = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!plexUrl || !plexToken) return { ok: false, reason: 'plex-not-configured', sessions: [] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const url = `${String(plexUrl).replace(/\/+$/, '')}/status/sessions`;
    const res = await fetchFn(url, {
      headers: { 'X-Plex-Token': plexToken, Accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) return { ok: false, reason: `plex-http-${res.status}`, sessions: [] };
    const data = await res.json().catch(() => null);
    const container = data?.MediaContainer;
    const entries = container?.Metadata;
    const empty = container && Number(container.size) === 0 && entries == null;
    if (empty) return { ok: true, sessions: [], total: 0 };
    if (!Array.isArray(entries)) return { ok: false, reason: 'bad-shape', sessions: [] };
    const sessions = [];
    for (const e of entries) {
      let mapped = mapSessionEntry(e);
      if (!mapped && e?.ratingKey != null) {
        const metadataRes = await fetchFn(`${String(plexUrl).replace(/\/+$/, '')}/library/metadata/${encodeURIComponent(e.ratingKey)}`, {
          headers: { 'X-Plex-Token': plexToken, Accept: 'application/json' },
          signal: ctl.signal,
        });
        if (metadataRes.ok) {
          const metadata = await metadataRes.json().catch(() => null);
          const identity = metadata?.MediaContainer?.Metadata?.[0];
          let seriesIdentity = identity?.Guid ?? e.Guid;
          if (String(e.type || e.mediaType) === 'episode' && e.grandparentRatingKey != null) {
            const seriesRes = await fetchFn(`${String(plexUrl).replace(/\/+$/, '')}/library/metadata/${encodeURIComponent(e.grandparentRatingKey)}`, {
              headers: { 'X-Plex-Token': plexToken, Accept: 'application/json' },
              signal: ctl.signal,
            });
            if (seriesRes.ok) {
              const series = await seriesRes.json().catch(() => null);
              seriesIdentity = series?.MediaContainer?.Metadata?.[0]?.Guid ?? seriesIdentity;
            }
          }
          mapped = mapSessionEntry({ ...identity, ...e, Guid: seriesIdentity });
        }
      }
      if (mapped) sessions.push(mapped);
    }
    return { ok: true, sessions, total: entries.length };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err).slice(0, 100), sessions: [] };
  }
}

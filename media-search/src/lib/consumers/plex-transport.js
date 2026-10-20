/**
 * The Plex HTTP transport, shared by the consumer adapter and the
 * projection observer.
 *
 * One place that knows how to talk to Plex, so the adapter (which maps
 * the library onto HashSucker's intents) and the observer (which reports
 * what Plex actually holds) cannot drift apart in their basic request
 * shape.
 */

const FETCH_TIMEOUT_MS = 60_000;

function baseUrl() {
  const raw = String(process.env.PLEX_URL || '').replace(/\/$/, '');
  if (!raw) throw new Error('plex-unconfigured: PLEX_URL is not set');
  return raw;
}

function token() {
  const t = String(process.env.PLEX_TOKEN || '');
  if (!t) throw new Error('plex-unconfigured: PLEX_TOKEN is not set');
  return t;
}

/**
 * A bounded GET against Plex. Throws on a non-2xx answer: a consumer that
 * cannot be read is UNKNOWN, never absent.
 */
export async function getJson(pathname, params = {}) {
  const url = new URL(baseUrl() + pathname);
  for (const [k, v] of Object.entries(params)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const response = await fetch(url.toString(), {
    headers: { accept: 'application/json', 'X-Plex-Token': token() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`plex-http-${response.status}`);
  return response.json();
}

export { baseUrl as plexBaseUrl, token as plexToken };

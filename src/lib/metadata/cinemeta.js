const DEFAULT_BASE = 'https://v3-cinemeta.strem.io';

function baseUrl() {
  return String(process.env.CINEMETA_BASE_URL || DEFAULT_BASE).replace(/\/$/, '');
}

async function getJson(pathname, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl()}${pathname}`, {
    headers: { accept: 'application/json', 'user-agent': 'media-search/0.1.0' },
  });
  if (!response.ok) throw new Error(`Metadata service returned HTTP ${response.status}`);
  return response.json();
}

function publicMeta(meta) {
  return {
    id: meta.id,
    type: meta.type,
    name: meta.name,
    poster: meta.poster || null,
    year: meta.year || meta.releaseInfo || null,
    description: meta.description || null,
  };
}

export async function searchCatalog(query, fetchImpl = fetch) {
  const q = String(query || '').trim();
  if (q.length < 2 || q.length > 120) throw new Error('Search must be 2–120 characters');
  const types = ['series', 'movie'];
  const attempts = await Promise.allSettled(types.map((type) =>
    getJson(`/catalog/${type}/top/search=${encodeURIComponent(q)}.json`, fetchImpl)
  ));
  const payloads = attempts.filter((attempt) => attempt.status === 'fulfilled').map((attempt) => attempt.value);
  if (payloads.length === 0) throw attempts[0].reason;
  const needle = q.toLowerCase();
  const relevance = (meta) => {
    const name = String(meta.name || '').toLowerCase();
    if (name === needle) return 0;
    if (name.startsWith(needle)) return 1;
    if (name.includes(needle)) return 2;
    return 3;
  };
  return payloads.flatMap((payload) => payload.metas || []).map(publicMeta)
    .map((meta, index) => ({ meta, index }))
    .sort((a, b) => relevance(a.meta) - relevance(b.meta) || a.index - b.index)
    .map(({ meta }) => meta)
    .slice(0, 40);
}

export async function getMedia(type, id, fetchImpl = fetch) {
  if (!['series', 'movie'].includes(type)) throw new Error('Invalid media type');
  if (!/^[a-z0-9:_-]+$/i.test(String(id || ''))) throw new Error('Invalid media ID');
  const payload = await getJson(`/meta/${type}/${encodeURIComponent(id)}.json`, fetchImpl);
  if (!payload.meta) return null;
  const media = publicMeta(payload.meta);
  media.videos = type === 'series'
    ? (payload.meta.videos || []).filter((video) =>
        Number.isInteger(video.season) && Number.isInteger(video.episode) && video.episode > 0
      ).map((video) => ({
        id: video.id,
        season: video.season,
        episode: video.episode,
        title: video.title || `Episode ${video.episode}`,
        released: video.released || null,
        thumbnail: video.thumbnail || null,
      }))
    : [];
  return media;
}

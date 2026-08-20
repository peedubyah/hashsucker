/**
 * Source Registry
 *
 * Defines discovery sources as data, not hard-coded branches.
 * New sources can be added by appending to this registry.
 */

export function loadSourceRegistry() {
  const sources = [];

  // Stremio/Torrentio/TorBox
  if (process.env.TORBOX_API_KEY) {
    sources.push({
      id: 'torrentio.torbox',
      kind: 'torrentio',
      enabled: true,
      provider: 'torbox',
      endpoint: buildTorrentioUrl('torbox', process.env.TORBOX_API_KEY),
      timeoutMs: 5000,
      priority: 1,
      capabilities: {
        imdb: false,
        textSearch: true,
        fileIndex: false,
        torrentDownload: false,
      },
    });
  }

  // Stremio/Torrentio/Real-Debrid
  if (process.env.REALDEBRID_API_KEY) {
    sources.push({
      id: 'torrentio.realdebrid',
      kind: 'torrentio',
      enabled: true,
      provider: 'realdebrid',
      endpoint: buildTorrentioUrl('realdebrid', process.env.REALDEBRID_API_KEY),
      timeoutMs: 5000,
      priority: 2,
      capabilities: {
        imdb: false,
        textSearch: true,
        fileIndex: false,
        torrentDownload: false,
      },
    });
  }

  // Comet manual manifest
  if (process.env.COMET_MANIFEST_URL) {
    sources.push({
      id: 'comet.manual',
      kind: 'stremio',
      enabled: true,
      provider: 'comet',
      endpoint: process.env.COMET_MANIFEST_URL,
      timeoutMs: 5000,
      priority: 3,
      capabilities: {
        imdb: false,
        textSearch: true,
        fileIndex: false,
        torrentDownload: false,
      },
    });
  }

  // Torznab instances from TORZNAB_URLS
  const torznabSources = loadTorznabSources();
  sources.push(...torznabSources);

  return sources.filter((s) => s.enabled);
}

function buildTorrentioUrl(provider, apiKey) {
  const encoded = encodeURIComponent(apiKey);
  return `https://torrentio.strem.fun/${provider}=${encoded}/manifest.json`;
}

function loadTorznabSources() {
  const urlsRaw = process.env.TORZNAB_URLS;
  if (!urlsRaw) return [];

  let configs;
  try {
    configs = JSON.parse(urlsRaw);
  } catch {
    return [];
  }
  if (!Array.isArray(configs)) return [];

  return configs
    .map((config, index) => {
      if (typeof config === 'string') {
        return {
          id: `torznab.${index}`,
          kind: 'torznab',
          enabled: true,
          provider: null,
          endpoint: config,
          timeoutMs: 5000,
          priority: 100 + index,
          capabilities: {
            imdb: true,
            textSearch: true,
            fileIndex: false,
            torrentDownload: true,
          },
        };
      }
      if (!config || typeof config !== 'object') return null;
      return {
        id: config.id || `torznab.${index}`,
        kind: 'torznab',
        enabled: config.enabled !== false,
        provider: config.provider || null,
        endpoint: config.url,
        timeoutMs: config.timeoutMs || 5000,
        priority: config.priority ?? 100 + index,
        capabilities: {
          imdb: true,
          textSearch: true,
          fileIndex: false,
          torrentDownload: true,
        },
      };
    })
    .filter((c) => c && c.endpoint);
}

export function getSourceById(sourceId) {
  return loadSourceRegistry().find((s) => s.id === sourceId);
}

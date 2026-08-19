import fs from 'node:fs/promises';

const input = new URL('../../config/addons.local.json', import.meta.url);
const output = new URL('../../config/addons.discovery.local.json', import.meta.url);

const addons = JSON.parse(await fs.readFile(input, 'utf8'));

const discovery = addons
  .filter((addon) => addon.addon_id === 'stremio.comet.fast')
  .map((addon) => {
    const url = new URL(addon.manifest_url);
    const parts = url.pathname.split('/').filter(Boolean);

    const encoded = parts.at(-2);
    if (!encoded || parts.at(-1) !== 'manifest.json') {
      throw new Error(`Unexpected Comet manifest URL for ${addon.name}`);
    }

    const config = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf8')
    );

    // Make Comet discovery-only. Our app will handle debrid providers.
    config.debridServices = [];
    config.cachedOnly = false;
    config.enableTorrent = true;
    config.scrapeDebridAccountTorrents = false;

    // Don't preserve any debrid proxy credential either.
    config.debridStreamProxyPassword = '';

    const discoveryEncoded = Buffer
      .from(JSON.stringify(config))
      .toString('base64');

    url.pathname = `/${discoveryEncoded}/manifest.json`;

    return {
      ...addon,
      name: 'Comet Discovery',
      manifest_url: url.toString(),
      enabled: 1,
      sort_order: 0,
    };
  });

await fs.writeFile(output, JSON.stringify(discovery, null, 2));

console.log(`Wrote ${discovery.length} discovery addon(s).`);
console.log('No debrid credentials retained.');
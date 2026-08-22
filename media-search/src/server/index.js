import { createControlPlaneStore } from '../lib/control-plane/store.js';
import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const discoveryCache = createDiscoveryCache(process.env.DISCOVERY_DB ? { dbPath: process.env.DISCOVERY_DB } : {});
const controlPlaneStore = createControlPlaneStore(
  process.env.CONTROL_PLANE_DB ? { dbPath: process.env.CONTROL_PLANE_DB } : {},
);
const server = createApp({ searchCache: discoveryCache, controlPlaneStore });
let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`media-search received ${signal}; shutting down`);
  server.close(() => {
    discoveryCache.close();
    controlPlaneStore.close();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(port, host, () => {
  console.log(`media-search listening on http://${host}:${port}`);
});

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import { runDMMIngestion } from '../lib/discovery/dmm-ingestion-runner.js';

const dbPath = process.env.DISCOVERY_DB ?? './discovery-cache.db';

console.log(`Starting DMM ingestion`);
console.log(`Database: ${dbPath}`);

const cache = createDiscoveryCache({ dbPath });

const result = await runDMMIngestion({
  cache,
  enableAttributeParsing: true,
  enableMediaEnrichment: false,
  onProgress(metrics) {
    const m = metrics.toJSON();
    console.log(
      `fragments=${m.fragmentsProcessed} records=${m.recordsProcessed} inserted=${m.recordsInserted}`
    );
  },
});

console.log(JSON.stringify(result, null, 2));

cache.close?.();
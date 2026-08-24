/**
 * Request inspector runner — invoked by the diagnostic system.
 * Outputs JSON with requests, recommendations, and summary.
 */

import path from 'node:path';
import { inspectRequests } from './request-inspector.js';

const REQUESTS_ROOT = process.env.REQUESTS_ROOT || '/requests';

async function main() {
  const result = await inspectRequests({
    requestsRoot: REQUESTS_ROOT,
    now: () => Date.now(),
  });

  // Output as JSON for the diagnostic system
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});

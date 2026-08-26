/**
 * Request inspector runner — invoked by the diagnostic system.
 *
 * Filesystem-based inspection is unavailable in container-native
 * environments. The endpoint now returns an unsupported structured
 * result directing operators to the container-native alternatives.
 */

import { inspectRequests } from './request-inspector.js';

async function main() {
  const result = await inspectRequests();
  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({ error: err.message }));
  process.exit(1);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('production image installs locked runtime dependencies and includes the UI', async () => {
  const dockerfile = await fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY ui\/package\.json ui\/package-lock\.json/);
  assert.match(dockerfile, /RUN npm ci$/m);
  assert.match(dockerfile, /RUN npm ci --omit=dev/);
  assert.match(dockerfile, /COPY --chown=node:node --from=ui-build \/build\/ui\/dist\/ \.\/public\//);
  assert.match(dockerfile, /^USER node$/m);
});

test('root Compose persists discovery and restricts the unauthenticated UI/API by default', async () => {
  const compose = await fs.readFile(new URL('../../compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /DISCOVERY_DB: \/data\/discovery-cache\.db/);
  assert.match(compose, /- discovery-data:\/data/);
  assert.match(compose, /^volumes:\s*\n\s+discovery-data:/m);
  assert.match(compose, /\$\{MEDIA_SEARCH_BIND_ADDRESS:-127\.0\.0\.1\}/);
  assert.match(compose, /group_add:\s*\n\s*- ["']\$\{MEDIA_SEARCH_QUEUE_GID:-100\}["']/);
  assert.doesNotMatch(compose, /^\s*user:\s*(?:root|0)/m);
});

test('importer image starts its worker and provides GNU find semantics', async () => {
  const dockerfile = await fs.readFile(new URL('../../torbox-importer/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /^\s*findutils$/m);
  assert.match(dockerfile, /^CMD \["\/app\/scripts\/worker\.sh"\]$/m);
  assert.doesNotMatch(dockerfile, /sleep.*infinity/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

test('Compose preserves non-root node user and supplementary spool group', async () => {
  const [dockerfile, compose] = await Promise.all([
    fs.readFile(new URL('../Dockerfile', import.meta.url), 'utf8'),
    fs.readFile(new URL('../compose.yaml', import.meta.url), 'utf8'),
  ]);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(compose, /group_add:\s*\n\s*- ["']100["']/);
  assert.doesNotMatch(compose, /^\s*user:\s*(?:root|0)/m);
});

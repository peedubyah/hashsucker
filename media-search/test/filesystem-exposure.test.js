import assert from 'node:assert/strict';
import test from 'node:test';

import { PROVIDER_CAPABILITIES } from '../src/lib/providers/capabilities.js';
import {
  createTorBoxNativeWebDavExposureProvider,
  createZurgExposureProvider,
} from '../src/lib/providers/filesystem-exposure.js';

const FILE = {
  providerResourceId: 'rd-resource-1',
  providerFileId: 'rd-file-9',
  relativePath: 'Release/movie.mkv',
};

function stat({ file = true, symbolicLink = false, size = 1000 } = {}) {
  return { isFile: () => file, isSymbolicLink: () => symbolicLink, size };
}

test('Zurg seam observes only an explicit file mapping under a read-only mount', async () => {
  let observedPath;
  const adapter = createZurgExposureProvider({
    accountScope: 'primary', rootPath: '/mnt/realdebrid', readOnly: true,
    now: () => 10_000, exposureTtlMs: 2_000,
    async lstatFn(filePath) { observedPath = filePath; return stat(); },
  });

  const exposure = await adapter.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure(FILE);

  assert.equal(observedPath, '/mnt/realdebrid/Release/movie.mkv');
  assert.equal(exposure.provider, 'realdebrid');
  assert.equal(exposure.transport, 'zurg-rclone');
  assert.equal(exposure.state, 'visible');
  assert.equal(exposure.readOnly, true);
  assert.equal(exposure.expiresAt, 12_000);
  assert.equal(exposure.evidence.size, 1000);
});

test('filesystem seam rejects writable transports and path traversal', async () => {
  assert.throws(() => createZurgExposureProvider({
    rootPath: '/mnt/realdebrid', readOnly: false,
  }), /explicitly read-only/);

  const adapter = createZurgExposureProvider({
    rootPath: '/mnt/realdebrid', readOnly: true, lstatFn: async () => stat(),
  });
  await assert.rejects(
    () => adapter.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure({ ...FILE, relativePath: '../escape.mkv' }),
    /cannot traverse parent/,
  );
  await assert.rejects(
    () => adapter.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure({ ...FILE, relativePath: '/etc/passwd' }),
    /must be relative/,
  );
});

test('missing mount path becomes missing exposure, never provider removal evidence', async () => {
  const adapter = createZurgExposureProvider({
    rootPath: '/mnt/realdebrid', readOnly: true,
    lstatFn: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });
  const exposure = await adapter.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure(FILE);

  assert.equal(exposure.state, 'missing');
  assert.equal(exposure.failureCategory, null);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.REMOVAL), false);
});

test('TorBox native-WebDAV mount seam remains observation-only with typed errors', async () => {
  const adapter = createTorBoxNativeWebDavExposureProvider({
    accountScope: 'primary', rootPath: '/mnt/torbox', readOnly: true,
    lstatFn: async () => { throw Object.assign(new Error('transport unavailable'), { code: 'ECONNRESET' }); },
  });
  const exposure = await adapter.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure({
    providerResourceId: 'tb-resource-1', providerFileId: 'tb-file-1', relativePath: 'movie.mkv',
  });

  assert.equal(exposure.provider, 'torbox');
  assert.equal(exposure.transport, 'torbox-native-webdav');
  assert.equal(exposure.state, 'error');
  assert.equal(exposure.failureCategory, 'network');
  assert.equal(exposure.retryable, true);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.PLACEMENT_CREATE), false);
  assert.equal(adapter.supports(PROVIDER_CAPABILITIES.REMOVAL), false);
});

test('directory presence is not treated as exact file visibility', async () => {
  const adapter = createZurgExposureProvider({
    rootPath: '/mnt/realdebrid', readOnly: true,
    lstatFn: async () => stat({ file: false }),
  });
  const exposure = await adapter.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure(FILE);
  assert.equal(exposure.state, 'missing');
});

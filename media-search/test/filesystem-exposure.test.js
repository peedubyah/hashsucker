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
  assert.equal(exposure.accountScope, 'primary');
  assert.equal(exposure.mountScope, 'default');
  assert.equal(exposure.transport, 'zurg-rclone');
  assert.equal(exposure.state, 'visible');
  assert.equal(exposure.readOnly, true);
  assert.match(exposure.exposureKey, /^path-sha256:[0-9a-f]{64}$/);
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

test('directory and symbolic-link presence are not treated as exact file visibility', async (t) => {
  for (const [name, fileStat] of [
    ['directory', stat({ file: false })],
    ['symbolic link', stat({ file: false, symbolicLink: true })],
  ]) {
    await t.test(name, async () => {
      const adapter = createZurgExposureProvider({
        rootPath: '/mnt/realdebrid', readOnly: true,
        lstatFn: async () => fileStat,
      });
      const exposure = await adapter.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure(FILE);
      assert.equal(exposure.state, 'missing');
    });
  }
});

test('exposure identity follows the scoped mapped path, not mutable provider IDs', async () => {
  const adapter = createZurgExposureProvider({
    accountScope: 'primary', mountScope: 'living-room',
    rootPath: '/mnt/realdebrid', readOnly: true,
    lstatFn: async () => stat(),
  });
  const capability = adapter.require(PROVIDER_CAPABILITIES.EXPOSURE);
  const beforeRepair = await capability.observeExposure(FILE);
  const afterRepair = await capability.observeExposure({
    providerResourceId: 'rd:replacement',
    providerFileId: 'file:after:repair',
    relativePath: FILE.relativePath,
  });

  assert.equal(beforeRepair.exposureKey, afterRepair.exposureKey);
  assert.equal(afterRepair.providerResourceId, 'rd:replacement');
  assert.equal(afterRepair.providerFileId, 'file:after:repair');

  const otherMount = createZurgExposureProvider({
    accountScope: 'primary', mountScope: 'bedroom',
    rootPath: '/mnt/realdebrid', readOnly: true,
    lstatFn: async () => stat(),
  });
  const otherExposure = await otherMount.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure(FILE);
  assert.notEqual(beforeRepair.exposureKey, otherExposure.exposureKey);
});

test('filesystem mount failures retain meaningful retry taxonomy', async (t) => {
  for (const [code, category, retryable] of [
    ['EIO', 'temporarily-unavailable', true],
    ['ESTALE', 'temporarily-unavailable', true],
    ['EACCES', 'authorization', false],
  ]) {
    await t.test(code, async () => {
      const adapter = createZurgExposureProvider({
        rootPath: '/mnt/realdebrid', readOnly: true,
        lstatFn: async () => { throw Object.assign(new Error(code), { code }); },
      });
      const exposure = await adapter.require(PROVIDER_CAPABILITIES.EXPOSURE).observeExposure(FILE);
      assert.equal(exposure.state, 'error');
      assert.equal(exposure.failureCategory, category);
      assert.equal(exposure.retryable, retryable);
    });
  }
});

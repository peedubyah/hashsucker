import assert from 'node:assert/strict';
import test from 'node:test';

import { createZurgTorrentMetadataObserver } from '../src/lib/providers/zurg-metadata.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

function stat({ file = true, symbolicLink = false, size = 1000 } = {}) {
  return {
    isFile: () => file,
    isSymbolicLink: () => symbolicLink,
    size,
  };
}

function metadata(overrides = {}) {
  return JSON.stringify({
    Name: 'Release',
    OriginalName: 'Release.mkv',
    Hash: HASH.toUpperCase(),
    State: 'under_repair_torrent',
    StateWhen: 1234,
    Version: 'v1',
    DownloadedIDs: ['temporary-rd-id'],
    IDsToDelete: ['replacement-rd-id'],
    SelectedFiles: {
      'opaque-zurg-key': {
        File: { id: 9, path: '/Release/movie.mkv', bytes: 1000, selected: 1 },
        Link: 'https://provider.invalid/secret-link',
        State: 'broken_file',
        Rename: 'Movie (2026).mkv',
      },
    },
    ...overrides,
  });
}

test('Zurg metadata observer reads an explicit torrent-level source-of-truth file without exposing links', async () => {
  let observedPath;
  const observer = createZurgTorrentMetadataObserver({
    accountScope: 'primary',
    instanceScope: 'living-room',
    dataPath: '/zurg/data',
    readOnly: true,
    now: () => 10_000,
    observationTtlMs: 2_000,
    async lstatFn(filePath) { observedPath = filePath; return stat(); },
    async readFileFn() { return metadata(); },
  });

  const observation = await observer.observeMetadata({
    infoHash: HASH,
    metadataPath: 'Release.zurgtorrent',
  });

  assert.equal(observedPath, '/zurg/data/Release.zurgtorrent');
  assert.equal(observation.provider, 'realdebrid');
  assert.equal(observation.accountScope, 'primary');
  assert.equal(observation.instanceScope, 'living-room');
  assert.equal(observation.source, 'zurg-zurgtorrent-v1');
  assert.equal(observation.infoHash, HASH);
  assert.equal(observation.fileIndex, null);
  assert.equal(observation.observationState, 'present');
  assert.equal(observation.zurgState, 'under_repair_torrent');
  assert.equal(observation.zurgStateWhen, 1234);
  assert.equal(observation.expiresAt, 12_000);
  assert.deepEqual(observation.evidence.files, [{
    zurgFileId: '9',
    recordedFilePath: '/Release/movie.mkv',
    size: 1000,
    selected: true,
    state: 'broken_file',
    rename: 'Movie (2026).mkv',
    savedLinkPresent: true,
  }]);
  assert.equal(Object.hasOwn(observation, 'providerResourceId'), false);
  assert.equal(Object.hasOwn(observation.evidence.files[0], 'fileIndex'), false);
  assert.equal(Object.hasOwn(observation.evidence.files[0], 'corpusFileIndex'), false);
  assert.equal(Object.hasOwn(observation.evidence, 'DownloadedIDs'), false);
  assert.equal(Object.hasOwn(observation.evidence, 'IDsToDelete'), false);
  assert.equal(JSON.stringify(observation).includes('opaque-zurg-key'), false);
  assert.equal(JSON.stringify(observation).includes('secret-link'), false);
  assert.equal(JSON.stringify(observation).includes('temporary-rd-id'), false);
  assert.equal(JSON.stringify(observation).includes('replacement-rd-id'), false);
});

test('missing Zurg metadata remains separate from mount exposure and provider placement', async () => {
  const observer = createZurgTorrentMetadataObserver({
    dataPath: '/zurg/data', readOnly: true,
    lstatFn: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
  });

  const observation = await observer.observeMetadata({
    infoHash: HASH, metadataPath: 'Release.zurgtorrent',
  });

  assert.equal(observation.observationState, 'missing');
  assert.equal(observation.failureCategory, null);
  assert.equal(Object.hasOwn(observation, 'state'), false);
  assert.equal(Object.hasOwn(observation, 'relativePath'), false);
});

test('Zurg metadata observer rejects writable, traversing, absolute, and non-metadata paths', async () => {
  assert.throws(() => createZurgTorrentMetadataObserver({
    dataPath: '/zurg/data', readOnly: false,
  }), /explicitly read-only/);

  const observer = createZurgTorrentMetadataObserver({
    dataPath: '/zurg/data', readOnly: true,
    lstatFn: async () => stat(), readFileFn: async () => metadata(),
  });
  await assert.rejects(
    () => observer.observeMetadata({ infoHash: HASH, metadataPath: '../escape.zurgtorrent' }),
    /cannot traverse parent/,
  );
  await assert.rejects(
    () => observer.observeMetadata({ infoHash: HASH, metadataPath: '/tmp/Release.zurgtorrent' }),
    /must be relative/,
  );
  await assert.rejects(
    () => observer.observeMetadata({ infoHash: HASH, metadataPath: 'Release.json' }),
    /must identify a \.zurgtorrent file/,
  );
});

test('invalid, mismatched, oversized, and symbolic-link metadata fail closed', async (t) => {
  const cases = [
    ['invalid JSON', stat(), '{', 'invalid-response'],
    ['mismatched hash', stat(), metadata({ Hash: '0'.repeat(40) }), 'invalid-response'],
    ['oversized', stat({ size: 1001 }), metadata(), 'invalid-response'],
    ['symbolic link', stat({ symbolicLink: true }), metadata(), 'invalid-response'],
  ];

  for (const [name, fileStat, body, expectedCategory] of cases) {
    await t.test(name, async () => {
      const observer = createZurgTorrentMetadataObserver({
        dataPath: '/zurg/data', readOnly: true, maxMetadataBytes: 1000,
        lstatFn: async () => fileStat, readFileFn: async () => body,
      });
      const observation = await observer.observeMetadata({
        infoHash: HASH, metadataPath: 'Release.zurgtorrent',
      });
      assert.equal(observation.observationState, 'error');
      assert.equal(observation.failureCategory, expectedCategory);
      assert.equal(observation.retryable, false);
      assert.equal(observation.evidence, null);
    });
  }
});

test('Zurg metadata transport errors remain typed unknown evidence', async () => {
  const observer = createZurgTorrentMetadataObserver({
    dataPath: '/zurg/data', readOnly: true,
    lstatFn: async () => { throw Object.assign(new Error('metadata transport unavailable'), { code: 'ECONNRESET' }); },
  });

  const observation = await observer.observeMetadata({
    infoHash: HASH, metadataPath: 'Release.zurgtorrent',
  });

  assert.equal(observation.observationState, 'error');
  assert.equal(observation.failureCategory, 'network');
  assert.equal(observation.retryable, true);
});

test('Zurg metadata observer validates scoped identity and malformed projected fields', async (t) => {
  assert.throws(() => createZurgTorrentMetadataObserver({
    accountScope: 'not valid', dataPath: '/zurg/data', readOnly: true,
  }), /accountScope/);
  assert.throws(() => createZurgTorrentMetadataObserver({
    instanceScope: 'not valid', dataPath: '/zurg/data', readOnly: true,
  }), /instanceScope/);

  for (const [name, selectedFile] of [
    ['invalid selected flag', { File: { id: 9, path: '/movie.mkv', bytes: 1, selected: 2 } }],
    ['invalid saved link', { File: { id: 9, path: '/movie.mkv', bytes: 1, selected: 1 }, Link: 42 }],
  ]) {
    await t.test(name, async () => {
      const observer = createZurgTorrentMetadataObserver({
        dataPath: '/zurg/data', readOnly: true,
        lstatFn: async () => stat(),
        readFileFn: async () => metadata({ SelectedFiles: { one: selectedFile } }),
      });
      const observation = await observer.observeMetadata({
        infoHash: HASH, metadataPath: 'Release.zurgtorrent',
      });
      assert.equal(observation.observationState, 'error');
      assert.equal(observation.failureCategory, 'invalid-response');
    });
  }
});

test('Zurg metadata accepts provider file IDs only as opaque values', async () => {
  const observer = createZurgTorrentMetadataObserver({
    dataPath: '/zurg/data', readOnly: true,
    lstatFn: async () => stat(),
    readFileFn: async () => metadata({
      SelectedFiles: {
        one: { File: { id: 'rd-file:opaque', path: '/movie.mkv', bytes: 1, selected: 1 } },
      },
    }),
  });
  const observation = await observer.observeMetadata({
    infoHash: HASH, metadataPath: 'Release.zurgtorrent',
  });
  assert.equal(observation.evidence.files[0].zurgFileId, 'rd-file:opaque');
});

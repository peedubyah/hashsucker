import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createReleaseIdentity,
  createReleaseKey,
  readHandoffReleaseIdentity,
  toPublicReleaseDto,
  validateReleaseIdentity,
} from '../src/api/release-contract.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';

function publicRelease(identity) {
  return {
    ...identity,
    title: 'Release',
    filename: 'Release.mkv',
    size: null,
    resolution: null,
    quality: null,
    codec: null,
    hdr: null,
    audio: null,
    releaseGroup: null,
    year: null,
    season: null,
    episode: null,
    confidence: 0.5,
    score: 0,
    components: {},
    providers: {},
    media: [],
    _source: 'live',
  };
}

test('release keys preserve null, zero, and different file indexes', () => {
  assert.equal(createReleaseKey(HASH, null), `${HASH}:torrent`);
  assert.equal(createReleaseKey(HASH, 0), `${HASH}:0`);
  assert.equal(createReleaseKey(HASH, 1), `${HASH}:1`);
  assert.notEqual(createReleaseKey(HASH, null), createReleaseKey(HASH, 0));
  assert.notEqual(createReleaseKey(HASH, 0), createReleaseKey(HASH, 1));
});

test('release identity normalizes hash casing without changing fileIndex zero', () => {
  assert.deepEqual(createReleaseIdentity(HASH.toUpperCase(), 0), {
    infoHash: HASH,
    fileIndex: 0,
    releaseKey: `${HASH}:0`,
  });
});

test('exact release validation rejects malformed or inconsistent identities', () => {
  for (const release of [
    { infoHash: HASH, releaseKey: `${HASH}:torrent` },
    { infoHash: HASH, fileIndex: null },
    { infoHash: HASH, fileIndex: -1, releaseKey: `${HASH}:-1` },
    { infoHash: HASH, fileIndex: 1.5, releaseKey: `${HASH}:1.5` },
    { infoHash: HASH, fileIndex: Number.MAX_SAFE_INTEGER + 1, releaseKey: `${HASH}:${Number.MAX_SAFE_INTEGER + 1}` },
    { infoHash: HASH, fileIndex: '0', releaseKey: `${HASH}:0` },
    { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:torrent` },
    { infoHash: 'not-a-hash', fileIndex: null, releaseKey: 'not-a-hash:torrent' },
  ]) {
    assert.throws(() => validateReleaseIdentity(release));
  }
});

test('public DTO contract projects supported fields and exact identity', () => {
  const release = publicRelease(createReleaseIdentity(HASH.toUpperCase(), 0));
  release.raw = { secret: true };
  release.downloadUrl = 'https://secret.invalid';

  const dto = toPublicReleaseDto(release);
  assert.deepEqual(
    { infoHash: dto.infoHash, fileIndex: dto.fileIndex, releaseKey: dto.releaseKey },
    { infoHash: HASH, fileIndex: 0, releaseKey: `${HASH}:0` },
  );
  assert.equal(dto.raw, undefined);
  assert.equal(dto.downloadUrl, undefined);
});

test('protocol-v1 reader accepts legacy hash-only handoffs as torrent identity', () => {
  assert.deepEqual(readHandoffReleaseIdentity({ infoHash: HASH.toUpperCase() }), {
    infoHash: HASH,
    fileIndex: null,
    releaseKey: `${HASH}:torrent`,
  });
  assert.throws(() => readHandoffReleaseIdentity({ infoHash: HASH, fileIndex: 0 }));
});

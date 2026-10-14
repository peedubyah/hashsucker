import test from 'node:test';
import assert from 'node:assert/strict';
import { isAuthoritativePartFile, vfsPartFile } from '../src/lib/plex/vfs-path.js';
import { isPrepared, isPublished, prepareFailure, probeFailure, publishFailure }
  from '../src/lib/requests/prepare-outcome.js';

test('vfsPartFile joins the mount root to the authoritative canonical path', () => {
  assert.equal(vfsPartFile('TV/tt123/Season 01/tt123 - S01E01.mkv'),
    '/mnt/hashsucker-vfs/TV/tt123/Season 01/tt123 - S01E01.mkv');
  // leading slashes must not double up
  assert.equal(vfsPartFile('/TV/tt1/x.mkv'), '/mnt/hashsucker-vfs/TV/tt1/x.mkv');
});

test('vfsPartFile refuses to invent a path', () => {
  for (const bad of [null, undefined, '', '   ', 42, {}]) {
    assert.equal(vfsPartFile(bad), null, `input=${JSON.stringify(bad)}`);
  }
});

test('isAuthoritativePartFile is exact and never guesses an extension', () => {
  assert.equal(isAuthoritativePartFile(
    '/mnt/hashsucker-vfs/TV/tt1/Season 01/tt1 - S01E01.mkv', 'TV/tt1/Season 01/tt1 - S01E01.mkv'), true);
  // the .mp4 guess from the removed fallback must never pass
  assert.equal(isAuthoritativePartFile(
    '/mnt/hashsucker-vfs/TV/tt1/Season 01/tt1 - S01E01.mp4', 'TV/tt1/Season 01/tt1 - S01E01.mkv'), false);
  assert.equal(isAuthoritativePartFile(null, 'TV/tt1/x.mkv'), false);
  assert.equal(isAuthoritativePartFile('/mnt/hashsucker-vfs/TV/tt1/x.mkv', null), false);
});

test('isPrepared requires status 200 AND prepared AND a durable TorrentFile', () => {
  assert.equal(isPrepared({ status: 200, json: { prepared: true, handoff: { torrentFileId: 'tf_1' } } }), true);
  assert.equal(isPrepared({ status: 200, json: { prepared: true, handoff: {} } }), false);
  assert.equal(isPrepared({ status: 200, json: { prepared: false, handoff: { torrentFileId: 'tf_1' } } }), false);
  assert.equal(isPrepared({ status: 500, json: { prepared: true, handoff: { torrentFileId: 'tf_1' } } }), false);
  // HTTP 200 is not preparation
  assert.equal(isPrepared({ status: 200, json: {} }), false);
});

test('isPublished requires status 200 and a durable TorrentFile', () => {
  assert.equal(isPublished({ status: 200, json: { handoff: { torrentFileId: 'tf_1' } } }), true);
  assert.equal(isPublished({ status: 200, json: { prepared: true } }), false);
  assert.equal(isPublished({ status: 503, json: { handoff: { torrentFileId: 'tf_1' } } }), false);
});

test('prepareFailure delegates to the body-first contract', () => {
  const r = { status: 200, json: { prepared: false, selection: { reason: 'no-bindable-candidate' } } };
  assert.deepEqual(prepareFailure(r),
    { error: 'prepare:no-handoff:no-bindable-candidate', reason: 'no-handoff' });
});

test('publish/probe failures keep transport labels but honour a body error', () => {
  assert.deepEqual(publishFailure({ status: 500, json: {} }),
    { error: 'publish-http-500', reason: 'http-status' });
  assert.deepEqual(publishFailure({ status: 200, json: { error: 'nope' } }),
    { error: 'nope', reason: 'server-error' });
  assert.deepEqual(probeFailure({ status: 503, json: {} }),
    { error: 'probe-http-503', reason: 'http-status' });
  assert.deepEqual(probeFailure({ status: 200, json: { error: 'bad gate' } }),
    { error: 'bad gate', reason: 'server-error' });
});

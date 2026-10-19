/**
 * Cinemeta (optional metadata) bound + per-lookup cache tests.
 *
 * The metadata catalog is optional enrichment: it may improve a
 * presentation title, it may never be authority, and it may never be able
 * to hold a request open or re-pay the same failure forever.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CINEMETA_TIMEOUT_MS,
  MetadataHttpError,
  _resetCinemetaCacheForTests,
  getMedia,
  searchCatalog,
} from '../src/lib/metadata/cinemeta.js';

function ok(payload) {
  return { ok: true, status: 200, async json() { return payload; } };
}

test('Cinemeta lookup is bounded and abortable when the catalog never answers', async () => {
  _resetCinemetaCacheForTests();
  let sawSignal = null;
  const fetchImpl = (_url, init) => {
    sawSignal = init?.signal ?? null;
    // Never resolves on its own: only the abort signal can end it.
    return new Promise((_resolve, reject) => {
      sawSignal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  };
  const startedAt = Date.now();
  await assert.rejects(() => getMedia('movie', 'tt0000001', fetchImpl));
  const elapsed = Date.now() - startedAt;
  assert.ok(sawSignal, 'the request must carry an abort signal');
  assert.ok(elapsed < CINEMETA_TIMEOUT_MS + 2000,
    `the call must end at the budget, not hang (took ${elapsed}ms)`);
  _resetCinemetaCacheForTests();
});

test('Cinemeta aborts the underlying request instead of abandoning it', async () => {
  _resetCinemetaCacheForTests();
  let aborted = false;
  const fetchImpl = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true;
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  await assert.rejects(() => getMedia('movie', 'tt0000002', fetchImpl));
  assert.equal(aborted, true, 'the in-flight HTTP work must be cancelled');
  _resetCinemetaCacheForTests();
});

test('Cinemeta does not re-pay a failed lookup during the failure window', async () => {
  _resetCinemetaCacheForTests();
  const previous = process.env.CINEMETA_FAILURE_CACHE_MS;
  process.env.CINEMETA_FAILURE_CACHE_MS = '60000';
  try {
    let calls = 0;
    const failing = async () => { calls += 1; throw new Error('network down'); };
    await assert.rejects(() => getMedia('movie', 'tt0000003', failing));
    await assert.rejects(() => getMedia('movie', 'tt0000003', failing));
    await assert.rejects(() => getMedia('movie', 'tt0000003', failing));
    assert.equal(calls, 1, 'a failing lookup must be paid once, not per request');
    // A DIFFERENT id is unaffected: the cache is scoped per lookup.
    await assert.rejects(() => getMedia('movie', 'tt0000004', failing));
    assert.equal(calls, 2, 'one unavailable id must not silence a different id');
    // A DIFFERENT transport is unaffected: the observation was about the
    // transport that failed.
    await assert.rejects(() => getMedia('movie', 'tt0000003', async () => { calls += 1; throw new Error('network down'); }));
    assert.equal(calls, 3, 'a failure observed on one transport is not replayed on another');
  } finally {
    if (previous === undefined) delete process.env.CINEMETA_FAILURE_CACHE_MS;
    else process.env.CINEMETA_FAILURE_CACHE_MS = previous;
    _resetCinemetaCacheForTests();
  }
});

test('Cinemeta treats "not in the catalog" as an answer, not an outage', async () => {
  _resetCinemetaCacheForTests();
  const notFound = async () => ({
    ok: false, status: 404, async json() { return { error: 'not found' }; },
  });
  await assert.rejects(
    () => getMedia('movie', 'tt0000008', notFound),
    (error) => error instanceof MetadataHttpError && error.status === 404,
  );
  await assert.rejects(
    () => getMedia('movie', 'tt0000008', notFound),
    (error) => error instanceof MetadataHttpError && error.status === 404,
  );
  _resetCinemetaCacheForTests();
});

test('Cinemeta search degrades instead of hanging', async () => {
  _resetCinemetaCacheForTests();
  const failing = async () => { throw new Error('network down'); };
  await assert.rejects(() => searchCatalog('the matrix', failing));
  _resetCinemetaCacheForTests();
});

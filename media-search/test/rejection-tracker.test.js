/**
 * Rejection Tracker Tests
 *
 * Proves:
 * - Every rejected candidate gets a typed reason
 - Duplicates track the surviving candidate
 * - Missing hash candidates are tracked
 * - Pagination rejections include rank context
 * - Rejections are immutable
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { RejectionTracker, RejectionReason, createRejection, describeRejection } from '../src/lib/discovery/rejection-tracker.js';

const HASH_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'cccccccccccccccccccccccccccccccccccccccc';

// =============================================================================
// RejectionTracker Tests
// =============================================================================

test('RejectionTracker: starts empty', () => {
  const tracker = new RejectionTracker();
  assert.equal(tracker.count, 0);
  assert.deepEqual(tracker.getRejections(), []);
});

test('RejectionTracker: recordMissingHash tracks rejection', () => {
  const tracker = new RejectionTracker();
  tracker.recordMissingHash({ infoHash: null, sources: [{ addonId: 'torrentio' }] });

  const rejections = tracker.getRejections();
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].reason, RejectionReason.MISSING_HASH);
  assert.equal(rejections[0].rejected, true);
  assert.equal(rejections[0].context.source, 'torrentio');
});

test('RejectionTracker: recordDuplicate tracks surviving candidate', () => {
  const tracker = new RejectionTracker();
  tracker.recordDuplicate(
    { hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0` },
    `${HASH_A}:0`
  );

  const rejections = tracker.getRejections();
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].reason, RejectionReason.DUPLICATED);
  assert.equal(rejections[0].candidate, HASH_A);
  assert.equal(rejections[0].context.duplicateOf, `${HASH_A}:0`);
});

test('RejectionTracker: recordLowConfidence tracks threshold', () => {
  const tracker = new RejectionTracker();
  tracker.recordLowConfidence(
    { hash: HASH_B, fileIndex: null, releaseKey: `${HASH_B}:torrent` },
    0.3,
    0.5
  );

  const rejections = tracker.getRejections();
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].reason, RejectionReason.LOW_METADATA_CONFIDENCE);
  assert.equal(rejections[0].context.confidence, 0.3);
  assert.equal(rejections[0].context.threshold, 0.5);
});

test('RejectionTracker: recordPaginated tracks rank context', () => {
  const tracker = new RejectionTracker();
  tracker.recordPaginated(
    { hash: HASH_C, fileIndex: 1, releaseKey: `${HASH_C}:1` },
    51,
    0,
    50
  );

  const rejections = tracker.getRejections();
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].reason, RejectionReason.PAGINATED);
  assert.equal(rejections[0].context.rank, 51);
  assert.equal(rejections[0].context.offset, 0);
  assert.equal(rejections[0].context.limit, 50);
});

test('RejectionTracker: record accepts custom rejection', () => {
  const tracker = new RejectionTracker();
  tracker.record(createRejection({
    hash: HASH_A,
    reason: RejectionReason.FILTERED_BY_QUALITY,
    context: { resolution: '360p', minResolution: '720p' },
  }));

  const rejections = tracker.getRejections();
  assert.equal(rejections.length, 1);
  assert.equal(rejections[0].reason, RejectionReason.FILTERED_BY_QUALITY);
  assert.equal(rejections[0].context.resolution, '360p');
});

test('RejectionTracker: getRejections returns immutable copy', () => {
  const tracker = new RejectionTracker();
  tracker.recordMissingHash({ infoHash: null });

  const rejections = tracker.getRejections();
  assert.throws(() => {
    rejections.push({ reason: 'hack' });
  }, /Cannot add property|object is not extensible|read only/);
});

test('RejectionTracker: merge combines trackers', () => {
  const tracker1 = new RejectionTracker();
  tracker1.recordMissingHash({ infoHash: null });

  const tracker2 = new RejectionTracker();
  tracker2.recordDuplicate({ hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0` }, `${HASH_A}:0`);

  tracker1.merge(tracker2);
  assert.equal(tracker1.count, 2);
});

test('RejectionTracker: clear removes all rejections', () => {
  const tracker = new RejectionTracker();
  tracker.recordMissingHash({ infoHash: null });
  tracker.recordDuplicate({ hash: HASH_A, fileIndex: 0, releaseKey: `${HASH_A}:0` }, `${HASH_A}:0`);
  assert.equal(tracker.count, 2);

  tracker.clear();
  assert.equal(tracker.count, 0);
});

// =============================================================================
// createRejection Tests
// =============================================================================

test('createRejection: minimal rejection', () => {
  const rejection = createRejection({
    hash: HASH_A,
    reason: RejectionReason.MISSING_HASH,
  });

  assert.equal(rejection.candidate, HASH_A);
  assert.equal(rejection.rejected, true);
  assert.equal(rejection.reason, RejectionReason.MISSING_HASH);
  assert.equal(rejection.description, describeRejection(RejectionReason.MISSING_HASH));
});

test('createRejection: full rejection with context', () => {
  const rejection = createRejection({
    hash: HASH_B,
    fileIndex: 0,
    releaseKey: `${HASH_B}:0`,
    reason: RejectionReason.DUPLICATED,
    description: 'Custom description',
    context: { duplicateOf: `${HASH_B}:0` },
  });

  assert.equal(rejection.candidate, HASH_B);
  assert.equal(rejection.fileIndex, 0);
  assert.equal(rejection.releaseKey, `${HASH_B}:0`);
  assert.equal(rejection.description, 'Custom description');
  assert.equal(rejection.context.duplicateOf, `${HASH_B}:0`);
});

test('createRejection: unknown reason gets default description', () => {
  const rejection = createRejection({
    hash: HASH_A,
    reason: 'unknown-reason',
  });

  assert.ok(rejection.description.includes('Unknown rejection reason'));
});

// =============================================================================
// describeRejection Tests
// =============================================================================

test('describeRejection: all reasons have descriptions', () => {
  for (const reason of Object.values(RejectionReason)) {
    const desc = describeRejection(reason);
    assert.ok(desc && desc.length > 0, `Description for ${reason} must not be empty`);
    assert.ok(!desc.includes('Unknown'), `Description for ${reason} should not be unknown`);
  }
});

test('describeRejection: MISSING_HASH description', () => {
  const desc = describeRejection(RejectionReason.MISSING_HASH);
  assert.ok(desc.includes('infoHash') || desc.includes('hash'));
});

test('describeRejection: DUPLICATED description', () => {
  const desc = describeRejection(RejectionReason.DUPLICATED);
  assert.ok(desc.toLowerCase().includes('duplicate'));
});

test('describeRejection: PAGINATED description', () => {
  const desc = describeRejection(RejectionReason.PAGINATED);
  assert.ok(desc.toLowerCase().includes('paginat'));
});

// =============================================================================
// Immutability Tests
// =============================================================================

test('createRejection: returned object is frozen', () => {
  const rejection = createRejection({
    hash: HASH_A,
    reason: RejectionReason.MISSING_HASH,
  });

  assert.throws(() => {
    rejection.reason = 'hacked';
  }, /Cannot assign|read only|not extensible/);
});

test('RejectionReason enum is frozen', () => {
  assert.throws(() => {
    RejectionReason.NEW_REASON = 'new';
  }, /Cannot add|read only|not extensible/);
});

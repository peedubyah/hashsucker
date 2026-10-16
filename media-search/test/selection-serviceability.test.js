/**
 * Serviceability-aware selection tests (execution-quality tranche).
 *
 * The representation ranking stays about media quality; this gate only ensures
 * a candidate that BINDS is not accepted when its exact TorrentFile cannot
 * deliver bytes here, so a cached-but-dead representation does not win over an
 * executable one. Omitted probe seam => exact pre-change behavior.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { selectBindableCandidate } from '../src/lib/discovery/selection.js';
import { resolveTvTorrentFile } from '../src/lib/resolver/tv-episode-resolver.js';
import {
  __resetByteHealth,
  getServiceability,
  recordServiceable,
  recordUnserviceable,
} from '../src/lib/vfs/byte-health.js';

const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';

function candidate({ infoHash, rank, torboxState = 'cached', size = 100 }) {
  return {
    infoHash,
    fileIndex: 0,
    filename: `${infoHash.slice(0, 8)}.mkv`,
    rank,
    score: 0.7,
    identity: { eligible: true, tier: 'Verified', confidence: 0.9 },
    availability: { torbox: { state: torboxState } },
    release: { title: 'T' },
    exactFileSize: size,
    selectedFileSize: size,
  };
}

function storeStub() {
  return { listTorrentFilesForRelease: () => [], listProviderRefsForTorrentFile: () => [] };
}

// TorBox binds every candidate; the probe decides serviceability per hash.
function ensureForAll() {
  const calls = [];
  const fn = async ({ infoHash }) => {
    calls.push(infoHash);
    return { torrentFileId: `tf-${infoHash.slice(0, 4)}`, placementId: 'pl', providerFileId: 'pf', size: 100 };
  };
  return { fn, calls };
}

function probeFor(map) {
  const calls = [];
  const fn = async (torrentFileId) => {
    calls.push(torrentFileId);
    const h = torrentFileId.replace('tf-', '');
    return map[h] ?? { serviceable: false, reason: 'unmapped' };
  };
  return { fn, calls };
}

test('top-ranked blocked, second serviceable -> second wins', async () => {
  const { fn: ensure } = ensureForAll();
  const { fn: probe, calls: probes } = probeFor({ '2222': { serviceable: true } });
  const r = await selectBindableCandidate(
    [candidate({ infoHash: H1, rank: 1 }), candidate({ infoHash: H2, rank: 2 })],
    { ensureTorBoxFileIdentityFn: ensure, serviceabilityProbeFn: probe, resolveTvTorrentFileFn: resolveTvTorrentFile, tvCoordinates: null, controlPlaneStore: storeStub() },
  );
  assert.equal(r.selected.infoHash, H2, 'the serviceable candidate wins');
  assert.equal(r.serviceability.state, 'serviceable');
  assert.deepEqual(probes, ['tf-1111', 'tf-2222'], 'one probe per bound candidate, in order');
  assert.ok(r.skipped.some((s) => s.infoHash === H1 && s.reason.startsWith('bound-unserviceable')));
});

test('top-ranked serviceable -> no unnecessary alternate probing', async () => {
  const { fn: ensure, calls: binds } = ensureForAll();
  const { fn: probe, calls: probes } = probeFor({ '1111': { serviceable: true } });
  const r = await selectBindableCandidate(
    [candidate({ infoHash: H1, rank: 1 }), candidate({ infoHash: H2, rank: 2 }), candidate({ infoHash: H3, rank: 3 })],
    { ensureTorBoxFileIdentityFn: ensure, serviceabilityProbeFn: probe, resolveTvTorrentFileFn: resolveTvTorrentFile, tvCoordinates: null, controlPlaneStore: storeStub() },
  );
  assert.equal(r.selected.infoHash, H1);
  assert.deepEqual(probes, ['tf-1111'], 'exactly one probe');
  assert.deepEqual(binds, [H1], 'no provider work for lower candidates');
});

test('all candidates blocked -> precise bounded failure, best-ranked fallback', async () => {
  const { fn: ensure } = ensureForAll();
  const { fn: probe } = probeFor({}); // nothing serviceable
  const r = await selectBindableCandidate(
    [candidate({ infoHash: H1, rank: 1 }), candidate({ infoHash: H2, rank: 2 }), candidate({ infoHash: H3, rank: 3 })],
    {
      ensureTorBoxFileIdentityFn: ensure, serviceabilityProbeFn: probe,
      resolveTvTorrentFileFn: resolveTvTorrentFile, tvCoordinates: null, controlPlaneStore: storeStub(),
      maxServiceabilityAlternates: 2,
    },
  );
  // The best-ranked (first) unserviceable bind is retained so the request still
  // publishes, but the state is explicit.
  assert.equal(r.selected.infoHash, H1, 'best-ranked bind retained as fallback');
  assert.equal(r.serviceability.state, 'blocked');
  assert.equal(r.serviceability.reason, 'unmapped');
});

test('alternate search is bounded (never probes the world)', async () => {
  const { fn: ensure, calls: binds } = ensureForAll();
  const { fn: probe, calls: probes } = probeFor({}); // all blocked
  const many = Array.from({ length: 20 }, (_, i) =>
    candidate({ infoHash: `${String(i + 1).padStart(4, '0')}`.padEnd(40, '0'), rank: i + 1 }));
  const r = await selectBindableCandidate(many, {
    ensureTorBoxFileIdentityFn: ensure, serviceabilityProbeFn: probe,
    resolveTvTorrentFileFn: resolveTvTorrentFile, tvCoordinates: null, controlPlaneStore: storeStub(),
    maxServiceabilityAlternates: 3,
  });
  // First bind (1 probe) + at most 3 alternates inspected -> bounded binds.
  assert.ok(binds.length <= 4, `binds bounded, got ${binds.length}`);
  assert.ok(probes.length <= 4, `probes bounded, got ${probes.length}`);
  assert.equal(r.serviceability.state, 'blocked');
});

test('no probe seam -> exact pre-change behavior (first bind wins, no serviceability)', async () => {
  const { fn: ensure, calls: binds } = ensureForAll();
  const r = await selectBindableCandidate(
    [candidate({ infoHash: H1, rank: 1 }), candidate({ infoHash: H2, rank: 2 })],
    { ensureTorBoxFileIdentityFn: ensure, resolveTvTorrentFileFn: resolveTvTorrentFile, tvCoordinates: null, controlPlaneStore: storeStub() },
  );
  assert.equal(r.selected.infoHash, H1);
  assert.deepEqual(binds, [H1]);
  assert.equal(r.serviceability, null, 'no gate => no serviceability claim');
});

test('provider preference cannot override known serviceability', async () => {
  // Both candidates are TorBox-cached (the historical primary provider). The
  // higher-ranked one is blocked; the lower one is serviceable. Serviceability
  // wins regardless of provider preference.
  const { fn: ensure } = ensureForAll();
  const { fn: probe } = probeFor({ '2222': { serviceable: true } });
  const r = await selectBindableCandidate(
    [candidate({ infoHash: H1, rank: 1 }), candidate({ infoHash: H2, rank: 2 })],
    { ensureTorBoxFileIdentityFn: ensure, serviceabilityProbeFn: probe, resolveTvTorrentFileFn: resolveTvTorrentFile, tvCoordinates: null, controlPlaneStore: storeStub() },
  );
  assert.equal(r.selected.infoHash, H2);
});

test('transient negative runtime health expires and recovers', () => {
  __resetByteHealth();
  recordUnserviceable('tf_x', { reason: 'provider-body-truncated' });
  assert.equal(getServiceability('tf_x').state, 'unserviceable');
  assert.ok(getServiceability('tf_x').retryInMs > 0);
  recordServiceable('tf_x');
  assert.equal(getServiceability('tf_x').state, 'serviceable');
});

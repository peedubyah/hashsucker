import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';

function cache() {
  return createDiscoveryCache({ db: new DatabaseSync(':memory:') });
}

test('evidence aggregates repeated and cross-source observations', () => {
  const c = cache();
  const hash = 'a'.repeat(40);
  const first = c.appendEvidenceObservation({ subjectKind: 'release', infoHash: hash, observer: 'torrentio', sourceClass: 'live', observedAt: 1000 });
  const repeat = c.appendEvidenceObservation({ subjectKind: 'release', infoHash: hash, observer: 'torrentio', sourceClass: 'live', observedAt: 2000 });
  const other = c.appendEvidenceObservation({ subjectKind: 'release', infoHash: hash, observer: 'comet', sourceClass: 'live', observedAt: 3000 });
  assert.equal(first.novelty, 'novel_release');
  assert.equal(repeat.novelty, 'repeat_observation');
  assert.equal(other.novelty, 'repeat_observation');
  assert.equal(c.db.prepare('SELECT COUNT(*) AS n FROM evidence_observations').get().n, 2);
  assert.equal(c.db.prepare('SELECT observation_count FROM evidence_observations WHERE observer = ?').get('torrentio').observation_count, 2);
  c.close();
});

test('claim calibration joins observer/provider independently of correlation id', () => {
  const c = cache();
  const hash = 'b'.repeat(40);
  c.appendEvidenceObservation({ subjectKind: 'availability', infoHash: hash, provider: 'realdebrid', observer: 'torrentio', sourceClass: 'third_party_cache_claim', state: 'cached', observedAt: 1_000 });
  c.appendEvidenceObservation({ subjectKind: 'availability', infoHash: hash, provider: 'realdebrid', observer: 'realdebrid', sourceClass: 'direct_provider', state: 'ready', observedAt: 2_000 });
  const rows = c.listEvidenceClaimCalibration({ from: 0, to: 10_000 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].provider, 'realdebrid');
  assert.equal(rows[0].observer, 'torrentio');
  assert.equal(rows[0].claims, 1);
  assert.equal(rows[0].confirmed, 1);
  c.close();
});

test('query yield stores bounded source latency and counts', () => {
  const c = cache();
  c.recordEvidenceQuery({ queryKey: 'tt-example', sourceClass: 'torrentio', observedAt: 1000, latencyMs: 120, candidateCount: 10, novelReleaseCount: 3, novelAssociationCount: 2, selectedCount: 1 });
  c.recordEvidenceQuery({ queryKey: 'tt-example', sourceClass: 'torrentio', observedAt: 2000, latencyMs: 80, candidateCount: 5, novelReleaseCount: 1 });
  const rows = c.listEvidenceQuerySummary({ from: 0, to: 3000 });
  assert.equal(rows.length, 1);
  assert.deepEqual({ ...rows[0] }, { source_class: 'torrentio', query_count: 2, hashes_observed: 15, novel_releases: 4, novel_associations: 2, selections: 1, average_latency_ms: 100 });
  c.close();
});

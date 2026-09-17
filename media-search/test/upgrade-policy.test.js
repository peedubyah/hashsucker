/**
 * Quality-upgrade policy tests: ladder ordering, unknown handling,
 * same-tier/downgrade rejection, terminal detection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  tierOf,
  isTerminalTier,
  compareUpgrade,
  UPGRADE_FLOOR_FROM_UNKNOWN,
} from '../src/lib/lifecycle/upgrade-policy.js';

test('ladder orders capture < sd < hd < web < bluray < remux', () => {
  const t = (s, r) => tierOf({ sourceType: s, resolution: r }).tier;
  assert.ok(t('CAM', '720p') < t('DVD', '480p'));
  assert.ok(t('DVD', '480p') < t('HDTV', '720p'));
  assert.ok(t('HDTV', '720p') < t('WEBRip', '1080p'));
  assert.ok(t('WEBRip', '1080p') < t('WEB-DL', '1080p'));
  assert.ok(t('WEB-DL', '1080p') < t('BluRay', '1080p'));
  assert.ok(t('BluRay', '1080p') < t('Remux', '2160p'));
  assert.ok(t('WEB-DL', '720p') < t('WEB-DL', '1080p'));
  assert.ok(t('WEB-DL', '1080p') < t('WEB-DL', '2160p'));
});

test('theatrical capture is tier 0 regardless of claimed resolution', () => {
  assert.equal(tierOf({ sourceType: 'CAM', resolution: '1080p' }).tier, 0);
  assert.equal(tierOf({ sourceType: 'TS', resolution: '720p' }).tier, 0);
});

test('unknown source has null tier (resolution alone never implies class)', () => {
  assert.equal(tierOf({ sourceType: null, resolution: '1080p' }).tier, null);
  assert.equal(tierOf({ sourceType: '', resolution: '2160p' }).tier, null);
  assert.equal(tierOf({ sourceType: 'Exotic', resolution: '1080p' }).tier, null);
});

test('HDR never moves the tier (tie-break only)', () => {
  const a = tierOf({ sourceType: 'WEB-DL', resolution: '2160p', hdr: 0 });
  const b = tierOf({ sourceType: 'WEB-DL', resolution: '2160p', hdr: 1 });
  assert.equal(a.tier, b.tier);
});

test('remux 2160p is terminal; web 1080p is not', () => {
  assert.ok(isTerminalTier(tierOf({ sourceType: 'Remux', resolution: '2160p' }).tier));
  assert.ok(!isTerminalTier(tierOf({ sourceType: 'WEB-DL', resolution: '1080p' }).tier));
  assert.ok(!isTerminalTier(null));
});

test('compareUpgrade: strict improvement only', () => {
  const cur = { tier: 32, label: 'web-dl/1080p' };
  assert.ok(compareUpgrade(cur, { tier: 42, label: 'bluray/1080p' }).upgrade);
  assert.equal(compareUpgrade(cur, { tier: 32, label: 'web-dl/1080p' }).upgrade, false);
  assert.equal(compareUpgrade(cur, { tier: 32, label: 'web-dl/1080p' }).reason, 'same-tier');
  const down = compareUpgrade(cur, { tier: 22, label: 'hdtv/720p' });
  assert.equal(down.upgrade, false);
  assert.equal(down.reason, 'downgrade');
});

test('compareUpgrade: unknown candidate never upgrades; unknown current needs floor', () => {
  const cur = { tier: 32, label: 'web-dl/1080p' };
  assert.equal(compareUpgrade(cur, { tier: null, label: 'unknown' }).upgrade, false);
  assert.equal(compareUpgrade(cur, { tier: null, label: 'unknown' }).reason, 'candidate-tier-unknown');
  const unk = { tier: null, label: 'unknown' };
  assert.ok(compareUpgrade(unk, { tier: 42, label: 'bluray/1080p' }).upgrade);
  const low = compareUpgrade(unk, { tier: UPGRADE_FLOOR_FROM_UNKNOWN - 1, label: 'x' });
  assert.equal(low.upgrade, false);
  assert.equal(low.reason, 'below-upgrade-floor');
});

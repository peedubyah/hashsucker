import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANARY_FAILURE_CLASSES,
  classify,
  ensureMpvConfig,
  fail,
  findSeekRead,
  freshFor,
  redactSecrets,
  stageKey,
} from '../src/scripts/dev-canary.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('findSeekRead requires a read genuinely distant from the start of the file', () => {
  const rows = [
    { request: { start: 0, end: 67108863 }, cache_hit: false },          // offset-0 probe
    { request: { start: 67108864, end: 134217727 }, cache_hit: false },
  ];
  const [match] = findSeekRead(rows, { targetMs: 900000, durationMs: 2736441, mediaSize: 8746838996 });
  assert.equal(match, null, 'index/probe reads must not count as seek evidence');
});

test('findSeekRead accepts a read within the read-ahead tolerance of the target', () => {
  // 36 s of media past the requested target: the delivery path reads ahead.
  const target = 2556441;
  const size = 8746838996; const dur = 2736441;
  const start = Math.floor((size * (target + 36000)) / dur);
  const rows = [{ request: { start, end: start + 67108863 }, cache_hit: false }];
  const [match] = findSeekRead(rows, { targetMs: target, durationMs: dur, mediaSize: size });
  assert.ok(match, 'a read-ahead read inside tolerance is valid seek evidence');
  assert.equal(match.cache_hit, false);
  assert.equal(match.strictWindow, false, 'read-ahead is expected to miss the strict window');
});

test('findSeekRead prefers a real miss over a cache hit', () => {
  const size = 8746838996; const dur = 2736441;
  const at = (ms) => Math.floor((size * ms) / dur);
  const rows = [
    { request: { start: at(300000), end: at(300000) + 67108863 }, cache_hit: true },
    { request: { start: at(300100), end: at(300100) + 67108863 }, cache_hit: false },
  ];
  const [match, cache] = findSeekRead(rows, { targetMs: 300000, durationMs: dur, mediaSize: size });
  assert.equal(match.cache_hit, false);
  assert.ok(cache, 'the cache-hit candidate is still reported for classification');
});

test('findSeekRead tolerates unknown media geometry by returning nothing', () => {
  const [match, cache] = findSeekRead([{ request: { start: 12, end: 99 } }], { targetMs: 1, durationMs: 0, mediaSize: 0 });
  assert.equal(match, null);
  assert.equal(cache, null);
});

test('stageKey/freshFor isolate one run from another', () => {
  const a = { corr_id: 'c1', request: { start: 1, end: 2 }, T0_received_ms: 0, tf_id: 'tf_x' };
  const b = { corr_id: 'c2', request: { start: 3, end: 4 }, T0_received_ms: 0, tf_id: 'tf_x' };
  const foreign = { corr_id: 'c3', request: { start: 5, end: 6 }, tf_id: 'tf_other' };
  const before = new Set([stageKey(a)]);
  const rows = freshFor([a, b, foreign], before, 'tf_x');
  assert.deepEqual(rows.map((x) => x.corr_id), ['c2']);
});

test('a read with no request payload never counts as evidence', () => {
  assert.deepEqual(freshFor([{ tf_id: 'tf_x' }, { tf_id: 'tf_x', request: null }], new Set(), 'tf_x'), []);
});

test('redactSecrets strips Plex tokens from strings and nested evidence', () => {
  const secret = 'SECRETtokenvalue';
  const sample = {
    reason: `Http request failed: https://h.plex.direct:32400/library/metadata/514?X-Plex-Token=${secret}&x=1`,
    nested: ['/', { playerPath: `/library/parts/1057/file.mkv?X-Plex-Token=${secret}` }],
    ok: 7,
  };
  const redacted = redactSecrets(sample);
  assert.ok(!JSON.stringify(redacted).includes(secret), 'the token must not survive redaction');
  assert.match(redacted.reason, /X-Plex-Token=<redacted>/);
  assert.equal(redacted.ok, 7);
});

test('failure classification maps typed codes to stable classes', () => {
  const direct = {
    PMS_SESSION_NOT_CREATED: 'PMS_SESSION_NOT_CREATED',
    PLEX_IDENTITY_MISMATCH: 'PLEX_IDENTITY_MISMATCH',
    MPV_IDENTITY_MISMATCH: 'MPV_IDENTITY_MISMATCH',
    PLAYBACK_START_TIMEOUT: 'PLAYBACK_START_TIMEOUT',
    NO_POST_SESSION_READ: 'NO_POST_SESSION_READ',
    NO_PROGRESSION: 'NO_PROGRESSION',
    SEEK_FORWARD_FAILED: 'SEEK_FORWARD',
    SEEK_BACKWARD_FAILED: 'SEEK_BACKWARD',
    SEEK_NEAR_EOF_FAILED: 'SEEK_NEAR_EOF',
    BYTE_CORRELATION_FAILURE: 'BYTE_CORRELATION',
    APP_STOP_FAILED: 'CLEAN_STOP',
    PMS_TEARDOWN_FAILED: 'PMS_TEARDOWN_FAILED',
  };
  for (const [code, expected] of Object.entries(direct)) {
    assert.equal(classify(fail(code, 'x')), expected);
  }
  assert.equal(classify(fail('SOMETHING_NEW', 'x')), 'UNKNOWN_WITH_SNAPSHOT');
  for (const cls of CANARY_FAILURE_CLASSES) assert.ok(typeof cls === 'string');
});

test('ensureMpvConfig is idempotent and preserves unrelated mpv tuning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-mpvconf-'));
  try {
    writeFileSync(join(dir, 'mpv.conf'), '# user tuning kept across rewrites\nhwdec=vaapi\n');
    ensureMpvConfig({ userDataDir: dir, socketPath: '/tmp/test-ipc.sock' });
    const first = readFileSync(join(dir, 'mpv.conf'), 'utf8');
    ensureMpvConfig({ userDataDir: dir, socketPath: '/tmp/test-ipc.sock' });
    const second = readFileSync(join(dir, 'mpv.conf'), 'utf8');
    assert.equal(first, second, 'rewriting must not accumulate configuration');
    assert.match(first, /^input-ipc-server=\/tmp\/test-ipc\.sock$/m);
    assert.match(first, /^hwdec=vaapi$/m);
    assert.match(first, /^# HashSucker canary:/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureMpvConfig creates the Plex user-data directory when absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hs-mpvconf2-'));
  const nested = join(dir, 'plex');
  try {
    ensureMpvConfig({ userDataDir: nested });
    assert.match(readFileSync(join(nested, 'mpv.conf'), 'utf8'), /^input-ipc-server=/m);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

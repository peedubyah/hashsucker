/**
 * The audio grammar: the scene forms with a channel suffix.
 *
 * "AAC5.1", "DD+5.1" and "DTS-X" all failed the word boundary before, so
 * "AAC5.1" produced NO audio at all and "DDP5.1" produced "DDP5" — a codec
 * with a channel count glued to it. The channel count is not the codec: the
 * quality tiers reason about the codec, so the suffix is read and dropped.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseMetadata } from '../src/lib/stremio/normalize.js';
import { audioQualityBonus } from '../src/lib/discovery/ranking.js';

const file = (tail) => `Some.Movie.2026.2160p.BluRay.x265.${tail}-GROUP.mkv`;

test('A1 — the scene forms with a channel suffix parse to their codec', () => {
  assert.equal(parseMetadata(file('AAC5.1')).audio, 'AAC');
  assert.equal(parseMetadata(file('DD+5.1')).audio, 'DD+');
  assert.equal(parseMetadata(file('DDP5.1')).audio, 'DD+');
  assert.equal(parseMetadata(file('DTS-X')).audio, 'DTS-X');
  assert.equal(parseMetadata(file('AAC2.0')).audio, 'AAC');
});

test('A2 — the forms that already parsed are unchanged', () => {
  assert.equal(parseMetadata(file('AAC')).audio, 'AAC');
  assert.equal(parseMetadata(file('AC3')).audio, 'AC3');
  assert.equal(parseMetadata(file('EAC3')).audio, 'EAC3');
  assert.equal(parseMetadata(file('DTS')).audio, 'DTS');
  assert.equal(parseMetadata(file('DTS-HD.MA')).audio, 'DTS-HD');
  assert.equal(parseMetadata(file('TrueHD.Atmos')).audio, 'TrueHD Atmos');
  assert.equal(parseMetadata(file('FLAC')).audio, 'FLAC');
  assert.equal(parseMetadata(file('Opus')).audio, 'Opus');
});

test('A3 — the parsed value lands in the quality tiers the ranking knows', () => {
  // AAC5.1 used to parse to nothing, so such a candidate carried no audio
  // signal at all. It now carries a codec; whether that codec earns a bonus
  // is a ranking-policy question and is deliberately untouched here (plain
  // AAC is not in the bonus table today).
  assert.equal(parseMetadata(file('AAC5.1')).audio, 'AAC');
  assert.ok(audioQualityBonus(parseMetadata(file('DD+5.1')).audio) > 0);
  assert.ok(audioQualityBonus(parseMetadata(file('DTS-X')).audio) > 0);
  // TrueHD Atmos stays the top tier; the suffix handling must not demote it.
  assert.equal(
    audioQualityBonus(parseMetadata(file('TrueHD.Atmos')).audio),
    audioQualityBonus('TrueHD Atmos'),
  );
});

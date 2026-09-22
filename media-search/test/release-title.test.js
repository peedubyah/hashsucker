import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalReleaseTitle } from '../src/lib/discovery/release-title.js';

test('strips deterministic season pack and quality grammar', () => {
  assert.equal(canonicalReleaseTitle('Breaking.Bad.S01.1080p.WEB-DL.x265-GROUP.mkv'), 'Breaking Bad');
  assert.equal(canonicalReleaseTitle('Game.of.Thrones.S01.MULTi.2160p.BluRay.HEVC.mkv'), 'Game of Thrones');
  assert.equal(canonicalReleaseTitle('Chernobyl.S01.COMPLETE.2160p.HDR.mkv'), 'Chernobyl');
});

test('preserves regional identity tokens', () => {
  assert.equal(canonicalReleaseTitle('The.Office.US.S01-S09.Complete.1080p.mkv'), 'The Office US');
  assert.equal(canonicalReleaseTitle('The.Office.UK.S01.Complete.1080p.mkv'), 'The Office UK');
  assert.equal(canonicalReleaseTitle('The.Office.Australia.S01.1080p.mkv'), 'The Office Australia');
});

test('does not remove arbitrary identity words', () => {
  assert.equal(canonicalReleaseTitle('Complete.Show.2024.1080p.mkv'), 'Complete Show');
  assert.equal(canonicalReleaseTitle('Series.2024.1080p.mkv'), 'Series');
});

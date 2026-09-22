import assert from 'node:assert/strict';
import test from 'node:test';
import { agreeShowIdentity, normalizeShowTitle } from '../src/lib/discovery/show-identity.js';

test('normalizes conservative title punctuation', () => {
  assert.equal(normalizeShowTitle("The Office: US"), 'the office us');
  assert.equal(normalizeShowTitle('Rock & Roll'), 'rock and roll');
});

test('clear shows and known episode titles agree', () => {
  assert.equal(agreeShowIdentity({ canonicalTitle: 'Breaking Bad', release: { filename: 'Breaking Bad Ozymandias S05E14.mkv' } }).matched, false);
  assert.equal(agreeShowIdentity({ canonicalTitle: 'Breaking Bad', release: { filename: 'Breaking Bad.mkv' } }).matched, true);
  assert.equal(agreeShowIdentity({ canonicalTitle: 'Breaking Bad', episodeTitles: ['Ozymandias'], release: { filename: 'Breaking Bad Ozymandias S05E14.mkv' } }).matched, true);
});

test('ambiguous suffix titles refuse identity', () => {
  for (const filename of ['Fast Friends S01E01.mkv', 'Fantastic Friends S01E01.mkv', 'Your Friends and Neighbors S01E01.mkv', 'Lost in Space S01E01.mkv', 'House of the Dragon S01E01.mkv']) {
    assert.equal(agreeShowIdentity({ canonicalTitle: filename.split(' ')[0], release: { filename } }).matched, false);
  }
});

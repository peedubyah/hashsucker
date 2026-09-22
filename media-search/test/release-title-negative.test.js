import assert from 'node:assert/strict';
import test from 'node:test';
import { agreeShowIdentity } from '../src/lib/discovery/show-identity.js';

const hardNegativeBases = [
  ['Friends', 'Fast Friends'], ['Friends', 'Fantastic Friends'], ['Friends', 'Your Friends and Neighbors'],
  ['Lost', 'Lost in Space'], ['House', 'House of the Dragon'], ['House', 'Full House'],
  ['Dark', 'Dark Matter'], ['From', 'From Dusk Till Dawn'], ['You', 'You Me and Her'],
  ['The Office', 'The Office UK'], ['The Office', 'The Office Australia'], ['The Office US', 'The Office UK'],
  ['Breaking Bad', 'Breaking Badger'], ['Better Call Saul', 'Better Call Molly'],
  ['Game of Thrones', 'Game of Shadows'], ['The Sopranos', 'Soprano'],
  ['The Last of Us', 'Last of the Mohicans'], ['Chernobyl', 'Chernobyl Diaries'],
  ['Fleabag', 'Flea Bag'], ['True Detective', 'True Detective Stories'],
  ['Ted Lasso', 'Lasso'], ['The Bear', 'Bear Grylls'], ['Mr. Robot', 'Robot'],
  ['Peaky Blinders', 'Peaky Blindness'], ['The X-Files', 'X-Men'],
];
const suffixes = ['S01E01.mkv', 'S02E03.1080p.WEB-DL.mkv', 'S01.COMPLETE.2160p.BluRay.mkv', 'S03-S04.COMPLETE.mkv'];
const negatives = hardNegativeBases.flatMap(([requested, wrong]) => suffixes.map((suffix) => ({ requested, filename: `${wrong}.${suffix}` })));

test('100 deterministic hard negatives remain rejected', () => {
  assert.equal(negatives.length, 100);
  const accepted = negatives.filter(({ requested, filename }) => agreeShowIdentity({ canonicalTitle: requested, release: { filename } }).matched);
  assert.deepEqual(accepted, []);
});

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

test('expanded truth set has 30 positive and 30 negative cases', () => {
  const positives = [
    ['Breaking Bad', 'Breaking.Bad.S05E14.1080p.mkv'], ['Better Call Saul', 'Better.Call.Saul.S06E13.mkv'],
    ['Game of Thrones', 'Game.of.Thrones.S08E06.mkv'], ['The Sopranos', 'The.Sopranos.S06E21.mkv'],
    ['The Last of Us', 'The.Last.of.Us.S01E03.mkv'], ['When They See Us', 'When.They.See.Us.S01E04.mkv'],
    ['Chernobyl', 'Chernobyl.S01E05.mkv'], ['Fleabag', 'Fleabag.S02E06.mkv'],
    ['True Detective', 'True.Detective.S04E06.mkv'], ['Ted Lasso', 'Ted.Lasso.S03E12.mkv'],
    ['The Office', 'The.Office.S09E23.mkv'], ['The Office US', 'The.Office.US.S02E01.mkv'],
    ['Friends', 'Friends.S10E18.mkv'], ['Lost', 'Lost.S06E18.mkv'], ['House', 'House.S08E22.mkv'],
    ['Dark', 'Dark.S03E08.mkv'], ['From', 'From.S02E10.mkv'], ['You', 'You.S04E10.mkv'],
    ['Mini Series', 'Mini-Series.S01E02.mkv'], ['Band of Brothers', 'Band.of.Brothers.S01E10.mkv'],
    ['The Bear', 'The.Bear.S02E10.mkv'], ['Mr. Robot', 'Mr.Robot.S04E13.mkv'],
    ['Peaky Blinders', 'Peaky.Blinders.S06E06.mkv'], ['The X-Files', 'The.X-Files.S01E01.mkv'],
    ['It\'s Always Sunny in Philadelphia', 'Its.Always.Sunny.in.Philadelphia.S16E08.mkv'],
    ['The Good Place', 'The.Good.Place.S04E13.mkv'], ['The Queen\'s Gambit', 'The.Queens.Gambit.S01E07.mkv'],
    ['La Casa de Papel', 'La.Casa.de.Papel.S05E10.mkv'], ['Dark', 'Dark.S03E08.2019.mkv'],
    ['The Office', 'The Office (2005) S01E01.mkv'],
  ];
  const negatives = [
    ['Friends', 'Fast.Friends.S01E01.mkv'], ['Friends', 'Fantastic.Friends.S01E01.mkv'],
    ['Friends', 'Your.Friends.and.Neighbors.S01E01.mkv'], ['Lost', 'Lost.in.Space.S01E01.mkv'],
    ['House', 'House.of.the.Dragon.S01E01.mkv'], ['House', 'Full.House.S01E01.mkv'],
    ['Dark', 'Dark.Matter.S01E01.mkv'], ['From', 'From.Dusk.Till.Dawn.S01E01.mkv'],
    ['You', 'You.Me.and.Everyone.S01E01.mkv'], ['The Office', 'The.Office.UK.S01E01.mkv'],
    ['The Office', 'The.Office.Australia.S01E01.mkv'], ['The Office', 'Office.Space.1999.mkv'],
    ['Breaking Bad', 'Breaking.Badger.S01E01.mkv'], ['Better Call Saul', 'Better.Call.Molly.S01E01.mkv'],
    ['Game of Thrones', 'Game.of.Shadows.S01E01.mkv'], ['The Sopranos', 'Soprano.S01E01.mkv'],
    ['The Last of Us', 'Last.of.the.Mohicans.1992.mkv'], ['Chernobyl', 'Chernobyl Diaries 2012.mkv'],
    ['Fleabag', 'Flea.Bag.2019.mkv'], ['True Detective', 'True.Detective.Stories.S01E01.mkv'],
    ['Ted Lasso', 'Lasso.S01E01.mkv'], ['The Bear', 'Bear Grylls S01E01.mkv'],
    ['Mr. Robot', 'Robot.2013.mkv'], ['Peaky Blinders', 'Peaky.Blindness.S01E01.mkv'],
    ['The X-Files', 'X-Men.S01E01.mkv'], ['The Good Place', 'Good.Place.2020.mkv'],
    ['The Queen\'s Gambit', 'Queens.S01E01.mkv'], ['La Casa de Papel', 'Casa de Papel 2020.mkv'],
    ['Mini Series', 'Miniature.Series.S01E01.mkv'], ['Band of Brothers', 'Brothers.S01E01.mkv'],
  ];
  assert.equal(positives.length, 30);
  assert.equal(negatives.length, 30);
  for (const [canonicalTitle, filename] of positives) {
    assert.equal(agreeShowIdentity({ canonicalTitle, release: { filename } }).matched, true, `${canonicalTitle}: ${filename}`);
  }
  for (const [canonicalTitle, filename] of negatives) {
    assert.equal(agreeShowIdentity({ canonicalTitle, release: { filename } }).matched, false, `${canonicalTitle}: ${filename}`);
  }
});

test('provider-neutral aliases and year fail safely', () => {
  assert.equal(agreeShowIdentity({ canonicalTitle: 'Money Heist', alternateTitles: ['La Casa de Papel'], firstAirYear: 2017, release: { filename: 'La.Casa.de.Papel.S01E01.mkv' } }).matched, true);
  assert.equal(agreeShowIdentity({ canonicalTitle: 'The Office', firstAirYear: 2005, release: { filename: 'The.Office.2025.COMPLETE.mkv' } }).matched, false);
  assert.equal(agreeShowIdentity({ canonicalTitle: 'The Office', alternateTitles: ['The Office US'], release: { filename: 'The.Office.US.S01E01.mkv' } }).matched, true);
});

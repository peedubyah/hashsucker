import assert from 'node:assert/strict';
import test from 'node:test';

function exactEpisodeCount(rows, season, episode) {
  return rows.filter((row) => row.eligible !== false && row.release?.season === season && row.release?.episode === episode).length;
}

test('Bloodhound trigger treats generic season packs as insufficient for exact TV episode', () => {
  const rows = [{ eligible: true, release: { season: null, episode: null } }];
  assert.equal(exactEpisodeCount(rows, 1, 8), 0);
});

test('Bloodhound trigger stays suppressed when exact persisted episode exists', () => {
  const rows = [{ eligible: true, release: { season: 1, episode: 8 } }];
  assert.equal(exactEpisodeCount(rows, 1, 8), 1);
});

test('exact release identity deduplicates by infoHash and file index', () => {
  const seen = new Set();
  const rows = [
    { infoHash: 'abc', fileIndex: null },
    { infoHash: 'abc', fileIndex: null },
    { infoHash: 'abc', fileIndex: 2 },
  ];
  const unique = rows.filter((row) => {
    const key = `${row.infoHash}:${row.fileIndex ?? 'torrent'}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  assert.equal(unique.length, 2);
});

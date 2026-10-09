import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createFutureIntentStore } from '../src/lib/anticipation/future-intents.js';

test('Seerr season backfill derives ownership from parent and child provenance idempotently', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE media_intents (
    id INTEGER PRIMARY KEY, media_id TEXT, media_type TEXT, season INTEGER,
    episode INTEGER, source TEXT, source_id TEXT, tmdb_id TEXT
  )`);
  db.prepare('INSERT INTO media_intents VALUES (1, ?, ?, NULL, NULL, ?, ?, ?)').run('tt-backfill', 'series', 'seerr', 'req-9', '123');
  db.prepare('INSERT INTO media_intents VALUES (2, ?, ?, 1, 1, ?, ?, ?)').run('tt-backfill', 'tv', 'seerr', 'req-9:s1:e1', '123');
  db.prepare('INSERT INTO media_intents VALUES (3, ?, ?, 1, 2, ?, ?, ?)').run('tt-backfill', 'tv', 'seerr', 'req-9:s1:e2', '123');
  db.prepare('INSERT INTO media_intents VALUES (4, ?, ?, 1, 99, ?, ?, ?)').run('tt-backfill', 'tv', 'api', 'unrelated:s1:e99', '123');
  const store = createFutureIntentStore({ db, clock: () => 1_000_000 });
  const first = store.backfillRequestedSeasonsFromSeerr({ mediaIntentDb: db });
  assert.equal(first.seasons, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requested_seasons').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM future_intents WHERE media_id = ? AND season = 1').get('tt-backfill').n, 2);
  const second = store.backfillRequestedSeasonsFromSeerr({ mediaIntentDb: db });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM requested_seasons').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM future_intents WHERE media_id = ? AND season = 1').get('tt-backfill').n, 2);
  assert.equal(second.seasons, 1);
});

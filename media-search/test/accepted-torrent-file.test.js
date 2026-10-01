import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';

test('accepted TorrentFile fact is exact, idempotent, and deterministic', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem({ mediaType: 'movie', mediaId: 'tt_accept', title: 'Accepted', desiredState: 'present' });
  const hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  store.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at) VALUES (?, ?, ?, ?, ?)`).run('tf-a', hash, 'Accepted.mkv', 10, 1);
  const first = store.recordAcceptedTorrentFile({ libraryItemId: item.id, torrentFileId: 'tf-a', source: 'test', reason: 'playback', observedAt: 10 });
  const second = store.recordAcceptedTorrentFile({ libraryItemId: item.id, torrentFileId: 'tf-a', source: 'test', reason: 'playback-seek-stop', observedAt: 20 });
  assert.equal(first.torrentFileId, 'tf-a');
  assert.equal(second.torrentFileId, 'tf-a');
  assert.equal(store.listAcceptedTorrentFiles(item.id).length, 1);
  assert.equal(store.getAcceptedTorrentFile(item.id).torrentFileId, 'tf-a');
  store.close();
});

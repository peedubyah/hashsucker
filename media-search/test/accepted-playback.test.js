import assert from 'node:assert/strict';
import test from 'node:test';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { recordAcceptedPlayback } from '../src/lib/consumers/accepted-playback.js';

test('accepted playback requires exact published Part path and active Binding TF', () => {
  const store = createControlPlaneStore();
  const item = store.ensureLibraryItem({ mediaType: 'episode', mediaId: 'tt_play', title: 'Play', season: 1, episode: 1, desiredState: 'present' });
  store.ensureCanonicalPath(item.id, { canonicalPath: 'TV/Play/Season 01/Play - S01E01.mkv' });
  const hash = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  store.db.prepare(`INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at) VALUES (?, ?, ?, ?, ?)`).run('tf-play', hash, 'Play.mkv', 10, 1);
  const session = { mediaId: 'tt_play', mediaType: 'episode', season: 1, episode: 1, progress: 0.1, viewOffset: 100, partFile: '/mnt/hashsucker-vfs/TV/Play/Season 01/Play - S01E01.mkv', partId: 1 };
  assert.equal(recordAcceptedPlayback({ controlPlaneStore: store, session }), null);
  store.close();
});

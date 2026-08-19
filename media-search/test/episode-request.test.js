import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { QueueImporterClient } from '../src/lib/importer/queue-client.js';
import { createHandoff } from '../src/lib/requests/handoff.js';
import { createRequestIntent } from '../src/lib/requests/intent.js';

const HASH = '0123456789abcdef0123456789abcdef01234567';

test('episode intent stays S07E03 for both episode and whole-season releases', () => {
  const intent = createRequestIntent({ type: 'series', mediaId: 'tt2085059:7:3' });
  const episode = createHandoff({ intent, release: { infoHash: HASH, title: 'Black.Mirror.S07E03.2160p' } });
  const season = createHandoff({ intent, release: { infoHash: HASH, title: 'Black.Mirror.S07.Complete.E01-E06.61GB' } });

  for (const handoff of [episode, season]) {
    assert.equal(handoff.intent.mediaType, 'tv');
    assert.equal(handoff.intent.scope, 'episode');
    assert.equal(handoff.intent.season, 7);
    assert.deepEqual(handoff.intent.episodes, [3]);
  }
});

test('movie handoff preserves explicit movie scope and selected hash', () => {
  const intent = createRequestIntent({ type: 'movie', mediaId: 'tt0082971' });
  const handoff = createHandoff({ intent, release: { infoHash: HASH, title: 'Raiders of the Lost Ark (1981)' } });
  assert.deepEqual(handoff.intent, {
    mediaType: 'movie', streamType: 'movie', scope: 'movie', mediaId: 'tt0082971', baseMediaId: 'tt0082971', season: null, episodes: [],
  });
  assert.equal(handoff.release.infoHash, HASH);
});

test('queue importer uses incoming and maps all lifecycle directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'media-search-queue-'));
  const client = new QueueImporterClient({ root });
  const handoff = createHandoff({
    intent: createRequestIntent({ type: 'series', mediaId: 'tt2085059:7:3' }),
    release: { infoHash: HASH, title: 'Season pack' },
  });
  await client.submitRequest(handoff);
  assert.equal((await client.getRequestStatus(handoff.requestId)).status, 'queued');

  for (const [directory, expected] of [['processing','processing'], ['done','done'], ['failed','failed']]) {
    for (const name of ['incoming','processing','done','failed']) {
      await fs.rm(path.join(root, name, `${handoff.requestId}.json`), { force: true });
    }
    await fs.writeFile(path.join(root, directory, `${handoff.requestId}.json`), JSON.stringify(handoff));
    assert.equal((await client.getRequestStatus(handoff.requestId)).status, expected);
  }
});

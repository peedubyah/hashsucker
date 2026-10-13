/**
 * Collection mtime stability in the TV VFS WebDAV surface.
 *
 * Regression guard for the PMS scanner-pressure defect: a directory collection
 * advertised `modifiedAt = now()`, so Plex saw every directory as perpetually
 * newer than its last refresh and scanned continuously. That scanner holds the
 * PMS SQLite write lock, which is the proven cause of `/playQueues` 500
 * FailedToCreateSession during playback starts.
 *
 * Collections must derive their mtime from durable publication state, exactly
 * as files already do and as movie-webdav already did.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/lib/vfs/tv-webdav.js', import.meta.url), 'utf8');

test('the TV PROPFIND path no longer advertises wall-clock time for collections', () => {
  const match = SRC.match(/if \(request\.method === 'PROPFIND'\) \{[\s\S]*?\n {4}\}/);
  assert.ok(match, 'the TV PROPFIND handler should exist');
  const block = match[0];
  assert.ok(
    !/modifiedAt:\s*now\(\)/.test(block),
    'a collection must not advertise modifiedAt = now(); that made directories look perpetually fresh to Plex',
  );
});

test('collection mtime is derived from durable handoff selectedAt', () => {
  assert.match(
    SRC,
    /const collectionModifiedAt = Math\.max\(\s*0,\s*\.\.\..*?selectedAt/s,
    'collection mtime should be the newest durable selectedAt in the TV tree',
  );
  assert.match(SRC, /modifiedAt: collectionModifiedAt/);
  // The per-entry callback must still use durable metadata for files.
  assert.match(SRC, /:\s*getDurableMetadata\(entry\.state\)/);
});

test('files keep durable metadata and do not regress to synthesized times', () => {
  // metadataFromState is the file path: it must still read handoff.selectedAt.
  assert.match(SRC, /modifiedAt: state\.handoff\.selectedAt/);
  // no other now()-based last-modified in a listing response
  assert.ok(
    !/<d:getlastmodified>' \+ escapeXml\(httpDate\(now\(\)\)\)/.test(SRC),
    'no listing response should synthesize last-modified from now()',
  );
});

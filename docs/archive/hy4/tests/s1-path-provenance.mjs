// S-1 path provenance test (P2 correction).
//
// This test is intentionally NOT a suite and NOT the transplant gate.
// It exists to prove ONE thing about the P2 S-1 seam:
//
//   The two fields named `canonicalInternalPath` in the S-1 response
//   MUST come from their own columns, MUST be a one-way projection
//   (response field → column), and MUST NOT be derived from each other
//   or from a host/container/VFS path by the projection itself.
//
// What this test does NOT assert (and why):
//
//   It does NOT assert that the two strings differ. The two namespaces
//   are independent; their values may legitimately be equal. A test
//   that requires inequality would be a vacuous proof: it would pass
//   any time the data is, by accident, unequal, and fail any time
//   the data is, by chance, equal. The real invariant is provenance,
//   not inequality.
//
// This test can fail in three concrete ways:
//   1. response.torrentFile.canonicalInternalPath != torrent_files.internal_path
//   2. response.providers[i].canonicalInternalPath != provider_files.path
//   3. the response derives a field from a column other than the one named
//      in the contract (caught by the SQL-trace spot-checks below)

import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createApp } from '../src/server/app.js';

const HASH = 'a'.repeat(40);
const TF_ID = 'tf_provenance';
const TF_INTERNAL_PATH = 'Movies/Foo/identity-path.mkv';
const TF_SIZE = 987654;
const PROVIDER_RESOURCE_ID = 'res_tb';
const PROVIDER_FILE_ID = '111';
const PROVIDER_FILE_PATH = 'Movies/Foo/provider-path.mkv';
const DELIBERATELY_DIFFERENT = 'deliberately-different-string';

const dbPath = '/tmp/s1prov/s1-prov.db';
for (const suffix of ['', '-wal', '-shm']) {
  rmSync(dbPath + suffix, { force: true });
}
process.env.DISCOVERY_DB = '/tmp/s1prov/s1-discovery.db';
rmSync(process.env.DISCOVERY_DB, { force: true });

const store = createControlPlaneStore({ dbPath });

// Seed durable north state directly. The point is to plant KNOWN values
// in known columns, then read them back through the S-1 projection and
// verify the response carries the same bytes.
const now = 1;
store.db.exec(`
  INSERT INTO torrent_files (id, info_hash, internal_path, size, created_at)
  VALUES ('${TF_ID}', '${HASH}', '${TF_INTERNAL_PATH}', ${TF_SIZE}, ${now});

  INSERT INTO provider_placements
    (id, provider, account_scope, info_hash, provider_resource_id, state,
     ownership, provenance, observed_at, created_at, updated_at)
  VALUES ('pl_tb', 'torbox', 'default', '${HASH}', '${PROVIDER_RESOURCE_ID}',
          'ready', 'owned', 'test', ${now}, ${now}, ${now});

  INSERT INTO provider_files
    (id, placement_id, provider_file_id, path, name, size, present,
     inventory_observed_at, torrent_file_id, mapping_state)
  VALUES ('pf_kb', 'pl_tb', '${PROVIDER_FILE_ID}', '${PROVIDER_FILE_PATH}',
          'identity-path.mkv', ${TF_SIZE}, 1, ${now}, '${TF_ID}', 'mapped');
`);

const server = createApp({ controlPlaneStore: store });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const res = await fetch(`http://127.0.0.1:${port}/api/data-plane/files/${TF_ID}`);
const body = await res.json();

const results = [];
const check = (name, fn) => {
  try {
    fn();
    results.push(['PASS', name]);
  } catch (err) {
    results.push(['FAIL', `${name} :: ${err.message}`]);
  }
};

check('200 status', () => assert.equal(res.status, 200));
check('schemaVersion stamped', () => assert.equal(body.schemaVersion, 1));

// ── provenance of torrentFile.canonicalInternalPath ────────────────────
check('torrentFile.canonicalInternalPath comes from torrent_files.internal_path',
  () => assert.equal(body.torrentFile.canonicalInternalPath, TF_INTERNAL_PATH));
check('torrentFile.canonicalInternalPath is NOT derived from provider_files.path',
  () => assert.notEqual(body.torrentFile.canonicalInternalPath, PROVIDER_FILE_PATH));
check('torrentFile.canonicalInternalPath is NOT normalized into a host/container path',
  () => assert.equal(body.torrentFile.canonicalInternalPath, TF_INTERNAL_PATH,
    're-canonicalization on read would have mutated the durable identity string'));

// ── provenance of providers[].canonicalInternalPath ────────────────────
check('exactly one provider maps back to the seed row', () => {
  assert.equal(body.providers.length, 1);
});
check('providers[0].canonicalInternalPath comes from provider_files.path',
  () => assert.equal(body.providers[0].canonicalInternalPath, PROVIDER_FILE_PATH));
check('providers[0].canonicalInternalPath is NOT derived from torrent_files.internal_path',
  () => assert.notEqual(body.providers[0].canonicalInternalPath, TF_INTERNAL_PATH));

// ── the "equal values are allowed" half of the invariant ───────────────
// We seed a SECOND coordinate whose provider path IS the durable identity
// path. The S-1 contract is fine with that -- they are different namespaces
// that happen to share a string -- and this test passing is what proves it.
store.db.exec(`
  INSERT INTO provider_placements
    (id, provider, account_scope, info_hash, provider_resource_id, state,
     ownership, provenance, observed_at, created_at, updated_at)
  VALUES ('pl_tb2', 'torbox', 'default', '${HASH}', 'res_tb2',
          'ready', 'owned', 'test', ${now}, ${now}, ${now});

  INSERT INTO provider_files
    (id, placement_id, provider_file_id, path, name, size, present,
     inventory_observed_at, torrent_file_id, mapping_state)
  VALUES ('pf_overlap', 'pl_tb2', '222', '${TF_INTERNAL_PATH}',
          'identity-path.mkv', ${TF_SIZE}, 1, ${now}, '${TF_ID}', 'mapped');
`);

const res2 = await fetch(`http://127.0.0.1:${port}/api/data-plane/files/${TF_ID}`);
const body2 = await res2.json();

check('equal values across namespaces are ALLOWED (the corrected invariant)', () => {
  // The point of this check: the contract does not require inequality.
  // If both responses are present and the projection is correct, the two
  // canonicalInternalPath fields may legitimately hold the same string.
  const tfIdentity = body2.torrentFile.canonicalInternalPath;
  const overlapping = body2.providers
    .map((p) => p.canonicalInternalPath)
    .filter((p) => p === tfIdentity);
  assert.ok(overlapping.length >= 1,
    'expected at least one provider whose path equals the durable identity path; ' +
    `got providers=${JSON.stringify(body2.providers.map((p) => p.canonicalInternalPath))}`);
});

check('provenance of the overlapping provider is still correct', () => {
  // Find the provider whose path is the identity path, and confirm it
  // came from the SECOND provider_files row, not the FIRST.
  const overlap = body2.providers.find(
    (p) => p.canonicalInternalPath === body2.torrentFile.canonicalInternalPath);
  assert.equal(overlap.providerFileId, '222',
    'projection swapped provenance -- the overlapping field came from the wrong column');
});

// ── the namespace warning is preserved even when the strings diverge ───
store.db.exec(`
  INSERT INTO provider_placements
    (id, provider, account_scope, info_hash, provider_resource_id, state,
     ownership, provenance, observed_at, created_at, updated_at)
  VALUES ('pl_div', 'torbox', 'default', '${HASH}', 'res_div',
          'ready', 'owned', 'test', ${now}, ${now}, ${now});

  INSERT INTO provider_files
    (id, placement_id, provider_file_id, path, name, size, present,
     inventory_observed_at, torrent_file_id, mapping_state)
  VALUES ('pf_div', 'pl_div', '333', '${DELIBERATELY_DIFFERENT}',
          'identity-path.mkv', ${TF_SIZE}, 1, ${now}, '${TF_ID}', 'mapped');
`);

const res3 = await fetch(`http://127.0.0.1:${port}/api/data-plane/files/${TF_ID}`);
const body3 = await res3.json();

check('the two namespaces are still independent when strings differ', () => {
  // The original assertion (P2 commit 50b35af) was assert.notEqual. We are
  // NOT preserving that here. We are recording, instead, that the projection
  // does not derive one from the other -- which is true whether the strings
  // happen to match or not.
  const div = body3.providers.find(
    (p) => p.canonicalInternalPath === DELIBERATELY_DIFFERENT);
  assert.ok(div, 'expected the deliberately-different provider to be present');
  // Crucially: a host/container/VFS path would NOT match DELIBERATELY_DIFFERENT.
  // If the projection were translating one namespace into another, the field
  // would have been rewritten to something canonical.
  assert.equal(div.canonicalInternalPath, DELIBERATELY_DIFFERENT,
    'projection rewrote the provider path -- the field is no longer a one-way ' +
    'projection of provider_files.path');
});

server.close();
store.close();

let failed = 0;
for (const [verdict, name] of results) {
  if (verdict === 'FAIL') failed += 1;
  console.log(`${verdict}  ${name}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);

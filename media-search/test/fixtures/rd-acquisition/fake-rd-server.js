/**
 * Fake RD /torrents server for tests.
 *
 * Builds a fetch stub that paginates an in-memory list the same way RD
 * does: GET /torrents?offset=N&limit=M returns a JSON array. The total
 * count is reported via X-Total-Count.
 *
 * Supports optional behavior flags:
 *   - transientFailures: array of {offset, status} — first attempt at the
 *     given offset returns the given status; subsequent attempts succeed.
 *   - dropField: a field name to strip from responses (e.g. 'hash' or
 *     'added') to exercise rejection paths.
 *   - badHashes: array of offsets whose entries have a deliberately bad
 *     hash to test rejection.
 *   - duplicateEntries: array of offsets whose entry is duplicated in
 *     the next page to test dedup.
 */

import { createHash } from 'node:crypto';

export function createFakeRdFetch({
  entries,
  pageSize = 1000,
  transientFailures = [],
  dropField,
  badHashes = [],
  duplicateEntries = [],
}) {
  const total = entries.length;
  const attempts = new Map(); // offset -> count

  return async (url, options = {}) => {
    const u = new URL(url);
    const offset = Number(u.searchParams.get('offset') || '0');
    const limit = Number(u.searchParams.get('limit') || String(pageSize));
    if (u.pathname !== '/rest/1.0/torrents') {
      return jsonResponse({ error: 'not found' }, 404);
    }
    const auth = options.headers && (options.headers.Authorization || options.headers.authorization);
    if (!auth || !auth.startsWith('Bearer ')) {
      return jsonResponse({ error: 'unauthorized' }, 401);
    }

    // Transient failures
    const attemptCount = (attempts.get(offset) || 0) + 1;
    attempts.set(offset, attemptCount);
    for (const tf of transientFailures) {
      if (tf.offset === offset && attemptCount === 1) {
        return jsonResponse({ error: 'temporarily unavailable' }, tf.status);
      }
    }

    const page = entries.slice(offset, offset + limit).map((e) => {
      let copy = { ...e };
      if (dropField) {
        const { [dropField]: _drop, ...rest } = copy;
        copy = rest;
      }
      if (badHashes.includes(offset)) {
        copy = { ...copy, hash: 'not-a-hash' };
      }
      return copy;
    });
    // Inject duplicates that also appear on the next page
    let toAdd = [];
    for (const dupOffset of duplicateEntries) {
      if (dupOffset === offset) {
        // duplicate from the start of the next page
        const dup = entries[offset + limit];
        if (dup) toAdd.push(dup);
      }
    }
    const final = [...page, ...toAdd];

    return jsonResponse(final, 200, { 'x-total-count': String(total) });
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const lower = String(name).toLowerCase();
        for (const k of Object.keys(extraHeaders)) {
          if (k.toLowerCase() === lower) return extraHeaders[k];
        }
        return null;
      },
      text: async () => JSON.stringify(body),
      json: async () => body,
    },
    async text() { return JSON.stringify(body); },
  };
}

export function makeRdEntry(i) {
  // Use a real SHA-1 of the seed so each entry has a unique, valid
  // 40-char hex infoHash. Lowercased to match RD's documented shape.
  const hash = createHash('sha1').update(`seed-${i}`).digest('hex');
  const added = new Date(1_700_000_000_000 + i * 1000).toISOString();
  return {
    id: `t${i}`,
    filename: `release-${i}.mkv`,
    hash,
    bytes: 1_000_000,
    host: 'real-debrid.com',
    split: 2000,
    progress: 100,
    status: 'downloaded',
    added,
    links: [],
    ended: added,
  };
}

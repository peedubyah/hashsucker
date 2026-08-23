/**
 * Operator utilities — shared helpers for operator dashboard endpoints.
 * Read-only access to importer request state and diagnostic runners.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const REQUEST_LOCATIONS = [
  ['incoming', 'queued'],
  ['processing', 'processing'],
  ['done', 'done'],
  ['failed', 'failed'],
];

const VALID_ID = /^[0-9a-f-]{36}$/i;

export function assertRequestId(requestId) {
  if (!VALID_ID.test(String(requestId || ''))) {
    throw new Error('Invalid request ID');
  }
}

/**
 * Read a single request from the filesystem queue.
 * Returns { requestId, status, request } or null.
 */
export async function readRequest(requestId, root) {
  assertRequestId(requestId);
  const filename = `${requestId}.json`;
  for (const [directory, status] of REQUEST_LOCATIONS) {
    try {
      const body = await fs.readFile(path.join(root, directory, filename), 'utf8');
      return { requestId, status, request: JSON.parse(body) };
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
  return null;
}

/**
 * List all requests across all queue directories.
 * Returns array of { requestId, status, request }.
 */
export async function listAllRequests(root) {
  const results = [];
  for (const [directory, status] of REQUEST_LOCATIONS) {
    const dirPath = path.join(root, directory);
    let entries;
    try {
      entries = await fs.readdir(dirPath);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const requestId = entry.slice(0, -5);
      if (!VALID_ID.test(requestId)) continue;
      try {
        const body = await fs.readFile(path.join(dirPath, entry), 'utf8');
        results.push({ requestId, status, request: JSON.parse(body) });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    }
  }
  return results;
}

/**
 * Move a request from one state directory to another (retry/reset).
 */
export async function moveRequest(requestId, fromDir, toDir, root) {
  assertRequestId(requestId);
  const filename = `${requestId}.json`;
  const fromPath = path.join(root, fromDir, filename);
  const toPath = path.join(root, toDir, filename);
  const tempPath = `${toPath}.tmp`;

  await fs.mkdir(path.join(root, toDir), { recursive: true });
  const body = await fs.readFile(fromPath, 'utf8');
  await fs.writeFile(tempPath, body, { encoding: 'utf8', flag: 'wx' });
  await fs.rename(tempPath, toPath);
  await fs.unlink(fromPath);
}

/**
 * Remove a request from ALL queue directories.
 */
export async function purgeRequest(requestId, root) {
  assertRequestId(requestId);
  const filename = `${requestId}.json`;
  for (const [directory] of REQUEST_LOCATIONS) {
    try {
      await fs.unlink(path.join(root, directory, filename));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

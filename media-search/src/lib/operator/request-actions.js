/**
 * Request actions — minimal management operations for stuck, failed, and orphaned requests.
 * Every action logs an audit entry and returns previous/new state.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { readRequest, moveRequest, purgeRequest, assertRequestId } from './index.js';

const VALID_ID = /^[0-9a-f-]{36}$/i;

/**
 * Append an audit entry to the local request-actions log.
 * @param {Object} entry
 * @param {string} root - requests root directory
 */
async function logAction(entry, root) {
  const logPath = path.join(root, '.actions.log');
  const line = JSON.stringify({ ...entry, at: new Date().toISOString() }) + '\n';
  await fs.appendFile(logPath, line, { encoding: 'utf8' });
}

/**
 * Retry a failed request by moving it back to incoming/queued.
 * @param {Object} options
 * @param {string} options.requestId - UUID of the request
 * @param {string} options.requestsRoot - Path to requests directory
 * @returns {Promise<{ requestId: string, previousState: string, newState: string }>}
 * @throws {Error} If request not found or not in failed state
 */
export async function retryFailedRequest({ requestId, requestsRoot }) {
  assertRequestId(requestId);
  const found = await readRequest(requestId, requestsRoot);
  if (!found) {
    throw new Error(`Request not found: ${requestId}`);
  }
  if (found.status !== 'failed') {
    throw new Error(`Cannot retry request in state "${found.status}" — only failed requests can be retried`);
  }
  const previousState = found.status;
  await moveRequest(requestId, 'failed', 'incoming', requestsRoot);
  await logAction({ requestId, action: 'retry', previousState, newState: 'incoming' }, requestsRoot);
  return { requestId, previousState, newState: 'incoming' };
}

/**
 * Reset a stuck processing request back to incoming/queued.
 * @param {Object} options
 * @param {string} options.requestId - UUID of the request
 * @param {string} options.requestsRoot - Path to requests directory
 * @returns {Promise<{ requestId: string, previousState: string, newState: string }>}
 * @throws {Error} If request not found or not in processing state
 */
export async function resetStuckRequest({ requestId, requestsRoot }) {
  assertRequestId(requestId);
  const found = await readRequest(requestId, requestsRoot);
  if (!found) {
    throw new Error(`Request not found: ${requestId}`);
  }
  if (found.status !== 'processing') {
    throw new Error(`Cannot reset request in state "${found.status}" — only processing requests can be reset`);
  }
  const previousState = found.status;
  await moveRequest(requestId, 'processing', 'incoming', requestsRoot);
  await logAction({ requestId, action: 'reset', previousState, newState: 'incoming' }, requestsRoot);
  return { requestId, previousState, newState: 'incoming' };
}

/**
 * Delete an orphaned request from all queue directories.
 * @param {Object} options
 * @param {string} options.requestId - UUID of the request
 * @param {string} options.requestsRoot - Path to requests directory
 * @returns {Promise<{ requestId: string, previousState: string, newState: string }>}
 * @throws {Error} If request not found
 */
export async function deleteOrphanedRequest({ requestId, requestsRoot }) {
  assertRequestId(requestId);
  const found = await readRequest(requestId, requestsRoot);
  if (!found) {
    throw new Error(`Request not found: ${requestId}`);
  }
  const previousState = found.status;
  await purgeRequest(requestId, requestsRoot);
  await logAction({ requestId, action: 'delete', previousState, newState: 'deleted' }, requestsRoot);
  return { requestId, previousState, newState: 'deleted' };
}

import fs from 'node:fs/promises';
import path from 'node:path';

import { emit, EVENTS } from '../../lib/trace/events.js';
import { inc } from '../../lib/metrics.js';

const LEGACY_REQUEST_DIR = path.resolve('data/requests');

/**
 * Queue a handoff for processing.
 *
 * Attaches timing metadata to the handoff so the full lifecycle
 * can be reconstructed from the persisted request file.
 *
 * @param {Object} handoff - Handoff object from createHandoff()
 * @param {Object} options
 * @param {string} options.requestDir - Directory to write to
 * @param {Object} [options.timing] - RequestTiming summary to persist
 * @returns {Promise<string>} Path to the written file
 */
export async function queueHandoff(handoff, options = {}) {
  if (!handoff?.requestId) {
    throw new Error('handoff requestId is required');
  }

  const requestDir = options.requestDir ||
    (process.env.REQUESTS_ROOT
      ? path.resolve(process.env.REQUESTS_ROOT, 'incoming')
      : LEGACY_REQUEST_DIR);

  await fs.mkdir(requestDir, { recursive: true });

  const filename = `${handoff.requestId}.json`;
  const finalPath = path.join(requestDir, filename);
  const tempPath = `${finalPath}.tmp`;

  // Attach timing metadata to the handoff for lifecycle tracking
  const handoffWithTiming = options.timing
    ? { ...handoff, timing: options.timing }
    : handoff;

  const body = `${JSON.stringify(handoffWithTiming, null, 2)}\n`;

  try {
    // Write-then-rename means consumers never see half-written JSON.
    await fs.writeFile(tempPath, body, {
      encoding: 'utf8',
      flag: 'wx',
    });

    await fs.rename(tempPath, finalPath);

    emit(EVENTS.QUEUE_WRITE, {
      requestId: handoff.requestId,
      path: finalPath,
      mediaId: handoff.intent?.mediaId,
      releaseKey: handoff.release?.releaseKey,
      handlingMode: handoff.handlingMode,
    });

    return finalPath;
  } catch (error) {
    if (handoff.handlingMode === 'stream') {
      inc('stream_failure_total');
    } else {
      inc('download_failure_total');
    }
    inc('requests_failed_total');
    emit(EVENTS.QUEUE_ERROR, {
      requestId: handoff.requestId,
      error: error.message,
    });
    throw error;
  }
}

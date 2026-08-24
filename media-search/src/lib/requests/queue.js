import fs from 'node:fs/promises';
import path from 'node:path';

import { emit, EVENTS } from '../../lib/trace/events.js';
import { inc } from '../../lib/metrics.js';

const LEGACY_REQUEST_DIR = path.resolve('data/requests');

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

  const body = `${JSON.stringify(handoff, null, 2)}\n`;

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

import fs from 'node:fs/promises';
import path from 'node:path';

const REQUEST_DIR = path.resolve('data/requests');

export async function queueHandoff(handoff) {
  if (!handoff?.requestId) {
    throw new Error('handoff requestId is required');
  }

  await fs.mkdir(REQUEST_DIR, { recursive: true });

  const filename = `${handoff.requestId}.json`;
  const finalPath = path.join(REQUEST_DIR, filename);
  const tempPath = `${finalPath}.tmp`;

  const body = `${JSON.stringify(handoff, null, 2)}\n`;

  // Write-then-rename means consumers never see half-written JSON.
  await fs.writeFile(tempPath, body, {
    encoding: 'utf8',
    flag: 'wx',
  });

  await fs.rename(tempPath, finalPath);

  return finalPath;
}
import fs from 'node:fs/promises';
import path from 'node:path';

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

  // Write-then-rename means consumers never see half-written JSON.
  await fs.writeFile(tempPath, body, {
    encoding: 'utf8',
    flag: 'wx',
  });

  await fs.rename(tempPath, finalPath);

  return finalPath;
}

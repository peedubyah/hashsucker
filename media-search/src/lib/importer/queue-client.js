import fs from 'node:fs/promises';
import path from 'node:path';

import { readHandoffReleaseIdentity } from '../../api/release-contract.js';
import { queueHandoff } from '../requests/queue.js';
import { ImporterClient } from './client.js';

const LOCATIONS = [
  ['incoming', 'queued'],
  ['processing', 'processing'],
  ['done', 'done'],
  ['failed', 'failed'],
];

function assertRequestId(requestId) {
  if (!/^[0-9a-f-]{36}$/i.test(String(requestId || ''))) {
    throw new Error('Invalid request ID');
  }
}

export class QueueImporterClient extends ImporterClient {
  constructor({ root = process.env.REQUESTS_ROOT || '/requests' } = {}) {
    super();
    this.root = path.resolve(root);
  }

  async submitRequest(handoff, options = {}) {
    await Promise.all(LOCATIONS.map(([directory]) =>
      fs.mkdir(path.join(this.root, directory), { recursive: true })
    ));
    await queueHandoff(handoff, {
      requestDir: path.join(this.root, 'incoming'),
      timing: options.timing || handoff.timing,
    });
    return {
      requestId: handoff.requestId,
      status: 'queued',
      release: readHandoffReleaseIdentity(handoff.release),
    };
  }

  async getRequestStatus(requestId) {
    const found = await this.getRequest(requestId);
    return found ? {
      requestId,
      status: found.status,
      release: readHandoffReleaseIdentity(found.request.release),
    } : null;
  }

  async getRequest(requestId) {
    assertRequestId(requestId);
    const filename = `${requestId}.json`;
    for (const [directory, status] of LOCATIONS) {
      try {
        const body = await fs.readFile(path.join(this.root, directory, filename), 'utf8');
        const request = JSON.parse(body);
        return { requestId, status, request };
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
    }
    return null;
  }
}

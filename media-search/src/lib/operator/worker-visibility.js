/**
 * Worker Visibility
 *
 * Tracks worker lifecycle information for the operator console.
 * Answers: "Is this request slow, or did the worker never process it?"
 *
 * Worker states:
 *   running  — actively processing requests
 *   idle     — no active jobs, waiting for work
 *   stuck    — processing job exceeded timeout
 *   error    — last job failed
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const STUCK_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Worker visibility tracker.
 *
 * Scans the request queue to determine worker status.
 */
export class WorkerVisibility {
  /**
   * @param {Object} options
   * @param {string} options.requestsRoot - Path to requests directory
   * @param {() => number} [options.now] - Clock function
   */
  constructor({ requestsRoot, now = Date.now } = {}) {
    this.requestsRoot = requestsRoot;
    this.now = now;
  }

  /**
   * Get worker status summary.
   *
   * @returns {Promise<Object>} Worker status
   */
  async getStatus() {
    const now = this.now();
    const dirs = ['incoming', 'processing', 'done', 'failed'];
    const requests = [];

    // Scan all queue files
    for (const dir of dirs) {
      const dirPath = path.join(this.requestsRoot, dir);
      let entries;
      try {
        entries = await fs.readdir(dirPath);
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const requestId = entry.slice(0, -5);
        if (!/^[0-9a-f-]{36}$/i.test(requestId)) continue;

        try {
          const body = await fs.readFile(path.join(dirPath, entry), 'utf8');
          const request = JSON.parse(body);
          requests.push({
            requestId,
            status: dir,
            request,
            updatedAt: request?.updatedAt || request?.updated_at || request?.createdAt || request?.created_at || null,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }

    // Calculate worker metrics
    const processing = requests.filter(r => r.status === 'processing');
    const queued = requests.filter(r => r.status === 'incoming');
    const completed = requests.filter(r => r.status === 'done');
    const failed = requests.filter(r => r.status === 'failed');

    // Find stuck jobs (processing for too long)
    const stuck = [];
    for (const r of processing) {
      const lastUpdate = r.updatedAt ? new Date(r.updatedAt).getTime() : null;
      if (lastUpdate && now - lastUpdate > STUCK_TIMEOUT_MS) {
        stuck.push({
          requestId: r.requestId,
          durationMs: now - lastUpdate,
          durationMin: Math.round((now - lastUpdate) / 60000),
        });
      }
    }

    // Determine worker status
    let status = 'idle';
    if (processing.length > 0) {
      status = stuck.length > 0 ? 'stuck' : 'running';
    }

    // Last heartbeat = most recent completed or failed job
    const recentCompleted = [...completed, ...failed]
      .sort((a, b) => {
        const ta = a.updatedAt || '';
        const tb = b.updatedAt || '';
        return ta < tb ? 1 : ta > b ? -1 : 0;
      });

    const lastHeartbeat = recentCompleted[0]?.updatedAt || null;
    const lastHeartbeatMs = lastHeartbeat ? now - new Date(lastHeartbeat).getTime() : null;

    // Current active job (most recent processing)
    const activeJob = processing.sort((a, b) => {
      const ta = a.updatedAt || '';
      const tb = b.updatedAt || '';
      return ta < tb ? 1 : ta > tb ? -1 : 0;
    })[0] || null;

    return {
      status,
      lastHeartbeat,
      lastHeartbeatMs,
      activeJobs: processing.length,
      currentRequestId: activeJob?.requestId || null,
      queuedJobs: queued.length,
      completedJobs: completed.length,
      failedJobs: failed.length,
      stuckJobs: stuck,
      totalJobs: requests.length,
    };
  }

  /**
   * Get detailed worker info for a specific request.
   *
   * @param {string} requestId
   * @returns {Promise<Object|null>}
   */
  async getRequestWorkerInfo(requestId) {
    const dirs = ['incoming', 'processing', 'done', 'failed'];
    
    for (const dir of dirs) {
      const filePath = path.join(this.requestsRoot, dir, `${requestId}.json`);
      try {
        const body = await fs.readFile(filePath, 'utf8');
        const request = JSON.parse(body);
        const now = this.now();
        const updatedAt = request?.updatedAt || request?.updated_at || request?.createdAt || request?.created_at;
        const lastUpdate = updatedAt ? new Date(updatedAt).getTime() : null;
        const isStuck = dir === 'processing' && lastUpdate && now - lastUpdate > STUCK_TIMEOUT_MS;

        return {
          requestId,
          status: dir,
          isStuck,
          durationMs: lastUpdate ? now - lastUpdate : null,
          durationMin: lastUpdate ? Math.round((now - lastUpdate) / 60000) : null,
          lastUpdate: updatedAt,
          workerStatus: isStuck ? 'stuck' : dir === 'processing' ? 'running' : 'idle',
        };
      } catch {
        continue;
      }
    }
    
    return null;
  }
}

/**
 * Create a worker visibility tracker.
 *
 * @param {Object} options
 * @param {string} options.requestsRoot
 * @param {() => number} [options.now]
 * @returns {WorkerVisibility}
 */
export function createWorkerVisibility(options) {
  return new WorkerVisibility(options);
}

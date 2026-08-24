/**
 * Worker Visibility Tests
 *
 * Tests createWorkerVisibility, getStatus, and formatWorkerStatus.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

import { createWorkerVisibility } from '../src/lib/operator/worker-visibility.js';
import { formatWorkerStatus } from '../src/lib/operator/worker-formatter.js';

async function createTempRequestsDir() {
  const tmpDir = path.join(os.tmpdir(), 'worker-test-' + Date.now());
  await fs.mkdir(path.join(tmpDir, 'incoming'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'processing'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'done'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'failed'), { recursive: true });
  return tmpDir;
}

async function writeRequest(root, dir, requestId, data = {}) {
  const filePath = path.join(root, dir, `${requestId}.json`);
  await fs.writeFile(filePath, JSON.stringify({
    requestId,
    mediaId: 'tt-test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...data,
  }));
}

test('createWorkerVisibility creates instance', () => {
  const wv = createWorkerVisibility({ requestsRoot: '/tmp/test' });
  assert.ok(wv);
});

test('getStatus returns idle when no requests', async () => {
  const root = await createTempRequestsDir();
  const wv = createWorkerVisibility({ requestsRoot: root, now: () => Date.now() });
  
  const status = await wv.getStatus();
  assert.equal(status.status, 'idle');
  assert.equal(status.queuedJobs, 0);
  assert.equal(status.activeJobs, 0);
  assert.equal(status.completedJobs, 0);
  assert.equal(status.failedJobs, 0);
  
  await fs.rm(root, { recursive: true });
});

test('getStatus shows running when processing', async () => {
  const root = await createTempRequestsDir();
  await writeRequest(root, 'processing', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  
  const wv = createWorkerVisibility({ requestsRoot: root, now: () => Date.now() });
  const status = await wv.getStatus();
  
  assert.equal(status.status, 'running');
  assert.equal(status.activeJobs, 1);
  assert.ok(status.currentRequestId);
  
  await fs.rm(root, { recursive: true });
});

test('getStatus detects stuck jobs', async () => {
  const root = await createTempRequestsDir();
  const oldDate = new Date(Date.now() - 45 * 60 * 1000).toISOString(); // 45 minutes ago
  await writeRequest(root, 'processing', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', { updatedAt: oldDate });
  
  const wv = createWorkerVisibility({ requestsRoot: root, now: () => Date.now() });
  const status = await wv.getStatus();
  
  assert.equal(status.status, 'stuck');
  assert.equal(status.stuckJobs.length, 1);
  assert.equal(status.stuckJobs[0].durationMin, 45);
  
  await fs.rm(root, { recursive: true });
});

test('getStatus counts completed and failed', async () => {
  const root = await createTempRequestsDir();
  await writeRequest(root, 'done', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  await writeRequest(root, 'done', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  await writeRequest(root, 'failed', 'cccccccc-dddd-eeee-ffff-000000000000');
  
  const wv = createWorkerVisibility({ requestsRoot: root, now: () => Date.now() });
  const status = await wv.getStatus();
  
  assert.equal(status.completedJobs, 2);
  assert.equal(status.failedJobs, 1);
  
  await fs.rm(root, { recursive: true });
});

test('getStatus shows queued jobs', async () => {
  const root = await createTempRequestsDir();
  await writeRequest(root, 'incoming', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  await writeRequest(root, 'incoming', 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff');
  
  const wv = createWorkerVisibility({ requestsRoot: root, now: () => Date.now() });
  const status = await wv.getStatus();
  
  assert.equal(status.queuedJobs, 2);
  
  await fs.rm(root, { recursive: true });
});

test('formatWorkerStatus renders header', () => {
  const status = {
    status: 'running',
    lastHeartbeat: '2026-08-24T03:00:00.000Z',
    lastHeartbeatMs: 12000,
    currentRequestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    queuedJobs: 2,
    activeJobs: 1,
    completedJobs: 421,
    failedJobs: 3,
    stuckJobs: [],
  };
  
  const text = formatWorkerStatus(status);
  assert.match(text, /WORKERS/);
  assert.match(text, /Status: running/);
  assert.match(text, /Heartbeat: 12s ago/);
  assert.match(text, /Active job: aaaaaaaa-bbb.../);
  assert.match(text, /Completed: 421/);
  assert.match(text, /Failed: 3/);
});

test('formatWorkerStatus renders idle status', () => {
  const status = {
    status: 'idle',
    lastHeartbeat: null,
    lastHeartbeatMs: null,
    currentRequestId: null,
    queuedJobs: 0,
    activeJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    stuckJobs: [],
  };
  
  const text = formatWorkerStatus(status);
  assert.match(text, /Status: idle/);
  assert.match(text, /Heartbeat: never/);
  assert.match(text, /Active job: none/);
});

test('formatWorkerStatus renders stuck status', () => {
  const status = {
    status: 'stuck',
    lastHeartbeat: null,
    lastHeartbeatMs: null,
    currentRequestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    queuedJobs: 0,
    activeJobs: 1,
    completedJobs: 0,
    failedJobs: 0,
    stuckJobs: [{ requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', durationMin: 45 }],
  };
  
  const text = formatWorkerStatus(status);
  assert.match(text, /Status: stuck/);
  assert.match(text, /Stuck Jobs \(1\):/);
  assert.match(text, /45min/);
});

test('formatWorkerStatus handles null status', () => {
  const text = formatWorkerStatus(null);
  assert.match(text, /No worker data available/);
});

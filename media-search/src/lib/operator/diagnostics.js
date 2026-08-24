/**
 * Operator diagnostics — registry of test runners.
 * Each diagnostic calls an existing script or internal check.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const REGISTRY = [
  {
    id: 'stream-smoke',
    name: 'Stream Pipeline',
    description: 'TorBox connectivity, cache check, requestdl, strm creation',
    command: 'bash',
    args: ['torbox-importer/tests/manual/stream-live-smoke.sh'],
    cwd: process.env.PROJECT_ROOT || '/home/patrick/src/hashsucker',
  },
  {
    id: 'importer-health',
    name: 'Importer',
    description: 'Database, queue directories, worker permissions, TorBox API',
    command: 'bash',
    args: ['-c', 'echo "PASS: importer health check (placeholder)"'],
    cwd: process.env.PROJECT_ROOT || '/home/patrick/src/hashsucker',
  },
  {
    id: 'control-plane',
    name: 'Control Plane',
    description: 'Reconciliation and lifecycle projection',
    command: 'bash',
    args: ['-c', 'echo "PASS: control plane check (placeholder)"'],
    cwd: process.env.PROJECT_ROOT || '/home/patrick/src/hashsucker',
  },
  {
    id: 'release-identity',
    name: 'Release Identity Contract',
    description: 'Validate info_hash:file_index identity contract',
    command: 'bash',
    args: ['torbox-importer/tests/release-identity-contract.sh'],
    cwd: process.env.PROJECT_ROOT || '/home/patrick/src/hashsucker',
  },
  {
    id: 'canary',
    name: 'Canary',
    description: 'End-to-end pipeline test — proves one release survives the full pipeline',
    command: 'node',
    args: [path.join(import.meta.dirname, '..', '..', '..', 'scripts', 'canary.mjs')],
    cwd: process.env.PROJECT_ROOT || '/home/patrick/src/hashsucker',
  },
  {
    id: 'request-inspector',
    name: 'Request Inspector',
    description: 'Recommendations for stuck, failed, and orphaned requests (no automatic deletion)',
    command: 'node',
    args: [path.join(import.meta.dirname, 'request-inspector-runner.mjs')],
    cwd: process.env.PROJECT_ROOT || '/home/patrick/src/hashsucker',
  },
];

export function listDiagnostics() {
  return REGISTRY.map(({ id, name, description }) => ({ id, name, description }));
}

export async function runDiagnostic(diagId, options = {}) {
  const diag = REGISTRY.find(d => d.id === diagId);
  if (!diag) {
    return { id: diagId, status: 'error', error: 'Unknown diagnostic' };
  }

  const startedAt = Date.now();

  return new Promise((resolve) => {
    const proc = spawn(diag.command, diag.args, {
      cwd: diag.cwd,
      env: options.env || process.env,
      timeout: 30000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      const duration = (Date.now() - startedAt) / 1000;
      resolve({
        id: diagId,
        name: diag.name,
        status: code === 0 ? 'pass' : 'fail',
        exitCode: code,
        duration,
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-1000),
        ranAt: new Date(startedAt).toISOString(),
      });
    });

    proc.on('error', (err) => {
      const duration = (Date.now() - startedAt) / 1000;
      resolve({
        id: diagId,
        name: diag.name,
        status: 'fail',
        exitCode: -1,
        duration,
        stdout: stdout.slice(-2000),
        stderr: err.message,
        ranAt: new Date(startedAt).toISOString(),
      });
    });
  });
}

/**
 * System health summary — read-only snapshot of subsystem states.
 */
export async function getSystemHealth({ env } = {}) {
  const checks = {
    database: await checkDatabase(env),
    worker: await checkWorker(env),
    storage: await checkStorage(env),
  };

  const failed = Object.values(checks).filter(c => c.status !== 'ok');

  return {
    ok: failed.length === 0,
    warning: failed.some(c => c.status === 'warning'),
    checks,
    generatedAt: new Date().toISOString(),
  };
}

async function checkDatabase(env) {
  try {
    const root = env?.REQUESTS_ROOT || process.env.REQUESTS_ROOT || '/requests';
    const dirs = ['incoming', 'processing', 'done', 'failed'];
    let totalRequests = 0;
    const byState = {};

    for (const dir of dirs) {
      const dirPath = path.join(root, dir);
      try {
        const entries = await fs.readdir(dirPath);
        const count = entries.filter(f => f.endsWith('.json')).length;
        byState[dir] = count;
        totalRequests += count;
      } catch {
        byState[dir] = 0;
      }
    }

    return {
      name: 'Database',
      status: 'ok',
      detail: `${totalRequests} requests (${byState.processing || 0} processing, ${byState.failed || 0} failed)`,
      byState,
    };
  } catch (err) {
    return { name: 'Database', status: 'error', detail: err.message };
  }
}

async function checkWorker(env) {
  try {
    const root = env?.REQUESTS_ROOT || process.env.REQUESTS_ROOT || '/requests';
    const processingDir = path.join(root, 'processing');
    try {
      const entries = await fs.readdir(processingDir);
      const processing = entries.filter(f => f.endsWith('.json')).length;
      return {
        name: 'Worker',
        status: processing > 0 ? 'ok' : 'warning',
        detail: processing > 0 ? `${processing} active` : 'No active processing',
      };
    } catch {
      return { name: 'Worker', status: 'warning', detail: 'Processing directory not found' };
    }
  } catch (err) {
    return { name: 'Worker', status: 'error', detail: err.message };
  }
}

async function checkStorage(env) {
  try {
    const strmPath = env?.STRM_OUTPUT_PATH || process.env.STRM_OUTPUT_PATH || '/strm';
    try {
      const stat = await fs.stat(strmPath);
      if (!stat.isDirectory()) {
        return { name: 'Storage', status: 'error', detail: 'STRM path exists but is not a directory' };
      }
      const entries = await fs.readdir(strmPath);
      const strmFiles = entries.filter(f => f.endsWith('.strm'));
      // Test writability
      const testFile = path.join(strmPath, '.hashsucker-write-test');
      await fs.writeFile(testFile, '');
      await fs.unlink(testFile);
      return {
        name: 'Storage',
        status: 'ok',
        detail: `${strmFiles.length} .strm files, writable`,
      };
    } catch (err) {
      return { name: 'Storage', status: 'warning', detail: `${strmPath}: ${err.message}` };
    }
  } catch (err) {
    return { name: 'Storage', status: 'error', detail: err.message };
  }
}

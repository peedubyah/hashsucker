import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Health checks for the media-search service.
 *
 * Liveness: Is the process alive?
 * Readiness: Can it do work?
 */

/**
 * Liveness check — is the process alive?
 * Simple static response, no I/O.
 */
export function liveness() {
  return {
    status: 'healthy',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Readiness check — can the process do work?
 * Checks dependencies and subsystem health.
 */
export function readiness(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const checks = {};

  // Database accessible
  checks.database = checkDatabases(env);

  // Migrations current
  checks.migrations = checkMigrations(env);

  // TorBox credentials present
  checks.torbox = checkTorBoxCredentials(env);

  // Queue directories writable
  checks.queue = checkQueueDirectories(env);

  // Worker heartbeat recent
  checks.worker = checkWorkerHeartbeat(env, now);

  // Determine overall status
  const failed = Object.entries(checks).filter(([, v]) => v.status === 'error');
  const warnings = Object.entries(checks).filter(([, v]) => v.status === 'warning');

  const status = failed.length > 0 ? 'unhealthy' : warnings.length > 0 ? 'degraded' : 'healthy';

  return {
    status,
    checks,
    timestamp: new Date().toISOString(),
  };
}

function checkDatabases(env) {
  const results = [];

  // Discovery cache DB
  if (env.DISCOVERY_DB) {
    const discoveryDb = env.DISCOVERY_DB;
    if (discoveryDb === ':memory:') {
      results.push({ name: 'discovery-cache', status: 'ok', detail: 'in-memory' });
    } else {
      try {
        fs.accessSync(discoveryDb, fs.constants.R_OK | fs.constants.W_OK);
        const stat = fs.statSync(discoveryDb);
        if (stat.isFile()) {
          results.push({ name: 'discovery-cache', status: 'ok', detail: 'accessible' });
        } else {
          results.push({ name: 'discovery-cache', status: 'error', detail: 'not a file' });
        }
      } catch (err) {
        results.push({ name: 'discovery-cache', status: 'error', detail: err.message });
      }
    }
  } else {
    results.push({ name: 'discovery-cache', status: 'warning', detail: 'not configured' });
  }

  // Control-plane DB
  if (env.CONTROL_PLANE_DB) {
    try {
      fs.accessSync(env.CONTROL_PLANE_DB, fs.constants.R_OK | fs.constants.W_OK);
      const stat = fs.statSync(env.CONTROL_PLANE_DB);
      if (stat.isFile()) {
        results.push({ name: 'control-plane', status: 'ok', detail: 'accessible' });
      } else {
        results.push({ name: 'control-plane', status: 'error', detail: 'not a file' });
      }
    } catch (err) {
      results.push({ name: 'control-plane', status: 'error', detail: err.message });
    }
  } else {
    results.push({ name: 'control-plane', status: 'warning', detail: 'not configured' });
  }

  const failed = results.filter((r) => r.status === 'error');
  return {
    status: failed.length > 0 ? 'error' : 'ok',
    detail: results.map((r) => `${r.name}: ${r.detail}`).join('; '),
    databases: results,
  };
}

function checkMigrations(env) {
  const dbPath = env.DISCOVERY_DB;
  if (!dbPath || dbPath === ':memory:') {
    return { status: 'warning', detail: 'in-memory or no DB configured' };
  }

  try {
    // Check if schema_migrations table exists and has entries
    const db = new DatabaseSync(dbPath, { readOnly: true });

    try {
      const row = db.prepare('SELECT COUNT(*) as count FROM schema_migrations').get();
      const count = row?.count ?? 0;
      return {
        status: count > 0 ? 'ok' : 'warning',
        detail: `${count} migration(s) applied`,
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return { status: 'warning', detail: err.message };
  }
}

function checkTorBoxCredentials(env) {
  if (env.TORBOX_API_KEY) {
    return { status: 'ok', detail: 'API key present' };
  }
  return { status: 'warning', detail: 'TORBOX_API_KEY not set' };
}

function checkQueueDirectories(env) {
  const root = env.REQUESTS_ROOT || '/requests';
  const dirs = ['incoming', 'processing', 'done', 'failed'];
  const results = [];

  for (const dir of dirs) {
    const dirPath = path.join(root, dir);
    try {
      fs.accessSync(dirPath, fs.constants.W_OK);
      results.push({ name: dir, status: 'ok' });
    } catch {
      results.push({ name: dir, status: 'error', detail: 'not writable' });
    }
  }

  const failed = results.filter((r) => r.status === 'error');
  return {
    status: failed.length > 0 ? 'error' : 'ok',
    detail: `${results.filter((r) => r.status === 'ok').length}/${dirs.length} directories writable`,
    directories: results,
  };
}

function checkWorkerHeartbeat(env, now) {
  const root = env.REQUESTS_ROOT || '/requests';
  const processingDir = path.join(root, 'processing');

  try {
    const entries = fs.readdirSync(processingDir);
    const processing = entries.filter((f) => f.endsWith('.json')).length;

    // Worker is doing work if there are items in processing
    // This is a simple heuristic — a more robust check would track last activity timestamp
    if (processing > 0) {
      return { status: 'ok', detail: `${processing} item(s) in processing` };
    }

    // No items in processing — check if there are any queued
    const incomingDir = path.join(root, 'incoming');
    try {
      const incoming = fs.readdirSync(incomingDir).filter((f) => f.endsWith('.json')).length;
      if (incoming > 0) {
        return { status: 'warning', detail: `${incoming} queued, worker may be idle` };
      }
    } catch {}

    return { status: 'ok', detail: 'idle (no work queued)' };
  } catch (err) {
    return { status: 'error', detail: err.message };
  }
}

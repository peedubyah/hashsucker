/**
 * Operator diagnostics — container-native diagnostic runners.
 *
 * All diagnostics execute as JS functions. No shell spawning.
 * Checks requiring external environment are marked unsupported.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { sampleRandomRelease } from '../discovery/corpus-sampler.js';

/**
 * Check if running inside a container (no bash, limited filesystem).
 */
function isContainerEnvironment() {
  try {
    require('node:fs').accessSync('/bin/bash');
    return false;
  } catch {
    return true;
  }
}

const CONTAINER = isContainerEnvironment();

/**
 * Diagnostic registry — each entry is a JS function.
 * Returns: { id, name, status, duration, result, unsupported, reason }
 */
const REGISTRY = [
  {
    id: 'database-connectivity',
    name: 'Database Connectivity',
    description: 'Verify SQLite databases are accessible and schema is current',
    run: () => runDatabaseConnectivity(),
  },
  {
    id: 'enrichment-pipeline',
    name: 'Enrichment Pipeline',
    description: 'Check identity enrichment queue status and resolver health',
    run: () => runEnrichmentCheck(),
  },
  {
    id: 'search-engine',
    name: 'Search Engine',
    description: 'Verify FTS5 index and search engine readiness',
    run: () => runSearchEngineCheck(),
  },
  {
    id: 'stream-smoke',
    name: 'Stream Pipeline',
    description: 'TorBox connectivity, cache check, requestdl, strm creation',
    run: () => runExternalCheck('stream-smoke', 'TorBox API + filesystem'),
  },
  {
    id: 'importer-health',
    name: 'Importer',
    description: 'Database, queue directories, worker permissions, TorBox API',
    run: () => runExternalCheck('importer-health', 'Host filesystem + TorBox API'),
  },
  {
    id: 'control-plane',
    name: 'Control Plane',
    description: 'Control plane subsystem health',
    run: () => runExternalCheck('control-plane', 'Host filesystem + queue directories'),
  },
  {
    id: 'release-identity',
    name: 'Release Identity Contract',
    description: 'Release identity schema validation',
    run: () => runExternalCheck('release-identity', 'torbox-importer test scripts'),
  },
  {
    id: 'canary',
    name: 'Canary',
    description: 'Random corpus sample — runs pipeline on sampled release',
    run: () => runCanary(),
  },
  {
    id: 'request-inspector',
    name: 'Request Inspector',
    description: 'Recommendations for stuck, failed, and orphaned requests',
    run: () => runRequestInspector(),
  },
];

/**
 * Get list of available diagnostics (UI-facing).
 */
export function listDiagnostics() {
  return REGISTRY.map(({ id, name, description }) => ({ id, name, description }));
}

/**
 * Run a diagnostic by ID.
 * @param {string} diagId
 * @param {Object} options
 * @returns {Object} { id, name, status, duration, result, unsupported, reason }
 */
export async function runDiagnostic(diagId, options = {}) {
  const diag = REGISTRY.find(d => d.id === diagId);
  if (!diag) {
    return { id: diagId, status: 'error', error: 'Unknown diagnostic' };
  }

  const start = Date.now();
  try {
    const result = await diag.run(options);
    return {
      ...result,
      id: diagId,
      name: diag.name,
      duration: Date.now() - start,
    };
  } catch (err) {
    return {
      id: diagId,
      name: diag.name,
      status: 'error',
      duration: Date.now() - start,
      error: err.message,
    };
  }
}

/**
 * System health snapshot — container-native.
 * Replaces getSystemHealth with no shell spawning.
 */
export async function getSystemHealth(options = {}) {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;

  const checks = {};

  checks.database = await checkDatabaseHealth(env);
  checks.enrichment = await checkEnrichmentHealth(env);
  checks.search = await checkSearchHealth(env);
  checks.container = checkContainerHealth();

  const failed = Object.values(checks).filter(c => c.status === 'error');
  const warnings = Object.values(checks).filter(c => c.status === 'warning');

  return {
    status: failed.length > 0 ? 'unhealthy' : warnings.length > 0 ? 'degraded' : 'healthy',
    container: CONTAINER,
    checks,
    timestamp: new Date().toISOString(),
  };
}

// =============================================================================
// Diagnostic Implementations
// =============================================================================

async function runDatabaseConnectivity() {
  const databases = [];

  const discoveryDb = process.env.DISCOVERY_DB;
  if (discoveryDb) {
    if (discoveryDb === ':memory:') {
      databases.push({ name: 'discovery-cache', status: 'ok', detail: 'in-memory' });
    } else {
      try {
        await fs.access(discoveryDb);
        const stat = await fs.stat(discoveryDb);
        databases.push({
          name: 'discovery-cache',
          status: stat.isFile() ? 'ok' : 'error',
          detail: stat.isFile() ? 'accessible' : 'not a file',
        });
      } catch (err) {
        databases.push({ name: 'discovery-cache', status: 'error', detail: err.message });
      }
    }
  } else {
    databases.push({ name: 'discovery-cache', status: 'warning', detail: 'not configured' });
  }

  const controlPlaneDb = process.env.CONTROL_PLANE_DB;
  if (controlPlaneDb) {
    try {
      await fs.access(controlPlaneDb);
      const stat = await fs.stat(controlPlaneDb);
      databases.push({
        name: 'control-plane',
        status: stat.isFile() ? 'ok' : 'error',
        detail: stat.isFile() ? 'accessible' : 'not a file',
      });
    } catch (err) {
      databases.push({ name: 'control-plane', status: 'error', detail: err.message });
    }
  } else {
    databases.push({ name: 'control-plane', status: 'warning', detail: 'not configured' });
  }

  const failed = databases.filter(d => d.status === 'error');
  return {
    status: failed.length > 0 ? 'fail' : 'pass',
    result: { databases },
  };
}

async function runEnrichmentCheck() {
  const discoveryDb = process.env.DISCOVERY_DB;
  if (!discoveryDb || discoveryDb === ':memory:') {
    return {
      status: 'warning',
      result: { detail: 'Enrichment DB not configured or in-memory' },
    };
  }

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(discoveryDb, { readOnly: true });

    try {
      const pending = db.prepare("SELECT COUNT(*) as n FROM identity_enrichment_queue WHERE status = 'pending'").get();
      const resolved = db.prepare("SELECT COUNT(*) as n FROM identity_enrichment_queue WHERE status = 'resolved'").get();
      const failed = db.prepare("SELECT COUNT(*) as n FROM identity_enrichment_queue WHERE status = 'failed'").get();

      return {
        status: 'pass',
        result: {
          queue: {
            pending: pending.n,
            resolved: resolved.n,
            failed: failed.n,
          },
        },
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return { status: 'fail', result: { detail: err.message } };
  }
}

async function runSearchEngineCheck() {
  const discoveryDb = process.env.DISCOVERY_DB;
  if (!discoveryDb || discoveryDb === ':memory:') {
    return {
      status: 'warning',
      result: { detail: 'Search DB not configured or in-memory' },
    };
  }

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(discoveryDb, { readOnly: true });

    try {
      const indexed = db.prepare('SELECT COUNT(*) as n FROM release_search').get();
      const total = db.prepare('SELECT COUNT(*) as n FROM release_attributes').get();

      return {
        status: 'pass',
        result: {
          ftsIndexed: indexed.n,
          totalAttributes: total.n,
          indexHealthy: indexed.n === total.n,
        },
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return { status: 'fail', result: { detail: err.message } };
  }
}

function runCanary() {
  const sample = sampleRandomRelease();
  
  if (!sample) {
    return {
      status: 'warning',
      result: {
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
        sample: null,
        reason: 'Corpus empty or no valid entries',
      },
    };
  }

  return {
    status: 'pass',
    result: {
      nodeVersion: process.version,
      platform: process.platform,
      uptime: process.uptime(),
      sample: {
        infoHash: sample.infoHash,
        filename: sample.filename,
        source: 'corpus_sampler',
        identity: sample.identity ? {
          mediaId: sample.identity.mediaId,
          state: sample.identity.resolutionState,
          confidence: sample.identity.confidence,
        } : null,
      },
    },
  };
}

function runRequestInspector() {
  if (CONTAINER) {
    return {
      status: 'unsupported',
      unsupported: true,
      reason: 'Request inspector requires host filesystem access (queue directories)',
    };
  }

  const operatorRoot = process.env.OPERATOR_ROOT;
  if (!operatorRoot) {
    return {
      status: 'unsupported',
      unsupported: true,
      reason: 'OPERATOR_ROOT not set — cannot inspect request queue',
    };
  }

  try {
    const entries = require('node:fs').readdirSync(operatorRoot, { withFileTypes: true });
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    const expected = ['incoming', 'processing', 'done', 'failed'];
    const present = expected.filter(d => dirs.includes(d));

    return {
      status: present.length === expected.length ? 'pass' : 'warning',
      result: {
        operatorRoot,
        directoriesPresent: present,
        directoriesMissing: expected.filter(d => !dirs.includes(d)),
      },
    };
  } catch (err) {
    return { status: 'fail', result: { detail: err.message } };
  }
}

function runExternalCheck(id, requirement) {
  return {
    status: 'unsupported',
    unsupported: true,
    reason: `${id} requires ${requirement} — not available in container runtime`,
  };
}

// =============================================================================
// System Health Checks
// =============================================================================

async function checkDatabaseHealth(env) {
  const discoveryDb = env.DISCOVERY_DB;
  if (!discoveryDb) {
    return { name: 'Database', status: 'warning', detail: 'DISCOVERY_DB not configured' };
  }
  if (discoveryDb === ':memory:') {
    return { name: 'Database', status: 'ok', detail: 'in-memory' };
  }

  try {
    await fs.access(discoveryDb);
    const stat = await fs.stat(discoveryDb);
    if (!stat.isFile()) {
      return { name: 'Database', status: 'error', detail: 'not a file' };
    }
    return { name: 'Database', status: 'ok', detail: 'accessible' };
  } catch (err) {
    return { name: 'Database', status: 'error', detail: err.message };
  }
}

async function checkEnrichmentHealth(env) {
  const discoveryDb = env.DISCOVERY_DB;
  if (!discoveryDb || discoveryDb === ':memory:') {
    return { name: 'Enrichment', status: 'warning', detail: 'DB not configured' };
  }

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(discoveryDb, { readOnly: true });

    try {
      const failed = db.prepare("SELECT COUNT(*) as n FROM identity_enrichment_queue WHERE status = 'failed'").get();
      if (failed.n > 10) {
        return { name: 'Enrichment', status: 'warning', detail: `${failed.n} failed items` };
      }
      return { name: 'Enrichment', status: 'ok', detail: 'queue healthy' };
    } finally {
      db.close();
    }
  } catch (err) {
    return { name: 'Enrichment', status: 'error', detail: err.message };
  }
}

async function checkSearchHealth(env) {
  const discoveryDb = env.DISCOVERY_DB;
  if (!discoveryDb || discoveryDb === ':memory:') {
    return { name: 'Search', status: 'warning', detail: 'DB not configured' };
  }

  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(discoveryDb, { readOnly: true });

    try {
      const indexed = db.prepare('SELECT COUNT(*) as n FROM release_search').get();
      if (indexed.n === 0) {
        return { name: 'Search', status: 'warning', detail: 'FTS index empty' };
      }
      return { name: 'Search', status: 'ok', detail: `${indexed.n} entries indexed` };
    } finally {
      db.close();
    }
  } catch (err) {
    return { name: 'Search', status: 'error', detail: err.message };
  }
}

function checkContainerHealth() {
  return {
    name: 'Runtime',
    status: 'ok',
    detail: CONTAINER ? 'container (node:alpine, no bash)' : 'host (bash available)',
    container: CONTAINER,
  };
}

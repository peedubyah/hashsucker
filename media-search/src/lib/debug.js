/**
 * Debug endpoint — full request trace.
 * 
 * GET /api/debug/request/:id
 * Returns: request, handoff, events, provider attempts, lifecycle, final state.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { readRequest } from './operator/index.js';
import { readHandoffReleaseIdentity } from '../api/release-contract.js';

/**
 * Build a full debug trace for a request.
 */
export async function getRequestDebug(requestId, options = {}) {
  const env = options.env ?? process.env;
  const root = options.root || env.REQUESTS_ROOT || '/requests';

  const result = {
    found: false,
    requestId,
    status: null,
    request: null,
    handoff: null,
    events: [],
    providerAttempts: [],
    lifecycle: null,
    finalState: null,
    errors: [],
  };

  // Find the request file
  const locations = [
    ['incoming', 'queued'],
    ['processing', 'processing'],
    ['done', 'done'],
    ['failed', 'failed'],
  ];

  let found = null;
  for (const [directory, status] of locations) {
    const filePath = path.join(root, directory, `${requestId}.json`);
    try {
      const body = await fs.readFile(filePath, 'utf8');
      const request = JSON.parse(body);
      found = { directory, status, request, path: filePath };
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        result.errors.push({ location: directory, error: err.message });
      }
    }
  }

  if (!found) {
    return result;
  }

  result.found = true;
  result.status = found.status;
  result.request = found.request;

  // Extract handoff data
  if (found.request) {
    result.handoff = {
      requestId: found.request.requestId,
      createdAt: found.request.createdAt,
      provider: found.request.provider,
      handlingMode: found.request.handlingMode,
      intent: found.request.intent || null,
      release: found.request.release || null,
    };

    // Reconstruct release identity
    if (found.request.release) {
      try {
        result.handoff.releaseIdentity = readHandoffReleaseIdentity(found.request.release);
      } catch (err) {
        result.errors.push({ step: 'release_identity', error: err.message });
      }
    }

    // Build timeline from request fields
    const req = found.request;
    result.events = buildEventTimeline(req);

    // Provider attempts from request metadata
    result.providerAttempts = buildProviderAttempts(req);

    // Lifecycle projection
    result.lifecycle = projectLifecycle(req);

    // Final state
    result.finalState = {
      status: found.status,
      directory: found.directory,
      completedAt: req.completedAt || req.completed_at || null,
      failedAt: req.failedAt || req.failed_at || null,
      lastError: req.lastError || req.last_error || null,
    };

    // Timing summary — expose lifecycle timing for operator console
    if (req.timing) {
      result.timing = req.timing;
    }
  }

  return result;
}

function buildEventTimeline(req) {
  const events = [];

  if (req.createdAt || req.created_at) {
    events.push({
      timestamp: req.createdAt || req.created_at,
      event: 'request.created',
      status: 'complete',
    });
  }

  if (req.handoffCreatedAt || req.handoff_created_at) {
    events.push({
      timestamp: req.handoffCreatedAt || req.handoff_created_at,
      event: 'handoff.created',
      status: 'complete',
    });
  }

  if (req.providerAssignedAt || req.provider_assigned_at) {
    events.push({
      timestamp: req.providerAssignedAt || req.provider_assigned_at,
      event: 'provider.assigned',
      provider: req.provider,
      status: 'complete',
    });
  }

  if (req.processingStartedAt || req.processing_started_at) {
    events.push({
      timestamp: req.processingStartedAt || req.processing_started_at,
      event: 'processing.started',
      status: 'complete',
    });
  }

  if (req.torboxId || req.torbox_id) {
    events.push({
      timestamp: req.torboxResolvedAt || req.torbox_resolved_at || req.processingStartedAt,
      event: 'torbox.resolved',
      torrentId: req.torboxId || req.torbox_id,
      status: 'complete',
    });
  }

  if (req.cacheCheckedAt || req.cache_checked_at) {
    events.push({
      timestamp: req.cacheCheckedAt || req.cache_checked_at,
      event: 'cache.checked',
      hit: req.cacheHit ?? req.cache_hit ?? null,
      status: 'complete',
    });
  }

  if (req.strmCreatedAt || req.strm_created_at) {
    events.push({
      timestamp: req.strmCreatedAt || req.strm_created_at,
      event: 'strm.created',
      status: 'complete',
    });
  }

  if (req.completedAt || req.completed_at) {
    events.push({
      timestamp: req.completedAt || req.completed_at,
      event: 'request.completed',
      status: 'complete',
    });
  }

  if (req.failedAt || req.failed_at) {
    events.push({
      timestamp: req.failedAt || req.failed_at,
      event: 'request.failed',
      error: req.lastError || req.last_error || null,
      status: 'error',
    });
  }

  return events.sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
  });
}

function buildProviderAttempts(req) {
  const attempts = [];

  // TorBox attempts
  if (req.torboxAttempts || req.torbox_attempts) {
    for (const attempt of (req.torboxAttempts || req.torbox_attempts || [])) {
      attempts.push({
        provider: 'torbox',
        timestamp: attempt.timestamp || attempt.createdAt,
        operation: attempt.operation || attempt.type,
        success: attempt.success ?? null,
        error: attempt.error || null,
      });
    }
  }

  // Generic provider attempts
  if (req.providerAttempts || req.provider_attempts) {
    for (const attempt of (req.providerAttempts || req.provider_attempts || [])) {
      attempts.push({
        provider: attempt.provider || req.provider,
        timestamp: attempt.timestamp || attempt.createdAt,
        operation: attempt.operation || attempt.type,
        success: attempt.success ?? null,
        error: attempt.error || null,
      });
    }
  }

  return attempts;
}

function projectLifecycle(req) {
  const milestones = [
    'requested',
    'checked',
    'placed',
    'provider-ready',
    'exposed',
    'exact-file-mapped',
    'bound',
    'cataloged',
    'playable',
  ];

  const projection = {};
  for (const milestone of milestones) {
    const event = req.lifecycleEvents?.[milestone]
      || req.lifecycle_events?.[milestone]
      || req[`${milestone}At`]
      || req[`${milestone}_at`];
    projection[milestone] = event ? { status: 'reached', timestamp: event } : null;
  }

  return projection;
}

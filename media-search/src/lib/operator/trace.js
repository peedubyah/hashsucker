/**
 * Operator trace utilities — build timeline representations of request lifecycle.
 */

/**
 * Build a timeline from a request object.
 * Returns ordered events with timestamp, label, and status.
 */
export function getTraceLog(found) {
  const req = found.request || {};
  const events = [];

  // Creation
  if (req.createdAt || req.created_at) {
    events.push({
      timestamp: req.createdAt || req.created_at,
      label: 'Request created',
      status: 'complete',
    });
  }

  // Handoff
  if (req.handoffId || req.handoff_id) {
    events.push({
      timestamp: req.handoffCreatedAt || req.createdAt || req.created_at,
      label: 'Handoff created',
      status: 'complete',
    });
  }

  // Provider assignment
  if (req.provider) {
    events.push({
      timestamp: req.providerAssignedAt || req.createdAt || req.created_at,
      label: `${req.provider} assigned`,
      status: 'complete',
    });
  }

  // Processing stages
  if (req.processingStartedAt || req.processing_started_at) {
    events.push({
      timestamp: req.processingStartedAt || req.processing_started_at,
      label: 'Processing started',
      status: 'complete',
    });
  }

  // TorBox stages
  if (req.torboxId || req.torbox_id) {
    events.push({
      timestamp: req.torboxResolvedAt || req.processingStartedAt || req.processing_started_at,
      label: 'TorBox torrent resolved',
      status: 'complete',
    });
  }

  if (req.cacheCheckedAt || req.cache_checked_at) {
    events.push({
      timestamp: req.cacheCheckedAt || req.cache_checked_at,
      label: req.cacheHit ? 'Cache hit' : 'Cache miss',
      status: 'complete',
    });
  }

  if (req.strmCreatedAt || req.strm_created_at) {
    events.push({
      timestamp: req.strmCreatedAt || req.strm_created_at,
      label: 'STRM generated',
      status: 'complete',
    });
  }

  // Terminal states
  if (found.status === 'done') {
    events.push({
      timestamp: req.completedAt || req.completed_at || req.updatedAt || req.updated_at,
      label: 'Complete',
      status: 'complete',
    });
  } else if (found.status === 'failed') {
    events.push({
      timestamp: req.failedAt || req.failed_at || req.updatedAt || req.updated_at,
      label: `Failed: ${req.lastError || req.last_error || 'unknown error'}`,
      status: 'error',
    });
  } else if (found.status === 'processing') {
    events.push({
      timestamp: req.updatedAt || req.updated_at,
      label: 'In progress',
      status: 'active',
    });
  } else if (found.status === 'queued') {
    events.push({
      timestamp: req.createdAt || req.created_at,
      label: 'Waiting in queue',
      status: 'pending',
    });
  }

  // Sort by timestamp
  events.sort((a, b) => {
    if (!a.timestamp) return 1;
    if (!b.timestamp) return -1;
    return a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0;
  });

  return {
    current: {
      state: found.status,
      owner: req.provider || null,
      nextAction: getNextAction(found),
    },
    timeline: events,
  };
}

function getNextAction(found) {
  const req = found.request || {};
  switch (found.status) {
    case 'queued':
      return 'Waiting for worker pickup';
    case 'processing':
      if (!req.torboxId && !req.torbox_id) return 'Resolving TorBox torrent';
      if (!req.cacheCheckedAt && !req.cache_checked_at) return 'Checking TorBox cache';
      if (!req.strmCreatedAt && !req.strm_created_at) return 'Generating STRM';
      return 'Continuing processing';
    case 'failed':
      return 'Awaiting retry or deletion';
    case 'done':
      return 'Complete';
    default:
      return 'Unknown';
  }
}

export const LIFECYCLE_MILESTONES = Object.freeze([
  'requested',
  'checked',
  'placed',
  'provider-ready',
  'exposed',
  'exact-file-mapped',
  'bound',
  'cataloged',
  'playable',
]);

export const LIFECYCLE_STATUSES = Object.freeze([
  'pending',
  'satisfied',
  'degraded',
  'failed',
  'unknown',
]);

const MILESTONE_SET = new Set(LIFECYCLE_MILESTONES);
const STATUS_SET = new Set(LIFECYCLE_STATUSES);

export function createLifecycleEvent(input, { now = Date.now() } = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('Lifecycle event is required');
  const milestone = input.milestone;
  const status = input.status;
  if (!MILESTONE_SET.has(milestone)) throw new TypeError(`Unsupported lifecycle milestone: ${milestone}`);
  if (!STATUS_SET.has(status)) throw new TypeError(`Unsupported lifecycle status: ${status}`);
  if (!Number.isSafeInteger(input.occurredAt ?? now) || (input.occurredAt ?? now) < 0) {
    throw new TypeError('occurredAt must be a non-negative millisecond timestamp');
  }
  if (status === 'failed' && !input.failureCategory) {
    throw new TypeError('Failed lifecycle events require failureCategory');
  }

  return Object.freeze({
    libraryItemId: requireString(input.libraryItemId, 'libraryItemId'),
    milestone,
    status,
    occurredAt: input.occurredAt ?? now,
    failureCategory: optionalString(input.failureCategory, 'failureCategory'),
    retryable: input.retryable == null ? null : Boolean(input.retryable),
    retryAfterMs: optionalInteger(input.retryAfterMs, 'retryAfterMs'),
    source: requireString(input.source, 'source'),
    reason: optionalString(input.reason, 'reason', 1000),
    evidence: input.evidence ?? null,
    correlationId: optionalString(input.correlationId, 'correlationId'),
  });
}

export function projectLifecycle(events) {
  const projection = Object.fromEntries(
    LIFECYCLE_MILESTONES.map((milestone) => [milestone, null]),
  );
  for (const event of events) {
    const current = projection[event.milestone];
    if (!current || event.occurredAt > current.occurredAt || (
      event.occurredAt === current.occurredAt && (event.id ?? 0) > (current.id ?? 0)
    )) {
      projection[event.milestone] = event;
    }
  }
  return projection;
}

function requireString(value, field, max = 256) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function optionalString(value, field, max = 256) {
  return value == null ? null : requireString(value, field, max);
}

function optionalInteger(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

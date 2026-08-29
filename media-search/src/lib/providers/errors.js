export const PROVIDER_ERROR_CATEGORIES = Object.freeze([
  'authentication',
  'authorization',
  'rate-limit',
  'timeout',
  'network',
  'not-found',
  'conflict',
  'invalid-request',
  'invalid-response',
  'temporarily-unavailable',
  'unsupported',
  'unsafe-operation',
  'infringing',
  'unknown',
]);

const ERROR_CATEGORY_SET = new Set(PROVIDER_ERROR_CATEGORIES);
const RETRYABLE_CATEGORIES = new Set([
  'rate-limit',
  'timeout',
  'network',
  'conflict',
  'temporarily-unavailable',
]);

export function isProviderErrorCategory(value) {
  return ERROR_CATEGORY_SET.has(value);
}

export class ProviderOperationError extends Error {
  constructor(message, options = {}) {
    const {
      provider = null,
      operation = null,
      category = 'unknown',
      retryable = RETRYABLE_CATEGORIES.has(category),
      retryAfterMs = null,
      rateLimit = null,
      cause,
    } = options;

    if (!isProviderErrorCategory(category)) {
      throw new TypeError(`Unsupported provider error category: ${category}`);
    }

    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ProviderOperationError';
    this.provider = provider;
    this.operation = operation;
    this.category = category;
    this.retryable = Boolean(retryable);
    this.retryAfterMs = normalizeNonNegativeInteger(retryAfterMs, 'retryAfterMs');
    this.rateLimit = normalizeRateLimit(rateLimit);
  }
}

export function classifyProviderError(error, context = {}) {
  if (error instanceof ProviderOperationError) return error;

  const status = Number(error?.status ?? error?.statusCode);
  const code = String(error?.code || '').toUpperCase();
  const name = String(error?.name || '');
  const message = String(error?.message || 'Provider operation failed');

  let category = 'unknown';
  if (status === 401 || code === 'BAD_TOKEN' || code === 'AUTH_ERROR') category = 'authentication';
  else if (status === 403) category = 'authorization';
  else if (status === 429 || code === 'RATE_LIMITED') category = 'rate-limit';
  else if (status === 404 || code === 'NOT_CACHED') category = 'not-found';
  else if (status === 409) category = 'conflict';
  else if (status >= 400 && status < 500) category = 'invalid-request';
  else if (status >= 500) category = 'temporarily-unavailable';
  else if (name === 'TimeoutError' || name === 'AbortError' || code === 'ETIMEDOUT') category = 'timeout';
  else if (['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) category = 'network';
  else if (error instanceof SyntaxError) category = 'invalid-response';
  else if (code === 'MALFORMED_RESPONSE') category = 'invalid-response';

  return new ProviderOperationError(message, {
    ...context,
    category,
    retryable: RETRYABLE_CATEGORIES.has(category),
    retryAfterMs: error?.retryAfterMs ?? null,
    rateLimit: error?.rateLimit ?? null,
    cause: error,
  });
}

function normalizeNonNegativeInteger(value, field) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer or null`);
  }
  return value;
}

function normalizeRateLimit(value) {
  if (value == null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('rateLimit must be an object or null');
  }

  return Object.freeze({
    limit: normalizeNonNegativeInteger(value.limit, 'rateLimit.limit'),
    remaining: normalizeNonNegativeInteger(value.remaining, 'rateLimit.remaining'),
    resetAt: normalizeNonNegativeInteger(value.resetAt, 'rateLimit.resetAt'),
  });
}

/**
 * Request-path performance trace (measurement instrument).
 *
 * A strictly diagnostic, env-gated seam used to attribute a request →
 * Binding latency tail to named operations. It is OFF by default
 * (`HASHSUCKER_PERF_TRACE` unset) and, when off, every helper here is a
 * no-op that returns its argument untouched.
 *
 * When enabled:
 *   - one JSON line per instrumented operation on stdout:
 *       [perf] {"rid":"r-…","mediaId":"tt…","n":"ensure","t":1730…,"ms":812}
 *   - every line carries the request correlation id (`rid`) and the media
 *     identity, so a tail can be reconstructed from container logs alone.
 *
 * The correlation context is carried with AsyncLocalStorage, so it follows
 * the real async control flow of the request without threading a parameter
 * through every production function signature.
 *
 * This module NEVER changes behavior: it only measures.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const ENABLED = process.env.HASHSUCKER_PERF_TRACE === '1';

const storage = new AsyncLocalStorage();

export const PERF_TRACE_ENABLED = ENABLED;

/**
 * Run `fn` inside a trace context. The context is inherited by every
 * async continuation of `fn`.
 *
 * @template T
 * @param {{rid: string, mediaId?: string|null}} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function runPerfTrace(ctx, fn) {
  if (!ENABLED) return fn();
  return storage.run({ rid: ctx.rid, mediaId: ctx.mediaId ?? null }, fn);
}

/** Current trace context (empty outside a traced request). */
export function perfTraceContext() {
  return storage.getStore() ?? {};
}

/**
 * Emit one structured trace line. Never throws.
 *
 * @param {string} name dotted operation name
 * @param {Object} [fields] flat JSON-safe fields
 */
export function perfTrace(name, fields = {}) {
  if (!ENABLED) return;
  try {
    const ctx = storage.getStore();
    console.log(`[perf] ${JSON.stringify({
      rid: ctx?.rid ?? null,
      mediaId: ctx?.mediaId ?? null,
      n: name,
      t: Date.now(),
      ...fields,
    })}`);
  } catch {
    // Observability must never break the request path.
  }
}

/**
 * Time an async operation and emit `<name>.ok` / `<name>.err`.
 * The resolved value (or thrown error) is passed through unchanged.
 *
 * @template T
 * @param {string} name
 * @param {Object|(() => Object)} fields
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function perfTraceAsync(name, fields, fn) {
  if (!ENABLED) return fn();
  const startedAt = Date.now();
  const resolveFields = typeof fields === 'function' ? fields : () => fields;
  try {
    const result = await fn();
    perfTrace(`${name}.ok`, { ...resolveFields(), ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    perfTrace(`${name}.err`, {
      ...resolveFields(),
      ms: Date.now() - startedAt,
      err: String(error?.message ?? error),
    });
    throw error;
  }
}

/**
 * Time a synchronous operation and emit `<name>.ok` / `<name>.err`.
 *
 * @template T
 * @param {string} name
 * @param {Object|(() => Object)} fields
 * @param {() => T} fn
 * @returns {T}
 */
export function perfTraceSync(name, fields, fn) {
  if (!ENABLED) return fn();
  const startedAt = Date.now();
  const resolveFields = typeof fields === 'function' ? fields : () => fields;
  try {
    const result = fn();
    perfTrace(`${name}.ok`, { ...resolveFields(), ms: Date.now() - startedAt });
    return result;
  } catch (error) {
    perfTrace(`${name}.err`, {
      ...resolveFields(),
      ms: Date.now() - startedAt,
      err: String(error?.message ?? error),
    });
    throw error;
  }
}

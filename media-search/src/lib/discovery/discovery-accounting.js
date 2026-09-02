/**
 * Discovery Accounting Registry — bounded, secret-free, in-process.
 *
 * Slice 2.9 — Live discovery work accounting exposure.
 *
 * Purpose:
 *   Aggregate per-source live discovery work (Stremio addons, Torznab
 *   indexers) into a single, stable operator/debug surface so a canary
 *   can assert how many external HTTP calls were made for a given
 *   request envelope, and how many candidates each source returned.
 *
 * Design:
 *   - Process-wide singleton. The aggregate counter survives across
 *     requests, playback sessions, canary runs, and operator inspections.
 *   - Bounded in-process. No external services. No persistence.
 *   - secret-free: source names are operator-assigned identifiers
 *     (e.g. "torrentio-torbox", "comet-realdebrid", "torznab.0"). No
 *     URLs, no API keys, no addon credentials, no authorization
 *     headers. The /api/debug/discovery-accounting endpoint MUST
 *     remain safe to expose.
 *   - `reset()` returns the registry to zero. No process restart
 *     required.
 *
 * Source identifiers are operator-defined. The discovery paths in
 * `src/lib/stremio/search.js` and `src/lib/torznab/torznab.js` add
 * them dynamically. Unknown sources are recorded under the literal
 * key, so a misnamed source still surfaces — but the operator can
 * identify the misconfiguration in the snapshot.
 *
 * Per-source counters:
 *   - requests:  number of HTTP calls the source has served.
 *   - candidates: number of candidates the source returned (post-filter).
 *   - errors:    number of HTTP / parse / abort errors for the source.
 *
 * Use:
 *   import { discoveryAccounting } from './discovery-accounting.js';
 *   discoveryAccounting.recordRequest('torrentio-torbox');
 *   discoveryAccounting.recordCandidates('torrentio-torbox', 12);
 *   discoveryAccounting.recordError('torrentio-torbox');
 *   const snap = discoveryAccounting.snapshot();
 *   discoveryAccounting.reset();
 */

const DEFAULT_KNOWN_SOURCES = Object.freeze([
  'torrentio-torbox',
  'torrentio-realdebrid',
  'comet-torbox',
  'comet-realdebrid',
  'comet-manual',
  'torznab',
]);

function emptySource() {
  return Object.freeze({
    requests: 0,
    candidates: 0,
    errors: 0,
  });
}

function emptySnapshot() {
  const sources = {};
  for (const s of DEFAULT_KNOWN_SOURCES) sources[s] = emptySource();
  return Object.freeze({
    timestamp: Date.now(),
    sources: Object.freeze(sources),
  });
}

function safeCopy(snapshot) {
  const sources = {};
  for (const [name, counter] of Object.entries(snapshot.sources)) {
    sources[name] = Object.freeze({
      requests: Number(counter.requests) || 0,
      candidates: Number(counter.candidates) || 0,
      errors: Number(counter.errors) || 0,
    });
  }
  return Object.freeze({
    timestamp: snapshot.timestamp,
    sources: Object.freeze(sources),
  });
}

function safeSourceKey(name) {
  // Reject anything that could leak a credential / URL. Allowed
  // characters: lowercase letters, digits, dot, dash, underscore.
  // Length cap: 64.
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (trimmed.length > 64) return null;
  if (!/^[a-z0-9._-]+$/.test(trimmed)) return null;
  return trimmed;
}

class DiscoveryAccounting {
  constructor() {
    this._state = emptySnapshot();
  }

  _ensureSource(name) {
    const key = safeSourceKey(name) || 'unknown';
    if (this._state.sources[key]) return key;
    // New source — extend the snapshot.
    const next = { ...this._state.sources };
    next[key] = emptySource();
    this._state = Object.freeze({
      timestamp: Date.now(),
      sources: Object.freeze(next),
    });
    return key;
  }

  _set(name, field, delta) {
    if (!Number.isInteger(delta) || delta < 0) {
      throw new TypeError('counter delta must be a non-negative integer');
    }
    const key = this._ensureSource(name);
    const next = { ...this._state.sources };
    next[key] = Object.freeze({
      ...this._state.sources[key],
      [field]: (this._state.sources[key][field] || 0) + delta,
    });
    this._state = Object.freeze({
      timestamp: Date.now(),
      sources: Object.freeze(next),
    });
  }

  /**
   * Increment the per-source request counter by 1.
   */
  recordRequest(name) {
    this._set(name, 'requests', 1);
  }

  /**
   * Increment the per-source candidates counter. `count` may be > 1
   * to record multiple candidates in one call.
   */
  recordCandidates(name, count = 1) {
    if (!Number.isInteger(count) || count < 0) {
      throw new TypeError('recordCandidates count must be a non-negative integer');
    }
    if (count === 0) return;
    this._set(name, 'candidates', count);
  }

  /**
   * Increment the per-source error counter by 1.
   */
  recordError(name) {
    this._set(name, 'errors', 1);
  }

  /**
   * Read-only snapshot. Always includes every known source plus
   * any dynamically-added source, even when zero.
   */
  snapshot() {
    return safeCopy(this._state);
  }

  /**
   * Compute the per-source delta between `current` and `before`.
   *   delta = current - before
   * Negative deltas are clamped to zero.
   */
  delta(before) {
    if (!before || typeof before !== 'object') {
      throw new TypeError('delta requires a prior snapshot');
    }
    const beforeBySource = before.sources || {};
    const sources = {};
    // Union of keys — current and before.
    const allKeys = new Set([
      ...Object.keys(this._state.sources),
      ...Object.keys(beforeBySource),
    ]);
    for (const key of allKeys) {
      const c = this._state.sources[key] || emptySource();
      const b = beforeBySource[key] || emptySource();
      sources[key] = Object.freeze({
        requests: Math.max(0, c.requests - b.requests),
        candidates: Math.max(0, c.candidates - b.candidates),
        errors: Math.max(0, c.errors - b.errors),
      });
    }
    return Object.freeze({
      timestamp: this._state.timestamp,
      sources: Object.freeze(sources),
    });
  }

  /**
   * Zero the registry. Returns the previous snapshot for caller-side
   * assertion bookkeeping.
   */
  reset() {
    const previous = safeCopy(this._state);
    this._state = emptySnapshot();
    return previous;
  }

  /**
   * List of known default sources. Operators may consult this when
   * rendering the registry.
   */
  knownSources() {
    return DEFAULT_KNOWN_SOURCES.slice();
  }
}

// Module-level singleton. Every import in the process shares the
// same accounting state. Tests that need isolation can call
// `.reset()` in setup/teardown.
export const discoveryAccounting = new DiscoveryAccounting();

/**
 * Format a snapshot for terminal/canary output. Intentionally
 * compact and secret-free. Only renders sources that have at least
 * one non-zero counter (or all known sources if `showAll` is true).
 *
 * @param {Object} snapshot
 * @param {Object} [options]
 * @param {string} [options.title]  e.g. "Live Discovery"
 * @param {boolean} [options.showAll]  render known sources even when zero
 */
export function formatDiscoveryAccounting(snapshot, { title, showAll = false } = {}) {
  if (!snapshot || !snapshot.sources) {
    return `${title || 'Discovery Accounting'}:\n  (no data)\n`;
  }
  const lines = [];
  lines.push(`${title || 'Discovery Accounting'}:`);
  const entries = Object.entries(snapshot.sources);
  // Stable ordering: known sources first, then by name.
  entries.sort(([a], [b]) => a.localeCompare(b));
  for (const [name, counter] of entries) {
    if (!showAll
      && counter.requests === 0
      && counter.candidates === 0
      && counter.errors === 0) {
      continue;
    }
    lines.push(`  ${name}: requests=${counter.requests} candidates=${counter.candidates} errors=${counter.errors}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Secret-stripping guard. Returns true if every value in the
 * snapshot is a non-negative integer (or string matching the safe
 * source-name pattern).
 */
export function isSecretFreeDiscoveryValue(value) {
  if (value == null) return true;
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) return false;
    return true;
  }
  if (typeof value === 'string') {
    return /^[a-z0-9._:-]{0,64}$/i.test(value);
  }
  if (Array.isArray(value)) {
    return value.every(isSecretFreeDiscoveryValue);
  }
  if (typeof value === 'object') {
    return Object.values(value).every(isSecretFreeDiscoveryValue);
  }
  return false;
}

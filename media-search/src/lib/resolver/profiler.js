/**
 * Resolver Stage Profiler
 *
 * Non-blocking profiler for the /stream/:type/:id resolver endpoint.
 * Captures duration of each resolution stage for latency analysis.
 *
 * Invariants:
 *   - Fail-safe: profiling errors never block resolution
 *   - Zero-cost when disabled (no overhead)
 *   - Does not log provider URLs or credentials
 *   - Used for latency diagnosis only
 */

/**
 * Create a profiler instance for a single resolver request.
 * @param {Object} options
 * @param {Function} options.now - Clock function (defaults to Date.now)
 * @returns {Profiler} Profiler instance
 */
export function createResolverProfiler({ now = () => Date.now() } = {}) {
  const stages = new Map();
  let startTime = null;
  // Check at creation time (per request) — not module load time
  const enabled = process.env.RESOLVER_PROFILE === '1';

  return {
    /**
     * Mark the start of the resolver request.
     */
    start() {
      if (!enabled) return;
      startTime = now();
    },

    /**
     * Mark the end of a stage and record its duration.
     * @param {string} stageName - Name of the stage
     */
    mark(stageName) {
      if (!enabled) return;
      const timestamp = now();
      const relativeMs = startTime != null ? timestamp - startTime : null;
      stages.set(stageName, { timestamp, relativeMs });
      console.log(`[resolver-profile] ${stageName}: ${relativeMs}ms`);
    },

    /**
     * Record a stage with an explicit duration.
     * @param {string} stageName - Name of the stage
     * @param {number} durationMs - Duration in milliseconds
     */
    record(stageName, durationMs) {
      if (!enabled) return;
      stages.set(stageName, { timestamp: now(), relativeMs: durationMs });
      console.log(`[resolver-profile] ${stageName}: ${durationMs}ms`);
    },

    /**
     * Get the timing summary for all recorded stages.
     * @returns {Object} Summary with total and per-stage durations
     */
    summary() {
      if (!enabled) return { enabled: false };
      const result = { enabled: true, stages: {} };
      let lastTimestamp = startTime;
      for (const [name, data] of stages) {
        result.stages[name] = data.relativeMs;
        lastTimestamp = data.timestamp;
      }
      if (startTime != null && lastTimestamp != null) {
        result.totalMs = lastTimestamp - startTime;
      }
      return result;
    },

    /**
     * Check if profiling is enabled.
     * @returns {boolean}
     */
    isEnabled() {
      return enabled;
    },
  };
}

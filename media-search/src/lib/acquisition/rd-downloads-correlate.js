/**
 * RD /downloads correlation analysis.
 *
 * Produces a deterministic, evidence-based correlation between the raw
 * RD /downloads observations and the existing HashSucker candidate
 * corpus. The output is a HYPOTHESIS, never identity. The correlation
 * is rebuilt from scratch on each run — it is a pure function of
 * (observations, candidates) state.
 *
 * Hard rules (per the slice spec):
 *   - Exact filename alone is NOT Release identity.
 *   - Exact bytes alone is NOT Release identity.
 *   - Filename + exact bytes + matching parsed attributes may create
 *     a strong correlation hypothesis, but never
 *     historical_provider_evidence.
 *   - If one RD download event maps to multiple plausible Releases,
 *     preserve the ambiguity. Do not choose whichever candidate
 *     currently ranks first.
 *   - Title-only weak matches never reach UNIQUE_STRONG.
 *   - Wrong-episode matches are rejected by hard gate.
 *   - Correlation must be deterministic for fixed DB state.
 *
 * Correlation classes:
 *   UNIQUE_STRONG       — exactly one plausible candidate matches
 *                         on hard-gate + exact filename + exact bytes
 *                         (+ matching parsed attributes where
 *                         available). The correlation row is
 *                         written; the score is high.
 *   MULTIPLE_PLAUSIBLE  — multiple plausible candidates match. ALL
 *                         are written (the table preserves
 *                         ambiguity); the row's ambiguity_count is
 *                         the candidate count. NEVER collapsed to
 *                         UNIQUE_STRONG.
 *   WEAK                — soft-match only (e.g. title-only, low
 *                         parser confidence, missing hard gate).
 *                         Written for analysis. Not safe to feed
 *                         into ranking.
 *   UNMATCHED           — no candidate matches the available
 *                         evidence. Written for completeness
 *                         (so the analysis can show what fraction
 *                         of the 2.22 TB history is unexplained).
 *
 * IMPORTANT: This module does NOT write to historical_provider_evidence,
 * does NOT call into ranking, and does NOT change runtime behavior.
 * It is a pure read-mostly analysis that writes the
 * rd_download_correlations table only.
 */

import { parseFilename } from '../discovery/parser-adapter.js';

export const CORRELATION_CLASSES = Object.freeze({
  UNIQUE_STRONG: 'UNIQUE_STRONG',
  MULTIPLE_PLAUSIBLE: 'MULTIPLE_PLAUSIBLE',
  WEAK: 'WEAK',
  UNMATCHED: 'UNMATCHED',
});

// Threshold for "plausible" filename/bytes match
const PARSER_CONFIDENCE_FLOOR = 0.30;
// Threshold below which we refuse to call a multi-attribute match
// UNIQUE_STRONG (must have at least title + one strong attribute)
const STRONG_MATCH_CONFIDENCE_FLOOR = 0.50;

// ============================================================================
// Candidate index (pure data structure)
// ============================================================================

/**
 * Build a deterministic in-memory index of the candidates table.
 *
 * @param {Array} candidates  Raw rows from selectAllCandidatesStmt
 * @returns {{
 *   byInfoHash: Map<string, Array<object>>,
 *   bySearchKey: Map<string, Array<object>>,
 *   total: number
 * }}
 */
export function buildCandidateIndex(candidates) {
  const byInfoHash = new Map();
  const bySearchKey = new Map();
  for (const c of candidates) {
    if (!byInfoHash.has(c.info_hash)) byInfoHash.set(c.info_hash, []);
    byInfoHash.get(c.info_hash).push(c);
    if (c.search_key) {
      if (!bySearchKey.has(c.search_key)) bySearchKey.set(c.search_key, []);
      bySearchKey.get(c.search_key).push(c);
    }
  }
  return { byInfoHash, bySearchKey, total: candidates.length };
}

// ============================================================================
// Hard gates
// ============================================================================

/**
 * Test the hard gate between an observation and a candidate.
 *
 * Returns null when the candidate is rejected (wrong episode / wrong
 * season / wrong year).
 *
 * @param {object} obs       Normalized /downloads row
 * @param {object} candidate Candidate row (info_hash, file_index_key,
 *                           search_key, title, filename, etc.)
 * @returns {object|null}    { reasons: string[] } when the hard
 *                           gate passes, or null when it fails.
 */
export function passesHardGate(obs, candidate) {
  const reasons = [];
  // Episode-level gate (TV): if the observation names a specific
  // episode and the candidate's search_key names a different
  // episode, reject.
  if (Number.isSafeInteger(obs.season) && Number.isSafeInteger(obs.episode)) {
    const sk = String(candidate.search_key || '').toLowerCase();
    // Find the candidate's S/E markers (if any). We only reject
    // when the candidate names an episode that disagrees with
    // the observation. If the candidate does not name an episode
    // (e.g. it is a season-pack), the gate is permissive.
    const re = /s(\d{1,2})e(\d{1,2})/g;
    let m;
    let candNamesEpisode = false;
    while ((m = re.exec(sk)) !== null) {
      candNamesEpisode = true;
      const candSeason = Number(m[1]);
      const candEpisode = Number(m[2]);
      if (candSeason !== obs.season || candEpisode !== obs.episode) {
        return null; // disagrees — reject
      }
    }
    if (candNamesEpisode) {
      reasons.push(`hard-gate:episode=s${obs.season}e${obs.episode}`);
    }
  } else if (Number.isSafeInteger(obs.season)) {
    // Season-only observation: episode is wildcard.
    const sk = String(candidate.search_key || '').toLowerCase();
    const re = /s(\d{1,2})(?:e\d{1,2})?/g;
    let m;
    while ((m = re.exec(sk)) !== null) {
      const candSeason = Number(m[1]);
      if (candSeason !== obs.season) {
        return null;
      }
    }
    reasons.push(`hard-gate:season=${obs.season}`);
  } else if (Number.isSafeInteger(obs.parsed_year)) {
    // Movie-level gate: if the candidate's search_key explicitly
    // names a year, it must match.
    const sk = String(candidate.search_key || '').toLowerCase();
    const re = /\b((?:19|20)\d{2})\b/g;
    let m;
    let yearOnCandidate = null;
    while ((m = re.exec(sk)) !== null) {
      yearOnCandidate = Number(m[1]);
      if (yearOnCandidate !== obs.parsed_year) {
        return null;
      }
    }
    if (yearOnCandidate != null) {
      reasons.push(`hard-gate:year=${obs.parsed_year}`);
    }
  }
  return { reasons };
}

// ============================================================================
// Score calculation
// ============================================================================

/**
 * Score a (observation, candidate) pair.
 *
 * @param {object} obs
 * @param {object} candidate
 * @returns {{
 *   score: number,
 *   reasons: string[],
 *   featureCounts: { exactFilename: number, exactBytes: number,
 *                    releaseGroup: number, resolution: number,
 *                    codec: number, sourceType: number,
 *                    hardGate: number }
 * }}
 */
export function scoreMatch(obs, candidate) {
  const reasons = [];
  const fc = {
    exactFilename: 0,
    exactBytes: 0,
    releaseGroup: 0,
    resolution: 0,
    codec: 0,
    sourceType: 0,
    hardGate: 0,
  };

  // Hard gate contributes a fixed +0.2 (it is required, not optional)
  const gate = passesHardGate(obs, candidate);
  if (gate) {
    fc.hardGate = 1;
    reasons.push(...gate.reasons);
  } else {
    // Failed hard gate -> score 0, return early
    return { score: 0, reasons: ['hard-gate:FAIL'], featureCounts: fc };
  }

  let score = 0.20; // hard-gate baseline

  // Exact filename on the candidate's own filename column
  if (candidate.filename && typeof candidate.filename === 'string'
      && candidate.filename.trim().toLowerCase() === obs.normalized_filename) {
    fc.exactFilename = 1;
    score += 0.40;
    reasons.push('exact:filename');
  }

  // Exact byte-size match
  if (Number.isSafeInteger(candidate.size)
      && Number.isSafeInteger(obs.exact_bytes)
      && candidate.size === obs.exact_bytes) {
    fc.exactBytes = 1;
    score += 0.20;
    reasons.push(`exact:bytes=${obs.exact_bytes}`);
  }

  // Release group match
  if (obs.release_group && candidate.filename
      && typeof candidate.filename === 'string') {
    const candFilename = candidate.filename.toLowerCase();
    if (candFilename.includes(String(obs.release_group).toLowerCase())) {
      fc.releaseGroup = 1;
      score += 0.10;
      reasons.push(`match:release_group=${obs.release_group}`);
    }
  }

  // Resolution match
  if (obs.resolution && candidate.filename
      && typeof candidate.filename === 'string'
      && candidate.filename.toLowerCase().includes(String(obs.resolution).toLowerCase())) {
    fc.resolution = 1;
    score += 0.05;
    reasons.push(`match:resolution=${obs.resolution}`);
  }

  // Codec match
  if (obs.codec && candidate.filename
      && typeof candidate.filename === 'string'
      && candidate.filename.toLowerCase().includes(String(obs.codec).toLowerCase())) {
    fc.codec = 1;
    score += 0.05;
    reasons.push(`match:codec=${obs.codec}`);
  }

  // Source-type match
  if (obs.source_type && candidate.filename
      && typeof candidate.filename === 'string') {
    const st = String(obs.source_type).toLowerCase().replace(/[\s-]+/g, '');
    const candFilename = candidate.filename.toLowerCase().replace(/[\s-]+/g, '');
    if (candFilename.includes(st)) {
      fc.sourceType = 1;
      score += 0.05;
      reasons.push(`match:source_type=${obs.source_type}`);
    }
  }

  // Title similarity (normalized)
  if (obs.parsed_title && candidate.title
      && typeof candidate.title === 'string') {
    const ot = normalizeTitle(obs.parsed_title);
    const ct = normalizeTitle(candidate.title);
    if (ot && ct && (ot === ct || ct.includes(ot) || ot.includes(ct))) {
      score += 0.10;
      reasons.push(`title:similar=${obs.parsed_title}|${candidate.title}`);
    } else if (ot && ct) {
      // Partial title overlap (Jaccard)
      const j = jaccard(new Set(ot.split(/\s+/)), new Set(ct.split(/\s+/)));
      if (j >= 0.5) {
        score += 0.05;
        reasons.push(`title:partial jaccard=${j.toFixed(2)}`);
      }
    }
  }

  // Confident parse: if both obs and candidate appear to be the
  // same release, the parser confidence on the obs must be at
  // least the floor.
  if (obs.parser_confidence < PARSER_CONFIDENCE_FLOOR) {
    // Penalize but do not zero — UNIQUE_STRONG classification
    // requires a confident parse below.
    score = score * 0.5;
    reasons.push(`penalty:low_parser_confidence=${obs.parser_confidence}`);
  }

  return { score, reasons, featureCounts: fc };
}

function normalizeTitle(s) {
  return String(s || '').toLowerCase()
    .replace(/[._\-]+/g, ' ')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ============================================================================
// Main correlation
// ============================================================================

/**
 * @typedef {Object} CorrelateConfig
 * @property {Array} observations       Array of normalized /downloads rows
 * @property {Array} candidates        Array of raw candidate rows
 *                                      (info_hash, file_index_key,
 *                                       search_key, filename, title,
 *                                       size, ...)
 * @property {number} [strongFloor=0.7] Minimum score to be considered
 *                                      "plausible" for the
 *                                      UNIQUE_STRONG/MULTIPLE_PLAUSIBLE
 *                                      decision. A score below this
 *                                      is WEAK.
 */

/**
 * @typedef {Object} CorrelateResult
 * @property {Array}  correlations     Array of correlation rows ready to
 *                                     write to rd_download_correlations
 * @property {object} stats            Counts and bytes by class
 */

/**
 * Correlate a set of /downloads observations against the candidate corpus.
 *
 * Determinism: when `observations` and `candidates` are passed in a
 * stable order, the output is byte-identical across runs. The internal
 * candidate iteration order is the input order, and ties in score are
 * broken by (info_hash, file_index_key) lexical order.
 *
 * Performance: builds a title-token inverted index to avoid O(N*M)
 * comparison across the full corpus. Only candidates sharing at least
 * one title token with the observation are scored.
 *
 * @param {CorrelateConfig} config
 * @returns {CorrelateResult}
 */
export function correlateRdDownloads(config) {
  const { observations, candidates, strongFloor = 0.70 } = config;
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array');
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');

  const correlations = [];

  const stats = {
    rawEvents: observations.length,
    eventsByClass: { UNIQUE_STRONG: 0, MULTIPLE_PLAUSIBLE: 0, WEAK: 0, UNMATCHED: 0 },
    bytesByClass: { UNIQUE_STRONG: 0, MULTIPLE_PLAUSIBLE: 0, WEAK: 0, UNMATCHED: 0 },
    uniqueFileBytesGroups: 0,
    candidateHashCardinality: new Set(),
  };

  // Group observations by (normalized_filename, exact_bytes) to count
  // unique (filename, bytes) groups as the spec requires.
  const groupMap = new Map(); // key -> [observation indices]
  for (let i = 0; i < observations.length; i += 1) {
    const obs = observations[i];
    const key = `${obs.normalized_filename}\x00${obs.exact_bytes}`;
    if (!groupMap.has(key)) groupMap.set(key, []);
    groupMap.get(key).push(i);
  }
  stats.uniqueFileBytesGroups = groupMap.size;

  // Build a title-token inverted index over the candidate corpus.
  // For each token (word of the normalized filename), map to the
  // set of candidate indices that contain it. This enables O(1)
  // candidate prefiltering per observation instead of O(N) scan.
  const tokIndex = new Map(); // token -> Array<candidateIdx>
  for (let ci = 0; ci < candidates.length; ci += 1) {
    const c = candidates[ci];
    const tokens = normalizeTitle(c.filename || c.title || '').split(/\s+/).filter(Boolean);
    for (const tok of tokens) {
      if (!tokIndex.has(tok)) tokIndex.set(tok, []);
      tokIndex.get(tok).push(ci);
    }
  }

  for (const obs of observations) {
    // Get the observation's title tokens and prefilter the candidate
    // set to only those sharing at least one token. We use a Set to
    // dedupe the union of token postings.
    const obsTokens = normalizeTitle(obs.normalized_filename || '').split(/\s+/).filter(Boolean);
    const candidateSet = new Set();
    for (const tok of obsTokens) {
      const postings = tokIndex.get(tok);
      if (postings) {
        for (let i = 0; i < postings.length; i += 1) candidateSet.add(postings[i]);
      }
    }

    const scored = [];
    for (const idx of candidateSet) {
      const cand = candidates[idx];
      const { score, reasons } = scoreMatch(obs, cand);
      if (score > 0) {
        scored.push({
          info_hash: cand.info_hash,
          file_index_key: cand.file_index_key,
          score,
          reasons,
        });
      }
    }
    // Deterministic order: highest score first, tie-break by
    // (info_hash, file_index_key) lex.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.info_hash !== b.info_hash) return a.info_hash < b.info_hash ? -1 : 1;
      return a.file_index_key - b.file_index_key;
    });

    if (scored.length === 0) {
      // UNMATCHED: write a synthetic row with the observation's
      // evidence so the analysis can show what fraction is
      // unexplained.
      correlations.push({
        source_event_id: obs.source_event_id,
        rd_id: obs.rd_id,
        candidate_info_hash: '',
        candidate_file_index_key: -1,
        correlation_class: CORRELATION_CLASSES.UNMATCHED,
        correlation_score: 0,
        reasons_json: ['unmatched:no_candidate_passes_hard_gate'],
        ambiguity_count: 0,
        parsed_filename: obs.normalized_filename,
        exact_bytes: obs.exact_bytes,
        generated_at: obs.generated_at,
      });
      stats.eventsByClass.UNMATCHED += 1;
      stats.bytesByClass.UNMATCHED += obs.exact_bytes;
      continue;
    }

    // Strong-plausible threshold
    const plausible = scored.filter((s) => s.score >= strongFloor);
    if (plausible.length === 1
        && plausible[0].score >= STRONG_MATCH_CONFIDENCE_FLOOR
        && obs.parser_confidence >= PARSER_CONFIDENCE_FLOOR) {
      const p = plausible[0];
      correlations.push({
        source_event_id: obs.source_event_id,
        rd_id: obs.rd_id,
        candidate_info_hash: p.info_hash,
        candidate_file_index_key: p.file_index_key,
        correlation_class: CORRELATION_CLASSES.UNIQUE_STRONG,
        correlation_score: p.score,
        reasons_json: p.reasons,
        ambiguity_count: 1,
        parsed_filename: obs.normalized_filename,
        exact_bytes: obs.exact_bytes,
        generated_at: obs.generated_at,
      });
      stats.eventsByClass.UNIQUE_STRONG += 1;
      stats.bytesByClass.UNIQUE_STRONG += obs.exact_bytes;
      stats.candidateHashCardinality.add(p.info_hash);
    } else if (plausible.length > 1) {
      // MULTIPLE_PLAUSIBLE: write ALL plausible candidates
      for (const p of plausible) {
        correlations.push({
          source_event_id: obs.source_event_id,
          rd_id: obs.rd_id,
          candidate_info_hash: p.info_hash,
          candidate_file_index_key: p.file_index_key,
          correlation_class: CORRELATION_CLASSES.MULTIPLE_PLAUSIBLE,
          correlation_score: p.score,
          reasons_json: p.reasons,
          ambiguity_count: plausible.length,
          parsed_filename: obs.normalized_filename,
          exact_bytes: obs.exact_bytes,
          generated_at: obs.generated_at,
        });
        stats.candidateHashCardinality.add(p.info_hash);
      }
      // Count the event ONCE under MULTIPLE_PLAUSIBLE
      stats.eventsByClass.MULTIPLE_PLAUSIBLE += 1;
      stats.bytesByClass.MULTIPLE_PLAUSIBLE += obs.exact_bytes;
    } else {
      // WEAK: take the top scorer (single row) so the analysis can
      // see what fraction of the history would land here.
      const top = scored[0];
      correlations.push({
        source_event_id: obs.source_event_id,
        rd_id: obs.rd_id,
        candidate_info_hash: top.info_hash,
        candidate_file_index_key: top.file_index_key,
        correlation_class: CORRELATION_CLASSES.WEAK,
        correlation_score: top.score,
        reasons_json: top.reasons,
        ambiguity_count: scored.length,
        parsed_filename: obs.normalized_filename,
        exact_bytes: obs.exact_bytes,
        generated_at: obs.generated_at,
      });
      stats.eventsByClass.WEAK += 1;
      stats.bytesByClass.WEAK += obs.exact_bytes;
      stats.candidateHashCardinality.add(top.info_hash);
    }
  }

  return { correlations, stats: { ...stats, candidateHashCardinality: stats.candidateHashCardinality.size } };
}

// ============================================================================
// Per-group aggregation (for the analysis report)
// ============================================================================

/**
 * Group observations by (normalized_filename, exact_bytes) and emit a
 * class decision per group (not per event) — useful for the
 * "what fraction of the 2.22 TB history is explainable" report.
 *
 * A group is UNIQUE_STRONG iff all its observations have the same
 * UNIQUE_STRONG target; MULTIPLE_PLAUSIBLE iff at least one is
 * MULTIPLE_PLAUSIBLE; etc.
 *
 * @param {Array} correlations  Output of correlateRdDownloads
 * @param {Array} observations
 * @returns {Array<{ key, size, count, class, totalBytes }>}
 */
export function groupCorrelationsByFileBytes(correlations, observations) {
  // Build a lookup of (source_event_id -> observation) for totalBytes
  const obsByEventId = new Map();
  for (const o of observations) {
    obsByEventId.set(o.source_event_id, o);
  }
  // Group correlations by group-key
  const groups = new Map();
  for (const c of correlations) {
    if (!groups.has(c.source_event_id)) {
      groups.set(c.source_event_id, []);
    }
    groups.get(c.source_event_id).push(c);
  }
  // Aggregate by (filename, bytes)
  const aggregated = new Map();
  for (const [eventId, list] of groups.entries()) {
    const obs = obsByEventId.get(eventId);
    if (!obs) continue;
    const key = `${obs.normalized_filename}\x00${obs.exact_bytes}`;
    if (!aggregated.has(key)) {
      aggregated.set(key, {
        key,
        normalized_filename: obs.normalized_filename,
        exact_bytes: obs.exact_bytes,
        events: 0,
        totalBytes: 0,
        classes: { UNIQUE_STRONG: 0, MULTIPLE_PLAUSIBLE: 0, WEAK: 0, UNMATCHED: 0 },
        candidateHashes: new Set(),
      });
    }
    const g = aggregated.get(key);
    g.events += 1;
    g.totalBytes += obs.exact_bytes;
    g.classes[list[0].correlation_class] += 1;
    for (const c of list) {
      if (c.candidate_info_hash) g.candidateHashes.add(c.candidate_info_hash);
    }
  }
  return Array.from(aggregated.values()).map((g) => ({
    key: g.key,
    normalized_filename: g.normalized_filename,
    exact_bytes: g.exact_bytes,
    events: g.events,
    totalBytes: g.totalBytes,
    classes: g.classes,
    candidateHashCount: g.candidateHashes.size,
  }));
}

// ============================================================================
// Re-export parser for tests that need a deterministic parse
// ============================================================================

export { parseFilename };

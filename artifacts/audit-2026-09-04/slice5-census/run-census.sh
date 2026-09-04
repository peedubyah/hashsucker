#!/usr/bin/env bash
# Read-only production census for slice 5: provider evidence reconciliation.
# No mutations. Use with: bash slice5-census/run-census.sh

set -euo pipefail

DB="/home/patrick/hashsucker-data/discovery/discovery-cache.db"
OUT="/home/patrick/src/hashsucker/artifacts/audit-2026-09-04/slice5-census"
mkdir -p "$OUT"

# Safety: refuse if not the production DB path.
case "$DB" in
  /home/patrick/hashsucker-data/discovery/discovery-cache.db) ;;
  *) echo "Refusing to run against non-prod DB: $DB" >&2; exit 2 ;;
esac

# Read-only: open in read-only mode (-readonly) and run only SELECTs.
sqlite3 -readonly -header -column "$DB" <<SQL > "$OUT/census.txt" 2>&1
-- ============================================================
-- A. provider_observation_current (the per-(provider, scope, key) projection)
-- ============================================================
SELECT 'A.1' AS section, 'current_total' AS metric, COUNT(*) AS value FROM provider_observation_current
UNION ALL SELECT 'A.1', 'cached', COUNT(*) FROM provider_observation_current WHERE state = 'cached'
UNION ALL SELECT 'A.1', 'uncached', COUNT(*) FROM provider_observation_current WHERE state = 'uncached'
UNION ALL SELECT 'A.1', 'error', COUNT(*) FROM provider_observation_current WHERE state = 'error'
UNION ALL SELECT 'A.1', 'unknown', COUNT(*) FROM provider_observation_current WHERE state = 'unknown'
UNION ALL SELECT 'A.1', 'distinct_provider_scope_pairs', COUNT(DISTINCT provider || '|' || account_scope) FROM provider_observation_current
UNION ALL SELECT 'A.1', 'distinct_info_hashes', COUNT(DISTINCT info_hash) FROM provider_observation_current
UNION ALL SELECT 'A.1', 'null_account_scope', COUNT(*) FROM provider_observation_current WHERE account_scope IS NULL OR account_scope = ''
UNION ALL SELECT 'A.1', 'null_observed_at', COUNT(*) FROM provider_observation_current WHERE observed_at IS NULL
UNION ALL SELECT 'A.1', 'null_expires_at', COUNT(*) FROM provider_observation_current WHERE expires_at IS NULL
UNION ALL SELECT 'A.1', 'with_error_category', COUNT(*) FROM provider_observation_current WHERE error_category IS NOT NULL
UNION ALL SELECT 'A.1', 'durable_negatives_infringing', COUNT(*) FROM provider_observation_current WHERE state = 'uncached' AND error_category = 'infringing'
UNION ALL SELECT 'A.1', 'durable_negatives_unsupported', COUNT(*) FROM provider_observation_current WHERE state = 'uncached' AND error_category = 'unsupported'
UNION ALL SELECT 'A.1', 'transient_negatives', COUNT(*) FROM provider_observation_current WHERE state = 'uncached' AND error_category IS NULL;

-- ============================================================
-- B. provider_observation_events (append-only history)
-- ============================================================
SELECT 'A.2' AS section, 'events_total' AS metric, COUNT(*) AS value FROM provider_observation_events
UNION ALL SELECT 'A.2', 'cached_events', COUNT(*) FROM provider_observation_events WHERE state = 'cached'
UNION ALL SELECT 'A.2', 'uncached_events', COUNT(*) FROM provider_observation_events WHERE state = 'uncached'
UNION ALL SELECT 'A.2', 'error_events', COUNT(*) FROM provider_observation_events WHERE state = 'error'
UNION ALL SELECT 'A.2', 'unknown_events', COUNT(*) FROM provider_observation_events WHERE state = 'unknown'
UNION ALL SELECT 'A.2', 'distinct_provider_scope_pairs', COUNT(DISTINCT provider || '|' || account_scope) FROM provider_observation_events
UNION ALL SELECT 'A.2', 'distinct_info_hashes', COUNT(DISTINCT info_hash) FROM provider_observation_events
UNION ALL SELECT 'A.2', 'null_account_scope', COUNT(*) FROM provider_observation_events WHERE account_scope IS NULL OR account_scope = ''
UNION ALL SELECT 'A.2', 'null_observed_at', COUNT(*) FROM provider_observation_events WHERE observed_at IS NULL
UNION ALL SELECT 'A.2', 'null_expires_at', COUNT(*) FROM provider_observation_events WHERE expires_at IS NULL
UNION ALL SELECT 'A.2', 'null_recorded_at', COUNT(*) FROM provider_observation_events WHERE recorded_at IS NULL
UNION ALL SELECT 'A.2', 'events_with_error_category', COUNT(*) FROM provider_observation_events WHERE error_category IS NOT NULL
UNION ALL SELECT 'A.2', 'infringing_events', COUNT(*) FROM provider_observation_events WHERE error_category = 'infringing'
UNION ALL SELECT 'A.2', 'unsupported_events', COUNT(*) FROM provider_observation_events WHERE error_category = 'unsupported'
UNION ALL SELECT 'A.2', 'temporarily_unavailable_events', COUNT(*) FROM provider_observation_events WHERE error_category = 'temporarily-unavailable'
UNION ALL SELECT 'A.2', 'unknown_error_events', COUNT(*) FROM provider_observation_events WHERE error_category = 'unknown';

-- ============================================================
-- C. Contradiction detection (per spec D.1-D.8 / I)
-- ============================================================
SELECT 'A.3' AS section, 'candidates_with_history_contradictions' AS metric, COUNT(*) AS value FROM (
  SELECT info_hash, file_index_key, provider
  FROM provider_observation_events
  GROUP BY info_hash, file_index_key, provider
  HAVING COUNT(DISTINCT state) >= 2
)
UNION ALL SELECT 'A.3', 'candidates_with_current_contradiction_pairs', COUNT(*) FROM (
  -- current row says cached, event history says uncached (and vice versa)
  SELECT c.info_hash, c.file_index_key, c.provider
  FROM provider_observation_current c
  WHERE c.state = 'cached'
    AND EXISTS (SELECT 1 FROM provider_observation_events e
                WHERE e.info_hash = c.info_hash
                  AND e.file_index_key = c.file_index_key
                  AND e.provider = c.provider
                  AND e.state = 'uncached')
  UNION
  SELECT c.info_hash, c.file_index_key, c.provider
  FROM provider_observation_current c
  WHERE c.state = 'uncached'
    AND EXISTS (SELECT 1 FROM provider_observation_events e
                WHERE e.info_hash = c.info_hash
                  AND e.file_index_key = c.file_index_key
                  AND e.provider = c.provider
                  AND e.state = 'cached')
);

-- ============================================================
-- D. Top contradiction classes (current vs most recent event)
-- ============================================================
SELECT 'A.4' AS section, c.provider, c.state AS current_state,
       (SELECT e.state FROM provider_observation_events e
         WHERE e.info_hash = c.info_hash
           AND e.file_index_key = c.file_index_key
           AND e.provider = c.provider
         ORDER BY e.observed_at DESC, e.id DESC LIMIT 1) AS most_recent_event_state,
       COUNT(*) AS n
FROM provider_observation_current c
WHERE c.state != COALESCE(
  (SELECT e.state FROM provider_observation_events e
    WHERE e.info_hash = c.info_hash
      AND e.file_index_key = c.file_index_key
      AND e.provider = c.provider
    ORDER BY e.observed_at DESC, e.id DESC LIMIT 1), c.state)
GROUP BY c.provider, c.state
ORDER BY n DESC;

-- ============================================================
-- E. Per-provider/account_scope breakdown
-- ============================================================
SELECT 'A.5' AS section, provider, account_scope, state, COUNT(*) AS n
FROM provider_observation_current
GROUP BY provider, account_scope, state
ORDER BY provider, account_scope, state;

-- ============================================================
-- F. Repeated observation rate
-- ============================================================
SELECT 'A.6' AS section, 'repeats_per_hash' AS metric, ROUND(1.0 * (SELECT COUNT(*) FROM provider_observation_events) / (SELECT COUNT(DISTINCT info_hash) FROM provider_observation_events), 3) AS value
UNION ALL SELECT 'A.6', 'max_repeats_one_hash', MAX(c) FROM (SELECT COUNT(*) AS c FROM provider_observation_events GROUP BY info_hash);

-- ============================================================
-- G. Other evidence tables
-- ============================================================
SELECT 'A.7' AS section, 'historical_provider_evidence', COUNT(*) FROM historical_provider_evidence
UNION ALL SELECT 'A.7', 'historical_provider_evidence_sightings', COUNT(*) FROM historical_provider_evidence_sightings
UNION ALL SELECT 'A.7', 'rd_download_observations', COUNT(*) FROM rd_download_observations
UNION ALL SELECT 'A.7', 'rd_download_correlations', COUNT(*) FROM rd_download_correlations
UNION ALL SELECT 'A.7', 'rd_download_correlation_classes', COUNT(DISTINCT correlation_class) FROM rd_download_correlations;

-- ============================================================
-- H. TTL distribution
-- ============================================================
SELECT 'A.8' AS section,
       CASE
         WHEN expires_at IS NULL THEN 'no-expiry'
         WHEN expires_at - observed_at < 60000 THEN 'lt-1min'
         WHEN expires_at - observed_at < 600000 THEN 'lt-10min'
         WHEN expires_at - observed_at < 3600000 THEN 'lt-1hr'
         WHEN expires_at - observed_at < 86400000 THEN 'lt-1day'
         ELSE 'gt-1day'
       END AS ttl_bucket,
       COUNT(*) AS n
FROM provider_observation_current
GROUP BY ttl_bucket;
SQL

echo "Census written to: $OUT/census.txt"
wc -l "$OUT/census.txt"

#!/usr/bin/env bash
# Read-only production census for slice 6: quality feature extraction.
# Analyzes release_attributes, candidates, and media_request_results
# to report quality feature distributions across the real corpus.
# No mutations. Use with: bash slice6-census/run-census.sh

set -euo pipefail

DB="/home/patrick/hashsucker-data/discovery/discovery-cache.db"
OUT="/home/patrick/src/hashsucker/artifacts/audit-2026-09-04/slice6-census"
mkdir -p "$OUT"

# Safety: refuse if not the production DB path.
case "$DB" in
  /home/patrick/hashsucker-data/discovery/discovery-cache.db) ;;
  *) echo "Refusing to run against non-prod DB: $DB" >&2; exit 2 ;;
esac

# Read-only: open in read-only mode (-readonly) and run only SELECTs.
sqlite3 -readonly -header -column "$DB" <<SQL > "$OUT/census.txt" 2>&1
-- ============================================================
-- A. release_attributes (parsed metadata from filenames)
-- ============================================================
SELECT 'A.1' AS section, 'total_release_attributes' AS metric, COUNT(*) AS value FROM release_attributes
UNION ALL SELECT 'A.1', 'distinct_info_hashes', COUNT(DISTINCT info_hash) FROM release_attributes
UNION ALL SELECT 'A.1', 'null_resolution', COUNT(*) FROM release_attributes WHERE resolution IS NULL OR resolution = ''
UNION ALL SELECT 'A.1', 'null_source_type', COUNT(*) FROM release_attributes WHERE source_type IS NULL OR source_type = ''
UNION ALL SELECT 'A.1', 'null_codec', COUNT(*) FROM release_attributes WHERE codec IS NULL OR codec = ''
UNION ALL SELECT 'A.1', 'null_release_group', COUNT(*) FROM release_attributes WHERE release_group IS NULL OR release_group = ''
UNION ALL SELECT 'A.1', 'null_filename', COUNT(*) FROM release_attributes WHERE filename IS NULL OR filename = '';

-- ============================================================
-- B. Resolution distribution in release_attributes
-- ============================================================
SELECT 'B.1' AS section, resolution, COUNT(*) AS n
FROM release_attributes
WHERE resolution IS NOT NULL AND resolution != ''
GROUP BY resolution
ORDER BY n DESC;

-- ============================================================
-- C. Source type distribution in release_attributes
-- ============================================================
SELECT 'C.1' AS section, source_type, COUNT(*) AS n
FROM release_attributes
WHERE source_type IS NOT NULL AND source_type != ''
GROUP BY source_type
ORDER BY n DESC;

-- ============================================================
-- D. Codec distribution in release_attributes
-- ============================================================
SELECT 'D.1' AS section, codec, COUNT(*) AS n
FROM release_attributes
WHERE codec IS NOT NULL AND codec != ''
GROUP BY codec
ORDER BY n DESC;

-- ============================================================
-- E. Top release groups
-- ============================================================
SELECT 'E.1' AS section, release_group, COUNT(*) AS n
FROM release_attributes
WHERE release_group IS NOT NULL AND release_group != ''
GROUP BY release_group
ORDER BY n DESC
LIMIT 20;

-- ============================================================
-- F. Container derivation from filename extensions
-- ============================================================
SELECT 'F.1' AS section,
  CASE
    WHEN lower(filename) LIKE '%.mkv' THEN 'mkv'
    WHEN lower(filename) LIKE '%.mp4' THEN 'mp4'
    WHEN lower(filename) LIKE '%.m2ts' THEN 'm2ts'
    WHEN lower(filename) LIKE '%.ts' THEN 'ts'
    WHEN lower(filename) LIKE '%.avi' THEN 'avi'
    WHEN lower(filename) LIKE '%.mov' THEN 'mov'
    WHEN lower(filename) LIKE '%.wmv' THEN 'wmv'
    WHEN lower(filename) LIKE '%.flv' THEN 'flv'
    WHEN lower(filename) LIKE '%.webm' THEN 'webm'
    WHEN lower(filename) LIKE '%.iso' THEN 'iso'
    ELSE 'other'
  END AS container,
  COUNT(*) AS n
FROM release_attributes
GROUP BY container
ORDER BY n DESC;

-- ============================================================
-- G. Exact file size availability
-- ============================================================
SELECT 'G.1' AS section, 'candidates_with_size' AS metric, COUNT(*) AS value FROM candidates WHERE size IS NOT NULL AND size > 0
UNION ALL SELECT 'G.1', 'candidates_total', COUNT(*) FROM candidates
UNION ALL SELECT 'G.1', 'results_with_selected_file_size', COUNT(*) FROM media_request_results WHERE selected_file_size IS NOT NULL AND selected_file_size > 0
UNION ALL SELECT 'G.1', 'results_total', COUNT(*) FROM media_request_results;

-- ============================================================
-- H. Size distribution by resolution (from candidates)
-- ============================================================
SELECT 'H.1' AS section,
  ra.resolution,
  COUNT(*) AS n,
  ROUND(MIN(c.size) / 1073741824.0, 2) AS min_gb,
  ROUND(AVG(c.size) / 1073741824.0, 2) AS avg_gb,
  ROUND(MAX(c.size) / 1073741824.0, 2) AS max_gb
FROM release_attributes ra
JOIN candidates c ON c.info_hash = ra.info_hash AND c.file_index_key = ra.file_index_key
WHERE ra.resolution IS NOT NULL AND ra.resolution != '' AND c.size IS NOT NULL AND c.size > 0
GROUP BY ra.resolution
ORDER BY n DESC;

-- ============================================================
-- I. Size distribution within 1080p tier
-- ============================================================
SELECT 'I.1' AS section, '1080p_size_distribution' AS metric, value FROM (
  SELECT 'count' AS metric, COUNT(*) AS value
  FROM release_attributes ra
  JOIN candidates c ON c.info_hash = ra.info_hash AND c.file_index_key = ra.file_index_key
  WHERE ra.resolution = '1080p' AND c.size IS NOT NULL AND c.size > 0
  UNION ALL SELECT 'min_gb', ROUND(MIN(c.size) / 1073741824.0, 2)
  FROM release_attributes ra
  JOIN candidates c ON c.info_hash = ra.info_hash AND c.file_index_key = ra.file_index_key
  WHERE ra.resolution = '1080p' AND c.size IS NOT NULL AND c.size > 0
  UNION ALL SELECT 'p25_gb', ROUND((SELECT c2.size FROM release_attributes ra2 JOIN candidates c2 ON c2.info_hash = ra2.info_hash AND c2.file_index_key = ra2.file_index_key WHERE ra2.resolution = '1080p' AND c2.size IS NOT NULL AND c2.size > 0 ORDER BY c2.size LIMIT 1 OFFSET (SELECT COUNT(*) / 4 FROM release_attributes ra3 JOIN candidates c3 ON c3.info_hash = ra3.info_hash AND c3.file_index_key = ra3.file_index_key WHERE ra3.resolution = '1080p' AND c3.size IS NOT NULL AND c3.size > 0)) / 1073741824.0, 2)
  FROM (SELECT 1)
  UNION ALL SELECT 'median_gb', ROUND((SELECT c2.size FROM release_attributes ra2 JOIN candidates c2 ON c2.info_hash = ra2.info_hash AND c2.file_index_key = ra2.file_index_key WHERE ra2.resolution = '1080p' AND c2.size IS NOT NULL AND c2.size > 0 ORDER BY c2.size LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM release_attributes ra3 JOIN candidates c3 ON c3.info_hash = ra3.info_hash AND c3.file_index_key = ra3.file_index_key WHERE ra3.resolution = '1080p' AND c3.size IS NOT NULL AND c3.size > 0)) / 1073741824.0, 2)
  FROM (SELECT 1)
  UNION ALL SELECT 'p75_gb', ROUND((SELECT c2.size FROM release_attributes ra2 JOIN candidates c2 ON c2.info_hash = ra2.info_hash AND c2.file_index_key = ra2.file_index_key WHERE ra2.resolution = '1080p' AND c2.size IS NOT NULL AND c2.size > 0 ORDER BY c2.size LIMIT 1 OFFSET (SELECT COUNT(*) * 3 / 4 FROM release_attributes ra3 JOIN candidates c3 ON c3.info_hash = ra3.info_hash AND c3.file_index_key = ra3.file_index_key WHERE ra3.resolution = '1080p' AND c3.size IS NOT NULL AND c3.size > 0)) / 1073741824.0, 2)
  FROM (SELECT 1)
  UNION ALL SELECT 'max_gb', ROUND(MAX(c.size) / 1073741824.0, 2)
  FROM release_attributes ra
  JOIN candidates c ON c.info_hash = ra.info_hash AND c.file_index_key = ra.file_index_key
  WHERE ra.resolution = '1080p' AND c.size IS NOT NULL AND c.size > 0
);

-- ============================================================
-- J. Tiny-file outliers (< 500MB) — NOT bad quality, just reported
-- ============================================================
SELECT 'J.1' AS section, ra.resolution, COUNT(*) AS n, ROUND(MIN(c.size) / 1048576.0, 1) AS min_mb
FROM release_attributes ra
JOIN candidates c ON c.info_hash = ra.info_hash AND c.file_index_key = ra.file_index_key
WHERE c.size IS NOT NULL AND c.size > 0 AND c.size < 524288000
GROUP BY ra.resolution
ORDER BY n DESC;

-- ============================================================
-- K. Giant-file outliers (> 50GB) — NOT bad quality, just reported
-- ============================================================
SELECT 'K.1' AS section, ra.resolution, COUNT(*) AS n, ROUND(MAX(c.size) / 1073741824.0, 1) AS max_gb
FROM release_attributes ra
JOIN candidates c ON c.info_hash = ra.info_hash AND c.file_index_key = ra.file_index_key
WHERE c.size IS NOT NULL AND c.size > 0 AND c.size > 53687091200
GROUP BY ra.resolution
ORDER BY n DESC;

-- ============================================================
-- L. media_request_results (quality_features will populate after deploy)
-- ============================================================
SELECT 'L.1' AS section, 'results_total' AS metric, COUNT(*) AS value FROM media_request_results
UNION ALL SELECT 'L.1', 'results_with_selected_file_size', COUNT(*) FROM media_request_results WHERE selected_file_size IS NOT NULL AND selected_file_size > 0
UNION ALL SELECT 'L.1', 'results_with_resolution_state', COUNT(*) FROM media_request_results WHERE resolution_state IS NOT NULL AND resolution_state != '';

SQL

echo "Census complete. Output at $OUT/census.txt"

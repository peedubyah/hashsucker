#!/usr/bin/env bash
# Authoritative cold-state preflight for tt7366338 (Chernobyl 2019) S01.
#
# Cold-state stores measured (all in /home/patrick/hashsucker-data/discovery/):
#   - discovery-cache.db: media_intents, media_requests, media_request_results,
#                         playback_handoffs, vfs_tv_entries, vfs_movie_entries,
#                         candidate_media, library_* (in control-plane.db), ...
#   - control-plane.db:   library_items, library_paths, media_bindings,
#                         torrent_files, provider_placements, provider_files,
#                         repair_transactions, repair_steps, lifecycle_events,
#                         durability_due_state, durability_scheduler_state
#
# This script is secret-safe: it never reads info_hash, file_index, file_id,
# capability URLs, or any durable provider IDs verbatim. It only emits
# counts/joins to verify cold state.
#
# Usage:  bash scripts/preflight-tt7366338-cold.sh
# Exit:   0 always; prints 0 vs N counts for the parent agent to inspect.

set -u

DDB="/home/patrick/hashsucker-data/discovery/discovery-cache.db"
CDB="/home/patrick/hashsucker-data/discovery/control-plane.db"
MEDIA="tt7366338"
SEASON=1
EXPECTED_CHILDREN=5

runq() {
  local label="$1"; shift
  echo "=== $label ==="
  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 -separator '|' -header "$@"
  else
    echo "(sqlite3 CLI not available; install sqlite3 to inspect)"
  fi
  echo
}

echo "Target: ${MEDIA} (Chernobyl 2019) S${SEASON} expected ${EXPECTED_CHILDREN} children"
echo "Discovery DB: ${DDB}"
echo "Control-plane DB: ${CDB}"
echo

# A. Logical parent request (media_intents row from Seerr)
runq "A. Logical parent request (media_intents for ${MEDIA})" \
  "$DDB" "SELECT COUNT(*) AS parent_intent_count FROM media_intents WHERE media_id = '${MEDIA}';"

# B. Five child episodes (children must have season IS NULL or =1 to count as
#    S01 fan-out). media_requests rows are the durable per-episode record.
runq "B. Child episode media_requests (intent season=${SEASON})" \
  "$DDB" "SELECT COUNT(*) AS child_request_count
          FROM media_requests mr JOIN media_intents mi ON mr.intent_id = mi.id
          WHERE mi.media_id = '${MEDIA}'
            AND mi.media_type = 'tv'
            AND (mi.season = ${SEASON} OR mi.season IS NULL);"

# C. Authoritative handoffs (playback_handoffs is the durable selection record)
runq "C. Authoritative playback_handoffs" \
  "$DDB" "SELECT COUNT(*) AS handoff_count FROM playback_handoffs WHERE media_id = '${MEDIA}';"

# D. TorrentFiles (control-plane) — only meaningful after a handoff exists.
#    Discover info_hashes through the handoff join (using ATTACH for cross-DB),
#    then look up the torrent_file and report its (id, info_hash prefix,
#    size, internal_path). Secret-safe: hash is truncated to 8 chars.
runq "D. TorrentFiles (control-plane) for ${MEDIA}" \
  "$CDB" "ATTACH DATABASE '${DDB}' AS discovery;
          SELECT tf.id,
                 substr(tf.info_hash, 1, 8) || '...' AS info_hash_prefix,
                 tf.size AS exact_size_bytes,
                 tf.internal_path
          FROM torrent_files tf
          WHERE tf.info_hash IN (
            SELECT DISTINCT lower(ph.info_hash)
            FROM discovery.playback_handoffs ph
            WHERE ph.media_id = '${MEDIA}'
          );"

# E. VFS rows (vfs_tv_entries is the authoritative publication record)
runq "E. VFS rows (vfs_tv_entries) for ${MEDIA} S=${SEASON}" \
  "$DDB" "SELECT media_id, season, episode, canonical_path, size
          FROM vfs_tv_entries
          WHERE media_id = '${MEDIA}' AND season = ${SEASON};"

# F. Control-plane target associations: library_items, library_paths, bindings
runq "F. library_items / library_paths / active bindings" \
  "$CDB" "SELECT 'library_items' AS store, COUNT(*) AS n FROM library_items
          UNION ALL SELECT 'library_paths', COUNT(*) FROM library_paths
          UNION ALL SELECT 'active_bindings', COUNT(*) FROM bindings
            WHERE status = 'active';"

# G. Repair transactions / steps
runq "G. repair_transactions / repair_steps" \
  "$CDB" "SELECT 'repair_transactions' AS store, COUNT(*) AS n FROM repair_transactions
          UNION ALL SELECT 'repair_steps', COUNT(*) FROM repair_steps;"

# H. Lifecycle events
runq "H. lifecycle_events" \
  "$CDB" "SELECT COUNT(*) AS lifecycle_event_count FROM lifecycle_events;"

# I. Durability state for ${MEDIA} (source, next_due, jitter, duplicates).
#    Jitter window: next_due_at - now() in ms. Duplicates: any non-unique
#    enrollment_key.
runq "I. durability_due_state / scheduler state" \
  "$CDB" "SELECT library_item_id,
                  source,
                  enrolled_at,
                  next_due_at,
                  (next_due_at - strftime('%s','now')*1000) AS jitter_ms,
                  last_run_at,
                  last_outcome,
                  consecutive_failures,
                  disabled
          FROM durability_due_state
          WHERE library_item_id IN (
            SELECT id FROM library_items
          ) OR library_item_id LIKE '${MEDIA}%'
          ORDER BY enrolled_at DESC;"

runq "I.2 Duplicate enrollment_keys (cold invariant: 0)" \
  "$CDB" "SELECT enrollment_key, COUNT(*) AS dup
          FROM durability_due_state
          GROUP BY enrollment_key
          HAVING dup > 1;"

runq "I.3 durability_scheduler_state" \
  "$CDB" "SELECT mode, last_pass_at, last_pass_selected, last_pass_succeeded,
                  last_pass_failed, last_pass_skipped, next_pass_at
          FROM durability_scheduler_state
          ORDER BY id DESC LIMIT 1;"

# J. Discovery-side candidate associations (candidate_media)
runq "J. candidate_media associations for ${MEDIA}" \
  "$DDB" "SELECT resolution_state, COUNT(*) AS n
          FROM candidate_media
          WHERE media_id = '${MEDIA}'
          GROUP BY resolution_state;"

# K. Cross-store hash union (handoff vs vfs) — secret-safe via prefix
runq "K. info_hash union (handoff vs vfs) — secret-safe prefix" \
  "$DDB" "SELECT 'handoff_only' AS src, substr(lower(ph.info_hash), 1, 8) || '...' AS h
          FROM playback_handoffs ph
          WHERE ph.media_id = '${MEDIA}'
            AND NOT EXISTS (
              SELECT 1 FROM vfs_tv_entries v
              WHERE v.media_id = ph.media_id
                AND v.season = ph.season
                AND v.episode = ph.episode
            )
          UNION ALL
          SELECT 'vfs_only', substr(lower(v.info_hash), 1, 8) || '...'
          FROM vfs_tv_entries v
          WHERE v.media_id = '${MEDIA}'
            AND NOT EXISTS (
              SELECT 1 FROM playback_handoffs ph
              WHERE ph.media_id = v.media_id
                AND ph.season = v.season
                AND ph.episode = v.episode
            )
          UNION ALL
          SELECT 'both', substr(lower(ph.info_hash), 1, 8) || '...'
          FROM playback_handoffs ph
          JOIN vfs_tv_entries v
            ON v.media_id = ph.media_id
           AND v.season = ph.season
           AND v.episode = ph.episode
          WHERE ph.media_id = '${MEDIA}'
          ORDER BY src, h;"

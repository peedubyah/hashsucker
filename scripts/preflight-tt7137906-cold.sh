#!/usr/bin/env bash
# Authoritative cold-state preflight + live accounting delta capture for
# tt7137906 (When They See Us, 2019) S01.
#
# Cold-state stores measured (all in
# /home/patrick/hashsucker-data/discovery/):
#   - discovery-cache.db: media_intents, media_requests, media_request_results,
#                         playback_handoffs, vfs_tv_entries, vfs_movie_entries,
#                         candidate_media, library_* (in control-plane.db), ...
#   - control-plane.db:   library_items, library_paths, media_bindings,
#                         torrent_files, provider_placements, provider_files,
#                         repair_transactions, repair_steps, lifecycle_events,
#                         durability_due_state, durability_scheduler_state
#
# Live accounting endpoints captured (secret-safe; counts only):
#   - GET  /api/debug/discovery-accounting   (JSON, sources.{name}.{requests,candidates,errors})
#   - GET  /api/debug/provider-accounting    (JSON or format=text)
#   - GET  /api/metrics                      (Plex refresh + winner/source/cached counters)
#   - GET  /api/control-plane/health         (mode + storage status)
#   - GET  /api/operator/health              (container health snapshot)
#   - GET  /api/operator/events/stats        (worker event totals)
#   - GET  /api/search/stats                 (search index size)
#   - GET  /api/search/cache/metrics         (search cache hit/miss)
#   - GET  /api/debug/cache-intelligence     (cache state)
#   - GET  /api/debug/enrichment             (enrichment counters)
#
# Background durability is read directly from control-plane.db:
#   - durability_scheduler_state  (mode, last_pass_*, next_pass_at)
#   - durability_due_state        (library_item_id, source, last_outcome,
#                                  consecutive_failures, disabled)
#
# This script is secret-safe: it never reads info_hash, file_index, file_id,
# capability URLs, or any durable provider IDs verbatim. It only emits
# counts/joins to verify cold state and a single timestamp-bearing delta
# envelope for the live runtime to record before/after a bounded run.
#
# Usage:  bash scripts/preflight-tt7137906-cold.sh [out-dir]
# Exit:   0 always; emits baseline + delta envelope JSON + readable summary.
#         Default out-dir is artifacts/preflight-tt7137906/.
#
# Required runtime state:
#   - media-search healthy on http://127.0.0.1:3000
#   - BACKGROUND_DURABILITY_MODE=observe (preserve override)
#   - No live request, no provider call, no Plex refresh issued by this script

set -u

DDB="/home/patrick/hashsucker-data/discovery/discovery-cache.db"
CDB="/home/patrick/hashsucker-data/discovery/control-plane.db"
MEDIA="tt7137906"
SEASON=1
EXPECTED_CHILDREN=4

MEDIA_SEARCH_URL="${MEDIA_SEARCH_URL:-http://127.0.0.1:3000}"
MEDIA_TITLE="When They See Us (2019)"
TMDB_ID="${TMDB_ID:-81355}"

OUT_DIR="${1:-artifacts/preflight-tt7137906}"
mkdir -p "$OUT_DIR"
BASELINE="$OUT_DIR/baseline.json"
LIVE_BEFORE="$OUT_DIR/live-before.json"
LIVE_BEFORE_TEXT="$OUT_DIR/live-before.txt"
META="$OUT_DIR/meta.json"
SCHEMA_NOTE="$OUT_DIR/seerr-envelope.json"

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

jcurl() {
  # jcurl <method> <path> [body]  → writes status+body to stdout
  local method="$1" path="$2" body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -o - -w '\n%{http_code}' -X "$method" \
      -H 'content-type: application/json' \
      --data "$body" "${MEDIA_SEARCH_URL}${path}"
  else
    curl -sS -o - -w '\n%{http_code}' -X "$method" "${MEDIA_SEARCH_URL}${path}"
  fi
}

# ─── Header / context ─────────────────────────────────────────────────────
echo "Target: ${MEDIA} (${MEDIA_TITLE}) S${SEASON} expected ${EXPECTED_CHILDREN} children"
echo "TMDB ID (read-only metadata lookup, NOT sent as ingress): ${TMDB_ID}"
echo "Discovery DB:  ${DDB}"
echo "Control-plane DB: ${CDB}"
echo "media-search URL: ${MEDIA_SEARCH_URL}"
echo "Out dir:       ${OUT_DIR}"
echo

# ─── META: context for the parent agent (no secrets) ──────────────────────
cat > "$META" <<EOF
{
  "media_id": "${MEDIA}",
  "title": "${MEDIA_TITLE}",
  "tmdb_id": "${TMDB_ID}",
  "season": ${SEASON},
  "expected_children": ${EXPECTED_CHILDREN},
  "image": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "media_search_url": "${MEDIA_SEARCH_URL}",
  "expected_runtime": {
    "background_durability_mode": "observe",
    "torbox_inventory_adapter_wired": false,
    "background_provider_calls_expected": 0,
    "torbox_provider_categories_tracked": [
      "availability checkcached",
      "placement lookup mylist",
      "placement create",
      "inventory fetch",
      "requestdl resolution",
      "requestdl cache hit",
      "requestdl rate limited 429"
    ],
    "plex_refresh_counters_tracked": [
      "refresh_requested",
      "refresh_coalesced",
      "actual_refresh_sent",
      "full_section_refresh",
      "refresh_failed",
      "pending"
    ],
    "discovery_sources_tracked": [
      "torrentio-torbox",
      "torrentio-realdebrid",
      "comet-torbox",
      "comet-realdebrid",
      "comet-manual",
      "torznab"
    ]
  }
}
EOF
echo "META → $META"

# ─── SEERR ENVELOPE: minimal, identity-only, no provider/candidate ─────────
# This is the exact, normal Seerr ingress body for tt7137906 S01.
# It carries ONLY identity (imdbId/tmdbId), mediaType, the request id, and
# the requested-season marker. It does NOT inject candidate or provider
# identity. The handler short-circuits the TMDB→IMDb translation because
# imdbId is present.
cat > "$SCHEMA_NOTE" <<EOF
{
  "seerr_envelope": {
    "method": "POST",
    "path": "/api/ingress/seerr",
    "headers": {
      "authorization": "Bearer \${SEERR_WEBHOOK_TOKEN}",
      "content-type": "application/json"
    },
    "body": {
      "notification_type": "MEDIA_AUTO_APPROVED",
      "subject": "Request for When They See Us (2019) S01 was automatically approved",
      "media": {
        "mediaType": "tv",
        "media_type": "tv",
        "imdbId": "tt7137906",
        "tmdbId": "${TMDB_ID}"
      },
      "request": {
        "request_id": "tt7137906-s01-preflight-<unique-token>"
      },
      "extra": [
        { "name": "Requested Seasons", "value": "${SEASON}" }
      ]
    }
  },
  "fields_used_by_buildSeerrIntent": [
    "media.mediaType or media.media_type",
    "media.imdbId (preferred; ^tt[0-9]{7,}\$ required)",
    "media.tmdbId (optional; preserved on intent, used for TV→movie fallback)",
    "media.tvdbId (optional; preserved; never the operational mediaId)",
    "request.request_id or request.requestId or request.id (idempotency key; required)",
    "notification_type (whitelist: MEDIA_AUTO_APPROVED | MEDIA_APPROVED; absent → 'REQUEST_APPROVED' assumed)",
    "subject (optional, human-readable)",
    "extra (required for TV: [{ name: 'Requested Seasons', value: '1' }])"
  ],
  "fields_NOT_required_and_NOT_injected": [
    "candidate.* / candidateMedia.* (provider-side; never accepted)",
    "releaseKey / infoHash / fileIndex (control-plane identity; never accepted)",
    "provider name (torbox / realdebrid / etc) — picked later by the resolver",
    "media_id candidate list (only the single requester-supplied media identity is carried)"
  ],
  "expected_derived_intent": {
    "mediaId": "tt7137906",
    "imdbId": "tt7137906",
    "tmdbId": "${TMDB_ID}",
    "tvdbId": null,
    "mediaType": "series",
    "season": null,
    "episode": null,
    "source": "seerr",
    "sourceType": "request",
    "sourceId": "tt7137906-s01-preflight-<unique-token>",
    "priority": 100,
    "status": "active"
  },
  "identity_translation_at_boundary": "imdb-already-known (handler skips resolveSeerrIdentity because intent.imdbId is truthy)",
  "tv_fanout_path": "isTvFanout=true when seasonParse.valid && seasons.length>0; this yields 1 parent media_intent + 1 child media_request per episode × per requested season"
}
EOF
echo "SEERR ENVELOPE → $SCHEMA_NOTE"
echo

# ─── A–K: cold-state SQL (mirrors preflight-tt7366338-cold.sh) ────────────
# A. Logical parent request
runq "A. Logical parent request (media_intents for ${MEDIA})" \
  "$DDB" "SELECT COUNT(*) AS parent_intent_count FROM media_intents WHERE media_id = '${MEDIA}';"

# B. Child episode media_requests
runq "B. Child episode media_requests (intent season=${SEASON})" \
  "$DDB" "SELECT COUNT(*) AS child_request_count
          FROM media_requests mr JOIN media_intents mi ON mr.intent_id = mi.id
          WHERE mi.media_id = '${MEDIA}'
            AND mi.media_type = 'tv'
            AND (mi.season = ${SEASON} OR mi.season IS NULL);"

# C. Authoritative handoffs
runq "C. Authoritative playback_handoffs" \
  "$DDB" "SELECT COUNT(*) AS handoff_count FROM playback_handoffs WHERE media_id = '${MEDIA}';"

# D. TorrentFiles (control-plane) — secret-safe info_hash prefix
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

# E. VFS rows
runq "E. VFS rows (vfs_tv_entries) for ${MEDIA} S=${SEASON}" \
  "$DDB" "SELECT media_id, season, episode, canonical_path, size
          FROM vfs_tv_entries
          WHERE media_id = '${MEDIA}' AND season = ${SEASON};"

# F. Control-plane target associations
runq "F. library_items / library_paths / active bindings" \
  "$CDB" "SELECT 'library_items' AS store, COUNT(*) AS n FROM library_items
          UNION ALL SELECT 'library_paths', COUNT(*) FROM library_paths
          UNION ALL SELECT 'active_bindings', COUNT(*) FROM bindings
            WHERE status = 'active';"

# G. Repair
runq "G. repair_transactions / repair_steps" \
  "$CDB" "SELECT 'repair_transactions' AS store, COUNT(*) AS n FROM repair_transactions
          UNION ALL SELECT 'repair_steps', COUNT(*) FROM repair_steps;"

# H. Lifecycle
runq "H. lifecycle_events" \
  "$CDB" "SELECT COUNT(*) AS lifecycle_event_count FROM lifecycle_events;"

# I. Durability
runq "I. durability_due_state" \
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
  "$CDB" "SELECT id, mode,
                  last_pass_at,
                  last_pass_selected,
                  last_pass_succeeded,
                  last_pass_failed,
                  last_pass_skipped,
                  next_pass_at,
                  updated_at
          FROM durability_scheduler_state
          ORDER BY id DESC LIMIT 1;"

# J. candidate_media
runq "J. candidate_media associations for ${MEDIA}" \
  "$DDB" "SELECT resolution_state, COUNT(*) AS n
          FROM candidate_media
          WHERE media_id = '${MEDIA}'
          GROUP BY resolution_state;"

# K. Cross-store hash union
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
                AND ph.season = ph.season
                AND ph.episode = ph.episode
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

# ─── LIVE: capture runtime accounting deltas (before any new ingress) ────
# These are observation-only; no request is sent. The parent will run a
# second capture AFTER the bounded run to compute deltas.
echo "=== LIVE: discovery-accounting (text) ==="
curl -sS "${MEDIA_SEARCH_URL}/api/debug/discovery-accounting?format=text"
echo
echo "=== LIVE: discovery-accounting (json) ==="
curl -sS "${MEDIA_SEARCH_URL}/api/debug/discovery-accounting?all=1" | head -c 4000
echo
echo
echo "=== LIVE: provider-accounting (text) ==="
curl -sS "${MEDIA_SEARCH_URL}/api/debug/provider-accounting?format=text"
echo
echo "=== LIVE: provider-accounting (json) ==="
curl -sS "${MEDIA_SEARCH_URL}/api/debug/provider-accounting" | head -c 4000
echo
echo
echo "=== LIVE: /api/metrics (Plex refresh + winner/source/cached) ==="
curl -sS "${MEDIA_SEARCH_URL}/api/metrics" | head -c 6000
echo
echo
echo "=== LIVE: /api/control-plane/health ==="
curl -sS "${MEDIA_SEARCH_URL}/api/control-plane/health" | head -c 4000
echo
echo
echo "=== LIVE: /api/operator/health ==="
curl -sS "${MEDIA_SEARCH_URL}/api/operator/health" | head -c 2000
echo
echo
echo "=== LIVE: /api/operator/events/stats ==="
curl -sS "${MEDIA_SEARCH_URL}/api/operator/events/stats"
echo
echo
echo "=== LIVE: /api/search/stats ==="
curl -sS "${MEDIA_SEARCH_URL}/api/search/stats"
echo
echo
echo "=== LIVE: /api/search/cache/metrics ==="
curl -sS "${MEDIA_SEARCH_URL}/api/search/cache/metrics" | head -c 2000
echo
echo
echo "=== LIVE: /api/debug/cache-intelligence ==="
curl -sS "${MEDIA_SEARCH_URL}/api/debug/cache-intelligence" | head -c 2000
echo
echo
echo "=== LIVE: /api/debug/enrichment ==="
curl -sS "${MEDIA_SEARCH_URL}/api/debug/enrichment" | head -c 2000
echo

# ─── LIVE composite snapshot (single JSON) ────────────────────────────────
echo "=== LIVE COMPOSITE → ${LIVE_BEFORE} ==="
{
  printf '{\n'
  printf '  "captured_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "media_id": "%s",\n' "${MEDIA}"
  printf '  "discovery_accounting": '
  curl -sS "${MEDIA_SEARCH_URL}/api/debug/discovery-accounting"
  printf ',\n  "provider_accounting": '
  curl -sS "${MEDIA_SEARCH_URL}/api/debug/provider-accounting"
  printf ',\n  "metrics": '
  curl -sS "${MEDIA_SEARCH_URL}/api/metrics"
  printf ',\n  "control_plane_health": '
  curl -sS "${MEDIA_SEARCH_URL}/api/control-plane/health"
  printf ',\n  "operator_health": '
  curl -sS "${MEDIA_SEARCH_URL}/api/operator/health"
  printf ',\n  "operator_events_stats": '
  curl -sS "${MEDIA_SEARCH_URL}/api/operator/events/stats"
  printf ',\n  "search_stats": '
  curl -sS "${MEDIA_SEARCH_URL}/api/search/stats"
  printf ',\n  "search_cache_metrics": '
  curl -sS "${MEDIA_SEARCH_URL}/api/search/cache/metrics"
  printf ',\n  "cache_intelligence": '
  curl -sS "${MEDIA_SEARCH_URL}/api/debug/cache-intelligence"
  printf ',\n  "enrichment": '
  curl -sS "${MEDIA_SEARCH_URL}/api/debug/enrichment"
  printf '\n}\n'
} > "$LIVE_BEFORE"
echo
echo "Wrote $LIVE_BEFORE"

# A compact text view of the same shape (diff-friendly)
{
  echo "captured_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "media_id: ${MEDIA}"
  echo "--- discovery_accounting ---"
  curl -sS "${MEDIA_SEARCH_URL}/api/debug/discovery-accounting?format=text"
  echo "--- provider_accounting ---"
  curl -sS "${MEDIA_SEARCH_URL}/api/debug/provider-accounting?format=text"
  echo "--- metrics (plex_refresh + winner/source/cached) ---"
  curl -sS "${MEDIA_SEARCH_URL}/api/metrics" | python3 -c '
import json, sys
m = json.load(sys.stdin)
out = {"plex_refresh": m.get("plex_refresh"), "winner_cache_cached": m.get("counters", {}).get("winner_cache_cached"), "winner_cache_uncached": m.get("counters", {}).get("winner_cache_uncached"), "winner_source_merged": m.get("counters", {}).get("winner_source_merged")}
print(json.dumps(out, indent=2))'
  echo "--- control_plane_health.ok / mode ---"
  curl -sS "${MEDIA_SEARCH_URL}/api/control-plane/health" | python3 -c 'import json, sys; h = json.load(sys.stdin); print(json.dumps({"ok": h.get("ok"), "mode": h.get("mode"), "provider_capabilities": h.get("providerCapabilities")}, indent=2))'
  echo "--- operator_health.status ---"
  curl -sS "${MEDIA_SEARCH_URL}/api/operator/health" | python3 -c 'import json, sys; h = json.load(sys.stdin); print(h.get("status"))'
} > "$LIVE_BEFORE_TEXT"
echo "Wrote $LIVE_BEFORE_TEXT"

# ─── Durability live state (from control-plane.db) ───────────────────────
runq "L. Durability scheduler state (live)" \
  "$CDB" "SELECT id, mode, last_pass_at,
                  last_pass_selected, last_pass_succeeded,
                  last_pass_failed, last_pass_skipped,
                  next_pass_at, updated_at
          FROM durability_scheduler_state ORDER BY id DESC LIMIT 1;"

runq "L.2 Durability outcomes by last_outcome" \
  "$CDB" "SELECT last_outcome, COUNT(*) AS n
          FROM durability_due_state
          GROUP BY last_outcome;"

runq "L.3 Background provider calls expected (mode-disabled / no-torbox-adapter)" \
  "$CDB" "SELECT
            (SELECT mode FROM durability_scheduler_state WHERE id=1) AS scheduler_mode,
            (SELECT COUNT(*) FROM durability_due_state) AS enrolled_items,
            (SELECT COUNT(*) FROM durability_due_state WHERE disabled = 0) AS enabled_items,
            (SELECT COUNT(*) FROM durability_due_state WHERE consecutive_failures > 0) AS items_with_failures;"

# ─── BASELINE composite: a single JSON for the parent to read post-run ───
# This is the cold-state snapshot at the time of preflight. The parent
# will diff this against a re-captured baseline (run the script again
# after the bounded run) to compute the delta.
{
  printf '{\n'
  printf '  "captured_at": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "media_id": "%s",\n' "${MEDIA}"
  printf '  "expected_children": %d,\n' "${EXPECTED_CHILDREN}"
  printf '  "parent_intent_count": %s,\n' \
    "$(sqlite3 -separator '' "$DDB" "SELECT COUNT(*) FROM media_intents WHERE media_id = '${MEDIA}';")"
  printf '  "child_request_count": %s,\n' \
    "$(sqlite3 -separator '' "$DDB" "SELECT COUNT(*) FROM media_requests mr JOIN media_intents mi ON mr.intent_id = mi.id WHERE mi.media_id = '${MEDIA}' AND mi.media_type = 'tv' AND (mi.season = ${SEASON} OR mi.season IS NULL);")"
  printf '  "handoff_count": %s,\n' \
    "$(sqlite3 -separator '' "$DDB" "SELECT COUNT(*) FROM playback_handoffs WHERE media_id = '${MEDIA}';")"
  printf '  "vfs_tv_count_for_S%d": %s,\n' "${SEASON}" \
    "$(sqlite3 -separator '' "$DDB" "SELECT COUNT(*) FROM vfs_tv_entries WHERE media_id = '${MEDIA}' AND season = ${SEASON};")"
  printf '  "library_items": %s,\n' \
    "$(sqlite3 -separator '' "$CDB" "SELECT COUNT(*) FROM library_items;")"
  printf '  "library_paths": %s,\n' \
    "$(sqlite3 -separator '' "$CDB" "SELECT COUNT(*) FROM library_paths;")"
  printf '  "active_bindings": %s,\n' \
    "$(sqlite3 -separator '' "$CDB" "SELECT COUNT(*) FROM bindings WHERE status = 'active';")"
  printf '  "repair_transactions": %s,\n' \
    "$(sqlite3 -separator '' "$CDB" "SELECT COUNT(*) FROM repair_transactions;")"
  printf '  "lifecycle_events": %s,\n' \
    "$(sqlite3 -separator '' "$CDB" "SELECT COUNT(*) FROM lifecycle_events;")"
  printf '  "durability_due_state": %s,\n' \
    "$(sqlite3 -separator '' "$CDB" "SELECT COUNT(*) FROM durability_due_state;")"
  printf '  "duplicate_enrollment_keys": %s,\n' \
    "$(sqlite3 -separator '' "$CDB" "SELECT COALESCE(SUM(c-1), 0) FROM (SELECT COUNT(*) AS c FROM durability_due_state GROUP BY enrollment_key HAVING c > 1);")"
  printf '  "durability_mode": "%s",\n' \
    "$(sqlite3 -separator '' "$CDB" "SELECT mode FROM durability_scheduler_state WHERE id = 1;")"
  printf '  "durability_last_pass_provider_calls": 0,\n'
  printf '  "expected_background_provider_calls_under_observe": 0\n'
  printf '}\n'
} > "$BASELINE"
echo
echo "BASELINE → $BASELINE"
echo
echo "Preflight complete. No live ingress, no provider call, no Plex refresh issued."
echo "Re-run after the bounded run and diff $BASELINE against the new value."

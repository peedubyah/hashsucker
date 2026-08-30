#!/usr/bin/env node
/**
 * Plex Watchlist Ingest — operator-triggered, movies only.
 *
 * Flow per movie:
 *   1. Fetch cloud watchlist (discover.provider.plex.tv)
 *   2. Resolve plex:// GUID → external IDs via /library/metadata/{ratingKey}
 *   3. Pick IMDb as canonical mediaId
 *   4. Dedupe: query media_intents by (source, source_id)
 *   5. If new → searchByMedia(cache, request)
 *
 * Operator-triggered. No scheduler. No TV. No removals.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ─── Load .env ───────────────────────────────────────────────────────────────
function loadEnv() {
  const envPath = path.join(ROOT, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

const PLEX_TOKEN = process.env.PLEX_TOKEN;
const DISCOVERY_DB = process.env.DISCOVERY_DB;
const PLEX_WATCHLIST_BASE = process.env.PLEX_WATCHLIST_BASE || 'https://discover.provider.plex.tv';

if (!PLEX_TOKEN) {
  console.error('PLEX_TOKEN is required');
  process.exit(1);
}

if (!DISCOVERY_DB) {
  console.error('DISCOVERY_DB is required');
  process.exit(1);
}

const SOURCE = 'plex-watchlist';
const SOURCE_TYPE = 'plex';

// ─── Plex API ────────────────────────────────────────────────────────────────
async function fetchWatchlist() {
  const url = `${PLEX_WATCHLIST_BASE.replace(/\/$/, '')}/library/sections/watchlist/all`;
  const response = await fetch(url, {
    headers: {
      'X-Plex-Token': PLEX_TOKEN,
      'Accept': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Plex watchlist error: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.MediaContainer?.Metadata || [];
}

async function fetchMetadata(ratingKey) {
  const url = `${PLEX_WATCHLIST_BASE.replace(/\/$/, '')}/library/metadata/${ratingKey}`;
  const response = await fetch(url, {
    headers: {
      'X-Plex-Token': PLEX_TOKEN,
      'Accept': 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Plex metadata error for ${ratingKey}: ${response.status}`);
  }
  const data = await response.json();
  return data.MediaContainer?.Metadata?.[0] || null;
}

// ─── Identity resolution ─────────────────────────────────────────────────────
function extractExternalGuids(item) {
  if (!item) return [];
  const guids = [];
  if (Array.isArray(item.Guid)) {
    for (const g of item.Guid) {
      if (g.id) guids.push(g.id);
    }
  }
  if (item.guid && typeof item.guid === 'string') {
    guids.push(item.guid);
  }
  return guids;
}

function parseIdentity(guid) {
  if (!guid) return null;
  const match = guid.match(/^(imdb|tmdb|local|tvdb|anidb|youtube|itunes|amazon):\/\/([^/?]+)/);
  if (!match) return null;
  return { provider: match[1], id: match[2] };
}

function pickCanonical(identities) {
  const imdb = identities.find((i) => i.provider === 'imdb');
  const tmdb = identities.find((i) => i.provider === 'tmdb');
  return imdb || tmdb || null;
}

// ─── Persistence ─────────────────────────────────────────────────────────────
async function loadPersistence() {
  const { createDiscoveryCache } = await import(
    pathToFileURL(path.join(ROOT, 'src', 'lib', 'discovery', 'cache.js')).href
  );
  return createDiscoveryCache({ dbPath: DISCOVERY_DB });
}

function findIntentBySourceAndId(cache, source, sourceId) {
  const rows = cache.db
    .prepare(
      `SELECT id, media_id, media_type, season, episode, source, source_type, source_id, source_label, status, request_count, created_at
       FROM media_intents
       WHERE source = ? AND source_id = ?
       ORDER BY last_requested_at DESC`
    )
    .all(source, sourceId);
  return rows;
}

function findRequestsByIntentId(cache, intentId) {
  const rows = cache.db
    .prepare(
      `SELECT id, media_id, media_type, source, source_type, status, candidate_count, created_at
       FROM media_requests
       WHERE intent_id = ?
       ORDER BY created_at DESC`
    )
    .all(intentId);
  return rows;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  const cache = await loadPersistence();
  const watchlist = await fetchWatchlist();

  const movies = watchlist.filter((item) => item.type === 'movie');

  const report = {
    run: new Date().toISOString(),
    watchlistTotal: watchlist.length,
    moviesTotal: movies.length,
    items: [],
  };

  for (const movie of movies) {
    const ratingKey = movie.ratingKey;
    const sourceId = `plex://movie/${ratingKey}`;
    const itemReport = {
      title: movie.title,
      year: movie.year,
      ratingKey,
      sourceId,
      status: 'pending',
    };

    try {
      // Resolve external GUIDs via cloud metadata endpoint
      const metadata = await fetchMetadata(ratingKey);
      const guids = extractExternalGuids(metadata);
      const identities = guids.map(parseIdentity).filter(Boolean);
      const canonical = pickCanonical(identities);

      itemReport.identities = identities;
      itemReport.canonical = canonical;

      if (!canonical) {
        itemReport.status = 'no_canonical_id';
        report.items.push(itemReport);
        continue;
      }

      // Dedupe: intent already exists for this (source, source_id)?
      const existingIntents = findIntentBySourceAndId(cache, SOURCE, sourceId);
      if (existingIntents.length > 0) {
        const intent = existingIntents[0];
        const requests = findRequestsByIntentId(cache, intent.id);
        itemReport.status = 'already_ingested';
        itemReport.intentId = intent.id;
        itemReport.requestCount = intent.request_count;
        itemReport.existingRequests = requests.map((r) => ({
          id: r.id,
          status: r.status,
          candidateCount: r.candidate_count,
        }));
        report.items.push(itemReport);
        continue;
      }

      // Ingest via canonical pipeline
      const { searchByMedia } = await import(
        pathToFileURL(path.join(ROOT, 'src', 'api', 'media-request.js')).href
      );

      const request = {
        mediaId: canonical.id,
        mediaType: 'movie',
        season: null,
        episode: null,
        source: SOURCE,
        sourceType: SOURCE_TYPE,
        sourceId,
        mediaTitle: movie.title,
      };

      const result = await searchByMedia(cache, request);

      itemReport.status = 'ingested';
      itemReport.mediaId = canonical.id;
      itemReport.requestId = result.requestId;
      itemReport.resultCount = result.total;
      itemReport.selection = result.selection?.selected
        ? {
            infoHash: result.selection.selected.infoHash,
            filename: result.selection.selected.filename,
            score: result.selection.selected.score,
          }
        : null;
      itemReport.handoff = result.handoff
        ? {
            id: result.handoff.id,
            status: result.handoff.status,
            strmPath: result.handoff.strmPath || null,
          }
        : null;
    } catch (error) {
      itemReport.status = 'error';
      itemReport.error = error.message;
    }

    report.items.push(itemReport);
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

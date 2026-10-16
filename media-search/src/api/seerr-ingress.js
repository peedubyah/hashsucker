/**
 * Seerr ingress — the Seerr webhook boundary.
 *
 * Owns everything that is true only at the Seerr edge:
 *   - Bearer auth on SEERR_WEBHOOK_TOKEN
 *   - intent construction (pure) + idempotency on the Seerr request id
 *   - TMDB → IMDb identity translation (one Seerr detail call)
 *   - withdrawal / availability-wake events, which never discover or search
 *   - the TV fan-out (parent intent + per-episode children), each child
 *     running the SAME single-intent searchByMedia pipeline
 *
 * The fulfillment pipeline itself is not here: this module translates an
 * external notification into durable intents and delegates to
 * media-request.searchByMedia. Household "not yet" outcomes become durable
 * future intent for the anticipation scheduler instead of failures.
 */

import { searchByMedia } from './media-request.js';
import { sendJson, readBody } from '../server/http.js';
import {
  buildSeerrIntent,
  checkSeerrAuth,
  parseRequestedSeasons,
  resolveSeerrSeasonEpisodes,
} from '../lib/intents/providers/seerr.js';
import { classifySeerrDeferral } from '../lib/defers/seerr-defer.js';
import { buildRequestScopedEnsureFn } from '../lib/requests/scoped-ensure.js';
import { buildRequestRdEnsureFn, rdEnsureForRequest } from '../lib/requests/provider-ensure.js';
import { openSeasonFanOutScope } from '../lib/requests/plex-notifier.js';

/**
 * Seerr identity translation at the Seerr ingress boundary.
 *
 * Seerr may report a media identity using only TMDB. The rest of the
 * HashSucker discovery pipeline is keyed on IMDb (and TVDB for series).
 * This helper resolves TMDB → IMDb by calling the Seerr detail endpoint
 * once at the boundary and returns the resolved IMDb; the persisted
 * media_intents row then carries the IMDb form as the operational
 * mediaId, with tmdb_id preserved alongside for traceability.
 *
 * Translation NEVER happens inside the generic discovery pipeline. If
 * a TMDB-only intent arrives without a configured SEERR_URL/API_KEY,
 * the resolver returns `{ ok: false, reason: 'identity-misconfigured' }`
 * and the caller records an explicit identity-unresolved last_error
 * instead of silently feeding `tmdb:*` to an IMDb-keyed search.
 *
 * @param {{ tmdbId: string, mediaType: 'movie'|'series' }} identity
 * @param {{ fetch?: typeof fetch, SEERR_URL?: string, SEERR_API_KEY?: string, logger?: Console }} env
 * @returns {Promise<{ok: true, imdbId: string, canonicalTitle: string|null, releaseDate: string|null} | {ok: false, reason: string, status?: number}>}
 */
export async function resolveSeerrIdentity(identity, env = process.env) {
  const tmdbId = String(identity.tmdbId || '').trim();
  if (!/^[0-9]+$/.test(tmdbId)) {
    return { ok: false, reason: 'identity-bad-tmdb' };
  }
  const baseUrl = String(env.SEERR_URL || '').trim();
  const apiKey = String(env.SEERR_API_KEY || '').trim();
  if (!baseUrl || !apiKey) {
    return { ok: false, reason: 'identity-misconfigured' };
  }
  const path = identity.mediaType === 'series' ? 'tv' : 'movie';
  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/v1/${path}/${encodeURIComponent(tmdbId)}`;
  const f = typeof env.fetch === 'function' ? env.fetch : fetch;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5000);
  try {
    const resp = await f(endpoint, {
      method: 'GET',
      headers: {
        'X-Api-Key': apiKey,
        Accept: 'application/json',
        'User-Agent': 'hashsucker-seerr-ingress/1.0',
      },
      signal: ac.signal,
    });
    if (resp.status === 401 || resp.status === 403) {
      return { ok: false, reason: 'identity-unauthorized', status: resp.status };
    }
    if (resp.status === 404) {
      return { ok: false, reason: 'identity-not-found', status: 404 };
    }
    if (!resp.ok) {
      return { ok: false, reason: 'identity-unavailable', status: resp.status };
    }
    let body;
    try {
      body = await resp.json();
    } catch {
      return { ok: false, reason: 'identity-unparseable' };
    }
    if (!body || typeof body !== 'object') {
      return { ok: false, reason: 'identity-unparseable' };
    }
    // Movie detail responses include `imdbId` at the root; TV detail
    // responses do NOT — the IMDb id lives on the nested `externalIds`
    // object (`{ imdbId, tvdbId, ... }`). The nested fallback is
    // considered only for series so movie identity behaviour remains
    // structurally unchanged rather than merely unchanged for the
    // observed movie response shape.
    const externalIds = identity.mediaType === 'series'
      && body && typeof body.externalIds === 'object' && body.externalIds !== null
      ? body.externalIds
      : null;
    const raw = body.imdbId ?? body.imdb_id
      ?? externalIds?.imdbId ?? externalIds?.imdb_id
      ?? null;
    const imdbId = raw == null ? null : String(raw).trim();
    if (!imdbId || !/^tt[0-9]{7,}$/.test(imdbId)) {
      return { ok: false, reason: 'identity-unresolved' };
    }
    // The same Seerr detail response used for TMDB→IMDb resolution also
    // carries canonical title and release date (Seerr MovieDetails: title,
    // originalTitle, releaseDate; TvDetails: name, originalName,
    // firstAirDate). Surface them on the ok result so the caller can
    // thread the canonical title into the search path without a second
    // I/O. Trivially-cheap string normalization only — no schema/storage
    // effects.
    const canonicalTitleRaw =
      body.originalTitle ?? body.original_title ??
      body.originalName ?? body.original_name ??
      body.title ?? body.name ?? null;
    const canonicalTitle = canonicalTitleRaw == null
      ? null
      : String(canonicalTitleRaw).trim() || null;
    const releaseDateRaw =
      body.releaseDate ?? body.release_date ??
      body.firstAirDate ?? body.first_air_date ?? null;
    const releaseDate = releaseDateRaw == null
      ? null
      : String(releaseDateRaw).trim() || null;
    return { ok: true, imdbId, canonicalTitle, releaseDate };
  } catch (err) {
    const reason = err && err.name === 'AbortError' ? 'identity-timeout' : 'identity-unavailable';
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// Exported for testability only; production callers go through
// handleSeerrIngress.


/**
 * Handle a Seerr webhook at the boundary.
 *
 * Flow:
 *   1. Bearer auth via SEERR_WEBHOOK_TOKEN
 *   2. Build intent (pure function, no I/O)
 *   3. Idempotency check on (source, source_id) — exact request_id
 *   4. If TMDB-only and SEERR_URL/API_KEY are configured, resolve to IMDb
 *      once. On unresolved identity, persist a durable intent with
 *      last_error set and return 500 — NOT zero candidates.
 *   5. Persist the durable intent (idempotent on media_id+type+source+season+episode)
 *   6. Invoke the existing single-intent searchByMedia() pipeline. The
 *      intent row is durable; a searchByMedia failure is recorded as
 *      last_error and re-thrown so the caller can decide.
 *
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 * @param {Object} searchCache
 */
export async function handleSeerrIngress(
  request,
  response,
  searchCache,
  hydrateVfs = null,
  { controlPlaneStore = null, ensureTorBoxFileIdentityFn = null,
    torBoxProvider = null, torBoxApiKey = null, torBoxApiBase = undefined,
    clock = () => Date.now(), hasExplicitEnsureFn = false,
    futureIntentStore = null, availabilityWakeLog = null, schedulingNudge = null,
    rdClient = null, ensureRealDebridFileIdentity = null } = {},
) {
  // 1. Auth
  const authHeader = request.headers && typeof request.headers.authorization === 'string'
    ? request.headers.authorization
    : (request.headers && Array.isArray(request.headers.authorization) ? request.headers.authorization[0] : null);
  const auth = checkSeerrAuth(authHeader, process.env.SEERR_WEBHOOK_TOKEN);
  if (!auth.ok) {
    return sendJson(response, auth.status || 401, { error: 'unauthorized', message: auth.reason });
  }

  // 2. Build intent (pure)
  let body;
  try {
    body = await readBody(request);
  } catch (err) {
    return sendJson(response, 400, { error: 'malformed-body', message: err.message });
  }
  const built = buildSeerrIntent(body);
  if (built.ignored) {
    return sendJson(response, 200, {
      status: 'ignored',
      reason: built.reason,
      notificationType: built.notificationType,
    });
  }
  if (built.error) {
    return sendJson(response, 400, { error: 'malformed-payload', message: built.error });
  }
  const { intent, notificationType } = built;
  const isWithdrawal = built.withdrawal === true;
  const isAvailable = built.available === true;

  // Human cancellation (declined/deleted request): withdraw still-pending
  // deferred rows for this Seerr request id. Passive only — no Seerr API
  // polling, no identity resolution, no provider work. Prepared+ rows and
  // other sources' rows are untouched by construction.
  if (isWithdrawal) {
    const withdrawn = futureIntentStore
      ? futureIntentStore.withdrawSeerrRequest(intent.sourceId, `seerr-withdrawn:${notificationType}`)
      : 0;
    return sendJson(response, 200, {
      status: withdrawn > 0 ? 'withdrawn' : 'withdrawal-nothing-pending',
      notificationType,
      sourceId: intent.sourceId,
      withdrawn,
    });
  }

  // Seerr availability wake-up (availability tranche): MEDIA_AVAILABLE is
  // a scheduling nudge, never fulfillment proof. Matching deferred rows
  // go due-now; the existing scheduler claims them through normal
  // corpus/live discovery and ranking. No Seerr calls, no discovery, no
  // ranking inside the handler — and no second fulfillment pipeline.
  if (isAvailable) {
    const wakeAt = clock();
    let awakened = 0;
    let via = 'none';
    if (futureIntentStore) {
      awakened = futureIntentStore.wakeSeerrRequest(intent.sourceId, wakeAt);
      via = 'request';
      if (awakened === 0) {
        // No row keyed to this request id (re-requested under a new id,
        // or housekeeping event): fall back to exact media identity in
        // every operational form worth trying.
        const forms = [intent.mediaId];
        if (intent.tmdbId) forms.push(`tmdb:${intent.tmdbId}`);
        if (intent.tvdbId) forms.push(`tvdb:${intent.tvdbId}`);
        awakened = futureIntentStore.wakeMedia(forms, wakeAt);
        via = awakened > 0 ? 'identity' : 'none';
      }
    }
    try {
      availabilityWakeLog?.record({
        requestId: intent.sourceId,
        mediaId: intent.mediaId,
        awakened,
        via,
      });
    } catch {}
    // Prompt the scheduler toward an early pass (debounced there) so
    // event→retry starts in seconds. The claim stays authoritative:
    // an already-claimed row cannot be double-driven by this nudge.
    if (awakened > 0) {
      try {
        schedulingNudge?.();
      } catch {}
    }
    return sendJson(response, 200, {
      status: awakened > 0 ? 'woken' : 'availability-no-match',
      notificationType,
      sourceId: intent.sourceId,
      mediaId: intent.mediaId,
      awakened,
      via,
    });
  }

  // 3. Idempotency by Seerr request_id (source_id).
  //    A parent counts as successfully completed/idempotent only when
  //    last_processed_at IS NOT NULL AND last_error IS NULL. If an
  //    earlier attempt created the parent but failed during season
  //    enumeration/fan-out, a subsequent webhook with the same request
  //    ID must be allowed to retry rather than being permanently
  //    poisoned by the parent row.
  //    Household deferred-request tranche: a deferred ("not yet") outcome
  //    is durable intent, not completion. While a non-terminal deferred
  //    row exists for this media, redelivery re-drives the pipeline
  //    (converge faster than the scheduler tick); only short-circuit
  //    when nothing is still pending.
  const existing = searchCache.db.prepare(
    'SELECT id, last_processed_at, last_error FROM media_intents WHERE source = ? AND source_id = ? LIMIT 1'
  ).get('seerr', intent.sourceId);
  if (existing && existing.last_processed_at != null && existing.last_error == null) {
    let stillPending = false;
    try {
      stillPending = futureIntentStore
        ? futureIntentStore.hasPendingForMedia(intent.mediaId)
        : false;
    } catch {}
    if (!stillPending) {
      return sendJson(response, 200, {
        status: 'duplicate',
        notificationType,
        intentId: existing.id,
      });
    }
  }

  // 4. Parse requested seasons BEFORE resolving identity so we can fail
  //    fast on a malformed/missing Requested Seasons entry (movies skip
  //    this entirely).
  const seasonParse = intent.mediaType === 'series'
    ? parseRequestedSeasons(built.extra)
    : { valid: true, seasons: [] };
  const isTvFanout = intent.mediaType === 'series' && seasonParse.valid && seasonParse.seasons.length > 0;

  // 5. Translate TMDB → IMDb at the Seerr boundary (movies always, TV
  //    when we have a TMDB to resolve). For TV fan-out we need IMDb to
  //    drive the parent and child media_id; for movies the same path
  //    continues to apply. When IMDb is already present we skip Seerr.
  let operationalIntent = intent;
  let identityStatus = 'imdb-already-known';
  let canonicalMediaTitle = null;
  let canonicalMediaYear = null;
  // Full ISO release/air date from the same Seerr detail response that
  // supplied the IMDb id (no extra metadata fanout). Drives deferred-
  // request classification: future date → future-not-released with an
  // expected_at the scheduler can sleep on; anything else → bounded retry.
  let canonicalReleaseDate = null;
  if (!intent.imdbId && intent.tmdbId) {
    const resolved = await resolveSeerrIdentity(
      { tmdbId: intent.tmdbId, mediaType: intent.mediaType },
      process.env,
    );
    if (!resolved.ok) {
      const intentId = searchCache.upsertMediaIntent({
        ...intent,
        imdbId: null,
        tmdbId: intent.tmdbId,
      });
      const failureMsg = `seerr-identity-unresolved: tmdb=${intent.tmdbId} reason=${resolved.reason}`;
      searchCache.db.prepare(
        'UPDATE media_intents SET last_error = ?, last_processed_at = ? WHERE id = ?'
      ).run(failureMsg, Date.now(), intentId);
      const httpStatus = resolved.reason === 'identity-misconfigured' ? 503 : 500;
      return sendJson(response, httpStatus, {
        status: 'identity-unresolved',
        notificationType,
        intentId,
        mediaId: intent.mediaId,
        mediaType: intent.mediaType,
        tmdbId: intent.tmdbId,
        reason: resolved.reason,
      });
    }
    operationalIntent = {
      ...intent,
      imdbId: resolved.imdbId,
      mediaId: resolved.imdbId,
    };
    identityStatus = 'imdb-resolved';
    if (typeof resolved.canonicalTitle === 'string' && resolved.canonicalTitle.length > 0) {
      canonicalMediaTitle = resolved.canonicalTitle;
    }
    // Surface the release year too. The Seerr detail body returns
    // `releaseDate` as an ISO date (e.g. "2024-02-27"); we only need the
    // 4-digit year to drive the canonical VFS path. We intentionally do
    // not add a second metadata lookup — the year is already in the same
    // Seerr response that supplied the IMDb id and canonical title.
    if (typeof resolved.releaseDate === 'string' && /^\d{4}/.test(resolved.releaseDate)) {
      const parsed = Number.parseInt(resolved.releaseDate.slice(0, 4), 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        canonicalMediaYear = parsed;
      }
      canonicalReleaseDate = resolved.releaseDate.trim() || null;
    }
  }

  // 6. Movie / single-episode path. Skipped entirely when this is a TV
  //    fan-out (handled in the branch below).
  if (!isTvFanout) {
    // For series with a missing/malformed Requested Seasons entry we
    // still persist the parent so the operator can see the parse
    // failure in last_error, but we never expand to "all seasons" and
    // we never call searchByMedia on the parent.
    const intentId = searchCache.upsertMediaIntent({
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      season: operationalIntent.season,
      episode: operationalIntent.episode,
      source: operationalIntent.source,
      sourceType: operationalIntent.sourceType,
      sourceId: operationalIntent.sourceId,
      sourceLabel: operationalIntent.sourceLabel,
      status: operationalIntent.status,
      priority: operationalIntent.priority,
      requestedBy: null,
      imdbId: operationalIntent.imdbId,
      tmdbId: operationalIntent.tmdbId,
      tvdbId: operationalIntent.tvdbId,
    });

    if (intent.mediaType === 'series' && !seasonParse.valid) {
      searchCache.db.prepare(
        'UPDATE media_intents SET last_error = ?, last_processed_at = ? WHERE id = ?'
      ).run(`extra-season-parse-failed:${seasonParse.reason}`, Date.now(), intentId);
    }

    // For non-TV (movies) the existing single-intent pipeline continues.
    // Request-scoped mylist memoization (same mechanism as POST
    // /api/media-request): one coordinator-owned snapshot for this
    // webhook's selection attempts instead of a full account-list
    // download per verify+inventory pair.
    if (intent.mediaType !== 'series') {
      const requestEnsureFn = buildRequestScopedEnsureFn({
        fallbackFn: ensureTorBoxFileIdentityFn,
        explicitFn: hasExplicitEnsureFn,
        controlPlaneStore,
        torBoxProvider,
        apiKey: torBoxApiKey,
        apiBase: torBoxApiBase,
        clock,
        scope: 'seerr-ingress',
      });
      const requestRdEnsureFn = ensureRealDebridFileIdentity
        ?? buildRequestRdEnsureFn({ rdClient, controlPlaneStore, clock });
      return await runSingleSearchByMedia({
        searchCache, operationalIntent, canonicalMediaTitle, canonicalMediaYear, canonicalReleaseDate, intentId,
        identityStatus, notificationType, response, hydrateVfs,
        ensureTorBoxFileIdentity: requestEnsureFn,
        ensureRealDebridFileIdentity: requestRdEnsureFn,
        controlPlaneStore,
        futureIntentStore,
        clock,
      });
    }
    // For series with parse failure, we stop here — the parent is durable
    // and last_error is recorded, but we never invoke searchByMedia.
    return sendJson(response, 200, {
      status: 'parse-failed',
      identityStatus,
      notificationType,
      intentId,
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      reason: seasonParse.valid ? null : seasonParse.reason,
    });
  }

  // ── 7. TV fan-out: parent + concrete episode children ───────────────────
  // Persist / reuse the parent media_intent. If an earlier attempt left
  // a parent with last_error != null, we reset the parent to retry;
  // existing children with successful media_request rows are skipped
  // below to avoid re-processing episodes that already succeeded.
  let parentIntentId = existing ? existing.id : null;
  if (parentIntentId == null) {
    parentIntentId = searchCache.upsertMediaIntent({
      mediaId: operationalIntent.mediaId,
      mediaType: 'series',
      season: null,
      episode: null,
      source: operationalIntent.source,
      sourceType: operationalIntent.sourceType,
      sourceId: operationalIntent.sourceId,
      sourceLabel: operationalIntent.sourceLabel,
      status: 'active',
      priority: operationalIntent.priority,
      requestedBy: null,
      imdbId: operationalIntent.imdbId,
      tmdbId: operationalIntent.tmdbId,
      tvdbId: operationalIntent.tvdbId,
    });
  } else {
    // Reset parent processing state so the next attempt can mark it again.
    searchCache.db.prepare(
      'UPDATE media_intents SET last_error = NULL, last_processed_at = NULL WHERE id = ?'
    ).run(parentIntentId);
  }

  // 8. Enumerate requested seasons via the Seerr TV API. The first season
  //    that fails structurally (env missing, network, 5xx) aborts the
  //    whole attempt; per-episode failures below are isolated.
  const childResults = [];
  let structurallyFailed = null;
  // Persist requested-season ownership before enumerating episodes. The
  // scheduler reconciles this durable definition repeatedly, so later
  // announcements and moved air dates are not lost after this webhook.
  for (const seasonNum of seasonParse.seasons) {
    futureIntentStore?.ensureRequestedSeason({
      mediaId: operationalIntent.mediaId,
      tmdbId: Number(operationalIntent.tmdbId),
      season: seasonNum,
      source: `seerr:${operationalIntent.sourceId}`,
    });
  }
  // Open a season fan-out scope so every per-child notifyPlex() call
  // for this mediaId is buffered; on close() the coalescer dispatches
  // exactly one targeted Plex partial-refresh per (collection, scanPath)
  // bucket instead of one per child. N children spanning seconds
  // collapse to a single HTTP call. Scope is closed after the
  // season loop completes (structurally or normally) below.
  const seasonScope = openSeasonFanOutScope(operationalIntent.mediaId);
  for (const seasonNum of seasonParse.seasons) {
    let episodes;
    try {
      episodes = await resolveSeerrSeasonEpisodes(
        Number(operationalIntent.tmdbId),
        seasonNum,
        process.env,
      );
    } catch (seasonErr) {
      structurallyFailed = { season: seasonNum, error: seasonErr.message };
      break;
    }

    // 9. Per-episode children.
    for (const ep of episodes) {
      const childSourceId = `${operationalIntent.sourceId}:s${seasonNum}:e${ep.episodeNumber}`;

      // Skip already-successful children on retry. A child counts as
      // successfully completed when it has a media_request row whose
      // status='completed' (existing pipeline writes this when
      // searchByMedia returns successfully).
      const priorChild = searchCache.db.prepare(
        "SELECT id FROM media_intents WHERE source = ? AND source_id = ? LIMIT 1"
      ).get('seerr', childSourceId);
      if (priorChild) {
        const priorDone = searchCache.db.prepare(
          "SELECT 1 FROM media_requests WHERE intent_id = ? AND status = 'completed' LIMIT 1"
        ).get(priorChild.id);
        if (priorDone) {
          childResults.push({
            season: seasonNum,
            episode: ep.episodeNumber,
            childIntentId: priorChild.id,
            skipped: true,
            reason: 'already-successful',
          });
          continue;
        }
      }

      const childIntentId = searchCache.upsertMediaIntent({
        mediaId: operationalIntent.mediaId,
        mediaType: 'tv',
        season: seasonNum,
        episode: ep.episodeNumber,
        source: operationalIntent.source,
        sourceType: 'request',
        sourceId: childSourceId,
        sourceLabel: operationalIntent.sourceLabel
          ? `${operationalIntent.sourceLabel} S${String(seasonNum).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`
          : null,
        status: 'active',
        priority: operationalIntent.priority,
        requestedBy: null,
        imdbId: operationalIntent.imdbId,
        tmdbId: operationalIntent.tmdbId,
        tvdbId: operationalIntent.tvdbId,
      });

      const childTraceStartedAt = Date.now();
      try {
        // Fresh request-scoped mylist memoization per episode child: the
        // coordinator must not outlive one searchByMedia call, otherwise a
        // later sibling could verify against a stale snapshot.
        const childEnsureFn = buildRequestScopedEnsureFn({
          fallbackFn: ensureTorBoxFileIdentityFn,
          explicitFn: hasExplicitEnsureFn,
          controlPlaneStore,
          torBoxProvider,
          apiKey: torBoxApiKey,
          apiBase: torBoxApiBase,
          clock,
          scope: 'seerr-ingress-tv',
        });
        const result = await searchByMedia(searchCache, {
          mediaId: operationalIntent.mediaId,
          // searchByMedia's intent factory accepts only 'movie' or 'series'
          // (it maps to streamType internally as 'tv' for episodes). The
          // media_intents row stores 'tv' for episode children; the
          // searchByMedia parameter is the streamType discriminator.
          mediaType: 'series',
          mediaTitle: canonicalMediaTitle,
          season: seasonNum,
          episode: ep.episodeNumber,
          source: operationalIntent.source,
          sourceType: 'request',
          sourceId: childSourceId,
          sourceLabel: operationalIntent.sourceLabel
            ? `${operationalIntent.sourceLabel} S${String(seasonNum).padStart(2, '0')}E${String(ep.episodeNumber).padStart(2, '0')}`
            : null,
          requestedBy: null,
          priority: operationalIntent.priority,
          intentId: childIntentId,
          persist: true,
          liveDiscoveryThreshold: 1,
          hydrateVfs,
          controlPlaneStore,
          // Bloodhound opt-out: the Seerr season call already carries each
          // episode's air date — a future date marks the child unreleased
          // so the fulfillment gate does not burn live queries on unaired
          // episodes. Absent dates default to released (bloodhound allowed).
          ...(ep.airDate ? { airDate: ep.airDate } : {}),
          // Slice 1.75: pre-publication TorBox file identity binding
          // for TV episodes. TV episodes typically have exact per-file
          // size on the candidate (behaviorHints.videoSize). When
          // configured, this matches the size against the live TorBox
          // inventory and threads the resulting torrentFileId into
          // the handoff.
          ...(childEnsureFn ? { ensureTorBoxFileIdentity: childEnsureFn } : {}),
          // RD ensure: explicit injection wins (tests), else per-request build.
          ...(ensureRealDebridFileIdentity
            ? { ensureRealDebridFileIdentity }
            : rdEnsureForRequest({ rdClient, controlPlaneStore, clock })),
          // TV series don't currently use the canonical title/year for
          // the VFS path (TV materializer uses its own filename-derived
          // identity — unchanged in this slice). Forwarding them is
          // safe and lets the handoff record the canonical identity
          // for telemetry / future TV work without forcing a separate
          // codepath.
          ...(canonicalMediaTitle ? { canonicalTitle: canonicalMediaTitle } : {}),
          ...(canonicalMediaYear != null ? { canonicalYear: canonicalMediaYear } : {}),
        });
        childResults.push({
          season: seasonNum,
          episode: ep.episodeNumber,
          childIntentId,
          // searchByMedia returns its candidate count as `total`, not
          // `resultCount`. (Look at the return object in
          // src/api/media-request.js — there is no `resultCount` field.)
          resultCount: result?.total ?? 0,
          // Household deferred-request tranche: an aired-or-future
          // episode with zero candidates — or candidates that never
          // bound — becomes durable intent keyed on exact S/E
          // (ep.airDate comes from the Seerr season call above — no
          // extra metadata fanout). Deferred children are not failures;
          // the parent outcome below excludes them from failedCount.
          ...unfulfilledTvDeferral({
            store: futureIntentStore,
            mediaId: operationalIntent.mediaId,
            season: seasonNum,
            episode: ep.episodeNumber,
            airDate: ep.airDate,
            childSourceId,
            result,
            clock,
          }),
        });
        // Clear any stale error from a prior failed attempt on this
        // child — successful processing supersedes the earlier failure.
        searchCache.db.prepare(
          'UPDATE media_intents SET last_error = NULL, last_processed_at = ? WHERE id = ?'
        ).run(Date.now(), childIntentId);
        // One concise end-to-end trace line per episode, so "why is this
        // episode not playable yet?" is answerable from the request log
        // without cross-referencing five subsystems. Later stages (Plex
        // ingest, byte route) log their own lines; this anchors the request
        // stage with the elapsed time and the durable outcome.
        const lastChild = childResults[childResults.length - 1];
        console.log(
          `media-search: episode-trace media=${operationalIntent.mediaId} s${seasonNum}e${ep.episodeNumber} `
          + `source=seerr stage=${lastChild?.deferred ? 'deferred' : 'selected'} `
          + `stage_ms=${Date.now() - childTraceStartedAt} candidates=${result?.total ?? 0} `
          + `defer_reason=${lastChild?.deferReason ?? 'none'} result=${lastChild?.deferred ? 'deferred' : 'fulfilled'}`,
        );
      } catch (episodeErr) {
        // Per-episode failure isolation: a transient pipeline failure
        // becomes durable deferred intent (exact S/E); a deterministic
        // failure is recorded on this child as before. Either way the
        // remaining episodes continue.
        const classification = classifySeerrDeferral({
          dateRaw: ep.airDate,
          total: null,
          error: episodeErr,
          nowMs: clock(),
        });
        const deferral = futureIntentStore ? deferSeerrRequest({
          store: futureIntentStore,
          mediaType: 'series',
          mediaId: operationalIntent.mediaId,
          season: seasonNum,
          episode: ep.episodeNumber,
          seerrSourceId: childSourceId,
          classification,
        }) : null;
        if (deferral) {
          searchCache.db.prepare(
            'UPDATE media_intents SET last_error = NULL, last_processed_at = ? WHERE id = ?'
          ).run(Date.now(), childIntentId);
          childResults.push({
            season: seasonNum,
            episode: ep.episodeNumber,
            childIntentId,
            resultCount: 0,
            deferred: true,
            deferReason: deferral.deferReason,
            futureIntentId: deferral.futureIntentId,
            detail: classification.detail,
          });
          continue;
        }
        // Per-episode failure isolation: record on this child and
        // continue with remaining episodes in the season.
        searchCache.db.prepare(
          'UPDATE media_intents SET last_error = ?, last_processed_at = ? WHERE id = ?'
        ).run(`searchByMedia-failed:s${seasonNum}e${ep.episodeNumber} ${episodeErr.message}`, Date.now(), childIntentId);
        childResults.push({
          season: seasonNum,
          episode: ep.episodeNumber,
          childIntentId,
          error: episodeErr.message,
        });
        console.log(
          `media-search: episode-trace media=${operationalIntent.mediaId} s${seasonNum}e${ep.episodeNumber} `
          + `source=seerr stage=failed stage_ms=${Date.now() - childTraceStartedAt} `
          + `result=error detail=${String(episodeErr.message).slice(0, 120)}`,
        );
      }
    }
  }

  // 10. Mark parent processing outcome.
  // Close the season fan-out scope BEFORE recording the parent
  // outcome and before any return path. close() awaits the
  // dispatched refreshes so the operator sees a consistent state:
  // either the Plex partial-refresh has been sent (and the
  // coalescer accounting reflects it) or it has not. This is the
  // lifecycle-semantics seam: N child notifies → one HTTP call.
  try {
    await seasonScope.close();
  } catch (scopeCloseErr) {
    // A failed close() is non-fatal for the Seerr response. The
    // season-fan-out outcome (success / partial failure) is
    // independent of whether the refresh dispatch itself failed.
    console.error(`[Plex] season-fan-out scope close error for ${operationalIntent.mediaId}: ${scopeCloseErr.message}`);
  }

  if (structurallyFailed) {
    searchCache.db.prepare(
      'UPDATE media_intents SET last_error = ?, last_processed_at = ? WHERE id = ?'
    ).run(
      `seerr-season-enumeration-failed:s${structurallyFailed.season} ${structurallyFailed.error}`,
      Date.now(),
      parentIntentId,
    );
    return sendJson(response, 500, {
      status: 'tv-fan-out-enumeration-failed',
      identityStatus,
      notificationType,
      parentIntentId,
      mediaId: operationalIntent.mediaId,
      mediaType: 'series',
      failedSeason: structurallyFailed.season,
      childResults,
      error: structurallyFailed.error,
    });
  }

  // If any child errored, the parent is NOT successfully completed —
  // a subsequent webhook with the same request ID must be allowed to
  // retry the failed children. We record the failure on the parent so
  // the duplicate short-circuit (last_processed_at IS NOT NULL AND
  // last_error IS NULL) does not poison the parent row.
  // Household deferred-request tranche: deferred children likewise keep
  // the parent redeliverable, under their own marker (deferred is
  // scheduled work, not a failure — the scheduler also converges on it).
  const failedChildren = childResults.filter((r) => r.error);
  const deferredChildren = childResults.filter((r) => r.deferred === true);
  if (failedChildren.length > 0) {
    const summary = failedChildren
      .map((r) => `s${r.season}e${r.episode}:${r.error}`)
      .join(',');
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_error = ? WHERE id = ?'
    ).run(Date.now(), `tv-fan-out-children-failed:${summary}`, parentIntentId);
  } else if (deferredChildren.length > 0) {
    const summary = deferredChildren
      .map((r) => `s${r.season}e${r.episode}:${r.deferReason}`)
      .join(',');
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_error = ? WHERE id = ?'
    ).run(Date.now(), `tv-fan-out-children-deferred:${summary}`, parentIntentId);
  } else {
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_error = NULL WHERE id = ?'
    ).run(Date.now(), parentIntentId);
  }

  // Fresh human season demand is urgent: the durable season/episode
  // obligations are now recorded, so pull the anticipation scheduler's next
  // tick forward instead of waiting for the generic interval. This is a direct
  // worker nudge into the EXISTING scheduler (single-flight + atomic claim keep
  // it idempotent); it starts no second scheduler and does no work itself.
  try {
    schedulingNudge?.();
  } catch {}

  return sendJson(response, 200, {
    status: 'tv-fan-out',
    identityStatus,
    notificationType,
    parentIntentId,
    childCount: childResults.filter((r) => r.episode != null).length,
    failedCount: failedChildren.length,
    deferredCount: childResults.filter((r) => r.deferred === true).length,
    childResults,
    mediaId: operationalIntent.mediaId,
    mediaType: 'series',
    canonicalTitle: canonicalMediaTitle,
  });
}

/**
 * Household deferred-request tranche: turn a retryable Seerr "not yet"
 * into durable future intent so the anticipation scheduler converges on
 * it automatically. Idempotent on exact media identity (the store's
 * unique index); a re-request revives withdrawn/exhausted rows instead
 * of duplicating them. Returns null when there is no store or the
 * classification is not retryable.
 */
function deferSeerrRequest({ store, mediaType, mediaId, season, episode, seerrSourceId, classification }) {
  if (!store || !classification || classification.retryable !== true) return null;
  const { intent } = store.seed({
    mediaType,
    mediaId,
    season: season ?? null,
    episode: episode ?? null,
    source: `seerr:${seerrSourceId}`,
    expectedAt: classification.expectedAt,
    deferReason: classification.outcome,
  });
  store.revive(intent.id, { expectedAt: classification.expectedAt, deferReason: classification.outcome });
  const row = store.findByIdentity({ mediaId, season: season ?? null, episode: episode ?? null }) ?? intent;
  return {
    futureIntentId: row.id,
    deferReason: row.defer_reason ?? classification.outcome,
    intentState: row.state,
    expectedAt: row.expected_at,
    nextCheckAt: row.next_check_at,
  };
}

/**
 * TV unfulfilled-child deferral fragment for one episode child. Returns
 * the extra childResults fields (or {} when the child fulfilled). Covers
 * both zero-candidate children and children whose candidates never bound
 * a provider-backed handoff.
 */
function unfulfilledTvDeferral({ store, mediaId, season, episode, airDate, childSourceId, result, clock = () => Date.now() }) {
  const total = result?.total ?? 0;
  const bound = result?.handoff != null && result?.vfsPublished !== false;
  if (!store || (total !== 0 && bound)) return {};
  const classification = classifySeerrDeferral({
    dateRaw: airDate,
    total,
    bound,
    selectionReason: result?.selection?.reason ?? null,
    nowMs: clock(),
  });
  const deferral = deferSeerrRequest({
    store,
    mediaType: 'series',
    mediaId,
    season,
    episode,
    seerrSourceId: childSourceId,
    classification,
  });
  if (!deferral) return {};
  return {
    deferred: true,
    deferReason: deferral.deferReason,
    futureIntentId: deferral.futureIntentId,
    expectedAt: deferral.expectedAt,
    nextCheckAt: deferral.nextCheckAt,
  };
}

/**
 * Single-intent searchByMedia path used by movies (and series with a
 * missing/malformed Requested Seasons entry, which never reach here).
 */
async function runSingleSearchByMedia({
  searchCache, operationalIntent, canonicalMediaTitle, canonicalMediaYear, canonicalReleaseDate = null, intentId,
  identityStatus, notificationType, response, hydrateVfs = null,
  ensureTorBoxFileIdentity = null, ensureRealDebridFileIdentity = null,
  controlPlaneStore = null, futureIntentStore = null, clock = () => Date.now(),
}) {
  try {
    const result = await searchByMedia(searchCache, {
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      mediaTitle: canonicalMediaTitle,
      season: operationalIntent.season,
      episode: operationalIntent.episode,
      source: operationalIntent.source,
      sourceType: operationalIntent.sourceType,
      sourceId: operationalIntent.sourceId,
      sourceLabel: operationalIntent.sourceLabel,
      requestedBy: null,
      priority: operationalIntent.priority,
      intentId,
      persist: true,
      hydrateVfs,
      controlPlaneStore,
      // Slice 1.75: pre-publication TorBox file identity binding.
      // When the operator has configured the TorBox provider + control
      // plane, the seam matches the selected candidate's exact per-file
      // size against the live TorBox inventory BEFORE the handoff is
      // persisted and threads the resulting torrentFileId into the
      // handoff. When the seam is absent (operator has not configured
      // a real TorBox account, e.g. tests), the search path persists
      // legacy handoffs with torrentFileId=null.
      ...(ensureTorBoxFileIdentity ? { ensureTorBoxFileIdentity } : {}),
      ...(ensureRealDebridFileIdentity ? { ensureRealDebridFileIdentity } : {}),
      // Forward the canonical Seerr detail identity (originalTitle +
      // releaseDate) so the VFS materializer builds a clean Plex-facing
      // path like Movies/Dune Part Two (2024)/Dune Part Two (2024).mkv
      // instead of inheriting the noisy provider release name.
      ...(canonicalMediaTitle ? { canonicalTitle: canonicalMediaTitle } : {}),
      ...(canonicalMediaYear != null ? { canonicalYear: canonicalMediaYear } : {}),
      // Bloodhound opt-out: a future releaseDate marks the title
      // unreleased (no live fallback); anything else defaults to
      // released.
      ...(canonicalReleaseDate ? { releaseDate: canonicalReleaseDate } : {}),
    });
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_result_count = ?, last_error = NULL WHERE id = ?'
    ).run(Date.now(), result.total ?? 0, intentId);
    // Household deferred-request tranche: zero usable candidates is not
    // a fulfillment — it is durable demand the scheduler must converge
    // on. Neither is an unbound candidate set (e.g. unreleased titles
    // with only fake/uncached rows and no provider-backed handoff).
    // Classify (future vs released vs transient) and seed a future
    // intent instead of silently dropping the human decision.
    if ((result.total ?? 0) === 0 || result.handoff == null) {
      const classification = classifySeerrDeferral({
        dateRaw: canonicalReleaseDate,
        total: result.total ?? 0,
        bound: result.handoff != null,
        selectionReason: result.selection?.reason ?? null,
        nowMs: clock(),
      });
      const deferral = deferSeerrRequest({
        store: futureIntentStore,
        mediaType: operationalIntent.mediaType,
        mediaId: operationalIntent.mediaId,
        season: operationalIntent.season,
        episode: operationalIntent.episode,
        seerrSourceId: operationalIntent.sourceId,
        classification,
      });
      if (deferral) {
        return sendJson(response, 202, {
          status: 'deferred',
          identityStatus,
          notificationType,
          intentId,
          resultCount: result.total ?? 0,
          mediaId: operationalIntent.mediaId,
          mediaType: operationalIntent.mediaType,
          imdbId: operationalIntent.imdbId,
          tmdbId: operationalIntent.tmdbId,
          tvdbId: operationalIntent.tvdbId,
          deferReason: deferral.deferReason,
          futureIntentId: deferral.futureIntentId,
          intentState: deferral.intentState,
          expectedAt: deferral.expectedAt,
          nextCheckAt: deferral.nextCheckAt,
        });
      }
    }
    return sendJson(response, 200, {
      status: 'created',
      identityStatus,
      notificationType,
      intentId,
      requestId: result.requestId ?? null,
      resultCount: result.total ?? 0,
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      imdbId: operationalIntent.imdbId,
      tmdbId: operationalIntent.tmdbId,
      tvdbId: operationalIntent.tvdbId,
    });
  } catch (err) {
    // A thrown pipeline error is either transient (provider, hydration,
    // availability — retry later via durable intent) or deterministic
    // (bad identity/mapping — fail loudly, never background-retry).
    const classification = classifySeerrDeferral({
      dateRaw: canonicalReleaseDate,
      total: null,
      error: err,
      nowMs: clock(),
    });
    const deferral = deferSeerrRequest({
      store: futureIntentStore,
      mediaType: operationalIntent.mediaType,
      mediaId: operationalIntent.mediaId,
      season: operationalIntent.season,
      episode: operationalIntent.episode,
      seerrSourceId: operationalIntent.sourceId,
      classification,
    });
    if (deferral) {
      searchCache.db.prepare(
        'UPDATE media_intents SET last_processed_at = ?, last_result_count = ?, last_error = NULL WHERE id = ?'
      ).run(Date.now(), 0, intentId);
      return sendJson(response, 202, {
        status: 'deferred',
        identityStatus,
        notificationType,
        intentId,
        resultCount: 0,
        mediaId: operationalIntent.mediaId,
        mediaType: operationalIntent.mediaType,
        imdbId: operationalIntent.imdbId,
        tmdbId: operationalIntent.tmdbId,
        tvdbId: operationalIntent.tvdbId,
        deferReason: deferral.deferReason,
        futureIntentId: deferral.futureIntentId,
        intentState: deferral.intentState,
        expectedAt: deferral.expectedAt,
        nextCheckAt: deferral.nextCheckAt,
        detail: classification.detail,
      });
    }
    searchCache.db.prepare(
      'UPDATE media_intents SET last_processed_at = ?, last_error = ? WHERE id = ?'
    ).run(Date.now(), err.message, intentId);
    return sendJson(response, 500, {
      status: 'processing-failed',
      identityStatus,
      notificationType,
      intentId,
      mediaId: operationalIntent.mediaId,
      mediaType: operationalIntent.mediaType,
      error: 'seerr-processing-failed',
      message: err.message,
    });
  }
}

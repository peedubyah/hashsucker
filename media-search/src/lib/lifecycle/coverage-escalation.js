/**
 * Storm-triggered resilience escalation (coverage-escalation tranche).
 *
 * Normal policy stays cheap (publish hook is discover-only; uncached RD
 * acquisition is never automatic there). This path escalates ONLY when
 * real playback pain is durably evidenced: a published single-provider
 * TF with fresh-or-recent temporary/terminal delivery evidence.
 *
 * Evidence TTLs are short (5-30 min) by revalidation design, so this
 * reads recency (observed_at window) rather than liveness: a storm
 * earlier today still justifies one bounded escalation attempt.
 * Backoff memory lives in provider_placement_observations
 * (source=coverage-escalation, 24h TTL): a failed/absent alternate
 * is not re-attempted for a day. No new tables, no timers of its own —
 * driven by the hourly publication tick and an internal endpoint.
 */
import { countReadyPlacements } from './upgrade-watch.js';

export const ESCALATION_SOURCE = 'coverage-escalation';
export const ESCALATION_BACKOFF_MS = 24 * 60 * 60 * 1000;
export const STORM_WINDOW_MS = 6 * 60 * 60 * 1000;

function vfsTorrents(cache) {
  const out = new Map();
  try {
    for (const e of [...(cache.listVfsMovieEntries?.() || []), ...(cache.listVfsTvEntries?.() || [])]) {
      if (e?.torrentFileId && !out.has(e.torrentFileId)) out.set(e.torrentFileId, e);
    }
  } catch {}
  return [...out.values()];
}

/**
 * Find one escalation candidate: published TF, exactly one ready
 * provider, recent temporary/terminal delivery evidence, no fresh
 * escalation observation. Prefers terminal evidence, then most recent.
 * Returns null when nothing qualifies (the common case).
 */
export function findEscalationCandidate({ cache, controlPlaneStore, nowMs = Date.now(), stormWindowMs = STORM_WINDOW_MS, limit = 200 } = {}) {
  if (!cache?.db || !controlPlaneStore?.db) throw new Error('escalation requires cache + controlPlaneStore');
  const entries = vfsTorrents(cache).slice(0, limit);
  const cands = [];
  for (const e of entries) {
    let tf = null;
    try {
      tf = controlPlaneStore.getTorrentFile?.(e.torrentFileId);
    } catch { continue; }
    if (!tf?.infoHash) continue;
    let ready = 0;
    try {
      for (const provider of ['torbox', 'realdebrid']) {
        const p = controlPlaneStore.findPlacementByInfoHash?.(provider, tf.infoHash);
        if (p && p.state === 'ready') ready++;
      }
    } catch { continue; }
    if (ready !== 1) continue;
    let ev = null;
    try {
      ev = controlPlaneStore.db.prepare(`SELECT state, reason, observed_at FROM provider_delivery_evidence
        WHERE info_hash = ? AND state IN ('temporary', 'terminal') AND observed_at >= ?
        ORDER BY observed_at DESC LIMIT 1`).get(tf.infoHash, nowMs - stormWindowMs);
    } catch { continue; }
    if (!ev) continue;
    let blocked = null;
    try {
      blocked = controlPlaneStore.db.prepare(`SELECT observed_at FROM provider_placement_observations
        WHERE info_hash = ? AND source = ? AND observed_at >= ? LIMIT 1`)
        .get(tf.infoHash, ESCALATION_SOURCE, nowMs - ESCALATION_BACKOFF_MS);
    } catch {}
    if (blocked) continue;
    cands.push({
      torrentFileId: e.torrentFileId, infoHash: tf.infoHash,
      mediaId: e.mediaId, mediaType: e.season != null ? 'episode' : 'movie',
      season: e.season ?? null, episode: e.episode ?? null,
      evidenceState: ev.state, evidenceReason: ev.reason, evidenceAt: ev.observed_at,
    });
  }
  cands.sort((a, b) => {
    const rank = (s) => (s === 'terminal' ? 0 : 1);
    return rank(a.evidenceState) - rank(b.evidenceState) || b.evidenceAt - a.evidenceAt;
  });
  return cands[0] ?? null;
}

function recordEscalationOutcome({ controlPlaneStore, candidate, outcome, nowMs }) {
  const state = outcome.status === 'created' || outcome.status === 'already_ready' ? 'present'
    : outcome.status === 'unavailable' ? 'missing' : 'error';
  try {
    controlPlaneStore.recordPlacementLookupObservation?.({
      provider: outcome.targetProvider ?? 'realdebrid',
      accountScope: 'default',
      infoHash: candidate.infoHash,
      observationState: state,
      placementId: outcome.placementId ?? null,
      observedAt: nowMs,
      expiresAt: nowMs + ESCALATION_BACKOFF_MS,
      source: ESCALATION_SOURCE,
    });
  } catch {}
}

/**
 * Run one bounded escalation: full ensure (storm justifies addMagnet
 * when discovery misses), outcome recorded as backoff memory.
 * Returns { acted, ...outcome }.
 */
export async function runCoverageEscalation({ cache, controlPlaneStore, ensurer, nowMs = Date.now(), log = () => {} } = {}) {
  if (!cache || !controlPlaneStore || !ensurer) throw new Error('escalation requires cache, controlPlaneStore, ensurer');
  const candidate = findEscalationCandidate({ cache, controlPlaneStore, nowMs });
  if (!candidate) return { acted: false, reason: 'no-candidate' };
  log(`coverage escalation ${candidate.torrentFileId} evidence=${candidate.evidenceState}:${candidate.evidenceReason}`);
  let outcome;
  try {
    outcome = await ensurer.ensureSecondPlacement({ torrentFileId: candidate.torrentFileId });
  } catch (err) {
    outcome = { status: 'error', reason: String(err?.message || err).slice(0, 120) };
  }
  recordEscalationOutcome({ controlPlaneStore, candidate, outcome, nowMs });
  return { acted: true, candidate, ...outcome };
}

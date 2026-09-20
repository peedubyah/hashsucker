/**
 * Quality-upgrade watch (quality-upgrade tranche).
 *
 * Autonomous loop over PUBLISHED items bound below terminal quality:
 * periodically re-probe the live market through the EXISTING seams and,
 * on a strictly-higher tier, switch publication to the better release.
 * The switch itself rides proven machinery (prepare upsert-replaces the
 * stored handoff; the normal republish path activates the new binding,
 * supersedes the old one, and rewrites the singular VFS row). This
 * module only decides WHEN to look and WHETHER the market winner
 * qualifies — it never selects releases itself (ranker) and never
 * serves bytes (Rust).
 *
 * Cadence is deliberately slow (default hourly, one row per tick):
 * upgrades are rare events; the loop must cost ~nothing when the
 * market has nothing better.
 */
import { tierOf, isTerminalTier, compareUpgrade, durabilityOf, shouldVetoUpgrade, DURABILITY } from './upgrade-policy.js';
import { profilePolicy } from './quality-profiles.js';
import { intentBackoffMs } from '../anticipation/future-intents.js';
import { probeByteReady } from '../anticipation/prewarm.js';
import { createLibraryIdentityKey } from '../control-plane/canonical-path.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS upgrade_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_type TEXT NOT NULL,
  media_id TEXT NOT NULL,
  season INTEGER,
  episode INTEGER,
  current_tf TEXT,
  current_tier INTEGER,
  current_label TEXT,
  last_check INTEGER,
  next_due INTEGER NOT NULL,
  last_reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upgrade_watch_identity
  ON upgrade_watch(media_id, COALESCE(season, -1), COALESCE(episode, -1));
CREATE INDEX IF NOT EXISTS idx_upgrade_watch_due ON upgrade_watch(next_due);
`;

function ensureSchema(db) {
  db.exec(SCHEMA);
}

/** Count currently-ready placements for a hash across providers.
 * Exported for tests; the evaluator calls it below. */
export function countReadyPlacements(controlPlaneStore, infoHash) {
  if (!infoHash) return 0;
  let n = 0;
  try {
    // Healthy-only bar (see placementHeld history): pending/unknown/
    // degraded placements are not evidence the household can serve
    // this hash today.
    for (const provider of ['torbox', 'realdebrid']) {
      const p = controlPlaneStore.findPlacementByInfoHash?.(provider, infoHash);
      if (p && p.state === 'ready') n++;
    }
  } catch {}
  return n;
}

/** Back-compat alias (boolean): household holds this hash iff ≥1 ready. */
export function placementHeld(controlPlaneStore, infoHash) {
  return countReadyPlacements(controlPlaneStore, infoHash) >= 1;
}

export function createUpgradeWatchStore({ db, clock = () => Date.now() } = {}) {
  if (!db) throw new Error('upgrade watch requires db');
  ensureSchema(db);
  const now = () => clock();

  function rowToWatch(r) {
    if (!r) return null;
    return { ...r };
  }

  /** Idempotent seed/converge: adopt the live binding when it moved. */
  function ensure({ mediaType, mediaId, season = null, episode = null, tf = null, tier = null, label = null, dueInMs = 0 }) {
    const t = now();
    const cur = db.prepare(`SELECT * FROM upgrade_watch
      WHERE media_id = ? AND COALESCE(season, -1) = COALESCE(?, -1) AND COALESCE(episode, -1) = COALESCE(?, -1)`)
      .get(mediaId, season, episode);
    if (!cur) {
      const info = db.prepare(`INSERT INTO upgrade_watch
        (media_type, media_id, season, episode, current_tf, current_tier, current_label,
         last_check, next_due, last_reason, attempts, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'watching', 0, ?, ?)`)
        .run(mediaType, mediaId, season, episode, tf, tier, label, null, t + dueInMs, t, t);
      return { row: rowToWatch({ ...cur, id: Number(info.lastInsertRowid) }), created: true };
    }
    // Converge, never fight: publication changed underneath (explicit
    // re-request, unpublish+republish) → adopt new truth, reset budget.
    if ((cur.current_tf ?? null) !== (tf ?? null)) {
      db.prepare(`UPDATE upgrade_watch SET current_tf = ?, current_tier = ?, current_label = ?,
        last_reason = 'adopted-new-binding', attempts = 0, next_due = ?, updated_at = ? WHERE id = ?`)
        .run(tf, tier, label, t + dueInMs, t, cur.id);
      return { row: rowToWatch({ ...cur, current_tf: tf, current_tier: tier, current_label: label }), created: false, adopted: true };
    }
    return { row: rowToWatch(cur), created: false };
  }

  function due({ limit = 3 } = {}) {
    return db.prepare('SELECT * FROM upgrade_watch WHERE next_due <= ? ORDER BY next_due LIMIT ?')
      .all(now(), limit).map(rowToWatch);
  }

  function remove(id) {
    db.prepare('DELETE FROM upgrade_watch WHERE id = ?').run(id);
  }

  function park(id, { reason = null, attempts = null } = {}) {
    const t = now();
    const cur = db.prepare('SELECT attempts FROM upgrade_watch WHERE id = ?').get(id);
    const n = attempts ?? ((cur?.attempts ?? 0) + 1);
    db.prepare(`UPDATE upgrade_watch SET last_check = ?, next_due = ?, last_reason = ?, attempts = ?, updated_at = ?
      WHERE id = ?`).run(t, t + intentBackoffMs(n), reason, n, t, id);
    return n;
  }

  function adoptNew(id, { tf, tier, label }) {
    const t = now();
    db.prepare(`UPDATE upgrade_watch SET current_tf = ?, current_tier = ?, current_label = ?,
      last_check = ?, next_due = ?, last_reason = 'upgraded', attempts = 0, updated_at = ? WHERE id = ?`)
      .run(tf, tier, label, t, t + intentBackoffMs(0), t, id);
  }

  function counts() {
    return db.prepare('SELECT COUNT(*) AS n FROM upgrade_watch').get()?.n ?? 0;
  }

  return { ensure, due, remove, park, adoptNew, counts };
}

/**
 * Read the live published truth for one identity: VFS publication TF +
 * its tier from release_attributes. Returns null when nothing usable
 * is published (caller drops the watch row). VFS-first (not bindings):
 * the VFS row IS the singular publication; bindings are verified
 * separately after a switch.
 */
export function readPublishedTier({ cache, controlPlaneStore, mediaType, mediaId, season = null, episode = null }) {
  try {
    const isEpisode = mediaType !== 'movie' && season != null;
    const key = createLibraryIdentityKey({
      mediaType: isEpisode ? 'episode' : 'movie', mediaId,
      season: isEpisode ? season : null, episode: isEpisode ? episode : null,
    });
    const item = controlPlaneStore.getLibraryItemByIdentityKey?.(key);
    if (!item || item.desiredState === 'absent') return null;
    const entry = isEpisode
      ? cache.getVfsTvEntry?.(mediaId, season, episode)
      : cache.getVfsMovieEntry?.(mediaId);
    const tfId = entry?.torrentFileId;
    if (!tfId) return null;
    const tf = controlPlaneStore.getTorrentFile?.(tfId);
    if (!tf || !tf.infoHash) return null;
    let tier = null, label = 'unknown';
    try {
      const rows = cache.db.prepare(`SELECT source_type, resolution, hdr, file_index_key FROM release_attributes
        WHERE info_hash = ?`).all(tf.infoHash);
      const row = rows.find((r) => (r.file_index_key ?? -1) === (entry.fileIndex ?? entry.file_index ?? -1))
        ?? rows.find((r) => /2160p|1080p|720p|480p/i.test(r.resolution || '') || r.source_type)
        ?? rows[0];
      if (row) {
        const t = tierOf({ sourceType: row.source_type, resolution: row.resolution, hdr: row.hdr });
        tier = t.tier; label = t.label;
      }
    } catch {}
    return { tf: tfId, tier, label, infoHash: tf.infoHash, profile: item.profile ?? null };
  } catch {
    return null;
  }
}

/** Scan VFS publication truth for below-terminal bindings; ensure watch rows. */
export function seedBelowTerminal({ cache, controlPlaneStore, store, dueInMs = 0, limit = 500 } = {}) {
  let seeded = 0, terminal = 0;
  let entries = [];
  try {
    entries = [...(cache.listVfsMovieEntries?.() || []), ...(cache.listVfsTvEntries?.() || [])];
  } catch { return { seeded, terminal }; }
  for (const e of entries.slice(0, limit)) {
    if (!e?.mediaId || !e?.torrentFileId) continue;
    const isEpisode = e.season != null && e.episode != null;
    const mediaType = isEpisode ? 'episode' : 'movie';
    let pub = null;
    try {
      pub = readPublishedTier({
        cache, controlPlaneStore, mediaType, mediaId: e.mediaId, season: e.season ?? null, episode: e.episode ?? null,
      });
    } catch { continue; }
    if (!pub) continue;
    if (isTerminalTier(pub.tier)) { terminal++; continue; }
    store.ensure({
      mediaType, mediaId: e.mediaId, season: e.season ?? null, episode: e.episode ?? null,
      tf: pub.tf, tier: pub.tier, label: pub.label, dueInMs,
    });
    seeded++;
  }
  return { seeded, terminal };
}

export function createUpgradeEvaluator({
  store, cache, controlPlaneStore, baseUrl, dataPlaneBaseUrl,
  fetchFn = fetch, clock = () => Date.now(), log = () => {},
} = {}) {
  if (!store || !cache || !controlPlaneStore || !baseUrl) throw new Error('upgrade evaluator requires store, cache, controlPlaneStore, baseUrl');
  const now = () => clock();

  async function post(path, body, timeoutMs) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${String(baseUrl).replace(/\/+$/, '')}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: ctl.signal,
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  function winnerTier(winner) {
    if (!winner) return { tier: null, label: 'no-winner' };
    const rel = winner.release || {};
    const t = tierOf({ sourceType: rel.source ?? winner.sourceType ?? null, resolution: rel.resolution ?? null, hdr: rel.hdr ?? null });
    return { ...t, filename: winner.filename ?? null, infoHash: winner.infoHash ?? null };
  }

  function sightings(infoHash) {
    const out = { firstSeen: null, lastSeen: null, sourceCount: 1, seeders: null };
    if (!infoHash) return out;
    try {
      const row = cache.db.prepare(`SELECT seeders, first_seen, last_seen, sources FROM candidates
        WHERE info_hash = ? ORDER BY last_seen DESC LIMIT 1`).get(infoHash);
      if (!row) return out;
      out.firstSeen = row.first_seen ?? null;
      out.lastSeen = row.last_seen ?? null;
      out.seeders = row.seeders ?? null;
      try {
        const srcs = JSON.parse(row.sources || '[]');
        if (Array.isArray(srcs)) {
          const ids = new Set(srcs.map((s) => s?.addonId || s?.origin || JSON.stringify(s)));
          out.sourceCount = Math.max(1, ids.size);
        }
      } catch {}
    } catch {}
    return out;
  }

  function durabilityFor({ infoHash, cacheState = null }) {
    const sight = sightings(infoHash);
    return durabilityOf({
      cacheState,
      placements: countReadyPlacements(controlPlaneStore, infoHash),
      firstSeen: sight.firstSeen,
      lastSeen: sight.lastSeen,
      sourceCount: sight.sourceCount,
      seeders: sight.seeders,
      nowMs: now(),
    });
  }

  async function probeMarket(row) {
    const body = {
      mediaId: row.media_id, mediaType: row.media_type, source: 'upgrade-watch',
      sourceType: 'upgrade-watch-probe', sourceId: `upgrade-watch:${row.id}`, persist: false,
      // Bypass the already-prepared short-circuit: sensing must run
      // fresh discovery for exactly the titles already prepared.
      forceDiscovery: true,
    };
    if (row.season != null) body.season = row.season;
    if (row.episode != null) body.episode = row.episode;
    const r = await post('/api/media-prepare', body, 5 * 60 * 1000);
    if (r.status !== 200) return { ok: false, error: r.json?.error || `probe-http-${r.status}` };
    const results = Array.isArray(r.json?.results) ? r.json.results : [];
    let sel = r.json?.selection?.selected || results[0] || null;
    if (sel) {
      // Reattach raw availability (formatted selections carry only
      // torboxState): match back into ranked rows like pickPrepareWinner.
      const raw = results.find((x) => String(x.infoHash || '').toLowerCase() === String(sel.infoHash || '').toLowerCase());
      if (raw?.availability) sel = { ...sel, availability: raw.availability };
    }
    return { ok: true, winner: sel, total: results.length };
  }

  async function prepareNew(row) {
    const body = {
      mediaId: row.media_id, mediaType: row.media_type, source: 'upgrade-watch',
      sourceType: 'upgrade-watch-prepare', sourceId: `upgrade-watch:${row.id}`,
      // Same bypass: binding the new winner requires the full pipeline,
      // not the already-prepared short-circuit (which would return the
      // OLD handoff and park as already-bound forever).
      forceDiscovery: true,
    };
    if (row.season != null) body.season = row.season;
    if (row.episode != null) body.episode = row.episode;
    const r = await post('/api/media-prepare', body, 5 * 60 * 1000);
    if (r.status !== 200 || r.json?.prepared !== true || !r.json?.handoff?.torrentFileId) {
      return { ok: false, error: r.json?.error || `prepare-http-${r.status}` };
    }
    return { ok: true, torrentFileId: r.json.handoff.torrentFileId };
  }

  async function publishNew(row) {
    const body = {
      mediaId: row.media_id, mediaType: row.media_type, source: 'upgrade-watch',
      sourceType: 'upgrade-watch-publish', sourceId: `upgrade-watch:${row.id}`,
    };
    if (row.season != null) body.season = row.season;
    if (row.episode != null) body.episode = row.episode;
    const r = await post('/api/media-request', body, 5 * 60 * 1000);
    if (r.status !== 200 || !r.json?.handoff?.torrentFileId) {
      return { ok: false, error: r.json?.error || `publish-http-${r.status}` };
    }
    return { ok: true, torrentFileId: r.json.handoff.torrentFileId, reuseMode: r.json.reuseMode ?? null };
  }

  function readVfsTf(row) {
    try {
      const isEpisode = row.media_type !== 'movie' && row.season != null;
      const entry = isEpisode
        ? cache.getVfsTvEntry?.(row.media_id, row.season, row.episode)
        : cache.getVfsMovieEntry?.(row.media_id);
      return entry?.torrentFileId ?? entry?.torrent_file_id ?? null;
    } catch { return null; }
  }

  /** Binding audit after a switch: exactly one active binding, on the new TF's hash. */
  function verifyBindingSwitch(row, newTfId) {
    try {
      const isEpisode = row.media_type !== 'movie' && row.season != null;
      const key = createLibraryIdentityKey({
        mediaType: isEpisode ? 'episode' : 'movie', mediaId: row.media_id,
        season: isEpisode ? row.season : null, episode: isEpisode ? row.episode : null,
      });
      const item = controlPlaneStore.getLibraryItemByIdentityKey?.(key);
      if (!item) return { ok: false, detail: 'no-library-item' };
      const all = controlPlaneStore.listBindings?.(item.id) || [];
      const active = all.filter((b) => b.status === 'active');
      const newTf = controlPlaneStore.getTorrentFile?.(newTfId);
      const onNew = active.filter((b) =>
        String(b.infoHash || '').toLowerCase() === String(newTf?.infoHash || '').toLowerCase());
      const retired = all.filter((b) => b.status === 'superseded').length;
      if (active.length === 1 && onNew.length === 1) return { ok: true, detail: `superseded=${retired}` };
      return { ok: false, detail: `active=${active.length} onNew=${onNew.length}` };
    } catch (err) {
      return { ok: false, detail: `verify-error:${String(err?.message || err).slice(0, 60)}` };
    }
  }

  /** Evaluate one due row. Returns an outcome descriptor (acted or parked). */
  async function evaluate(row) {
    const t0 = now();
    const done = (extra) => ({ rowId: row.id, media: row.media_id, ms: now() - t0, ...extra });
    // 1. Converge on live publication first (never fight user action).
    const pub = readPublishedTier({
      cache, controlPlaneStore,
      mediaType: row.media_type, mediaId: row.media_id, season: row.season, episode: row.episode,
    });
    if (!pub) {
      store.remove(row.id);
      return done({ acted: true, to: 'removed', reason: 'no-active-publication' });
    }
    if ((pub.tf ?? null) !== (row.current_tf ?? null)) {
      store.ensure({
        mediaType: row.media_type, mediaId: row.media_id, season: row.season, episode: row.episode,
        tf: pub.tf, tier: pub.tier, label: pub.label, dueInMs: 60 * 60 * 1000,
      });
      return done({ acted: true, to: 'adopted', reason: 'binding-changed-underneath' });
    }
    if (isTerminalTier(pub.tier)) {
      store.remove(row.id);
      return done({ acted: true, to: 'removed', reason: 'reached-terminal' });
    }
    // Profile terminal (quality-profile tranche): at/above the intent's
    // terminal tier the row parks (never churns, never removed — removal
    // is reserved for the global terminal, so a profile change back to
    // a higher terminal re-arms without reseeding).
    const policy = profilePolicy(pub.profile);
    if (policy.terminalTier != null && pub.tier != null && pub.tier >= policy.terminalTier) {
      store.park(row.id, { reason: `profile-terminal:${pub.profile ?? 'balanced'}` });
      return done({ acted: false, reason: 'profile-terminal' });
    }
    // 2. Probe the live market (zero writes) and gate on tier.
    let probe;
    try {
      probe = await probeMarket(row);
    } catch (err) {
      store.park(row.id, { reason: `probe-error:${String(err?.message || err).slice(0, 80)}` });
      return done({ acted: false, reason: 'probe-error' });
    }
    if (!probe.ok) {
      store.park(row.id, { reason: `probe-error:${probe.error}` });
      return done({ acted: false, reason: 'probe-error' });
    }
    if (!probe.winner) {
      store.park(row.id, { reason: 'market-empty' });
      return done({ acted: false, reason: 'market-empty' });
    }
    const cand = winnerTier(probe.winner);
    const verdict = compareUpgrade(
      { tier: pub.tier, label: pub.label ?? row.current_label },
      { tier: cand.tier, label: cand.label },
    );
    if (!verdict.upgrade) {
      store.park(row.id, { reason: verdict.reason });
      return done({ acted: false, reason: verdict.reason });
    }
    // Durability veto (durability tranche): a fragile winner replaces a
    // strong current only on a large quality jump. Marginal upgrades
    // need equal-or-better durability — they park until the winner
    // proves itself (cached, placed, or seen over time). The byte probe
    // later still verifies actual servability; this veto guards future
    // persistence, not present availability.
    {
      const av = probe.winner?.availability || {};
      const tb = av.torbox; const tbState = (tb && typeof tb === 'object' ? tb.state : tb)
        ?? probe.winner?.torboxState ?? null;
      const rd = av.realdebrid ?? av.real_debrid ?? av.rd;
      const rdState = (rd && typeof rd === 'object' ? (rd.state ?? rd.cached) : rd) ?? null;
      const cacheState = tbState === 'cached' || rdState === 'cached' || rdState === true ? 'cached'
        : (tbState === 'uncached' ? 'uncached' : 'unknown');
      const winnerDur = durabilityFor({ infoHash: cand.infoHash, cacheState });
      const curTf = controlPlaneStore.getTorrentFile?.(row.current_tf);
      const curDur = durabilityFor({ infoHash: curTf?.infoHash ?? curTf?.info_hash ?? null, cacheState: null });
      const tierDelta = (pub.tier != null && cand.tier != null) ? cand.tier - pub.tier : null;
      const veto = shouldVetoUpgrade({ currentDur: curDur.level, winnerDur: winnerDur.level, tierDelta,
        vetoDelta: profilePolicy(pub.profile).vetoDelta });
      if (veto.veto) {
        const reason = `durability-veto:${veto.reason}(winner ${winnerDur.level} [${winnerDur.reasons.join(',')}] vs current ${curDur.level})`;
        store.park(row.id, { reason });
        log(`upgrade veto media=${row.media_id} ${row.current_label} -> ${cand.label}: ${reason}`);
        return done({ acted: false, reason: 'durability-veto' });
      }
    }
    // 3. Bind the better release through the real prepare seam.
    const prep = await prepareNew(row);
    if (!prep.ok) {
      store.park(row.id, { reason: `prepare-failed:${prep.error}` });
      return done({ acted: false, reason: 'prepare-failed' });
    }
    if (prep.torrentFileId === row.current_tf) {
      store.park(row.id, { reason: 'already-bound' });
      return done({ acted: false, reason: 'already-bound' });
    }
    // 4. Provider readiness BEFORE touching publication: the new TF must
    //    serve bytes, else the healthy current media stays (unavailable
    //    "better" candidates never replace working playback).
    let ready = false;
    try {
      if (dataPlaneBaseUrl) ready = await probeByteReady({ dataPlaneBaseUrl, torrentFileId: prep.torrentFileId, fetchFn });
    } catch { ready = false; }
    if (!ready) {
      store.park(row.id, { reason: 'not-byte-ready' });
      return done({ acted: false, reason: 'not-byte-ready' });
    }
    // 5. Switch via the normal republish seam (prepared truth now points
    //    at the new TF, so reuse detects the divergence and republishes;
    //    old binding supersedes, VFS row rewrites singularly).
    const pub2 = await publishNew(row);
    if (!pub2.ok) {
      store.park(row.id, { reason: `publish-failed:${pub2.error}` });
      return done({ acted: false, reason: 'publish-failed' });
    }
    const vfsTf = readVfsTf(row);
    if (vfsTf !== prep.torrentFileId) {
      store.park(row.id, { reason: 'switch-unconfirmed' });
      return done({ acted: false, reason: 'switch-unconfirmed' });
    }
    const bind = verifyBindingSwitch(row, prep.torrentFileId);
    store.adoptNew(row.id, { tf: prep.torrentFileId, tier: cand.tier, label: cand.label });
    log(`upgrade switched media=${row.media_id} ${row.current_label} -> ${cand.label} tf=${prep.torrentFileId} binding=${bind.ok ? bind.detail : `UNCONFIRMED:${bind.detail}`}`);
    return done({ acted: true, to: 'upgraded', from: row.current_tf, tf: prep.torrentFileId, tier: cand.tier, binding: bind });
  }

  /** Seed below-terminal rows, then evaluate a single due row. */
  async function tickOnce({ seedLimit = 500 } = {}) {
    const seed = seedBelowTerminal({ cache, controlPlaneStore, store, dueInMs: 0, limit: seedLimit });
    const dueList = store.due({ limit: 1 });
    if (dueList.length === 0) return { acted: false, seeded: seed.seeded };
    try {
      const outcome = await evaluate(dueList[0]);
      return { ...outcome, seeded: seed.seeded };
    } catch (err) {
      store.park(dueList[0].id, { reason: `tick-error:${String(err?.message || err).slice(0, 80)}` });
      return { acted: false, reason: 'tick-error', seeded: seed.seeded };
    }
  }

  return { evaluate, tickOnce, seedBelowTerminal, readPublishedTier, winnerTier };
}

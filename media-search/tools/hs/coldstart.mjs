#!/usr/bin/env node
/**
 * COLD START, SMALL — the pre-first-frame Range traffic, with the chunk
 * accounting.
 *
 * The question is narrow: the player's whole-file request makes HashSucker
 * claim hundreds or thousands of fixed-grid chunks before the first frame,
 * while the player itself needs a handful. Does filling and evicting the
 * unnecessary ones materially delay the reads the player actually waits for?
 *
 * This measures, per run, ONLY the traffic before the first frame:
 *
 *   - every byte request the player made, with its Range, cache state,
 *     the chunks HashSucker claimed for it, the provider's dispatch and
 *     first byte, the first byte to the client, and the bytes delivered;
 *   - the data plane's counter deltas across the run: bytes fetched
 *     upstream, chunk fills, failed fills, evictions, bytes evicted;
 *   - the player's own first frame.
 *
 * Usage:
 *   node tools/hs/coldstart.mjs --fixture "label=intent" [--fixture ...]
 *                              [--runs N] [--out FILE]
 */

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { decisionsSince, metricSnapshot, readDataPlaneMetrics } from './data-plane.mjs';

const args = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const runs = Number.parseInt(argValue('--runs', '2'), 10);
const measureSeconds = Number.parseFloat(argValue('--measure', '1'));
const server = argValue('--server', null);
const outPath = argValue('--out', null);
const dataPlaneUrl = argValue('--data-plane', process.env.HS_DATA_PLANE_URL ?? null);
const fixtures = args
  .map((a, i) => (a === '--fixture' ? args[i + 1] : null))
  .filter(Boolean)
  .map((spec) => {
    const [label, intent] = spec.split('=');
    const [mediaId, season, episode] = intent.split(':');
    return { label, intent, mediaId, season: season ? Number(season) : null, episode: episode ? Number(episode) : null };
  });

if (fixtures.length === 0) {
  console.error('usage: node tools/hs/coldstart.mjs --fixture "label=intent" [--fixture ...]');
  process.exit(2);
}

/** The decision entry that matches a byte request's Range. */
function decisionFor(decisions, range) {
  if (!range) return null;
  return decisions.find((d) => d?.request
    && d.request.start === range.start
    && d.request.end === range.end) ?? null;
}

function delta(before, after) {
  const out = {};
  for (const key of Object.keys(after)) {
    if (typeof after[key] !== 'number') continue;
    out[key] = after[key] - (before[key] ?? 0);
  }
  return out;
}

const results = [];

for (const fixture of fixtures) {
  const client = ['tools/hs/main.mjs', 'play', fixture.mediaId];
  if (fixture.season != null) client.push('--season', String(fixture.season));
  if (fixture.episode != null) client.push('--episode', String(fixture.episode));
  client.push('--json', '--measure', String(measureSeconds));
  if (server) client.push('--server', server);

  const runData = [];
  for (let i = 0; i < runs; i += 1) {
    const before = readDataPlaneMetrics({ url: dataPlaneUrl });
    const beforeSnap = metricSnapshot(before);
    const started = Date.now();
    let payload = null;
    try {
      const stdout = execFileSync('node', client, { encoding: 'utf8', timeout: 900_000, stdio: ['ignore', 'pipe', 'pipe'] });
      payload = JSON.parse(stdout);
    } catch (error) {
      const stdout = error.stdout ?? '';
      try { payload = JSON.parse(stdout); } catch { payload = { error: String(error.message).slice(0, 200) }; }
    }
    const wallMs = Date.now() - started;
    const after = readDataPlaneMetrics({ url: dataPlaneUrl });
    const afterSnap = metricSnapshot(after);
    const decisions = decisionsSince(before, after);

    const waterfall = payload?.waterfall ?? null;
    const requests = (waterfall?.byteRequests ?? []).map((r) => {
      const decision = decisionFor(decisions, r.range);
      const claimed = decision?.chunk_indices?.length ?? null;
      return {
        range: r.range,
        cacheHit: r.cacheHit,
        cdnRequests: r.cdnRequests,
        provider: r.provider,
        chunksClaimed: claimed,
        chunksMissing: decision?.missing
          ? Math.ceil((decision.missing.end - decision.missing.start + 1) / (8 * 1024 * 1024))
          : null,
        missingBytes: decision?.missing_bytes ?? null,
        presentBefore: decision?.present_before?.length ?? null,
        joinedExistingFill: decision?.joined_inflight ?? null,
        planOrigin: decision?.plan_origin ?? null,
        evictionsBefore: decision?.evictions_before ?? null,
        providerDispatchMs: r.t3DispatchedMs ?? null,
        providerFirstByteMs: r.t4FirstUpstreamByteMs ?? null,
        firstByteToClientMs: r.t5FirstClientByteMs ?? null,
        termination: r.termination ?? null,
        bytesDelivered: r.bytesDelivered ?? null,
        attempts: r.attempts,
      };
    });

    runData.push({
      wallMs,
      sessionId: payload?.sessionId ?? null,
      warm: payload?.warm ?? null,
      played: payload?.firstSourceSuccess ?? false,
      firstFrameMs: payload?.firstFrameMs ?? null,
      totalMs: waterfall?.totalMs ?? null,
      cacheClass: requests[0]
        ? (requests[0].cacheHit ? 'hot' : 'cold')
        : null,
      requests,
      dataPlaneDelta: delta(beforeSnap, afterSnap),
      error: payload?.error ?? null,
    });
  }
  results.push({ fixture: fixture.label, intent: fixture.intent, runs: runData });
}

if (outPath) writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
if (has('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const f of results) {
    console.log(`\n=== ${f.fixture} (${f.intent})`);
    for (const [i, r] of f.runs.entries()) {
      console.log(`  run${i}: firstFrame=${r.firstFrameMs}ms total=${r.totalMs}ms played=${r.played} cache=${r.cacheClass} wall=${r.wallMs}ms`);
      const d = r.dataPlaneDelta ?? {};
      console.log(`     data plane: fetched=${d.bytesFetchedUpstream} fills=${d.chunkFills} failed=${d.chunkFillsFailed} evictions=${d.evictions} evictedBytes=${d.bytesEvicted} claims=${d.chunkClaims} takeovers=${d.demandChunkTakeovers}`);
      for (const req of r.requests) {
        console.log(`     REQ ${req.range?.start}..${req.range?.end} hit=${req.cacheHit} claimed=${req.chunksClaimed} missingBytes=${req.chunksMissing} joined=${req.joinedExistingFill} origin=${req.planOrigin} t3=${req.providerDispatchMs} t4=${req.providerFirstByteMs} t5=${req.firstByteToClientMs} term=${req.termination} bytes=${req.bytesDelivered}`);
      }
    }
  }
}

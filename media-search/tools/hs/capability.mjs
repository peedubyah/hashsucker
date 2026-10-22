#!/usr/bin/env node
/**
 * START FAST: CAPABILITY + PERMIT PATH — the capability-acquisition cohort.
 *
 * The question is narrow: HOW OFTEN is a capability acquisition slow, and
 * WHEN it is slow, WHERE does the time go?
 *
 * "The provider API took 26 s" is not a bucket. This measures, per byte
 * request:
 *
 *   - the acquisition window (T1 -> T2) and its own breakdown: the provider
 *     API time, the local permit wait, the single-flight (in-flight dedupe)
 *     wait, and any throttle cooldown;
 *   - whether the capability was REUSED (an existing, still-valid one) or
 *     freshly ACQUIRED (a provider call was paid for);
 *   - which provider endpoints were called, and for how long each;
 *   - the permit's HOLD side: how long the capability's maxInFlight permit
 *     was held once taken (the data plane's own counters);
 *   - the player's first frame.
 *
 * The result is a DISTRIBUTION (p50 / p95 / max / count over a threshold),
 * not an anecdote.
 *
 * Usage:
 *   node tools/hs/capability.mjs --fixture "label=intent" [--fixture ...]
 *                               [--runs N] [--out FILE]
 */

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { readDataPlaneMetrics } from './data-plane.mjs';

const args = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const runs = Number.parseInt(argValue('--runs', '1'), 10);
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
    return {
      label,
      intent,
      mediaId,
      season: season ? Number(season) : null,
      episode: episode ? Number(episode) : null,
    };
  });

if (fixtures.length === 0) {
  console.error('usage: node tools/hs/capability.mjs --fixture "label=intent" [--fixture ...]');
  process.exit(2);
}

/** The data plane's stage reports for one session, oldest first. */
function stagesForSession(metrics, sessionId) {
  const list = Array.isArray(metrics?.stages_recent) ? metrics.stages_recent : [];
  return list
    .filter((r) => r?.corr_id === sessionId)
    .sort((a, b) => (a?.T0_wall_ms ?? 0) - (b?.T0_wall_ms ?? 0));
}

/** The permit counters, before/after a run. */
function permitSnapshot(metrics) {
  const p = metrics?.permit ?? {};
  const t = metrics?.timing ?? {};
  return {
    permitHolds: Number(p.holds ?? 0),
    permitHoldMsTotal: Number(p.hold_ms_total ?? 0),
    permitHoldMsMax: Number(p.hold_ms_max ?? 0),
    permitWaitMsMax: Number(p.wait_ms_max ?? 0),
    limiterWaitMsTotal: Number(t.limiter_wait_ms_total ?? 0),
    limiterPermitWaits: Number(metrics?.limiter_permit_waits ?? 0),
    capabilityAcquisitions: Number(metrics?.capability?.acquisitions ?? 0),
    capabilityReuses: Number(metrics?.capability?.reuses ?? 0),
    apiRequests: Number(metrics?.layer_A_api?.requests ?? 0),
    apiLatencyAvg: Number(metrics?.layer_A_api?.latency_ms_avg ?? 0),
  };
}

function delta(before, after) {
  const out = {};
  for (const key of Object.keys(after)) {
    if (typeof after[key] !== 'number') continue;
    out[key] = after[key] - (before[key] ?? 0);
  }
  return out;
}

/** One acquisition, flattened for the report. */
function flattenAcquisition(a) {
  return {
    provider: a?.provider ?? null,
    outcome: a?.outcome ?? null,
    totalMs: a?.total_ms ?? null,
    apiCalls: a?.api_calls ?? null,
    apiMs: a?.api_ms ?? null,
    permitWaitMs: a?.permit_wait_ms ?? null,
    cooldownMs: a?.cooldown_ms ?? null,
    inflightWaitMs: a?.inflight_wait_ms ?? null,
    poolSize: a?.pool_size ?? null,
    poolTarget: a?.pool_target ?? null,
    capId: a?.cap_id ?? null,
    apiDetail: (a?.api_detail ?? []).map((c) => ({
      endpoint: c?.endpoint ?? null,
      provider: c?.provider ?? null,
      ms: c?.ms ?? null,
      status: c?.status ?? null,
      timedOut: c?.timed_out ?? false,
    })),
  };
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
    const beforePermit = permitSnapshot(before);
    let payload = null;
    try {
      const stdout = execFileSync('node', client, {
        encoding: 'utf8',
        timeout: 900_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      payload = JSON.parse(stdout);
    } catch (error) {
      const stdout = error.stdout ?? '';
      try {
        payload = JSON.parse(stdout);
      } catch {
        payload = { error: String(error.message).slice(0, 200) };
      }
    }
    const after = readDataPlaneMetrics({ url: dataPlaneUrl });
    const afterPermit = permitSnapshot(after);

    const sessionId = payload?.sessionId ?? null;
    const stages = stagesForSession(after, sessionId);
    const requests = stages.map((r) => ({
      range: r?.request ?? null,
      cacheHit: r?.cache_hit ?? null,
      workClass: r?.work_class ?? null,
      provider: r?.provider || null,
      // The acquisition window and its own breakdown.
      acquisitionApiMs: r?.acquisition_api_ms ?? null,
      acquisitions: (r?.acquisitions ?? []).map(flattenAcquisition),
      apiRequests: r?.api_requests_delta ?? null,
      providerTtfbMs: r?.provider_ttfb_ms ?? null,
      firstByteToClientMs: r?.T5_first_client_byte_ms ?? null,
      termination: r?.termination ?? null,
      bytesDelivered: r?.bytes_delivered ?? null,
    }));

    runData.push({
      sessionId,
      played: payload?.firstSourceSuccess ?? false,
      firstFrameMs: payload?.firstFrameMs ?? null,
      error: payload?.error ?? null,
      requests,
      permitDelta: delta(beforePermit, afterPermit),
      permitAfter: afterPermit,
    });
  }
  results.push({ fixture: fixture.label, intent: fixture.intent, runs: runData });
}

if (outPath) writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);

/** The distribution helpers the slice asks for. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

if (has('--json')) {
  console.log(JSON.stringify(results, null, 2));
} else {
  // The distribution over every acquisition in the cohort.
  const allAcquisitions = [];
  for (const f of results) {
    for (const r of f.runs) {
      for (const req of r.requests) {
        for (const a of req.acquisitions) {
          allAcquisitions.push({ ...a, fixture: f.fixture, firstFrameMs: r.firstFrameMs });
        }
      }
    }
  }
  const windows = [];
  for (const f of results) {
    for (const r of f.runs) {
      for (const req of r.requests) {
        if (Number.isFinite(req.acquisitionApiMs)) {
          windows.push({ ms: req.acquisitionApiMs, fixture: f.fixture, firstFrameMs: r.firstFrameMs });
        }
      }
    }
  }
  const w = windows.map((x) => x.ms);
  console.log('\n=== ACQUISITION WINDOWS (T1 -> T2), per byte request ===');
  console.log(`  n=${w.length} p50=${percentile(w, 50)}ms p95=${percentile(w, 95)}ms max=${Math.max(...w, 0)}ms`);
  console.log(`  >1s=${w.filter((x) => x > 1000).length}  >5s=${w.filter((x) => x > 5000).length}  >10s=${w.filter((x) => x > 10000).length}`);
  const slow = windows.filter((x) => x.ms > 1000).sort((a, b) => b.ms - a.ms);
  if (slow.length) {
    console.log('\n  slow windows (>1s):');
    for (const s of slow.slice(0, 12)) {
      console.log(`    ${s.fixture} ${s.ms}ms firstFrame=${s.firstFrameMs}ms`);
    }
  }
  console.log('\n=== ACQUISITION BREAKDOWN ===');
  const byOutcome = new Map();
  for (const a of allAcquisitions) {
    const key = a.outcome ?? 'unknown';
    if (!byOutcome.has(key)) byOutcome.set(key, []);
    byOutcome.get(key).push(a);
  }
  for (const [outcome, list] of byOutcome) {
    const tot = list.map((a) => a.totalMs ?? 0);
    console.log(`  ${outcome}: n=${list.length} p50=${percentile(tot, 50)}ms max=${Math.max(...tot, 0)}ms`);
  }
  const permitWaits = allAcquisitions.map((a) => a.permitWaitMs ?? 0).filter((x) => x > 0);
  const apiTimes = allAcquisitions.map((a) => a.apiMs ?? 0).filter((x) => x > 0);
  const inflight = allAcquisitions.map((a) => a.inflightWaitMs ?? 0).filter((x) => x > 0);
  console.log(`  permit waits: n=${permitWaits.length} p50=${percentile(permitWaits, 50)}ms max=${Math.max(...permitWaits, 0)}ms`);
  console.log(`  provider api: n=${apiTimes.length} p50=${percentile(apiTimes, 50)}ms max=${Math.max(...apiTimes, 0)}ms`);
  console.log(`  single-flight waits: n=${inflight.length} p50=${percentile(inflight, 50)}ms max=${Math.max(...inflight, 0)}ms`);

  console.log('\n=== PER FIXTURE ===');
  for (const f of results) {
    for (const [i, r] of f.runs.entries()) {
      const p = r.permitDelta;
      console.log(`  ${f.fixture} run${i}: firstFrame=${r.firstFrameMs}ms played=${r.played}`);
      console.log(`     permit: holds=+${p.permitHolds} holdMsTotal=+${p.permitHoldMsTotal} holdMsMax=${r.permitAfter.permitHoldMsMax} waitMsMax=${r.permitAfter.permitWaitMsMax} permitWaits=+${p.limiterPermitWaits}`);
      for (const req of r.requests) {
        const acqs = req.acquisitions.map((a) => `${a.outcome}(api=${a.apiMs}ms/${a.apiCalls} permit=${a.permitWaitMs}ms inflight=${a.inflightWaitMs}ms pool=${a.poolSize}/${a.poolTarget})`).join(' + ');
        console.log(`     REQ ${req.range?.start}..${req.range?.end} ${req.workClass} acq=${req.acquisitionApiMs}ms ttfb=${req.providerTtfbMs} term=${req.termination} bytes=${req.bytesDelivered} :: ${acqs || 'no acquisition'}`);
      }
    }
  }
}

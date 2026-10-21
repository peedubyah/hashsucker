#!/usr/bin/env node
/**
 * THE FAST/SLOW COHORT.
 *
 * The waterfall says where the seconds were for ONE playback. The cohort
 * asks the same question across the shapes that matter, so the tail can be
 * characterised before anything is changed:
 *
 *   warm-movie        a movie already bound and already cached
 *   warm-episode      an episode of a bound series
 *   byte-cold-movie   a movie whose BYTES are not in the cache
 *   byte-cold-episode an episode whose bytes are not in the cache
 *   dual-route        a file with two provider routes
 *   large-file        a very large file
 *   season-pack       an episode inside a multi-file pack
 *
 * Every run records the canonical waterfall, so the cohort is a set of
 * waterfalls, not a set of numbers: any slow run can be re-read stage by
 * stage.
 *
 * Usage:
 *   node tools/hs/cohort.mjs --runs 3 --out /tmp/cohort.json \
 *     --fixture "warm-movie=tt10986410" ...
 */

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const runs = Number.parseInt(argValue('--runs', '3'), 10);
const measureSeconds = Number.parseFloat(argValue('--measure', '2'));
const server = argValue('--server', null);
const asJson = has('--json');
const outPath = argValue('--out', null);
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
  console.error('usage: node tools/hs/cohort.mjs --runs N --fixture "label=intent" [--fixture ...]');
  process.exit(2);
}

function percentile(values, p) {
  const sorted = [...values].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/** The stages of a waterfall, as a map of stage -> gap from the previous one. */
function gapsOf(waterfall) {
  const out = {};
  for (const stage of waterfall?.stages ?? []) out[stage.stage] = stage.gapMs;
  return out;
}

const results = [];

for (const fixture of fixtures) {
  const client = ['tools/hs/main.mjs', 'play', fixture.mediaId];
  if (fixture.season != null) client.push('--season', String(fixture.season));
  if (fixture.episode != null) client.push('--episode', String(fixture.episode));
  client.push('--json', '--measure', String(measureSeconds));
  if (server) client.push('--server', server);

  const runsData = [];
  for (let i = 0; i < runs; i += 1) {
    const started = Date.now();
    let payload = null;
    try {
      const stdout = execFileSync('node', client, { encoding: 'utf8', timeout: 900_000, stdio: ['ignore', 'pipe', 'pipe'] });
      payload = JSON.parse(stdout);
    } catch (error) {
      const stdout = error.stdout ?? '';
      try { payload = JSON.parse(stdout); } catch { payload = { error: String(error.message).slice(0, 200) }; }
    }
    const waterfall = payload?.waterfall ?? null;
    const gaps = gapsOf(waterfall);
    // The cache state of the FIRST byte request, honestly classified: a
    // label of "cached" says nothing about WHICH bytes were hot.
    const firstByteReq = (waterfall?.byteRequests ?? [])[0] ?? null;
    const cacheClass = firstByteReq
      ? (firstByteReq.cacheHit
        ? (firstByteReq.cdnRequests > 0 ? 'hot-body' : 'hot-metadata-only')
        : (firstByteReq.cdnRequests > 0 ? 'cold-body' : 'cold-unknown'))
      : null;
    runsData.push({
      wallMs: Date.now() - started,
      sessionId: payload?.sessionId ?? null,
      warm: payload?.warm ?? null,
      firstSourceSuccess: payload?.firstSourceSuccess ?? false,
      resolverMs: payload?.resolverMs ?? null,
      playerStartupMs: payload?.playerStartupMs ?? null,
      firstFrameMs: payload?.firstFrameMs ?? null,
      totalMs: waterfall?.totalMs ?? null,
      cacheClass,
      byteRequests: (waterfall?.byteRequests ?? []).map((r) => ({
        range: r.range, cacheHit: r.cacheHit, cdnRequests: r.cdnRequests,
        provider: r.provider, t3: r.t3DispatchedMs, t4: r.t4FirstUpstreamByteMs,
        t5: r.t5FirstClientByteMs, termination: r.termination, bytes: r.bytesDelivered,
        attempts: (r.attempts ?? []).map((a) => ({
          attempt: a.attempt, host: a.host, status: a.status, headersMs: a.headersMs,
          ttfbMs: a.ttfbMs, bodyMs: a.bodyMs, bytes: a.bytes, outcome: a.outcome,
        })),
      })),
      gaps,
      buckets: (waterfall?.buckets ?? []).map((b) => ({
        after: b.after, before: b.before, gapMs: b.gapMs, owner: b.owner,
      })),
      missingStages: waterfall?.missingStages ?? null,
      error: payload?.error ?? null,
      code: payload?.code ?? null,
    });
  }

  const ok = runsData.filter((r) => r.firstSourceSuccess);
  const gapSeries = (stage) => ok.map((r) => r.gaps?.[stage]).filter((v) => Number.isFinite(v));
  const stageStats = {};
  for (const stage of new Set(ok.flatMap((r) => Object.keys(r.gaps ?? {})))) {
    const values = gapSeries(stage);
    stageStats[stage] = {
      p50: percentile(values, 50),
      p95: percentile(values, 95),
      max: values.length ? Math.max(...values) : null,
    };
  }
  // The cache-state split, which is what makes a "slow" run explicable.
  const byCacheClass = {};
  for (const r of ok) {
    const key = r.cacheClass ?? 'unknown';
    byCacheClass[key] = (byCacheClass[key] ?? 0) + 1;
  }

  results.push({
    fixture: fixture.label,
    intent: fixture.intent,
    runs: runsData.length,
    successes: ok.length,
    warm: runsData[0]?.warm ?? null,
    totalMs: { p50: percentile(ok.map((r) => r.totalMs), 50), p95: percentile(ok.map((r) => r.totalMs), 95), max: ok.length ? Math.max(...ok.map((r) => r.totalMs)) : null },
    firstFrameMs: { p50: percentile(ok.map((r) => r.firstFrameMs), 50), p95: percentile(ok.map((r) => r.firstFrameMs), 95), max: ok.length ? Math.max(...ok.map((r) => r.firstFrameMs)) : null },
    stages: stageStats,
    byCacheClass,
    buckets: runsData.map((r) => r.buckets),
    missingStages: runsData.map((r) => r.missingStages),
    errors: runsData.filter((r) => r.error).map((r) => `${r.code ?? 'ERROR'}: ${String(r.error).slice(0, 90)}`),
    runDetail: runsData,
  });
}

if (outPath) writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`\n${r.fixture}  (${r.intent})  warm=${r.warm}  ${r.successes}/${r.runs} played`);
    console.log(`  total ms      p50 ${r.totalMs.p50}  p95 ${r.totalMs.p95}  max ${r.totalMs.max}`);
    console.log(`  first frame   p50 ${r.firstFrameMs.p50}  p95 ${r.firstFrameMs.p95}  max ${r.firstFrameMs.max}`);
    console.log(`  cache class   ${JSON.stringify(r.byCacheClass)}`);
    for (const [stage, s] of Object.entries(r.stages)) {
      console.log(`  ${stage.padEnd(26)} p50 ${String(s.p50).padStart(7)}  p95 ${String(s.p95).padStart(7)}  max ${String(s.max).padStart(7)}`);
    }
    if (r.errors.length) console.log(`  errors        ${r.errors.slice(0, 2).join(' | ')}`);
  }
}

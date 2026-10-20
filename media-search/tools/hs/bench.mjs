#!/usr/bin/env node
/**
 * The measurement harness for the resolver-first path.
 *
 * It runs the client as a user would (`hs play <intent>`) and records, per
 * run: the manual actions, the resolver attempts, whether the first source
 * succeeded, and where the time went — resolution, player startup, first
 * frame.
 *
 * The same fields are what a later product benchmark (against Stremio, say)
 * needs, so the shape is deliberately fixed now:
 *
 *   manualActions        how many times the user had to choose something
 *   resolverAttempts     how many times the server was asked
 *   firstSourceSuccess   did playback actually start
 *   resolverMs           HashSucker's own latency (intent → playback URL)
 *   playerStartupMs      the player's own latency (launch → media loaded)
 *   firstFrameMs         the player's own latency (launch → first frame)
 *
 * Usage:
 *   node tools/hs/bench.mjs --runs 10 --fixture "label=tt0021749" ...
 *   node tools/hs/bench.mjs --runs 3 --json --out /tmp/bench.json \
 *     --fixture "warm-movie=tt0021749" --fixture "warm-episode=tt26545992:1:5"
 *
 * A fixture is `label=intent`, where the intent may be a media id or a
 * `mediaId:season:episode` triple for a series.
 */

import { writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const argValue = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const has = (name) => args.includes(name);

const runs = Number.parseInt(argValue('--runs', '10'), 10);
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
    return { label, intent, mediaId, season: season ? Number(season) : null, episode: episode ? Number(episode) : null };
  });

if (fixtures.length === 0) {
  console.error('usage: node tools/hs/bench.mjs --runs N --fixture "label=intent" [--fixture ...]');
  process.exit(2);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const clientArgs = ['tools/hs/main.mjs', 'play'];
const results = [];

for (const fixture of fixtures) {
  const client = [...clientArgs];
  client.push(fixture.mediaId);
  if (fixture.season != null) client.push('--season', String(fixture.season));
  if (fixture.episode != null) client.push('--episode', String(fixture.episode));
  client.push('--json', '--measure', String(measureSeconds));
  if (server) client.push('--server', server);

  const runsData = [];
  for (let i = 0; i < runs; i += 1) {
    const started = Date.now();
    let payload;
    try {
      const stdout = execFileSync('node', client, { encoding: 'utf8', timeout: 900_000, stdio: ['ignore', 'pipe', 'pipe'] });
      payload = JSON.parse(stdout);
    } catch (error) {
      const stdout = error.stdout ?? '';
      try { payload = JSON.parse(stdout); } catch { payload = { error: String(error.message).slice(0, 200) }; }
    }
    runsData.push({
      wallMs: Date.now() - started,
      manualActions: payload.manualActions ?? null,
      resolverAttempts: payload.resolverAttempts ?? null,
      firstSourceSuccess: payload.firstSourceSuccess ?? false,
      resolverMs: payload.resolverMs ?? null,
      playerStartupMs: payload.playerStartupMs ?? null,
      firstFrameMs: payload.firstFrameMs ?? null,
      warm: payload.warm ?? null,
      error: payload.error ?? null,
      code: payload.code ?? null,
    });
  }
  const ok = runsData.filter((r) => r.firstSourceSuccess);
  results.push({
    fixture: fixture.label,
    intent: fixture.intent,
    runs: runsData.length,
    successes: ok.length,
    manualActions: runsData.map((r) => r.manualActions),
    resolverAttempts: runsData.map((r) => r.resolverAttempts),
    resolverMs: { min: Math.min(...ok.map((r) => r.resolverMs)), p50: percentile(ok.map((r) => r.resolverMs), 50), p95: percentile(ok.map((r) => r.resolverMs), 95), max: Math.max(...ok.map((r) => r.resolverMs)) },
    playerStartupMs: { min: Math.min(...ok.map((r) => r.playerStartupMs)), p50: percentile(ok.map((r) => r.playerStartupMs), 50), p95: percentile(ok.map((r) => r.playerStartupMs), 95), max: Math.max(...ok.map((r) => r.playerStartupMs)) },
    firstFrameMs: { min: Math.min(...ok.map((r) => r.firstFrameMs)), p50: percentile(ok.map((r) => r.firstFrameMs), 95 ? 95 : 95), p95: percentile(ok.map((r) => r.firstFrameMs), 95), max: Math.max(...ok.map((r) => r.firstFrameMs)) },
    warm: runsData[0]?.warm ?? null,
    errors: runsData.filter((r) => r.error).map((r) => `${r.code ?? 'ERROR'}: ${String(r.error).slice(0, 90)}`),
  });
}

if (outPath) writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    console.log(`\n${r.fixture}  (${r.intent})  warm=${r.warm}  ${r.successes}/${r.runs} played`);
    console.log(`  manual actions   ${JSON.stringify(r.manualActions)}`);
    console.log(`  resolver attempts ${JSON.stringify(r.resolverAttempts)}`);
    console.log(`  resolver ms      min ${r.resolverMs.min}  p50 ${r.resolverMs.p50}  p95 ${r.resolverMs.p95}  max ${r.resolverMs.max}`);
    console.log(`  player startup   min ${r.playerStartupMs.min}  p50 ${r.playerStartupMs.p50}  p95 ${r.playerStartupMs.p95}  max ${r.playerStartupMs.max}`);
    console.log(`  first frame      min ${r.firstFrameMs.min}  p50 ${r.firstFrameMs.p50}  p95 ${r.firstFrameMs.p95}  max ${r.firstFrameMs.max}`);
    if (r.errors.length) console.log(`  errors           ${r.errors.slice(0, 2).join(' | ')}`);
  }
}

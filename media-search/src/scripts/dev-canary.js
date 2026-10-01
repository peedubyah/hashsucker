#!/usr/bin/env node
/** CDP-only isolated Plex HTPC canary; PMS and data-plane telemetry are evidence. */
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const repo = '/home/patrick/src/hashsucker';
const canonicalCommand = 'cd /home/patrick/src/hashsucker/media-search && npm run test:production-canary';
if (existsSync('/.dockerenv') || existsSync('/run/.dockerenv')) {
  console.error(`CANARY_INFRA_FAILURE: production HTPC canary must run in the host namespace; run: ${canonicalCommand}`);
  process.exit(2);
}
const timeoutMs = Number(process.env.HASHSUCKER_CANARY_TIMEOUT_MS || 90000);
const fast = process.argv.includes('--fast');
const explicitFixture = process.argv.find((x) => x.startsWith('--fixture='))?.split('=')[1];
const rotate = explicitFixture === 'rotate' || process.argv.includes('--rotate');
const quiet = process.argv.includes('--quiet') || process.env.HASHSUCKER_CANARY_QUIET === '1';
const runs = Number(process.env.HASHSUCKER_CANARY_RUNS || (fast || rotate ? 1 : 3));
const requested = rotate ? 'e01' : (explicitFixture || 'e01');
const fixtures = {
  e01: { label: 'Lanterns S01E01', ratingKey: '497', part: '1042', tf: 'tf_426aa723-3dfc-427a-8cc2-3871f231ff6c', path: '/mnt/hashsucker-vfs/TV/tt26545992/Season 01/tt26545992 - S01E01.mkv', server: '1c622b259a95aebb46228e9661409b7656539c53', grandparent: '495', parent: '496' },
  e05: { label: 'Lanterns S01E05', ratingKey: '514', part: '1061', tf: 'tf_1355e37f-143d-4703-8a53-23827089afbe', path: '/mnt/hashsucker-vfs/TV/tt26545992/Season 01/tt26545992 - S01E05.mp4', server: '1c622b259a95aebb46228e9661409b7656539c53', grandparent: '495', parent: '496' },
  mobland: { label: 'MobLand S02E02', ratingKey: '512', part: '1057', tf: 'tf_8d9d4437-03e9-440b-8b80-db36f9dd22af', path: '/mnt/hashsucker-vfs/TV/MobLand/Season 02/MobLand - S02E02.mkv', server: '1c622b259a95aebb46228e9661409b7656539c53', grandparent: '509', parent: '510' },
};
if (explicitFixture && !rotate && !fixtures[explicitFixture]) { console.error(`CANARY_HARNESS_FAILURE: INVALID_FIXTURE ${explicitFixture}; use e01, e05, mobland, or rotate`); process.exit(2); }
let fixture = fixtures[requested];
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', timeout: opts.timeout || 120000, ...opts });
const composeNode = (source) => run('docker', ['compose', 'exec', '-T', 'media-search', 'node', '--input-type=module'], { input: source, maxBuffer: 20 * 1024 * 1024 }).stdout.trim();
const serviceState = (service) => run('systemctl', ['--user', 'is-active', service]).stdout.trim();
const ensureCanaryServices = () => {
  for (const service of ['hashsucker-plex-xvfb.service', 'hashsucker-plex-audio.service', 'hashsucker-plex-canary.service']) {
    if (serviceState(service) !== 'active') {
      const result = run('systemctl', ['--user', 'start', service]);
      if (result.status !== 0) throw new Error(`CANARY_INFRA_FAILURE: could not start ${service}`);
    }
  }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonLast = (text, fallback = null) => { try { return JSON.parse(text.split('\n').filter(Boolean).at(-1) || ''); } catch { return fallback; } };

// websocket-client is installed on the canary host. Expression is argv data,
// so shell expansion cannot expose or alter Plex credentials.
const cdp = (expression) => {
  const py = `import json,sys,requests,websocket\nj=requests.get('http://127.0.0.1:9222/json/list',timeout=3).json()[0]\nw=websocket.create_connection(j['webSocketDebuggerUrl'],timeout=10)\nw.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':sys.argv[1],'awaitPromise':True,'returnByValue':True}}))\nwhile True:\n x=json.loads(w.recv())\n if x.get('id')==1:\n  print(json.dumps(x.get('result',{}).get('result',{}).get('value'))); break`;
  return jsonLast(run('python3', ['-c', py, expression], { timeout: 30000 }).stdout, null);
};
const sessionRows = () => jsonLast(composeNode(`const j=await (await fetch(process.env.PLEX_URL+'/status/sessions',{headers:{'X-Plex-Token':process.env.PLEX_TOKEN,Accept:'application/json'}})).json();console.log(JSON.stringify(j.MediaContainer?.Metadata||[]));`), []);
const sessionFor = () => sessionRows().find((x) => String(x.ratingKey) === fixture.ratingKey);
const stageEvents = () => { const r = run('docker', ['exec', 'hashsucker-data-plane-1', 'sh', '-lc', 'wget -qO- http://127.0.0.1:3001/metrics'], { maxBuffer: 20 * 1024 * 1024 }); const j = jsonLast(r.stdout, {}); return (j.stages_by_tf || []).filter((x) => x.tf_id === fixture.tf && x.request); };
const telemetry = () => stageEvents().map((x) => x.request).filter(Boolean);
const stageKey = (x) => `${x.corr_id || ''}:${x.request?.start}:${x.request?.end}:${x.T0_received_ms || ''}`;
const cacheRequests = () => { const r = run('docker', ['exec', 'hashsucker-data-plane-1', 'sh', '-lc', 'wget -qO- http://127.0.0.1:3001/metrics']); const j = jsonLast(r.stdout, {}); return (j.cache_decisions || []).map((x) => x.request).filter(Boolean); };
const readKey = (r) => `${r.start}:${r.end}`;
const captureSlowStart = (runNo, session, elapsedMs) => {
  if (elapsedMs < 15000) return null;
  const snapshot = { capturedAt: new Date().toISOString(), fixture: requested, run: runNo, sessionToFirstReadMs: elapsedMs, session, stages: stageEvents(), reads: telemetry() };
  const path = `/tmp/hashsucker-canary-${requested}-slow-${Date.now()}.json`;
  writeFileSync(path, JSON.stringify(snapshot, null, 2), { mode: 0o600 });
  console.error(`CANARY_SLOW_START_CAPTURE ${path}`);
  return path;
};
const freshStageEvents = (before = null) => stageEvents().filter((x) => !before || !before.has(stageKey(x)));
const waitForRead = async (before, predicate = () => true, timeout = 60000) => { const until = Date.now() + timeout; while (Date.now() < until) { const rows = freshStageEvents(before); const hit = rows.find((x) => predicate(x.request)); if (hit) return { at: Date.now(), request: hit.request, rows }; await sleep(1000); } return null; };
const waitForCdp = async (waitMs = timeoutMs) => { const until = Date.now() + waitMs; while (Date.now() < until) { const s = cdp('(()=>{if(!window.__hsr&&window.webpackChunk_plex_client_qt){let r;window.webpackChunk_plex_client_qt.push([[Date.now()],{},x=>r=x]);window.__hsr=r}return {hsr:typeof window.__hsr,name:window.__hsr?.(72861)?.Z?.resolve("navigation")?.currentName||null}})()'); if (s?.hsr === 'function') return s; await sleep(1000); } throw new Error('CANARY_INFRA_FAILURE: CDP endpoint/app not ready'); };
const prepareCanary = async () => {
  ensureCanaryServices();
  try {
    await waitForCdp(10_000);
  } catch {
    const result = run('systemctl', ['--user', 'restart', 'hashsucker-plex-canary.service']);
    if (result.status !== 0) throw new Error('CANARY_INFRA_FAILURE: could not restart isolated Plex HTPC canary');
    await waitForCdp();
  }
};
const startNative = () => { const uri = `server://${fixture.server}/com.plexapp.plugins.library/library/metadata/${fixture.ratingKey}`; const p = JSON.stringify({ metadataSourceUri: uri, itemKey: `/library/metadata/${fixture.ratingKey}`, type: 'episode', subtype: 'episode', grandparentKey: `/library/metadata/${fixture.grandparent}`, parentKey: `/library/metadata/${fixture.parent}`, fromPlayButton: true, startPaused: false }); return cdp(`(()=>{let n=window.__hsr(72861).Z.resolve("navigation");return n.navigate("VisualMediaPlaybackScreen",${p}).then(()=>({name:n.currentName}))})()`); };
const seek = (ms) => cdp(`(()=>{let c=window.__hsr(72861).Z.resolve("navigation").current._playbackController;return Promise.resolve(c.seek(${Math.round(ms)})).then(()=>({position:c.position}))})()`);
const stop = () => cdp('(()=>{let c=window.__hsr?.(72861)?.Z?.resolve("navigation")?.current?._playbackController;return c?c.stop():null})()');

async function one(runNo) {
  // Keep the isolated client running; native stop is the bounded lifecycle
  // operation between runs. Restarting the user unit can block on Qt teardown.
  await prepareCanary();
  await stop();
  const cleanUntil = Date.now() + 15000; while (Date.now() < cleanUntil && sessionRows().length) await sleep(500);
  if (sessionRows().length) throw new Error('TEARDOWN_FAILURE: stale PMS session before start');
  const started = Date.now(); const t0 = started; const baselineStages = stageEvents(); const beforeReads = new Set(baselineStages.map(stageKey)); const t1 = Date.now(); const route = startNative(); if (route?.name !== 'VisualMediaPlaybackScreen') throw new Error(`PLEX_SESSION_FAILURE: route=${JSON.stringify(route)}`);
  let active = null; while (Date.now() - started < timeoutMs && !active) { await sleep(1000); active = sessionFor(); }
  if (!active) throw new Error('PLEX_SESSION_FAILURE: no expected PMS session');
  // Navigation resolves before the playback screen's player is initialized;
  // wait for the native controller to become loaded/playing before measuring
  // progression so startup latency is not misclassified as a stall.
  const readyUntil = Date.now() + timeoutMs; let controllerReady = false;
  while (Date.now() < readyUntil && !controllerReady) { const s = cdp('(()=>{let c=window.__hsr(72861).Z.resolve("navigation").current._playbackController;return {state:c?.state,loaded:c?.hasPlayerLoaded}})()'); controllerReady = Boolean(s?.loaded && (s.state === 'playing' || s.state === 'paused')); if (!controllerReady) await sleep(1000); }
  if (!controllerReady) throw new Error('BYTE_DELIVERY_FAILURE: native player did not initialize');
  const t2 = Date.now(); const t3 = Date.now(); const firstRead = await waitForRead(beforeReads, () => true, timeoutMs); const t4 = firstRead?.at || null;
  const slowCapture = firstRead ? captureSlowStart(runNo, active, firstRead.at - t3) : null;
  const part = active.Media?.flatMap((m) => m.Part || []).find((p) => String(p.id) === fixture.part); const player = active.Player || {};
  if (String(active.ratingKey) !== fixture.ratingKey || !part || part.file !== fixture.path || String(player.machineIdentifier) !== '1iu21f4816xfz8urti7gfc9r') throw new Error(`IDENTITY_DRIFT_FAILURE: ${JSON.stringify({ ratingKey: active.ratingKey, part: part?.id, file: part?.file, client: player.machineIdentifier })}`);
  const initial = Number(active.viewOffset || 0); let progressed = null; const progressUntil = Date.now() + 30000; while (Date.now() < progressUntil) { await sleep(2000); progressed = sessionFor(); if (progressed && Number(progressed.viewOffset || 0) > initial + 5000) break; } if (!progressed || Number(progressed.viewOffset || 0) <= initial + 5000) throw new Error('BYTE_DELIVERY_FAILURE: playback did not progress'); const t5 = Date.now();
  const duration = Number(progressed.duration || 0); const mediaSize = Number(part?.size || 0); const cachedRegion = (target, rows) => { const expected = mediaSize * target / duration; const chunk = 67108864; return rows.find((r) => r.cache_hit === true && r.request?.start <= expected + chunk && r.request?.end >= Math.max(0, expected - chunk)); };
  const forwardTarget = Math.min(900000, Math.max(600000, duration - 120000)); const beforeFwd = new Set(stageEvents().map(stageKey)); const t6 = Date.now(); await seek(forwardTarget); let fwdRead = null; let forward = null; const fwdUntil = Date.now() + 30000; while (Date.now() < fwdUntil) { await sleep(1000); if (!fwdRead) { const candidates = stageEvents().filter((x) => !beforeFwd.has(stageKey(x))); const hit = candidates.find((x) => x.request.start > 100000000 && x.request.end > mediaSize * forwardTarget / duration - 67108864); const cache = cachedRegion(forwardTarget, candidates); if (hit) fwdRead = { at: Date.now(), request: hit.request, cacheHit: Boolean(hit.cache_hit) }; else if (cache) fwdRead = { at: Date.now(), request: cache.request, cacheHit: true }; } forward = sessionFor(); if (forward && Number(forward.viewOffset || 0) >= forwardTarget - 15000) break; } const t7 = fwdRead?.at || null; if (!forward || Number(forward.viewOffset || 0) < forwardTarget - 15000) throw new Error(`FORWARD_SEEK_FAILURE: target=${forwardTarget} actual=${forward?.viewOffset}`); const t8 = Date.now(); if (!fwdRead) { const cached = cachedRegion(forwardTarget, stageEvents()); if (cached) fwdRead = { at: t8, request: cached.request, cacheHit: true }; }
  const backwardTarget = Math.max(300000, forwardTarget - 600000); const beforeBack = new Set(stageEvents().map(stageKey)); const t9 = Date.now(); await seek(backwardTarget); let backRead = null; let backward = null; const backUntil = Date.now() + 30000; while (Date.now() < backUntil) { await sleep(1000); if (!backRead) { const candidates = stageEvents().filter((x) => !beforeBack.has(stageKey(x))); const hit = candidates.find((x) => x.request.start < mediaSize * backwardTarget / duration + 67108864 && x.request.end > mediaSize * backwardTarget / duration - 67108864); const cache = cachedRegion(backwardTarget, candidates); if (hit) backRead = { at: Date.now(), request: hit.request, cacheHit: Boolean(hit.cache_hit) }; else if (cache) backRead = { at: Date.now(), request: cache.request, cacheHit: true }; } backward = sessionFor(); if (backward && Number(backward.viewOffset || 0) <= backwardTarget + 15000) break; } const t10 = backRead?.at || null; if (!backward || Number(backward.viewOffset || 0) > backwardTarget + 15000) throw new Error(`BACKWARD_SEEK_FAILURE: target=${backwardTarget} actual=${backward?.viewOffset}`); const t11 = Date.now(); if (!backRead) { const cached = cachedRegion(backwardTarget, stageEvents()); if (cached) backRead = { at: t11, request: cached.request, cacheHit: true }; }
  const eofTarget = Math.max(120000, duration - 180000); const beforeEof = new Set(stageEvents().map(stageKey)); const t12 = Date.now(); await seek(eofTarget); let eofRead = null; const eofUntilRead = Date.now() + timeoutMs; while (Date.now() < eofUntilRead && !eofRead) { await sleep(1000); const hit = stageEvents().find((x) => !beforeEof.has(stageKey(x)) && x.request.start > 0.8 * (mediaSize || 1000000000)); if (hit) eofRead = { at: Date.now(), request: hit.request, cacheHit: Boolean(hit.cache_hit) }; } let eof = null; const eofUntil = Date.now() + 30000; while (Date.now() < eofUntil) { await sleep(1000); eof = sessionFor(); if (eof && Number(eof.viewOffset || 0) >= eofTarget - 15000) break; } if (!eof || Number(eof.viewOffset || 0) < eofTarget - 15000) throw new Error(`NEAR_EOF_FAILURE: target=${eofTarget} actual=${eof?.viewOffset}`); if (!eofRead) { const cached = stageEvents().find((x) => x.cache_hit === true && x.request.start > 0.8 * (mediaSize || 1000000000)); if (cached) eofRead = { at: Date.now(), request: cached.request, cacheHit: true }; } const t13 = eofRead?.at || null;
  const t14 = Date.now(); await stop(); const goneUntil = Date.now() + 15000; while (Date.now() < goneUntil && sessionRows().length) await sleep(500); const t15 = Date.now(); if (sessionRows().length) throw new Error('TEARDOWN_FAILURE: PMS session did not disappear');
  const freshRows = freshStageEvents(beforeReads);
  const reads = freshRows.map((x) => x.request).filter(Boolean);
  if (!reads.length || !reads.every((r) => Number.isFinite(r.start)) || !reads.some((r) => r.start > 100000000)) {
    const error = new Error(`BYTE_DELIVERY_FAILURE: no fresh exact/distant reads for ${fixture.tf}`);
    error.evidence = { baselineStageCount: beforeReads.size, currentStageCount: stageEvents().length, freshStageCount: freshRows.length, freshCorrelationIds: freshRows.map((x) => x.corr_id).filter(Boolean).slice(-8) };
    throw error;
  }
  const seekEvidence = (read) => read ? { classification: read.cacheHit ? 'BYTE_PATH_CACHE' : 'BYTE_PATH_READ', request: read.request } : { classification: 'SEEK_PASS_BUFFERED', backendRequired: false };
  return { run: runNo, status: 'PASS', fixture: requested, ratingKey: fixture.ratingKey, part: fixture.part, tf: fixture.tf, startMs: initial, forwardMs: Number(forward.viewOffset), backwardMs: Number(backward.viewOffset), nearEofMs: Number(eof.viewOffset), seekEvidence: { forward: seekEvidence(fwdRead), backward: seekEvidence(backRead), nearEof: seekEvidence(eofRead) }, readCount: reads.length, distantRead: Math.max(...reads.map((r) => r.start)), latencyMs: Date.now() - started, phases: { playCommandToController: t2 - t1, playCommandToSession: t3 - t1, sessionToFirstRead: t4 ? t4 - t3 : null, firstReadToProgress: t4 ? t5 - t4 : null, playCommandToProgress: t5 - t1, forwardSeekToRead: t7 ? t7 - t6 : null, forwardSeekToProgress: t8 - t6, backwardSeekToRead: t10 ? t10 - t9 : null, backwardSeekToProgress: t11 - t9, eofSeekToRead: t13 ? t13 - t12 : null, stopToSessionGone: t15 - t14 } };
}
const plan = rotate ? ['e01', 'e05', 'mobland'] : (explicitFixture || fast ? [requested] : ['e01', 'e05', 'mobland']);
const results = []; for (const key of plan) { fixture = fixtures[key]; for (let i = 1; i <= runs; i += 1) { try { const result = await one(i); result.fixture = key; const abnormal = (result.phases.sessionToFirstRead != null && result.phases.sessionToFirstRead >= 15000) || result.latencyMs >= 60000; result.abnormal = abnormal; results.push(result); if (!quiet || abnormal) console.log(JSON.stringify({ fixture: key, run: i, status: 'PASS', latencyMs: result.latencyMs, sessionToFirstRead: result.phases.sessionToFirstRead, identityStable: true, teardown: result.phases.stopToSessionGone < 15000, abnormal })); } catch (e) { let diagnostic = null; try { diagnostic = { navigation: cdp('(()=>{let n=window.__hsr?.(72861)?.Z?.resolve("navigation"),c=n?.current?._playbackController;return {name:n?.currentName,state:c?.state,loaded:c?.hasPlayerLoaded,pos:c?.position,duration:c?.duration,error:c?.playbackError}})()'), sessions: sessionRows(), reads: telemetry().slice(-8), evidence: e.evidence ?? null }; } catch {} try { await stop(); } catch {} const reason = String(e.message || e); const classification = reason.includes('no expected PMS session') ? 'PMS_SESSION_NOT_CREATED' : reason.includes('native player did not initialize') ? 'PLAYBACK_START_TIMEOUT' : reason.includes('FORWARD_SEEK_FAILURE') ? 'FORWARD_SEEK_FAILED' : reason.includes('BACKWARD_SEEK_FAILURE') ? 'BACKWARD_SEEK_FAILED' : reason.includes('NEAR_EOF_FAILURE') ? 'NEAR_EOF_FAILED' : reason.includes('TEARDOWN_FAILURE') ? 'STOP_FAILED' : reason.includes('IDENTITY_DRIFT_FAILURE') ? 'PLEX_IDENTITY_MISMATCH' : reason.includes('BYTE_DELIVERY_FAILURE') ? 'VFS_OR_BYTE_PATH_FAILURE' : 'UNKNOWN_WITH_SNAPSHOT'; const failure = { fixture: key, run: i, status: 'FAIL', classification, reason, diagnostic }; results.push(failure); console.error(JSON.stringify(failure)); break; } } }
const expected = plan.length * runs; const pass = results.length === expected && results.every((x) => x.status === 'PASS'); const summary = { mode: quiet ? 'cdp-quiet' : (fast ? 'cdp-fast' : 'cdp-full'), plan, runsRequested: runs, results: quiet ? results.map((x) => ({ fixture: x.fixture, run: x.run, status: x.status, classification: x.classification || null, latencyMs: x.latencyMs || null, sessionToFirstRead: x.phases?.sessionToFirstRead ?? null, abnormal: x.abnormal || false })) : results, pass }; if (quiet || !pass) console.log(JSON.stringify(summary, null, quiet ? 0 : 2));
process.exitCode = results.length === expected && results.every((x) => x.status === 'PASS') ? 0 : 1;

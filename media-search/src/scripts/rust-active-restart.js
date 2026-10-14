#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
const repo = '/home/patrick/src/hashsucker';
const fixture = { ratingKey: '497', part: '1042', tf: 'tf_426aa723-3dfc-427a-8cc2-3871f231ff6c' };
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { cwd: repo, encoding: 'utf8', timeout: opts.timeout || 120000, ...opts });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const jsonLast = (s, fallback = null) => { try { return JSON.parse(s.split('\n').filter(Boolean).at(-1) || ''); } catch { return fallback; } };
const cdp = (expression) => { const py = `import json,sys,requests,websocket\nj=requests.get('http://127.0.0.1:9222/json/list',timeout=3).json()[0]\nw=websocket.create_connection(j['webSocketDebuggerUrl'],timeout=10)\nw.send(json.dumps({'id':1,'method':'Runtime.evaluate','params':{'expression':sys.argv[1],'awaitPromise':True,'returnByValue':True}}))\nwhile True:\n x=json.loads(w.recv())\n if x.get('id')==1:\n  print(json.dumps(x.get('result',{}).get('result',{}).get('value'))); break`; return jsonLast(run('python3', ['-c', py, expression], { timeout: 30000 }).stdout, null); };
const sessions = () => jsonLast(run('docker', ['compose', 'exec', '-T', 'media-search', 'node', '--input-type=module'], { input: `const j=await (await fetch(process.env.PLEX_URL+'/status/sessions',{headers:{'X-Plex-Token':process.env.PLEX_TOKEN,Accept:'application/json'}})).json();console.log(JSON.stringify(j.MediaContainer?.Metadata||[]));` }).stdout, []);
const session = () => sessions().find((x) => String(x.ratingKey) === fixture.ratingKey);
const stop = () => cdp('(()=>{let c=window.__hsr?.(72861)?.Z?.resolve("navigation")?.current?._playbackController;return c?c.stop():null})()');
const start = () => cdp('(()=>{let n=window.__hsr(72861).Z.resolve("navigation");return n.navigate("VisualMediaPlaybackScreen",{metadataSourceUri:"server://1c622b259a95aebb46228e9661409b7656539c53/com.plexapp.plugins.library/library/metadata/497",itemKey:"/library/metadata/497",type:"episode",subtype:"episode",grandparentKey:"/library/metadata/495",parentKey:"/library/metadata/496",fromPlayButton:true,startPaused:false}).then(()=>({name:n.currentName}))})()');
const seek = (ms) => cdp(`(()=>{let c=window.__hsr(72861).Z.resolve("navigation").current._playbackController;return Promise.resolve(c.seek(${ms})).then(()=>({position:c.position}))})()`);
async function waitHealthy() { for (let i = 0; i < 60; i += 1) { const s = run('docker', ['inspect', '-f', '{{.State.Health.Status}}', 'hashsucker-data-plane-1']).stdout.trim(); if (s === 'healthy') return i; await sleep(1000); } throw new Error('data-plane readiness timeout'); }
async function one(i) {
  await stop(); await sleep(1500); start(); let active = null; for (let n = 0; n < 30 && !active; n += 1) { await sleep(1000); active = session(); }
  if (!active) throw new Error('no PMS session before active restart');
  const before = Number(active.viewOffset || 0); await sleep(8000); const preRestart = session();
  const restartStart = Date.now(); run('docker', ['compose', 'restart', 'data-plane']); const waited = await waitHealthy(); const restartEnd = Date.now();
  const seekIssued = Date.now(); seek(900000); let after = null; for (let n = 0; n < 30; n += 1) { await sleep(1000); after = session(); if (after && Number(after.viewOffset || 0) >= 885000) break; }
  const controller = cdp('(()=>{let c=window.__hsr(72861).Z.resolve("navigation").current._playbackController;return {state:c?.state,loaded:c?.hasPlayerLoaded,position:c?.position}})()');
  const result = { run: i, preRestart: { viewOffset: preRestart?.viewOffset, ratingKey: preRestart?.ratingKey, part: preRestart?.Media?.flatMap((m) => m.Part || []).find((p) => String(p.id) === fixture.part)?.id }, restartMs: restartEnd - restartStart, readinessWaitS: waited, postRestart: { session: Boolean(after), viewOffset: after?.viewOffset, ratingKey: after?.ratingKey, part: after?.Media?.flatMap((m) => m.Part || []).find((p) => String(p.id) === fixture.part)?.id, state: after?.Player?.state }, controller, targetReached: Boolean(after && Number(after.viewOffset || 0) >= 885000), continuity: Boolean(preRestart && after && Number(after.viewOffset || 0) > before), sameIdentity: Boolean(after?.ratingKey === fixture.ratingKey && after?.Media?.flatMap((m) => m.Part || []).some((p) => String(p.id) === fixture.part)) };
  await stop(); for (let n = 0; n < 30 && sessions().length; n += 1) await sleep(500); result.cleanStop = sessions().length === 0; return result;
}
const results = []; for (let i = 1; i <= Number(process.env.RUST_ACTIVE_RESTART_RUNS || 3); i += 1) { try { const r = await one(i); results.push({ ...r, status: r.targetReached && r.sameIdentity && r.cleanStop ? 'PASS' : 'FAIL' }); console.log(JSON.stringify(results.at(-1))); } catch (e) { results.push({ run: i, status: 'FAIL', error: e.message }); console.error(JSON.stringify(results.at(-1))); } }
console.log(JSON.stringify({ mode: 'rust-active-restart', results, pass: results.length > 0 && results.every((r) => r.status === 'PASS') }, null, 2));
process.exitCode = results.every((r) => r.status === 'PASS') ? 0 : 1;

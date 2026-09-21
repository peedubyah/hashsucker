#!/usr/bin/env node
/**
 * HashSucker terminal operator console (TUI = control room).
 *
 *   npm run tui            # or: node src/tui.mjs
 *   HASHSUCKER_URL=http://127.0.0.1:3000 npm run tui
 *
 * Keyboard-only: 1-8 sections, j/k or arrows to move, enter for detail,
 * / to filter lists, r to refresh, q to quit. 15s auto-refresh on the
 * home screen only; every other screen refreshes manually. All views are
 * read-only except explicitly labelled probes (also read-only). No
 * state-changing admin commands exist here by design.
 *
 * Zero dependencies: readline + ANSI only (SSH-safe, resize-safe via
 * re-render, no mouse).
 */
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { api, bytes, ago } from './lib/tui/api.mjs';

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
};
const W = () => process.stdout.columns || 80;
const line = (ch = '─') => ch.repeat(Math.max(10, W() - 1));
const cut = (s, n) => {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const pill = (text, color) => `${color}${C.bold}${text}${C.reset}`;

function dueIn(ts) {
  const ms = ts - Date.now();
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `in ${h}h`;
  return `in ${Math.round(h / 24)}d`;
}

function stateColor(s) {
  s = String(s ?? '').toLowerCase();
  if (['ok', 'healthy', 'ready', 'reachable', 'usable', 'configured', 'done', 'published', 'fulfilled', 'completed', 'staged', 'cached'].includes(s)) return C.green;
  if (['error', 'failed', 'unreachable', 'down', 'fatal'].includes(s)) return C.red;
  if (['degraded', 'not_ready', 'warn', 'requested', 'resolving', 'materializing', 'pending', 'accepted', 'throttled'].includes(s)) return C.yellow;
  return C.dim;
}

const state = {
  screen: 'home',
  data: {},
  error: null,
  cursor: 0,
  filter: '',
  detail: null,
  logService: 'hashsucker-media-search-1',
  lastRefresh: 0,
  homeTimer: null,
};

function emit(s) {
  process.stdout.write('\x1b[2J\x1b[H');
  process.stdout.write(s);
}

async function load(screen) {
  state.error = null;
  try {
    if (screen === 'home') {
      const [ready, diag, dl] = await Promise.all([
        api.ready().catch((e) => ({ status: 'unreachable', _err: String(e.message || e) })),
        api.diagnostics().catch(() => null),
        api.downloads(50).catch(() => ({ items: [] })),
      ]);
      state.data.home = { ready, diag, dl };
    } else if (screen === 'activity') {
      state.data.activity = await api.activity(40);
    } else if (screen === 'library') {
      const lib = await api.library(100);
      state.data.library = lib;
      const tfs = [...new Set(lib.items.map((i) => i.torrentFileId).filter(Boolean))].slice(0, 100);
      state.data.quality = tfs.length ? await api.quality(tfs).catch(() => ({ items: [] })) : { items: [] };
    } else if (screen === 'providers') {
      const [diag, failed] = await Promise.all([api.diagnostics(), api.failedEvents(20).catch(() => ({ runs: [] }))]);
      state.data.providers = { diag, failed };
    } else if (screen === 'downloads') {
      state.data.downloads = await api.downloads(50);
    } else if (screen === 'diagnostics') {
      const [diag, workers, failed] = await Promise.all([
        api.diagnostics(), api.workers().catch(() => null), api.failedEvents(10).catch(() => ({ runs: [] })),
      ]);
      state.data.diagnostics = { diag, workers, failed };
    } else if (screen === 'logs') {
      state.data.logs = tailLogs(state.logService, 120);
    }
  } catch (e) {
    state.error = String(e.message || e);
  }
  state.lastRefresh = Date.now();
}

function dockerLogs(service, n) {
  try {
    const r = spawnSync('docker', ['logs', '--tail', String(n), '--timestamps', service],
      { encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) return { ok: false, text: cut((r.stderr || 'docker logs failed').trim(), 200) };
    return { ok: true, text: r.stdout };
  } catch (e) {
    return { ok: false, text: `docker unavailable: ${cut(e.message, 120)}` };
  }
}

function tailLogs(service, n) {
  const r = dockerLogs(service, n);
  if (!r.ok) return { service, lines: [], note: r.text };
  return { service, lines: r.text.trim().split('\n').slice(-n), note: null };
}

const SERVICES = [
  'hashsucker-media-search-1',
  'hashsucker-data-plane-1',
  'hashsucker-edge-1',
  'hashsucker-torbox-importer-1',
];

function renderHome() {
  const { ready, diag, dl } = state.data.home || {};
  const out = [];
  out.push(`${C.bold}HashSucker control room${C.reset}  ${C.dim}${api.base} · r refresh · q quit${C.reset}`);
  out.push(line());
  const rs = ready?.status ?? '?';
  out.push(`readiness  ${pill(rs, stateColor(rs))}`);
  if (ready?._err) out.push(`  ${C.red}${cut(ready._err, W() - 4)}${C.reset}`);
  const p = diag?.providers ?? {};
  out.push(`torbox    ${(p.torbox?.state ?? '?')}`);
  out.push(`realdebrid ${(p.realdebrid?.state ?? '?')}`);
  out.push(`corpus     ${diag?.corpus?.state ?? '?'}${diag?.corpus?.candidates != null ? ` · ${diag.corpus.candidates.toLocaleString()} candidates` : ''}`);
  const v = diag?.publication?.vfs;
  out.push(`vfs        ${v?.detail ?? '?'}   data-plane ${typeof diag?.dataPlane === 'string' ? diag.dataPlane : (diag?.dataPlane?.state ?? '?')}`);
  const items = dl?.items ?? [];
  const active = items.filter((d) => !['staged', 'failed'].includes(d.state));
  const failed = items.filter((d) => d.state === 'failed');
  out.push(`downloads  ${active.length} active · ${failed.length} failed · library ${(diag?.publication?.vfs?.movies ?? 0)} movies`);
  out.push(line());
  out.push(`${C.dim}1 activity  2 library  3 providers  4 downloads  5 diagnostics  6 logs  7 probes${C.reset}`);
  return out.join('\n');
}

function matchFilter(s) {
  if (!state.filter) return true;
  return s.toLowerCase().includes(state.filter.toLowerCase());
}

function renderActivity() {
  const items = (state.data.activity?.items ?? []).filter((i) =>
    matchFilter(`${i.mediaId} ${i.headline} ${i.state} ${i.kind}`));
  const out = [`${C.bold}Activity${C.reset}  ${C.dim}${items.length} rows · j/k move · enter detail · / filter · r refresh${C.reset}`, line()];
  const rows = items.slice(0, Math.max(5, process.stdout.rows - 8));
  rows.forEach((it, idx) => {
    const cur = idx === state.cursor ? `${C.cyan}›${C.reset}` : ' ';
    out.push(`${cur} ${cut(it.kind, 8).padEnd(8)} ${cut(it.mediaId ?? '?', 14).padEnd(14)} ${pill(cut(it.state ?? '?', 12), stateColor(it.state))} ${cut(it.headline ?? '', W() - 42)}`);
    if (state.detail === `${it.kind}:${it.id}`) {
      out.push(`    profile ${it.qualityProfile ?? '—'} · at ${it.at ? new Date(it.at).toLocaleString() : '—'}`);
    }
  });
  if (state.filter) out.push(`${C.dim}filter: ${state.filter}${C.reset}`);
  return out.join('\n');
}

function renderLibrary() {
  const items = (state.data.library?.items ?? []).filter((i) =>
    matchFilter(`${i.title} ${i.mediaId} ${i.mediaType}`));
  const qmap = {};
  for (const q of state.data.quality?.items ?? []) qmap[q.torrentFileId] = q;
  const out = [`${C.bold}Library${C.reset}  ${C.dim}${items.length} items · enter = identity detail · / filter${C.reset}`, line()];
  const rows = items.slice(0, Math.max(5, process.stdout.rows - 8));
  rows.forEach((it, idx) => {
    const cur = idx === state.cursor ? `${C.cyan}›${C.reset}` : ' ';
    const q = it.torrentFileId ? qmap[it.torrentFileId] : null;
    const name = it.title || it.mediaId;
    const ep = it.mediaType === 'episode' ? ` S${it.season}E${it.episode}` : '';
    out.push(`${cur} ${cut(name, 34).padEnd(34)} ${cut(q?.label ?? '—', 16).padEnd(16)} ${cut(it.qualityProfile ?? 'balanced', 8).padEnd(8)} ${it.hasServingCoordinates ? pill('watchable', C.green) : pill('no-copy', C.yellow)}`);
    if (state.detail === it.mediaId + ep) {
      out.push(`    tf ${it.torrentFileId ?? '—'} · size ${bytes(it.size)} · mode ${it.publicationMode ?? 'permanent'} · path ${cut(it.canonicalPath ?? '—', W() - 12)}`);
    }
  });
  if (state.filter) out.push(`${C.dim}filter: ${state.filter}${C.reset}`);
  return out.join('\n');
}

function renderProviders() {
  const { diag, failed } = state.data.providers || {};
  const out = [`${C.bold}Providers${C.reset}`, line()];
  for (const [name, p] of Object.entries(diag?.providers ?? {})) {
    out.push(`${name.padEnd(12)} ${pill(p?.state ?? '?', stateColor(p?.state))}  ${cut(p?.detail ?? '', W() - 24)}`);
  }
  const throttle = (failed?.runs ?? []).filter((r) => /429|rate|limit|throttle/i.test(r.error ?? ''));
  out.push(line());
  out.push(`${C.bold}Throttle evidence (${throttle.length})${C.reset}`);
  if (!throttle.length) out.push(`${C.dim}none recently — backoff and retries are automatic${C.reset}`);
  throttle.slice(0, 10).forEach((r) => out.push(`  ${cut(r.mediaId ?? r.requestId ?? '?', 16)} ${cut(r.error ?? '', W() - 22)}`));
  return out.join('\n');
}

function renderDownloads() {
  const items = state.data.downloads?.items ?? [];
  const out = [`${C.bold}Downloads${C.reset}  ${C.dim}${items.length} rows · enter = lifecycle detail${C.reset}`, line()];
  const rows = items.slice(0, Math.max(5, process.stdout.rows - 8));
  rows.forEach((d, idx) => {
    const cur = idx === state.cursor ? `${C.cyan}›${C.reset}` : ' ';
    const prog = d.expectedSize ? ` ${bytes(d.bytesComplete)}/${bytes(d.expectedSize)}` : '';
    out.push(`${cur} ${cut(d.mediaId, 14).padEnd(14)} ${pill(cut(d.state, 12), stateColor(d.state))} ${cut(d.headline ?? '', W() - 46)}${prog}`);
    if (state.detail === d.downloadRequestId) {
      const due = d.nextDueAt ? dueIn(d.nextDueAt) : '—';
      out.push(`    attempts ${d.attempts ?? 0} · next-due ${due}${d.nextDueAt ? ` (${new Date(d.nextDueAt).toLocaleString()})` : ''}`);
      out.push(`    handoff ${d.handoffState ?? 'none'} v${d.handoffVersion ?? 0} · cleanup due ${d.cleanupDueAt ? new Date(d.cleanupDueAt).toLocaleString() : '—'} · done ${d.cleanupDoneAt ? 'yes' : 'no'}`);
      out.push(`    fail-category ${d.failCategory ?? d.detail ?? '—'} · file ${d.filePresent == null ? '—' : (d.filePresent ? 'present' : 'absent')}`);
    }
  });
  return out.join('\n');
}

function renderDiagnostics() {
  const { diag, workers, failed } = state.data.diagnostics || {};
  const out = [`${C.bold}Diagnostics${C.reset}`, line()];
  const kv = (k, v) => out.push(`${k.padEnd(14)} ${cut(v, W() - 17)}`);
  kv('corpus', `${diag?.corpus?.state ?? '?'}${diag?.corpus?.candidates != null ? ` · ${diag.corpus.candidates.toLocaleString()}` : ''}`);
  kv('vfs', diag?.publication?.vfs?.detail ?? '?');
  kv('strm', diag?.publication?.strm?.state ?? '?');
  kv('discovery-db', diag?.storage?.discoveryDb?.state ?? '?');
  kv('control-db', diag?.storage?.controlDb?.state ?? '?');
  kv('timers/workers', cut(JSON.stringify(workers ?? 'n/a'), 70));
  kv('workers', cut(JSON.stringify(workers ?? 'n/a'), 60));
  out.push(line());
  out.push(`${C.bold}Recent errors (${(failed?.runs ?? []).length})${C.reset}`);
  for (const r of (failed?.runs ?? []).slice(0, 8)) {
    out.push(`  ${cut(r.mediaId ?? r.requestId ?? '?', 16)} ${cut(r.error ?? '', W() - 22)}`);
  }
  return out.join('\n');
}

function renderLogs() {
  const { service, lines, note } = state.data.logs || { service: state.logService, lines: [], note: null };
  const out = [`${C.bold}Logs: ${service}${C.reset}  ${C.dim}tab = switch service · lines follow (newest last)${C.reset}`, line()];
  if (note) out.push(`${C.yellow}${note}${C.reset}`);
  const h = Math.max(5, process.stdout.rows - 6);
  for (const l of lines.slice(-h)) out.push(cut(l, W() - 1));
  return out.join('\n');
}

function renderProbes() {
  const out = [`${C.bold}Probes (all read-only)${C.reset}`, line()];
  for (const p of state.data.probes ?? []) {
    out.push(`${p.ok ? pill('ok', C.green) : pill('FAIL', C.red)}  ${p.name.padEnd(28)} ${cut(p.detail ?? '', W() - 40)}`);
  }
  if (!(state.data.probes ?? []).length) out.push(`${C.dim}press 1-4 to run a probe${C.reset}`);
  out.push(line());
  out.push(`${C.dim}1 readiness  2 vfs-catalog  3 data-plane range  4 provider status${C.reset}`);
  return out.join('\n');
}

async function runProbe(n) {
  state.data.probes = state.data.probes ?? [];
  const push = (name, ok, detail) => {
    state.data.probes = [...state.data.probes.filter((p) => p.name !== name), { name, ok, detail }];
  };
  try {
    if (n === '1') {
      const r = await api.ready();
      push('readiness', r.status === 'healthy' || r.status === 'degraded', r.status);
    } else if (n === '2') {
      const lib = await api.library(1);
      push('vfs-catalog', true, `${lib.total ?? lib.items?.length ?? 0} items listed`);
    } else if (n === '3') {
      const lib = await api.library(100);
      const tf = lib.items.map((i) => i.torrentFileId).find(Boolean);
      if (!tf) return push('data-plane range', false, 'no TorrentFile in library');
      const { spawnSync: sp } = await import('node:child_process');
      const r = sp('docker', ['exec', 'hashsucker-edge-1', 'curl', '-s', '-m', '60',
        '-o', '/dev/null', '-w', '%{http_code} %{size_download} %{time_total}s',
        `http://data-plane:3001/files/${tf}`, '-H', 'Range: bytes=0-1023'],
      { encoding: 'utf8', timeout: 90000 });
      const t = (r.stdout || '').trim();
      push('data-plane range', t.startsWith('206'), t || 'edge/data-plane unreachable');
    } else if (n === '4') {
      const d = await api.diagnostics();
      const p = d.providers ?? {};
      push('provider status', true, `torbox=${p.torbox?.state} rd=${p.realdebrid?.state} (cached, no new probe)`);
    }
  } catch (e) {
    push(`probe ${n}`, false, cut(e.message, 80));
  }
}

function render() {
  let s;
  if (state.screen === 'home') s = renderHome();
  else if (state.screen === 'activity') s = renderActivity();
  else if (state.screen === 'library') s = renderLibrary();
  else if (state.screen === 'providers') s = renderProviders();
  else if (state.screen === 'downloads') s = renderDownloads();
  else if (state.screen === 'diagnostics') s = renderDiagnostics();
  else if (state.screen === 'logs') s = renderLogs();
  else if (state.screen === 'probes') s = renderProbes();
  if (state.error) s += `\n${C.red}error: ${cut(state.error, W() - 9)}${C.reset}`;
  emit(s.endsWith('\n') ? s : `${s}\n`);
}

const SCREENS = ['home', 'activity', 'library', 'providers', 'downloads', 'diagnostics', 'logs', 'probes'];

async function go(screen) {
  state.screen = screen;
  state.cursor = 0;
  state.detail = null;
  state.filter = '';
  await load(screen);
  render();
}

function armHomeTimer() {
  if (state.homeTimer) clearInterval(state.homeTimer);
  state.homeTimer = setInterval(async () => {
    if (state.screen === 'home' && !process.stdout.isTTY) return;
    if (state.screen === 'home') {
      await load('home');
      render();
    }
  }, 15_000);
  state.homeTimer.unref?.();
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('tui needs an interactive terminal');
    process.exit(1);
  }
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.on('resize', () => render());
  let filtering = false;

  await go('home');
  armHomeTimer();

  process.stdin.on('keypress', async (ch, key) => {
    if (!key) return;
    if (key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
    if (filtering) {
      if (key.name === 'escape' || key.name === 'return') { filtering = false; render(); return; }
      if (key.name === 'backspace') state.filter = state.filter.slice(0, -1);
      else if (ch && ch.length === 1) state.filter += ch;
      state.cursor = 0;
      render();
      return;
    }
    const k = key.name === 'q' ? 'q' : (ch || '');
    if (k === 'q') { cleanup(); process.exit(0); return; }
    if (['1', '2', '3', '4', '5', '6', '7', '8'].includes(k)) {
      if (state.screen === 'probes' && ['1', '2', '3', '4'].includes(k)) {
        await runProbe(k);
        render();
        return;
      }
      const map = { 1: 'activity', 2: 'library', 3: 'providers', 4: 'downloads', 5: 'diagnostics', 6: 'logs', 7: 'probes', 8: 'home' };
      await go(map[k]);
      return;
    }
    if (k === 'r') { await load(state.screen); render(); return; }
    if (k === 'j' || k === 'down') { state.cursor++; render(); return; }
    if (k === 'k' || k === 'up') { state.cursor = Math.max(0, state.cursor - 1); render(); return; }
    if (k === 'return' || k === 'enter') {
      toggleDetail();
      render();
      return;
    }
    if (k === '/') { filtering = true; render(); return; }
    if (k === 'tab' && state.screen === 'logs') {
      const i = SERVICES.indexOf(state.logService);
      state.logService = SERVICES[(i + 1) % SERVICES.length];
      await load('logs');
      render();
    }
    if (k === 'escape') { state.detail = null; state.filter = ''; render(); }
  });
}

function toggleDetail() {
  if (state.screen === 'activity') {
    const items = (state.data.activity?.items ?? []).filter((i) =>
      `${i.mediaId} ${i.headline} ${i.state} ${i.kind}`.toLowerCase().includes(state.filter.toLowerCase()));
    const it = items[state.cursor];
    state.detail = it && state.detail !== `${it.kind}:${it.id}` ? `${it.kind}:${it.id}` : null;
  } else if (state.screen === 'library') {
    const items = (state.data.library?.items ?? []).filter((i) =>
      `${i.title} ${i.mediaId} ${i.mediaType}`.toLowerCase().includes(state.filter.toLowerCase()));
    const it = items[state.cursor];
    const key = it ? it.mediaId + (it.mediaType === 'episode' ? ` S${it.season}E${it.episode}` : '') : null;
    state.detail = it && state.detail !== key ? key : null;
  } else if (state.screen === 'downloads') {
    const items = state.data.downloads?.items ?? [];
    const it = items[state.cursor];
    state.detail = it && state.detail !== it.downloadRequestId ? it.downloadRequestId : null;
  }
}

function cleanup() {
  if (state.homeTimer) clearInterval(state.homeTimer);
  try { process.stdin.setRawMode(false); } catch { /* noop */ }
  process.stdin.pause();
}

process.on('SIGWINCH', () => render());
main().catch((e) => {
  cleanup();
  console.error(`tui failed: ${e.message}`);
  process.exit(1);
});

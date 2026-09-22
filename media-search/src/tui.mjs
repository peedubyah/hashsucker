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
    } else if (screen === 'requests') {
      state.data.requests = await api.requests(100);
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
    } else if (screen === 'corpus') {
      state.data.corpus = await api.corpus();
    } else if (screen === 'evidence') {
      state.data.evidence = await api.evidence();
    } else if (screen === 'storage') {
      state.data.storage = readStorageReport();
    } else if (screen === 'downloads') {
      state.data.downloads = await api.downloads(50);
    } else if (screen === 'workers') {
      state.data.workers = await api.workers();
    } else if (screen === 'diagnostics') {
      const [diag, workers, failed, enrichment, hygiene] = await Promise.all([
        api.diagnostics(), api.workers().catch(() => null), api.failedEvents(10).catch(() => ({ runs: [] })),
        api.enrichment().catch(() => null), api.hygiene().catch(() => null),
      ]);
      state.data.diagnostics = { diag, workers, failed, enrichment, hygiene };
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

function commandText(command, args) {
  try {
    const r = spawnSync(command, args, { encoding: 'utf8', timeout: 15000 });
    return r.status === 0 ? r.stdout.trim() : `unavailable (${cut(r.stderr || '', 100)})`;
  } catch (e) { return `unavailable (${cut(e.message, 100)})`; }
}

function readStorageReport() {
  const disk = commandText('df', ['-h', '/']);
  const docker = commandText('docker', ['system', 'df']);
  const scratch = commandText('du', ['-sh', '/var/tmp/patrick/hashsucker']);
  return { disk, docker, scratch, cleanup: 'scripts/hashsucker-housekeeping --clean' };
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
  out.push(`${C.dim}1 requests  2 library  3 providers  4 corpus  5 evidence  6 downloads  7 workers  8 logs  9 probes  0 storage${C.reset}`);
  return out.join('\n');
}

function matchFilter(s) {
  if (!state.filter) return true;
  return s.toLowerCase().includes(state.filter.toLowerCase());
}

function renderRequests() {
  const items = (state.data.requests?.items ?? []).filter((i) => matchFilter(`${i.title} ${i.mediaId} ${i.stage} ${i.intentLabel}`));
  const out = [`${C.bold}Requests${C.reset}  ${C.dim}${items.length} human requests · exact IDs/details available here · / filter${C.reset}`, line()];
  items.slice(0, Math.max(5, process.stdout.rows - 8)).forEach((it, idx) => {
    const cur = idx === state.cursor ? `${C.cyan}›${C.reset}` : ' ';
    out.push(`${cur} ${cut(it.title || it.mediaId || '?', 28).padEnd(28)} ${pill(cut(it.stage, 16), stateColor(it.stage))} ${cut(it.intentLabel, 18).padEnd(18)} ${cut(it.message, W() - 72)}`);
    if (state.detail === it.id) out.push(`    media=${it.mediaId} type=${it.mediaType} profile=${it.qualityProfile ?? 'balanced'} created=${it.createdAt ? new Date(it.createdAt).toISOString() : '—'}`);
  });
  return out.join('\\n');
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

function renderEvidence() {
  const data = state.data.evidence ?? {};
  const out = [`${C.bold}Evidence${C.reset}  ${C.dim}bounded source yield and claim calibration${C.reset}`, line()];
  out.push('Source'.padEnd(18) + 'Obs'.padStart(6) + 'Novel release'.padStart(15) + 'Novel assoc'.padStart(14) + 'Novel TF'.padStart(11) + 'Selected'.padStart(10));
  for (const row of data.sources ?? []) {
    out.push(`${cut(`${row.observer}/${row.source_class}`, 18).padEnd(18)}${String(row.asserted_observations ?? 0).padStart(6)}${String(row.novel_releases ?? 0).padStart(15)}${String(row.novel_associations ?? 0).padStart(14)}${String(row.novel_torrent_files ?? 0).padStart(11)}${String(row.selections ?? 0).padStart(10)}`);
  }
  out.push(line());
  out.push(`${C.bold}Query yield${C.reset}`);
  for (const row of data.queryYield ?? []) {
    const latency = data.queryLatency?.find((item) => item.source_class === row.source_class);
    out.push(`  ${row.source_class} queries=${row.query_count ?? 0} hashes=${row.hashes_observed ?? 0} novel=${row.novel_releases ?? 0} p50=${latency?.p50_latency_ms ?? '—'}ms p95=${latency?.p95_latency_ms ?? '—'}ms max=${latency?.max_latency_ms ?? '—'}ms`);
  }
  out.push(line());
  out.push(`${C.bold}Claim calibration${C.reset}`);
  for (const row of data.claimCalibration ?? []) out.push(`  ${row.observer} → ${row.provider} ${row.age_bucket}: ${row.confirmed ?? 0}/${row.claims ?? 0} confirmed`);
  if (!(data.sources ?? []).length && !(data.queryYield ?? []).length) out.push(`${C.dim}No evidence observations recorded yet.${C.reset}`);
  return out.join('\\n');
}

function renderCorpus() {
  const { lifecycle = {}, enrichment = {}, hygiene = {} } = state.data.corpus || {};
  const out = [`${C.bold}Corpus${C.reset}  ${C.dim}lifecycle, revision, enrichment, hygiene${C.reset}`, line()];
  out.push(`state        ${lifecycle.state ?? '?'}`);
  out.push(`revision     ${lifecycle.imported_revision ?? '—'}`);
  out.push(`commit       ${lifecycle.imported_commit ?? '—'}`);
  out.push(`candidates   ${lifecycle.candidate_count ?? '—'} · fragments ${lifecycle.fragment_count ?? '—'}`);
  out.push(`last success ${lifecycle.last_success ? new Date(lifecycle.last_success).toISOString() : '—'}`);
  out.push(`enrichment   ${enrichment.enabled === false ? 'disabled' : `${enrichment.lastOutcome ?? '?'} · learned ${enrichment.newHashes ?? 0} · refreshed ${enrichment.refreshed ?? 0}`}`);
  out.push(`hygiene      ${hygiene.enabled === false ? 'disabled' : `checked ${hygiene.checked ?? 0} · repaired ${hygiene.repaired ?? 0} · flagged ${hygiene.flagged ?? 0}`}`);
  return out.join('\\n');
}

function renderStorage() {
  const s = state.data.storage || {};
  return [`${C.bold}Storage / housekeeping${C.reset}  ${C.dim}report-only; no Docker socket or generic prune${C.reset}`, line(), `disk\\n${s.disk ?? '—'}`, `docker reclaimable\\n${s.docker ?? '—'}`, `known scratch\\n${s.scratch ?? '—'}`, `safe cleanup command\\n${s.cleanup ?? 'scripts/hashsucker-housekeeping --clean'}`].join('\\n');
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

function renderWorkers() {
  const out = [`${C.bold}Workers${C.reset}  ${C.dim}last/next tick and lifecycle visibility${C.reset}`, line()];
  out.push(cut(JSON.stringify(state.data.workers ?? {}, null, 2), W() - 1));
  return out.join('\\n');
}

function renderDiagnostics() {
  const { diag, workers, failed, enrichment, hygiene } = state.data.diagnostics || {};
  const out = [`${C.bold}Diagnostics${C.reset}`, line()];
  const kv = (k, v) => out.push(`${k.padEnd(14)} ${cut(v, W() - 17)}`);
  kv('corpus', `${diag?.corpus?.state ?? '?'}${diag?.corpus?.candidates != null ? ` · ${diag.corpus.candidates.toLocaleString()}` : ''}`);
  kv('vfs', diag?.publication?.vfs?.detail ?? '?');
  kv('strm', diag?.publication?.strm?.state ?? '?');
  kv('discovery-db', diag?.storage?.discoveryDb?.state ?? '?');
  kv('control-db', diag?.storage?.controlDb?.state ?? '?');
  kv('timers/workers', cut(JSON.stringify(workers ?? 'n/a'), 70));
  if (enrichment && enrichment.enabled !== false) {
    const bo = Object.keys(enrichment.backoffUntil ?? {}).length;
    kv('enrichment', `${enrichment.lastOutcome ?? '?'} · +${enrichment.newHashes ?? 0} ~${enrichment.refreshed ?? 0} x${enrichment.rejected ?? 0} · day ${enrichment.dailyCount ?? 0}${bo ? ` · backoff ${bo}` : ''}`);
  } else {
    kv('enrichment', 'disabled');
  }
  if (hygiene && hygiene.enabled !== false) {
    kv('hygiene', `${hygiene.lastOutcome ?? '?'} · checked ${hygiene.checked ?? 0} · repaired ${hygiene.repaired ?? 0} · flagged ${hygiene.flagged ?? 0}`);
  } else {
    kv('hygiene', 'disabled');
  }
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
  if (state.screen === 'home') s = renderHome();  else if (state.screen === 'requests') s = renderRequests();  else if (state.screen === 'activity') s = renderActivity();
  else if (state.screen === 'library') s = renderLibrary();
  else if (state.screen === 'providers') s = renderProviders();
  else if (state.screen === 'corpus') s = renderCorpus();
  else if (state.screen === 'evidence') s = renderEvidence();
  else if (state.screen === 'storage') s = renderStorage();
  else if (state.screen === 'downloads') s = renderDownloads();
  else if (state.screen === 'diagnostics') s = renderDiagnostics();
  else if (state.screen === 'logs') s = renderLogs();
  else if (state.screen === 'probes') s = renderProbes();
  else if (state.screen === 'workers') s = renderWorkers();
  if (state.error) s += `\n${C.red}error: ${cut(state.error, W() - 9)}${C.reset}`;
  emit(s.endsWith('\n') ? s : `${s}\n`);
}

const SCREENS = ['home', 'requests', 'library', 'providers', 'corpus', 'evidence', 'downloads', 'workers', 'logs', 'probes', 'storage'];

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
    if (['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].includes(k)) {
      if (state.screen === 'probes' && ['1', '2', '3', '4'].includes(k)) {
        await runProbe(k);
        render();
        return;
      }
      const map = { 0: 'storage', 1: 'requests', 2: 'library', 3: 'providers', 4: 'corpus', 5: 'evidence', 6: 'downloads', 7: 'workers', 8: 'logs', 9: 'probes' };
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
    if (state.screen === 'requests') {
    const items = state.data.requests?.items ?? [];
    const it = items[state.cursor];
    state.detail = it && state.detail !== it.id ? it.id : null;
  } else if (state.screen === 'activity') {
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

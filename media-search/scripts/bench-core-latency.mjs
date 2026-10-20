/**
 * Core product latency benchmark (Part 8).
 *
 * Controlled fixture samples (hermetic, zero network) across workflow
 * classes. Prints p50/p95/mean per class plus the dominant stage where
 * attributable. Sandbox timings are order-of-magnitude guides, not
 * production SLAs — the product claim is the workflow shape and the
 * dominant-stage identification, not absolute milliseconds.
 *
 *   A. healthy reuse (noop return, no work)
 *   B. local-corpus direct (rank + bind + stage, no live)
 *   C. live fast-source discovery (bloodhound fanout + bind + publish)
 *   D. provider recovery (corpus miss → bloodhound → bind)
 *   E. plex-only convergence (republish, no discovery/binding)
 *
 * Usage: node scripts/bench-core-latency.mjs [samples=15]
 */
import { searchByMedia } from '../src/api/media-request.js';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import {
  MEDIA_ID, LIVE_H1, CORPUS_H1, SIZES,
  seedCorpusRow, liveStreams,
  stubEnsure, stubStoreWithCoords,
  bloodhoundSeam, baseRequest,
} from '../test/helpers/core-harness.js';

const SAMPLES = Math.max(3, parseInt(process.argv[2] || '15', 10));

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i];
}
function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, p50: quantile(s, 0.5), p95: quantile(s, 0.95), mean };
}
const fmt = (v) => (v == null ? 'n/a' : `${v.toFixed(1)}ms`);

// Sandbox fetch stub (module scope; this process is bench-only).
const _seen = [];
const _realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const href = String(url);
  _seen.push(href);
  if (!href.includes('fake.local')) throw new Error(`no-network: ${href.slice(0, 80)}`);
  const key = Object.keys(liveStreams()).find((k) => href.includes(k));
  return { ok: true, status: 200, json: async () => ({ streams: liveStreams()[key] ?? [] }) };
};

process.env.STRM_OUTPUT_PATH = process.env.STRM_OUTPUT_PATH || '/tmp/bench-core-strm';

async function timeRequest(build) {
  const started = performance.now();
  const result = await build();
  return { ms: performance.now() - started, result };
}

function freshCorpusBindable() {
  const cache = createDiscoveryCache();
  seedCorpusRow(cache, { infoHash: CORPUS_H1 });
  const store = stubStoreWithCoords();
  const ensureCalls = [];
  const ensure = async ({ infoHash, skipSizeMatch } = {}) => {
    ensureCalls.push(1);
    const hash = String(infoHash || '').toLowerCase();
    if (hash === CORPUS_H1.toLowerCase() && skipSizeMatch) {
      const tf = { id: 'tf_bench_c', infoHash: hash, size: 555555555, internalPath: 'Harness/Season 01/Harness - S01E07.mkv' };
      store.register(tf);
      return { placementId: 'pl', torrentFiles: [{ ...tf }] };
    }
    const err = new Error('no placement');
    err.code = 'NO_PLACEMENT';
    throw err;
  };
  return { cache, store, ensure, ensureCalls };
}

const rows = [];
async function benchClass(name, setup, extra = {}) {
  const samples = [];
  let liveMs = [];
  for (let i = 0; i < SAMPLES; i++) {
    const { cache, run, liveCounter } = await setup();
    const { ms, result } = await timeRequest(run);
    samples.push(ms);
    if (result?.discovery?.liveSources) {
      liveMs.push(result.discovery.liveSources.reduce((a, s) => a + (s.latencyMs || 0), 0));
    }
    cache.close();
    void liveCounter;
  }
  const s = stats(samples);
  rows.push({ name, ...s, liveFanoutP50: liveMs.length ? quantile([...liveMs].sort((a, b) => a - b), 0.5) : null, ...extra });
}

// A. healthy reuse: prepared truth → noop return.
await benchClass('A reuse-noop', async () => {
  const { cache, store, ensure } = freshCorpusBindable();
  const liveCounter = { count: 0 };
  const req = (plex) => baseRequest({ controlPlaneStore: store, ensureTorBoxFileIdentity: ensure, confirmPlexFn: plex, liveDiscoveryFn: async () => { liveCounter.count++; throw new Error('x'); } });
  await searchByMedia(cache, req(async () => null)); // prime (untimed)
  return {
    cache, store, ensure, liveCounter,
    run: () => searchByMedia(cache, req(async () => ({ visible: true, mediaPart: { file: 'x' } }))),
  };
});

// B. corpus-direct staged (rank + bind, no live).
await benchClass('B corpus-direct', () => {
  const { cache, store, ensure } = freshCorpusBindable();
  const liveCounter = { count: 0 };
  return {
    cache, store, ensure, liveCounter,
    run: () => searchByMedia(cache, baseRequest({ controlPlaneStore: store, ensureTorBoxFileIdentity: ensure, confirmPlexFn: async () => null, liveDiscoveryFn: async () => { liveCounter.count++; throw new Error('x'); } })),
  };
});

// C. live fast discovery (bloodhound + bind + publish).
await benchClass('C live-fast', () => {
  const cache = createDiscoveryCache();
  const store = stubStoreWithCoords();
  const liveCounter = { count: 0 };
  const ensureCalls = [];
  return {
    cache, store, ensure: null, liveCounter,
    run: () => searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, { bindable: new Set([LIVE_H1.toLowerCase()]), backingStore: store }),
      confirmPlexFn: async () => ({ visible: true, mediaPart: { file: 'x' } }),
      liveDiscoveryFn: bloodhoundSeam(liveCounter),
    })),
  };
});

// D. provider recovery (corpus miss → bloodhound → bind).
await benchClass('D recovery', () => {
  const cache = createDiscoveryCache();
  seedCorpusRow(cache, { infoHash: CORPUS_H1, episode: 6 });
  const store = stubStoreWithCoords();
  const liveCounter = { count: 0 };
  const ensureCalls = [];
  return {
    cache, store, ensure: null, liveCounter,
    run: () => searchByMedia(cache, baseRequest({
      controlPlaneStore: store,
      ensureTorBoxFileIdentity: stubEnsure(ensureCalls, { bindable: new Set([LIVE_H1.toLowerCase()]), backingStore: store }),
      confirmPlexFn: async () => ({ visible: true, mediaPart: { file: 'x' } }),
      liveDiscoveryFn: bloodhoundSeam(liveCounter),
    })),
  };
});

// E. plex-only convergence (republish path).
await benchClass('E plex-converge', async () => {
  const { cache, store, ensure } = freshCorpusBindable();
  const liveCounter = { count: 0 };
  const req = (plex) => baseRequest({ controlPlaneStore: store, ensureTorBoxFileIdentity: ensure, confirmPlexFn: plex, liveDiscoveryFn: async () => { liveCounter.count++; throw new Error('x'); } });
  await searchByMedia(cache, req(async () => null)); // stage (untimed)
  return {
    cache, store, ensure, liveCounter,
    run: () => searchByMedia(cache, req(async () => ({ visible: true, mediaPart: { file: 'x' } }))),
  };
});

console.log('class | n | p50 | p95 | mean | live-fanout p50');
for (const r of rows) {
  console.log(`${r.name} | ${r.n} | ${fmt(r.p50)} | ${fmt(r.p95)} | ${fmt(r.mean)} | ${fmt(r.liveFanoutP50)}`);
}
globalThis.fetch = _realFetch;

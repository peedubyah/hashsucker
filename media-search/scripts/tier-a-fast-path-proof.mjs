#!/usr/bin/env node
/** Controlled scratch proof of the actual healthy-publication request path. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { searchByMedia } from '../src/api/media-request.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hashsucker-tier-a-'));
process.env.STRM_OUTPUT_PATH = root;
const cache = createDiscoveryCache();
let providerCalls = 0;
const cases = [
  { mediaId: 'proof-movie-1', mediaType: 'movie', hash: 'a'.repeat(40), tf: 'tf-proof-movie-1', filename: 'Proof Movie 1.mkv', path: 'Movies/Proof Movie 1/Proof Movie 1.strm' },
  { mediaId: 'proof-tv-1', mediaType: 'series', season: 1, episode: 1, hash: 'b'.repeat(40), tf: 'tf-proof-tv-1', filename: 'Proof Show S01E01.mkv', path: 'TV Shows/Proof Show/Season 01/Proof Show - S01E01.strm' },
  { mediaId: 'proof-movie-2', mediaType: 'movie', hash: 'c'.repeat(40), tf: 'tf-proof-movie-2', filename: 'Proof Movie 2.mkv', path: 'Movies/Proof Movie 2/Proof Movie 2.strm' },
];
const store = {
  getTorrentFile(id) { const c = cases.find(x => x.tf === id); return c ? { id, infoHash: c.hash, internalPath: c.filename, size: 12345 } : null; },
  listDataPlaneCoordinates(id) { providerCalls++; return cases.some(x => x.tf === id) ? [{ provider: 'torbox', providerResourceId: `resource-${id}` }] : []; },
  getLibraryItemByIdentityKey() { return { desiredState: 'present' }; },
};
for (const c of cases) {
  const requestId = cache.persistMediaRequest({ mediaId: c.mediaId, mediaType: c.mediaType, season: c.season ?? null, episode: c.episode ?? null }, []);
  cache.persistPlaybackHandoff({ requestId, mediaId: c.mediaId, mediaType: c.mediaType, season: c.season ?? null, episode: c.episode ?? null, releaseKey: `${c.hash}:torrent`, infoHash: c.hash, fileIndex: null, filename: c.filename, provider: 'torbox', providerState: 'cached', identityTier: 'Verified', resolutionState: 'resolved', selectionReason: 'proof', selectedAt: Date.now(), torrentFileId: c.tf });
  if (c.mediaType === 'movie') cache.createVfsMovieEntry({ mediaId: c.mediaId, releaseKey: `${c.hash}:torrent`, infoHash: c.hash, fileIndex: null, canonicalPath: `Movies/${c.mediaId}/file.mkv`, torrentFileId: c.tf, size: 12345, createdAt: Date.now(), updatedAt: Date.now() });
  else cache.createVfsTvEntry({ mediaId: c.mediaId, season: c.season, episode: c.episode, releaseKey: `${c.hash}:torrent`, infoHash: c.hash, fileIndex: null, canonicalPath: `TV/${c.mediaId}/file.mkv`, torrentFileId: c.tf, size: 12345, createdAt: Date.now(), updatedAt: Date.now() });
  const strm = path.join(root, c.path); await fs.mkdir(path.dirname(strm), { recursive: true });
  const url = c.mediaType === 'movie' ? `/stream/movie/${c.mediaId}` : `/stream/series/${c.mediaId}?season=${c.season}&episode=${c.episode}`;
  await fs.writeFile(strm, `http://localhost:8080${url}\n`);
}
const samples=[];
for (let round=0; round<10; round++) for (const c of cases) {
  const started=performance.now();
  const result=await searchByMedia(cache, { mediaId:c.mediaId, mediaType:c.mediaType, season:c.season, episode:c.episode, controlPlaneStore:store, skipLiveDiscovery:false, skipAvailability:false });
  samples.push({case:c.mediaId,ms:performance.now()-started,reuseMode:result.reuseMode,reason:result.selection?.reason,discovery:result.discovery,ranking:result.ranking,availability:result.availability});
}
const ms=samples.map(x=>x.ms).sort((a,b)=>a-b); const pct=p=>ms[Math.min(ms.length-1,Math.ceil(ms.length*p)-1)];
console.log(JSON.stringify({status:'scratch-only',cases:cases.length,repetitions:samples.length,latencyMs:{p50:Number(pct(.5).toFixed(3)),p95:Number(pct(.95).toFixed(3)),min:Number(ms[0].toFixed(3)),max:Number(ms.at(-1).toFixed(3))},providerCoordinateLookups:providerCalls,allNoop:samples.every(x=>x.reuseMode==='noop'),allDiscoveryFalse:samples.every(x=>x.discovery?.liveDiscoveryTriggered===false),allRankingDisabled:samples.every(x=>x.ranking?.TieredRankingApplied===false),allAvailabilityZero:samples.every(x=>x.availability?.checked===0),samples:samples.slice(0,3)}));
cache.close(); await fs.rm(root,{recursive:true,force:true});

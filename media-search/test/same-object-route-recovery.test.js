import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createAlternateFallback } from '../src/lib/resolver/alternate-fallback.js';
import { createRevalidator, REVALIDATION_OUTCOME } from '../src/lib/resolver/availability-revalidation.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';
const ALT = 'abcdef0123456789abcdef0123456789abcdef02';
const TF = 'tf-same-object';
const PATH = 'Shows/Example/Season 01/Example - S01E01.mkv';
const SIZE = 123456789;

function setup() {
  const cache = createDiscoveryCache({ db: new DatabaseSync(':memory:') });
  const cp = createControlPlaneStore({ database: new DatabaseSync(':memory:') });
  const item = cp.ensureLibraryItem({ mediaType: 'episode', mediaId: 'tt_same', title: 'Example', season: 1, episode: 1, desiredState: 'present' });
  cp.db.prepare('INSERT INTO torrent_files (id,info_hash,internal_path,size,created_at) VALUES (?,?,?,?,?)').run(TF,HASH,PATH,SIZE,1);
  const tor = cp.recordPlacement({ provider:'torbox', accountScope:'primary', infoHash:HASH, providerResourceId:'tb-same', state:'ready', ownership:'owned', provenance:'test' });
  cp.replaceProviderFileInventory(tor.id,[{providerFileId:'tb-file',path:PATH,name:'Example - S01E01.mkv',size:SIZE,selected:true}],{authoritative:true,complete:true});
  cp.recordFileMapping({infoHash:HASH,fileIndex:null,fileIndexKey:-1,releaseKey:`${HASH}:torrent`,placementId:tor.id,providerFileId:'tb-file',state:'mapped',method:'test',authoritative:true});
  const rd = cp.recordPlacement({ provider:'realdebrid', accountScope:'primary', infoHash:HASH, providerResourceId:'rd-same', state:'ready', ownership:'owned', provenance:'test' });
  cp.replaceProviderFileInventory(rd.id,[{providerFileId:'rd-file',path:PATH,name:'Example - S01E01.mkv',size:SIZE,selected:true}],{authoritative:true,complete:true});
  cp.recordFileMapping({infoHash:HASH,fileIndex:null,fileIndexKey:-1,releaseKey:`${HASH}:torrent`,placementId:rd.id,providerFileId:'rd-file',state:'mapped',method:'test',authoritative:true});
  cache.createVfsTvEntry({mediaId:'tt_same',season:1,episode:1,releaseKey:`${HASH}:torrent`,infoHash:HASH,fileIndex:null,canonicalPath:PATH,torrentFileId:TF,size:SIZE,createdAt:1,updatedAt:1});
  return {cache,cp,item,tor,rd};
}

test('same-object provider route recovery preserves TorrentFile identity', async () => {
  const s=setup(); const calls=[];
  const revalidator=createRevalidator({checkTorBoxCached:async()=>{calls.push('torbox-check');return {cached:new Set(),failed:new Set(),details:new Map(),latencyMs:new Map()}},now:()=>Date.now(),maxAgeMs:0});
  const rdResolution={get:()=>null,set:()=>{},getOrInFlight:async(_h,_f,fn)=>{calls.push('realdebrid-resolve');return fn()}};
  const fallback=createAlternateFallback({searchCache:s.cache,revalidator,rdClient:{},rdResolutionCache:rdResolution,attemptRdResolution:async()=>({usable:true,provider:'realdebrid',url:'https://rd.example/same',releaseKey:`${HASH}:torrent`,infoHash:HASH,fileIndex:null,rdFileId:'rd-file',torrentId:'rd-same'})});
  const before=s.cp.getTorrentFile(TF); const vfsBefore=s.cache.getVfsTvEntry('tt_same',1,1);
  const result=await fallback.findUsableAlternate({mediaId:'tt_same',primaryReleaseKey:`${HASH}:torrent`,expectedScope:{media_type:'episode',season:1,episode:1},additionalAttemptedKeys:new Set([`${HASH}:torrent`])});
  assert.equal(result,null,'same object is not an alternate Release candidate');
  assert.deepEqual(s.cp.getTorrentFile(TF),before); assert.deepEqual(s.cache.getVfsTvEntry('tt_same',1,1),vfsBefore); assert.ok(calls.length===0);
  s.cache.close();s.cp.close();
});

test('both providers unavailable return no candidate fallback and preserve object fixtures', async () => {
  const s=setup(); const revalidator=createRevalidator({checkTorBoxCached:async()=>({cached:new Set(),failed:new Set(),details:new Map(),latencyMs:new Map()}),now:()=>Date.now(),maxAgeMs:0});
  const fallback=createAlternateFallback({searchCache:s.cache,revalidator});
  const result=await fallback.findUsableAlternate({mediaId:'tt_same',primaryReleaseKey:`${HASH}:torrent`,expectedScope:{media_type:'episode',season:1,episode:1}});
  assert.equal(result,null); assert.equal(s.cp.getTorrentFile(TF).infoHash,HASH); assert.equal(s.cp.getTorrentFile(TF).internalPath,PATH); assert.equal(s.cp.getTorrentFile(TF).size,SIZE); assert.equal(s.cache.getVfsTvEntry('tt_same',1,1).torrentFileId,TF); s.cache.close();s.cp.close();
});

test('explicit alternate candidate fallback is a different Release object', async () => {
  const s=setup();
  s.cache.persistMediaRequest({mediaId:'tt_same',mediaType:'episode',season:1,episode:1,source:'test'},[{infoHash:HASH,fileIndex:null,filename:PATH,score:1,rank:1,eligible:1},{infoHash:ALT,fileIndex:null,filename:'Example-alt.mkv',score:0.9,rank:2,eligible:1}]);
  const revalidator=createRevalidator({checkTorBoxCached:async()=>({cached:new Set([ALT]),failed:new Set(),details:new Map(),latencyMs:new Map()}),now:()=>Date.now(),maxAgeMs:0});
  const fallback=createAlternateFallback({searchCache:s.cache,revalidator});
  const result=await fallback.findUsableAlternate({mediaId:'tt_same',primaryReleaseKey:`${HASH}:torrent`,expectedScope:{media_type:'episode',season:1,episode:1}});
  assert.equal(result?.candidate?.info_hash,ALT); assert.notEqual(result?.candidate?.info_hash,HASH); s.cache.close();s.cp.close();
});

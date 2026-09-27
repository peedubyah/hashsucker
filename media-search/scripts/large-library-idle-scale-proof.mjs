#!/usr/bin/env node
/**
 * Scratch 1k/10k library maintenance selector proof.
 * Uses real control-plane/cache implementations but stub adapters and no provider calls.
 */
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { createIdleEnrichment } from '../src/lib/discovery/idle-enrichment.js';
import { createCorpusHygiene } from '../src/lib/discovery/corpus-hygiene.js';
import { runReconcile } from '../src/lib/consumers/reconcile.js';

function makeStores(n) {
  const cache=createDiscoveryCache({db:new DatabaseSync(':memory:')});
  const cp=createControlPlaneStore({database:new DatabaseSync(':memory:')});
  for(let i=0;i<n;i++){
    const mediaId=`scale-${i}`;
    cp.ensureLibraryItem({mediaType:'movie',mediaId,title:`Scale ${i}`,desiredState:'present'});
    const hash=String(i).padStart(40,'0');
    cache.createVfsMovieEntry({mediaId,releaseKey:`${hash}:torrent`,infoHash:hash,fileIndex:null,canonicalPath:`Movies/${mediaId}/file.mkv`,torrentFileId:null,size:12345,createdAt:1,updatedAt:1});
  }
  return {cache,cp};
}
async function run(n){const {cache,cp}=makeStores(n);let consumerCalls=0;const adapters=[{name:'stub',enabled:()=>true,listLibrary:async()=>{consumerCalls++;return[]}}];
const t0=performance.now();const reconcile=await runReconcile({cache,controlPlaneStore:cp,adapters,policy:{enabled:false,graceMs:0,minObservations:1}});const reconcileMs=performance.now()-t0;
const enrichment=createIdleEnrichment({cache,controlPlaneStore:cp,measureLag:async()=>1,now:()=>1_000_000,env:{},discoverFn:async()=>{throw new Error('must not discover')}});const e0=performance.now();const er=await enrichment.tickOnce();const enrichmentMs=performance.now()-e0;
const hygiene=createCorpusHygiene({cache,controlPlaneStore:cp,measureLag:async()=>1,now:()=>1_000_000,env:{}});const h0=performance.now();const hr=await hygiene.tickOnce();const hygieneMs=performance.now()-h0;
const out={items:n,reconcile:{ms:Number(reconcileMs.toFixed(3)),published:reconcile.published,observations:reconcile.observations?.length??null,consumerCalls,retired:reconcile.retired},enrichment:{ms:Number(enrichmentMs.toFixed(3)),reason:er.reason,acted:er.acted},hygiene:{ms:Number(hygieneMs.toFixed(3)),checked:hr.checked??0,repaired:hr.repaired??0,flagged:hr.flagged??0}};cache.close();cp.close();return out}
console.log(JSON.stringify({status:'scratch-only',scales:[await run(1000),await run(10000)],note:'No provider, source, VFS, publication, or acquisition calls.'},null,2));

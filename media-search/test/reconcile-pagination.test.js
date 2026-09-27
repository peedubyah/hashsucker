import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { runReconcile } from '../src/lib/consumers/reconcile.js';

function adapter(calls) { return { name: 'stub', listLibrary: async () => { calls.push('list'); return []; } }; }

test('reconcile covers 1500 published items across pages without duplicates', async () => {
  const cache=createDiscoveryCache();const store=createControlPlaneStore();const calls=[];
  for(let i=0;i<1500;i++){const id=`page-${String(i).padStart(4,'0')}`;store.ensureLibraryItem({mediaType:'movie',mediaId:id,title:id,desiredState:'present'});cache.createVfsMovieEntry({mediaId:id,releaseKey:`${String(i).padStart(40,'0')}:torrent`,infoHash:String(i).padStart(40,'0'),fileIndex:null,canonicalPath:`Movies/${id}.mkv`,torrentFileId:null,size:1,createdAt:1,updatedAt:1})}
  const r=await runReconcile({cache,controlPlaneStore:store,adapters:[adapter(calls)],policy:{enabled:false}});
  assert.equal(r.published,1500);assert.equal(r.examined,1500);assert.equal(calls.length,1);assert.equal(store.listConsumerObservations({mediaId:'page-1499'}).length,1);cache.close();store.close();
});

test('reconcile below page size remains complete', async () => {
  const cache=createDiscoveryCache();const store=createControlPlaneStore();const calls=[];
  for(let i=0;i<12;i++){const id=`small-${i}`;store.ensureLibraryItem({mediaType:'movie',mediaId:id,title:id,desiredState:'present'});cache.createVfsMovieEntry({mediaId:id,releaseKey:`${String(i).padStart(40,'0')}:torrent`,infoHash:String(i).padStart(40,'0'),fileIndex:null,canonicalPath:`Movies/${id}.mkv`,torrentFileId:null,size:1,createdAt:1,updatedAt:1})}
  const r=await runReconcile({cache,controlPlaneStore:store,adapters:[adapter(calls)],policy:{enabled:false}});assert.equal(r.published,12);assert.equal(calls.length,1);cache.close();store.close();
});

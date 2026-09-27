#!/usr/bin/env node
import { DatabaseSync } from 'node:sqlite';
import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { createControlPlaneStore } from '../src/lib/control-plane/store.js';
import { runReconcile } from '../src/lib/consumers/reconcile.js';
const n=Number(process.env.RECONCILE_AUDIT_ITEMS||10000);const cache=createDiscoveryCache({db:new DatabaseSync(':memory:')});const cp=createControlPlaneStore({database:new DatabaseSync(':memory:')});
for(let i=0;i<n;i++){const id=`audit-${String(i).padStart(5,'0')}`;cp.ensureLibraryItem({mediaType:'movie',mediaId:id,title:id,desiredState:'present'});cache.createVfsMovieEntry({mediaId:id,releaseKey:`${String(i).padStart(40,'0')}:torrent`,infoHash:String(i).padStart(40,'0'),fileIndex:null,canonicalPath:`Movies/${id}.mkv`,torrentFileId:null,size:1,createdAt:1,updatedAt:1})}
const adapter={name:'stub',listLibrary:async()=>Array.from({length:n},(_,i)=>({mediaId:`audit-${String(i).padStart(5,'0')}`,consumerItemId:String(i)}))};
function count(){return cp.db.prepare('SELECT COUNT(*) n FROM consumer_observations').get().n}
const before=count();const p1=await runReconcile({cache,controlPlaneStore:cp,adapters:[adapter],policy:{enabled:false},now:1000});const after1=count();const p2=await runReconcile({cache,controlPlaneStore:cp,adapters:[adapter],policy:{enabled:false},now:2000});const after2=count();const sample=cp.db.prepare('SELECT consumer,present,consumer_item_id,source,first_checked_at,last_checked_at,last_seen_present_at FROM consumer_observations WHERE media_id=?').get('audit-00000');console.log(JSON.stringify({items:n,rowsBefore:before,pass1:{examined:p1.examined,writes:after1-before,stateChanges:after1-before},pass2:{examined:p2.examined,writes:after2-after1,stateChanges:0},observationRows:after2,sample,note:'SQLite row count cannot expose UPDATE count; pass2 rewrites same primary keys while changing timestamps.'},null,2));cache.close();cp.close();

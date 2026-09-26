#!/usr/bin/env node
/** Read-only demand-weighted enrichment target replay. */
import { DatabaseSync } from 'node:sqlite';
const discoveryPath=process.env.DISCOVERY_DB||'/home/patrick/hashsucker-data/discovery/discovery-cache.db';
const controlPath=process.env.CONTROL_PLANE_DB||'/home/patrick/hashsucker-data/discovery/control-plane.db';
const d=new DatabaseSync(discoveryPath,{readOnly:true}); const c=new DatabaseSync(controlPath,{readOnly:true});
const now=Number(process.env.REPLAY_NOW||Date.now()); const cutoff=now-30*24*60*60*1000;
const assoc=d.prepare('SELECT media_id,COUNT(*) n FROM candidate_media GROUP BY media_id'); const assocMap=new Map(assoc.all().map(x=>[x.media_id,x.n]));
const results=d.prepare('SELECT COUNT(*) n FROM media_request_results WHERE request_id IN (SELECT id FROM media_requests WHERE media_id=? AND media_type=? AND (season IS ? OR season=?) AND (episode IS ? OR episode=?)) AND eligible=1');
const published=new Set(c.prepare("SELECT media_id||'|'||COALESCE(season,'')||'|'||COALESCE(episode,'') k FROM library_items WHERE desired_state='present'").all().map(x=>x.k));
const key=(x)=>`${x.media_type}|${x.media_id}|${x.season??''}|${x.episode??''}`;
const targets=[];
function push(x){if(!targets.some(y=>key(y)===key(x)))targets.push(x)}
const future=d.prepare("SELECT media_id,media_type,season,episode,state,expected_at FROM future_intents WHERE state IN ('anticipated','failed') ORDER BY CASE WHEN expected_at IS NULL THEN 1 ELSE 0 END,expected_at").all();
for(const x of future) push({class:'future-intent',media_id:x.media_id,media_type:x.media_type==='episode'?'episode':x.media_type,season:x.season,episode:x.episode,expected_at:x.expected_at,reason:'future intent',demand:true});
const human=d.prepare("SELECT media_id,media_type,season,episode,source,source_type,created_at FROM media_requests WHERE created_at>=? AND source IN ('seerr','web','plex-watchlist','operator') ORDER BY created_at DESC").all(cutoff);
for(const x of human) push({class:'recent-request',media_id:x.media_id,media_type:x.media_type,season:x.season,episode:x.episode,source:x.source,created_at:x.created_at,reason:'human request in 30d',demand:true});
const libs=c.prepare("SELECT media_id,media_type,season,episode FROM library_items WHERE desired_state='present'").all();
for(const x of libs){const n=assocMap.get(x.media_id)||0;if(n<3)push({class:'thin-diversity',media_id:x.media_id,media_type:x.media_type,season:x.season,episode:x.episode,reason:`${n} known associations`,demand:true})}
function enrich(x){const assocCount=assocMap.get(x.media_id)||0;const depth=results.get(x.media_id,x.media_type,x.season,x.season,x.episode,x.episode).n;const pub=published.has(`${x.media_id}|${x.season??''}|${x.episode??''}`)||published.has(`${x.media_id}||`);return {...x,assocCount,candidateDepth:depth,published:pub,demandLinked:true,gainClass:depth===0?'DEPTH_GAIN':depth<3?'RESILIENCE_GAIN':'NO_GAIN'};}
const current=targets.slice(0,100).map(enrich);
// Alternative is lexicographically demand-adjacent first, then published fragile,
// then generic health. Current main already has no generic sparse/below-terminal pool.
const order={"future-intent":0,"recent-request":1,"thin-diversity":2};
const alt=[...targets].sort((a,b)=>(order[a.class]-order[b.class])||((a.expected_at??Number.MAX_SAFE_INTEGER)-(b.expected_at??Number.MAX_SAFE_INTEGER))).slice(0,100).map(enrich);
function summary(xs){return {slots:xs.length,classes:Object.fromEntries([...new Set(xs.map(x=>x.class))].map(k=>[k,xs.filter(y=>y.class===k).length])),demandLinked:xs.filter(x=>x.demandLinked).length,generic:xs.filter(x=>!x.demandLinked).length,depth0:xs.filter(x=>x.candidateDepth===0).length,depth1:xs.filter(x=>x.candidateDepth===1).length,depth2to9:xs.filter(x=>x.candidateDepth>=2&&x.candidateDepth<10).length,depth10plus:xs.filter(x=>x.candidateDepth>=10).length,publicationLinked:xs.filter(x=>x.published).length,gainClasses:Object.fromEntries([...new Set(xs.map(x=>x.gainClass))].map(k=>[k,xs.filter(y=>y.gainClass===k).length]))};}
const sourceRows=d.prepare('SELECT sources FROM candidates WHERE sources IS NOT NULL').all();const sourceCounts={};for(const r of sourceRows){try{for(const s of JSON.parse(r.sources)||[]){const o=s.origin||s.kind||'unknown';sourceCounts[o]=(sourceCounts[o]||0)+1}}catch{}}
console.log(JSON.stringify({status:'offline-read-only',now,backlog:{identityEnrichmentPending:d.prepare("SELECT COUNT(*) n FROM identity_enrichment_queue WHERE status='pending'").get().n,futureByState:d.prepare('SELECT state,COUNT(*) n FROM future_intents GROUP BY state').all(),humanRecent:human.length,publishedLibrary:libs.length,thinPublished:targets.filter(x=>x.class==='thin-diversity').length},classes:{futureIntent:future.length,recentRequest:human.length,thinDiversity:targets.filter(x=>x.class==='thin-diversity').length,genericSparse:0,genericBelowTerminal:0},current100:summary(current),demandWeighted100:summary(alt),sameOrdering:current.map(x=>key(x)).join('|')===alt.map(x=>key(x)).join('|'),currentTargets:current,demandWeightedTargets:alt,sourceProvenanceCounts:sourceCounts,note:'Candidate depth and source counts are diagnostic proxies. No live discovery, acquisition, persistence, or provider calls were performed.'},null,2));d.close();c.close();

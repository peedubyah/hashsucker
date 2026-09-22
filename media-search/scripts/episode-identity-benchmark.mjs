#!/usr/bin/env node
/** Read-only per-request episode identity benchmark. */
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { parsedReleaseTitle } from '../src/lib/discovery/identity-agreement.js';
import { normalizeShowTitle, agreeShowIdentity } from '../src/lib/discovery/show-identity.js';
import { canonicalReleaseTitle } from '../src/lib/discovery/release-title.js';
import { isEpisodeCovered } from '../src/lib/discovery/episode-coverage.js';

const dbPath = process.env.DISCOVERY_DB || '/home/patrick/hashsucker-data/discovery/discovery-cache.db';
const db = new DatabaseSync(dbPath, { readOnly: true });
const requests = [
  ['Breaking Bad','tt0903747',2008,1,1,'mainstream-old'], ['Breaking Bad','tt0903747',2008,1,6,'multi/pack'],
  ['Ted Lasso','tt10986410',2020,1,1,'mainstream-current'], ['Ted Lasso','tt10986410',2020,1,10,'mainstream-current'],
  ['When They See Us','tt7137906',2019,1,1,'miniseries'], ['When They See Us','tt7137906',2019,1,4,'miniseries'],
  ['Chernobyl','tt7366338',2019,1,1,'miniseries/pack'], ['Chernobyl','tt7366338',2019,1,5,'miniseries/pack'],
  ['Game of Thrones','tt0944947',2011,1,1,'season-pack'], ['Game of Thrones','tt0944947',2011,8,6,'mainstream-old'],
  ['The Sopranos','tt0141842',1999,1,1,'mainstream-old'], ['The Sopranos','tt0141842',1999,6,21,'mainstream-old'],
  ['The Last of Us','tt3581920',2023,1,1,'mainstream-current'], ['The Last of Us','tt3581920',2023,1,3,'mainstream-current'],
  ['Fleabag','tt5687612',2016,1,1,'pack-heavy'], ['Fleabag','tt5687612',2016,2,6,'pack-heavy'],
  ['True Detective','tt2356777',2014,1,1,'remake/anthology'], ['True Detective','tt2356777',2014,4,6,'remake/anthology'],
  ['The Twilight Zone','tt0052520',1959,1,1,'older'], ['The Twilight Zone','tt0052520',1959,5,1,'older'],
  ['Deadwood','tt0348914',2004,1,1,'older'], ['Deadwood','tt0348914',2004,3,12,'older'],
  ['Friends','tt0108778',1994,1,1,'ambiguous'], ['Lost','tt0411008',2004,1,1,'ambiguous'],
  ['House','tt0412142',2004,1,1,'ambiguous'], ['Dark','tt5753856',2017,1,1,'ambiguous'],
  ['From','tt9813792',2022,1,1,'ambiguous'], ['You','tt7335184',2018,1,1,'ambiguous'],
  ['The Office US','tt0386676',2005,1,1,'regional'], ['The Office UK','tt0290978',2001,1,1,'regional'],
];
const ambiguous = [
  ['Friends',['Fast Friends','Fantastic Friends','Your Friends and Neighbors']],
  ['Lost',['Lost in Space','Lost Ollie']], ['House',['House of the Dragon','Full House']],
  ['Dark',['Dark Matter','Dark Winds']], ['From',['From Dusk Till Dawn','From Scratch']],
  ['You',['You Me and Her','You'],], ['The Office US',['The Office UK','The Office Australia']],
  ['The Office UK',['The Office US','The Office Australia']], ['The Bear',['Bear Grylls','The Bear']],
  ['The Boys',['The Boy','The Boys Presents']],
];
function ftsMatch(title) { return normalizeShowTitle(title).split(' ').filter(Boolean).map(t => `"${t.replaceAll('"','""')}"`).join(' AND '); }
function attrs(row) { return { season: row.season, episode: row.episode, episodeRange: row.episode_range, seasonOnly: row.media_type === 'season', mediaType: row.media_type }; }
function rawTitle(release) { const p=parsedReleaseTitle(release); const raw=String(release.filename||'').split('/').pop()?.replace(/\.[^.]+$/,'')||''; return normalizeShowTitle(p.title||raw); }
function rawAgree(context,row) { const p=parsedReleaseTitle({filename:row.filename}); const refs=[context.canonicalTitle,...(context.alternateTitles||[])].map(normalizeShowTitle); const title=rawTitle(row); return refs.includes(title) && (p.year==null || context.firstAirYear==null || Math.abs(p.year-context.firstAirYear)<=1); }
function canonicalAgree(context,row) { const result = agreeShowIdentity({...context, release:{filename:row.filename}, year:row.year}); return result.matched; }
function canonicalTitleOnly(context,row) { const title = normalizeShowTitle(canonicalReleaseTitle({filename:row.filename})); return [context.canonicalTitle,...(context.alternateTitles||[])].map(normalizeShowTitle).includes(title); }
function pct(a,b) { return b ? Number((100*a/b).toFixed(2)) : 0; }
function percentile(a,p) { const x=[...a].sort((u,v)=>u-v); return x.length?x[Math.min(x.length-1,Math.ceil(x.length*p)-1)]:0; }
const stage = { raw:{accepted:0,total:0}, canonicalTitle:{accepted:0,total:0}, canonical:{accepted:0,total:0}, full:{accepted:0,total:0} };
const byCategory={}; const misses=[]; const perRequest=[]; const timings={fts:[],canonical:[],identity:[],episode:[],total:[]};
for (const [title,mediaId,year,season,episode,category] of requests) {
  const context={canonicalTitle:title,alternateTitles:[],originalTitle:null,firstAirYear:year,externalIds:{imdb:mediaId},episodeTitles:[]};
  const positives=db.prepare(`SELECT DISTINCT ra.* FROM candidate_media cm JOIN release_attributes ra ON ra.info_hash=cm.info_hash AND ra.file_index_key=cm.file_index_key WHERE cm.media_id=?`).all(mediaId).filter(r=>isEpisodeCovered(attrs(r),season,episode));
  const tf=performance.now(); const rows=db.prepare(`SELECT DISTINCT ra.* FROM release_search rs JOIN release_attributes ra ON ra.rowid=rs.rowid WHERE release_search MATCH ? LIMIT 5000`).all(ftsMatch(title)); timings.fts.push(performance.now()-tf);
  const positiveKeys=new Set(positives.map(r=>`${r.info_hash}:${r.file_index_key}`));
  const retrievedPositives=positives.filter(r=>rows.some(x=>x.info_hash===r.info_hash&&x.file_index_key===r.file_index_key));
  const tc=performance.now(); const canonicalTitles=rows.filter(r=>canonicalTitleOnly(context,r)); timings.canonical.push(performance.now()-tc);
  const canonical=rows.filter(r=>canonicalAgree(context,r));
  const ti=performance.now(); const raw=rows.filter(r=>rawAgree(context,r)); timings.identity.push(performance.now()-ti);
  const te=performance.now(); const full=canonical.filter(r=>isEpisodeCovered(attrs(r),season,episode)); timings.episode.push(performance.now()-te); timings.total.push(timings.fts.at(-1)+timings.canonical.at(-1)+timings.identity.at(-1)+timings.episode.at(-1));
  for(const [name,set] of [['raw',raw],['canonicalTitle',canonicalTitles],['canonical',canonical],['full',full]]) { stage[name].total+=retrievedPositives.length; stage[name].accepted+=set.filter(r=>positiveKeys.has(`${r.info_hash}:${r.file_index_key}`)).length; }
  const depth=full.length; const bucket=depth===0?'0':depth<3?'1-2':depth<10?'3-9':'10+';
  byCategory[category] ??= {requests:0,positiveRows:0,retrievedPositiveRows:0,raw:0,canonicalTitle:0,canonical:0,full:0}; const c=byCategory[category]; c.requests++; c.positiveRows+=positives.length; c.retrievedPositiveRows+=retrievedPositives.length; c.raw+=raw.filter(r=>positiveKeys.has(`${r.info_hash}:${r.file_index_key}`)).length; c.canonical+=canonical.filter(r=>positiveKeys.has(`${r.info_hash}:${r.file_index_key}`)).length; c.full+=full.filter(r=>positiveKeys.has(`${r.info_hash}:${r.file_index_key}`)).length;
  perRequest.push({title,mediaId,season,episode,category,positiveRows:positives.length,retrievedPositiveRows:retrievedPositives.length,raw:raw.length,canonical:canonical.length,full:full.length,distinctReleases:new Set(full.map(r=>r.info_hash)).size,depthBucket:bucket});
  for(const r of positives.filter(r=>!canonicalAgree(context,r)).slice(0,10)) misses.push({title,season,episode,filename:r.filename,parserTitle:parsedReleaseTitle({filename:r.filename}).title,canonicalTitle:canonicalReleaseTitle({filename:r.filename}),expected:title,reason:agreeShowIdentity({...context,release:{filename:r.filename},year:r.year}).reason});
}
const negativeResults=[];
for(const [title,wrongTitles] of ambiguous) { const rows=db.prepare(`SELECT DISTINCT ra.* FROM release_search rs JOIN release_attributes ra ON ra.rowid=rs.rowid WHERE release_search MATCH ? LIMIT 5000`).all(ftsMatch(title)).slice(0,10); for(const r of rows) { const can=canonicalReleaseTitle({filename:r.filename}); const n=normalizeShowTitle(can); const requested=normalizeShowTitle(title); const wrong=wrongTitles.some(w=>n===normalizeShowTitle(w)||n.startsWith(`${normalizeShowTitle(w)} `)); const correct=n===requested||n.startsWith(`${requested} `); negativeResults.push({requested,title:r.filename,canonical:can,label:wrong?'wrong-show':correct?'correct-show':'uncertain',accepted:canonicalAgree({canonicalTitle:title,alternateTitles:[],firstAirYear:null},r)}); } }
const labels=Object.fromEntries(['correct-show','wrong-show','uncertain'].map(k=>[k,negativeResults.filter(x=>x.label===k)]));
console.log(JSON.stringify({status:'offline-read-only',requestCount:requests.length,positiveOracle:'candidate_media association AND episode-coverage eligibility for this exact request; unlabeled FTS rows excluded',stageRecovery:Object.fromEntries(Object.entries(stage).map(([k,v])=>[k,{...v,recovery:pct(v.accepted,v.total)}])),ftsRecall:{retrieved:perRequest.reduce((a,r)=>a+r.retrievedPositiveRows,0),positiveRows:perRequest.reduce((a,r)=>a+r.positiveRows,0),percent:pct(perRequest.reduce((a,r)=>a+r.retrievedPositiveRows,0),perRequest.reduce((a,r)=>a+r.positiveRows,0))},byCategory,perRequest,misses,manualNegativeSample:{rows:negativeResults.length,counts:Object.fromEntries(Object.entries(labels).map(([k,v])=>[k,v.length])),falseAccepts:negativeResults.filter(x=>x.label==='wrong-show'&&x.accepted)},candidateDepth:Object.fromEntries(['0','1-2','3-9','10+'].map(k=>[k,perRequest.filter(r=>r.depthBucket===k).length])),latencyMs:Object.fromEntries(Object.entries(timings).map(([k,v])=>[k,{p50:Number(percentile(v,.5).toFixed(3)),p95:Number(percentile(v,.95).toFixed(3))}])),},null,2)); db.close();

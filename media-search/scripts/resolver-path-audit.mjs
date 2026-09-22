#!/usr/bin/env node
/** Read-only audit of the previous 100-row ambiguous FTS sample. */
import { DatabaseSync } from 'node:sqlite';
import { parsedReleaseTitle } from '../src/lib/discovery/identity-agreement.js';
import { normalizeShowTitle, agreeShowIdentity } from '../src/lib/discovery/show-identity.js';
import { canonicalReleaseTitle } from '../src/lib/discovery/release-title.js';

const db = new DatabaseSync(process.env.DISCOVERY_DB || '/home/patrick/hashsucker-data/discovery/discovery-cache.db', { readOnly: true });
const tableNames = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
const hasTable = (name) => tableNames.has(name);
const ambiguous = [
  ['Friends',['Fast Friends','Fantastic Friends','Your Friends and Neighbors']],
  ['Lost',['Lost in Space','Lost Ollie']], ['House',['House of the Dragon','Full House']],
  ['Dark',['Dark Matter','Dark Winds']], ['From',['From Dusk Till Dawn','From Scratch']],
  ['You',['You Me and Her','You']], ['The Office US',['The Office UK','The Office Australia']],
  ['The Office UK',['The Office US','The Office Australia']], ['The Bear',['Bear Grylls','The Bear']],
  ['The Boys',['The Boy','The Boys Presents']],
];
function ftsMatch(title) { return normalizeShowTitle(title).split(' ').filter(Boolean).map(t => `"${t.replaceAll('"','""')}"`).join(' AND '); }
function parseJson(v) { try { return v ? JSON.parse(v) : null; } catch { return null; } }
function hasText(value, needles) { const s=JSON.stringify(value ?? '').toLowerCase(); return needles.some(n => s.includes(n)); }
const rows=[];
for (const [requested, wrongTitles] of ambiguous) {
  const results=db.prepare(`SELECT DISTINCT ra.* FROM release_search rs JOIN release_attributes ra ON ra.rowid=rs.rowid WHERE release_search MATCH ? LIMIT 5000`).all(ftsMatch(requested)).slice(0,10);
  for (const r of results) {
    const parsed=parsedReleaseTitle({filename:r.filename})?.title ?? null;
    const canonical=canonicalReleaseTitle({filename:r.filename});
    const n=normalizeShowTitle(canonical); const req=normalizeShowTitle(requested);
    const wrong=wrongTitles.some(w=>n===normalizeShowTitle(w)||n.startsWith(`${normalizeShowTitle(w)} `));
    const correct=n===req||n.startsWith(`${req} `);
    const cm=db.prepare('SELECT media_id,source,confidence,evidence,resolver_source,match_method,resolution_state FROM candidate_media WHERE info_hash=? AND file_index_key=?').all(r.info_hash,r.file_index_key);
    const ev=hasTable('evidence_observations') ? db.prepare('SELECT observer,source_class,state,media_id,provider,correlation_id,payload FROM evidence_observations WHERE info_hash=? AND file_index_key=?').all(r.info_hash,r.file_index_key) : [];
    const mrr=hasTable('media_request_results') ? db.prepare('SELECT request_id,intent_id,identity_tier,identity_confidence,expected_media_scope,parsed_candidate_scope,evidence_snapshot FROM media_request_results WHERE info_hash=? AND file_index_key=?').all(r.info_hash,r.file_index_key) : [];
    const poe=hasTable('provider_observation_events') ? db.prepare('SELECT provider,scope,subject_type,subject_key,state,source,evidence,correlation_id FROM provider_observation_events WHERE info_hash=? AND file_index_key=?').all(r.info_hash,r.file_index_key) : [];
    const sources=parseJson(db.prepare('SELECT sources,metadata FROM candidates WHERE info_hash=? AND file_index_key=?').get(r.info_hash,r.file_index_key)?.sources);
    let bucket='genuinely_insufficient_evidence';
    if (wrong || correct) bucket='benchmark_bug';
    else if (mrr.some(x=>x.expected_media_scope||x.parsed_candidate_scope||x.identity_tier)) bucket='existing_source_provenance_can_label';
    else if (cm.length) bucket='existing_candidate_media_can_label';
    else if (hasText({filename:r.filename,parsed,canonical}, ['s01','s02','s03','s04','s05','s06','s07','s08','s09','s10','complete','season','series','2160p','1080p','720p','web-dl','webrip','bluray','x265','h265','hevc','hdr','dv','ddp','dts','multi','english','french','german','italian','spanish'])) bucket='parser_determinable';
    else if (ev.length||poe.length||sources) bucket='existing_source_provenance_can_label';
    rows.push({requested,filename:r.filename,infoHash:r.info_hash,fileIndexKey:r.file_index_key,parserTitle:parsed,canonicalTitle:canonical,season:r.season,episode:r.episode,episodeRange:r.episode_range,mediaType:r.media_type,label:wrong?'wrong-show':correct?'correct-show':'uncertain',bucket,candidateMedia:cm,evidence:ev,requestResults:mrr,providerEvents:poe,sources});
  }
}
const uncertain=rows.filter(r=>r.label==='uncertain');
console.log(JSON.stringify({status:'offline-read-only',sampleSize:rows.length,uncertainCount:uncertain.length,bucketCounts:Object.fromEntries([...new Set(uncertain.map(r=>r.bucket))].map(k=>[k,uncertain.filter(r=>r.bucket===k).length])),durableEvidenceSummary:{candidateMedia:uncertain.filter(r=>r.candidateMedia.length).length,evidenceObservations:uncertain.filter(r=>r.evidence.length).length,mediaRequestResults:uncertain.filter(r=>r.requestResults.length).length,providerObservationEvents:uncertain.filter(r=>r.providerEvents.length).length},rows:uncertain},null,2)); db.close();

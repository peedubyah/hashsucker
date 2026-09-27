#!/usr/bin/env node
/**
 * Live same-TorrentFile range proof helper.
 * Requires DATA_PLANE_URL and a running data plane/control plane.
 * Fault injection uses DATA_PLANE_FORCE_FAIL_PROVIDER, never production config.
 */
import crypto from 'node:crypto';
const base=(process.env.DATA_PLANE_URL||'http://127.0.0.1:3001').replace(/\/$/,'');
const tf=process.env.TORRENT_FILE_ID||'tf_5de34a78-0a1a-410b-8de5-76ded2680e7d';
const size=34319716114;
const ranges=[0,1048576,17159858057,34318667518].map(start=>({start,end:Math.min(start+1048575,size-1)}));
const out=[];for(const r of ranges){const res=await fetch(`${base}/files/${encodeURIComponent(tf)}`,{headers:{Range:`bytes=${r.start}-${r.end}`}});const body=Buffer.from(await res.arrayBuffer());out.push({range:r,status:res.status,bytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex'),contentRange:res.headers.get('content-range')})}console.log(JSON.stringify({tf,size,ranges:out},null,2));

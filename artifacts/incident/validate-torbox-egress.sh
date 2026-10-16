#!/usr/bin/env bash
# TorBox egress validation matrix.
#
# Proves which egress is the discriminator for the `nexus.erth.tb-cdn.earth`
# SNI reset, and validates a fix by running the SAME matrix before/after the
# operator changes the gateway setting (or routes the host via pfSense).
#
# Usage:
#   validate-torbox-egress.sh before            # test the default egress (Arris)
#   validate-torbox-egress.sh after-pfsense     # test via pfSense (192.168.2.1)
#   validate-torbox-egress.sh after-default     # test the default egress again
#
# It never logs credentials or signed URLs. It adds at most two temporary /32
# host routes (pfSense mode) and removes them on exit. Requires sudo for
# tcpdump/routes.
set -u
MODE="${1:-before}"
CDN_IPS=(172.66.155.241 104.20.42.216)
GOOD_SNI="api.torbox.app"
BAD_SNI="nexus.erth.tb-cdn.earth"
TMP="/tmp/opencode"
mkdir -p "$TMP"
PF_GW=192.168.2.1
PF_DEV=ens19
PF_SRC=192.168.2.4
DEFAULT_DEV=ens18

cleanup() {
  for ip in "${CDN_IPS[@]}"; do sudo ip route del "$ip/32" 2>/dev/null; done
  sudo ip route del 8.8.8.8/32 2>/dev/null
}
trap cleanup EXIT

if [ "$MODE" = "after-pfsense" ]; then
  for ip in "${CDN_IPS[@]}"; do
    sudo ip route add "$ip/32" via "$PF_GW" dev "$PF_DEV" src "$PF_SRC" 2>/dev/null
  done
  DEV="$PF_DEV"; SRC="$PF_SRC"
else
  DEV="$DEFAULT_DEV"; SRC="$(ip -4 -o addr show dev $DEFAULT_DEV | awk '{print $4}' | cut -d/ -f1)"
fi
echo "== mode=$MODE iface=$DEV src=$SRC $(date -u +%FT%TZ)"

tls() { # $1=ip $2=sni
  timeout 5 bash -c "echo | openssl s_client -connect $1:443 -servername $2 2>&1" \
    | grep -E 'errno=104|no peer certificate|subject=CN' | head -1
}

echo "--- A: $BAD_SNI -> CDN (expect ECONNRESET on the bad egress, subject=CN=tb-cdn.earth when fixed)"
tls "${CDN_IPS[0]}" "$BAD_SNI"
echo "--- B: $GOOD_SNI -> CDN (control, expect subject=CN=torbox.app)"
tls "${CDN_IPS[0]}" "$GOOD_SNI"

echo "--- C: real TorBox requestdl -> bounded Range"
docker exec hashsucker-media-search-1 node -e '
const key=process.env.TORBOX_API_KEY;
const base=process.env.TORBOX_API_URL||"https://api.torbox.app/v1/api";
(async()=>{
  try{
    const j=await (await fetch(base+"/torrents/requestdl?token="+encodeURIComponent(key)+"&torrent_id=120289342&file_id=0")).json();
    const r=await fetch(j.data,{headers:{range:"bytes=0-65535"}});
    const b=Buffer.from(await r.arrayBuffer());
    console.log("Range status",r.status,"bytes",b.length);
  }catch(e){console.log("ERR",e.cause&&e.cause.code||e.message);}
})();' 2>&1 | tail -1

echo "--- D: Rust data-plane byte read (TorBox-only TorrentFile)"
docker exec hashsucker-media-search-1 node -e '
const http=require("http");
const req=http.request({host:"data-plane",port:3001,path:"/files/tf_533e1e85-6612-4e2a-8f0f-18281cc4f1cc",headers:{range:"bytes=0-65535"}},res=>{
  let n=0;res.on("data",c=>n+=c.length);res.on("end",()=>console.log("data-plane status",res.statusCode,"bytes",n));
});
req.on("error",e=>console.log("data-plane ERR",e.message));req.setTimeout(15000,()=>{console.log("data-plane TIMEOUT");req.destroy();});req.end();' 2>&1 | tail -1
echo "== done $(date -u +%FT%TZ)"

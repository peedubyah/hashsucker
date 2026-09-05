#!/usr/bin/env python3
"""P13 S-1 control-plane state check for the frozen tfId."""
import json
import sys
import urllib.request

TFID = 'tf_5de34a78-0a1a-410b-8de5-76ded2680e7d'
URL = 'http://127.0.0.1:3300/api/data-plane/files/' + TFID

try:
    raw = urllib.request.urlopen(URL, timeout=8).read().decode()
except Exception as e:
    print(f"ERR fetching {URL}: {e}")
    sys.exit(1)

try:
    j = json.loads(raw)
except Exception as e:
    print(f"ERR parsing: {e}")
    print("RAW:", raw[:500])
    sys.exit(1)

print(f"schemaVersion: {j.get('schemaVersion')}")
tf = j.get('torrentFile', {})
print(f"torrentFile.id: {tf.get('id')}")
print(f"torrentFile.size: {tf.get('size')}")
print(f"torrentFile.infoHash: {tf.get('infoHash')}")
print(f"torrentFile.canonicalInternalPath: {tf.get('canonicalInternalPath')}")
print(f"providers ({len(j.get('providers',[]))} total):")
for p in j.get('providers', []):
    print(
        f"  - provider={p.get('provider')} state={p.get('state')} "
        f"account={p.get('accountScope')} "
        f"resource={p.get('providerResourceId')} "
        f"fileId={p.get('providerFileId')} "
        f"size={p.get('size')}"
    )

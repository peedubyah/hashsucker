#!/bin/bash
for p in 3009 3011 3013; do
  echo "=== port $p ==="
  curl -sS "http://127.0.0.1:$p/metrics" | python -c "import json,sys; d=json.load(sys.stdin); print('chunks_present',d['cache']['chunks_present'],'current_bytes',d['cache']['current_bytes'])"
done

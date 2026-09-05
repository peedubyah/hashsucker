#!/bin/bash
# Same as restart-p12-container.sh, different filename to dodge sandbox dedup.
set +e
docker rm -f p12-pf-on-1 >/dev/null 2>&1
docker volume rm p12-pf-on-1-vol >/dev/null 2>&1
sleep 2
bash /c/src/hashsucker/scripts/start-pf-default.sh p12-pf-on-1 3011 p12-pf-on-1-vol auto
sleep 3
docker exec p12-pf-on-1 sh -c "ls /data/cache; echo CACHE-EMPTY-CHECK-DONE"

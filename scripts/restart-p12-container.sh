#!/bin/bash
# Restart the P12 default-ON container on a fresh volume. Hard-coded names.
set +e
docker rm -f p12-pf-on-1 >/dev/null 2>&1
docker volume rm p12-pf-on-1-vol >/dev/null 2>&1
sleep 2
bash /c/src/hashsucker/scripts/start-pf-default.sh p12-pf-on-1 3011 p12-pf-on-1-vol auto
sleep 3
docker exec p12-pf-on-1 sh -c "ls /data/cache; echo DONE-LIST"

#!/bin/bash
set -e

rsync -av --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='data/' \
  ./ \
  root@192.168.1.5:/mnt/database/appdata/media-search-dev/

ssh root@192.168.1.5 \
  'cd /mnt/database/appdata/media-search-dev && docker compose up -d --build'
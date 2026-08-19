#!/bin/bash
set -euo pipefail

if [[ -z "${DEPLOY_TARGET:-}" ]]; then
  echo "Set DEPLOY_TARGET, for example root@unraid:/mnt/user/appdata/media-search-project" >&2
  exit 1
fi

rsync -av \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='data/' \
  --exclude='.env' \
  --exclude='.env.local' \
  ./ \
  "${DEPLOY_TARGET}/"

echo "Copied project. On Unraid, create .env from .env.example and run: docker compose up -d --build"

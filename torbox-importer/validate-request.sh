#!/usr/bin/env bash
set -euo pipefail

file="${1:-}"

if [[ -z "$file" || ! -f "$file" ]]; then
  echo "usage: $0 request.json" >&2
  exit 2
fi

jq -e '
  .version == 1
  and (.requestId | type == "string" and length > 0)
  and (.provider == "torbox" or .provider == "realdebrid" or .provider == "auto")
  and (.intent.mediaType == "movie" or .intent.mediaType == "tv")
  and (.intent.scope == "movie" or .intent.scope == "episode" or .intent.scope == "season" or .intent.scope == "series")
  and (.intent.mediaId | type == "string" and length > 0)
  and (.release.infoHash | type == "string" and test("^[0-9a-fA-F]{40}$"))
' "$file" >/dev/null || {
  echo "INVALID REQUEST" >&2
  exit 1
}

echo "VALID REQUEST"
jq -r '
  "request:  \(.requestId)",
  "provider: \(.provider)",
  "media:    \(.intent.mediaType)",
  "scope:    \(.intent.scope)",
  "mediaId:  \(.intent.mediaId)",
  "season:   \(.intent.season // "-")",
  "episodes: \((.intent.episodes // []) | map(tostring) | join(","))",
  "hash:     \(.release.infoHash)"
' "$file"

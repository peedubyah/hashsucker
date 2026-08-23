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
  and ((.handlingMode // "download") | . == "download" or . == "stream")
  and (.intent.mediaType == "movie" or .intent.mediaType == "tv")
  and (.intent.scope == "movie" or .intent.scope == "episode" or .intent.scope == "season" or .intent.scope == "series")
  and (.intent.mediaId | type == "string" and length > 0)
  and (.release.infoHash | type == "string" and test("^[0-9a-fA-F]{40}$"))
  and (
    ((.release | has("fileIndex") | not) and (.release | has("releaseKey") | not))
    or (
      (.release | has("fileIndex"))
      and (.release | has("releaseKey"))
      and (
        .release.fileIndex == null
        or (
          (.release.fileIndex | type) == "number"
          and .release.fileIndex >= 0
          and .release.fileIndex <= 9007199254740991
          and (.release.fileIndex | floor) == .release.fileIndex
        )
      )
      and (.release.releaseKey | type == "string")
      and .release.releaseKey == (
        (.release.infoHash | ascii_downcase)
        + ":"
        + (if .release.fileIndex == null then "torrent" else (.release.fileIndex | tostring) end)
      )
    )
  )
' "$file" >/dev/null || {
  echo "INVALID REQUEST" >&2
  exit 1
}

echo "VALID REQUEST"
jq -r '
  "request:    \(.requestId)",
  "provider:   \(.provider)",
  "handling:   \(.handlingMode // "download")",
  "media:      \(.intent.mediaType)",
  "scope:      \(.intent.scope)",
  "mediaId:    \(.intent.mediaId)",
  "season:     \(.intent.season // "-")",
  "episodes:   \((.intent.episodes // []) | map(tostring) | join(","))",
  "hash:       \(.release.infoHash | ascii_downcase)",
  "fileIndex:  \(if (.release | has("fileIndex")) then (.release.fileIndex // "-") else "-" end)",
  "releaseKey: \(if (.release | has("releaseKey")) then .release.releaseKey else ((.release.infoHash | ascii_downcase) + ":torrent") end)"
' "$file"

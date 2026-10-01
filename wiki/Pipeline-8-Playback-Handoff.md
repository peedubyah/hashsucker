# Stage 8 — Playback Handoff

The handoff is the exact, minimal authority that crosses from
Node's control plane into byte serving. It carries identity, never bytes.

## Shape (`lib/discovery/playback-handoff.js:buildPlaybackHandoff`)

Requires `request.requestId`, `sel.infoHash`, `sel.filename`. Emits:

```js
{ requestId, mediaId, mediaType, season, episode,
  releaseKey: "<infoHash>:<fileIndex ?? 'torrent'>",
  infoHash, fileIndex, filename,
  provider: "torbox" | "realdebrid" | "unknown",
  providerState,           // point-in-time only, never authority
  identityTier, resolutionState,
  canonicalTitle?, canonicalYear?,
  torrentFileId? }         // null = legacy/unbound; VFS refuses new pubs
```

Persisted to `playback_handoffs` (with `torrent_file_id` migration
column, app-validated into control-plane — no FK).

## Authority rules

- `torrentFileId` comes from `ensureTorBoxFileIdentity` (placement +
  provider-file + size) or the RD seam. All read paths re-derive from
  the durable TorrentFile; handoff bytes are never trusted.
- WebDAV reads proxy `data-plane /files/:tfId` verbatim
  (`vfs/data-plane-forward.js`, headers passed through).
- `/media/:hash/:idx` resolves projection → active binding → exposure →
  readiness (`servable` ⇔ binding active + exposure visible + mount
  configured + relative path), then builds the media source and stream.
- `stream-resolver/index.js` is a STUB (`not_implemented`); the live
  `/stream` route does not use it except a fallback 501.

## What Node passes to Rust

Path `tfId` + client `Range` + optional `x-read-priority`. TorrentFile
authority arrives as the S-1 control body (`torrentFile{id, infoHash,
canonicalInternalPath, size}`, `providers[]` with per-coord
`provider/accountScope/providerResourceId/providerFileId/state/size`,
optional `local`, `schemaVersion: 1`). See Contracts-Provider-Execution.

## Source references

- `media-search/src/lib/discovery/playback-handoff.js`,
  `media-search/src/lib/vfs/data-plane-forward.js`,
  `media-search/src/lib/resolver/resolver.js` (`resolveProjection`,
  `findActiveBinding`, `findExposure`, `evaluateReadiness`),
  `source.js`, `transport.js`

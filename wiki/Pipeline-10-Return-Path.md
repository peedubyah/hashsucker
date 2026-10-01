# Stage 10 — Return Path to Consumer

Bytes flow back through the same authority chain, in reverse. No layer
reinterprets identity on the way out.

## Byte flow

Rust 206 (`Content-Range`, `Content-Length`, `Accept-Ranges`, plus
`x-hashsucker-serving-{provider,resource-id,file-id,cap-id}` iff a
provider was used; cache hits carry no serving headers) → Node
verbatim proxy → edge (Caddy `:8080`, transparent streaming hop: forwards
`Range`/`If-Range` unchanged, sets no content headers, never buffers
media) → client/PMS.

Legacy `/stream` resolver returns 307 redirects instead; media bytes
bypass Caddy in that path.

## Player experience

- Seeks are Range requests against the same TorrentFile; the grid +
  coalescing make repeat ranges cheap; single-byte probes bypass cache.
- Near-EOF: exact size is authoritative — short reads past `size` are
  416, never silent truncation.
- Disconnect/linger: consumer-gone backfill is suppressed and partial
  chunks discarded; no zombie fills.
- PMS/client buffering is the client's business; HashSucker reports
  `Accept-Ranges` honestly and never advertises what it can't serve.

## Successful playback (acceptance, not vibes)

Per `src/PRODUCTION-PLAYBACK-TESTING.md`: Plex-client-mediated playback
(real HTPC on isolated display/audio), independent PMS session
observation, HashSucker read attribution. Metadata visibility (rating
keys, `MediaPart`, bare 206s, 2xx control responses) is explicitly NOT
proof. Screenshots diagnose; bytes accept.

## Source references

- `data-plane/src/serve.rs`, `media-search/src/lib/vfs/data-plane-forward.js`,
  `edge/Caddyfile`, `src/PRODUCTION-PLAYBACK-TESTING.md`

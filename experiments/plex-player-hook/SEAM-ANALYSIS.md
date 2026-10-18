# Seam F (HTTP URL interception) — architecture review before prototype

## Exact current Direct Play request anatomy (from Plex HTPC 1.71.1.346 log)
- mpv `loadfile` receives a full PMS URL:
  `https://127-0-0-1.<plex.direct>:32400/library/parts/<partId>/<version>/file.mkv?X-Plex-Token=...&...&X-Plex-Playback-Session-Id=...&X-Plex-Playback-Id=...`
- PMS part key: `/library/parts/1066/1790863310/file.mkv`
- Auth: `X-Plex-Token` query param (not header).
- Required params: X-Plex-Product/Platform/Platform-Version/Model/Device/Device-Name/Device-Vendor/Device-Screen-Resolution/Drm/Version/Client-Identifier/Language/Features/Session-Id/Accept/Accept-Language/Playback-Session-Id/Playback-Id.
- mpv options: `stream-lavf-o=resolve_hosts=[host:127.0.0.1]` (DNS pin).
- Transport: HTTPS to localhost PMS (self-signed cert, plex.direct DNS → 127.0.0.1).
- mpv opens via ffmpeg (libavformat), Range requests internally.
- PMS serves the file directly from `/mnt/hashsucker-vfs/...` (VFS path in Part metadata).

## Exact interception boundary for Seam F
There is NO external seam that receives this request before mpv opens it:
- mpv resolves DNS itself (plex.direct → 127.0.0.1 via resolve_hosts override).
- mpv uses libavformat/ffmpeg HTTP, not Qt networking.
- System proxy (`http_proxy`) is NOT honored by mpv's ffmpeg HTTP (verified: mpv docs; `--http-proxy` exists but Plex does not set it and we cannot inject without native hook).
- Therefore Seam F as "HTTP URL interception" WITHOUT native hooking is **NOT implementable**: the request never touches a configurable proxy, Qt network, or DNS we control without touching Plex's process.

The only places the URL is mutable are:
  (1) JS web-client before `loadfile` (webpack hook) — fragile.
  (2) native `mpv_command("loadfile", url, ...)` — requires LD_PRELOAD/native hook.
  (3) post-hoc: replace the URL string in the `user-data/plex/playing-media` property — too late; bytes already open.

Conclusion: Seam F's "no native hook" assumption is FALSE. The actual media HTTP request is made by libmpv/ffmpeg directly and cannot be externally intercepted. Seam F secretly requires either a JS webpack hook (A) or a native hook (C/D).

## Revised seam matrix (evidence-based)
| Seam | Coupling | Semantics preserved | Complexity | Verdict |
|---|---|---|---|---|
| A JS/web-client source substitution | HIGH (webpack) | yes | medium | viable but upgrade-fragile |
| C native mpv_command hook (LD_PRELOAD) | MEDIUM | yes | high | viable IF symbols resolve; requires proof |
| D libmpv API interception | MEDIUM | yes | high | same as C |
| F HTTP URL interception (external) | N/A | n/a | n/a | **NOT IMPLEMENTABLE without A or C** |
| E custom mpv protocol | LOW | yes | medium | needs mpv build proof |
| G CDP-only | LOW | yes | low | proof-only |

## Part/ratingKey→TF mapping
- PMS Part id (1066) + file path `/mnt/hashsucker-vfs/TV/tt31510819/Season 02/...mkv` gives the infoHash and S/E directly from the VFS path.
- HashSucker can resolve via existing `queryCandidatesByMedia`/Binding by mediaId+season+episode, OR by exact VFS path → Binding. Mapping is deterministic for modern TF-backed items. Multi-edition: PMS selects one Part; the URL carries `partId` + `version`; HashSucker must resolve by (mediaId, season, episode, part key), not by filename alone, to avoid serving the wrong edition.

## Range behavior
- mpv uses ffmpeg HTTP with internal Range requests (open-ended + bounded), cancellation, retries. `/bytes/:tfId` already serves these (proven by VFS canary: 206 + seeks + cache hits). HTTP-semantically compatible.

## Headers/auth
- `X-Plex-Token` must NOT be forwarded to HashSucker (it's PMS auth). HashSucker `/bytes/:tfId` uses its own auth (or none on localhost). The interceptor must strip all `X-Plex-*` params and cookies before forwarding. mpv sends them only because Plex supplied them in the URL.

## Subtitles
- Embedded subtitles: purely inside the same file after mpv opens bytes → survive substitution (same bytes).
- External SRT: PMS supplies a separate subtitle URL (`/library/streams/...` or external); substitution of the media URL does not touch it. But if the external subtitle URL is relative to the media base URL, substitution could break it — needs proof. Embedded-only items are safe.

## Audio tracks
- Track selection is purely inside the file after open (stream indices). Same bytes ⇒ same tracks. `selectedAudioStream`/`selectedVideoStream` in playing-media are display metadata, not source params. Proven by canary (audio track change works on substituted... no, on VFS bytes — same bytes).

## Direct Play / Direct Stream / Transcode discriminator
- Direct Play: `decision` has no transcode session; URL is `/library/parts/.../file.mkv` with original container.
- Direct Stream: URL is `/video/:/transcode/universal/...` or `/library/parts/...` with `?directPlay=0` + transcode params.
- Transcode: URL contains `/transcode/universal/` or `/video/:/transcode/`.
- Discriminator must be URL-path based (`/library/parts/` = Direct Play candidate; `/transcode/` = refuse). Fail closed to normal Plex for anything else.

## Pre-open vs post-open failure
- Pre-open (HashSucker resolve fails before mpv loadfile): use original Plex URL. Clean.
- Post-open (HashSucker byte failure mid-playback): cannot transparently fall back without PMS session discontinuity. Policy: keep mpv on the HashSucker URL, surface a clean error, let Plex's normal retry/reload handle it; do NOT silently reload the original URL mid-playback (would reset position and confuse PMS).

## Progress/watch-state mechanism
- PMS progress is driven by the web client's `viewOffset` updates via `/timeline` calls (not by source URL activity or server-side byte consumption). The log shows `viewOffset` advancing and `lastViewedAt` updates independent of byte source. Therefore source substitution does not affect progress as long as the player keeps emitting time-pos events — which mpv does regardless of URL.

## Remote control
- Remote commands flow: remote → PMS → web client controller → mpv (pause/play/seek/stop). Independent of source URL. Strong evidence for seam viability.

## Next-episode lifecycle
- Next episode = new playQueue item + fresh source decision + new playSessionID (or same session with new media). Each open is independently interceptable. Stateless per-open interception is correct.

## Can media HTTP be intercepted WITHOUT native hooking?
NO. As established, mpv uses libavformat/ffmpeg directly; it does not honor system proxy for this request class, and Qt networking is not in the path. Seam F requires either (A) JS webpack hook or (C/D) native hook. The "no native hook" assumption is false.

## Revised seam matrix (evidence-based)
| Seam | Coupling | Semantics preserved | Complexity | Upgrade fragility | Verdict |
|---|---|---|---|---|---|
| A JS/web-client source substitution | HIGH | yes | medium | HIGH (webpack churn) | viable but fragile |
| C native mpv_command hook (LD_PRELOAD) | MEDIUM | yes | high | MEDIUM | viable IF symbols resolve |
| D libmpv API interception | MEDIUM | yes | high | MEDIUM | same as C |
| F HTTP URL interception (external) | N/A | n/a | n/a | n/a | **NOT IMPLEMENTABLE without A or C** |
| E custom mpv protocol | LOW | yes | medium | LOW | needs mpv build proof |
| G CDP-only | LOW | yes | low | LOW | proof-only |

## CURRENT VFS→Rust path vs moonshot value
CURRENT (already working, production):
  Plex → VFS (rclone) → Node /vfs → Rust /files/:tfId → bytes
  - HashSucker ALREADY owns bytes for modern Plex playback.
  - Measured: play start ~sub-second, 206 ranges, seeks, cache hits, PMS progress advances, watch state persists.

PROPOSED (Seam C/E):
  Plex → (hook) → HashSucker /bytes/:tfId → Rust /files/:tfId → bytes
  - Removes rclone/VFS/filesystem indirection.
  - Gains: exact player-session→TF identity at open time; direct byte telemetry; no filesystem projection; future non-Plex player execution.
  - Does NOT gain: byte authority (already have it), seek behavior (already works), PMS progress (already independent), watch state (already persists).

## What the moonshot buys that we do not already have
1. Remove rclone/VFS/filesystem indirection (latency + scanner surface).
2. Exact player-session→TF identity at open (today VFS path is derived, not session-bound).
3. Direct control of playback failure/recovery at the player (today PMS retries opaque).
4. Future non-Plex player execution (mpv/other) without VFS.

## Right-to-exist test
If Seam F requires native hooking (it does) and the gain is "remove rclone + exact session identity," the moonshot is worth a **small, isolated native-hook prototype** but only if:
  - symbols resolve dynamically (LD_PRELOAD feasibility proven), and
  - the gain is measured, not assumed.

If symbols are static/internal, the moonshot is **NOT WORTH BUILDING** beyond the existing VFS path.

## Revised verdict
`PROTOTYPE ANOTHER SEAM` — specifically Seam C (native mpv_command hook via LD_PRELOAD) or Seam E (custom mpv protocol), whichever proves cheaper, with Seam F demoted to "not implementable externally." The next slice must first prove symbol resolution (`mpv_command`/`mpv_command_async`/`mpv_create` resolvability in the embedded libmpv) before any hook code is written. If symbols are not dynamically resolvable, verdict becomes `MOONSHOT HAS NO RIGHT TO EXIST` beyond the existing VFS path.

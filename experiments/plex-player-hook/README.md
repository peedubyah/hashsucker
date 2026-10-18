# Plex HTPC local playback executor — RECONNAISSANCE ONLY

Status: NOT IMPLEMENTED. This directory contains reconnaissance notes and
a version-gated compatibility probe. Nothing here is wired into
production. No production code is changed.

Supported target (pinned):
- Plex HTPC 1.71.1.346-f62ce923, Qt 6, QtWebEngine/Chromium, libmpv 0.38.0,
  embedded libPlexMediaServer.so.

## Findings (2026-10-18)

### Proven seam (already established, do not rediscover)
- Plex loads user-data `mpv.conf`. Adding
  `input-ipc-server=/tmp/hs-mpv-ipc.sock` exposes native libmpv JSON IPC.
- Confirmed: read `time-pos`, pause/play, seek, path, duration, player state.
- Raw mpv `loadfile` does NOT establish PMS playback-session semantics.
- Raw mpv `stop` unloads bytes while leaving PMS session state behind.
- CDP available via `QTWEBENGINE_REMOTE_DEBUGGING`.

### Play call chain (reconstructed, high level)
1. User Play → web-client player action.
2. PMS playQueue/session request (playSessionID, ratingKey, Media/Part).
3. Source URL construction from Part (Direct Play by default on local HTPC).
4. Qt/native boundary → embedded libmpv `loadfile`/`mpv_command_async`.
5. libmpv network open → bytes.

### Invariants
- Plex must own: ratingKey, playQueue, playSessionID, Media/Part identity,
  viewOffset, timeline/progress events, pause/play, seek, watched state,
  stop, next-episode, subtitles, audio selection, remote control,
  transcode/direct-play mode.
- HashSucker may mirror: Binding/TF resolution, byte URL, progress telemetry.
- HashSucker may replace (candidate): final source URL only, Direct Play
  only, local HTPC only.

### Candidate seams (scored)
A. JS/web-client source substitution — coupling HIGH (webpack churn), semantics preserved, complexity medium, rollback easy. Upgrade-fragile.
B. QtWebChannel seam — coupling medium, semantics preserved, complexity high, rollback medium.
C. native Qt/libmpv wrapper before mpv_command/loadfile — coupling medium, semantics preserved, complexity high, brittle.
D. libmpv API interception via LD_PRELOAD — coupling low IF symbols resolve dynamically; upgrade-fragile; complex; rollback one env var. REJECTED for now: requires symbol resolution proof; risk of wedging.
E. mpv custom protocol (hashsucker://tf/<id>) — coupling low, semantics preserved, complexity medium, rollback easy. FEASIBLE IN PRINCIPLE but requires mpv build support proof.
F. HTTP URL interception (Plex opens Part; local executor maps to /bytes/:tfId) — coupling low, semantics preserved, complexity low, rollback trivial. RECOMMENDED first seam.
G. CDP-only prototype — coupling low, semantics preserved, complexity low, rollback trivial. Acceptable for proof, not final.

### Recommendation
Seam F (HTTP URL interception) for Direct Play only, scoped to local HTPC.
Plex believes it opens its selected Part; the local executor resolves the
same media through HashSucker Binding→TF→/bytes/:tfId→Rust. Plex semantics
stay native. No native hooking. No PMS DB mutation. Fail closed: if
HashSucker cannot resolve, Plex proceeds with its own URL (do not wedge).

### Explicit scope limits
- Local Plex HTPC playback only. No Chromecast, no remote clients, no PMS
  transcoding replacement.
- Direct Play only initially; Direct Stream/transcode stay PMS-native.
- No global interception; opt-in via env/launcher wrapper.

### Enable/disable (planned, not implemented)
- Enable: set HS_PLEX_EXECUTOR=1 and HS_PLEX_MEDIA_SEARCH_URL, launch Plex
  HTPC with wrapper that injects the local resolver config. (Prototype
  only; no shipping launcher yet.)
- Disable: unset HS_PLEX_EXECUTOR; Plex runs stock.

### Compatibility gate (required before any hook)
- Verify Plex HTPC version == 1.71.1.346-f62ce923.
- Verify expected player module/symbol signature.
- If unsupported: do nothing; Plex launches normally.

### Right-to-exist assessment
Marginal-to-moderate value: absolute TF authority at final open, deterministic
seek/byte telemetry, no PMS/provider source divergence. Cost: tight coupling
to Plex's player internals if using seams A/C/D. Seam F avoids that coupling
and is worth a small prototype. Seams A/C/D are NOT worth building unless
F fails. Verdict: VIABLE WITH LIMITATIONS.

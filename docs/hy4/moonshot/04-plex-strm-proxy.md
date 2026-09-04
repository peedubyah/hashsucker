# `StromKuo/plex-strm-proxy` — Plex control-plane interception

**Repo:** `research/moonshot-refs/plex-strm-proxy` · **Language:** Go 1.23, **zero external
dependencies** · **Shape:** HTTP reverse proxy in front of Plex Media Server on :3001, registered
via *Settings → Network → Custom server access URLs*.

~6,900 lines non-test Go, ~4,400 lines tests. Single commit (`d611360`) — one coherent design, no
history to mine.

**Why it matters here:** this is the only reference that treats **Plex as a control plane you can
intercept**, and it directly answers deliverable question E5 (*"is an optional Plex-native fast path
feasible without replacing the neutral VFS?"*). It also contains the sharpest statement in the
corpus of the **cold-probe budget** problem.

---

## 1. Architecture — the interception surface is only four routes

`internal/app/server.go:184-208`:

```go
	switch {
	case isDecisionRequest(request):
		s.handleDecision(tracked, request)
	case isTranscodeStartRequest(request):
		s.handleTranscodeStart(tracked, request)
	case isHLSResourceRequest(request.URL.Path):
		s.handleTranscodeResource(tracked, request)
	case isPartFileRequest(request.URL.Path):
		s.handlePartFile(tracked, request)
	default:
		s.proxyToPlex(tracked, request, "")
	}
```

| # | Path | Predicate cite |
|---|---|---|
| 1 | `/video/:/transcode/universal/decision` | `server.go:1432-1434` |
| 2 | `/video/:/transcode/universal/start[.m3u8\|.mpd\|/…]` | `server.go:1436-1442` |
| 3 | `/video/:/transcode/universal/session/<id>/<rel>` | `hls_transcode.go:24`, `:1072` |
| 4 | `/library/parts/<id>/file[.ext]`, `/library/parts/<id>/<ver>/file[.ext]` | `server.go:1500-1523` |

Plus a **response-side** rewrite: `modifyPlexResponse` (`server.go:928`) is installed as
`ReverseProxy.ModifyResponse` and rewrites bodies under `MaxPlexBodyBytes` (4 MiB) for
`isMetadataResponseRequest` (`server.go:1107-1122`):

```go
	// Plex Web frequently starts playback from the metadata embedded in a Hub
	// response (for example, Continue Watching) instead of fetching the full
	// metadata endpoint again. Rewrite those responses too, otherwise the STRM
	// Part has no container and Plex Web falls back to DASH transcoding.
	return strings.HasPrefix(request.URL.Path, "/hubs/") ||
		strings.HasPrefix(request.URL.Path, "/library/sections/") ||
		strings.HasPrefix(request.URL.Path, "/playQueues")
```

### What it is NOT

- **Not** a Plex agent / scanner / metadata plugin. No plugin bundle, no `Scanners/`.
- **Not** a filesystem shim. It reads `.strm` files read-only to extract a URL string.
- **Not** a library writer. `AGENTS.md:11` — *"Do not modify the Plex database."*

### Two-address topology (non-obvious and important)

`server.go:476-491` — three URL builders for three audiences:

| Builder | Audience |
|---|---|
| `publicProxyURL` (`server.go:449`) | client-facing Part keys (from `request.Host` / `X-Forwarded-Proto`) |
| `plexCallbackProxyURL` (`server.go:481`) | Plex→proxy metadata fetches (`PLEX_CALLBACK_URL`) |
| `localProxyURL` / `localPartProxyURL` (`server.go:466`, `:539`) | in-process ffprobe/ffmpeg (`127.0.0.1:<port>`) |

Plex may be in another container/namespace while ffprobe needs an address reachable from *this*
process. `AGENTS.md:69-70` warns `PLEX_CALLBACK_URL` must be validated with a real request in bridge
networking.

## 2. The core trick — "native STRM coordination"

`AGENTS.md:41-44` — the public README *deliberately* omits this.

**Problem:** Plex cannot probe a `.strm` file (a ~40-byte text file containing a URL). Its decision
engine has zero codec/duration/stream data, and its transcoder cannot open the file.

**Solution:** synthesize a *proxy-local metadata document* and hand Plex a URL to it, so Plex runs
its **own native** decision logic against **real** probed stream data, with a **Part key that Plex
can actually HTTP-GET**.

`server.go:239-258`:

```go
		// Let Plex evaluate the same directPlay/directStream/profile query it
		// received from the client. The only substitution is the media path:
		// Plex fetches a proxy-local metadata document whose Part points to the
		// protected local Part adapter. This gives Plex real stream metadata
		// without exposing the third-party URL or Plex credentials to it.
		query := request.URL.Query()
		query.Set("path", s.localMetadataProxyURL(metadataPath, mapping.PartID))
		decisionURL := *request.URL
		decisionURL.RawQuery = query.Encode()
		decisionRequest := request.Clone(context.WithValue(request.Context(), nativeSTRMKey, true))
		decisionRequest.URL = &decisionURL
```

And `fileFor` (`server.go:1179-1191`) returns the **protected Part URL** instead of the third-party
URL, because (per `AGENTS.md:15`) Plex appends `X-Plex-Token` to any URL it fetches.

**Key invariant** (`AGENTS.md:55-61`):

> Only a native Direct Play result may have the selected Part file rewritten to the validated source
> URL and remembered for the current playback session and Part. A selected Part/Stream transcode
> decision must remain Plex-owned and must not populate the direct cache. Later requests that
> explicitly set both `directPlay=0` and `directStream=0` must always be passed back to Plex, even if
> an earlier request in the same session was Direct Play.

**Transferable? Yes — highest-value mechanic in the repo.** Any design where bytes live behind a
lazily-materialized URL has exactly this problem: Plex's decision engine needs *stream metadata*,
and Plex's transcoder needs *a URL it can read*.

**Fragile:** it depends entirely on Plex resolving `?path=` as a fetchable URL. It doubles round
trips (client → proxy → Plex → proxy(metadata) → Plex → proxy → client). The `plexTranscode=1`
marker distinguishing the proxy's own fetch from a client's is a plain query param — advisory, not a
security boundary.

## 3. Decision classification — transcode-dominant, stream-overrides-part

`playback_policy.go:404-435`:

```go
func choosePlexDecision(observations plexDecisionObservations) PlexPlaybackDecision {
	selectedPart := choosePlexDecisionObservations(observations.parts, true)
	selectedStream := choosePlexDecisionObservations(observations.streams, true)
	// Plex can leave Part.decision as directplay while marking the selected
	// video or audio Stream as transcode. The selected stream decision is the
	// authoritative signal for that request and must prevent a stale direct
	// redirect from being remembered.
	if selectedStream == PlexDecisionTranscode || selectedPart == PlexDecisionTranscode {
		return PlexDecisionTranscode
	}
	...
}
```

Codes: `1000`=DirectPlay, `2000`=DirectStream, `3000`=Transcode (`playback_policy.go:384-395`).
`choosePlexDecisionObservations` (`:437-467`) is transcode-dominant: `hasTranscode` beats
`hasDirectStream` beats `hasDirectPlay`.

**This is validated against 5 captured real Plex decision responses** in
`internal/app/testdata/plex-native/`. The fixture README (translated) states:

> 判断依据是选中的 Part 和 Stream 的决策字段；设备型号、媒体标题和 User-Agent 不参与判断。
> (*The judgment is based on the decision fields of the selected Part and Stream; device model,
> media title, and User-Agent do not participate.*)

The dangerous case is documented explicitly (`strm-hevc-native-stream-transcode.xml`): *"Part may
still be `directplay`, but the selected video/audio streams are both `transcode` → treat as Plex
transcode, must not rewrite to 302, must not enter the direct cache."*

**Port this pure function wholesale.** It is testable without a server and encodes a real Plex
behavior you will otherwise rediscover the hard way.

## 4. Redirect vs proxy — the answer is: pure configuration

**This is the most surprising finding in the repo.** `server.go:758-772` — the *entire* rule:

```go
func (s *Server) serveResolvedMedia(writer http.ResponseWriter, request *http.Request, mapping PartMapping) {
	if s.cfg.PlaybackMode == "proxy" || s.cfg.ProxyFallback {
		target, err := url.Parse(mapping.ResolvedURL)
		if err != nil {
			writeJSONError(writer, http.StatusBadGateway, "STRM URL is invalid")
			return
		}
		s.proxyMedia(writer, request, target)
		return
	}
	writer.Header().Set("Location", mapping.ResolvedURL)
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("X-Plex-Strm-Proxy", "redirect")
	writer.WriteHeader(s.cfg.RedirectStatus)
}
```

**The complete byte-delivery rule:**

| Condition | Behavior | Cite |
|---|---|---|
| `plexTranscode=1` present (proxy issued this URL to Plex itself) | **Always proxy bytes**, ignores config | `server.go:748-751` |
| `PLAYBACK_MODE=proxy` or `PROXY_FALLBACK=true` | Proxy bytes | `server.go:759-766` |
| Otherwise | **302/307 redirect** | `server.go:768-771` |
| Method not GET/HEAD | 405 | `server.go:813-816` |
| Part kind == local | Transparent proxy to Plex | `server.go:729-732` |

**What it does NOT depend on:** client type, User-Agent, `X-Plex-*`, Range header, GET vs HEAD,
provider, content type, codec. Only (a) a self-issued marker, (b) global config.

`AGENTS.md:13` explicitly forbids device sniffing: *"Do not hard-code Android, Plex Web, a user
agent, or a device model."* (X19 — and it is right.)

### The *ownership* rule is the different question that IS capability-dependent

`SelectPlaybackPlan` (`playback_policy.go:110-148`) is a deliberately pure function:

| Plan | Value | Owner |
|---|---|---|
| `PlaybackPlanSTRMRedirect` | `strm-redirect` | Client + external source |
| `PlaybackPlanPlexTranscode` | `plex-transcode` | **Plex** |
| `PlaybackPlanProxyHLSAudioFallback` | `proxy-hls-audio-fallback` | Proxy FFmpeg |
| `PlaybackPlanProxyHLSVideoFallback` | `proxy-hls-video-fallback` | Proxy FFmpeg |

**Default is direct-first** (`:147` returns `PlaybackPlanSTRMRedirect`). Proxy HLS is only reached
if the client's own codec profile says it can't decode, or Plex actually rejected the native path.

Client capability is parsed from `X-Plex-Client-Profile-Extra` (`client_profile.go:23-109`), not
from User-Agent.

## 5. M4 — the cold-probe budget (the most transferable thing here)

`server.go:1192-1251`:

```go
	// Home hubs and library lists must never start a remote request or wait for
	// FFprobe. A single-media detail request is different: it is the request
	// made after the user selected an item, and is the last metadata response
	// before Plex clients build their playback decision. Probe that one item so
	// the client receives real codec and Stream information before it sends
	// directPlay/directStream. For play queues, restrict a cold probe to the
	// selected Part; cached probes can still enrich any other STRM entries.
	...
	// A metadata endpoint can represent a show/season with many episodes. Do
	// not probe the first Part merely because the URL contains
	// /library/metadata/. A cold detail probe is safe only for one selected
	// STRM Part, an explicit internal plexPartID, or a queue's selected item.
	detailProbeAllowed := detailRequest && (selectedPartID != "" || detailSTRMParts == 1)
	coldProbeAllowed := detailProbeAllowed || (queueRequest && len(selectedQueueParts) > 0) || (probeMedia && selectedPartID != "")
	coldProbeUsed := false
```

**The rule, generalized: probe at most ONE item per response**, and only when the request is
(a) a single-item detail request, (b) carries an explicit internal part selector, or (c) is the
selected item of a play queue.

Enforced by 5 tests:
- `app_test.go:227` — hub must rewrite container but produce **0** cached probes (`:261-263`)
- `app_test.go:606` — `/library/metadata/42` with 2 STRM videos → **0** probes
- `app_test.go:486` — single-item detail → **exactly 1** probe
- `app_test.go:533` — only `playQueueSelectedItemID`'s part is probed
- `app_test.go:623` — pre-warmed probe is reused, count stays 1

`const strmMetadataProbeTimeout = 45 * time.Second` (`media_probe.go:79-83`);
`playbackStageAllowsProbe` (`playback_policy.go:98-100`) forbids probing entirely at
`PlaybackStageMetadata`.

**Port this directly** — generalized from "one ffprobe per response" to "**one provider read per
response**". This is the same problem class as Plex's scanner/analyze generating huge numbers of
requests that look like reads (see `07-plex-vfs-io-forensics.md` §C).

**Fragile:** `detailSTRMParts == 1` is a guess — a show/season detail response that happens to
contain exactly one STRM part will trigger a cold probe on what might be a list render.

## 6. M17 — client cancellation ≠ upstream rejection

`server.go:293-306`:

```go
func isSTRMTranscodeIntent(request *http.Request) bool {
	query := request.URL.Query()
	return query.Get("directPlay") == "0" && query.Get("directStream") == "0"
}

func shouldUseSTRMProxyFallback(status int, proxyErr error) bool {
	if status < http.StatusBadRequest { return false }
	return !errors.Is(proxyErr, context.Canceled) && !errors.Is(proxyErr, context.DeadlineExceeded)
}
```

And the error-capture plumbing that makes the distinction answerable (`server.go:66-92`):

```go
// plexProxyErrorCapture lets the buffered native Plex path distinguish an
// actual upstream rejection from a request that the client cancelled while
// Plex was still opening the transcode session. The latter must not create a
// proxy-owned HLS session: doing so races the client's retry and takes
// ownership away from Plex.
```

Test: `app_test.go:2110 TestCanceledNativeTranscodeStartDoesNotCreateProxySession`.

> `AGENTS.md:62-64`: **"A client cancellation or timeout is not evidence that an upstream rejected
> the path."** This maps exactly onto our question of whether provider API work should be triggered.
> **Port it as an invariant.**

## 7. The direct-decision short-circuit — the intent boundary, expressed as intent flags

`server.go:393-402`:

```go
	// A start request with both flags set to zero is an explicit request for a
	// server-owned transcode. A prior direct decision in the same session must
	// not override that current intent.
	if !isSTRMTranscodeIntent(request) {
		if directMapping, ok := s.directDecisionForStart(sessionID, mapping.PartID); ok {
			s.logger.Info("redirecting confirmed STRM direct start to direct source", ...)
			s.serveResolvedMedia(writer, request, directMapping)
			return
		}
	}
```

So `start.m3u8` after a confirmed direct decision → 302 to the provider URL, **never reaching
Plex**.

**This is the intent boundary we are looking for, and it is expressed as client-declared intent
flags on a specific endpoint — not as a heuristic.** That is a crucial data point for E2: Plex
*does* hand us explicit intent signals on the control plane (`directPlay=0&directStream=0`), so we
may not need to infer intent from byte patterns on the data plane at all.

## 8. Stable Part id → transient remote URL

`mapping.go:23-51` — in-memory TTL map, **durable: NONE**:

```go
type PartMapping struct {
	PartID        string
	Kind          PartKind      // "local" | "strm"
	File          string
	Key           string
	STRMPath      string
	ResolvedURL   string
	UpdatedAt     time.Time
	ResolutionErr string
}
```

`MappingCacheTTL = 10 * time.Minute` (`config.go:49`); `ResolverCacheTTL = 5 * time.Minute`, keyed
on `path|mtimeNanos|size` (`resolver.go:125`).

**The stable parts are:** (1) the Plex `PartID`, from Plex's own DB, stable across restarts;
(2) the `.strm` file on disk — the durable record of `PartID → provider URL`. The mapping is
**reconstructible at any time** by re-reading the file.

### Non-downgrade invariant (a real bug class)

`mapping.go:67-86`:

```go
	if existing, ok := s.items[mapping.PartID]; ok && now.Before(existing.expiresAt) &&
		existing.value.Kind == PartKindSTRM && existing.value.ResolvedURL != "" &&
		mapping.Kind == PartKindLocal {
		// Plex may later echo the same Part through a session/status response
		// without the original .strm file. That representation is not a new
		// library fact and must not downgrade the authoritative STRM mapping;
		// otherwise the next Part request is sent back to Plex and can produce
		// an upstream redirect/auth response instead of the configured 302.
		mapping = existing.value
	}
```

**Port this invariant.** "A weaker observation must not overwrite a stronger one" is our P3
requirement F, restated.

### On expiry / eviction

`server.go:714-737` — if the mapping is missing and `StrictPartMap` (default true), return **404 +
"retry playback decision"**. The Plex library item is completely unaffected (the proxy never wrote
to Plex); the client retries the decision endpoint and a fresh mapping is installed.

**But** if the *signed URL itself* expired, this is unrecoverable mid-playback. `README.md:136`: a
signed URL must remain valid for the entire playback session. There is no re-signing logic.

**Port the shape, not the TTL.** Our mapping (`PartID → ProviderPlacement`) is durable in *our* DB,
which is strictly better — no TTL needed, and a dead placement can be re-resolved by asking the
provider for a fresh one.

## 9. What the proxy does and does not see of Plex's own probing

**It does NOT see:** Plex's scanner, "Analyze"/deep analysis, intro/credits detection, chapter
thumbnail (BIP) generation, or bitrate analysis. **All of those run in-process inside PMS, reading
files directly off disk.** They never issue HTTP requests to `/library/parts/N/file`. There is no
code for `/library/metadata/N/analyze`, `/refresh`, thumbnails, or BIP.

> **This matters enormously for us.** With `.strm` files, Plex's scanner reads 40 bytes and learns
> nothing. **With a VFS exposing a real-size virtual file, Plex's scanner would read real bytes —
> possibly the whole file** — and that traffic goes through *our* VFS layer, not through an HTTP
> proxy like this one. See `07-plex-vfs-io-forensics.md` §C for the cost table.

**It DOES see:** Plex-server-originated reads when Plex needs actual bytes (native transcode, Direct
Stream remux), arriving at `/library/parts/<id>/file?plexTranscode=1`.

**The discriminator is a marker the proxy injected into the URL it handed Plex.** Not a User-Agent,
not a heuristic (`server.go:748`, `:846`, `:1067`, `:1156`). **This is the answer to our Q4: you
can discriminate Plex-internal reads from client playback because you mint the URL Plex is given,
so you can tag it.** No HMAC — it's a routing hint, not a security boundary.

## 10. The Plex quirk catalog (complete)

Zero `TODO`/`FIXME`/`HACK` markers in the codebase. All quirks are encoded as code with comments.

| # | Quirk | Cite |
|---|---|---|
| 1 | Plex Web sends the **direct source URL back in `start.mpd`** even though it's now a transcode request; must rebind or Plex gets the third-party URL and appends its token | `server.go:342-359` |
| 2 | Plex Web **cancels** the decision/start request after receiving its synthetic response; probing must survive (`context.WithoutCancel`) | `server.go:500-506` |
| 3 | Client cancel ≠ Plex rejection | `server.go:301-306` |
| 4 | Plex's internal DASH fetch treats a **huge `Content-Length` as an allocation hint** → delete it for unbounded 200s on the protected route | `server.go:842-848` |
| 5 | **Android uses the Part `file` extension** to decide native vs HLS input | `metadata_rewrite.go:149-160` |
| 6 | Plex Web uses the declared **`container`** to choose the playback branch | `server.go:1064-1066`, `:884-905` |
| 7 | Plex Web starts playback from **Hub-embedded metadata** (Continue Watching) rather than re-fetching | `server.go:1117-1121` |
| 8 | Plex JSON **`frameRate` is a formatted string** while other numeric fields are numbers; Android validates this | `metadata_rewrite.go:696-701` |
| 9 | Part `decision=directplay` can coexist with Stream `decision=transcode`; **stream wins** | `playback_policy.go:404-435` |
| 10 | Plex booleans appear as `true/false/"1"/"0"/1/0` | `metadata.go:541-548` |
| 11 | Plex echoes the same Part via session/status **without the `.strm` file** → would downgrade STRM→local | `mapping.go:74-81` |
| 12 | Native decisions against proxy-local metadata return a **local placeholder** (`file="127.0.0.1"`) — must not be ingested | `server.go:963-971` |
| 13 | Plex emits **absolute `Location` headers** pointing at its private upstream | `server.go:1389-1416` |
| 14 | Plex **appends `X-Plex-Token`** to URLs it fetches | `server.go:1545-1551`, `AGENTS.md:15` |
| 15 | Part path carries a **version segment**: `/library/parts/77/1786724686/file.mkv` | `server.go:1505-1523` |
| 16 | Clients that don't follow redirects → `PLAYBACK_MODE=proxy` | `README.md:130` |
| 17 | Clients must **sign out/in** after changing Custom server access URLs | `README.md:89` |
| 18 | **HEVC in DASH**: FFmpeg emits bare `hev1`; some Chromium builds reject it | `media_probe.go:509-542` |
| 19 | DASH clients get MPD + fragmented MP4; HLS gets playlists | `transcode_format.go:18-32` |
| 20 | Proxy must not claim Plex's own transcode session files | `hls_transcode.go:1058-1066` |
| 21 | Plex Web DASH sessions must be left to Plex even when Part says directplay and audio is transcode | fixture `strm-hevc-truehd-native-copy.xml` |

Provider-side quirks:

| # | Quirk | Cite |
|---|---|---|
| 22 | Signed media hosts leave **HEAD hanging** — bounded 8 s, then retry with a 1-byte ranged GET | `target.go:24-28`, `:145-183` |
| 23 | Some servers **reject HEAD (405/501)** or mishandle it (400/403) | `target.go:164-171` |
| 24 | Some endpoints answer HEAD with a **redirect to a login page** | `target.go:172-180`, `:235-245` |
| 25 | HTTP/2 stalls on signed endpoints → `ForceAttemptHTTP2: false` | `target.go:117-122` |
| 26 | Some sources reject ffmpeg's byte-range input seek → `-seekable 0` + `-ss` after `-i` | `hls_transcode.go:728-745` |
| 27 | Some reject a **second concurrent connection** to the same signed URL → kill main ffmpeg before a far-seek transcode | `hls_transcode.go:594-602` |
| 28 | Protected Part URLs are intentionally **forward-only**; long seeks download the whole source to disk first | `hls_transcode.go:437-546`, `:617-647` |
| 29 | FFmpeg has no usable `max_redirects` — resolve redirects in Go before the subprocess | `target.go:142-145`, `AGENTS.md:78` |
| 30 | ffprobe emits numeric fields as **JSON numbers or strings** depending on demuxer | `media_probe.go:129-159` |
| 31 | Redirect status must be **302 or 307 only** — 301/308 get cached against a transient URL | `config.go:205-207` |
| 32 | DNS split-horizon: container resolves the STRM domain publicly while the service is on the LAN | `README.md:115,120` |

**Quirk 31 is a trap worth internalizing**: a 301/308 redirect to a transient provider URL will be
cached by the client. Always 302 or 307.

## 11. Streaming implementation

`server.go:812-869` — pass-through, not synthesized:

| Question | Answer | Cite |
|---|---|---|
| Range support? | **Pass-through**, never synthesized. **If the provider doesn't support Range, seeking silently breaks** | `server.go:1545-1551` |
| 206 handling? | Faithful pass-through, `Content-Range` preserved | `app_test.go:1442-1486` |
| Content-Length? | Copied — **except deleted** on the protected route for unbounded 200s (quirk #4) | `server.go:846-848` |
| HEAD? | Forwarded as HEAD, body suppressed, `Content-Length` preserved | `server.go:817`, `:854-856` |
| Buffering? | **None.** 64-byte prefix read for sniffing, then 32 KiB chunks with `Flush()` each | `server.go:830-840`, `:907-926` |
| Content-Type? | Sniffs magic bytes (EBML, `ftyp`, `RIFF`) and **overrides** the provider | `server.go:884-905` |
| Auth leak? | Forwarded headers are an explicit allowlist of 6 — **no `Authorization`, no `X-Plex-Token`** | `server.go:1545-1551` |
| SSRF? | Every outbound request resolves DNS and filters loopback/private/link-local | `target.go:115-140`, `:265-296` |

## 12. Verdict on E5 — is an optional Plex fast path feasible without replacing the VFS?

**Yes — and the two are complementary. But the division of labor is the opposite of what you'd
expect.**

### Evidence it's feasible

1. **The interception surface is 4 URL paths + 1 response-rewrite hook** — a ~200-line router. Drop
   `resolver.go`, the STRM-specific bits of `target.go`, and every `isSTRMPath` check, and the
   control-plane interception still works; you'd just source `PartID → delivery URL` from your DB.
2. **The decision-vs-start split IS an intent boundary.** `decision` is cheap; `start` touches bytes.
   The proxy answers `start.m3u8` with a 302 **without contacting Plex** when a confirmed direct
   decision exists (`server.go:396-402`). Exactly the moonshot shape.
3. **`plexTranscode=1` proves you can discriminate Plex-internal reads from client playback** without
   heuristics (§9).
4. **Plex can be made to do the codec decision itself** (`server.go:239-258`) — you don't reimplement
   its direct-play logic.
5. **The ownership discipline is explicit and tested** — Plex keeps ordinary transcoding; the proxy
   only takes over when Plex actually returns ≥400.

### Evidence NOT to drop the VFS

1. **~2,500 lines exist purely to compensate for Plex being unable to probe the file.**
   `metadata_rewrite.go` (800) + `media_probe.go` (751) + `decision_rewrite.go` (396) +
   `decision_json_rewrite.go` (546) ≈ 2,493, plus `hls_transcode.go` (1,094) which exists because
   Plex's transcoder can't open a `.strm`. **That's >50 % of the non-test codebase.** With a VFS
   reporting a real size and serving real bytes, Plex's *own* scanner writes duration/codecs/streams
   into its own DB and all of it is unnecessary.
2. **The cold-probe budget is a workaround for missing metadata.** With a VFS + Plex's own scanner,
   metadata is already in Plex's DB and you need zero ffprobe on the metadata path.
3. **The FFmpeg HLS fallback is a liability you'd inherit for no reason.** `AGENTS.md:39`: *"HLS
   fallback consumes NAS CPU, temporary disk space, and network bandwidth, so it must not become the
   default path for all media."* Long seeks download the **entire source file** to disk. With a VFS,
   Plex's own transcoder reads through it and you get Plex-native seeking for free.

### Evidence the VFS alone is not sufficient — the real risk

**VFS reads are not free either.** Plex's scanner + Analyze + intro detection + BIP all read file
bytes. With a provider-backed VFS, *every one of those is a provider read*. `.strm` accidentally
avoids this because the file is 40 bytes — an accident, not a design.

> **This is the single biggest transferable lesson in the repo: HashSucker needs its own equivalent
> of `coldProbeAllowed`, applied to VFS reads, not just to ffprobe calls.**

### Recommended division of labor

| Layer | Keep VFS? | Why |
|---|---|---|
| Library scan / probe / analyze | **YES — VFS** | Only a VFS can serve it; real size + bytes → real metadata in Plex's DB |
| Playback decision (`/decision`) | **YES — thin interceptor** | ~100 lines, no bytes |
| Playback start (`start.m3u8`/`.mpd`) | **YES — thin interceptor** | **This is the intent boundary** |
| Media bytes, client-facing | **302 redirect** | The moonshot. Zero bytes through our process |
| Media bytes, Plex-internal | **Proxy or VFS** | Distinguished by `plexTranscode=1` |
| Transcoding | **Plex** | Adopt `AGENTS.md:14`: *"Prefer direct STRM playback, but do not force ordinary Plex media through this proxy's transcoder."* |

### Port verbatim

1. `SelectPlaybackPlan` + the transcode-dominant classifier (`playback_policy.go:110-148`, `:404-467`)
   + the 5 captured fixtures.
2. **The cold-probe budget** (`server.go:1192-1251`), generalized from "one ffprobe" to "one
   provider read".
3. The two-address URL topology (`server.go:449-491`) and `plexTranscode=1` as the Plex-internal
   discriminator.

### Do NOT port

1. `hls_transcode.go` (1,094 lines) — unnecessary with a VFS.
2. `resolver.go` + `.strm` parsing — our DB is the durable record.
3. The `directDecisions` full-body cache (`server.go:1271-1339`) — a compensation for Plex
   re-asking; we can answer from a durable mapping instead of a 128-entry TTL LRU of response
   bodies.

### The sharpest counterintuitive finding

**The redirect-vs-proxy decision here is 100 % static configuration and 0 % client-aware.**
Everything one might expect to matter — client type, Range, GET vs HEAD, auth, provider — is
irrelevant to it. All of that complexity lives in a *different* question (who owns transcoding),
and it exists only because this proxy runs its own FFmpeg.

> For HashSucker: **the redirect fast path is a 14-line function plus one marker check.** The 6,900
> lines around it are the cost of not having a VFS.

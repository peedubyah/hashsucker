# `Jauntiness/torrg` — probe windows, intent inference, API-call firewall

**Repo:** `research/moonshot-refs/torrg` · **Language:** Python · **Shape:** WebDAV/HTTP proxy over
TorBox with an explicit probe budget.

**Why it matters here:** torrg is the only reference in the corpus that attempts **explicit
playback-intent inference**, and the only one that uses a byte-range *window* as a dual-purpose
mechanism (cache test **and** API-call firewall). It is the intellectual ancestor of experiments
E1 and E2.

---

## 1. Architecture

```
client (Plex / player / ffprobe)
  └─> torrg WebDAV/HTTP front end
        ├─ probe path    : head/tail byte windows, served from local blob cache
        └─ materialize   : provider API (requestdl) gated by PlaybackIntent + budget
              └─> TorBox CDN (presigned URL, TTL-bounded)
```

Durable identity is a **composite primary key `(hash, wpath)`** — infoHash plus the walking path
inside the torrent. Provider-native `tid`/`fid` are treated as **explicitly volatile**: stored for
convenience, never used as identity. This aligns with HashSucker invariant I1/I3 and is worth
noting as independent confirmation of the ontology.

## 2. M1 — The probe window (the core mechanic)

`app.py:615-621`:

```python
def in_probe_window(start, length, size, head=PROBE_HEAD_MB * MB, tail=PROBE_TAIL_MB * MB):
    return (start + length) <= head or start >= size - tail
```

| Constant | Value |
|---|---|
| `PROBE_HEAD_MB` | 16 |
| `PROBE_TAIL_MB` | 2 |

**The insight is that this predicate does double duty:**

1. **Cache-hit test** — is this read inside the region we bother to cache locally?
2. **API-call firewall** — a read outside the window is not allowed to trigger a provider call
   unless intent has been established.

This is why the head is 16 MiB and the tail only 2 MiB: the head absorbs container-header probing
(ffprobe, mediainfo, Plex's initial sniff), the tail absorbs container-index/duration reads
(MP4 `moov` at EOF, MKV cue seek). Compare `09-cache-concurrency` in the Zurg corpus and
`07-plex-vfs-io-forensics.md` §G6, which independently recommends exactly a head+tail cache.

**Port? Yes.** Directly applicable. Two adjustments for HashSucker:

- The window must be **per-`TorrentFile`, not global.** torrg's window is computed against the
  file size it holds, so it is effectively per-file already, but the *constants* are global. A
  16 MiB head on a 1 GB episode is 1.6 %; on a 60 GB remux it is 0.027 %. Consider
  `min(head_max, size * ratio)` the way lazarr sizes its footer (`05-lazarr.md` §6).
- The window must be **sized against observed offsets**, not guessed. `07` §H1–H3 describes the
  measurement we would need (ProcMon on Windows / fatrace on Linux, plus a loopback capture).

## 3. M16 — Playback-intent inference

`app.py:646-675`, `PlaybackIntent.miss()`:

| Constant | Value | Meaning |
|---|---|---|
| `repeat_n` | 3 | reads on the *same* key within the window that signal real playback |
| repeat window | 30 s | |
| `storm_keys` | 4 | distinct keys within the storm window that signal a *scan*, not playback |
| storm window | 120 s | |
| `budget_per_hour` | 12 | hard cap on materializations |
| `cooldown` | 600 s | |

**The discriminator is request *pattern*, not byte size:**

- **Playback** = repeated reads against the *same* key. A player reads sequentially and keeps
  coming back to the same file.
- **Scan/probe** = a storm of *distinct* keys. A scanner touches one file after another and never
  returns.

**This is the single most important transferable idea in the corpus for E2.** The directive
explicitly warns: *"do not guess using only request byte size (CatBox showed a raw `/dav` GET could
emit >100 MB without triggering materialization, so intent may need request-pattern/session/context
semantics)."* torrg's repeat-rate-vs-distinct-key-storm test is precisely such a pattern test, and
it is pattern-based for exactly that reason.

**Port? Yes — as the shape, with a hard caveat.** The thresholds (`3` / `30s` / `4` / `120s`) are
tuned to one deployment's Plex. We must:

- Make them **configurable and instrumented from day one**; log the classifier's input features so
  the thresholds can be fitted to real traces rather than guessed.
- Add a **fail-open vs fail-closed policy decision**. If the classifier is unsure, does the request
  materialize (safe, costs a provider call) or not (cheap, risks a stall)? torrg fails closed
  (budget-limited). For playback reliability — the whole point of the moonshot — failing closed on
  a *real* playback is worse than an extra provider call. Consider a third state: **defer** (serve
  what you can, materialize in the background, block only if the read would leave the probe window).

## 4. M18 — Anti-poisoning without synthetic bytes

**torrg synthesizes no bytes anywhere.** Verified. Instead:

1. **Full-interval coverage requirement** — a cached blob is only served if it fully covers the
   requested interval. A partial hit is a miss.
2. **Short reads return `None`** — never a truncated buffer. A short read would be interpreted by
   ffprobe/Plex as premature EOF and would corrupt the very header scan the cache exists to serve.
3. **Blob-drop on real eviction** — when the provider genuinely evicts, the cached head/tail is
   dropped, not served stale.

**This is the correct answer to invariant I7.** Compare lazarr, which arrived at the identical
all-or-nothing contract independently (`05-lazarr.md` §7.1), and contrast stremiarr, which uses a
`< 25 MB ⇒ dead` size heuristic that permanently kills small legitimate files
(`03-stremiarr.md` §5.6 BUG E/F).

**Port? Yes, verbatim.** The three rules are small and complete.

## 5. Eviction authority is asymmetric

Only `checkcached` (a positive *authoritative* provider statement about presence) may evict cached
state. **Transport failures, API errors and timeouts never poison the catalog.**

This is the same discipline warpbox states as *"never demote a Placement because a call failed"*
(`02-warpbox.md` §8) and that HashSucker already encodes in P3 (absence of evidence is not evidence
of absence). Three independent codebases converging on it is strong evidence it is right.

**Port? Yes — and it should become an explicit invariant, not a per-call-site habit.**

## 6. Other mechanics

| Mechanic | Value | Port? |
|---|---|---|
| `CDN_TTL_S` | 1800 (30 min) | Yes — delivery-URL TTL, with jitter |
| Native WebDAV fallback `NATIVE_TTL` | 300 s | Partially — a fallback path is useful; ours would be provider failover instead |
| Breaker: `fails=5` / `window=60s` / `neg_ttl=30` | | Yes, but re-scope from global to per-placement |
| `get()` is all-or-nothing | | No — we want partial/range support |

## 7. Fragile / do not copy

1. **TorBox-shaped throughout.** There is no equivalent of Real-Debrid's hash re-add path. Porting
   its assumptions to RD would be wrong.
2. **Global, not per-container, probe window.** One size of head/tail for every file.
3. **`get()` is all-or-nothing** — no partial range fulfilment.
4. **One `curl` subprocess per API call.** Enormous per-call overhead; fine for a hobby deployment,
   not for us.
5. **Intent thresholds are undocumented magic numbers** with no recorded trace behind them.

## 8. Verdict

torrg contributes the **conceptual core of E1 and E2**: probe windows as a dual-purpose
cache/firewall, intent inferred from pattern rather than size, and anti-poisoning by coverage
completeness rather than by fabrication. It is the smallest repo in the corpus and has the
highest idea-density.

Its constants should be treated as **starting points to be fitted**, not as answers.

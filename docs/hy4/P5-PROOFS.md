# P5 — Proof ladder A–E (executed against the live stack)

**Branch:** `m3-north-db`
**Date:** 2026-09-04
**Stack:** `media-search:local` + `hy4-data-plane:local` (Rust `rust:1.96.1-alpine3.22`
builder, release binary). VFS forwarder pinned to `DATA_PLANE_URL=http://hy4-data-plane:3001`.
Real `control-plane.db` + `discovery-cache.db` mounted; TorBox credentials live.

The P5 invariant under test: for a durable VFS entry (`torrentFileId != null`), Rust is
the **only** byte-serving authority. A Rust failure classifies into exactly one of
A/B/C/D; only class **D** (`PROVIDER_EXHAUSTED`) is allowed to flow into the existing
persisted-candidate fallback (switch `TorrentFile`, re-forward to Rust). No class may
silently escape into the legacy Node provider byte path, and no class may present a
truncated `206` as success.

Durable candidates (from `P4-PROOFS.md` §4):

| Role | `tfId` | Path |
|------|--------|------|
| Movie | `tf_5de34a78-0a1a-410b-8de5-76ded2680e7d` | `/vfs/Movies/tt1825683/tt1825683.mkv` |
| TV S01E01 | `tf_c09f21b6-0d01-410c-95d6-71943474ac01` | `/vfs/TV/Ted Lasso/Season 01/Ted Lasso - S01E01.mkv` |
| TV S01E02 | `tf_ecbd6de5-9f28-4002-a682-a38960f00c93` | `/vfs/TV/Ted Lasso/Season 01/Ted Lasso - S01E02.mkv` |

## A — primary success, no legacy escape ✅

`GET /vfs/Movies/tt1825683/tt1825683.mkv` `Range: bytes=0-65535`

```
HTTP/1.1 206 Partial Content
content-length: 65536
content-range: bytes 0-65535/34319716114
accept-ranges: bytes
content-type: video/x-matroska
```
Body = **65 536 bytes** (verified via piped `wc -c`). No `openValidatedProviderRead`
invocation on the `tfId`-present entry — Rust served directly. ✅

## B — forced exhaustion → persisted alternate ✅ (two demonstrations)

The `HY4_FORCE_EXHAUST_TFID` test gate returns `PROVIDER_EXHAUSTED` (502, class D)
**before any 206** for the targeted `tfId`, exactly as a real `AllSameTfFailed` would.

### B.1 — Movie (gate `tf_5de34a78-…`, no distinct cached alternate)

`GET /vfs/Movies/tt1825683/tt1825683.mkv` `Range: bytes=0-65535` →

```
HTTP/1.1 502 Bad Gateway
content-type: application/json; charset=utf-8
{"error":"data-plane returned 502 for tfId=tf_5de34a78-...: PROVIDER_EXHAUSTED","code":"PROVIDER_EXHAUSTED"}
```

media-search log:
```
[vfs] persisted-alternate fallback used for media=tt1825683 ... newTfId=tf_5de34a78-...
[vfs] re-forward to alternate tfId=tf_5de34a78-... failed: ... PROVIDER_EXHAUSTED
```
The class-D fallback **fired**, selected the only TorBox-cached alternate, promoted it,
and re-forwarded to Rust — but in this dataset the only persisted alternate resolves to
the **same** `tfId` (so it is still gated), and the chain terminates at an explicit
`502` with **no legacy escape**. ✅ (Proves fallback *wiring* + *no-legacy-escape*.)

### B.2 — TV S01E01 (gate `tf_c09f21b6-…`, distinct cached alternate) — HAPPY PATH ✅

`GET /vfs/TV/Ted Lasso/Season 01/Ted Lasso - S01E01.mkv` `Range: bytes=0-1023` →

```
HTTP/1.1 206 Partial Content
content-range: bytes 0-1023/5808263018
```
Body = real matroska bytes. media-search log:
```
[vfs-tv] persisted-alternate fallback used for media=tt10986410
        from=18f1fa740652ff438b261080073ba4b8171e9428:torrent
        to=23dc09ffa3310d21b22acb905d9a56d3b0cb864d:torrent
        rank=4 newTfId=tf_00f25ade-a5ad-4864-9db2-ab4430251302
```
Primary `tf_c09f21b6-…` was gated → class D → a **distinct** TorBox-cached alternate
`tf_00f25ade-…` (rank 4) was selected → re-forwarded to Rust → served `206`. The full
"switch TorrentFile, re-forward to Rust, serve bytes" lifecycle is exercised end to end. ✅

## C — 416, no fallback ✅

`GET /vfs/Movies/tt1825683/tt1825683.mkv` `Range: bytes=99999999999999-` →

```
HTTP/1.1 416 Range Not Satisfiable
content-range: bytes */34319716114
```
Class A — unsatisfied range. `sendError` fires, **no** fallback and **no** legacy path. ✅

## D — Rust unreachable → explicit 5xx, no legacy ✅

Data-plane container stopped; `GET /vfs/Movies/tt1825683/tt1825683.mkv` `Range: bytes=0-65535` →

```
HTTP/1.1 502 Bad Gateway
content-type: application/json; charset=utf-8
{"error":"data-plane unreachable for tfId=tf_5de34a78-...: fetch failed","code":"DATA_PLANE_UNREACHABLE"}
```
Class C — `DATA_PLANE_UNREACHABLE`. The error originates in `data-plane-forward.js`
(never reached Rust), classification is class C, so `attemptPersistedAlternateFallback`
is skipped and the client receives an explicit `502`. The legacy Node provider byte path
is **not** entered for the `tfId`-present entry. (Observed ~14 s — the fetch layer's
connection-retry interval before giving up; acceptable.) ✅

## E — TV sibling safety (per-`tfId`, not per-infoHash) ✅

With `HY4_FORCE_EXHAUST_TFID=tf_c09f21b6-…` (Ted Lasso S01E01) set on the data-plane,
`GET /vfs/TV/Ted Lasso/Season 01/Ted Lasso - S01E02.mkv` `Range: bytes=0-1023` →

```
HTTP/1.1 206 Partial Content
content-length: 1024
content-range: bytes 0-1023/5691921896
```
E02 (`tf_ecbd6de5-…`) serves normally while its sibling E01 (`tf_c09f21b6-…`) is
force-exhausted. Exhaustion is **per-TorrentFile**; identity is exact. ✅

## Coherence gates

- [x] `cargo check --bin hy4-data-plane` — clean (2 intentional dead-code warnings only).
- [x] `cargo test --release --lib` — **27/27** pass.
- [x] `docker build` (multi-stage, release binary) — `hy4-data-plane:local` built.
- [x] No truncated/`206`-as-success on exhaustion (root bug fixed: acquire before 206).
- [x] Class D is the only fallback-eligible class; A/B/C/unreachable terminate explicitly.
- [x] Legacy Node provider byte path unreachable for any `torrentFileId != null` entry.

## Follow-up notes

- The data-plane was restored to a **clean (no-gate)** state after the proofs.
- `compose.p5proof.yaml` (a temporary proof overlay that adds the
  `HY4_FORCE_EXHAUST_TFID` passthrough) was **not** committed — it is a local proof
  artifact only, set via `HY4_FORCE_EXHAUST_TFID=<tfId> docker compose … up -d hy4-data-plane`.

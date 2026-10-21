# Are we re-ranking for a reason? — the upstream/HashSucker differential (2026-10-20)

Measurement only. **No production selection behaviour changed.** The question:
does HashSucker's independent re-parse and re-rank of Stremio-addon candidates
buy anything the addon did not already provide, or is it duplicated work?

Method: eight fixtures fetched live from the public Torrentio deployment
(`https://torrentio.strem.fun`, **no debrid key**, so no provider API was
touched and the addon answers in the magnet form), each raw stream run through
the **production normalizer** (`src/lib/stremio/normalize.js`) and the
**production sort** (`sortStreams`), then compared field-for-field against the
addon's own interpretation of the same candidate.

---

## 1. What the upstream actually publishes, and where

The upstream publishes its parse in **two shapes** — and this is the first
correction to the recon's framing:

| field | movies | series |
|---|---|---|
| `behaviorHints.bingeGroup` | `torrentio\|4k\|BluRay\|x265\|10bit\|HDR` — label, resolution, source, codec, bitDepth, HDR | `torrentio\|<infoHash>` (**no quality at all**) or `torrentio\|4k\|XEBEC` — label, resolution, group |
| `name` (2nd line) | `4k HDR`, `4k DV \| HDR` | `4k DV \| HDR10+ \| HDR` — the same tag list for **both** kinds |
| `title` | `… 2160p BluRay\n👤 186 💾 6.91 GB ⚙️ YTS` — the resolution in full, plus seeders and size | same |
| `behaviorHints.filename` | the release filename | same |
| `infoHash` / `fileIdx` | present | present |
| `behaviorHints.videoSize` | **absent** without a debrid key; the exact *file* size with one | same |
| `url` | **absent** without a debrid key (the magnet form) | same |

So the comparable upstream parse is the **name's tag list** (the only shape
present for both kinds); `bingeGroup` is structured only for movies, and for
series it is mostly the infoHash. A first pass that parsed `bingeGroup` as if
it were always the movie shape produced 253 spurious "conflicts" — the
comparison has to read the name.

## 2. The differential (605 comparable candidates, 8 fixtures)

| | count | share |
|---|---|---|
| **A — equivalent** (the same resolution and HDR) | 509 | **84.1 %** |
| **B — HashSucker adds information** | 92 | 15.2 % |
| **C — upstream has richer information** (in the compared fields) | 0 | 0 % |
| **conflicts** (both understand it, differently) | 4 | 0.7 % |
| the upstream published no parse for the candidate | 8 | — |

**Every one of the 605 candidates also carried upstream facts HashSucker's
normalizer has no field for**: the bit depth (`10bit`), the **seeders**
(`👤 186`, only in the upstream's title) and the size text (`💾 6.91 GB`).
254 candidates carried facts only HashSucker's parse has (notably the **audio**
track, which the upstream's tag list never carries).

The 92 "B" cases are not new information: they are the upstream's **own**
resolution, recovered by HashSucker's parse from the upstream's **title**
(`2160p BluRay`) rather than from its tag list. The upstream knew it; it
published it in a different field. HashSucker's re-parse is a **re-derivation
of the addon's facts, not an addition to them**.

## 3. The three ranking models

| model | description |
|---|---|
| **M1** | the current HashSucker order (`mergeStreams` → `sortStreams`: cached → resolution → size → addon order → title) |
| **M2** | the raw upstream order |
| **M3** | HashSucker's order with the upstream's parsed fields filling the gaps and the upstream's position breaking ties (a stable sort preserves the upstream order within a tie) |

| fixture | streams | M1 = M2 (top-1) | M1 = M3 (top-1) | top-3 overlap M1∩M2 / M1∩M3 | top-10 overlap M1∩M2 / M1∩M3 | top-1 resolution M1 / M2 / M3 |
|---|---|---|---|---|---|---|
| movie-2160p-hdr | 96 | no | yes | 1 / 3 | 6 / 10 | 2160p / 2160p / 2160p |
| movie-1080p-classic | 101 | yes | yes | 1 / 3 | 6 / 10 | 2160p / 2160p / 2160p |
| movie-dv-atmos | 88 | no | yes | 0 / 3 | 3 / 10 | 2160p / 2160p / 2160p |
| episode-s01e01 | 69 | no | yes | 2 / 3 | 7 / 10 | 2160p / 2160p / 2160p |
| episode-s01e05 | 67 | no | yes | 2 / 3 | 7 / 10 | 2160p / 2160p / 2160p |
| episode-season-pack | 50 | no | yes | 2 / 3 | 7 / 10 | 2160p / 2160p / 2160p |
| episode-newly-aired | 120 | no | yes | 0 / 3 | 4 / 10 | **2160p / 4320p / 2160p** |
| episode-old-show | 22 | no | yes | 0 / 3 | 9 / 10 | 1080p / 1080p / 1080p |

Readings:
- **M1 and M2 disagree on the top-1 in 7 of 8 fixtures — but the top-1
  *quality* is identical in 7 of 8.** The re-sort mostly reorders rows of
  equal quality; it rarely changes what is chosen.
- **M3 changes no top-1** (identical to M1 everywhere except where M1 and M2
  already agreed) while making the **top-3 identical to the upstream's** and
  the top-10 overlap 10/10. So the upstream's order is useful **as a
  tiebreak**, not as an authority.
- The one quality difference is instructive: for the newly aired episode the
  upstream's first row is a **4320p** release and HashSucker's is 2160p.
  HashSucker's parse *did* read "4320p", but its resolution ordering does
  not know 4320p, so the candidate is ranked last. A real 8K release would
  be demoted by our sort. **A small, concrete gap in our ordering, not in
  our parsing.**

## 4. Exact-file outcomes

- In the **magnet form** (no debrid key) the identity strength of **every
  one of the 613 candidates** is `release-only`: the addon publishes an
  infoHash and a file index, and **no exact file size and no torrent-internal
  path**. HashSucker's binding cannot be built from an addon's answer at all.
- In the **debrid form** the addon publishes `behaviorHints.videoSize` — the
  exact byte count of the selected file — which is what
  `normalizeStream`'s `exactFileSize` consumes. The addon can therefore
  supply the *size*; it never supplies the *canonical internal path*, which
  HashSucker resolves from the torrent's own file list.
- The addon's `fileIdx` is an **index**, not an identity: it is stable only
  for a given metainfo, it degrades when the torrent is not cached (Comet),
  and it says nothing about the path.

## 5. Newly aired coverage

- The upstream's coverage for the household's newly aired show was **good**:
  120 candidate streams, of which **115 name the requested episode**
  (S01E08) in the title or filename. So the *upstream* is not the gap.
- In the persisted corpus, `tt26545992` has **254 associated candidates**
  (`match_method = request-ranked`) — so the candidates exist and are
  associated with the media id — but **every association is
  `resolution_state = unresolved`**, and `resolver_source` is **empty** on
  all 8751 rows in `candidate_media`. The *provenance* of an association is
  not recorded.
- The control plane has an **active Binding for S01E08** (`tf_8eb97c57…`) —
  the newly aired episode is bound today. The historical concern about
  newly aired coverage is, for this show, resolved.

## 6. Cost

| | measured |
|---|---|
| normalizing 22–120 candidates (the production normalizer) | **0.3 – 3.9 ms** |
| the production sort | **0 – 4.3 ms** |
| DB churn attributable to the addon path | **zero** — the persisted `candidates` table is 100 % `dmm.hashlist` ingestion (1 480 584 + 112 543 rows); **no addon candidate is ever persisted** |
| duplicated provider/cache checks in the live path | the addon's own `cached` flag is consumed by `sortStreams` and kept on the candidate, but the **live-bridge's release shape drops it** (`src/lib/discovery/live-bridge.js:79-108`) — the addon's answer is used for ordering and then discarded before the ranking sees it |

**The parse and the sort together are under 8 ms on the largest fixture.**
This is not a latency problem. The cost of the duplication is not CPU.

## 7. What the upstream's ordering encodes — and must not become ours

Torrentio's sort is a **configuration option** (`addon/lib/sort.js`: "By
quality then seeders", "By seeders", by size, by video quality) and its
filters are per-user configuration; the addon's response is therefore
**operator-configured and user-configured policy**, not a fact about the
release. The same is true of Comet's `sortCachedUncachedTogether` and its
RTN ranking profile.

**Upstream order is evidence, never authority.** It must not become durable
HashSucker ranking policy, and it must not survive into the persisted
candidates as an ordering fact.

## 8. Answering the questions directly

- **What structured quality does the upstream provide?** The name's tag list
  for every candidate; a structured `bingeGroup` for movies only (and for
  series, the infoHash instead of a parse); the seeders and a human size
  string in the title; the release filename; the exact file size only in the
  debrid form.
- **What does HashSucker reconstruct?** The resolution, the source, the codec,
  the HDR type, the audio and the language — from the filename and the title.
- **Where do they disagree?** 15.2 % of candidates on the resolution/HDR
  pair — and in every one of those the upstream had the same fact somewhere
  else (its title). 0.7 % genuine conflicts.
- **Where does HashSucker recover what the addon omitted?** The audio track
  (254 candidates), and the episode→file mapping, which the addon does not
  express at all.
- **Where does HashSucker throw away what the addon knew?** The **seeders**
  (605 candidates), the **bit depth** (605), the upstream's **order** beyond
  a tiebreak, and — at the live-bridge boundary — the addon's own `cached`
  flag.
- **Does upstream ordering encode user/provider configuration?** Yes —
  Torrentio's sort is a config option and its filters are per-user. It must
  not become our durable ranking policy.
- **Does retaining upstream rank as a feature improve our ranking without
  surrendering authority?** Yes: M3 changed **no** top-1 and made the top-3
  identical to the upstream's. It is a good tiebreak and a bad authority.

## 9. Verdict

**USE UPSTREAM AS FEATURES** (with the current layer partly justified).

Not **REDUNDANT**: the re-parse is not the addon's parse re-derived for
nothing — it recovers facts the addon's *tag list* omits (the audio track),
it covers the *series* case where the addon publishes no structured parse at
all, and it is the only parse that is uniform across heterogeneous sources
(DMM hashlist, Torznab, Prowlarr, the addons). HashSucker's normalization
across sources is load-bearing and must stay.

But the **ranking** is where the duplication is real: 84 % of the parsing is
re-derivation of the addon's own facts, the re-sort changes the *order* of
equal-quality rows in 7 of 8 fixtures while changing the *outcome* in 1, and
the upstream order — which is someone else's configured policy — is
currently discarded except as a tiebreak, while the upstream's `cached` flag
is discarded outright at the live-bridge boundary.

## 10. The smallest safe implementation change (NOT applied here)

1. **Carry the upstream's parsed tags as a feature source** — fill the gaps in
   HashSucker's parse from `behaviorHints.bingeGroup` (movies) and the name's
   tag list (both kinds) instead of re-deriving what the addon already
   published. Purely additive: the upstream's values fill blanks, they never
   overwrite HashSucker's own.
2. **Carry the upstream's position as a tiebreak** (M3) — it changes no
   top-1 and restores the upstream's top-3 ordering. The upstream's order
   stays *evidence*; it never becomes durable policy and never reaches the
   persisted candidates.
3. **Do not drop the addon's `cached` flag at the live-bridge boundary** —
   it is the upstream's own answer to "is this release cached", and it is
   currently used for ordering and then thrown away.
4. **Fix the resolution-order gap** — `RESOLUTION_ORDER` does not know
   `4320p`, so a genuine 8K release is ranked last.

None of these changes the *policy* HashSucker applies; they make the policy
act on the addon's evidence where the addon's evidence is better than our
re-derivation of it.

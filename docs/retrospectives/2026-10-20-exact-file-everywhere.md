# Retrospective: exact file everywhere

## Expected vs actual

Expected to find one widening predicate in the second-placement ensurer.
Found the opposite: the ensurer was already exact (it looks for the
provider file ALREADY MAPPED to our TorrentFile), and the widening lived
one layer up — in the DISCOVERY's file classification, which the route
authorization then inherited.

The real leak was smaller and nastier than a missing predicate: the
Real-Debrid classification could answer "the only playable video in this
resource" — and the route authorization never checked that the file it
picked was the size the discovery said it selected. The bytes an item then
served were not necessarily the bytes the ranking chose.

## Surprises

1. **The same hash was never enough, but the same SIZE was routinely
   enough** — and the size is a weaker identity than a path. The audit of
   the durable mapping found 4120 of 4120 rows exact: the durable contract
   was already right. The leak was entirely in the discovery's pick.
2. **The two providers frame a path differently.** TorBox's file `name` is
   the whole torrent-relative path (root folder included); Real-Debrid's
   file `path` is relative to the root and the root is named separately.
   A shared "compare the paths" helper would have been wrong for one of
   them.
3. **The corpus names the PACK, not the file.** A multi-file release's
   filename is the pack's name, so the only per-file fact the discovery
   can state is the byte count. That is why the size match exists, and it
   is why "size alone" is not a bug in the discovery — it is a gap in
   what the corpus carries.
4. **The provider file id is stable.** Real-Debrid and TorBox both assign
   native file ids that survive a refresh and a reorder, and Rust binds the
   capability to that id. The index was never the identity; demoting it
   was already done.

## Disproved assumptions

- "The second-placement ensurer accepts a same-release file." It does
  not: it requires the provider file already mapped to our exact
  TorrentFile, and a replacement resource must expose that file by path and
  size.
- "A byte probe can promote an ambiguous file into authority." It cannot:
  byte health is recorded against the TorrentFile, and an ambiguous file
  never becomes a route.
- "The production mapping class is broken." 4120 exact, 50 unmapped
  extras, zero mismatches. Nothing needed repair.

## Wasted effort / cause

- Implemented the exact-file check for the Real-Debrid ROUTE as
  path + size, then found the production data: a season pack lists
  `Root/Season 1/Episode.mkv` while the corpus names the pack. The check
  would have broken the production RD route. The fix that survived is the
  one the facts support: the exact SIZE must agree, because the size is
  the per-file fact both sides state.
- Spent a cycle looking for the corpus's per-file path before noticing
  that the release's filename is the pack's. The absence is not a bug in
  the matcher; it is a gap in the corpus.

## Most useful test

`a single playable file is the file only when its size agrees`
(test/realdebrid-resolve.test.js). It pins the leak in one assertion: the
only video in a resource is not proof when its byte count contradicts the
discovery's.

## Lying / overconstraining test

`classifyCandidateToRdFile: single playable file → match` asserted the old
behaviour with a byte count that contradicted the candidate's. It passed
because it pinned the leak.

## Automation that should disappear

The Real-Debrid classification's three fallbacks (single playable file,
basename without size, size only) now have one authority: the exact size.
The basename and the "first video" branches are redundant with it and
should be deleted once the corpus carries per-file paths.

## Guidance change

- Release identity discovers provider resources. TorrentFile identity
  authorizes provider files and routes. The two statements must not be
  blurred: a route is authorized by the exact file, never by the release.
- A provider file id is an identity; a file INDEX is a position. The
  index is execution metadata and may not decide anything.
- The normalization that compares two framings of one logical file is
  provider-specific and minimal. It never folds case, never collapses
  interior path runs, and never accepts a basename as a path.

## Complexity to remove

- The discovery's release-level classification (basename, size-only, first
  video) exists because the corpus does not carry a per-file path. Give it
  one and the classification collapses into the exact comparison.
- The TorBox file-identity helper's size-only selection is the same gap in
  a different place.

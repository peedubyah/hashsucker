# Retrospective: the corpus knows the file

## Expected vs actual

Expected to find per-file paths in the corpus and wire them through. Found
that the corpus has never had one: 1 593 141 rows, every one of them
release-level, zero with a file-level index, and the only per-file fact
anywhere in the chain is the byte count the stremio stream hands over.

The premise was half right and half wrong, and the wrong half was the
important half: the corpus knows the RELEASE and the candidate file's byte
count, exactly as described — but it does not know the file's path, and it
never did. Nothing was being discarded; the information was never there.

## Surprises

1. **The `candidates` cache is 100% release-level too.** The per-file
   facts live in the stremio stream, in memory. So "the corpus knows the
   file" was never true of any persisted table.
2. **The 103 rows that DO carry a directory are scrape artifacts** —
   `xxxadulttorrent.org_[…]/…` — not torrent-relative paths. Had they
   been imported as paths, the corpus would have been full of fabricated
   canonical paths.
3. **A byte count is ambiguous for a tenth of the mapped provider
   files.** 424 of 4099 share their size with another file of the same
   resource — mostly the giant "IMDB合集" packs with 153 files of one
   size. This is the measurement that makes the whole slice concrete: a
   size-only match is not a file.
4. **The Real-Debrid path comparison had to be abandoned**, not
   tightened: the corpus names the PACK, the provider lists files by their
   path inside the torrent, and the two framings do not meet. The
   comparable per-file fact is the byte count.

## Disproved assumptions

- "The corpus discards path information during ingest." It does not
  discard anything: the parsers parse the release's NAME, and the source
  records carry the release's name. The per-file path was never available
  to discard.
- "Adding a path column will fill the corpus." It will not: the sources
  have nothing to put there. The column is plumbing for a source that can
  supply one — and its coverage today is honestly zero.
- "The TorBox helper's size-only match is a bug to remove." It is the
  best the data supports, and it already fails closed on a shared size.
  The fix is to give the discovery a path, not to tighten a predicate
  against facts that do not exist.

## Wasted effort / cause

- Implemented the exact path + size check for the Real-Debrid ROUTE and
  only then read the production provider files: a season pack lists
  `Root/Season 1/Episode.mkv` while the corpus names the pack. The check
  would have broken the production RD route. The production data has to
  come BEFORE the predicate.
- Hunted for a per-file path in the DMM fragments, the stremio streams
  and the cached release rows before accepting that the corpus's design is
  release-level. One query against `release_attributes` (the file-index
  distribution) would have said it immediately.

## Most useful test

`an exact corpus path selects that provider file, not another of the same
size` (test/corpus-file-identity.test.js). Two provider files with the
same name and the same size in different directories; the candidate's
path picks one, the size alone cannot.

## Lying / overconstraining test

The Real-Debrid classification tests asserted the release-level
behaviour ("a single playable file → match") with a byte count that
contradicted the candidate's. They pinned the leak.

## Automation that should disappear

The release-level classification's three fallbacks — single playable
file, basename without a size, size only — exist because the corpus has
no per-file path. With a path they collapse into the exact comparison,
and the whole "which file did the discovery mean" question is answered by
data instead of heuristics.

## Guidance change

- Release-level corpus records discover releases. Exact-file corpus
  records identify TorrentFiles. Pathless file evidence is weaker and must
  stay LABELLED as such: a byte count is not a path, and a candidate that
  has only one must not pretend otherwise.
- Measure what a data source actually holds before designing a predicate
  around it. The byte count was the strongest per-file fact the chain
  carried, and 10 % of the provider files show why that is not enough.

## Complexity to remove

- The TorBox file-identity helper's size-only selection, the Real-Debrid
  classification's three fallbacks, and the `skipSizeMatch` TV branch all
  exist because the corpus cannot name a file. One per-file path from a
  source that has one removes all three.

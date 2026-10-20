# Retrospective: one name to rule them all (the presentation identity)

## Expected vs actual

Expected to find a naming bug — a title that comes out wrong in one place
and right in another — and fix it. Found that the naming was not one
system at all: two resolvers with two source precedences, five trees with
three collection names and two sanitizers, one of them (the `.strm`) not
durable at all. The visible symptom (148 of 168 `.strm` names disagreeing
with the VFS path) was the small part; the larger part was that nothing
was authoritative, so every surface could answer "what is this called?"
differently and be right.

## Surprises

1. **The `.strm` publisher ignored the request's canonical title.** The
   VFS materializer preferred it; the `.strm` publisher led with the
   catalog. Two resolvers, opposite answers, for the same item — and the
   `.strm` is the name the consumer actually sees.
2. **The catalog's year was accepted raw in one resolver and rejected in
   the other.** `Number.isSafeInteger(meta.year)` is false for the string
   `"2016"`, so the VFS path dropped the year while the `.strm` path
   printed `"2016–2019"`. Every production directory name in that class
   carried a range.
3. **A TV handoff asked the MOVIE catalog.** The type check was
   `mediaType === 'series' ? 'series' : 'movie'`, and TV handoffs are
   labelled `'tv'`. The movie catalog answers a series id with a
   DIFFERENT film — which is why the production tree holds "Black Gunn
   (1972)" (a 2012 film) beside "The Last of Us" (the series) for one
   media id, and why a Deadwood EPISODE carries a movie artifact.
4. **`library_items.title` was the bare media id for every published
   item.** A republication without a title overwrote a real title with the
   placeholder, so the operator surface reported `tt0056801` for a
   published movie. The drift was not only in paths.
5. **The `.strm` writer raced on one temp file.** A fixed temp name means
   two concurrent publications of one item: the loser's rename fails with
   ENOENT. The duplicate-publication path made it reachable.
6. **The control-plane canonical path could MIGRATE.** `ensureCanonicalPath`
   rewrote it when the incoming path differed — and the incoming path
   differs whenever a republicublish carries a different request name. A
   published path moved because a request was worded differently.

## Disproved assumptions

- "The paths are durable, so they cannot drift." The VFS path was
  durable; the `.strm` path was recomputed on every publication. Half the
  contract was missing.
- "The drift is cosmetic." The `.strm` recomputation could write a second
  artifact for the same media (a duplicate Plex item), and the TV/movie
  catalog mix could name an episode after a different film.
- "The catalog is the best name source." No: it is enrichment. It
  answered with a different film for a series id, and it answers with a
  year RANGE. The request's canonical title is the identity authority, and
  the catalog fills only the gap the request left.
- "The filename is a good last resort." It is release grammar
  ("Deadwood (2004) S01E01 Deadwood (1080p BluRay x265 Silence)"), and it
  belongs to a release, not to an intent: a representation reselection
  would rename the item through it.
- "A published path can be corrected when the truth is known." The
  control-plane path did exactly that, and it moved a published path for a
  wording difference. A committed path may only be moved by an explicit
  migration, and there is no such product requirement today.

## Wasted effort / cause

- Spent the first third of the slice enumerating path builders with two
  parallel explore agents before reading a single line of the code
  myself. The inventory was right, but I could have found the five
  constructors in the first twenty minutes of grep. The agents were worth
  their cost for the CONSUMER side (Plex/Jellyfin/projection), not for the
  producers I could have read directly.
- Rewrote the resolver's year rule three times: request-only, then
  "always the catalog's year", then "the year follows the title's
  authority". The rule that survived is the one that makes the identity
  reconstructible with zero metadata calls — the criterion I should have
  used to choose it the first time.
- Chased the legacy `.strm` rename (underscore → space) as a feature to
  preserve. It is a rename of a consumer-visible path: the artifact the
  consumer already has should be ADOPTED where it is, and the identity
  should record that path.

## Most useful test

`the committed path survives a lost VFS row and a different representation`
(test/presentation-identity-integration.test.js). It deletes the VFS row and
republishes against a different TorrentFile with a different extension, and
asserts the path is the committed one. It pins the whole point of the
slice — that the presentation identity is not a function of the
representation — in one assertion, through the real materializer and the
real publisher.

## Lying / overconstraining test

- The existing `.strm` tests pinned the title SOURCE (the selection's
  release attributes) rather than the behaviour (the name is sanitized the
  same way the VFS path is). They had to change when the source became the
  request's canonical title — which is exactly the signal that they were
  pinning an implementation choice.
- Two materializer tests called `materializeVfsEntry` without awaiting it,
  which only worked because the TV path resolved the name synchronously.
  The moment the resolution became a metadata call with a fast path, the
  tests broke in a way that looked like a data bug and was a test bug.

## Automation that should disappear

The `.strm` publisher's per-publish filesystem sweep (the whole `Movies`
tree) is a price paid for the absence of a durable path. With the
committed identity the sweep is only needed once per item — for the
adoption of an artifact published under an older rule. When every item has
an identity, the sweep should go.

## Guidance change

- A consumer-visible name is a committed durable fact, not a derivation.
  Derive it once, at a commit point, from an explicit precedence; store
  it; consume it.
- Enrichment may fill a gap the explicit identity left. It may never add a
  fact to a name the request already gave, and it may never move a
  committed path.
- A path that is derived from the representation is not a presentation
  decision: the extension belongs to the representation, the PATH belongs
  to the intent. The path is committed with the extension it was
  published with.
- A consumer-visible artifact that already exists is ADOPTED, not renamed
  and not duplicated. The content identifies it.

## Complexity to remove

- The permanent-promotion tree and the download-staging tree still derive
  their names independently (`promotion/paths.js`, `download/paths.js`),
  with their own sanitizer and their own collection names (`Movies`,
  `movies`). They are not consumer-visible yet, so they were left alone —
  but they are the next two constructors that will drift.
- The control plane keeps two durable copies of the canonical path (the
  `library_paths` row and the discovery cache's VFS row) with different
  collision-suffix identity keys. The identity removed the rewrite, not
  the duplication.
EOF
echo written
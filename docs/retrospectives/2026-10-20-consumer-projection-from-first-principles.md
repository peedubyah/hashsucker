# Retrospective: consumer projection from first principles

## Expected vs actual

Expected to audit whether Plex is treated as authority, find a leak or
two, and fix them. Found that the question had never been asked in the
form it needed to be answered: not "does the consumer influence us?" but
"what SHOULD the consumer hold?" — a question nothing in the codebase
had ever stated. Without that, every surface derived its own expectation
from a different fragment, and "the consumer is missing our projection" and
"the media is missing" were the same sentence.

The leaks were real but small. The bigger finding was structural: the
desired projection had to be written down before anything could be
checked against it.

## Surprises

1. **Plex holds a DIFFERENT film under our item's title.** The Plex item
   for our `Movies/Casablanca/Casablanca.mkv` carries
   `imdb://tt0303279` — the file's embedded IMDb tag names another film.
   A guid-only matcher therefore reports a PRESENT projection as MISSING,
   and a repair would have chased it. The Part file — our path — is the
   matcher that cannot be wrong.
2. **The single "conflicted" item was an artefact of the same thing**: a
   second film with the same title, matched by the guid fallback. The
   conflict did not exist; the matcher invented it.
3. **The confirm could verify a Part it was never told about.** With no
   expected Part file, the ingest took the consumer's first Part and
   compared it against nothing, then reported `verified`. The strict
   check existed and the loose path was the one in production.
4. **"Not playback ready" was unreachable.** `String(null)` is the truthy
   string `"null"`, so the consumer's own "this item has no Part id yet"
   branch could never fire.
5. **A truncated Jellyfin list was recorded as absence** — 2000 movies is
   a cap, and everything beyond it looked "missing" to the reconciler,
   which feeds the retirement gate and the republication follow-up.
6. **Our own durable truth has two copies of the byte identity.** The VFS
   row and the active binding can name different TorrentFiles for one
   media intent (one production item does). The binding is the authority;
   the VFS row is what the byte path serves. Nothing reconciles them.

## Disproved assumptions

- "The consumer tells us whether our publication is visible." It tells us
  whether SOMETHING is visible. The verification needs our expected Part
  file, and without it the consumer's own ordering is the arbiter.
- "The IMDb guid identifies the consumer's item." It identifies the
  consumer's item BY THE FILE'S METADATA, which is exactly the metadata a
  mis-tagged release gets wrong.
- "The Part.file and the section-root derivation are the same thing."
  They were two derivations that agreed because the deployment is
  configured that way.
- "A consumer absence means the projection is missing." It means the
  consumer did not list it — which may be a lagging library, a truncated
  list, or a renamed file.
- "The reconciliation needs a new state model." It needed a comparison:
  the desired projection already existed, scattered.

## Wasted effort / cause

- Wrote the observer against the guid first and only found the metadata
  collision when the production audit disagreed with what Plex's API
  plainly showed. Matching by the durable path is both cheaper (one
  section fetch) and stricter, and it was the second attempt.
- Assumed the projection states needed a table. They did not: the states
  are a comparison, and the comparison belongs with the desired side.
- Tried to make the Jellyfin observer work before checking whether the
  appliance can talk to Jellyfin at all. It cannot (the key is rejected),
  so the live proof there is blocked by the environment and only the
  code path could be characterised.

## Most useful test

`the projection states are distinguished, and absence is never assumed`
(test/projection-contract.test.js). It pins the whole contract in one
place: aligned, missing, stale-path, stale-size, conflicted — and the
rule that an unobserved consumer is UNKNOWN, never absent.

## Lying / overconstraining test

The ingest's own test asserted `VERIFIED` for a confirm that passed no
expected Part file. That assertion was pinning the loose behaviour, and
it had to change when the verification became strict: without an expected
Part file there is nothing to verify against.

## Automation that should disappear

The Plex library is fetched twice for the same question: the consumer
adapter maps the library onto HashSucker's intents by guid, and the
projection observer reads the same list to report what the consumer
holds. One fetch, two views, would remove a duplicate request per
reconcile and the two matching rules that disagreed.

## Guidance change

- State the desired consumer projection before asking whether the
  consumer matches it. A consumer comparison without a stated desire is a
  comparison against two people's assumptions.
- Match a consumer item by its FILE, not by its metadata. The file is
  ours; the metadata is a release's (and can name the wrong film).
- A consumer's absence is not a media fact, and a consumer's metadata is
  not our identity. Both are observations; neither is authority.
- Verification needs an expectation. A confirm that is not told what to
  look for can only confirm that something exists.

## Complexity to remove

- The VFS row's `torrent_file_id` and `size` are a second copy of the
  byte identity, next to the binding's. The authority is the binding; the
  row is what the byte path serves; they can disagree, and one production
  item does.
- The Plex library is walked twice per reconcile, with two different
  matching rules (guid in the adapter, Part file in the observer).

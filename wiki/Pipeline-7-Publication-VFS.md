# Stage 7 — Publication / VFS

Publication turns an authoritative Binding into what consumers see.
`media-search/src/lib/vfs/materialize.js:materializeVfsEntry`
enforces `torrentFileId`, positive size, set internal path, and infoHash
match — then projects a stale handoff onto the active Binding (looked up
by library identity key) unless the reason is
`alternate-bounded-byte-validated`. Chain:
`ensureLibraryItem → ensureCanonicalPath → recordExposure → activateBinding`
(+ async RD realizer). `desiredState=='absent'` never resurrects.

## Canonical paths

Built by `control-plane/canonical-path.js:buildPreferredCanonicalPath`.
Concrete shapes:

- `Movies/Dune Part Two (2024)/Dune Part Two (2024).mkv`
- `TV/Dune/Season 01/Dune - S01E01.mkv`
- Collisions append a deterministic ` [hash10]` suffix.

Serving comments reference `/vfs/Movies/…` and `/TV Shows/<Series>/
Season 01/<Series> - S01E01.mkv`; confirm the mount mapping at the
deployment layer if paths mismatch (flagged UNKNOWN in inventory).

STRM files (separate, legacy-compatible): single resolver-URL line,
never overwritten, legacy-underscore renamed to canonical:

- `/strm/Movies/<Title> (<Year>)/<Title> (<Year>).strm`
- `/strm/TV Shows/<Title> (<Year>)/Season <NN>/<Title> (<Year>) - S<NN>E<NN>.strm`

(`STRM_OUTPUT_PATH`, default `/strm`.)

## Idempotency, rebind, staleness

- Identical identity → return existing (idempotent; covered by
  `vfs-*-idempotent` tests).
- Legacy `torrentFileId NULL` → `replaceVfs*Entry`, preserving
  canonical path (`legacy-supersede`).
- Authoritative different hash → `rejection-supersede` (stable alias).
- Same hash / different TF id or `releaseKey` mismatch → throw
  `Durable VFS entry conflicts…`.
- Unique-constraint races → `raceRecoverVfs*Entry`; binding activation
  retries on 30s backoff (`BINDING_ACTIVATION_RETRY_MS`) for stale or
  unbounded inventory. `.exe` converges to a video extension.

## Failure / reconciliation

Hydration without size skips Plex notify but keeps truth;
`authoritative-publication-incomplete` fires when a Binding's TF id
diverges from the handoff. Consumer reconcile diffs published vs
Plex/Jellyfin presence and unpublishes per retirement policy.

## Source references

- `media-search/src/lib/vfs/materialize.js`,
  `media-search/src/lib/control-plane/canonical-path.js`,
  `media-search/src/lib/requests/strm-publisher.js`,
  `media-search/src/lib/consumers/reconcile.js`

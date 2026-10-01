# Consumer Projection — Plex and Jellyfin

Consumers are views, never home. Library truth lives in control-plane;
everything here is projection + presence observation.

## Plex

- **Visibility:** library sections walked (`listPlexLibrary`), episode
  confirmation via `Media[].Part[]` (`ratingKey → consumerItemId`);
  reachability/token failures park as fail-closed UNKNOWN, never as absent.
- **Sessions:** active sessions feed temporary-publication retention
  (`plex-sessions.js`); playback sessions are the retention signal.
- **Refresh:** coalesced per `(sectionId, scanPath, collection)` with
  ~750ms debounce (`refresh-coalescer.js`); partial-refresh only, never
  escalated to full-section on failure. Season fan-out scope coalesces
  notify bursts.
- **Reconcile:** `runReconcile` diffs published items vs Plex/Jellyfin
  presence; unpublish/retire per policy; automatic retirement only when
  explicitly enabled (default OFF).
- **Why Plex IDs are not canonical:** ratingKey/Part/file are PMS-owned
  observations. The binding points at the TorrentFile; the Part is
  evidence the consumer sees it, nothing more.
- **HTPC relationship:** the production canary drives the official Plex
  HTPC for Linux on an isolated display/audio sink; PMS session state +
  HashSucker read attribution are authoritative, player UI is not.

## Jellyfin

- **Status:** refresh + STRM playback + listing integration implemented
  (`notifyJellyfin`, Jellyfin listing/refresh paths); sessions-based
  retention is Plex-only today (README limitation, honestly stated).
- **Contract:** same filesystem/library contract as Plex (scan published
  paths, play STRM/byte URLs); differences are capability gaps, not a
  second model.

## STRM compatibility note

STRM files are single resolver-URL lines for players that need them;
the authoritative path is always `/vfs`. Series STRM URLs must carry
`?season=&episode=`; Plex episode confirmation applies to series only.

## Source references

- `media-search/src/lib/consumers/`,
  `media-search/src/lib/plex/refresh-coalescer.js`,
  `media-search/src/lib/requests/strm-publisher.js`

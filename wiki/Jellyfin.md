# Jellyfin Integration

Honest status: Jellyfin is a supported consumer, not a proven one. It
gets the same filesystem/library contract as Plex; where behavior
differs, the difference is documented below rather than papered over.

## What exists

- Library refresh + listing integration (`consumers/jellyfin.js`,
  requires `JELLYFIN_URL` + `JELLYFIN_API_KEY`; unconfigured Jellyfin
  fails closed with `jellyfin-unconfigured`, never silent).
- STRM playback and refresh notifications (`jellyfin-notifier.js`,
  fire-and-forget like the Plex notifier).
- Presence in consumer reconcile (`reconcile.js` reads Jellyfin
  presence when configured).
- Same canonical paths, same VFS truth, same STRM contract
  (`?season=&episode=` required for series) as Plex.

## What is experimental or missing

- **Sessions-based retention is Plex-only.** Jellyfin playback does not
  currently feed temporary-publication retention. Temporary items
  exposed to Jellyfin-only households retire on policy timers, not on
  observed watching.
- No Jellyfin equivalent of the HTPC canary exists: there is no
  client-mediated playback proof path for Jellyfin. All playback
  acceptance evidence is Plex-shaped.
- Jellyfin-specific client quirks (transcode triggers, subtitle
  behavior, seek semantics) are unmapped. Do not assume Plex-verified
  behavior transfers.

## Contract (same as Plex unless noted)

Scan published paths, play STRM/byte URLs, accept refresh
notifications. Jellyfin is a projection surface with no identity
authority — identical to Plex in the architecture, behind in proof.

## Source references

- `media-search/src/lib/consumers/jellyfin.js`,
  `media-search/src/lib/requests/jellyfin-notifier.js`,
  `media-search/src/lib/consumers/reconcile.js`

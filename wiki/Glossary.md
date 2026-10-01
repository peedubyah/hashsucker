# Glossary

Terms mean exactly this. Loose usage has caused real bugs; the wiki
follows repo usage, and repo usage follows `docs/architecture.md`.

| Term | Meaning | Not |
|---|---|---|
| Release | A torrent, identified by `infoHash` | A file, a title, a provider listing |
| TorrentFile | Exact durable file: `infoHash` + canonical internal path + exact positive size | A file ordinal, a basename, a provider filename |
| ProviderPlacement | Durable route inventory: provider + account + resource ID | Bytes, availability, identity |
| ProviderFile | Current file observation inside a placement | A TorrentFile (until authoritatively mapped) |
| Binding | The authoritative choice of TorrentFile for a library item | A suggestion; bindings supersede, never edit in place |
| DeliveryCapability | Ephemeral Rust runtime state (signed URL, pool slot) | Anything persisted or used as identity |
| Media intent | Household desire for media, with request metadata | A download job |
| Publication | VFS row exposing a Binding to consumers | The media itself |
| Exposure | Mount/transport visibility record for a binding | Playback proof |
| VFS | Canonical-path namespace consumers scan | A filesystem with real files |
| Handoff | Exact minimal authority crossing into byte serving (identity, never bytes) | A download ticket |
| Candidate | A ranked discovery result keyed by `(infoHash, fileIndex)` | A TorrentFile |
| Representation | One exact playable form of a title (a TorrentFile in practice) | A quality label ("1080p") |
| Route | A currently usable path to exact bytes (provider + placement + capability, or local file) | A provider account |
| Consumer projection | Plex/Jellyfin-visible surface derived from library truth | Canonical state |
| Exact durable truth | The Binding + TorrentFile + placement set that republication reuses | A backup |
| Anticipation | Scheduled preparation of known future intent around release dates | Guessing taste |
| S-1 (ess-wun) | Per-request control projection Node sends Rust: one TorrentFile + serving coords | A cache, a session |

## Source references

- `docs/architecture.md` §2, `AGENTS.override.md` (Durable identity)

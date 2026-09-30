# Architecture

Stable model. Canonical: `docs/architecture.md`.

## Identity (exact, durable)

- **Release** = `infoHash`.
- **TorrentFile** = `infoHash` + canonical internal path + exact positive size.
  Same bytes are the same object across providers, restarts, refactors.
- **Binding** selects the authoritative TorrentFile for a library item.
- **ProviderPlacement** = durable route inventory (provider + account +
  resource). Routes are perishable; identity is not.
- **DeliveryCapability** = runtime-only (ephemeral signed URLs). Never
  persisted, never identity.

## Ownership split

- **Node** owns durable identity and control truth: discovery, ranking,
  binding, publication, VFS semantics. Only Node may select a different
  TorrentFile or Release, and only after classified provider exhaustion.
- **Rust** owns exact-byte execution: Range delivery, fixed-grid cache,
  coalescing, retry/`Retry-After`, same-TorrentFile provider recovery.
  Rust never picks another Release.
- **Consumers** (Plex, Jellyfin) are projections of the library.
- **Providers** (TorBox, Real-Debrid, local disk) are routes, not identity.

Byte path: client → edge (`:8080`) → Node `/vfs` selects TorrentFile →
Rust serves bytes (cache or provider) → stream back.

# Playback & Fulfillment Flow

How a request becomes bytes. Canonical mechanics:
`src/PRODUCTION-PLAYBACK-TESTING.md`, `docs/architecture.md`.

1. **Intent** — household media request arrives (explicit; no guessing).
2. **Discovery** — candidate releases found (live sources; no speculative
   background acquisition).
3. **Ranking/binding** — best candidate bound to an exact TorrentFile
   through authoritative provider placement/inventory.
4. **Publication** — library item published to VFS with TorrentFile truth.
5. **Playback** — Plex plays via the authoritative `/vfs` path; Rust
   delivers ranges from cache or provider.
6. **Recovery** — provider failure re-resolves the *same exact object*
   through another route. The library never changes; only the route does.

## What this deliberately avoids

- No download manager, no staging UX, no import queues.
- No background provider acquisition without measured demand evidence.
- No second ranking/identity/reuse implementations.

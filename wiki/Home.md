# HashSucker

**Household media that survives its suppliers.** HashSucker keeps a durable
record of what your household wants, which exact bytes satisfy it, and how
to play those bytes right now — so a dead provider, a dead disk, or a dead
media server is a routing event, never a lost library.

## Why it exists

Every other system binds your library to something that can die: a debrid
cache (Real-Debrid's May-2026 keyword filter wiped 50–70% of working
libraries overnight), a folder of files, or a per-play search with no
memory. HashSucker binds the library to **exact objects** and treats
providers, disks, and media servers as interchangeable routes.

## Current product bar

- Request → publication → real Plex playback → provider failover, proven
  with byte-verified evidence ([Reliability](Reliability)).
- Unattended canary fit for on-demand regression use; scheduled operation
  and outage recovery still unproven ([Current-State](Current-State)).

## How it's split

- **Node/media-search** owns durable truth: identity, binding, routes, library.
- **Rust/data-plane** executes bytes: Range delivery, cache, retry, recovery.
- **Plex/Jellyfin** are consumers — projections of the library, never its home.
- **Providers** (TorBox, Real-Debrid, local disk) are execution infrastructure,
  never media identity ([Architecture](Architecture)).

## Where to go deeper

- [Current-State](Current-State) — proven / partial / active / parked, honestly graded.
- [Product-Direction](Product-Direction) — household media continuity thesis.
- [Not-Building](Not-Building) — things deliberately refused.

> Projection note: this wiki summarizes. Repo docs are canonical —
> see [_Footer](_Footer) for the rule and canonical pointers.

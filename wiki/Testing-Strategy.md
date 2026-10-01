# Testing Strategy

What each layer proves — and the famous things each layer does *not* prove.

| Layer | Command / location | Proves | Does not prove |
|---|---|---|---|
| Unit/integration | `npm test` (`node --test`, 217 files in `media-search/test/`) | Module contracts: ranking determinism, identity rules, VFS idempotency, placement hygiene, timer behavior | Real providers, real PMS, real bytes |
| Fixture harnesses | `npm run test:stage3 [--ranking]`, `scripts/*canary*.mjs`, `data-plane/bench/*.mjs` | Deterministic pipelines, cold-start shapes, soak behavior | Production traffic shape |
| Production smoke | `npm run test:production-smoke` | Authenticated health, metadata, binding/VFS consistency, bounded byte probes | Client-mediated playback |
| Production playback | `npm run test:production-playback` | Real HTPC client launch, PMS session state, HashSucker read attribution | Scheduled cadence, outage continuity |
| Production acceptance | `npm run test:production-acceptance -- --fixture <name>` | Fresh-request fulfillment end to end per fixture | Anything beyond the fixture |
| Production canary | `npm run test:production-canary` (rotate + quiet) | Bounded rotation passes, invalid fixtures fail loud without touching prod | Lifecycle/chaos behavior (explicitly out of scope) |
| Lifecycle experiments | `node-active-restart`, `rust-active-restart` scripts | Restart/replay observations | Active outage continuity (stopped by instruction) |
| Importer bridge | `torbox-importer/tests/*.sh`, `handoff/movie-importer-bridge/tests/` | Queue/outbox/identity contracts | Production importer runs |

## Non-negotiable testing doctrines

- Screenshots are diagnostic-only, never acceptance.
- Manual repair is not recovery proof; corpus health is not fulfillment proof.
- Buffered-seek semantics: seeks are Range requests; acceptance requires
  PMS-observed session + HashSucker read attribution, not player UI state.
- Identity evidence: any byte claim must tie to an exact TorrentFile
  (infoHash + path + size); hashes without identity are trivia.

## Source references

- `src/PRODUCTION-PLAYBACK-TESTING.md` (authoritative mechanics),
  `media-search/package.json` (scripts), `media-search/test/`

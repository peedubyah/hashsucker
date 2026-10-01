# Observability

How to tell what happened, and what is still blind spots. Canonical
behavioral detail lives in code; this page maps the instruments.

## Correlation and identity in telemetry

- **Correlation IDs** (`corr_id`, monotonic counter in
  `data-plane/src/metrics.rs`): every `StageClock` gets one at
  construction. Join Rust stage reports to Node request logs with it.
- **`span_kind`** (default `"serve"`, settable): labels what a stage
  clock was doing. Filter slow snapshots by span before blaming providers.
- **TorrentFile IDs** (`tf_…`): the join key across Node bindings, Rust
  cache rows, stage reports, and canary evidence. Any byte claim without
  a TF id is trivia.
- **Per-TorrentFile retention**: bounded stage/telemetry retention keyed
  by TF exists specifically for production-canary correlation
  (`metrics.rs`).

## Stage reports and cache signals

Rust emits stage clocks (T0–T5 style progression), cache hit/miss,
provider and CDN attempt records, throttle age, and slow snapshots.
Slow-start snapshots are bounded and token-free by design — latency
evidence without secret leakage. Node operator surfaces mirror request,
worker, corpus, enrichment, and hygiene state (`/api/operator/*`,
`/api/metrics`, Rust `/metrics`); the TUI reads these endpoints only.

## Known observability gaps (honest)

- No end-to-end trace ID spanning Seerr webhook → binding → first byte;
  correlation is manual across request IDs, TF IDs, and corr_ids.
- Retained telemetry from earlier playback can pollute fresh first-read
  latency claims — baselines must be reset per fixture (the canary does;
  ad-hoc runs often don't).
- Provider-side visibility ends at our API calls: cache warmth, CDN
  behavior, and throttle causes are inferred, never observed directly.
- Jellyfin-side playback has no session-attribution equivalent of PMS
  sessions; Jellyfin retention signals are absent, not merely unlogged.

## Source references

- `data-plane/src/metrics.rs` (corr_id, span_kind, retention),
  `data-plane/src/serve.rs` (stage clocks, slow snapshots)
- `media-search/src/lib/operator/`, `media-search/src/lib/metrics.js`
- `media-search/src/server/app.js` (`/api/metrics`,
  `/api/search/cache/metrics`)

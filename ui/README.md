# Release discovery UI

React/Vite prototype for title search and release comparison.

## Current status

- Source remains a separate package, but the production `media-search` image builds and serves it on the same origin as `/api`.
- Vite development proxies `/api` to `http://localhost:3000`.
- Supports title search, media selection, release filtering/sorting, provider badges, and a release-details panel.
- Has no season/episode picker.
- “Request this release” opens details only; it does not submit `POST /api/requests` or poll request status.
- Current TypeScript metadata fields (`name`, `poster`, `description`) diverge from active backend fields (`title`, `posterUrl`, `overview`). The UI may render missing title/artwork data until roadmap Stage 1.
- React list identity uses `infoHash` only rather than exact `(infoHash,fileIndex)`.

Treat this as a prototype, not a deployed product UI.

## Development

Run the backend first from `../media-search`, then:

```sh
npm ci
npm test
npm run dev
```

Other scripts:

- `npm run build`
- `npm run lint`
- `npm run preview`
- `npm run test:watch`

## Contract boundary

All HTTP calls go through `../media-search/src/api/client.js` via the `@api` alias. The current API is documented in [`../media-search/src/api/API_CONTRACT.md`](../media-search/src/api/API_CONTRACT.md).

Until generated/shared types or contract tests exist, code is the final authority. Do not add another copied API narrative. When Stage 1 is implemented, update the backend contract, API client/JSDoc, TypeScript types, UI fixtures, and tests together.

## Product direction

The UI should eventually display separate lifecycle and evidence concepts:

- provider-independent release desirability;
- provider-specific cache prior;
- fresh confirmed provider state;
- placement/exposure/file mapping;
- canonical binding;
- catalog/playback health.

Do not label `cached` or `placed` as `playable`, and do not hide exact file identity behind a hash-only row key.

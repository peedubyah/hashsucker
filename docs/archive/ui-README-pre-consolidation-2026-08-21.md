# Release Discovery UI

> **ARCHIVED PRE-CONSOLIDATION COMPONENT README:** Non-authoritative. Use [`../../ui/README.md`](../../ui/README.md); API/type assumptions below are stale.

A React/Vite frontend for media release discovery. Built as a release intelligence interface, not a streaming catalog.

## Architecture

```
src/
├── App.tsx                  # Page routing (search ↔ releases)
├── main.tsx                 # Entry point
├── index.css                # Global dark theme, dense tables, badges
├── components/
│   ├── Badge.tsx            # Reusable badge (variants: default/success/warning/error/info/corpus/live)
│   ├── DataTable.tsx        # Generic sortable table with column definitions
│   ├── EmptyState.tsx       # Empty state placeholder
│   ├── ErrorState.tsx       # Error state with retry button
│   ├── FilterBar.tsx        # Inline filter controls (query, source, resolution, quality, cache)
│   ├── LoadingState.tsx     # Spinner + message
│   ├── MediaResults.tsx     # Title selection cards
│   ├── ProviderStatus.tsx   # Provider cache badges
│   ├── ReleaseDetails.tsx   # Full detail overlay
│   ├── ReleaseRow.tsx       # Expandable release row with inline details
│   └── SearchBar.tsx        # Query input
├── hooks/
│   ├── useReleaseFilters.ts # Sorting + filtering logic for releases
│   └── useSearch.ts         # Title search + media selection
├── pages/
│   ├── ReleasesPage.tsx     # Release discovery screen (filter + sort + list)
│   └── SearchPage.tsx       # Title search screen
├── types/
│   └── api.ts               # TypeScript interfaces derived from API_CONTRACT.md
├── utils/
│   └── format.ts            # Size, score, confidence formatting
└── test/
    ├── fixtures.ts          # Mock data for tests
    └── setup.ts             # Testing Library setup
```

## API Usage

All API calls go through the existing `media-search/src/api/client.js` (imported via `@api/client`). No duplicate fetch logic.

| Endpoint | Hook | Component |
|----------|------|-----------|
| `GET /api/search?q=` | `useSearch.search()` | `SearchPage` |
| `GET /api/search?type=&mediaId=` | `useSearch.selectMedia()` | `ReleasesPage` |
| `GET /api/media?type=&id=` | `useSearch.selectMedia()` | `ReleasesPage` (header) |

### API Fields Consumed

**Title Search:**
- `results[].id`, `type`, `name`, `poster`, `year`, `description`

**Release Search:**
- `intent` — media identity (used for display context)
- `results[]` — full `ReleaseResult` objects:
  - `infoHash`, `filename`, `size`, `resolution`, `quality`, `codec`, `hdr`, `audio`, `releaseGroup`
  - `confidence`, `score` — composite ranking
  - `components` — score breakdown (relevance, quality, releaseConfidence, identityConfidence, providerAvailability, episodeMatch)
  - `providers` — cache status per provider
  - `_source` — `"corpus"` (DMM) or `"live"` (Torrentio/Torznab)
- `total`, `timings.totalMs`, `stats.indexed`, `stats.total`

**Media Lookup:**
- `media.id`, `type`, `name`, `poster`, `year`, `description`

## Ranking Presentation

Score, confidence, and score components are all treated as optional. The UI renders whatever is present:

- **Score** — composite ranking (shown prominently)
- **Confidence** — parse confidence
- **Score bars** — visual breakdown of components (only shown if `components` is present)

No weights are hard-coded in the frontend. The ranking model can evolve without UI changes.

## Local Development

```bash
cd ui
npm install
npm run dev
```

The dev server proxies `/api` requests to `http://localhost:3000` (the media-search backend).

## Testing

```bash
npm test          # Run all tests
npm run test:watch
```

Tests cover:
- Filter state management (source, resolution, quality, cache, query)
- Sorting logic (score, size, filename, direction toggle)
- Component rendering (badges, release rows, filter controls)
- Empty/error/loading states

## Assumptions

1. **Backend contract** — All shapes derived from `media-search/src/api/API_CONTRACT.md`. If the backend changes, update `types/api.ts` first.
2. **Score/components optional** — Ranking data may be partial; UI degrades gracefully.
3. **Provider observations** — Keyed by provider name; may be empty for corpus results.
4. **Source distinction** — `corpus` = DMM (cached/indexed), `live` = real-time discovery.
5. **No auth** — Authentication is out of scope for this iteration.
6. **No request workflow** — The "Request this release" button is a placeholder for future import flow integration.
7. **Release table is the core screen** — All UX decisions prioritize release comparison over browsing.

## Visual Direction

- Dark theme with high-contrast text
- Dense information layout (not poster-card streaming UI)
- Monospace filenames for quick scanning
- Color-coded badges for providers, sources, quality attributes
- Minimal animation — fast interaction priority

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.

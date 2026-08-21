# Queue-driven movie request bridge

> **ARCHIVED BRIDGE DESIGN:** Superseded by the current importer captured under `torbox-importer/`. This document and patch record pre-deployment provenance, not current deployment state or authority.

## Authority and scope

The existing torbox-importer legacy movie path was live-proven through cached TorBox acquisition, confident movie classification, exact selected-file download, Radarr ManualImport, command and post-import verification, empty staging, provider cleanup, and job completion. The bridge did not replace or redesign `process-movie.sh`; it connected explicit `mediaType=movie`, `scope=movie` queue requests to that processor.

The complete proposed importer diff is in `torbox-importer-movie-bridge.patch`. It was prepared against fresh read-only copies from `/mnt/database/appdata/torbox-importer` on 2026-08-19. This archived design predates promotion of the current repository importer.

## Minimal importer changes

- `worker.sh` guards legacy unattended movie selection with a `NOT EXISTS` clause against any request matching `torbox_id` or `info_hash`. Truly unrequested movie jobs continue through legacy processing; request-linked movie jobs (whether active or failed) are strictly excluded from legacy crawler execution, eliminating double-processing races and ensuring failed validations never fall through to unintended downloads.
- `process-request.sh` explicitly permits only `tv/episode` and `movie/movie`, retains all other fail-closed behavior, validates movie classification against explicit request intent (failing closed to `/requests/failed/` on mismatch without retrying), dispatches classified movies to the existing `process-movie.sh`, synchronizes terminal job state, and settles the queue artifact.
- `validate-movie-request-match.sh` proves the requested movie ID matches the selected file's Radarr-authoritative TMDB classification before processing. `tmdb:<id>` compares directly; IMDb `tt...` resolves the classified TMDB movie through Radarr and compares exact IMDb ID. Ambiguous, unsupported, or mismatched IDs fail closed, and `process-request.sh` immediately marks the request `failed`, records the error, and settles to `/requests/failed/` without modifying jobs or downloading.
- `sync-movie-request-state.sh` maps only the exact linked processing movie request from terminal job `done`, `already_present`, or `failed`; non-terminal jobs and unrelated TV requests are untouched.
- `movie-cleanup-policy.sh` returns one of:
  - `delete-legacy`: no linked request, preserving proven legacy behavior;
  - `delete-request-owned`: a single linked processing movie request has `provider_created=1`;
  - `retain-preexisting`: linked requests exist without provider ownership, OR multiple active processing requests share the same job/hash (fail-safe retention to prevent breaking concurrent/subsequent requests).
- `process-movie.sh` consults that policy only at cleanup. Request-owned cleanup additionally re-verifies that the current TorBox ID hash equals the job/request hash. Pre-existing queued sources and multi-request sources are retained. Failed requests retain provider material through existing settlement behavior.

Already-present movies retain the established no-upgrade rule. The processor sets job `already_present`, the bridge propagates it to the request, and `settle-request.sh` deletes only a request-created source after its existing ownership/hash proof; pre-existing sources remain untouched.

## Automatic verification

Temporary importer tests use isolated SQLite databases and mocked processor boundaries. They verify:

- non-terminal jobs do not propagate;
- `done`, `already_present`, and `failed` propagate to only the exact movie/movie request;
- TV rows remain untouched and tv/season remains unsupported;
- movie requests invoke the movie processor and settle, never the TV processor;
- direct TMDB match, Radarr-resolved IMDb match, and mismatched movie rejection;
- legacy deletion, request-owned deletion, and pre-existing retention cleanup policies.

All modified Bash/POSIX shell scripts pass `bash -n`/`sh -n`. The test script passes locally. No environment files, API keys, databases, or secrets were copied.

## Deployment gate

Do not deploy the movie-enabled media-search build before this importer diff is reviewed, approved, installed, and its container restarted deliberately. After importer deployment, use a movie absent from Radarr for the first live acceptance test and verify browser queued -> processing -> done, Radarr import verification, request finalization, and ownership-aware cleanup.

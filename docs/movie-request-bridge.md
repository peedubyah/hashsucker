# Queue-driven movie request bridge

## Authority and scope

The existing torbox-importer legacy movie path is live-proven through cached TorBox acquisition, confident movie classification, exact selected-file download, Radarr ManualImport, command and post-import verification, empty staging, provider cleanup, and job completion. The bridge does not replace or redesign `process-movie.sh`; it connects explicit `mediaType=movie`, `scope=movie` queue requests to that processor.

The complete proposed importer diff is in `docs/torbox-importer-movie-bridge.patch`. It was prepared against fresh read-only copies from `/mnt/database/appdata/torbox-importer` on 2026-08-19. It has not been deployed to Tower.

## Minimal importer changes

- `process-request.sh` explicitly permits only `tv/episode` and `movie/movie`, retains all other fail-closed behavior, dispatches classified movies to the existing `process-movie.sh`, synchronizes terminal job state, and settles the queue artifact.
- `validate-movie-request-match.sh` proves the requested movie ID matches the selected file's Radarr-authoritative TMDB classification before processing. `tmdb:<id>` compares directly; IMDb `tt...` resolves the classified TMDB movie through Radarr and compares exact IMDb ID. Ambiguous, unsupported, or mismatched IDs fail closed.
- `sync-movie-request-state.sh` maps only the exact linked processing movie request from terminal job `done`, `already_present`, or `failed`; non-terminal jobs and unrelated TV requests are untouched.
- `movie-cleanup-policy.sh` returns one of:
  - `delete-legacy`: no linked request, preserving proven legacy behavior;
  - `delete-request-owned`: a linked processing movie request has `provider_created=1`;
  - `retain-preexisting`: linked requests exist but none owns the provider source.
- `process-movie.sh` consults that policy only at cleanup. Request-owned cleanup additionally re-verifies that the current TorBox ID hash equals the job/request hash. Pre-existing queued sources are retained. Failed requests retain provider material through existing settlement behavior.

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

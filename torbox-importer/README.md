# torbox-importer

Shell/SQLite executor for HashSucker’s **secondary physical-acquisition mode**.

## Current role

The importer consumes explicit JSON requests from the shared filesystem queue, acquires through TorBox, downloads selected provider files into local staging with `aria2c`, and submits `ManualImport` to Sonarr or Radarr.

Supported unattended intents:

- one explicit movie;
- exactly one explicit TV episode.

This is not the target provider-neutral virtual-library materializer. Do not generalize its staging/download/Arr lifecycle into primary virtual fulfillment.

## Authority and invariants

- `incoming/`, `processing/`, `done/`, and `failed/` JSON files are authoritative for physical request ownership and terminal movement.
- Claim uses atomic `mv -n`; publication uses temporary write plus rename.
- Provider resource ID and expected hash are reconciled before destructive or import actions.
- The importer maps request evidence to provider-authoritative files and validates the result independently.
- Movie IMDb/Radarr and episode/Sonarr identity are validated.
- Downloaded size and post-import state are verified.
- Ambiguity fails closed.
- Pre-existing/unowned provider resources are normally retained; cleanup must remain ownership-aware.
- Staging cleanup avoids recursive deletion.

Do not weaken these safeguards to compensate for discovery defects. Current request persistence still lacks `fileIndex`/`releaseKey`; that is roadmap Stage 1 work.

## Known liveness risk

The worker repeatedly resumes the first file in `processing` and handles at most one explicit request per loop. A permanently blocked/manual-selection request can starve later requests. Preserve crash recovery while adding attempts, typed errors, `nextAttemptAt`, backoff, fair eligible selection, terminal blocked/dead-letter state, and operator requeue.

A legacy no-request movie cleanup path can return `delete-legacy`; this policy requires explicit review. Default to retention when request ownership is not proven.

## Runtime

The image and root Compose both use this normal container lifecycle:

```text
/app/scripts/worker.sh
```

The worker initializes its SQLite database, resumes/claims requests, scans TorBox, dispatches jobs, and polls continuously. `TORBOX_API_URL` may override the API base for isolated testing; production uses the TorBox default.

Important paths:

- `TORBOX_DB=/config/state/torbox-importer.db`
- `/requests` — shared queue
- `/downloads` — local staging
- `/config` — persistent importer state

Required integrations are TorBox, Sonarr, and Radarr; see root `.env.example` and `compose.yaml` for current variable names.

## Validation

This tree was captured from the Tower deployment on 2026-08-19 after shell syntax, checksum, and movie-bridge validation. That statement is dated provenance, not proof of current live byte-for-byte parity. Historical bridge artifacts under `handoff/` and `docs/archive/` are non-authoritative.

Current project direction and safeguards are in [`../HANDOFF.md`](../HANDOFF.md).

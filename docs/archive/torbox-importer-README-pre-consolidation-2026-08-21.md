# torbox-importer

> **ARCHIVED PRE-CONSOLIDATION COMPONENT README:** Non-authoritative. Use [`../../torbox-importer/README.md`](../../torbox-importer/README.md); live-parity claims below are dated provenance only.

Canonical importer source captured from the live Tower deployment on 2026-08-19.

## Status

This tree is byte-for-byte aligned with the current live importer source captured from:

`/mnt/database/appdata/torbox-importer`

Historical `.pre-*`, `.before-*`, backup directories, runtime state, databases, and live
credentials were intentionally not copied.

The previous `handoff/movie-importer-bridge/` tree is retained temporarily as historical
bridge/provenance material. It is not the long-term canonical importer location.

## Validation

Before this tree was promoted:

- all shell scripts passed `bash -n`
- all shell scripts passed `sh -n`
- live `scripts/` and this tree matched by rsync checksum comparison
- top-level runtime files matched by checksum
- `tests/movie-request-bridge.sh` passed
- root `npm test` passed 16/16

Do not delete the historical handoff tree until the unified importer layout and regression
tests are established.

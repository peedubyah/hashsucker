# Structured importer progress proposal

> **ARCHIVED PROPOSAL:** Not implemented and not current status behavior. Current project direction is in [`../../HANDOFF.md`](../../HANDOFF.md); this file remains useful only as design evidence for physical-import progress ownership.

Status richer than queued/processing/done/failed must be authored by torbox-importer. media-search must not infer it from logs, stdout, SQLite, torrent contents, or filesystem side effects.

## Recommended v1 extension

Keep the four queue directories as the authoritative command transport and coarse fallback lifecycle. Add an optional shared directory:

```text
/requests/status/<requestId>.json
```

torbox-importer would write each status document atomically using a temporary file followed by rename. It owns all writes and removes or retains documents according to an explicitly documented retention policy. media-search reads the document only through the existing importer-client abstraction; a future read-only HTTP importer implementation can return the same domain object.

Proposed schema for importer discussion—not implemented or promised yet:

```json
{
  "version": 1,
  "requestId": "uuid",
  "state": "processing",
  "stage": "downloading",
  "message": "Downloading selected episode",
  "currentFile": "optional display-safe filename",
  "bytesDownloaded": 123,
  "bytesTotal": 456,
  "updatedAt": "2026-08-19T12:34:56.000Z"
}
```

Suggested `state` values remain `queued`, `processing`, `done`, and `failed`. Suggested optional `stage` values are `acquiring`, `inspecting`, `selecting`, `downloading`, `importing`, `verifying`, and `cleaning`. The importer must define transition semantics and whether fields can be null.

## Safety and compatibility

- If the structured document is missing, stale, invalid, or unsupported, media-search falls back to spool location.
- `requestId` must match the requested UUID and the filename.
- Reject unknown schema versions until supported deliberately.
- Enforce a small maximum file size and validate all fields before returning browser-safe data.
- `message` and `currentFile` are untrusted display text and must be rendered with `textContent`.
- Byte counts must be non-negative finite integers; never fabricate percentages when totals are absent.
- Status documents must contain no provider credentials, filesystem secrets, or importer database data.
- media-search remains read-only for status and never changes importer lifecycle.

## Alternative

A small read-only importer HTTP status API could implement the same importer-client result later. It adds availability/authentication/versioning concerns and is not justified while the shared spool is already mounted. The atomic shared status document is therefore the smallest compatible first extension, but implementation requires coordinated torbox-importer work.

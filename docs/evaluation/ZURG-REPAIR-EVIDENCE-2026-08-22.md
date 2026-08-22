# Zurg repair, persistence, and exposure evidence

**Study date:** 2026-08-22  
**Scope:** Current public Zurg `v1.0.0` Linux amd64 release.  
**Purpose:** Bound HashSucker's Real-Debrid/Zurg integration to public documentation and direct static evidence. This is not a live-runtime certification.

## Artifacts and method

- Release: <https://github.com/debridmediamanager/zurg-public/releases/tag/v1.0.0>
- Release timestamp: `2026-08-09T23:14:01Z`
- Archive: `zurg-v1.0.0-linux-amd64.zip`
- Published and locally verified archive SHA-256: `2c31fa4bb8e99516d4f3ea97ef9a595b3adeff0d1923886182aef1c8cdc96cf9`
- Extracted ELF SHA-256: `9c16eba794aec71a9f43dc6471c068fb8f2416b9f7ada063761d54dbe2688065`
- Recovered build metadata: module `github.com/debridmediamanager/zurg` `v1.0.0`, Go `1.24.2`, VCS revision `f2f88e3af4421bdea67ea57c9464a8d4926ca557`, unmodified build.
- Wiki repository revision: `86c3be0b8d557ae89b17d7c588625f9cd7a01601`
- Public documentation reviewed: `Repair.md`, `zurgtorrent-v0.10.md`, `History.md`, and `Config.md` from <https://github.com/debridmediamanager/zurg-public/wiki>.
- Static inspection: ELF metadata, printable strings, recovered Go symbols/types, and targeted x86-64 call-graph disassembly. Zurg was not executed and no Real-Debrid credentials were used.

The public repository does not provide the current Go implementation source. Recovered names and direct calls establish structure and persisted fields, but branch-level outcomes are reported only where documentation or explicit embedded transition messages corroborate them.

## Evidence matrix

| Requested behavior | Direct evidence | Supported conclusion | Confidence / unresolved boundary |
|---|---|---|---|
| Same-hash re-add | Wiki `zurgtorrent-v0.10.md` says whole and partial repair create new same-hash torrents. The binary's `repairByReinserting` calls `buildOriginalSelection` then `redownloadTorrent`; `redownloadTorrent` calls `AddMagnetHash`, `SelectTorrentFiles`, and `GetTorrentInfo`. | Repair can add the same magnet/hash again. A repair resource ID is not stable identity. | High for re-add; live API race/idempotency behavior was not exercised. |
| File selection / reselection | `buildOriginalSelection`, `buildAllFilesSelection`, `getFileIDsForBatch`, and individual-file repair all convert embedded Real-Debrid file IDs to selection strings. The persisted file type contains opaque RD `id`, `path`, `bytes`, and `selected` fields. | Whole reinsertion reuses the recorded original selected-file set. Partial repair can select individual or batched broken-file IDs. Provider file IDs are opaque Zurg/RD metadata, not corpus indexes. | High for strategy. Continuity of an RD file ID across distinct same-hash resources is not established. |
| Full-repair replacement | Wiki: a whole redownload replaces the old torrent only after all links verify. Binary: `handleCompletedRedownload` checks brokenness, can delete by ID, and transitions to OK; transition messages explicitly distinguish failed and completed repair. | Successful verified whole repair may replace the old RD torrent. HashSucker must re-observe placement/inventory rather than assume the original resource survives. | High for replacement possibility; exact delete/update ordering needs runtime observation. |
| Partial-repair cleanup | Wiki: temporary same-hash torrents are deleted after the fixed link is saved to `.zurgtorrent`. Binary strings explicitly say repair torrents from reinsert, batch, and archive flows “will be deleted once it is completed”; `repairByIndividualFiles` and batch helpers call `DeleteByID` and `SaveToZurgTorrent`. | A visible Zurg file can depend on a persisted link while its temporary RD repair resource no longer exists. | High. This directly forbids deriving Zurg exposure identity from a supposedly immutable repair resource ID. |
| Torrent repair states | Recovered state constants: `ok_torrent`, `broken_torrent`, `under_repair_torrent`; file constants: `ok_file`, `broken_file`, `deleted_file`. Embedded messages show `ok_torrent → broken_torrent` when enqueued/manual, `under_repair_torrent → broken_torrent` on cleanup/no seeders/stuck/no active downloads, and broken file → OK after link assignment/verification/repair. `transitionToOK` updates VFS/STRM and saves metadata. | Zurg has an independent torrent/file repair state machine. Placement, metadata state, and mount visibility must remain separate HashSucker observations. | High for vocabulary and listed transitions. The complete branch graph and timings were not dynamically validated. |
| `.zurgtorrent` persistence | Wiki calls the file Zurg's source of truth. `SaveToZurgTorrent` uses custom JSON encoding and `os.WriteFile`; `readZurgTorrent` opens and decodes it; `loadCachedTorrents` enumerates, reads, migrates/renames, assigns directories, and recreates STRM state. Recovered wire fields include `Hash`, `SelectedFiles`, `State`, `StateWhen`, `DownloadedIDs`, `IDsToDelete`, `Rename`, `Unfixable`, and per-file `File`, `Link`, `State`, and `Rename`. | `.zurgtorrent` is Zurg's persisted local source of truth for names, selected files, links, and repair state. It is stronger lifecycle evidence than a generic mount lookup, but it is not provider-authoritative RD placement inventory and not exposure proof. | High for schema/persistence. Write atomicity and crash durability are not established: the inspected path calls `os.WriteFile`, not an observed temp-file rename. |
| External RD deletion | Wiki: deleting a torrent from RD does not delete its `.zurgtorrent`, but it disappears from the normal mount. Dump-folder entries remain exposed and are not repaired. Binary has `CheckDeletedStatus` and persists its result. | Metadata presence must not be treated as current normal-mount visibility or current RD placement. Dump metadata has different exposure/repair semantics. | High from documentation; refresh latency remains untested. |
| Restart behavior | `loadCachedTorrents` loads persisted metadata and rebuilds directory/STRM state. `ValidateStuckTorrentsOnStartup` inspects `under_repair_torrent`; embedded messages say it keeps state with active downloads and resets stale entries with no active downloads to `broken_torrent`, then saves. Cleanup helpers track persisted `DownloadedIDs`/`IDsToDelete`. | Restart restores Zurg-local metadata and explicitly validates stale repair state. A restart is not proof of immediate exposure or provider readiness. | Medium-high. Crash points, exact thresholds, and restart during every repair branch require a controlled runtime experiment. |
| Rename/path updates | `RenameTorrent` rekeys internal maps, saves `.zurgtorrent`, invalidates VFS rename caches, invokes directory side effects, removes old STRM paths, and creates new ones. `RenameFile` saves metadata, updates STRM files, invalidates rclone VFS paths/directories, and triggers library side effects. Dump-folder hierarchy is documented as part of WebDAV layout. | Zurg paths can change because of Zurg rename/config/dump hierarchy even when the hash does not. A Zurg path is exposure location, never canonical media identity. | High for explicit rename flow. Behavior after arbitrary config-rule changes and concurrent playback remains untested. |

## Integration consequences

1. Preserve exact HashSucker release identity as `(infoHash, fileIndex)`. Neither a Real-Debrid torrent ID, an RD/Zurg file ID, a `.zurgtorrent` filename, nor a mount path is candidate identity.
2. Treat Real-Debrid placement resource IDs as observations that may change after repair. Never rewrite canonical identity when they change.
3. Keep provider placement/readiness, provider-authoritative file inventory, Zurg metadata state, exact mount exposure, canonical binding, cataloging, and playback independent.
4. Keep the current mount observer exact and read-only. A missing path is exposure absence only; it is not authoritative provider removal and not an `uncached` claim.
5. Add only a separate, explicit-path, read-only `.zurgtorrent` observer. It may report account/instance-scoped torrent-level Zurg state and sanitized per-file metadata. It must not expose saved links, map keys, or temporary/deletion RD IDs and must not implement placement, removal, or mount-exposure authority. Current tests use a synthetic fixture reconstructed from static schema evidence; keep the observer unwired until a redacted real-v1 fixture validates compatibility.
6. Do not infer the `.zurgtorrent` filename from hash or mutable display name. The inspected binary sanitizes a Zurg key, and no stable public filename-by-hash contract was found. Callers must supply an already observed metadata-relative path.
7. Treat malformed or hash-mismatched metadata as typed invalid evidence. Treat missing metadata as missing metadata only.
8. Do not automate Zurg repair, RD replacement/deletion, or path rebinding from this study. Those operations still require a fixture-verified API/runtime boundary and ownership-safe policy.

## Remaining controlled experiment

Before declaring the Stage 6 vertical slice operational, use an isolated Real-Debrid account and pinned Zurg/rclone versions to record:

1. initial RD resource/file IDs, `.zurgtorrent` contents, WebDAV paths, and mounted paths;
2. external deletion of the normal RD torrent and refresh-to-disappearance latency;
3. access-triggered and periodic repair for whole and single-file failures;
4. resource/file IDs before and after verified whole replacement;
5. temporary partial-repair resource creation/deletion and persisted-link continuity;
6. restart before selection, during download, after link persistence, and before cleanup;
7. torrent/file rename plus configuration-driven organization changes;
8. rclone VFS and catalog behavior during disappearance/reappearance.

Until that experiment exists, exact timing, crash atomicity, resource-ID continuity, mount-cache behavior, catalog continuity, and real-fixture schema compatibility remain unknown. The current path observers reject final symlinks but provide lexical root containment only; deployment must expose dedicated read-only roots rather than hostile, symlink-writable trees. Stage 3 remains open pending the independent real-DMM-corpus retrieval experiment.

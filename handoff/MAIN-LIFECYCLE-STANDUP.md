# MAIN LIFECYCLE STANDUP — CachyOS

> **Historical evidence only:** use [`CURRENT.md`](CURRENT.md) for the active
> state and next action.

**main:** `359005068a222f3e75e40fe71628da74bf305861`
**date:** 2026-09-06
**host:** CachyOS Linux (192.168.2.4)

---

## BOUNDARY 0: Baseline State (PRE-CLEAN)

### CLEANED:
- **VFS entry**: `vfs_movie_entries` row for `media_id=tt1825683` — DELETED
  - canonical_path was `Movies/Black Panther (2018)/Black Panther (2018).mkv`
  - WebDAV now returns `404 PATH_NOT_FOUND`
  - rclone mount no longer shows Black Panther

- **Plex**: `ratingKey=229` — DELETED via API
  - Library scan now shows 12 movies, Black Panther absent
  - API `/library/metadata/229` returns `404 Not Found`

### PRESERVED (durable identity):
- `torrent_files` → `tf_5de34a78-0a1a-410b-8de5-76ded2680e7d`
  - info_hash: `06bfe49fdc99ad0c6fef1f761382a8181490e456`
  - size: 34,319,716,114 bytes
  - internal_path: `Black.Panther.2018.2160p.DV.HDR10Plus.Ai-Enhanced.HEVC.TrueHD.Atmos.7...`

- `provider_placements` (by info_hash):
  - torbox: `pl_a5e7d71d...` state=ready, ownership=owned
  - realdebrid: `pl_7122445e...` state=ready, ownership=external

- `provider_files` (by torrent_file_id):
  - torbox file: `pf_43977df9...` present=1, mapped
  - RD file: `pf_942340b4...` present=1, selected=1, mapped

- `library_items` → `li_9be2222da50d81e69bfe410`
  - media_id=tt1825683, media_type=movie, desired_state=present

- `library_paths` → `lp_1b0f2fd5...`
  - canonical_path: `Movies/tt1825683/tt1825683.mkv` (WRONG PATH — moonshot fixture)
  - preferred_path: `Movies/tt1825683/tt1825683.mkv`
  - active=1

- `media_requests`: 2 rows for tt1825683, status=completed

---

## BOUNDARY 1: POST /api/media-request (real front door)

**STATUS:** IN PROGRESS

**ENDPOINT:** `POST http://127.0.0.1:3000/api/media-request`
**LIFECYCLE FLOW:**
```
POST /api/media-request { mediaId, mediaType }
  → searchByMedia()
  → ranked candidates persisted to candidates table
  → best candidate selected
  → Release identity created
  → TorrentFile identity established
  → ProviderPlacement/ProviderFile mapping
  → MediaBinding (if applicable)
  → VFS publication (via materializeVfsEntry)
  → WebDAV visibility
```

**INPUT:**
```json
{
  "mediaId": "tt1825683",
  "mediaType": "movie",
  "persist": true
}
```

**ACTION:** Issue the request now.

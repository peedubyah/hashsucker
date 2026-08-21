# DMM Hashlist Source Architecture

> **ARCHIVED SOURCE SNAPSHOT:** Wrapper and corpus-size claims are superseded by the [2026-08-21 audit](../audit/8-21-audit.md). Current sampled fragments used iframe/hash; reverify upstream format and licensing before relying on this file.

## Canonical Source

**URL:** https://hashlists.debridmediamanager.com
**Repository:** github.com/debridmediamanager/hashlists
**License:** Public domain (user-contributed data)

## Distribution Format

### Transport
- **Protocol:** HTTPS via GitHub Pages
- **Format:** HTML wrapper with embedded LZString-compressed JSON
- **Update cadence:** Every 6 hours
- **Fragment model:** One HTML page per hash fragment (~750KB each)

### HTML Structure
```html
<!DOCTYPE html>
<html>
<head><title>Debrid Media Manager Hash List</title></head>
<body>
  <script>
    // LZString decompresses to JSON array/object
    var payload = decompressFromEncodedURIComponent('ENCODED_PAYLOAD_HERE');
  </script>
</body>
</html>
```

### Payload Format (after LZString decompression)
```json
{
  "torrents": [
    {
      "hash": "abcdef0123456789abcdef0123456789abcdef01",
      "filename": "Movie.2024.1080p.BluRay.x264-Group.mkv",
      "bytes": 2147483648
    },
    ...
  ]
}
```

### Per-Record Fields
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `hash` | string | Yes | 40-char hex infoHash |
| `filename` | string | Yes | Release filename |
| `bytes` | number | No | File size in bytes |

**DMM does NOT provide:**
- Media identity (no imdb, tmdb)
- Source/provenance beyond filename
- Seeders/leechers
- Magnet URI
- fileIndex (single-file torrents only)

## Fragment Listing

### GitHub API Endpoint
```
GET https://api.github.com/repos/debridmediamanager/hashlists/contents
```

### Response Filter
- Files ending in `.html` are hash fragments
- Each fragment contains compressed payload for ~500-1000 torrents
- 200-300 fragments total in active use

### Rate Limits
- GitHub API: 60 requests/hour (unauthenticated)
- GitHub API: 5000 requests/hour (authenticated)
- Raw.githubusercontent.com: no documented limit

## Ingestion Pipeline Architecture

### Components

```
DMMIngestionRunner (orchestrator)
    |
    +-- DMMHashListSource (transport)
    |       |-- listFragments() -> GitHub API
    |       |-- fetchFragment(url) -> raw.githubusercontent.com
    |
    +-- extractPayload(html) -> LZString compressed string
    +-- decodeDmmPayload(compressed) -> JSON string
    +-- streamParseDMM(json) -> generator of records
    +-- transformDMMRecord(record) -> HashSucker entry
    |
    +-- IngestionMetrics (tracking)
    +-- ingestCandidates() (boundary write)
```

### Memory Efficiency
1. **Streaming parser:** Yields records one at a time, never loads full corpus
2. **Batch commits:** Every 1000 records, flush to SQLite
3. **Single fragment:** Only one HTML payload in memory at a time
4. **Generator pattern:** `function*` for lazy evaluation

### Batch Flow
```
Fragment HTML (750KB)
    |
    v
LZString decode (~1MB JSON)
    |
    v
Stream parse (yields ~1000 records)
    |
    v
Batch buffer (1000 records)
    |
    v
ingestCandidates() boundary
    |
    v
SQLite commit (WAL mode)
```

## Metrics

| Metric | Description |
|--------|-------------|
| `recordsProcessed` | Total records parsed from payloads |
| `recordsInserted` | New candidates added to cache |
| `recordsUpdated` | Existing candidates (duplicates) |
| `recordsFailed` | Invalid records (bad hash/missing filename) |
| `fragmentsProcessed` | HTML fragments successfully ingested |
| `durationMs` | Total wall-clock time |
| `recordsPerSecond` | Ingestion throughput |
| `estimatedGrowthMB` | Projected SQLite size increase |
| `errorCount` | Non-fatal errors encountered |

### Estimated Database Growth
- Average record: ~200 bytes in SQLite
- 1 million records: ~200 MB
- Full DMM corpus: ~50-100 million records = 10-20 GB

## Error Handling

### Parser Failures
- Invalid hash format: Skip record, increment `recordsFailed`
- Missing filename: Skip record, increment `recordsFailed`
- Malformed JSON: Skip record, continue
- LZString decode failure: Skip fragment, log error

### Network Failures
- GitHub API failure: Abort run, preserve partial progress
- Fragment fetch failure: Skip fragment, continue to next
- Rate limit exceeded: Wait for retry-after header

### Cache Failures
- SQLite write failure: Batch marked as failed
- Cache closed mid-ingestion: Results preserved up to last batch

## Transport Abstraction

### Interface
```javascript
class HashListSource {
  async listFragments();  // [{ url, name, size }]
  async fetchFragment(url);  // HTML string
}
```

### Implementations
| Source | Transport | Use Case |
|--------|-----------|----------|
| `DMMHashListSource` | GitHub API + raw.githubusercontent.com | Production |
| `MockHashListSource` | In-memory array | Testing |
| Future: CDNSource | Direct CDN URL | High-volume ingestion |

## Security Considerations

- No authentication required for public data
- User-Agent header identifies client
- GitHub token optional (increases rate limit)
- No credentials stored or logged
- HTTPS enforced for all requests

## Future Enhancements

1. **Incremental sync:** Track last-modified timestamps, skip unchanged fragments
2. **Parallel fragments:** Process multiple fragments concurrently (bounded)
3. **Checkpointing:** Resume interrupted ingestion from last batch
4. **CDN direct:** Bypass GitHub Pages for direct LZString payload hosting
5. **Torrent metadata:** Extract additional fields from .torrent files (if available)

## Reference Implementation

- Ingestion runner: `src/lib/discovery/dmm-ingestion-runner.js`
- LZString decoder: `src/lib/discovery/lz-string.js`
- DMM adapter: `src/lib/discovery/adapters/dmm.js`
- Tests: `test/dmm-ingestion.test.js`

## Sources

- github.com/debridmediamanager/hashlists
- github.com/mhdzumair/MediaFusion/blob/main/python-deprecated/workers/scrapers/dmm_hashlist.com
- github.com/pierrost/lz-string

# First-Boot Deployment Verification

Minimal checklist for verifying a fresh deployment. Run after `docker compose up -d --build`.

## Quick run

```bash
scripts/smoke-test.sh            # full cycle: up → verify → down
SKIP_BUILD=1 scripts/smoke-test.sh   # skip compose build (use existing images)
scripts/smoke-test.sh --no-down  # leave stack running after verify
```

## Checks

| # | Check | How verified |
|---|-------|--------------|
| 1 | **Media-search health endpoint** | `GET /health` → 200 `{ ok: true }` |
| 2 | **UI static serving** | `GET /` → 200 HTML with `#root` (Vite build) |
| 3 | **Importer starts** | `docker logs torbox-importer` shows `starting TorBox importer` |
| 4 | **Shared request queue permissions** | media-search writes to `/requests/incoming/`, torbox-importer reads it |
| 5 | **SQLite: importer schema** | `sqlite3 $TORBOX_DB` → `requests` table exists (db-init.sh) |
| 6 | **SQLite: discovery cache** | node:sqlite opens `$DISCOVERY_DB`, `PRAGMA integrity_check` passes |
| 7 | **Env: media-search** | `TORBOX_API_KEY`, `REQUESTS_ROOT`, `DISCOVERY_DB`, `CONTROL_PLANE_DB` present |
| 8 | **Env: torbox-importer** | `TORBOX_API_KEY`, `RADARR_URL`, `TORBOX_DB` present |

## Manual checks (if smoke test unavailable)

```bash
# 1. Health
curl -fsS http://127.0.0.1:3000/health

# 2. UI
curl -fsS http://127.0.0.1:3000/ | grep 'id="root"'

# 3. Importer logs
docker compose logs torbox-importer | grep 'starting TorBox importer'

# 4. Queue (run from one container, verify from the other)
docker compose exec media-search sh -c 'echo test > /requests/incoming/probe.txt'
docker compose exec torbox-importer sh -c 'cat /requests/incoming/probe.txt'

# 5. SQLite importer
docker compose exec torbox-importer sh -c 'sqlite3 "$TORBOX_DB" ".tables"'

# 6. SQLite discovery
docker compose exec media-search node --input-type=module -e "
import { DatabaseSync } from 'node:sqlite';
new DatabaseSync(process.env.DISCOVERY_DB).exec('PRAGMA integrity_check');
"

# 7. Env media-search
docker compose exec media-search node -e "console.log(process.env.TORBOX_API_KEY ? 'ok' : 'MISSING')"

# 8. Env importer
docker compose exec torbox-importer sh -c 'echo "$TORBOX_API_KEY"'
```

## Exit codes

- `0` — all checks passed
- `1` ≥ one check failed (details printed in summary)

## Constraints

- Does not modify the stack or its data (read-only probes).
- Does not test runtime discovery, provider APIs, or arr integrations (out of scope for first-boot).
- Assumes `.env` is configured per `.env.example`.

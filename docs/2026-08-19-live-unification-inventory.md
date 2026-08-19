# Live Unification Inventory — 2026-08-19

## Status

Read-only pre-unification inventory and planning notes.

### Authority rules

- Part I — Observed Facts: evidence from repo/live inspection.
- Part II — Recommendations / Inferences: prior agent proposals only.
- Part II is NOT approved architecture.
- Re-verify any observed fact before relying on it for destructive or migration work.
- `AGENTS.md` and current repository source override this document where they conflict.

### Known corrections

- Movie E2E acceptance has been completed successfully.
- Post-bridge hardening was backported and checkpointed at commit `f385cb2...`.
- Therefore claims that the live importer is currently ahead of repo must be re-verified.

Part I — Observed Facts (Inventory)
1. Current runtime boundaries
Two separate runtime services, both live on Tower:

Container	Image	User	Network	Port
media-search	media-search:local	node (UID 1000) + supplementary GID 100	bridge	3000→3000
torbox-importer	torbox-importer:local	99:100 (nobody:users)	isolated bridge	none
media-search is a Node.js 24 Alpine container built from a src-only multi-file app. No build/compile step (plain ESM). Runs node src/server/index.js. Healthy (GET /health → 200).

torbox-importer is a POSIX/bash shell app running on Alpine (bash, curl, jq, aria2c, sqlite3). Started as CMD ["/config/scripts/worker.sh"]. No HTTP port. No healthcheck. Its entire state lives in the appdata bind-mount.

No shared network. The two containers do not communicate over HTTP. The sole IPC channel is the shared filesystem queue.

2. Compose projects / launch mechanism
media-search: Compose project media-search-dev, config at /mnt/database/appdata/media-search-dev/compose.yaml, managed by Unraid Compose Manager. The project working directory is the Unraid appdata directory (files rsynced there via deploy.sh).

torbox-importer: Compose project torbox-importer, config at /boot/config/plugins/compose.manager/projects/torbox-importer/compose.yaml. Secrets .env is at /mnt/database/appdata/torbox-importer/.env (root-readable only). Build context is /mnt/database/appdata/torbox-importer.

Neither deployment has a git repository on Tower. Changes are deployed by rsync (deploy.sh) or manual file placement.

3. Volume mounts and shared paths
Host path	media-search	torbox-importer	Purpose
/mnt/database/appdata/media-request-queue	/requests (rw)	/requests (rw)	Shared durable request queue
/mnt/database/appdata/torbox-importer	—	config (rw)	Importer state, scripts, DB, env
/mnt/user/Downloads	—	/downloads (rw)	Staging area for downloaded files
Queue directory permissions (observed): nobody:users (99:100), mode drwxrwsr-x (setgid, 2775). Request files written by media-search are patrick:users (1000:100); files written by importer are nobody:users (99:100). Both have group write access via GID 100.

Staging path (observed from script): /downloads/.torbox-importer/<torbox_id>/ — this is ephemeral; no files currently staged.

4. Persistent data and state
Data	Location	Owned by	Notes
TorBox importer SQLite DB	/mnt/database/appdata/torbox-importer/state/torbox-importer.db (61 KB)	nobody:users	WAL mode; 4 tables
Request queue spool	/mnt/database/appdata/media-request-queue/{incoming,processing,done,failed}/	nobody:users	~7 settled requests in done/
Importer scripts (live truth)	/mnt/database/appdata/torbox-importer/scripts/	nobody:users or root	23 scripts
media-search source (Tower copy)	/mnt/database/appdata/media-search-dev/src/ (19 files)	patrick:1000	
Config files	/mnt/database/appdata/media-search-dev/config/	patrick:1000	Stremio addon discovery configs
SQLite schema (confirmed live): jobs, files, events, requests (with provider_created INTEGER NOT NULL DEFAULT 0 as a post-creation ALTER ADD). WAL + foreign keys enforced.

5. Secrets and configuration
media-search env vars:

TORBOX_API_KEY — server-side only; never reaches browser
STREMIO_ADDON_MANIFEST_URL — Comet addon URL (contains embedded API key in base64 payload)
PORT, HOST, REQUESTS_ROOT — operational
MEDIA_SEARCH_PORT, REQUESTS_HOST_PATH — Compose-level host config
torbox-importer env vars (from live container inspect, read from /mnt/database/appdata/torbox-importer/.env):

TORBOX_API_KEY, RADARR_API_KEY, SONARR_API_KEY — critical secrets
RADARR_URL=http://192.168.1.5:7878, SONARR_URL=http://192.168.1.5:8989 — LAN IPs
RADARR_ROOT_FOLDER=/data/Movies
RADARR_PROFILE_HD=4, RADARR_PROFILE_4K_WEB=7, RADARR_PROFILE_4K_BLU=8
POLL_INTERVAL=10
Optional: TORBOX_API_URL (defaults to https://api.torbox.app/v1/api), TORBOX_DB, TORBOX_SCRIPTS_DIR, REQUEST_ROOT
The importer .env is at /mnt/database/appdata/torbox-importer/.env, mode 640, root-readable. It is NOT at /boot/config/plugins/compose.manager/projects/torbox-importer/.env (not found there).

6. Ports and health checks
Service	Container port	Host port	Healthcheck
media-search	3000	3000	wget /health every 30s, 3 retries — currently healthy
torbox-importer	none	none	none
Sonarr	—	8989	Unraid-managed
Radarr	—	7878	Unraid-managed
Prowlarr	—	9696	Unraid-managed
7. Container users and permissions
media-search: USER node (UID 1000), group_add: ["100"]. Files created in /requests get ownership 1000:100.
torbox-importer: user: "99:100" (nobody:users). Files it creates in /requests get 99:100. Can read queue files written by media-search because both share GID 100.
no-new-privileges:true on both.
8. Shared request queue (observed format)
The queue is a filesystem-based atomic handoff. media-search writes {requestId}.json to /requests/incoming/ via rename; importer claims via mv -n to /requests/processing/; terminates to /requests/done/ or /requests/failed/.

Handoff JSON schema (version 1): version, requestId, createdAt, provider, intent (mediaType, streamType, scope, mediaId, baseMediaId, season, episodes), release (infoHash, title, filename, size, resolution, quality, codec, hdr).

Proven flows: tv/episode (complete E2E), movie/movie (movie bridge deployed, scripts live-verified syntax + unit-tested, but not yet live-tested end-to-end per movie-request-bridge.md).

9. Live vs repository drift
media-search:

Tower copy (/mnt/database/appdata/media-search-dev/) has 147-line app.js; repo (unify-media-search-importer branch) has the same file and 19 src files — structure matches. The diff tool showed Tower has content while find found 0 files locally for src — this is a tool artifact (the workspace path maps via the user session). Both sides are identical at commit f385cb2.
compose.yaml is identical between Tower and repo.
Tower's .env has STREMIO_ADDON_MANIFEST_URL with a Comet-hosted payload containing the TorBox API key embedded in a base64 config — this is a live credential exposure risk if that URL is ever logged or committed.
torbox-importer (critical — no git, no deploy script):

Movie bridge IS deployed (movie-cleanup-policy.sh, validate-movie-request-match.sh, sync-movie-request-state.sh all present on Tower).
NOT EXISTS worker guard IS deployed (confirmed in live worker.sh).
Multiple incremental patches applied since initial deployment, evidenced by .pre-* backup files. The applied state is AHEAD of the repo's scripts copies in some respects (e.g., process-request.sh shows movie/movie routing with validate-movie-request-match.sh calls; the repo's process-request only showed the TV path in early lines but the live version has both).
process-movie.sh.pre-empty-movie-fix-20260819-121936 — a post-bridge fix was applied intraday on 2026-08-19.
backup-request-hardening-20260819-123636 and backup-worker-hardening-20260819-123827 — two additional hardening patches applied after the movie bridge.
The movie-importer-bridge in the repo is a staging area, not the live truth. The live /mnt/database/appdata/torbox-importer/scripts/ is ahead.
The torbox-importer-movie-bridge.patch was regenerated against "verified Tower originals" but these have since been modified by three additional patch operations.
Key risk: The torbox-importer has no version control. Its current live state is the authoritative truth and has diverged from repository representations. Any new unified project must capture this live state before restructuring.

10. Arr/TorBox integration boundaries
Integration	Owned by	Details
TorBox cache check (checkcached API)	media-search	Uses TORBOX_API_KEY; server-side only
TorBox torrent add/reuse	torbox-importer (ensure-torbox-job.sh)	Creates or reuses torrent via API
TorBox mylist scan	torbox-importer (scan-torbox.sh)	Every poll loop
TorBox file download (aria2c)	torbox-importer (process-tv.sh, process-movie.sh)	Staged to /downloads/.torbox-importer/<id>/
TorBox delete	torbox-importer (settle-request.sh, process-movie.sh via policy)	Only after ownership/hash proof
Sonarr ManualImport	torbox-importer (process-tv.sh)	Via Sonarr REST API
Radarr ManualImport	torbox-importer (process-movie.sh)	Via Radarr REST API
Radarr TMDB/IMDb lookup	torbox-importer (validate-movie-request-match.sh)	Identity proof before import
11. What the current code does NOT have
No CINEMETA_BASE_URL override in Tower .env (the default https://v3-cinemeta.strem.io is used).
No importer HTTP API; no WebSocket; no /requests/status/<id>.json implementation.
No Unraid Community Applications XML template for either service.
No shared docker-compose.yaml spanning both services.
The handoff directory is conceptually a patch staging area, not a versioned importer source tree.
No unified versioning, changelog, or release tagging.

Part II — Recommendations / Inferences
These are recommendations, not observed facts.

12. Proposed repository layout
The unified repository should remain one Git repo, two deployment service contexts. Do not collapse the two runtimes into one process.


Alternative (simpler): keep media-search at repo root (current layout) and add torbox-importer/ alongside handoff. This avoids renaming paths and is less disruptive to the current working deploy.sh model.

13. Proposed unified compose.yaml
A single top-level compose.yaml spanning both services is the primary deliverable for "one documented installation." Both services share the queue volume and can be declared in the same file. Key constraints to preserve:

media-search: user: node, group_add: ["100"], no-new-privileges:true
torbox-importer: user: "99:100", no-new-privileges:true, env_file pointing to secrets
Volume media-request-queue declared once as a named or bind volume, shared by both services
torbox-importer network isolation (currently its own bridge — may move to a shared internal compose network for status API if/when that is built)
14. What must become configurable for public distribution
Currently hard-coded or assumed:

Item	Current state	Required for distribution
TORBOX_API_KEY	.env, required	✅ already env var
STREMIO_ADDON_MANIFEST_URL	.env, required	✅ already env var
RADARR_URL, RADARR_API_KEY	.env required	✅ already env var
SONARR_URL, SONARR_API_KEY	.env required	✅ already env var
RADARR_ROOT_FOLDER	.env, defaults /data/Movies	needs documented example
RADARR_PROFILE_HD/4K_WEB/4K_BLU	.env, numeric profile IDs	hard for new users — consider lookup-by-name or document how to find
Queue host path	REQUESTS_HOST_PATH env var	✅ already parameterized
Downloads host path	hard-coded /mnt/user/Downloads in compose	must be env_file or compose variable
TORBOX_API_URL	optional override, already env-capable	document in .env.example
POLL_INTERVAL	env var, default 10s	✅ already env var
CINEMETA_BASE_URL	optional override in media-search	add to .env.example
Port bindings	MEDIA_SEARCH_PORT env var	✅ already env var
LAN IPs for Arr	currently 192.168.1.5 in live .env	✅ env vars, but example must warn about Docker network resolution
Radarr quality profile IDs are the highest friction item for new users — they are numeric IDs internal to each Radarr instance and are not portable.

15. Migration path from current live deployment
Recommended sequence (each step independently reversible):

Capture live importer state into git — copy all 23 live scripts from /mnt/database/appdata/torbox-importer/scripts/ into torbox-importer/scripts/ in the repo. This is the primary missing piece. The .pre-* backups document history but the current live files are the truth.

Write torbox-importer/.env.example — document all required and optional variables with safe placeholder values. Write torbox-importer/Dockerfile that matches the live Alpine image exactly.

Write unified compose.yaml — replaces the two separate Compose projects. Test with docker compose config locally before touching Tower.

Deploy media-search from unified repo — use existing deploy.sh pattern, targeting the Tower appdata path. Rebuild image. Verify health. No importer change yet.

Deploy torbox-importer from unified repo — this is the highest-risk step. Procedure:

Back up /mnt/database/appdata/torbox-importer/scripts/ (timestamped, already established pattern)
Back up torbox-importer.db
Deploy new scripts
Restart container
Verify via docker logs torbox-importer and queue processing
Migrate Compose projects — move both from Unraid Compose Manager separate projects into a single project. Requires stopping both, migrating the compose file, restarting. Queue spool must be idle (no incoming/processing files) at migration time.

Update Unraid Compose Manager to point at the unified project.

Data migration: No database schema changes are required in this plan. The provider_created column was already added via ALTER TABLE to the live DB. The unified db-init.sh must use CREATE TABLE IF NOT EXISTS + ALTER TABLE IF NOT EXISTS patterns to tolerate existing schemas.

16. Regression-test gates
Before and after each deployment step:

npm test in media-search — 16 tests, 0 failures (currently passing)
bash -n / sh -n on all modified shell scripts (currently passing for scripts)
movie-request-bridge.sh — movie bridge unit tests (16 pass/0 fail, currently passing)
Live smoke test: Submit a known-cached Black Mirror episode request; verify incoming → processing → done queue progression and Sonarr import
Live movie smoke test (gated on movie bridge acceptance): Submit a movie absent from Radarr; verify Radarr import, request finalization, and ownership-aware cleanup
Additional gates needed before public release:

Test on a fresh Unraid install with no pre-existing data or state
Verify db-init.sh idempotency against an existing database with the provider_created column already present
End-to-end movie request test (currently documented as pending first acceptance)
17. Specific risks
Risk	Severity	Notes
torbox-importer has no git history	High	Live scripts are ahead of any repo representation; wrong capture = silent regression
Movie bridge not live-tested end-to-end	High	process-request.sh movie path is deployed and unit-tested but per movie-request-bridge.md end-to-end acceptance has not been verified; the process-movie.sh.pre-empty-movie-fix-20260819-121936 backup suggests a bug was fixed intraday
STREMIO_ADDON_MANIFEST_URL contains embedded TorBox API key	Medium	The base64 payload in the Comet URL exposes the API key to anyone who decodes it; this URL must never be committed or logged; the .env is correctly gitignored but needs a strong warning in .env.example
Radarr profile IDs are instance-specific	Medium	Profile IDs 4/7/8 mean nothing on another installation; a new user must look these up manually; bad values cause silent misconfiguration (wrong quality or no import)
Compose project rename migrating from two named projects to one	Medium	Compose project name change causes container recreation; queue spool must be idle; Docker-managed named volumes (none currently — all bind mounts) would need manual migration
provider_created column may be missing on fresh schema init	Medium	The column was added via ALTER TABLE to the live DB; db-init.sh must include it in the canonical CREATE TABLE; any fresh installation must also add it
settle-request.sh TorBox deletion	High (safety invariant)	Deletes TorBox provider resources; protected by provider_created=1 + hash verification + single-request-count checks; must not be weakened during any refactor
NOT EXISTS guard in worker.sh	High (safety invariant)	Prevents legacy movie crawler from double-processing request-linked jobs; must be preserved exactly
Staging directory persistence	Low-Medium	/downloads/.torbox-importer/<id>/ is ephemeral; if a container restart happens mid-download, process-request.sh is designed to resume; but the Downloads bind-mount path must remain stable across any Compose migration
aria2c dependency	Low	Present in Alpine via apk add aria2; must remain in the Dockerfile; no alternative is tested
Unraid 9.x / Docker Compose v5	Low	Labels confirm Compose Manager v5.1.2; any unified compose file must be compatible
RADARR_ROOT_FOLDER default	Low	Defaults to /data/Movies in process-movie.sh; this is not a universal path; must be documented with no default or a clearly wrong placeholder in .env.example
18. Unraid Community Applications path
For CA distribution, both services need:

Unraid XML template(s) with all required variables, path mappings, and sensible defaults
A published Docker image (GitHub Container Registry: ghcr.io/...) for each service, or a single multi-service template referencing a Compose approach
CA currently supports single-container templates natively; multi-service requires Compose Manager (already installed on Tower)
The Compose-Manager approach (already used for torbox-importer) is the most straightforward path — publish a GitHub repo with a compose.yaml that CA Compose Manager can pull directly
Recommended CA distribution shape: One GitHub repo, one Compose file, CA Compose Manager template pointing to a released GitHub URL. Users clone or download the compose file, fill in .env, and docker compose up -d.

Summary of immediate pre-unification prerequisites
Before any restructuring work begins:

Capture live torbox-importer scripts into the repo — this is the most urgent gap. The live state is the truth.
Read and compare each live script against scripts to document exactly what subsequent patches changed.
First live movie end-to-end test — validate the movie bridge before freezing the live state as the baseline for unification.
Decide on the source layout for torbox-importer/ in the unified repo (alongside media-search root vs. a subdirectory).
Draft torbox-importer/.env.example with all required variables and safe explanations.

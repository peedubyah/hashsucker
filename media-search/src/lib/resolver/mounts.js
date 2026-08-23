/**
 * Mount resolution boundary.
 *
 * Maps logical `exposure.mount_scope` identifiers to deployment-configured
 * filesystem roots. Mount roots are NOT persisted to the database — they are
 * read from environment variables at startup, matching the pattern in
 * `health.js` which inspects mounts via env vars.
 *
 * Adding a new mount scope requires:
 *   1. A new environment variable (e.g., `MY_PROVIDER_MOUNT_PATH`)
 *   2. An entry in `MOUNT_SCOPE_ENV_VARS` below
 * No schema change. No `mount_registry` table.
 */

const MOUNT_SCOPE_ENV_VARS = {
  default: 'REALDEBRID_MOUNT_PATH',
  torbox: 'TORBOX_MOUNT_PATH',
  canonical: 'CANONICAL_LIBRARY_PATH',
};

export function resolveMountRoot(mountScope, env = process.env) {
  if (typeof mountScope !== 'string' || mountScope.length === 0) {
    return { configured: false, mountScope, envVar: null, root: null };
  }
  const envVar = MOUNT_SCOPE_ENV_VARS[mountScope] ?? null;
  const root = envVar ? (env[envVar] ?? null) : null;
  return {
    configured: root != null,
    mountScope,
    envVar,
    root,
  };
}

export function listConfiguredMounts(env = process.env) {
  return Object.entries(MOUNT_SCOPE_ENV_VARS).map(([mountScope, envVar]) => ({
    mountScope,
    envVar,
    root: env[envVar] ?? null,
    configured: env[envVar] != null,
  }));
}

export function getMountScopeEnvVar(mountScope) {
  return MOUNT_SCOPE_ENV_VARS[mountScope] ?? null;
}

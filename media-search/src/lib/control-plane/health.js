import fs from 'node:fs';

export function getControlPlaneHealth(options = {}) {
  const env = options.env ?? process.env;
  const statSync = options.statSync ?? fs.statSync;
  const accessSync = options.accessSync ?? fs.accessSync;
  const generatedAt = options.now?.() ?? Date.now();
  const storage = inspectStorage(env.CONTROL_PLANE_DB, { statSync, accessSync });
  const mounts = [
    inspectMount('realdebrid-zurg', env.REALDEBRID_MOUNT_PATH, { statSync, accessSync }),
    inspectMount('torbox-webdav', env.TORBOX_MOUNT_PATH, { statSync, accessSync }),
    inspectMount('canonical-library', env.CANONICAL_LIBRARY_PATH, { statSync, accessSync }),
  ];
  const configuredMounts = mounts.filter((mount) => mount.configured);
  const errors = [storage, ...configuredMounts]
    .filter((component) => component.status === 'error')
    .map((component) => `${component.name}:${component.errorCategory}`);

  return {
    generatedAt,
    ok: errors.length === 0,
    mode: 'read-only-shadow',
    storage,
    mounts,
    providerCapabilities: {
      realdebrid: env.REALDEBRID_API_KEY ? 'discovery-credential-only' : 'not-configured',
      torbox: env.TORBOX_API_KEY ? 'cache-and-physical-credential-configured' : 'not-configured',
    },
    errors,
  };
}

function inspectStorage(dbPath, io) {
  if (!dbPath) {
    return { name: 'control-plane-db', configured: false, status: 'not-configured', errorCategory: null };
  }
  try {
    io.accessSync(dbPath, fs.constants.R_OK | fs.constants.W_OK);
    const stat = io.statSync(dbPath);
    return {
      name: 'control-plane-db', configured: true, status: stat.isFile() ? 'healthy' : 'error',
      errorCategory: stat.isFile() ? null : 'not-file',
    };
  } catch (error) {
    return {
      name: 'control-plane-db', configured: true, status: 'error',
      errorCategory: error?.code === 'ENOENT' ? 'missing' : 'inaccessible',
    };
  }
}

function inspectMount(name, mountPath, io) {
  if (!mountPath) return { name, configured: false, status: 'not-configured', readOnly: null, errorCategory: null };
  try {
    io.accessSync(mountPath, fs.constants.R_OK);
    const stat = io.statSync(mountPath);
    if (!stat.isDirectory()) {
      return { name, configured: true, status: 'error', readOnly: null, errorCategory: 'not-directory' };
    }
    return {
      name, configured: true, status: 'reachable', readOnly: null, errorCategory: null,
      note: 'read-only enforcement and transport freshness are not verified by filesystem reachability',
    };
  } catch (error) {
    return {
      name, configured: true, status: 'error', readOnly: null,
      errorCategory: error?.code === 'ENOENT' ? 'missing' : 'inaccessible',
    };
  }
}

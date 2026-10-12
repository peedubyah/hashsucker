/**
 * libmpv native IPC client for the isolated Plex HTPC canary.
 *
 * Plex HTPC 1.71.x runs libmpv in-process inside `/opt/plex-htpc/bin/Plex`.
 * That library reads `<PLEX_USERDATA_DIR>/mpv.conf` at engine init
 * (static: `mpv_load_config_file` call in bin/Plex), so the canary can expose
 * libmpv's native JSON control socket with no binary patch, no injection and
 * no browser automation:
 *
 *     input-ipc-server=/tmp/hs-mpv-ipc.sock      # in the Plex user-data mpv.conf
 *
 * That socket is the player's own truth: position, duration, pause state and
 * seek execution. It is deliberately NOT used to start or stop playback —
 * `loadfile` starts decoding without creating a PMS playback session and raw
 * `stop` unloads the file without notifying the Plex application layer, so the
 * application/session lifecycle stays with the app bridge instead.
 *
 * This module is a scoped client for the handful of properties and the one
 * command the canary needs. It is not an mpv SDK.
 */
import net from 'node:net';
import fs from 'node:fs';

/** Owner of a unix socket, resolved from /proc so no external tool is needed. */
export function resolveSocketOwner(socketPath) {
  let rows;
  try {
    rows = fs.readFileSync('/proc/net/unix', 'utf8').trim().split('\n').slice(1);
  } catch {
    return null;
  }
  const row = rows
    .map((line) => line.trim().split(/\s+/))
    .find((cols) => cols.length > 6 && cols[cols.length - 1] === socketPath);
  if (!row) return null;
  const inode = row[6];
  for (const pid of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    let exe = null;
    try {
      exe = fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      continue;
    }
    try {
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) {
          return { pid: Number(pid), exe, inode };
        }
      }
    } catch {
      /* /proc race: ignore */
    }
  }
  return null;
}

class MpvIpcError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const MPV_ERRORS = {
  UNAVAILABLE: 'MPV_IPC_UNAVAILABLE',
  NOT_PLEX: 'MPV_IPC_NOT_PLEX',
  DISCONNECTED: 'MPV_IPC_DISCONNECTED',
  COMMAND_FAILED: 'MPV_IPC_COMMAND_FAILED',
};

/**
 * Connect to an already-running libmpv IPC socket.
 * Throws MPV_IPC_UNAVAILABLE when the socket is absent, and
 * MPV_IPC_NOT_PLEX when it is not owned by the expected Plex HTPC executable.
 */
export function connectMpvIpc({ socketPath, expectedExe, timeoutMs = 5000 } = {}) {
  const owner = resolveSocketOwner(socketPath);
  if (!owner) {
    throw new MpvIpcError(MPV_ERRORS.UNAVAILABLE, `no listener on ${socketPath}`);
  }
  if (expectedExe && owner.exe !== expectedExe) {
    throw new MpvIpcError(
      MPV_ERRORS.NOT_PLEX,
      `socket ${socketPath} is owned by ${owner.exe} (pid ${owner.pid}), not ${expectedExe}`,
    );
  }
  return createMpvIpcClient({ socketPath, owner, timeoutMs });
}

function createMpvIpcClient({ socketPath, owner, timeoutMs }) {
  const socket = net.connect(socketPath);
  let requestId = 0;
  const pending = new Map();
  let buffer = '';
  let closed = false;

  socket.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = pending.get(msg.request_id);
      if (waiter) {
        pending.delete(msg.request_id);
        waiter(msg);
      }
    }
  });
  socket.on('error', (err) => {
    closed = true;
    for (const [, waiter] of pending) waiter({ error: 'error', _transport: String(err) });
    pending.clear();
  });
  socket.on('close', () => {
    closed = true;
    for (const [, waiter] of pending) waiter({ error: 'error', _transport: 'closed' });
    pending.clear();
  });

  const send = (parts) =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new MpvIpcError(MPV_ERRORS.DISCONNECTED, `ipc socket ${socketPath} closed`));
        return;
      }
      const id = ++requestId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new MpvIpcError(MPV_ERRORS.COMMAND_FAILED, `ipc timeout: ${JSON.stringify(parts)}`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      socket.write(`${JSON.stringify({ command: parts, request_id: id })}\n`);
    });

  const get = (name) => send(['get_property', name]);
  const command = (...parts) => send(parts);

  return {
    socketPath,
    owner,
    get,
    command,
    /** Numeric mpv value in milliseconds, or null when the property is absent. */
    async ms(name) {
      const msg = await get(name);
      return msg.error === 'success' && msg.data != null ? Math.round(msg.data * 1000) : null;
    },
    async text(name) {
      const msg = await get(name);
      return msg.error === 'success' && msg.data != null ? String(msg.data) : null;
    },
    /** Absolute seek. `playerSeekMs` is milliseconds; libmpv's seek is seconds. */
    seekMs(targetMs) {
      return command('seek', Math.round(targetMs / 1000), 'absolute');
    },
    stop() {
      return command('stop');
    },
    async isIdle() {
      const msg = await get('idle-active');
      return msg.error === 'success' && msg.data === true;
    },
    /** Poll a property until it satisfies `predicate`, or time out. Returns the value. */
    async waitForProperty(name, predicate, { timeoutMs = 90000, intervalMs = 250 } = {}) {
      const until = Date.now() + timeoutMs;
      let last = null;
      for (;;) {
        const msg = await get(name);
        last = msg.error === 'success' ? msg.data : null;
        if (predicate(last)) return last;
        if (Date.now() >= until) return null;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    },
    close() {
      if (!closed) socket.end();
      closed = true;
    },
  };
}

/**
 * VFS → Rust data-plane byte forwarder (P4: VFS Range-Forwarding Cutover).
 *
 * Core invariant this module exists to honor:
 *
 *   VFS decides WHICH durable TorrentFile is exposed.
 *   Rust decides HOW that TorrentFile's bytes move.
 *
 * This is the ONLY thing that crosses the ownership boundary at read time. The
 * Node VFS has already resolved the exact durable TorrentFile (its surrogate
 * `tfId`, i.e. `state.entry.torrentFileId`). We forward the client's GET/Range
 * request to the Rust data plane at `/files/:tfId` and proxy its response to the
 * client VERBATIM — status, the allowlisted hop-by-hop headers, and the raw
 * byte stream. Node performs no buffering, no Range arithmetic, and no
 * byte-exactness logic of its own; the data plane owns all of that south of the
 * DB boundary.
 *
 * The data plane performs a per-request S-1 lookup (Node control plane) to map
 * the surrogate `tfId` to the durable (info_hash, canonical_path, size) tuple,
 * so routing purely by `tfId` is sufficient and resolves to the durable identity
 * automatically (P4 §5). We never re-derive durable identity in Node here.
 */

import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

/**
 * Headers the Rust data plane may emit that must be preserved on the client
 * response. We deliberately do NOT rewrite Range / Content-Range / status — the
 * data plane owns byte-exactness. `cache-control: no-store` is added by Node to
 * keep the VFS read path non-cacheable, matching the legacy behavior.
 */
const PROXIED_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
];

/**
 * Structured error thrown ONLY when the data plane cannot be reached — i.e.
 * before any response byte has been written. This lets the caller fall back to
 * the legacy Node byte path as rollback evidence (P4 §6). Any response that the
 * data plane DID return (including its 502/503/416) is proxied verbatim and is
 * NOT surfaced as this error — Rust exhaustion is presented to the client as
 * the data plane's own fallback status shape, never swallowed into 200 (P4 §4).
 *
 * Duck-types the same `{ status, code }` surface as VfsError so the existing
 * `sendError` helper can route it without a class dependency.
 */
export class DataPlaneError extends Error {
  constructor(message, status = 502, code = 'DATA_PLANE_ERROR') {
    super(message);
    this.name = 'DataPlaneError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Forward a single VFS GET/Range read to the Rust data plane and proxy its
 * response to the client verbatim.
 *
 * @param {object} args
 * @param {(input: string, init?: object) => Promise<import('undici').Response>} args.fetchFn
 * @param {string} args.baseUrl  Data-plane base URL, e.g. http://hy4-data-plane:3001
 * @param {string} args.tfId     Durable TorrentFile surrogate id (state.entry.torrentFileId)
 * @param {import('http').IncomingMessage} args.request
 * @param {import('http').ServerResponse} args.response
 * @param {string} [args.contentType]  Fallback content-type when the data plane omits one.
 */
export async function streamFromDataPlane({
  fetchFn,
  baseUrl,
  tfId,
  request,
  response,
  contentType,
}) {
  const upstreamUrl = `${String(baseUrl).replace(/\/+$/, '')}/files/${encodeURIComponent(tfId)}`;
  const upstreamHeaders = {};
  // Forward the client Range verbatim. The data plane owns Range parsing,
  // satisfiability (416), and Content-Range construction.
  if (request.headers.range) upstreamHeaders.range = request.headers.range;
  // Mirror the client method so a forwarded HEAD/GET both behave; VFS HEAD is
  // handled in Node and never reaches here, but be defensive.
  const method = (request.method || 'GET').toUpperCase();

  let upstream;
  try {
    upstream = await fetchFn(upstreamUrl, { method, headers: upstreamHeaders });
  } catch (error) {
    // No response bytes have been written yet — safe for the caller to fall
    // back to the legacy Node byte path.
    throw new DataPlaneError(
      `data-plane unreachable for tfId=${tfId}: ${error?.message || error}`,
      502,
      'DATA_PLANE_UNREACHABLE',
    );
  }

  const outHeaders = {};
  for (const name of PROXIED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value != null) outHeaders[name] = value;
  }
  if (contentType && outHeaders['content-type'] == null) {
    outHeaders['content-type'] = contentType;
  }
  outHeaders['cache-control'] = 'no-store';

  // Proxy status + headers verbatim. This automatically preserves 206/416,
  // streaming, Content-Range, Accept-Ranges, and the data plane's Retry-After
  // (carried outside PROXIED_HEADERS only if needed — see note in P4 §2).
  response.writeHead(upstream.status, outHeaders);

  if (!upstream.body) {
    response.end();
    return;
  }

  const stream = Readable.fromWeb(upstream.body);
  const abort = () => stream.destroy();
  request.once('aborted', abort);
  response.once('close', abort);
  try {
    stream.pipe(response);
    await finished(stream);
  } catch (error) {
    if (!response.headersSent) throw error;
    // Headers already on the wire — cannot 502 now; tear down cleanly.
    response.destroy(error);
  } finally {
    request.removeListener('aborted', abort);
    response.removeListener('close', abort);
  }
}

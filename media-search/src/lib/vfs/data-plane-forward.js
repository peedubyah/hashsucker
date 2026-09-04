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
  /**
   * @param {string} message
   * @param {number} status  HTTP status to surface to the caller (default 502).
   * @param {string} code    Machine-readable error code (e.g. PROVIDER_EXHAUSTED).
   * @param {'A'|'B'|'C'|'D'} errorClass  P5 failure class:
   *   A — client Range / no fallback (416)
   *   B — identity / not-found / no blind fallback (S1_FETCH_FAILED)
   *   C — transient infra / explicit 5xx / data-plane unreachable. MUST NOT
   *       silently fall through to the legacy Node provider byte path.
   *   D — provider exhaustion. The ONLY fallback-eligible class: the caller may
   *       switch to a persisted alternate TorrentFile and re-forward to Rust.
   */
  constructor(message, status = 502, code = 'DATA_PLANE_ERROR', errorClass = 'C') {
    super(message);
    this.name = 'DataPlaneError';
    this.status = status;
    this.code = code;
    this.class = errorClass;
  }
}

/**
 * P5 failure-class classifier. Maps a Rust error code (or status) to a class
 * that the caller uses to decide fallback vs explicit failure. See the P5 brief.
 */
export function classifyDataPlaneError(code, status) {
  if (code === 'PROVIDER_EXHAUSTED') return 'D';
  if (code === 'S1_FETCH_FAILED') return 'B';
  if (code === 'INTERNAL_ERROR') return 'C';
  if (status === 416) return 'A';
  // default: explicit 5xx / 429 / unknown — class C (no legacy escape)
  return 'C';
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
    // The data plane itself is unreachable. P5 proof D: this is an explicit
    // failure — there is no durable TorrentFile Rust can serve, so re-forwarding
    // a persisted alternate would only hit the same dead data plane. Class C:
    // terminal, NO silent fall-through to the legacy Node provider byte path.
    throw new DataPlaneError(
      `data-plane unreachable for tfId=${tfId}: ${error?.message || error}`,
      502,
      'DATA_PLANE_UNREACHABLE',
      'C',
    );
  }

  // P5: classify the data-plane response before proxying. A 200/206 is a
  // successful byte stream and is proxied verbatim (unchanged P4 behavior). Any
  // non-success status is classified into a P5 failure class and THROWN (rather
  // than proxied) so the caller can decide: class D (provider exhaustion) →
  // reuse the persisted-candidate fallback and re-forward to Rust with a
  // different TorrentFile; every other class → explicit terminal failure with NO
  // silent fall-through to the legacy Node provider byte path.
  const status = upstream.status;
  if (status === 200 || status === 206) {
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
    response.writeHead(status, outHeaders);

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
    return;
  }

  // Non-success: read the body (Rust emits structured JSON on 5xx) and classify.
  // Even when the body is not JSON, the status alone determines the class.
  let code = `DATA_PLANE_HTTP_${status}`;
  if (status === 416) code = 'RUST_RANGE_NOT_SATISFIABLE';
  else if (status === 429) code = 'RUST_RATE_LIMITED';
  let bodyText = '';
  try {
    bodyText = await upstream.text();
  } catch {
    // ignore body read errors; fall back to status-derived code
  }
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText);
      if (parsed?.error?.code) code = parsed.error.code;
    } catch {
      // non-JSON body; keep the status-derived code
    }
  }
  const errorClass = classifyDataPlaneError(code, status);
  throw new DataPlaneError(
    `data-plane returned ${status} for tfId=${tfId}: ${code}`,
    status,
    code,
    errorClass,
  );
}

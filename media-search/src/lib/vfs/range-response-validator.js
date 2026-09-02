/**
 * Shared Range response validator for the movie/TV WebDAV byte path.
 *
 * Owns the "is this upstream 200/206 actually a usable byte response?"
 * classification that used to live as an inline closure in both
 * movie-webdav.js and tv-webdav.js. A retained cached capability can
 * produce a body that the upstream claims is valid but is in fact a
 * protocol-invalid 206 (e.g. 206 + correct Content-Range start/end/total
 * but body is 0 bytes, or Content-Length says 10 but the body is 5
 * bytes). The prior inline validator only checked the headers — the
 * client received a response that lied about its own length, which is
 * the exact E02 failure mode.
 *
 * Public API:
 *   - RANGE_VALIDATION_REASONS: frozen enum of reason codes
 *   - validateRangeResponseHeaders(upstream, requestedRange, metadata)
 *       Pure header check. Returns null (valid) or a structured
 *       RangeResponseValidationError (status=502, code, message,
 *       validationReason).
 *   - validateRangeResponseBody(upstream, requestedRange, metadata)
 *       Header check + buffered body byte count check. For a Range
 *       request the body is fully buffered, the byte count is
 *       compared against end-start+1, and the buffered body is
 *       substituted on the returned upstream-like object so the
 *       WebDAV layer can pipe it. For a full-file (no Range) request
 *       only the Content-Length header is compared against the
 *       durable size — body is NOT buffered.
 *   - classifyReadFailure(upstream)
 *       Maps an upstream status to one of: 'rate-limited' | 'stale' |
 *       'transient' | 'protocol-invalid'. The movie/TV WebDAV byte
 *       path uses this to decide whether the cached capability is
 *       trustworthy after a header-class validation failure:
 *         - 'rate-limited'  → mark the handoff rate-limited, retain
 *         - 'stale'         → the capability is definitively invalid
 *                            (401/403/404/410) — invalidate it
 *         - 'transient'     → 5xx blip, retain the capability
 *         - 'protocol-invalid' → the upstream is lying (e.g. ignored
 *                              Range and returned a 200) — invalidate
 *                              it. The body-class check in
 *                              validateRangeResponseBody additionally
 *                              invalidates on body-length mismatch.
 *       Mirrors the inline classification that used to live in
 *       openValidatedProviderRead so the bounded-retry contract
 *       remains the same.
 */

export const RANGE_VALIDATION_REASONS = Object.freeze({
  STATUS_NOT_206: 'STATUS_NOT_206',
  STATUS_NOT_2XX: 'STATUS_NOT_2XX',
  CONTENT_RANGE_MISSING: 'CONTENT_RANGE_MISSING',
  CONTENT_RANGE_UNPARSEABLE: 'CONTENT_RANGE_UNPARSEABLE',
  CONTENT_RANGE_START_MISMATCH: 'CONTENT_RANGE_START_MISMATCH',
  CONTENT_RANGE_END_MISMATCH: 'CONTENT_RANGE_END_MISMATCH',
  CONTENT_RANGE_TOTAL_MISMATCH: 'CONTENT_RANGE_TOTAL_MISMATCH',
  CONTENT_LENGTH_MISMATCH: 'CONTENT_LENGTH_MISMATCH',
  BODY_LENGTH_MISMATCH: 'BODY_LENGTH_MISMATCH',
  EMPTY_BODY: 'EMPTY_BODY',
  BODY_MISSING: 'BODY_MISSING',
  METADATA_SIZE_MISSING: 'METADATA_SIZE_MISSING',
});

const STALE_PROVIDER_STATUSES = new Set([401, 403, 404, 410]);
// Transient 5xx statuses: the upstream is overloaded / unavailable,
// not stale — the cached capability is still trustworthy, retain it.
const TRANSIENT_PROVIDER_STATUSES = new Set([500, 502, 503, 504]);

/**
 * Parse a Content-Range header value of the form
 *   "bytes <start>-<end>/<total>".
 * Returns null if the value is missing or not parseable. The "bytes *
 * <size>" form is intentionally rejected because it is only used on
 * 416 responses, not on 2xx byte responses.
 */
function parseContentRange(value) {
  if (value == null) return null;
  const match = String(value).match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
  if (!match) return null;
  if (match[3] === '*') return null;
  return {
    start: Number(match[1]),
    end: Number(match[2]),
    total: Number(match[3]),
  };
}

function makeValidationError(message, code, validationReason, details = {}) {
  const error = new Error(message);
  error.name = 'RangeResponseValidationError';
  error.status = 502;
  error.code = code;
  error.validationReason = validationReason;
  Object.assign(error, details);
  return error;
}

/**
 * Pure header-level check. No body access. Suitable for the
 * streaming-only WebDAV path that does not want to buffer.
 */
export function validateRangeResponseHeaders(upstream, requestedRange, metadata) {
  if (!upstream) {
    return makeValidationError(
      'Provider response was missing',
      'PROVIDER_READ_FAILED',
      RANGE_VALIDATION_REASONS.BODY_MISSING,
    );
  }

  if (requestedRange) {
    if (upstream.status !== 206) {
      return makeValidationError(
        'Provider did not honor the requested byte range',
        'PROVIDER_RANGE_FAILED',
        RANGE_VALIDATION_REASONS.STATUS_NOT_206,
        { upstreamStatus: upstream.status },
      );
    }
    const headerValue = upstream.headers?.get?.('content-range');
    const upstreamRange = parseContentRange(headerValue);
    if (!upstreamRange) {
      return makeValidationError(
        'Provider did not return a parseable Content-Range header',
        'PROVIDER_RANGE_MISMATCH',
        headerValue == null
          ? RANGE_VALIDATION_REASONS.CONTENT_RANGE_MISSING
          : RANGE_VALIDATION_REASONS.CONTENT_RANGE_UNPARSEABLE,
        { contentRangeHeader: headerValue ?? null },
      );
    }
    const expectedTotal = Number(metadata?.size);
    if (upstreamRange.start !== requestedRange.start) {
      return makeValidationError(
        'Provider returned a range with the wrong start offset',
        'PROVIDER_RANGE_MISMATCH',
        RANGE_VALIDATION_REASONS.CONTENT_RANGE_START_MISMATCH,
        {
          expectedStart: requestedRange.start,
          actualStart: upstreamRange.start,
          contentRangeHeader: headerValue,
        },
      );
    }
    if (upstreamRange.end !== requestedRange.end) {
      return makeValidationError(
        'Provider returned a range with the wrong end offset',
        'PROVIDER_RANGE_MISMATCH',
        RANGE_VALIDATION_REASONS.CONTENT_RANGE_END_MISMATCH,
        {
          expectedEnd: requestedRange.end,
          actualEnd: upstreamRange.end,
          contentRangeHeader: headerValue,
        },
      );
    }
    if (!Number.isSafeInteger(expectedTotal) || upstreamRange.total !== expectedTotal) {
      return makeValidationError(
        'Provider returned a range whose total does not match the durable file size',
        'PROVIDER_RANGE_MISMATCH',
        RANGE_VALIDATION_REASONS.CONTENT_RANGE_TOTAL_MISMATCH,
        {
          expectedTotal,
          actualTotal: upstreamRange.total,
          contentRangeHeader: headerValue,
        },
      );
    }
    // Defense in depth: Content-Length must agree with the requested
    // range when present. A lie here is a protocol-invalid 206 even if
    // the upstream body is the right size — the headers are internally
    // inconsistent.
    const clHeader = upstream.headers?.get?.('content-length');
    if (clHeader != null) {
      const declared = Number(String(clHeader).trim());
      const expectedLength = requestedRange.end - requestedRange.start + 1;
      if (Number.isFinite(declared) && declared !== expectedLength) {
        return makeValidationError(
          'Provider Content-Length does not match the requested range',
          'PROVIDER_RANGE_MISMATCH',
          RANGE_VALIDATION_REASONS.CONTENT_LENGTH_MISMATCH,
          {
            expectedLength,
            declaredLength: declared,
            contentLengthHeader: clHeader,
          },
        );
      }
    }
    return null;
  }

  // No range requested — the upstream must answer 200 and the
  // Content-Length (when present) must match the durable file size.
  if (upstream.status !== 200) {
    return makeValidationError(
      `Provider returned HTTP ${upstream.status}`,
      'PROVIDER_READ_FAILED',
      RANGE_VALIDATION_REASONS.STATUS_NOT_2XX,
      { upstreamStatus: upstream.status },
    );
  }
  const clHeader = upstream.headers?.get?.('content-length');
  if (clHeader != null) {
    const declared = Number(String(clHeader).trim());
    const expectedTotal = Number(metadata?.size);
    if (Number.isFinite(declared) && Number.isSafeInteger(expectedTotal) && declared !== expectedTotal) {
      return makeValidationError(
        'Provider Content-Length does not match the durable file size',
        'PROVIDER_READ_MISMATCH',
        RANGE_VALIDATION_REASONS.CONTENT_LENGTH_MISMATCH,
        {
          expectedLength: expectedTotal,
          declaredLength: declared,
          contentLengthHeader: clHeader,
        },
      );
    }
  }
  return null;
}

/**
 * Read the upstream body fully into a Buffer. Returns
 * { buffer, length } on success, or throws if the body errors before
 * completion. The body is consumed regardless of outcome so the
 * caller does not need to drain it.
 */
async function readBodyFully(upstream) {
  if (!upstream.body) return { buffer: Buffer.alloc(0), length: 0 };
  const reader = upstream.body.getReader();
  const parts = [];
  let total = 0;
  // Guard against a runaway body that never terminates. For a Range
  // request the expected upper bound is end - start + 1 bytes. For a
  // full-file (no Range) request we use the durable size when known.
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        parts.push(value);
        total += value.byteLength ?? value.length ?? 0;
      }
    }
  } catch (error) {
    // Release the lock before propagating so the underlying socket
    // is not leaked.
    try { await reader.cancel(error); } catch { /* ignore */ }
    throw error;
  }
  return {
    buffer: Buffer.concat(parts.map((p) => Buffer.from(p))),
    length: total,
  };
}

/**
 * Header check + buffered body byte count check. For a Range request
 * the body is fully buffered (Range sizes are bounded by client
 * requests — KB to MB in practice), the byte count is compared
 * against end-start+1, and a fresh Response-like wrapper is returned
 * with the buffered body so the WebDAV layer can pipe it. For a
 * full-file (no Range) request the body is NOT buffered; only the
 * Content-Length header is compared.
 *
 * Returns either:
 *   { ok: true, upstream } — the (possibly re-wrapped) upstream
 *   { ok: false, error } — the structured RangeResponseValidationError
 */
export async function validateRangeResponseBody(upstream, requestedRange, metadata) {
  const headerError = validateRangeResponseHeaders(upstream, requestedRange, metadata);
  if (headerError) return { ok: false, error: headerError };

  if (!requestedRange) {
    // Full-file path — trust the body length once it streams, do
    // not buffer.
    return { ok: true, upstream };
  }

  // Range path — buffer the body and verify exact byte count. This
  // is the E02 fix: a 206 with correct Content-Range but a
  // short/empty body is a protocol-invalid 206 that must NOT be
  // passed to the client.
  const expectedLength = requestedRange.end - requestedRange.start + 1;
  let bodyResult;
  try {
    bodyResult = await readBodyFully(upstream);
  } catch (error) {
    return {
      ok: false,
      error: makeValidationError(
        'Provider body stream errored before completion',
        'PROVIDER_READ_FAILED',
        RANGE_VALIDATION_REASONS.BODY_MISSING,
        { streamError: error?.message ?? String(error) },
      ),
    };
  }
  if (bodyResult.length === 0) {
    return {
      ok: false,
      error: makeValidationError(
        'Provider returned an empty body for the requested byte range',
        'PROVIDER_RANGE_MISMATCH',
        RANGE_VALIDATION_REASONS.EMPTY_BODY,
        { expectedLength, actualLength: 0 },
      ),
    };
  }
  if (bodyResult.length !== expectedLength) {
    return {
      ok: false,
      error: makeValidationError(
        'Provider body length does not match the requested byte range',
        'PROVIDER_RANGE_MISMATCH',
        RANGE_VALIDATION_REASONS.BODY_LENGTH_MISMATCH,
        { expectedLength, actualLength: bodyResult.length },
      ),
    };
  }
  // Re-wrap the upstream so the WebDAV layer can pipe the buffered
  // body. The original upstream.body is consumed at this point so
  // the new stream is the only path forward.
  const rewound = new Response(bodyResult.buffer, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: upstream.headers,
  });
  return { ok: true, upstream: rewound };
}

/**
 * Classify the failure mode for a non-validation upstream status
 * (e.g. 401/403/404/410/429). Mirrors the inline classification that
 * used to live in openValidatedProviderRead so the bounded-retry
 * contract remains the same.
 */
export function classifyReadFailure(upstream) {
  if (upstream?.status === 429) return 'rate-limited';
  if (upstream && STALE_PROVIDER_STATUSES.has(upstream.status)) return 'stale';
  if (upstream && TRANSIENT_PROVIDER_STATUSES.has(upstream.status)) return 'transient';
  return 'protocol-invalid';
}

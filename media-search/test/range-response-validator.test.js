// Unit tests for the shared Range response validator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RANGE_VALIDATION_REASONS,
  validateRangeResponseHeaders,
  validateRangeResponseBody,
  classifyReadFailure,
} from '../src/lib/vfs/range-response-validator.js';

const SIZE = 1000;
const REQ = { start: 100, end: 199, header: 'bytes=100-199' };
const META = { size: SIZE };

// ---- Header-only validation ----

test('valid range response passes', () => {
  const upstream = new Response(null, {
    status: 206,
    headers: { 'content-range': 'bytes 100-199/1000', 'content-length': '100' },
  });
  const result = validateRangeResponseHeaders(upstream, REQ, META);
  assert.equal(result, null);
});

test('STATUS_NOT_206 when upstream returns 200 to a range request', () => {
  const upstream = new Response('full body', { status: 200 });
  const result = validateRangeResponseHeaders(upstream, REQ, META);
  assert.equal(result.status, 502);
  assert.equal(result.code, 'PROVIDER_RANGE_FAILED');
  assert.equal(result.validationReason, RANGE_VALIDATION_REASONS.STATUS_NOT_206);
  assert.equal(result.upstreamStatus, 200);
});

test('CONTENT_RANGE_MISSING when upstream returns 206 without Content-Range', () => {
  const upstream = new Response('hi', { status: 206, headers: { 'content-length': '5' } });
  const result = validateRangeResponseHeaders(upstream, REQ, META);
  assert.equal(result.validationReason, RANGE_VALIDATION_REASONS.CONTENT_RANGE_MISSING);
  assert.equal(result.contentRangeHeader, null);
});

test('CONTENT_RANGE_UNPARSEABLE when Content-Range is malformed', () => {
  const upstream = new Response('hi', {
    status: 206,
    headers: { 'content-range': 'not-a-range' },
  });
  const result = validateRangeResponseHeaders(upstream, REQ, META);
  assert.equal(result.validationReason, RANGE_VALIDATION_REASONS.CONTENT_RANGE_UNPARSEABLE);
  assert.equal(result.contentRangeHeader, 'not-a-range');
});

test('CONTENT_RANGE_START_MISMATCH when start offset disagrees', () => {
  const upstream = new Response(null, {
    status: 206,
    headers: { 'content-range': 'bytes 50-199/1000' },
  });
  const result = validateRangeResponseHeaders(upstream, REQ, META);
  assert.equal(result.validationReason, RANGE_VALIDATION_REASONS.CONTENT_RANGE_START_MISMATCH);
  assert.equal(result.expectedStart, 100);
  assert.equal(result.actualStart, 50);
});

test('CONTENT_RANGE_END_MISMATCH when end offset disagrees', () => {
  const upstream = new Response(null, {
    status: 206,
    headers: { 'content-range': 'bytes 100-150/1000' },
  });
  const result = validateRangeResponseHeaders(upstream, REQ, META);
  assert.equal(result.validationReason, RANGE_VALIDATION_REASONS.CONTENT_RANGE_END_MISMATCH);
  assert.equal(result.expectedEnd, 199);
  assert.equal(result.actualEnd, 150);
});

test('CONTENT_RANGE_TOTAL_MISMATCH when total does not match durable size', () => {
  const upstream = new Response(null, {
    status: 206,
    headers: { 'content-range': 'bytes 100-199/2000' },
  });
  const result = validateRangeResponseHeaders(upstream, REQ, META);
  assert.equal(result.validationReason, RANGE_VALIDATION_REASONS.CONTENT_RANGE_TOTAL_MISMATCH);
  assert.equal(result.expectedTotal, 1000);
  assert.equal(result.actualTotal, 2000);
});

test('CONTENT_LENGTH_MISMATCH when Content-Length disagrees with requested range', () => {
  const upstream = new Response(null, {
    status: 206,
    headers: { 'content-range': 'bytes 100-199/1000', 'content-length': '50' },
  });
  const result = validateRangeResponseHeaders(upstream, REQ, META);
  assert.equal(result.validationReason, RANGE_VALIDATION_REASONS.CONTENT_LENGTH_MISMATCH);
  assert.equal(result.expectedLength, 100);
  assert.equal(result.declaredLength, 50);
});

test('valid range with absent Content-Length still passes', () => {
  const upstream = new Response(null, {
    status: 206,
    headers: { 'content-range': 'bytes 100-199/1000' },
  });
  const result = validateRangeResponseHeaders(upstream, REQ, META);
  assert.equal(result, null);
});

test('STATUS_NOT_2XX on full-file when upstream returns 206 with no range', () => {
  const upstream = new Response(null, { status: 206 });
  const result = validateRangeResponseHeaders(upstream, null, META);
  assert.equal(result.validationReason, RANGE_VALIDATION_REASONS.STATUS_NOT_2XX);
});

test('full-file 200 with matching Content-Length passes', () => {
  const upstream = new Response(null, {
    status: 200,
    headers: { 'content-length': '1000' },
  });
  const result = validateRangeResponseHeaders(upstream, null, META);
  assert.equal(result, null);
});

test('full-file 200 with mismatched Content-Length fails with CONTENT_LENGTH_MISMATCH', () => {
  const upstream = new Response(null, {
    status: 200,
    headers: { 'content-length': '500' },
  });
  const result = validateRangeResponseHeaders(upstream, null, META);
  assert.equal(result.validationReason, RANGE_VALIDATION_REASONS.CONTENT_LENGTH_MISMATCH);
  assert.equal(result.expectedLength, 1000);
  assert.equal(result.declaredLength, 500);
});

// ---- Body-buffered validation ----

test('range body: correct length passes and re-wraps upstream', async () => {
  const body = Buffer.alloc(100, 0x41); // 100 'A' bytes
  const upstream = new Response(body, {
    status: 206,
    headers: { 'content-range': 'bytes 100-199/1000' },
  });
  const result = await validateRangeResponseBody(upstream, REQ, META);
  assert.equal(result.ok, true);
  assert.ok(result.upstream.body);
  // The re-wrapped body should be a ReadableStream of the same bytes.
  const reader = result.upstream.body.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) total += value.byteLength;
  }
  assert.equal(total, 100);
});

test('range body: EMPTY_BODY when body is 0 bytes despite correct Content-Range', async () => {
  const upstream = new Response(null, {
    status: 206,
    headers: { 'content-range': 'bytes 100-199/1000' },
  });
  const result = await validateRangeResponseBody(upstream, REQ, META);
  assert.equal(result.ok, false);
  assert.equal(result.error.validationReason, RANGE_VALIDATION_REASONS.EMPTY_BODY);
  assert.equal(result.error.expectedLength, 100);
  assert.equal(result.error.actualLength, 0);
});

test('range body: BODY_LENGTH_MISMATCH when body shorter than requested range', async () => {
  const body = Buffer.alloc(50, 0x42); // 50 'B' bytes
  const upstream = new Response(body, {
    status: 206,
    headers: { 'content-range': 'bytes 100-199/1000' },
  });
  const result = await validateRangeResponseBody(upstream, REQ, META);
  assert.equal(result.ok, false);
  assert.equal(result.error.validationReason, RANGE_VALIDATION_REASONS.BODY_LENGTH_MISMATCH);
  assert.equal(result.error.expectedLength, 100);
  assert.equal(result.error.actualLength, 50);
});

test('range body: BODY_LENGTH_MISMATCH when body LONGER than requested range', async () => {
  const body = Buffer.alloc(200, 0x43);
  const upstream = new Response(body, {
    status: 206,
    headers: { 'content-range': 'bytes 100-199/1000' },
  });
  const result = await validateRangeResponseBody(upstream, REQ, META);
  assert.equal(result.ok, false);
  assert.equal(result.error.validationReason, RANGE_VALIDATION_REASONS.BODY_LENGTH_MISMATCH);
  assert.equal(result.error.expectedLength, 100);
  assert.equal(result.error.actualLength, 200);
});

test('range body: header error is surfaced before body read', async () => {
  // Wrong total — header check fires before body read.
  const body = Buffer.alloc(100, 0x44);
  const upstream = new Response(body, {
    status: 206,
    headers: { 'content-range': 'bytes 100-199/2000' },
  });
  const result = await validateRangeResponseBody(upstream, REQ, META);
  assert.equal(result.ok, false);
  assert.equal(result.error.validationReason, RANGE_VALIDATION_REASONS.CONTENT_RANGE_TOTAL_MISMATCH);
});

// ---- Classification ----

test('classifyReadFailure: 429 -> rate-limited', () => {
  assert.equal(classifyReadFailure({ status: 429 }), 'rate-limited');
});
test('classifyReadFailure: 401 -> stale', () => {
  assert.equal(classifyReadFailure({ status: 401 }), 'stale');
});
test('classifyReadFailure: 403 -> stale', () => {
  assert.equal(classifyReadFailure({ status: 403 }), 'stale');
});
test('classifyReadFailure: 404 -> stale', () => {
  assert.equal(classifyReadFailure({ status: 404 }), 'stale');
});
test('classifyReadFailure: 410 -> stale', () => {
  assert.equal(classifyReadFailure({ status: 410 }), 'stale');
});
test('classifyReadFailure: 200 -> invalid', () => {
  assert.equal(classifyReadFailure({ status: 200 }), 'invalid');
});
test('classifyReadFailure: 502 -> invalid', () => {
  assert.equal(classifyReadFailure({ status: 502 }), 'invalid');
});
test('classifyReadFailure: null -> invalid', () => {
  assert.equal(classifyReadFailure(null), 'invalid');
});

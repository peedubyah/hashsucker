/**
 * Edge Proxy Integration Tests
 *
 * Validates the edge proxy configuration against the contract.
 * Tests routing, header forwarding, and forbidden responsibilities.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const CADDYFILE_PATH = new URL('../../edge/Caddyfile', import.meta.url);
const COMPOSE_PATH = new URL('../../compose.yaml', import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCaddyfile() {
  return fs.readFileSync(CADDYFILE_PATH, 'utf8');
}

function readCompose() {
  return fs.readFileSync(COMPOSE_PATH, 'utf8');
}

// ---------------------------------------------------------------------------
// Test: Routing contract lives in the Caddyfile (consolidated topology)
// ---------------------------------------------------------------------------

test('Caddyfile documents the routing contract', () => {
  // The standalone EDGE-PROXY-CONTRACT.md was retired when the config was
  // consolidated (Aug 2026): the Caddyfile is the single source of truth.
  // It must route /api/* explicitly and send everything else (including
  // /media/* and /stream/*) to media-search:3000 through the catch-all.
  const caddyfile = readCaddyfile();
  assert.ok(caddyfile.length > 0, 'Caddyfile should not be empty');
  assert.match(caddyfile, /@api path \/api\/\*/);
  assert.match(caddyfile, /reverse_proxy media-search:3000/);
});

// ---------------------------------------------------------------------------
// Test: Caddyfile exists and has correct structure
// ---------------------------------------------------------------------------

test('Caddyfile defines two route classes (api + catch-all)', () => {
  const caddyfile = readCaddyfile();
  assert.ok(caddyfile.length > 0, 'Caddyfile should not be empty');
  assert.match(caddyfile, /@api path \/api\/\*/);
  assert.match(caddyfile, /reverse_proxy media-search:3000/);
  // No dedicated @media matcher: /media/* and /stream/* fall through to
  // the catch-all, which targets the same backend.
  assert.doesNotMatch(caddyfile, /@media/);
});

// ---------------------------------------------------------------------------
// Test: /media/* reaches media-search through the catch-all
// ---------------------------------------------------------------------------

test('/media/* routes to media-search backend via catch-all', () => {
  const caddyfile = readCaddyfile();
  // No split backend for media: the single catch-all reverse_proxy serves
  // /media/*, /stream/* and /* alike.
  const lines = caddyfile.split('\n');
  const catchAllIndex = lines.findIndex(line =>
    line.includes('reverse_proxy media-search:3000') &&
    !line.includes('@media') &&
    !line.includes('@api')
  );
  assert.ok(catchAllIndex >= 0, 'catch-all reverse_proxy serves /media/*');
});

// ---------------------------------------------------------------------------
// Test: /api/* routes to control plane
// ---------------------------------------------------------------------------

test('/api/* routes to control plane backend', () => {
  const caddyfile = readCaddyfile();
  const apiBlock = caddyfile.match(/@api[\s\S]*?reverse_proxy @api media-search:3000/);
  assert.ok(apiBlock, '/api/* should route to media-search:3000');
});

// ---------------------------------------------------------------------------
// Test: /* routes to UI/static
// ---------------------------------------------------------------------------

test('/* routes to UI/static backend', () => {
  const caddyfile = readCaddyfile();
  // The catch-all reverse_proxy (without @media or @api matcher) handles /*
  const lines = caddyfile.split('\n');
  const catchAllIndex = lines.findIndex(line => 
    line.includes('reverse_proxy media-search:3000') && 
    !line.includes('@media') && 
    !line.includes('@api')
  );
  assert.ok(catchAllIndex >= 0, 'Should have a catch-all reverse_proxy for /*');
});

// ---------------------------------------------------------------------------
// Test: Range headers survive proxy traversal
// ---------------------------------------------------------------------------

test('Range headers pass through to upstream by default', () => {
  const caddyfile = readCaddyfile();
  // Caddy reverse_proxy forwards request headers unchanged by default, so
  // Range/conditional headers reach media-search without explicit
  // directives. The contract, checked on the catch-all block that serves
  // /media/*: no Range stripping or fabrication there.
  const lines = caddyfile.split('\n');
  const catchAllIndex = lines.findIndex(line =>
    line.includes('reverse_proxy media-search:3000') &&
    !line.includes('@media') &&
    !line.includes('@api')
  );
  assert.ok(catchAllIndex >= 0, 'catch-all reverse_proxy exists');
  const catchAllBlock = lines.slice(catchAllIndex, catchAllIndex + 25).join('\n');
  assert.doesNotMatch(catchAllBlock, /header_down.*Range/i);
  assert.doesNotMatch(catchAllBlock, /bytes=/);
  assert.doesNotMatch(catchAllBlock, /content-range/i);
  // The API block explicitly forwards Range upstream.
  assert.match(caddyfile, /header_up Range/);
});

// ---------------------------------------------------------------------------
// Test: Media responses are not buffered
// ---------------------------------------------------------------------------

test('Media responses stream without proxy buffering', () => {
  const caddyfile = readCaddyfile();
  // Caddy streams proxied responses by default. The contract is the
  // absence of buffering directives anywhere in the file.
  assert.doesNotMatch(caddyfile, /flush_interval/);
  assert.doesNotMatch(caddyfile, /request_body.*buffer|response.*buffer/i);
});

// ---------------------------------------------------------------------------
// Test: Error responses pass through unchanged
// ---------------------------------------------------------------------------

test('Error responses pass through (no response modification)', () => {
  const caddyfile = readCaddyfile();
  // No response body modification directives
  assert.doesNotMatch(caddyfile, /replace/);
  assert.doesNotMatch(caddyfile, /rewrite/);
  // No status code override
  assert.doesNotMatch(caddyfile, /handle_error/);
  assert.doesNotMatch(caddyfile, /error/);
});

// ---------------------------------------------------------------------------
// Test: Internal headers are stripped
// ---------------------------------------------------------------------------

test('Internal headers (X-Resolver-*, X-Internal-*) are stripped from responses', () => {
  const caddyfile = readCaddyfile();
  assert.match(caddyfile, /header_down -X-Resolver-\*/);
  assert.match(caddyfile, /header_down -X-Internal-\*/);
});

// ---------------------------------------------------------------------------
// Test: Proxy does not parse Range headers
// ---------------------------------------------------------------------------

test('Proxy does not parse Range headers (no Range manipulation)', () => {
  const caddyfile = readCaddyfile();
  // No Range parsing logic — only forwarding
  assert.doesNotMatch(caddyfile, /bytes=/);
  assert.doesNotMatch(caddyfile, /parse.*range/i);
  assert.doesNotMatch(caddyfile, /content-range/i);
});

// ---------------------------------------------------------------------------
// Test: Proxy does not calculate Content-Length
// ---------------------------------------------------------------------------

test('Proxy does not set Content-Length', () => {
  const caddyfile = readCaddyfile();
  // No Content-Length manipulation
  assert.doesNotMatch(caddyfile, /Content-Length/);
  assert.doesNotMatch(caddyfile, /content.length/i);
});

// ---------------------------------------------------------------------------
// Test: Proxy does not determine Content-Type
// ---------------------------------------------------------------------------

test('Proxy does not set Content-Type', () => {
  const caddyfile = readCaddyfile();
  // No Content-Type manipulation
  assert.doesNotMatch(caddyfile, /Content-Type/);
  assert.doesNotMatch(caddyfile, /content.type/i);
});

// ---------------------------------------------------------------------------
// Test: Proxy does not resolve identities
// ---------------------------------------------------------------------------

test('Proxy does not resolve identities (no info_hash/file_index logic)', () => {
  const caddyfile = readCaddyfile();
  // No info_hash or file_index variables or path parameters
  assert.doesNotMatch(caddyfile, /\binfo_hash\b/);
  assert.doesNotMatch(caddyfile, /\bfile_index\b/);
  // No resolver endpoint patterns (but X-Resolver-* header stripping is OK)
  assert.doesNotMatch(caddyfile, /resolver\s*{/i);
  assert.doesNotMatch(caddyfile, /resolver\s+media-search/);
});

// ---------------------------------------------------------------------------
// Test: Proxy does not access SQLite
// ---------------------------------------------------------------------------

test('Proxy does not access SQLite or databases', () => {
  const caddyfile = readCaddyfile();
  assert.doesNotMatch(caddyfile, /sqlite/i);
  assert.doesNotMatch(caddyfile, /\.db/);
  assert.doesNotMatch(caddyfile, /database/i);
});

// ---------------------------------------------------------------------------
// Test: Proxy does not read filesystem mounts
// ---------------------------------------------------------------------------

test('Proxy does not read filesystem mounts', () => {
  const caddyfile = readCaddyfile();
  // Only the Caddyfile itself is mounted — no data volumes
  const compose = fs.readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8');
  const edgeBlock = compose.match(/edge:[\s\S]*?(?=\n  \w|\nvolumes:|$)/);
  assert.ok(edgeBlock, 'Should find edge service block');
  // No /data or /downloads mounts in edge service
  assert.doesNotMatch(edgeBlock[0], /\/data\//);
  assert.doesNotMatch(edgeBlock[0], /\/downloads\//);
});

// ---------------------------------------------------------------------------
// Test: Proxy does not call provider APIs
// ---------------------------------------------------------------------------

test('Proxy does not call provider APIs', () => {
  const caddyfile = readCaddyfile();
  assert.doesNotMatch(caddyfile, /torbox/i);
  assert.doesNotMatch(caddyfile, /realdebrid/i);
  assert.doesNotMatch(caddyfile, /api\.provider/i);
});

// ---------------------------------------------------------------------------
// Test: Proxy is stateless
// ---------------------------------------------------------------------------

test('Proxy is stateless (no caching, no state files)', () => {
  const caddyfile = readCaddyfile();
  assert.doesNotMatch(caddyfile, /cache/i);
  assert.doesNotMatch(caddyfile, /persist/i);
  assert.doesNotMatch(caddyfile, /state/i);
});

// ---------------------------------------------------------------------------
// Test: TLS is not implemented (deferred)
// ---------------------------------------------------------------------------

test('TLS is not implemented (auto_https off)', () => {
  const caddyfile = readCaddyfile();
  assert.match(caddyfile, /auto_https off/);
});

// ---------------------------------------------------------------------------
// Test: Auth is not implemented (deferred)
// ---------------------------------------------------------------------------

test('Authentication is not implemented', () => {
  const caddyfile = readCaddyfile();
  assert.doesNotMatch(caddyfile, /basicauth/i);
  assert.doesNotMatch(caddyfile, /auth/i);
});

// ---------------------------------------------------------------------------
// Test: Rate limiting is not implemented (deferred)
// ---------------------------------------------------------------------------

test('Rate limiting is not implemented', () => {
  const caddyfile = readCaddyfile();
  assert.doesNotMatch(caddyfile, /rate_limit/i);
  assert.doesNotMatch(caddyfile, /throttle/i);
});

// ---------------------------------------------------------------------------
// Test: Proxy runs as separate container
// ---------------------------------------------------------------------------

test('Proxy runs as separate container in compose', () => {
  const compose = readCompose();
  assert.match(compose, /edge:\s*\n\s*image:.*hashsucker-edge/);
  // Has its own service definition, ordered after media-search
  assert.match(compose, /depends_on:\s*\n\s*- media-search/);
});

// ---------------------------------------------------------------------------
// Test: Consolidated topology — everything backend-bound targets media-search:3000
// ---------------------------------------------------------------------------

test('Consolidated topology: all backend routes target media-search:3000', () => {
  const caddyfile = readCaddyfile();
  // No hardcoded IPs — Docker service name only.
  assert.doesNotMatch(caddyfile, /192\.168\./);
  assert.doesNotMatch(caddyfile, /127\.0\.0\.1/);
  assert.match(caddyfile, /media-search:3000/);
  // No split media-gateway backend: a single backend serves api + media.
  const backends = [...caddyfile.matchAll(/reverse_proxy\s+(?:@\w+\s+)?([a-z0-9.-]+:\d+)/gi)]
    .map((m) => m[1]);
  assert.ok(backends.length > 0, 'at least one backend route exists');
  assert.ok(backends.every((b) => b === 'media-search:3000'), 'single backend for all routes');
});

test('Consolidated topology: proxy does not assume co-location (EP-TOPO-2)', () => {
  const caddyfile = readCaddyfile();
  // No hardcoded IP addresses — must use Docker service name
  assert.doesNotMatch(caddyfile, /192\.168\./);
  assert.doesNotMatch(caddyfile, /127\.0\.0\.1/);
  // Must reference media-search by service name
  assert.match(caddyfile, /media-search:3000/);
});

test('Consolidated topology: single image carries the baked config', () => {
  // The edge image bakes the Caddyfile in (no repo mount at runtime), so
  // pulled deployments need no repo files. The compose build context and
  // the Dockerfile COPY are the contract.
  const compose = readCompose();
  assert.match(compose, /context: \.\/edge/);
  const dockerfile = fs.readFileSync(new URL('../../edge/Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY Caddyfile/);
});

// ---------------------------------------------------------------------------
// Test: Routing order is correct (media first, then api, then catch-all)
// ---------------------------------------------------------------------------

test('Routing order: /api/* first, then catch-all', () => {
  const caddyfile = readCaddyfile();
  const apiIndex = caddyfile.indexOf('@api');
  const catchAllIndex = caddyfile.lastIndexOf('reverse_proxy media-search:3000');

  assert.ok(apiIndex >= 0, '/api/* route should exist');
  assert.ok(catchAllIndex >= 0, 'catch-all route should exist');
  assert.ok(apiIndex < catchAllIndex, '/api/* should come before catch-all');
});

// ---------------------------------------------------------------------------
// Test: Contract compliance summary
// ---------------------------------------------------------------------------

test('Contract compliance: behavioral MUST NOTs hold on the live config', () => {
  // The retired contract doc's prohibitions are enforced directly against
  // the Caddyfile here (same assertions as the dedicated behavioral
  // tests above, aggregated as one compliance gate).
  const caddyfile = readCaddyfile();
  assert.doesNotMatch(caddyfile, /bytes=/, 'must not parse Range');
  assert.doesNotMatch(caddyfile, /Content-Length/, 'must not set Content-Length');
  assert.doesNotMatch(caddyfile, /Content-Type/, 'must not set Content-Type');
  assert.doesNotMatch(caddyfile, /sqlite/i, 'must not access SQLite');
  assert.doesNotMatch(caddyfile, /\.db/, 'must not access databases');
});

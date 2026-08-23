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
const CONTRACT_PATH = new URL('../docs/architecture/EDGE-PROXY-CONTRACT.md', import.meta.url);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readCaddyfile() {
  return fs.readFileSync(CADDYFILE_PATH, 'utf8');
}

function readContract() {
  return fs.readFileSync(CONTRACT_PATH, 'utf8');
}

// ---------------------------------------------------------------------------
// Test: Contract exists and is valid
// ---------------------------------------------------------------------------

test('EDGE-PROXY-CONTRACT.md exists and defines routing table', () => {
  const contract = readContract();
  assert.match(contract, /EP-ROUTE-1/);
  assert.match(contract, /EP-ROUTE-2/);
  assert.match(contract, /EP-ROUTE-3/);
  assert.match(contract, /MUST NOT.*parse.*Range/i);
  assert.match(contract, /MUST NOT.*access.*SQLite/i);
});

// ---------------------------------------------------------------------------
// Test: Caddyfile exists and has correct structure
// ---------------------------------------------------------------------------

test('Caddyfile exists and defines three route classes', () => {
  const caddyfile = readCaddyfile();
  assert.ok(caddyfile.length > 0, 'Caddyfile should not be empty');
  assert.match(caddyfile, /@media path \/media\/\*/);
  assert.match(caddyfile, /@api path \/api\/\*/);
  assert.match(caddyfile, /reverse_proxy media-search:3000/);
});

// ---------------------------------------------------------------------------
// Test: /media/* routes to media gateway
// ---------------------------------------------------------------------------

test('/media/* routes to media gateway backend', () => {
  const caddyfile = readCaddyfile();
  // /media/* must be routed to media-search:3000
  const mediaBlock = caddyfile.match(/@media[\s\S]*?reverse_proxy @media media-search:3000/);
  assert.ok(mediaBlock, '/media/* should route to media-search:3000');
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

test('Range headers are forwarded unchanged for /media/*', () => {
  const caddyfile = readCaddyfile();
  // Range header must be forwarded in the media block
  // Match the full reverse_proxy block (closing } at start of line)
  const mediaBlock = caddyfile.match(/@media[\s\S]*?reverse_proxy @media media-search:3000[\s\S]*?\n\}/);
  assert.ok(mediaBlock, 'Should find media block');
  assert.match(mediaBlock[0], /header_up Range/);
  assert.match(mediaBlock[0], /header_up If-Range/);
  assert.match(mediaBlock[0], /header_up If-Modified-Since/);
});

// ---------------------------------------------------------------------------
// Test: Media responses are not buffered
// ---------------------------------------------------------------------------

test('Media responses are not buffered (flush_interval -1)', () => {
  const caddyfile = readCaddyfile();
  const mediaBlock = caddyfile.match(/@media[\s\S]*?reverse_proxy @media media-search:3000[\s\S]*?\}/);
  assert.ok(mediaBlock, 'Should find media block');
  assert.match(mediaBlock[0], /flush_interval -1/);
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
  const compose = fs.readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8');
  assert.match(compose, /edge:\s*\n\s*image: caddy/);
  // Has its own service definition
  assert.match(compose, /depends_on:\s*\n\s*- media-search/);
});

// ---------------------------------------------------------------------------
// Test: Routing order is correct (media first, then api, then catch-all)
// ---------------------------------------------------------------------------

test('Routing order: /media/* first, then /api/*, then /*', () => {
  const caddyfile = readCaddyfile();
  const mediaIndex = caddyfile.indexOf('@media');
  const apiIndex = caddyfile.indexOf('@api');
  const catchAllIndex = caddyfile.lastIndexOf('reverse_proxy media-search:3000');
  
  assert.ok(mediaIndex >= 0, '/media/* route should exist');
  assert.ok(apiIndex >= 0, '/api/* route should exist');
  assert.ok(catchAllIndex >= 0, 'catch-all route should exist');
  assert.ok(mediaIndex < apiIndex, '/media/* should come before /api/*');
  assert.ok(apiIndex < catchAllIndex, '/api/* should come before catch-all');
});

// ---------------------------------------------------------------------------
// Test: Contract compliance summary
// ---------------------------------------------------------------------------

test('Contract compliance: all MUST NOT constraints are satisfied', () => {
  const caddyfile = readCaddyfile();
  const contract = readContract();
  
  // Extract all MUST NOT constraints from contract
  const mustNotConstraints = contract.match(/EP-FORBID-\d+.*\n.*MUST NOT.*/g) || [];
  
  // Verify each forbidden responsibility is not implemented
  for (const constraint of mustNotConstraints) {
    if (constraint.includes('parse.*Range') || constraint.includes('Range.*parse')) {
      assert.doesNotMatch(caddyfile, /bytes=/, 'Should not parse Range');
    }
    if (constraint.includes('Content-Length')) {
      assert.doesNotMatch(caddyfile, /Content-Length/, 'Should not set Content-Length');
    }
    if (constraint.includes('Content-Type')) {
      assert.doesNotMatch(caddyfile, /Content-Type/, 'Should not set Content-Type');
    }
    if (constraint.includes('SQLite') || constraint.includes('database')) {
      assert.doesNotMatch(caddyfile, /sqlite/i, 'Should not access SQLite');
    }
  }
});

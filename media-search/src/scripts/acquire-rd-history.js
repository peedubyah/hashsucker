#!/usr/bin/env node
/**
 * Acquire a Real-Debrid /torrents snapshot to an immutable local NDJSON
 * file. The output is suitable for the existing
 * import-historical-provider-evidence.js importer.
 *
 * Auth: RD_API_TOKEN env var, --api-key-file <path>, or --api-key <secret>
 *       (the last one is intentionally only for short-lived shells — we
 *        warn and refuse to log it).
 *
 * Output:
 *   <output>                       NDJSON with { infoHash, observedAt }
 *   <output>.manifest.json         Provenance manifest
 *
 * The acquirer NEVER writes to the discovery cache SQLite.
 *
 * Usage:
 *   node src/scripts/acquire-rd-history.js \
 *     --output /var/lib/hashsucker/snapshots/rd-history-2026-09-03.ndjson \
 *     [--page-size 1000] [--chunk-rows 200000] \
 *     [--api-base https://api.real-debrid.com/rest/1.0] \
 *     [--api-key-file /run/secrets/rd-token] \
 *     [--api-key-env RD_API_TOKEN]
 */

import fs from 'node:fs';
import path from 'node:path';
import { acquireRdHistory } from '../lib/acquisition/rd-history.js';

function parseArgs(argv) {
  const out = {
    pageSize: 1000,
    chunkRows: 200_000,
    apiBase: undefined,
    apiKeyFile: undefined,
    apiKeyEnv: 'RD_API_TOKEN',
    apiKey: undefined,
    output: undefined,
    timeoutMs: 30_000,
    maxRetries: 3,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--output' || a === '-o') { out.output = argv[++i]; continue; }
    if (a === '--page-size') { out.pageSize = Number(argv[++i]); continue; }
    if (a === '--chunk-rows') { out.chunkRows = Number(argv[++i]); continue; }
    if (a === '--api-base') { out.apiBase = argv[++i]; continue; }
    if (a === '--api-key-file') { out.apiKeyFile = argv[++i]; continue; }
    if (a === '--api-key-env') { out.apiKeyEnv = argv[++i]; continue; }
    if (a === '--api-key') { out.apiKey = argv[++i]; continue; }
    if (a === '--timeout-ms') { out.timeoutMs = Number(argv[++i]); continue; }
    if (a === '--max-retries') { out.maxRetries = Number(argv[++i]); continue; }
    if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    if (a.startsWith('--')) {
      throw new Error(`unknown flag: ${a}`);
    }
    throw new Error(`unexpected positional argument: ${a}`);
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: acquire-rd-history.js --output <path> [options]

  --output, -o <path>      NDJSON output path (required)
  --page-size <n>          Entries per /torrents request (max 5000, default 1000)
  --chunk-rows <n>         Spill chunk size for external sort (default 200000; 0=in-memory)
  --api-base <url>         Override RD base URL (default https://api.real-debrid.com/rest/1.0)
  --api-key-file <path>    Read bearer token from file (first line, stripped)
  --api-key-env <name>     Env var holding bearer token (default RD_API_TOKEN)
  --api-key <secret>       Pass token directly (avoids env). Use cautiously.
  --timeout-ms <n>         Per-request timeout (default 30000)
  --max-retries <n>        Per-request retry budget for transient failures (default 3)
`);
}

async function resolveApiKey(opts) {
  if (opts.apiKey) return opts.apiKey;
  if (opts.apiKeyFile) {
    const raw = fs.readFileSync(opts.apiKeyFile, 'utf8');
    const first = raw.split(/\r?\n/, 1)[0] || '';
    return first.trim();
  }
  if (opts.apiKeyEnv) {
    const v = process.env[opts.apiKeyEnv];
    if (v && v.length > 0) return v;
  }
  throw new Error('No RD API key resolved. Use --api-key-file, --api-key-env, or --api-key.');
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.output) {
    throw new Error('--output is required');
  }
  const apiKey = await resolveApiKey(args);
  const log = (msg) => process.stderr.write(`${msg}\n`);
  log(`[acquire-rd] output=${args.output} pageSize=${args.pageSize} chunkRows=${args.chunkRows}`);

  const result = await acquireRdHistory({
    apiKey,
    outputPath: path.resolve(args.output),
    pageSize: args.pageSize,
    chunkRows: args.chunkRows,
    apiBase: args.apiBase,
    timeoutMs: args.timeoutMs,
    maxRetries: args.maxRetries,
    log,
  });
  log(`[acquire-rd] wrote ${result.rowsAccepted} rows, rejected ${result.rowsRejected}, fetched ${result.pagesFetched} pages`);
  log(`[acquire-rd] manifest: ${result.manifestPath}`);
  process.stdout.write(JSON.stringify({
    rowsSeen: result.rowsSeen,
    rowsAccepted: result.rowsAccepted,
    rowsRejected: result.rowsRejected,
    pagesFetched: result.pagesFetched,
    outputPath: result.outputPath,
    manifestPath: result.manifestPath,
    outputSha256: result.manifest.outputSha256,
  }, null, 2) + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`acquire-rd-history failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

export { parseArgs, resolveApiKey, main };

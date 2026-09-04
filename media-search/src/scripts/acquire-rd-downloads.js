#!/usr/bin/env node
/**
 * Acquire a Real-Debrid /downloads snapshot to an immutable local NDJSON
 * file. The output is suitable for the
 * ingest-rd-downloads.js importer.
 *
 * /downloads is NOT canonical Release evidence (no infoHash, no
 * deterministic bridge to /torrents). The output is a raw observation
 * log only.
 *
 * Auth: REALDEBRID_API_KEY env var, --api-key-file <path>, or
 *       --api-key <secret>. The token is never printed.
 *
 * Usage:
 *   REALDEBRID_API_KEY=xxx node src/scripts/acquire-rd-downloads.js \
 *     --output /var/lib/hashsucker/snapshots/rd-downloads-2026-09-03.ndjson
 *
 *   # Or with explicit key file:
 *   node src/scripts/acquire-rd-downloads.js \
 *     --api-key-file /run/secrets/rd-token \
 *     --output /var/lib/hashsucker/snapshots/rd-downloads-2026-09-03.ndjson
 */
import { acquireRdDownloads } from '../lib/acquisition/rd-downloads.js';
import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    apiBase: undefined,
    apiKey: undefined,
    apiKeyFile: undefined,
    apiKeyEnv: undefined,
    output: undefined,
    pageSize: 5000,
    chunkRows: 200000,
    mergeFanIn: 64,
    timeoutMs: 30_000,
    maxRetries: 3,
    retryBaseMs: 500,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`flag ${a} requires a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case '--output':
      case '-o':
        args.output = next();
        break;
      case '--api-base':
        args.apiBase = next();
        break;
      case '--api-key':
        args.apiKey = next();
        break;
      case '--api-key-file':
        args.apiKeyFile = next();
        break;
      case '--api-key-env':
        args.apiKeyEnv = next();
        break;
      case '--page-size':
        args.pageSize = Number(next());
        break;
      case '--chunk-rows':
        args.chunkRows = Number(next());
        break;
      case '--merge-fan-in':
        args.mergeFanIn = Number(next());
        break;
      case '--timeout-ms':
        args.timeoutMs = Number(next());
        break;
      case '--max-retries':
        args.maxRetries = Number(next());
        break;
      case '--retry-base-ms':
        args.retryBaseMs = Number(next());
        break;
      case '-h':
      case '--help':
        args.help = true;
        break;
      default:
        if (a.startsWith('-')) {
          throw new Error(`unknown flag: ${a}`);
        }
        throw new Error(`unexpected positional argument: ${a}`);
    }
  }
  return args;
}

function resolveApiKey(args) {
  if (args.apiKey) {
    process.stderr.write('WARN: --api-key is for short-lived shells; the secret will be held in memory only\n');
    return args.apiKey;
  }
  if (args.apiKeyFile) {
    return fs.readFileSync(args.apiKeyFile, 'utf8').trim();
  }
  if (args.apiKeyEnv) {
    const v = process.env[args.apiKeyEnv];
    if (!v) throw new Error(`env ${args.apiKeyEnv} is not set`);
    return v;
  }
  // Try REALDEBRID_API_KEY (the canonical env var in this repo)
  const v = process.env.REALDEBRID_API_KEY;
  if (v) return v;
  throw new Error('No RD API key resolved. Use --api-key-file, --api-key-env, --api-key, or REALDEBRID_API_KEY env.');
}

const HELP = `acquire-rd-downloads

  Acquire a Real-Debrid /downloads snapshot to an immutable NDJSON file.

OPTIONS
  -o, --output <path>         Output NDJSON path (required)
      --api-base <url>        RD API base URL
      --api-key-file <path>   Read token from file
      --api-key-env <name>    Read token from env var
      --api-key <secret>      Token on the command line (short-lived shells only)
      --page-size <n>         Pagination size (default 5000)
      --chunk-rows <n>        Spill threshold; 0 = in-memory (default 200000)
      --merge-fan-in <n>      k-way merge fan-in (default 64)
      --timeout-ms <n>        Per-request timeout (default 30000)
      --max-retries <n>       Per-request retry budget (default 3)
      --retry-base-ms <n>     Backoff base (default 500)
  -h, --help                  Show this help

NOTES
  /downloads is NOT canonical Release evidence. The output is a raw
  observation log only; it is not written to historical_provider_evidence.

  RD /downloads is known to return HTTP 204 for offset=0. The acquirer
  starts pagination at offset=1 and uses X-Total-Count to bound the
  loop.`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || !args.output) {
    process.stderr.write(HELP + '\n');
    if (!args.help) throw new Error('--output is required');
    return null;
  }
  const apiKey = resolveApiKey(args);
  const log = (...a) => process.stderr.write('[acquire-rd-downloads] ' + a.join(' ') + '\n');
  const result = await acquireRdDownloads({
    apiKey,
    outputPath: path.resolve(args.output),
    apiBase: args.apiBase,
    pageSize: args.pageSize,
    chunkRows: args.chunkRows,
    mergeFanIn: args.mergeFanIn,
    timeoutMs: args.timeoutMs,
    maxRetries: args.maxRetries,
    retryBaseMs: args.retryBaseMs,
    log,
  });
  log(`wrote ${result.rowsAccepted} rows, rejected ${result.rowsRejected}, fetched ${result.pagesFetched} pages`);
  log(`manifest: ${result.manifestPath || result.outputPath + '.manifest.json'}`);
  process.stdout.write(JSON.stringify({
    rowsSeen: result.rowsSeen,
    rowsAccepted: result.rowsAccepted,
    rowsRejected: result.rowsRejected,
    pagesFetched: result.pagesFetched,
    outputPath: result.outputPath,
    manifestPath: result.outputPath + '.manifest.json',
    outputSha256: result.manifest.outputSha256,
    sourceVersion: result.manifest.sourceVersion,
  }, null, 2) + '\n');
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`acquire-rd-downloads failed: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}

export { parseArgs, resolveApiKey, HELP };

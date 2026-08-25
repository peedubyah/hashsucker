#!/usr/bin/env node
/**
 * Media Intent Provider CLI
 *
 * Discovers registered providers, lists their status, and executes intent fetching.
 * Serves as the reference implementation for the provider interface.
 *
 * Usage:
 *   npm run intents -- list
 *   npm run intents -- fetch --source cli --intents '[{"mediaId":"tt0182576","mediaType":"series","season":5,"episode":12}]'
 *   npm run intents -- stats
 */

import { createDiscoveryCache } from '../lib/discovery/cache.js';
import {
  MediaIntentProviderRegistry,
  CliIntentProvider,
  PlexIntentProvider,
  MediaIntentIngestionService,
  MediaIntentProcessor,
  getIntentStatus,
  getRecentProcessedIntents,
  getReprocessingNeeded,
  formatIntentStatus,
  formatIngestionSummary,
  formatProcessingSummary,
  INTENT_STATUS,
} from '../lib/intents/index.js';

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    command: null,
    source: null,
    provider: null,
    status: null,
    intents: null,
    limit: null,
    dryRun: false,
    dbPath: DB_PATH,
    output: null,
    verbose: false,
  };

  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source' && argv[i + 1]) { args.source = argv[++i]; }
    else if (a === '--provider' && argv[i + 1]) { args.provider = argv[++i]; }
    else if (a === '--status' && argv[i + 1]) { args.status = argv[++i]; }
    else if (a === '--intents' && argv[i + 1]) {
      try {
        args.intents = JSON.parse(argv[++i]);
      } catch (err) {
        console.error('Error: --intents must be valid JSON');
        process.exit(1);
      }
    }
    else if (a === '--limit' && argv[i + 1]) { args.limit = argv[++i]; }
    else if (a === '--dry-run') { args.dryRun = true; }
    else if (a === '--db' && argv[i + 1]) { args.dbPath = argv[++i]; }
    else if (a === '--output' && argv[i + 1]) { args.output = argv[++i]; }
    else if (a === '--verbose' || a === '-v') { args.verbose = true; }
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
    else if (!a.startsWith('--')) { positional.push(a); }
  }

  if (positional.length >= 1) {
    args.command = positional[0];
  }

  return args;
}

function printUsage() {
  console.log(`
Media Intent Provider CLI

Usage:
  npm run intents -- <command> [options]

Commands:
  list                  List all registered providers
  stats                 Show registry statistics
  status                Show intent lifecycle status
  fetch                 Fetch intents from providers
  sync                  Sync intents from providers (fetch + ingest)
  process               Process active intents through discovery pipeline
  validate              Validate intents without persisting

Options:
  --source <name>       Provider source to fetch from (for fetch command)
  --provider <name>     Provider to use (cli, plex) - for sync command
  --intents <json>      JSON array of intents (for fetch command)
  --limit <N>           Max intents to process (for process command)
  --dry-run             Don't persist results (for process command)
  --db <path>           Database path (default: :memory: or $DISCOVERY_DB)
  --output <path>       Write results to JSON file
  --verbose, -v         Print detailed output
  --help, -h            Show this help

Examples:
  npm run intents -- list
  npm run intents -- stats
  npm run intents -- fetch --source cli --intents '[{"mediaId":"tt0182576","mediaType":"series","season":5,"episode":12}]'
  npm run intents -- sync --provider cli --intents '[{"mediaId":"tt0182576","mediaType":"series","season":5,"episode":12}]'
  npm run intents -- sync --provider plex
  npm run intents -- process --limit 10
  npm run intents -- process --dry-run
  npm run intents -- status
`);
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function cmdList(registry) {
  const providers = registry.list();

  if (providers.length === 0) {
    console.log('No providers registered.');
    return;
  }

  console.log('Registered providers:');
  for (const p of providers) {
    const status = p.enabled ? 'enabled' : 'disabled';
    console.log(`  ${p.name} (${p.type}) — ${status}`);
  }
}

async function cmdStats(registry) {
  const stats = registry.getStats();
  const providers = registry.list();

  console.log('Provider Registry Statistics:');
  console.log(`  Total providers: ${stats.total}`);
  console.log(`  Enabled: ${stats.enabled}`);
  console.log(`  Disabled: ${stats.disabled}`);

  if (Object.keys(stats.byType).length > 0) {
    console.log('  By type:');
    for (const [type, count] of Object.entries(stats.byType)) {
      console.log(`    ${type}: ${count}`);
    }
  }

  if (providers.length > 0) {
    console.log('  Providers:');
    for (const p of providers) {
      console.log(`    ${p.name} (${p.type})`);
    }
  }
}

async function cmdFetch(registry, cache, args) {
  const providerName = args.source || 'cli';
  const provider = registry.get(providerName);

  if (!provider) {
    console.error(`Error: Provider "${providerName}" is not registered`);
    console.error('Run "list" command to see available providers.');
    process.exit(1);
  }

  console.log(`Fetching intents from "${providerName}"...`);

  const startedAt = Date.now();

  // Fetch intents
  const intents = await provider.fetchIntents({
    cache,
    log: args.verbose ? console.log : undefined,
    intents: args.intents,
  });

  const elapsedMs = Date.now() - startedAt;

  console.log(`Fetched ${intents.length} intents in ${elapsedMs}ms`);

  if (intents.length > 0) {
    console.log('\nIntents:');
    for (const intent of intents) {
      const scope = intent.season != null
        ? ` S${String(intent.season).padStart(2, '0')}${intent.episode != null ? `E${String(intent.episode).padStart(2, '0')}` : ''}`
        : '';
      console.log(`  ${intent.mediaId} (${intent.mediaType})${scope} — source=${intent.source}, priority=${intent.priority}`);
    }

    // Persist intents
    console.log('\nPersisting intents...');
    let persistedCount = 0;
    for (const intent of intents) {
      try {
        const intentId = cache.upsertMediaIntent({
          mediaId: intent.mediaId,
          mediaType: intent.mediaType,
          season: intent.season,
          episode: intent.episode,
          source: intent.source,
          sourceType: intent.sourceType,
          sourceId: intent.sourceId,
          sourceLabel: intent.sourceLabel,
          requestedBy: intent.requestedBy,
          priority: intent.priority,
        });
        persistedCount++;
        if (args.verbose) {
          console.log(`  Persisted: ${intent.mediaId} (intent_id=${intentId})`);
        }
      } catch (err) {
        console.error(`  Failed to persist ${intent.mediaId}: ${err.message}`);
      }
    }
    console.log(`Persisted ${persistedCount}/${intents.length} intents`);

    // Show current stats
    const stats = cache.getMediaIntentStats();
    console.log('\nIntent statistics:');
    console.log(`  Total intents: ${stats.total_intents}`);
    console.log(`  Active intents: ${stats.active_intents}`);
    console.log(`  Total requests: ${stats.total_requests}`);
    console.log(`  Unique media: ${stats.unique_media}`);
    console.log(`  Unique sources: ${stats.unique_sources}`);
  }

  // Write output if requested
  if (args.output) {
    const fs = await import('node:fs');
    const output = {
      timestamp: new Date().toISOString(),
      provider: providerName,
      intentCount: intents.length,
      intents,
      elapsedMs,
    };
    fs.writeFileSync(args.output, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\nResults written to ${args.output}`);
  }
}

async function cmdSync(registry, cache, args) {
  const providerName = args.provider || args.source || 'cli';
  const provider = registry.get(providerName);

  if (!provider) {
    console.error(`Error: Provider "${providerName}" is not registered`);
    console.error('Run "list" command to see available providers.');
    process.exit(1);
  }

  const ingestion = new MediaIntentIngestionService(cache, provider);

  console.log(`Syncing intents from "${providerName}"...`);

  const result = await ingestion.ingestFromProvider(
    provider,
    { intents: args.intents, log: args.verbose ? console.log : undefined },
    { log: args.verbose ? console.log : undefined }
  );

  console.log(`\nFetch: ${result.fetch.intentCount} intents in ${result.fetch.elapsedMs}ms`);
  console.log(formatIngestionSummary(result.ingestion));

  // Show current stats
  const stats = cache.getMediaIntentStats();
  console.log('\nIntent statistics:');
  console.log(`  Total intents: ${stats.total_intents}`);
  console.log(`  Active intents: ${stats.active_intents}`);
  console.log(`  Total requests: ${stats.total_requests}`);
  console.log(`  Unique media: ${stats.unique_media}`);
  console.log(`  Unique sources: ${stats.unique_sources}`);

  // Write output if requested
  if (args.output) {
    const fs = await import('node:fs');
    const output = {
      timestamp: new Date().toISOString(),
      command: 'sync',
      provider: providerName,
      fetch: result.fetch,
      ingestion: result.ingestion,
      stats,
    };
    fs.writeFileSync(args.output, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\nResults written to ${args.output}`);
  }
}

async function cmdStatus(cache, args) {
  const status = getIntentStatus(cache, {
    source: args.source || null,
    status: args.status || null,
  });
  const recent = getRecentProcessedIntents(cache, args.limit || 10);

  console.log(formatIntentStatus(status, recent));

  // Show reprocessing needed if verbose
  if (args.verbose) {
    const reprocess = getReprocessingNeeded(cache, { limit: 10 });
    if (reprocess.length > 0) {
      console.log('\nNeeds reprocessing:');
      for (const intent of reprocess) {
        const label = intent.label || intent.mediaId;
        const reason = intent.lastError ? 'error' : intent.lastProcessedAt ? 'stale' : 'never processed';
        console.log(`- ${label} (${intent.source}) — ${reason}`);
      }
    }
  }

  // Write output if requested
  if (args.output) {
    const fs = await import('node:fs');
    const output = {
      timestamp: new Date().toISOString(),
      command: 'status',
      status,
      recent,
    };
    fs.writeFileSync(args.output, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\nResults written to ${args.output}`);
  }
}

async function cmdProcess(cache, args) {
  const limit = args.limit ? parseInt(args.limit, 10) : 50;
  const dryRun = args.dryRun || false;

  const processor = new MediaIntentProcessor(cache);

  if (dryRun) {
    console.log('DRY RUN - no results will be persisted');
  }

  console.log(`Processing active intents (limit=${limit})...`);

  const result = await processor.process({
    limit,
    dryRun,
    log: args.verbose ? console.log : undefined,
  });

  console.log(`\n${formatProcessingSummary(result)}`);

  // Show current stats
  const stats = processor.getStats();
  console.log('\nProcessing statistics:');
  console.log(`  Total intents: ${stats.totalIntents}`);
  console.log(`  Active intents: ${stats.activeIntents}`);
  console.log(`  Processed intents: ${stats.processedIntents}`);
  console.log(`  Error intents: ${stats.errorIntents}`);
  console.log(`  Total results: ${stats.totalResults}`);

  // Write output if requested
  if (args.output) {
    const fs = await import('node:fs');
    const output = {
      timestamp: new Date().toISOString(),
      command: 'process',
      result,
      stats,
    };
    fs.writeFileSync(args.output, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\nResults written to ${args.output}`);
  }
}

async function cmdValidate(registry, args) {
  const providerName = args.source || 'cli';
  const provider = registry.get(providerName);

  if (!provider) {
    console.error(`Error: Provider "${providerName}" is not registered`);
    process.exit(1);
  }

  if (!args.intents) {
    console.error('Error: --intents is required for validate command');
    process.exit(1);
  }

  console.log(`Validating ${args.intents.length} intents...`);

  const results = [];
  let validCount = 0;
  let invalidCount = 0;

  for (const raw of args.intents) {
    try {
      const normalized = provider.normalizeRawIntent ? provider.normalizeRawIntent(raw) : raw;
      const validated = provider.validateIntent(normalized);
      results.push({ raw, validated, valid: true });
      validCount++;
    } catch (err) {
      results.push({ raw, error: err.message, valid: false });
      invalidCount++;
    }
  }

  console.log(`\nValidation results:`);
  console.log(`  Valid: ${validCount}`);
  console.log(`  Invalid: ${invalidCount}`);

  if (invalidCount > 0) {
    console.log('\nInvalid intents:');
    for (const r of results.filter(r => !r.valid)) {
      console.log(`  ${JSON.stringify(r.raw)}: ${r.error}`);
    }
  }

  if (args.output) {
    const fs = await import('node:fs');
    const output = {
      timestamp: new Date().toISOString(),
      provider: providerName,
      total: args.intents.length,
      valid: validCount,
      invalid: invalidCount,
      results,
    };
    fs.writeFileSync(args.output, JSON.stringify(output, null, 2), 'utf-8');
    console.log(`\nResults written to ${args.output}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.command) {
    console.error('Error: command is required');
    printUsage();
    process.exit(1);
  }

  // Open cache
  const cache = createDiscoveryCache(args.dbPath !== ':memory:' ? { dbPath: args.dbPath } : {});

  try {
    // Create registry and register providers
    const registry = new MediaIntentProviderRegistry();

    // Always register CLI provider
    const cliProvider = new CliIntentProvider({
      enabled: true,
      intents: args.intents || [],
    });
    await registry.register(cliProvider, { cache });

    // Register Plex provider if configured or requested
    const plexUrl = process.env.PLEX_URL;
    const plexToken = process.env.PLEX_TOKEN;
    if (plexUrl && plexToken) {
      const plexProvider = new PlexIntentProvider({
        url: plexUrl,
        token: plexToken,
        username: process.env.PLEX_USERNAME,
        enabled: true,
      });
      await registry.register(plexProvider, { cache });
   }

    // Execute command
    switch (args.command) {
      case 'list':
        await cmdList(registry);
        break;
      case 'stats':
        await cmdStats(registry);
        break;
      case 'fetch':
        await cmdFetch(registry, cache, args);
        break;
      case 'validate':
        await cmdValidate(registry, args);
        break;
      case 'sync':
        await cmdSync(registry, cache, args);
        break;
      case 'process':
        await cmdProcess(cache, args);
        break;
      case 'status':
        await cmdStatus(cache, args);
        break;
      default:
        console.error(`Error: unknown command "${args.command}"`);
        printUsage();
        process.exit(1);
    }
  } finally {
    cache.close();
  }
}

main().catch(err => {
  console.error(`Fatal error: ${err.message}`);
  process.exit(1);
});

#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const OUTPUT_PATH = 'docs/project-state.md';
const GENERATOR_PATH = 'scripts/update-project-state.mjs';
const GENERATED_AT_MARKER = '__GENERATED_AT__';
const REQUIRED_PATHS = [
  'README.md',
  'HANDOFF.md',
  'compose.yaml',
  'docs/roadmap.md',
  'docs/known-gaps.md',
  'docs/audit/8-21-audit.md',
  'media-search/package.json',
  'media-search/src/lib/discovery/cache.js',
  'media-search/src/lib/discovery/dmm-ingestion-runner.js',
  'media-search/src/lib/discovery/adapters/dmm.js',
  'media-search/src/lib/ingestion/dmm.js',
  'media-search/src/server/app.js',
  'torbox-importer/scripts/db-init.sh',
  'torbox-importer/validate-request.sh',
  'ui/package.json',
];
const CANONICAL_DOCUMENTS = [
  ['Durable handoff', 'HANDOFF.md'],
  ['Project entry point', 'README.md'],
  ['Architecture', 'docs/architecture.md'],
  ['Data model', 'docs/data-model.md'],
  ['Pipeline', 'docs/pipeline.md'],
  ['Roadmap', 'docs/roadmap.md'],
  ['Known gaps', 'docs/known-gaps.md'],
  ['Audit evidence baseline', 'docs/audit/8-21-audit.md'],
  ['Current HTTP contract', 'media-search/src/api/API_CONTRACT.md'],
];

function fail(message) {
  console.error(`project-state: ${message}`);
  process.exit(1);
}

function runGit(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = error.stderr?.trim();
    fail(detail ? `Git failed: ${detail}` : `Git failed: git ${args.join(' ')}`);
  }
}

function oneMatch(text, regex, description) {
  const matches = [...text.matchAll(regex)];
  if (matches.length !== 1) {
    fail(`expected exactly one ${description}; found ${matches.length}`);
  }
  return matches[0];
}

function markdownCode(value) {
  return `\`${String(value).replaceAll('`', '\\`')}\``;
}

function tableNames(schema) {
  return [...schema.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)]
    .map((match) => match[1])
    .sort((left, right) => left.localeCompare(right));
}

function isSensitiveOrRuntimePath(relativePath) {
  const parts = relativePath.split('/');
  const basename = parts.at(-1);

  if (parts.some((part) => ['node_modules', 'data', 'dist'].includes(part))) return true;
  if (basename === '.env') return true;
  if (basename?.startsWith('.env.') && basename !== '.env.example') return true;
  if (basename?.endsWith('.local.json')) return true;
  return false;
}

async function repositoryInputs(root) {
  const listed = runGit(
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    root,
  ).split('\0').filter(Boolean);

  return [...new Set(listed)]
    .filter((relativePath) => relativePath !== OUTPUT_PATH)
    .filter((relativePath) => !relativePath.startsWith(`${OUTPUT_PATH}.`))
    .filter((relativePath) => !isSensitiveOrRuntimePath(relativePath))
    .sort((left, right) => left.localeCompare(right));
}

async function fingerprintInputs(root, inputs) {
  const hash = createHash('sha256');
  hash.update('hashsucker-project-state-v1\0');

  for (const relativePath of inputs) {
    const absolutePath = path.join(root, relativePath);
    hash.update(relativePath);
    hash.update('\0');

    try {
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        hash.update('symlink\0');
        hash.update(await readFile(absolutePath));
      } else if (metadata.isFile()) {
        hash.update(metadata.mode & 0o111 ? 'file+x\0' : 'file\0');
        hash.update(await readFile(absolutePath));
      } else {
        hash.update('other\0');
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      hash.update('missing\0');
    }
    hash.update('\0');
  }

  return hash.digest('hex');
}

async function parsePackage(root, relativePath) {
  const contents = await readFile(path.join(root, relativePath), 'utf8');
  try {
    return JSON.parse(contents);
  } catch (error) {
    fail(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function parseComposeServices(compose) {
  const services = [];
  let inServices = false;

  for (const line of compose.split('\n')) {
    if (line === 'services:') {
      inServices = true;
      continue;
    }
    if (inServices && /^\S/.test(line)) break;
    const match = inServices ? line.match(/^  ([a-zA-Z0-9_-]+):\s*$/) : null;
    if (match) services.push(match[1]);
  }

  if (services.length === 0) fail('no services found in compose.yaml');
  return services;
}

async function directProviderModules(root) {
  const providerDirectory = path.join(root, 'media-search/src/lib/providers');
  try {
    return (await readdir(providerDirectory))
      .filter((entry) => entry.endsWith('.js'))
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function findRuntimeDmmImports(root, inputs) {
  const importers = [];
  for (const relativePath of inputs) {
    if (!relativePath.startsWith('media-search/src/') || !relativePath.endsWith('.js')) continue;
    if (relativePath === 'media-search/src/lib/ingestion/dmm.js') continue;
    const contents = await readFile(path.join(root, relativePath), 'utf8');
    if (/from\s+['"][^'"]*ingestion\/dmm\.js['"]/.test(contents)) {
      importers.push(relativePath);
    }
  }
  return importers.sort((left, right) => left.localeCompare(right));
}

function normalizeExisting(content) {
  const regex = /^- Generated at \(UTC\): `([^`]+)`$/gm;
  const matches = [...content.matchAll(regex)];
  if (matches.length !== 1 || Number.isNaN(Date.parse(matches[0][1]))) return null;
  return content.replace(matches[0][0], `- Generated at (UTC): \`${GENERATED_AT_MARKER}\``);
}

async function renderState(root, generatedAt) {
  const inputs = await repositoryInputs(root);
  const fingerprint = await fingerprintInputs(root, inputs);
  const read = (relativePath) => readFile(path.join(root, relativePath), 'utf8');

  const [
    roadmap,
    compose,
    discoverySchema,
    metadataSchema,
    importerSchema,
    handoffSource,
    requestValidator,
    serverApp,
    dmmRunner,
    dmmAdapter,
    dmmImporter,
    liveBridge,
    stremioSearch,
    unifiedMetadata,
    backendPackage,
    uiPackage,
    providerModules,
    runtimeDmmImports,
  ] = await Promise.all([
    read('docs/roadmap.md'),
    read('compose.yaml'),
    read('media-search/src/lib/discovery/cache.js'),
    read('media-search/src/lib/discovery/media-metadata.js'),
    read('torbox-importer/scripts/db-init.sh'),
    read('media-search/src/lib/requests/handoff.js'),
    read('torbox-importer/validate-request.sh'),
    read('media-search/src/server/app.js'),
    read('media-search/src/lib/discovery/dmm-ingestion-runner.js'),
    read('media-search/src/lib/discovery/adapters/dmm.js'),
    read('media-search/src/lib/ingestion/dmm.js'),
    read('media-search/src/lib/discovery/live-bridge.js'),
    read('media-search/src/lib/stremio/search.js'),
    read('media-search/src/lib/metadata/unified-search.js'),
    parsePackage(root, 'media-search/package.json'),
    parsePackage(root, 'ui/package.json'),
    directProviderModules(root),
    findRuntimeDmmImports(root, inputs),
  ]);

  const roadmapSource = oneMatch(
    roadmap,
    /^\*\*Source:\*\* \[[^\]]+\]\(([^)]+)\), verified (\d{4}-\d{2}-\d{2})\.\s*$/gm,
    'roadmap source header',
  );
  const currentStage = oneMatch(
    roadmap,
    /^\*\*Current stage:\*\* (Stage (\d+)) (?:—|-) (.+)\.\s*$/gm,
    'current roadmap stage header',
  );
  const stage3OutputBoundary = oneMatch(
    roadmap,
    /^\*\*Stage 3 output boundary:\*\* (.+)\.\s*$/gm,
    'Stage 3 output boundary',
  );
  const stage3RetrievalDecision = oneMatch(
    roadmap,
    /^\*\*Stage 3 retrieval decision:\*\* (.+)\.\s*$/gm,
    'Stage 3 retrieval decision',
  );
  const stageNumbers = [...roadmap.matchAll(/^## Stage (\d+) (?:—|-) .+$/gm)]
    .map((match) => Number(match[1]));
  if (stageNumbers.length === 0) fail('no roadmap stage headings found');

  const roadmapSourcePath = path.posix.normalize(path.posix.join('docs', roadmapSource[1]));
  const composeServices = parseComposeServices(compose);
  const discoveryTables = tableNames(discoverySchema);
  const metadataTables = tableNames(metadataSchema);
  const importerTables = tableNames(importerSchema);
  const allSchemas = `${discoverySchema}\n${metadataSchema}\n${importerSchema}`;
  const schemaVersionRecorded = /user_version|schema_version|CREATE\s+TABLE[^;]*migrations?/i.test(allSchemas);
  const protocolProducer = oneMatch(handoffSource, /^\s+version:\s*(\d+),\s*$/gm, 'request handoff producer version');
  const protocolConsumer = oneMatch(requestValidator, /^\s*\.version\s*==\s*(\d+)\s*$/gm, 'request handoff consumer version');
  if (protocolProducer[1] !== protocolConsumer[1]) {
    fail(`request handoff version mismatch: producer ${protocolProducer[1]}, consumer ${protocolConsumer[1]}`);
  }

  const routeUsesRunner = serverApp.includes("import { runDMMIngestion } from '../lib/discovery/dmm-ingestion-runner.js';")
    && serverApp.includes("url.pathname === '/api/ingest/dmm'")
    && serverApp.includes('await runDMMIngestion({');
  const runnerUsesScriptWrapper = dmmRunner.includes("html.match(/decompressFromEncodedURIComponent\\(['\"]([^'\"]+)['\"]\\)/)");
  const adapterUsesIframeHash = dmmAdapter.includes('export function extractHashFragment(html)')
    && dmmAdapter.includes('debridmediamanager\\.com\\/hashlist#');
  const compatibleImporterUsesAdapter = dmmImporter.includes('extractHashFragment,')
    && dmmImporter.includes('const fragment = extractHashFragment(html);');
  const ingestLifecycleTables = [...new Set([...discoveryTables, ...metadataTables, ...importerTables])]
    .filter((name) => /ingest|checkpoint|source_revision/i.test(name));

  const metadataWired = unifiedMetadata.includes("import { createCinemetaAdapter } from './cinemeta-adapter.js';")
    && unifiedMetadata.includes('providers = [createCinemetaAdapter()]');
  const stremioWired = liveBridge.includes("import { searchStremio } from '../stremio/search.js';")
    && liveBridge.includes('searchStremio({');
  const torznabWired = liveBridge.includes("import { searchTorznab } from '../torznab/torznab.js';")
    && liveBridge.includes('searchTorznab({');
  const directTorboxImportedByActiveBridge = /providers\/torbox/.test(`${serverApp}\n${liveBridge}`);
  const rootHasImporter = composeServices.includes('torbox-importer');
  const directRealDebrid = providerModules.some((moduleName) => /real.?debrid|realdebrid|rd\./i.test(moduleName));

  const canonicalDocumentRows = CANONICAL_DOCUMENTS.map(([role, relativePath]) => {
    if (!inputs.includes(relativePath)) fail(`canonical document is not repository-visible: ${relativePath}`);
    return `| ${role} | [${markdownCode(relativePath)}](../${relativePath}) |`;
  }).join('\n');

  const integrationRows = [
    ['Cinemeta metadata', metadataWired ? 'implemented and wired to active title/media lookup' : 'not detected on active lookup path', 'optional `CINEMETA_BASE_URL`', 'unknown'],
    ['Torrentio / TorBox discovery', stremioWired && stremioSearch.includes("addon_id: 'torrentio.torbox'") ? 'implemented on live discovery path' : 'not detected', 'required `TORBOX_API_KEY` in root Compose', 'unknown'],
    ['Torrentio / Real-Debrid discovery', stremioWired && stremioSearch.includes("addon_id: 'torrentio.realdebrid'") ? 'discovery-only implementation' : 'not detected', 'optional `REALDEBRID_API_KEY`', 'unknown'],
    ['Comet discovery', stremioWired && stremioSearch.includes("addon_id: 'comet.manual'") ? 'implemented on Stremio discovery path' : 'not detected', 'optional `COMET_MANIFEST_URL`', 'unknown'],
    ['Torznab discovery', torznabWired ? 'implemented on live discovery path' : 'not detected', 'optional `TORZNAB_URLS`', 'unknown'],
    ['Direct TorBox cache adapter', providerModules.includes('torbox.js') ? (directTorboxImportedByActiveBridge ? 'implemented and imported by active server/live bridge' : 'implemented; not imported by active server/live bridge') : 'not detected', '`TORBOX_API_KEY`', 'unknown'],
    ['TorBox physical fulfillment', rootHasImporter ? 'implemented by `torbox-importer`' : 'not detected in root Compose', 'required TorBox/importer paths in root Compose', 'unknown'],
    ['Sonarr physical import', rootHasImporter && compose.includes('SONARR_URL:') ? 'implemented/configured surface' : 'not detected', 'required `SONARR_URL` and `SONARR_API_KEY`', 'unknown'],
    ['Radarr physical import', rootHasImporter && compose.includes('RADARR_URL:') ? 'implemented/configured surface' : 'not detected', 'required `RADARR_URL` and `RADARR_API_KEY`', 'unknown'],
    ['Direct Real-Debrid provider adapter', directRealDebrid ? 'implementation module detected' : 'not detected', 'discovery key is not a direct adapter', 'not recorded'],
    ['Zurg / rclone / provider WebDAV / Plex', composeServices.some((service) => /zurg|rclone|webdav|plex/i.test(service)) ? 'service detected in root Compose' : 'not detected in root Compose', 'none detected', 'not recorded'],
  ].map((row) => `| ${row.join(' | ')} |`).join('\n');

  const backendTest = backendPackage.scripts?.test;
  const uiTest = uiPackage.scripts?.test;
  if (!backendTest || !uiTest) fail('both package manifests must define a test script');

  return `# Generated project state

<!-- MACHINE-GENERATED by ${GENERATOR_PATH}; DO NOT EDIT. -->

This is the machine-maintained companion to [\`HANDOFF.md\`](../HANDOFF.md). It reports only reproducible repository facts and explicit unknowns. It does not prove live runtime, provider, deployment, or test health.

- Generated at (UTC): \`${generatedAt}\`
- Generator: [\`${GENERATOR_PATH}\`](../${GENERATOR_PATH})
- Repository root: \`.\` (the Git top-level containing this file)
- State input fingerprint: \`sha256:${fingerprint}\`
- Fingerprinted repository paths: \`${inputs.length}\`

## Authority and ownership

| Responsibility | Owner | Contents |
|---|---|---|
| Durable project truth | Human-maintained canonical documents | Product north star, architecture boundaries, invariants, authority, roadmap intent, and constraints agents must not casually redesign |
| Current integration facts | This machine-maintained document | Reproducible facts derived from the current repository checkout |
| Agent/task coordination | Future task system, not this document | Agent ownership, active task/issue, branch/worktree ownership, and acceptance state |

Worker branches/worktrees do not routinely regenerate or commit this file. The canonical integration/root workflow regenerates it after accepted changes are merged. If a generated-file conflict occurs, regenerate from the integrated tree instead of hand-merging it.

## Repository snapshot

- Content identity: verified by the state input fingerprint above.
- Root Compose services: ${composeServices.map(markdownCode).join(', ')}.
- Backend package: ${markdownCode(`${backendPackage.name}@${backendPackage.version}`)}.
- Frontend package: ${markdownCode(`${uiPackage.name}@${uiPackage.version}`)}.
- Current branch: **not recorded** — branch names are checkout/worktree-local.
- Current commit SHA and subject: **not recorded** — a versioned generated file cannot truthfully contain the SHA of the commit that contains itself.
- Working-tree/index status: **not recorded** — staging and dirtiness are checkout-local; changed repository content is represented by the fingerprint.
- Recent commits: **not recorded** — use Git directly when commit history is required.

## Roadmap state

- Authority: [\`${roadmapSourcePath}\`](../${roadmapSourcePath}), verified \`${roadmapSource[2]}\` by [\`docs/roadmap.md\`](roadmap.md).
- Current stage: **${currentStage[1]} — ${currentStage[3]}**.
- Stage 3 output boundary: **${stage3OutputBoundary[1]}**.
- Stage 3 retrieval decision: **${stage3RetrievalDecision[1]}**.
- Stage status beyond these explicit roadmap statements: **not recorded**.
- Defined stages: \`${Math.min(...stageNumbers)}\` through \`${Math.max(...stageNumbers)}\` (\`${stageNumbers.length}\` headings).
- Recently completed stages/milestones beyond Stage 3: **not recorded**.

## Tests and checks

| Scope | Command | Manifest implementation | Most recent recorded result |
|---|---|---|---|
| Backend | \`cd media-search && npm test\` | \`${backendTest}\` | **not recorded** |
| Frontend | \`cd ui && npm test\` | \`${uiTest}\` | **not recorded** |
| Importer bridge check | \`torbox-importer/tests/movie-request-bridge.sh\` | standalone shell test | **not recorded** |

- Known failing tests: **not recorded**.
- No test command is executed by this updater.
- Documentation claims and prior terminal/chat output are intentionally not converted into recorded test results.

## Schema and protocol facts

| Scope | Source | Derived fact |
|---|---|---|
| Active discovery database | [\`media-search/src/lib/discovery/cache.js\`](../media-search/src/lib/discovery/cache.js) | tables: ${discoveryTables.map(markdownCode).join(', ')} |
| Media metadata storage module | [\`media-search/src/lib/discovery/media-metadata.js\`](../media-search/src/lib/discovery/media-metadata.js) | tables: ${metadataTables.map(markdownCode).join(', ')}; not imported by the active server metadata path |
| Physical importer database | [\`torbox-importer/scripts/db-init.sh\`](../torbox-importer/scripts/db-init.sh) | tables: ${importerTables.map(markdownCode).join(', ')} |
| Database schema version | active schema sources | **${schemaVersionRecorded ? 'version marker detected' : 'not recorded; no migration table or schema/user version marker detected'}** |
| Request handoff protocol | producer and validator | version \`${protocolProducer[1]}\` |

## DMM ingestion static status

- API route: ${routeUsesRunner ? 'implemented and wired to `runDMMIngestion()`' : '**not detected**'} in [\`media-search/src/server/app.js\`](../media-search/src/server/app.js).
- Runtime-reachable extractor: ${runnerUsesScriptWrapper ? 'script-call wrapper (`decompressFromEncodedURIComponent(...)`)' : '**unknown**'} in [\`media-search/src/lib/discovery/dmm-ingestion-runner.js\`](../media-search/src/lib/discovery/dmm-ingestion-runner.js).
- Current iframe/hash-compatible extractor: ${adapterUsesIframeHash ? 'implemented' : '**not detected**'} in [\`media-search/src/lib/discovery/adapters/dmm.js\`](../media-search/src/lib/discovery/adapters/dmm.js).
- Compatible cache importer: ${compatibleImporterUsesAdapter ? 'implemented' : '**not detected**'} in [\`media-search/src/lib/ingestion/dmm.js\`](../media-search/src/lib/ingestion/dmm.js).
- Compatible importer runtime wiring: ${runtimeDmmImports.length === 0 ? '**not detected outside its own module**' : runtimeDmmImports.map(markdownCode).join(', ')}.
- Persisted run/source revision/fragment checkpoint schema: ${ingestLifecycleTables.length === 0 ? '**not detected**' : ingestLifecycleTables.map(markdownCode).join(', ')}.
- Last successful ingestion, corpus size, throughput, and source revision: **not recorded**.

No DMM source, corpus, remote API, or database workload is contacted by this updater.

## Integration inventory

“Implemented” means source code is present and, where stated, statically wired. A configuration surface does not prove that credentials are set, a service is deployed, or an integration is healthy.

| Integration | Static implementation status | Configuration surface | Runtime/deployment health |
|---|---|---|---|
${integrationRows}

- Direct provider adapter modules found: ${providerModules.length ? providerModules.map(markdownCode).join(', ') : '**none**'}.
- Runtime configuration values are never read or emitted by this updater.

## Canonical document locations

| Role | Document |
|---|---|
${canonicalDocumentRows}

[\`docs/archive/\`](archive/) and [\`handoff/\`](../handoff/) are excluded as current authority.

## Generation contract

- Update: \`node ${GENERATOR_PATH}\`
- Check without writing: \`node ${GENERATOR_PATH} --check\`
- Inputs: Git-visible repository files from the current working tree, plus exact parsing of package manifests, root Compose, active schema/protocol sources, DMM wiring, provider modules, and the canonical roadmap header.
- Exclusions: this output file, temporary output files, \`node_modules/\`, \`data/\`, \`dist/\`, non-example \`.env*\` files, and \`*.local.json\`.
- Side effects: writes only [\`${OUTPUT_PATH}\`](project-state.md), atomically, and only when semantic content changed.
- Network/provider/product/database operations: none.
`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--check') || args.filter((arg) => arg === '--check').length > 1) {
    fail(`usage: node ${GENERATOR_PATH} [--check]`);
  }
  const checkOnly = args.includes('--check');

  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let cwd;
  try {
    cwd = await realpath(process.cwd());
  } catch (error) {
    fail(`cannot resolve current directory: ${error.message}`);
  }
  const gitRoot = await realpath(runGit(['rev-parse', '--show-toplevel'], cwd).trim());
  const expectedRoot = await realpath(scriptRoot);

  if (cwd !== gitRoot || gitRoot !== expectedRoot) {
    fail(`run from the expected repository root: ${expectedRoot}`);
  }

  for (const relativePath of REQUIRED_PATHS) {
    try {
      const metadata = await lstat(path.join(gitRoot, relativePath));
      if (!metadata.isFile()) fail(`required file is not a regular file: ${relativePath}`);
    } catch (error) {
      if (error.code === 'ENOENT') fail(`required repository file is missing: ${relativePath}`);
      throw error;
    }
  }

  const outputPath = path.join(gitRoot, OUTPUT_PATH);
  let existing = null;
  try {
    existing = await readFile(outputPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const expectedTemplate = await renderState(gitRoot, GENERATED_AT_MARKER);
  const normalizedExisting = existing === null ? null : normalizeExisting(existing);

  if (checkOnly) {
    if (normalizedExisting !== expectedTemplate) {
      fail(`${OUTPUT_PATH} is missing or stale; run: node ${GENERATOR_PATH}`);
    }
    console.log(`project-state: current (${OUTPUT_PATH})`);
    return;
  }

  if (normalizedExisting === expectedTemplate) {
    console.log(`project-state: unchanged (${OUTPUT_PATH})`);
    return;
  }

  const next = await renderState(gitRoot, new Date().toISOString());
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, next, { encoding: 'utf8', mode: 0o644 });
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  console.log(`project-state: updated (${OUTPUT_PATH})`);
}

main().catch((error) => fail(error.stack || error.message));

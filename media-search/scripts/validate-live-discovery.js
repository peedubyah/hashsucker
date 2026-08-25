#!/usr/bin/env node
/**
 * Validate live discovery integration against real cases.
 *
 * Tests:
 *   - Family Guy S05E12 (tt0182576) - should trigger live discovery
 *   - Star Wars Young Jedi Adventures S01E01 (tt0458290) - should trigger live discovery
 *   - Bicycle Thieves (tt0040522) - should work without live discovery (corpus success)
 *
 * Usage:
 *   node scripts/validate-live-discovery.js [--skip-live] [--skip-availability]
 */

import { createDiscoveryCache } from '../src/lib/discovery/cache.js';
import { searchByMedia } from '../src/api/media-request.js';
import { runLiveDiscovery } from '../src/lib/discovery/live-bridge.js';

const DB_PATH = process.env.DISCOVERY_DB || ':memory:';

const TEST_CASES = [
  {
    name: 'Bicycle Thieves (movie - corpus success path)',
    request: { mediaId: 'tt0040522', mediaType: 'movie', mediaTitle: 'Bicycle Thieves' },
    expectLiveDiscovery: false,
  },
  {
    name: 'Family Guy S05E12 (series - needs live discovery)',
    request: { mediaId: 'tt0182576', mediaType: 'series', season: 5, episode: 12, mediaTitle: 'Family Guy' },
    expectLiveDiscovery: true,
  },
  {
    name: 'Star Wars Young Jedi Adventures S01E01 (series - needs live discovery)',
    request: { mediaId: 'tt0458290', mediaType: 'series', season: 1, episode: 1, mediaTitle: 'Star Wars Young Jedi Adventures' },
    expectLiveDiscovery: true,
  },
];

function parseArgs(argv) {
  const args = { skipLive: false, skipAvailability: false, verbose: false };
  for (const a of argv) {
    if (a === '--skip-live') args.skipLive = true;
    else if (a === '--skip-availability') args.skipAvailability = true;
    else if (a === '--verbose') args.verbose = true;
    else if (a === '--help' || a === '-h') { printUsage(); process.exit(0); }
  }
  return args;
}

function printUsage() {
  console.log(`
Live Discovery Validation Script

Usage:
  node scripts/validate-live-discovery.js [options]

Options:
  --skip-live          Skip live discovery fallback
  --skip-availability  Skip TorBox availability check
  --verbose            Show full result details
  --help, -h           Show this help

Environment:
  DISCOVERY_DB         Path to discovery database
  TORBOX_API_KEY       TorBox API key for availability checks
`);
}

function formatSource(s) {
  if (!s || !Array.isArray(s)) return '-';
  return s.map(src => src.origin || 'unknown').join(', ');
}

function formatTopCandidate(r) {
  const torbox = r.availability?.torbox;
  const torboxState = torbox ? torbox.state : 'not-checked';
  return {
    rank: r.rank,
    filename: r.filename,
    source: formatSource(r.sources),
    identityTier: r.identity?.tier,
    eligible: r.identity?.eligible,
    ineligibleReason: r.identity?.ineligibleReason,
    score: r.score?.toFixed(3),
    torbox: torboxState,
  };
}

async function runValidation() {
  const args = parseArgs(process.argv.slice(2));
  const cache = createDiscoveryCache(DB_PATH !== ':memory:' ? { dbPath: DB_PATH } : {});

  let totalPassed = 0;
  let totalFailed = 0;

  for (const testCase of TEST_CASES) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`TEST: ${testCase.name}`);
    console.log(`${'='.repeat(70)}`);

    try {
      const startedAt = Date.now();

      // First, check corpus only (skip live discovery to see what corpus has)
      const corpusResult = await searchByMedia(cache, {
        ...testCase.request,
        skipLiveDiscovery: true,
        skipAvailability: true,
        persist: false,
      });

      console.log(`\nCorpus Only:`);
      console.log(`  Candidates: ${corpusResult.total}`);
      console.log(`  Eligible: ${corpusResult.identitySummary.eligibleCount}`);
      console.log(`  Ineligible: ${corpusResult.identitySummary.ineligibleCount}`);
      console.log(`  Ineligible codes: ${JSON.stringify(corpusResult.identitySummary.ineligibleByCode)}`);

      // Now run with full pipeline
      const result = await searchByMedia(cache, {
        ...testCase.request,
        skipLiveDiscovery: args.skipLive,
        skipAvailability: args.skipAvailability,
        persist: false,
        limit: 50,
      });

      const duration = Date.now() - startedAt;

      console.log(`\nFull Pipeline:`);
      console.log(`  Discovery triggered: ${result.discovery.liveDiscoveryTriggered}`);
      console.log(`  Live candidates: ${result.discovery.liveCandidates}`);
      console.log(`  Live eligible: ${result.discovery.liveEligible}`);
      console.log(`  Total candidates: ${result.total}`);
      console.log(`  Eligible: ${result.identitySummary.eligibleCount}`);
      console.log(`  Ineligible: ${result.identitySummary.ineligibleCount}`);
      console.log(`  Availability checked: ${result.availability.checked}`);
      console.log(`  Cached: ${result.availability.cached}`);
      console.log(`  Uncached: ${result.availability.uncached}`);
      console.log(`  Unknown: ${result.availability.unknown}`);
      console.log(`  Duration: ${duration}ms`);

      // Selection
      const sel = result.selection;
      console.log(`\n  Selection:`);
      console.log(`    Reason: ${sel.reason}`);
      if (sel.selected) {
        console.log(`    Selected: rank=${sel.selected.rank}, filename=${sel.selected.filename}`);
        console.log(`      source: ${sel.selected.sources?.join(', ')}, tier: ${sel.selected.identityTier}, confidence: ${sel.selected.identityConfidence}`);
        console.log(`      torbox: ${sel.selected.torboxState}`);
        console.log(`      score: ${sel.selected.score?.toFixed(3)}`);
      } else {
        console.log(`    Selected: none`);
      }
      console.log(`    Alternates: ${sel.alternates.length}`);

      // Top 5 eligible candidates
      const eligible = result.results.filter(r => r.identity.eligible !== false);
      console.log(`\n  Top 5 eligible candidates:`);
      for (const r of eligible.slice(0, 5)) {
        const formatted = formatTopCandidate(r);
        console.log(`    #${formatted.rank} ${formatted.filename}`);
        console.log(`      source: ${formatted.source}, tier: ${formatted.identityTier}, score: ${formatted.score}, torbox: ${formatted.torbox}`);
      }

      // Top ineligible (for diagnostics)
      const ineligible = result.results.filter(r => r.identity.eligible === false);
      if (ineligible.length > 0) {
        console.log(`\n  Ineligible candidates: ${ineligible.length}`);
        for (const r of ineligible.slice(0, 3)) {
          console.log(`    #${r.rank} ${r.filename} - ${r.identity.ineligibleCode}: ${r.identity.ineligibleReason}`);
        }
      }

      // Validate expectations
      let passed = true;
      const failures = [];

      if (testCase.expectLiveDiscovery && !args.skipLive) {
        if (!result.discovery.liveDiscoveryTriggered) {
          passed = false;
          failures.push('Expected live discovery to be triggered but it was not');
        }
      }

      if (!testCase.expectLiveDiscovery && corpusResult.total > 0) {
        // Corpus success path - live discovery should NOT trigger
        if (result.discovery.liveDiscoveryTriggered) {
          passed = false;
          failures.push('Live discovery should not trigger when corpus has eligible candidates');
        }
      }

      if (passed) {
        console.log(`\n  ✓ PASSED`);
        totalPassed++;
      } else {
        console.log(`\n  ✗ FAILED:`);
        for (const f of failures) {
          console.log(`    - ${f}`);
        }
        totalFailed++;
      }

      if (args.verbose) {
        console.log(`\n  Full results (verbose):`);
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      console.error(`\n  ✗ ERROR: ${error.message}`);
      if (args.verbose) {
        console.error(error.stack);
      }
      totalFailed++;
    }
  }

  console.log(`\n${'='.repeat(70)}`);
  console.log(`SUMMARY: ${totalPassed} passed, ${totalFailed} failed`);
  console.log(`${'='.repeat(70)}`);

  cache.close();
  process.exit(totalFailed > 0 ? 1 : 0);
}

runValidation();

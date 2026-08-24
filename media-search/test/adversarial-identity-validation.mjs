/**
 * Adversarial Identity Validation
 * 
 * Tests tier boundaries with real-world adversarial cases.
 * Verifies tier assignments match expected confidence levels.
 */

import assert from 'node:assert/strict';
import {
  classifyIdentityTier,
  rankHitsTiered,
  diagnoseIdentityEvidence,
} from '../src/lib/discovery/ranking.js';

const HASH = (n) => 'a'.repeat(40) + n;

// ============================================================
// ADVERSARIAL TEST CASES
// ============================================================

const cases = [
  // === VERIFIED TIER ===
  {
    name: 'Verified: corpus with media association + season/episode match',
    hit: {
      hash: HASH('1'),
      filename: 'NCIS.S01E01.720p.BluRay.x264',
      relevance: 0.9,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '720p', sourceType: 'BluRay' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.95 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.98 }],
    },
    expectedTier: 'Verified',
    expectedConfidence: { min: 0.9, max: 1.0 },
  },
  {
    name: 'Verified: corpus with media association, no season/episode',
    hit: {
      hash: HASH('2'),
      filename: 'NCIS.Complete.Series',
      relevance: 0.7,
      releaseAttributes: { title: 'NCIS' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.95 }],
    },
    expectedTier: 'Verified',
    expectedConfidence: { min: 0.8, max: 1.0 },
  },

  // === PROVIDERCONFIRMED TIER ===
  {
    name: 'ProviderConfirmed: live scoped + strong title match',
    hit: {
      hash: HASH('3'),
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      relevance: 0.75,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'live', evidence: [], confidence: 0.6 }],
      selectedMediaId: 'tt0364845',
    },
    expectedTier: 'ProviderConfirmed',
    expectedConfidence: { min: 0.7, max: 0.9 },
  },
  {
    name: 'ProviderConfirmed: live scoped + matching season/episode',
    hit: {
      hash: HASH('4'),
      filename: 'Show.S01E01.1080p',
      relevance: 0.4,
      releaseAttributes: { season: 1, episode: 1 },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    expectedTier: 'ProviderConfirmed',
    expectedConfidence: { min: 0.7, max: 0.9 },
  },

  // === PROVIDERSCOPED TIER (the garbage-in-garbage-out problem) ===
  {
    name: 'ProviderScoped: live scoped but garbage filename',
    hit: {
      hash: HASH('5'),
      filename: '[TORRENT🧲] Comet 1080p',
      relevance: 0.0,
      releaseAttributes: { title: '[TORRENT🧲] Comet 1080p', resolution: '1080p', sourceType: 'WEBRip' },
      sources: [{ origin: 'live', evidence: [], confidence: 0.3 }],
      selectedMediaId: 'tt0364845',
    },
    expectedTier: 'ProviderScoped',
    expectedConfidence: { min: 0.3, max: 0.5 },
  },
  {
    name: 'ProviderScoped: live scoped but wrong season',
    hit: {
      hash: HASH('6'),
      filename: 'Show.S05E12.720p',
      relevance: 0.3,
      releaseAttributes: { season: 5, episode: 12 },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    expectedTier: 'ProviderScoped',
    expectedConfidence: { min: 0.3, max: 0.5 },
  },
  {
    name: 'ProviderScoped: live scoped but no parsed metadata',
    hit: {
      hash: HASH('7'),
      filename: 'random_release_name.mkv',
      relevance: 0.1,
      releaseAttributes: {},
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    expectedTier: 'ProviderScoped',
    expectedConfidence: { min: 0.3, max: 0.5 },
  },

  // === PROBABLE TIER ===
  {
    name: 'Probable: corpus strong title match, no media association',
    hit: {
      hash: HASH('8'),
      filename: 'NCIS.S01E01.2160p.BluRay',
      relevance: 0.95,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '2160p', sourceType: 'BluRay' },
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
      mediaAssociations: [],
    },
    expectedTier: 'Probable',
    expectedConfidence: { min: 0.5, max: 0.8 },
  },
  {
    name: 'Probable: live not scoped to media',
    hit: {
      hash: HASH('9'),
      filename: 'NCIS.S01E01.WEB-DL.mkv',
      relevance: 0.8,
      releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    },
    expectedTier: 'Probable',
    expectedConfidence: { min: 0.4, max: 0.6 },
  },

  // === TEXTONLY TIER ===
  {
    name: 'TextOnly: weak text match only',
    hit: {
      hash: HASH('10'),
      filename: 'some_random_show.mkv',
      relevance: 0.15,
      releaseAttributes: {},
      sources: [{ origin: 'corpus', evidence: [], confidence: 0.3 }],
      mediaAssociations: [],
    },
    expectedTier: 'TextOnly',
    expectedConfidence: { min: 0.1, max: 0.3 },
  },

  // === EDGE CASES ===
  {
    name: 'ProviderScoped: live scoped with title but relevance exactly 0.59',
    hit: {
      hash: HASH('11'),
      filename: 'NCIS.1080p',
      relevance: 0.59,
      releaseAttributes: { title: 'NCIS', resolution: '1080p' },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    expectedTier: 'ProviderScoped',
    expectedConfidence: { min: 0.3, max: 0.5 },
  },
  {
    name: 'ProviderConfirmed: live scoped with relevance exactly 0.6',
    hit: {
      hash: HASH('12'),
      filename: 'NCIS.1080p',
      relevance: 0.6,
      releaseAttributes: { title: 'NCIS', resolution: '1080p' },
      sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
      selectedMediaId: 'tt0364845',
    },
    expectedTier: 'ProviderConfirmed',
    expectedConfidence: { min: 0.7, max: 0.9 },
  },
];

// ============================================================
// RUN VALIDATION
// ============================================================

console.log('=== ADVERSARIAL IDENTITY VALIDATION ===\n');

let pass = 0;
let fail = 0;
const failures = [];

for (const tc of cases) {
  const result = classifyIdentityTier(tc.hit, { season: 1, episode: 1 }, 'tt0364845');
  
  const tierOk = result.IdentityTier === tc.expectedTier;
  const confOk = result.IdentityConfidence >= tc.expectedConfidence.min && 
                 result.IdentityConfidence <= tc.expectedConfidence.max;
  
  if (tierOk && confOk) {
    pass++;
    console.log(`✓ ${tc.name}`);
    console.log(`  Tier: ${result.IdentityTier} (${result.IdentityConfidence.toFixed(2)})`);
  } else {
    fail++;
    failures.push(tc.name);
    console.log(`✗ ${tc.name}`);
    if (!tierOk) console.log(`  EXPECTED TIER: ${tc.expectedTier}, GOT: ${result.IdentityTier}`);
    if (!confOk) console.log(`  EXPECTED CONFIDENCE: ${tc.expectedConfidence.min}-${tc.expectedConfidence.max}, GOT: ${result.IdentityConfidence.toFixed(2)}`);
  }
}

console.log(`\n=== RESULTS: ${pass} pass, ${fail} fail ===`);

// ============================================================
// TIER PRECEDENCE VALIDATION
// ============================================================

console.log('\n=== TIER PRECEDENCE VALIDATION ===\n');

const precedenceHits = [
  // TextOnly (lowest)
  {
    hash: HASH('20'),
    filename: 'random.mkv',
    relevance: 0.1,
    releaseAttributes: {},
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.3 }],
  },
  // ProviderScoped (live scoped, garbage filename)
  {
    hash: HASH('21'),
    filename: 'garbage.mkv',
    relevance: 0.1,
    releaseAttributes: {},
    sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    selectedMediaId: 'tt0364845',
  },
  // Probable (strong title match)
  {
    hash: HASH('22'),
    filename: 'NCIS.S01E01.2160p.mkv',
    relevance: 0.95,
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '2160p' },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.9 }],
  },
  // ProviderConfirmed (live scoped + strong identity)
  {
    hash: HASH('23'),
    filename: 'NCIS.S01E01.WEB-DL.mkv',
    relevance: 0.7,
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1 },
    sources: [{ origin: 'live', evidence: [], confidence: 0.5 }],
    selectedMediaId: 'tt0364845',
  },
  // Verified (corpus + media association)
  {
    hash: HASH('24'),
    filename: 'NCIS.S01E01.720p.mkv',
    relevance: 0.8,
    releaseAttributes: { title: 'NCIS', season: 1, episode: 1, resolution: '720p' },
    sources: [{ origin: 'corpus', evidence: [], confidence: 0.95 }],
    mediaAssociations: [{ mediaId: 'tt0364845', confidence: 0.98 }],
  },
];

const { ranked, tierMeta } = rankHitsTiered(precedenceHits, { season: 1, episode: 1 }, 'tt0364845');

console.log('Rank ordering:');
for (let i = 0; i < ranked.length; i++) {
  const r = ranked[i];
  const tier = classifyIdentityTier(r, { season: 1, episode: 1 }, 'tt0364845');
  console.log(`  ${i+1}. [${tier.IdentityTier}] ${r.filename} (score=${r.score?.toFixed(3)})`);
}

console.log('\nTier counts:', tierMeta.TierCounts);

// Verify ordering
const tierOrder = ranked.map(r => classifyIdentityTier(r, { season: 1, episode: 1 }, 'tt0364845').IdentityTier);
const expectedOrder = ['Verified', 'ProviderConfirmed', 'Probable', 'ProviderScoped', 'TextOnly'];
const orderingCorrect = JSON.stringify(tierOrder) === JSON.stringify(expectedOrder);

if (orderingCorrect) {
  console.log('✓ Tier precedence ordering correct');
  pass++;
} else {
  console.log(`✗ Tier precedence WRONG: ${JSON.stringify(tierOrder)}`);
  failures.push('Tier precedence ordering');
  fail++;
}

// ============================================================
// DIAGNOSTIC EVIDENCE VALIDATION
// ============================================================

console.log('\n=== DIAGNOSTIC EVIDENCE VALIDATION ===\n');

const scopedHit = {
  hash: HASH('30'),
  filename: '[TORRENT🧲] Comet 1080p',
  relevance: 0.0,
  releaseAttributes: { title: '[TORRENT🧲] Comet 1080p', resolution: '1080p' },
  sources: [{ origin: 'live', evidence: [], confidence: 0.3 }],
  selectedMediaId: 'tt0364845',
};

const diag = diagnoseIdentityEvidence(scopedHit, { season: 1, episode: 1 }, 'tt0364845');
console.log('ProviderScoped diagnostic:');
console.log(`  Tier: ${diag.IdentityTier}`);
console.log(`  MediaId scope: ${JSON.stringify(diag.EvidenceSources.MediaId_scope)}`);
console.log(`  Title match: ${JSON.stringify(diag.EvidenceSources.Title_match)}`);
console.log(`  Promotion failure: ${JSON.stringify(diag.promotionFailure)}`);

if (diag.promotionFailure && diag.promotionFailure.failures.length > 0) {
  console.log('✓ Promotion failure diagnostic present');
  pass++;
} else {
  console.log('✗ Missing promotion failure diagnostic');
  failures.push('Promotion failure diagnostic');
  fail++;
}

// ============================================================
// SUMMARY
// ============================================================

console.log(`\n=== FINAL RESULTS: ${pass} pass, ${fail} fail ===`);

if (fail > 0) {
  console.log('\nFailures:');
  failures.forEach(f => console.log(`  - ${f}`));
  process.exit(1);
}

/**
 * Historical Provider Prior — Provider Attempt Ordering Proof Tests
 *
 * Proves that the historical provider prior influences provider attempt
 * ordering AFTER a release/file has been selected, without affecting
 * eligibility or fulfillment semantics.
 *
 * Proof tests (spec section "PROOF — PROVIDER ORDER"):
 *
 *   P10. No evidence → existing provider order unchanged (TorBox first)
 *   P11. RD historical only → RD can be attempted first
 *   P12. TorBox historical only → TorBox can be attempted first
 *   P13. RD historical + fresh RD negative → RD historical prior does not override fresh negative
 *   P14. Independent RD historical sources > one TorBox historical source → ordering follows bounded projection
 *   P15. Whichever provider goes second remains eligible for fallback → ordering is not exclusion
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { createAlternateFallback } from '../src/lib/resolver/alternate-fallback.js';
import { historicalAvailabilityPriorContribution } from '../src/lib/discovery/confidence-projection.js';

// =============================================================================
// P10. No evidence → existing provider order unchanged
// =============================================================================
test('P10. No evidence → existing provider order unchanged (TorBox first)', () => {
  const fallback = createAlternateFallback({
    searchCache: {},
    revalidator: {},
  });

  // Empty historical priors → default order preserved
  const order = fallback.determineProviderAttemptOrder({});
  assert.deepEqual(order, ['torbox', 'realdebrid']);

  // Undefined priors → default order preserved
  const orderUndef = fallback.determineProviderAttemptOrder();
  assert.deepEqual(orderUndef, ['torbox', 'realdebrid']);

  // Zero priors → default order preserved
  const orderZero = fallback.determineProviderAttemptOrder({ torbox: 0, realdebrid: 0 });
  assert.deepEqual(orderZero, ['torbox', 'realdebrid']);
});

// =============================================================================
// P11. RD historical only → RD can be attempted first
// =============================================================================
test('P11. RD historical only → RD can be attempted first', () => {
  const fallback = createAlternateFallback({
    searchCache: {},
    revalidator: {},
  });

  // RD has historical prior, TorBox has none
  const order = fallback.determineProviderAttemptOrder({ torbox: 0, realdebrid: 0.2 });
  assert.deepEqual(order, ['realdebrid', 'torbox']);
});

// =============================================================================
// P12. TorBox historical only → TorBox can be attempted first
// =============================================================================
test('P12. TorBox historical only → TorBox can be attempted first', () => {
  const fallback = createAlternateFallback({
    searchCache: {},
    revalidator: {},
  });

  // TorBox has historical prior, RD has none
  // Default is TorBox first, so this should still be TorBox first
  const order = fallback.determineProviderAttemptOrder({ torbox: 0.2, realdebrid: 0 });
  assert.deepEqual(order, ['torbox', 'realdebrid']);
});

// =============================================================================
// P13. RD historical + fresh RD negative → RD historical prior does not override fresh negative
// =============================================================================
test('P13. RD historical + fresh RD negative → RD historical prior does not override fresh negative', () => {
  // When fresh negative exists for RD, the historical prior for RD should be 0
  // (suppressed by fresh negative). So even if RD had historical evidence,
  // the fresh negative suppresses it, and TorBox should be tried first.
  const projection = {
    freshProvider: 'negative',
    availabilityPrior: 0.2,
    corroboration: 1,
  };
  const rdPrior = historicalAvailabilityPriorContribution(projection);
  assert.equal(rdPrior, 0, 'RD historical prior should be 0 when fresh negative exists');

  const fallback = createAlternateFallback({
    searchCache: {},
    revalidator: {},
  });

  // With RD prior suppressed by fresh negative, order should be default (TorBox first)
  const order = fallback.determineProviderAttemptOrder({ torbox: 0, realdebrid: rdPrior });
  assert.deepEqual(order, ['torbox', 'realdebrid']);
});

// =============================================================================
// P14. Independent RD historical sources > one TorBox historical source → ordering follows bounded projection
// =============================================================================
test('P14. Independent RD historical sources > one TorBox historical source → ordering follows bounded projection', () => {
  const fallback = createAlternateFallback({
    searchCache: {},
    revalidator: {},
  });

  // RD has more independent sources → higher bounded prior
  // RD: 2 independent sources → 0.20 + 0.05 = 0.25
  // TorBox: 1 source → 0.20
  const order = fallback.determineProviderAttemptOrder({ torbox: 0.20, realdebrid: 0.25 });
  assert.deepEqual(order, ['realdebrid', 'torbox']);
});

// =============================================================================
// P15. Whichever provider goes second remains eligible for fallback → ordering is not exclusion
// =============================================================================
test('P15. Whichever provider goes second remains eligible for fallback → ordering is not exclusion', () => {
  const fallback = createAlternateFallback({
    searchCache: {},
    revalidator: {},
  });

  // When RD goes first, TorBox is still in the order (as fallback)
  const orderRDFirst = fallback.determineProviderAttemptOrder({ torbox: 0, realdebrid: 0.3 });
  assert.deepEqual(orderRDFirst, ['realdebrid', 'torbox']);
  assert.ok(orderRDFirst.includes('torbox'), 'TorBox must still be in the order');

  // When TorBox goes first, RD is still in the order (as fallback)
  const orderTorBoxFirst = fallback.determineProviderAttemptOrder({ torbox: 0.1, realdebrid: 0 });
  assert.deepEqual(orderTorBoxFirst, ['torbox', 'realdebrid']);
  assert.ok(orderTorBoxFirst.includes('realdebrid'), 'RD must still be in the order');

  // Both providers always present regardless of order
  const allOrders = [
    fallback.determineProviderAttemptOrder({}),
    fallback.determineProviderAttemptOrder({ torbox: 0.5 }),
    fallback.determineProviderAttemptOrder({ realdebrid: 0.5 }),
    fallback.determineProviderAttemptOrder({ torbox: 0.3, realdebrid: 0.3 }),
  ];
  for (const order of allOrders) {
    assert.equal(order.length, 2, 'Both providers must always be in the order');
    assert.ok(order.includes('torbox'), 'TorBox must always be in the order');
    assert.ok(order.includes('realdebrid'), 'RD must always be in the order');
  }
});

// =============================================================================
// Edge cases
// =============================================================================
test('determineProviderAttemptOrder: equal priors → TorBox first (default)', () => {
  const fallback = createAlternateFallback({
    searchCache: {},
    revalidator: {},
  });

  // Equal priors → default order (TorBox first)
  const order = fallback.determineProviderAttemptOrder({ torbox: 0.2, realdebrid: 0.2 });
  assert.deepEqual(order, ['torbox', 'realdebrid']);
});

test('determineProviderAttemptOrder: RD slightly higher → RD first', () => {
  const fallback = createAlternateFallback({
    searchCache: {},
    revalidator: {},
  });

  // RD slightly higher → RD first
  const order = fallback.determineProviderAttemptOrder({ torbox: 0.2, realdebrid: 0.21 });
  assert.deepEqual(order, ['realdebrid', 'torbox']);
});

test('historicalAvailabilityPriorContribution: fresh positive suppresses prior', () => {
  const proj = { freshProvider: 'positive', availabilityPrior: 0.4, corroboration: 2 };
  assert.equal(historicalAvailabilityPriorContribution(proj), 0);
});

test('historicalAvailabilityPriorContribution: fresh negative suppresses prior', () => {
  const proj = { freshProvider: 'negative', availabilityPrior: 0.4, corroboration: 2 };
  assert.equal(historicalAvailabilityPriorContribution(proj), 0);
});

test('historicalAvailabilityPriorContribution: stale suppresses prior', () => {
  const proj = { freshProvider: 'stale', availabilityPrior: 0.4, corroboration: 2 };
  assert.equal(historicalAvailabilityPriorContribution(proj), 0);
});

test('historicalAvailabilityPriorContribution: null fresh + one source → bounded prior', () => {
  const proj = { freshProvider: null, availabilityPrior: 0.20, corroboration: 1 };
  assert.equal(historicalAvailabilityPriorContribution(proj), 0.20);
});

test('historicalAvailabilityPriorContribution: null fresh + two sources → prior + corroboration bonus', () => {
  const proj = { freshProvider: null, availabilityPrior: 0.20, corroboration: 2 };
  // 0.20 + 0.05 (one extra family) = 0.25
  assert.equal(historicalAvailabilityPriorContribution(proj), 0.25);
});

test('historicalAvailabilityPriorContribution: capped at maxPrior', () => {
  const proj = { freshProvider: null, availabilityPrior: 0.50, corroboration: 3 };
  // Should be capped at 0.40
  assert.equal(historicalAvailabilityPriorContribution(proj), 0.40);
});

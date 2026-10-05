import test from 'node:test';
import assert from 'node:assert/strict';
import { depositEquivalentToman } from '../src/rental-pricing.js';

test('converts monthly rent into its deposit equivalent and adds the deposit', () => {
  assert.equal(depositEquivalentToman({ deposit_toman: 500_000_000, rent_toman: 10_000_000 }), 800_000_000);
});

test('keeps deposit-only listings comparable', () => {
  assert.equal(depositEquivalentToman({ deposit_toman: 750_000_000 }), 750_000_000);
});

test('converts rent-only listings and falls back to the generic price', () => {
  assert.equal(depositEquivalentToman({ rent_toman: 10_000_000 }), 300_000_000);
  assert.equal(depositEquivalentToman({ price_toman: 420_000_000 }), 420_000_000);
});
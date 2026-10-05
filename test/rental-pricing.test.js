import test from 'node:test';
import assert from 'node:assert/strict';
import { depositEquivalentToman } from '../src/rental-pricing.js';
import { neighborhoodFromText, regionForNeighborhood } from '../src/tehran-region-map.js';

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

test('maps known Tehran neighborhoods and leaves ambiguous names unassigned', () => {
  assert.equal(regionForNeighborhood('آبشار', 'abshar'), 12);
  assert.equal(regionForNeighborhood('آهنگ', 'ahang'), 14);
  assert.equal(regionForNeighborhood('ابوذر', 'abouzar'), null);
  assert.equal(regionForNeighborhood('ناشناخته', 'unknown-place'), null);
});

test('recovers one clearly mentioned neighborhood but rejects multiple places', () => {
  const neighborhoods = [
    { slug: 'haft-hoz', name_fa: 'هفت حوض' },
    { slug: 'abshar', name_fa: 'آبشار' }
  ];
  assert.deepEqual(neighborhoodFromText('آگهی نزدیک هفت حوض', neighborhoods), {
    slug: 'haft-hoz', region_id: 8, length: 6
  });
  assert.equal(neighborhoodFromText('هفت حوض و آبشار', neighborhoods), null);
});
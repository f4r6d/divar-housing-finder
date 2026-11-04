import test from 'node:test';
import assert from 'node:assert/strict';
import { aiCallBudgets, neighborhoodTarget, tehranClock } from '../src/quota.js';
import { depositEquivalentToman, RENT_TO_DEPOSIT_MULTIPLIER } from '../src/rental-pricing.js';
import { isSharedHousingListing } from '../src/listing-classification.js';
import { extractListingsFromApiResponse } from '../src/scraper.js';

test('Verification: Tehran Clock matches UTC+3:30 schedule boundaries', () => {
  // Morning run: 06:30 UTC -> 10:00 Tehran
  const morningUtc = new Date('2026-11-04T06:30:00.000Z');
  const morningTehran = tehranClock(morningUtc);
  assert.equal(morningTehran.hour, 10, '06:30 UTC must be 10:00 Tehran');
  assert.equal(morningTehran.date, '2026-11-04');

  // Night run: 18:30 UTC -> 22:00 Tehran
  const nightUtc = new Date('2026-11-04T18:30:00.000Z');
  const nightTehran = tehranClock(nightUtc);
  assert.equal(nightTehran.hour, 22, '18:30 UTC must be 22:00 (10 PM) Tehran');
  assert.equal(nightTehran.date, '2026-11-04');
});

test('Verification: 500 Daily Quota splits 80% auto (400) and 20% manual (100)', () => {
  const budgets = aiCallBudgets(500, { total_calls: 0, auto_calls: 0, manual_calls: 0, manual_searches: 0 }, 10);
  assert.equal(budgets.auto_limit, 400);
  assert.equal(budgets.manual_limit, 100);
  assert.equal(budgets.remaining, 500);
  assert.equal(budgets.auto_remaining, 400);
  assert.equal(budgets.manual_remaining, 100);
});

test('Verification: Night run (hour >= 22) claims unused manual quota only if manual_searches == 0', () => {
  // Case A: No manual search occurred -> auto limit expands to full 500
  const budgetsUnused = aiCallBudgets(500, { total_calls: 350, auto_calls: 350, manual_calls: 0, manual_searches: 0 }, 22);
  assert.equal(budgetsUnused.auto_limit, 500);
  assert.equal(budgetsUnused.auto_remaining, 150);

  // Case B: A manual search occurred -> auto limit remains capped at 400
  const budgetsUsed = aiCallBudgets(500, { total_calls: 350, auto_calls: 350, manual_calls: 0, manual_searches: 1 }, 22);
  assert.equal(budgetsUsed.auto_limit, 400);
  assert.equal(budgetsUsed.auto_remaining, 50);
});

test('Verification: Rental formula converts rent to deposit equivalent with 100/3 ratio', () => {
  assert.equal(RENT_TO_DEPOSIT_MULTIPLIER, 100 / 3);
  // 3 million monthly rent = 100 million deposit equivalent
  const listingWithRent = { deposit_toman: 0, rent_toman: 3_000_000 };
  assert.equal(depositEquivalentToman(listingWithRent), 100_000_000);

  // 100M deposit + 6M rent = 100M + 200M = 300M equivalent
  const combined = { deposit_toman: 100_000_000, rent_toman: 6_000_000 };
  assert.equal(depositEquivalentToman(combined), 300_000_000);
});

test('Verification: Shared housing detection handles Persian zero-width non-joiner & variants', () => {
  assert.equal(isSharedHousingListing('هم‌خانه خانم نیازمندیم', ''), true);
  assert.equal(isSharedHousingListing('همخانه آقا دانشجو', ''), true);
  assert.equal(isSharedHousingListing('یک نفر هماتاقی در ونک', ''), true);
  assert.equal(isSharedHousingListing('اجاره اتاق مشترک', ''), true);
  assert.equal(isSharedHousingListing('اجاره آپارتمان کامل', '', 'room'), true);
  assert.equal(isSharedHousingListing('اجاره آپارتمان ۸۰ متری شیک', ''), false);
});

test('Verification: Divar API postlist extraction handles empty and malformed payloads gracefully', () => {
  assert.deepEqual(extractListingsFromApiResponse(null), []);
  assert.deepEqual(extractListingsFromApiResponse({}), []);
  assert.deepEqual(extractListingsFromApiResponse({ list_widgets: [] }), []);

  const mockResponse = {
    list_widgets: [
      {
        widget_type: 'POST_ROW',
        data: {
          token: 'test_token_123',
          title: 'آپارتمان ۷۰ متری فردوس',
          top_description_text: 'ودیعه: ۵۰۰,۰۰۰,۰۰۰ تومان',
          middle_description_text: 'اجاره: ۱۵,۰۰۰,۰۰۰ تومان',
          bottom_description_text: 'فردوس غرب',
          action: {
            payload: {
              web_info: {
                district_persian: 'فردوس'
              }
            }
          }
        }
      }
    ]
  };

  const results = extractListingsFromApiResponse(mockResponse);
  assert.equal(results.length, 1);
  assert.equal(results[0].token, 'test_token_123');
  assert.equal(results[0].deposit_toman, 500_000_000);
  assert.equal(results[0].rent_toman, 15_000_000);
  assert.equal(results[0].neighborhood, 'فردوس');
});


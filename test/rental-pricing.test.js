import test from 'node:test';
import assert from 'node:assert/strict';
import { depositEquivalentToman } from '../src/rental-pricing.js';
import { extractListingsFromApiResponse } from '../src/scraper.js';

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

test('extracts deposit and rent values from Divar search widgets', () => {
  const response = {
    list_widgets: [{
      widget_type: 'POST_ROW',
      data: {
        token: 'gaEnqi7f',
        title: 'جنت آباد۱۴۰متر۲خواب همکف غرق نور',
        top_description_text: 'ودیعه: ۱,۸۰۰,۰۰۰,۰۰۰ تومان',
        middle_description_text: 'اجاره: ۳۶,۰۰۰,۰۰۰ تومان',
        bottom_description_text: 'آژانس بزرگ پونک در جنت‌آباد مرکزی',
        action: {
          payload: {
            web_info: {
              district_persian: 'جنت‌آباد مرکزی'
            }
          }
        }
      }
    }]
  };

  const [listing] = extractListingsFromApiResponse(response);
  assert.equal(listing.neighborhood, 'جنت‌آباد مرکزی');
  assert.equal(listing.deposit_toman, 1_800_000_000);
  assert.equal(listing.rent_toman, 36_000_000);
});
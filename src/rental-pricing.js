export const RENT_TO_DEPOSIT_MULTIPLIER = 100 / 3;

function positiveAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

export function depositEquivalentToman(listing) {
  const deposit = positiveAmount(listing.deposit_toman);
  const rent = positiveAmount(listing.rent_toman);
  if (deposit === null && rent === null) return positiveAmount(listing.price_toman);
  return Math.round((deposit || 0) + (rent || 0) * RENT_TO_DEPOSIT_MULTIPLIER);
}